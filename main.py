import asyncio
import random
import logging
import sqlite3
import os
import time
import threading
import hashlib
import io
from datetime import datetime, timedelta
from telegram import Update, ReplyKeyboardMarkup, InlineKeyboardMarkup, InlineKeyboardButton, ReplyKeyboardRemove
from telegram.ext import Application, CommandHandler, MessageHandler, filters, ContextTypes, CallbackQueryHandler
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError, FloodWaitError, PhoneNumberInvalidError, PhoneCodeInvalidError
from telethon.tl.types import InputPeerChannel

# ========== KONFIGURATSIYA ==========
ADMIN_ID =   # O'zingizning Telegram ID'ingiz
BOT_TOKEN = ""  # @BotFather dan olingan token

# Telegram API ma'lumotlari (my.telegram.org dan oling)
API_ID = 
API_HASH = "de4b653676e085ce3d0f3d64f8741ae4"

# Ommaviy Arxiv Kanal (Media fayllar uchun)
STORAGE_CHANNEL_USERNAME = "@ajskhdgjasduouwqyuvdqhuq"  # O'z kanalingizni username bilan almashtiring

# Logging yoqish
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO
)
logger = logging.getLogger(__name__)

# SQLite bazasi
DB_FILE = "telegram_bot.db"

# Session fayllar papkasi
SESSIONS_DIR = "sessions"

# Global o'zgaruvchilar
is_sending = False
last_send_time = None
min_interval = 20  # Minimal interval (daqiqa)
max_interval = 25  # Maksimal interval (daqiqa)
random_messages = True  # Random xabarlarni yuborish

# ========== HELPER FUNCTIONS ==========

def get_storage_channel():
    """Arxiv kanal ID'sini olish"""
    storage_channel = get_setting('storage_channel', STORAGE_CHANNEL_USERNAME)
    if storage_channel and storage_channel != 'not_set':
        return storage_channel
    return STORAGE_CHANNEL_USERNAME

# ========== TELEGRAM CLIENT FUNCTIONS ==========

def init_sessions_dir():
    """Sessions papkasini yaratish"""
    if not os.path.exists(SESSIONS_DIR):
        os.makedirs(SESSIONS_DIR)
        logger.info(f"📁 Sessions papkasi yaratildi: {SESSIONS_DIR}")

def get_session_path(display_name):
    """Session fayl yo'lini olish"""
    # Display name'dagi maxsus belgilarni tozalash
    safe_name = ''.join(c for c in display_name if c.isalnum() or c in ('_', '-'))
    return os.path.join(SESSIONS_DIR, f"{safe_name}.session")

def session_exists(display_name):
    """Session fayli mavjudligini tekshirish"""
    session_path = get_session_path(display_name)
    return os.path.exists(session_path)

async def create_and_auth_session(user_id, display_name, phone):
    """Yangi session yaratish va avtorizatsiya qilish"""
    try:
        session_path = get_session_path(display_name)
        
        # Telefon raqamni tozalash
        if phone.startswith('+'):
            phone = phone[1:]
        
        # Yangi client yaratish
        client = TelegramClient(
            session_path,
            API_ID,
            API_HASH,
            device_model="Telegram Bot",
            system_version="1.0",
            app_version="1.0",
            lang_code="en"
        )
        
        await client.connect()
        
        if not await client.is_user_authorized():
            try:
                # Kod yuborish
                sent_code = await client.send_code_request(phone)
                
                logger.info(f"📱 {phone} raqamiga kod yuborildi")
                
                # SMS kodini bazaga saqlash
                conn = sqlite3.connect(DB_FILE)
                cursor = conn.cursor()
                cursor.execute('''
                    INSERT OR REPLACE INTO pending_sessions (display_name, phone, code_hash, user_id, created_at)
                    VALUES (?, ?, ?, ?, ?)
                ''', (display_name, phone, sent_code.phone_code_hash, user_id, datetime.now().strftime('%Y-%m-%d %H:%M:%S')))
                conn.commit()
                conn.close()
                
                await client.disconnect()
                
                # Admin ga xabar yuborish (faqat ma'lumot uchun)
                from telegram import Bot
                bot = Bot(token=BOT_TOKEN)
                
                await bot.send_message(
                    chat_id=ADMIN_ID,
                    text=f"📱 **YANGI HISOB QO'SHILDI**\n\n"
                         f"👤 Foydalanuvchi ID: {user_id}\n"
                         f"📱 Hisob: {display_name}\n"
                         f"📞 Telefon: +{phone}\n\n"
                         f"ℹ️ Foydalanuvchi o'zi kodni kiritadi."
                )
                
                return True, f"ENTER_CODE:{display_name}"
                
            except FloodWaitError as e:
                await client.disconnect()
                return False, f"Flood wait: {e.seconds} soniya kutish kerak"
            except PhoneNumberInvalidError:
                await client.disconnect()
                return False, "Noto'g'ri telefon raqam"
            except Exception as e:
                await client.disconnect()
                return False, f"Xato: {str(e)}"
        else:
            # Agar session allaqachon avtorizatsiya qilingan bo'lsa
            await client.disconnect()
            
            # Bazada is_active ni yangilash
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute('UPDATE accounts SET is_active = 1 WHERE display_name = ?', (display_name,))
            conn.commit()
            conn.close()
            
            return True, "Session allaqachon avtorizatsiya qilingan"
            
    except Exception as e:
        logger.error(f"Session yaratishda xato: {e}")
        return False, f"Xato: {str(e)}"

def get_pending_session(display_name):
    """Kutilayotgan session ma'lumotlarini olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT phone, code_hash, user_id FROM pending_sessions WHERE display_name = ?', (display_name,))
    result = cursor.fetchone()
    conn.close()
    return result

def remove_pending_session(display_name):
    """Kutilayotgan sessionni o'chirish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('DELETE FROM pending_sessions WHERE display_name = ?', (display_name,))
    conn.commit()
    conn.close()

def get_pending_session_by_user(user_id):
    """Foydalanuvchi uchun kutilayotgan sessionni olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT display_name, phone, code_hash FROM pending_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', (user_id,))
    result = cursor.fetchone()
    conn.close()
    return result

async def enter_code(display_name, code):
    """Kodni kiritish va sessionni tasdiqlash"""
    try:
        session_path = get_session_path(display_name)
        
        if not os.path.exists(session_path):
            return False, "Session fayli topilmadi"
        
        # Pending session ma'lumotlarini olish
        pending_data = get_pending_session(display_name)
        if not pending_data:
            return False, "Kutilayotgan session topilmadi"
        
        phone, code_hash, user_id = pending_data
        
        # Client yaratish
        client = TelegramClient(
            session_path,
            API_ID,
            API_HASH
        )
        
        await client.connect()
        
        try:
            # Kodni kiritish
            await client.sign_in(phone=phone, code=code, phone_code_hash=code_hash)
            
            # Session faylini saqlash
            await client.disconnect()
            
            # Pending sessionni o'chirish
            remove_pending_session(display_name)
            
            # Bazada is_active ni yangilash
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute('UPDATE accounts SET is_active = 1 WHERE display_name = ?', (display_name,))
            conn.commit()
            conn.close()
            
            return True, "✅ Session muvaffaqiyatli tasdiqlandi! Hisob endi faol."
            
        except SessionPasswordNeededError:
            await client.disconnect()
            return False, f"❗️ **2FA paroli kerak!**\n\nParolni kiriting: `/password {display_name} PAROL`"
            
        except PhoneCodeInvalidError:
            await client.disconnect()
            return False, "❌ Noto'g'ri kod! Iltimos, to'g'ri kodni kiriting."
            
        except Exception as e:
            await client.disconnect()
            return False, f"Kod kiritishda xato: {str(e)}"
            
    except Exception as e:
        logger.error(f"Kod kiritishda xato: {e}")
        return False, f"Xato: {str(e)}"

async def enter_password(display_name, password):
    """2FA parolini kiritish"""
    try:
        session_path = get_session_path(display_name)
        
        if not os.path.exists(session_path):
            return False, "Session fayli topilmadi"
        
        # Hisob ma'lumotlarini olish
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT phone FROM accounts WHERE display_name = ?', (display_name,))
        result = cursor.fetchone()
        conn.close()
        
        if not result:
            return False, "Hisob topilmadi"
        
        phone = result[0]
        
        # Client yaratish
        client = TelegramClient(
            session_path,
            API_ID,
            API_HASH
        )
        
        await client.connect()
        
        try:
            # Parolni kiritish
            await client.sign_in(password=password)
            
            # Session faylini saqlash
            await client.disconnect()
            
            # Bazada is_active ni yangilash
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute('UPDATE accounts SET is_active = 1 WHERE display_name = ?', (display_name,))
            conn.commit()
            conn.close()
            
            return True, "✅ 2FA parol tasdiqlandi! Hisob endi to'liq faol."
            
        except Exception as e:
            await client.disconnect()
            return False, f"Parol noto'g'ri: {str(e)}"
            
    except Exception as e:
        logger.error(f"Parol kiritishda xato: {e}")
        return False, f"Xato: {str(e)}"

async def test_session(display_name):
    """Sessionni test qilish"""
    try:
        session_path = get_session_path(display_name)
        
        if not os.path.exists(session_path):
            return False, "Session fayli topilmadi"
        
        # Hisob ma'lumotlarini olish
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT phone FROM accounts WHERE display_name = ?', (display_name,))
        result = cursor.fetchone()
        conn.close()
        
        if not result:
            return False, "Hisob topilmadi"
        
        phone = result[0]
        
        # Client yaratish
        client = TelegramClient(
            session_path,
            API_ID,
            API_HASH
        )
        
        await client.connect()
        
        if await client.is_user_authorized():
            # Foydalanuvchi ma'lumotlarini olish
            me = await client.get_me()
            await client.disconnect()
            
            return True, f"✅ Session faol!\n👤 User: {me.first_name} {me.last_name or ''}\n📞 Phone: +{phone}\n🔗 Username: @{me.username or 'Yoq'}"
        else:
            await client.disconnect()
            return False, "❌ Session avtorizatsiya qilinmagan"
            
    except Exception as e:
        logger.error(f"Session testda xato: {e}")
        return False, f"❌ Xato: {str(e)}"

async def save_media_to_channel(bot, message, user_id, message_type, file_name=None):
    """Media faylni arxiv kanaliga saqlash (lokal diskga yuklamasdan)"""
    try:
        # Arxiv kanalini olish
        storage_channel = get_storage_channel()
        
        if storage_channel == 'not_set':
            return None, "❌ Arxiv kanali sozlanmagan! Admin: Sozlamalar -> Arxiv kanali"
        
        # Arxiv kanaliga xabarni ko'chirish
        caption = message.caption or ""
        user_caption = f"User: {user_id}"
        if caption:
            final_caption = f"{caption}\n\n{user_caption}"
        else:
            final_caption = user_caption
        
        # Bot orqali xabarni nusxalash
        if message_type == 'photo':
            # Photo uchun eng katta o'lchamdagi rasmni olish
            photo = message.photo[-1]
            sent_message = await bot.copy_message(
                chat_id=storage_channel,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                caption=final_caption
            )
        elif message_type == 'video':
            sent_message = await bot.copy_message(
                chat_id=storage_channel,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                caption=final_caption
            )
        elif message_type == 'document':
            sent_message = await bot.copy_message(
                chat_id=storage_channel,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                caption=final_caption
            )
        elif message_type == 'audio':
            sent_message = await bot.copy_message(
                chat_id=storage_channel,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                caption=final_caption
            )
        elif message_type == 'voice':
            sent_message = await bot.copy_message(
                chat_id=storage_channel,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                caption=final_caption
            )
        elif message_type == 'sticker':
            sent_message = await bot.copy_message(
                chat_id=storage_channel,
                from_chat_id=message.chat_id,
                message_id=message.message_id
            )
        elif message_type == 'animation':
            sent_message = await bot.copy_message(
                chat_id=storage_channel,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                caption=final_caption
            )
        elif message_type == 'video_note':
            sent_message = await bot.copy_message(
                chat_id=storage_channel,
                from_chat_id=message.chat_id,
                message_id=message.message_id,
                caption=final_caption
            )
        else:
            return None, None
        
        storage_data = f"{storage_channel}:{sent_message.message_id}"
        
        logger.info(f"📦 Media arxivlandi: {storage_data} (type: {message_type})")
        return storage_data, None
        
    except Exception as e:
        logger.error(f"Media arxivlashda xato: {e}")
        return None, f"Media arxivlashda xato: {str(e)}"

async def send_message_to_group(display_name, group_identifier, message_data):
    """Guruhga xabar yuborish (arxiv kanalidan media o'qib)"""
    try:
        session_path = get_session_path(display_name)
        
        if not os.path.exists(session_path):
            return False, "Session fayli topilmadi"
        
        # Client yaratish
        client = TelegramClient(
            session_path,
            API_ID,
            API_HASH
        )
        
        await client.connect()
        
        if not await client.is_user_authorized():
            await client.disconnect()
            return False, "Session avtorizatsiya qilinmagan"
        
        try:
            # Guruhni topish
            entity = None
            
            if group_identifier.startswith('@'):
                entity = await client.get_entity(group_identifier)
            elif group_identifier.startswith('https://t.me/'):
                username = group_identifier.split('/')[-1]
                entity = await client.get_entity(f"@{username}")
            elif group_identifier.startswith('-100'):
                # Channel/Chat ID
                entity = await client.get_entity(int(group_identifier))
            else:
                # Username sifatida urinib ko'rish
                try:
                    entity = await client.get_entity(f"@{group_identifier}")
                except:
                    try:
                        entity = await client.get_entity(int(group_identifier))
                    except:
                        return False, f"Guruh topilmadi: {group_identifier}"
            
            # Xabar yuborish - turga qarab
            if isinstance(message_data, str):
                # Eski usul - oddiy text
                await client.send_message(entity, message_data)
                await client.disconnect()
                return True, f"✅ Text xabar yuborildi: {group_identifier}"
                
            elif isinstance(message_data, dict):
                message_type = message_data.get('message_type', 'text')
                storage_data = message_data.get('storage_data')  # CHAT_ID:MESSAGE_ID formatida
                text = message_data.get('text', '')
                
                if message_type == 'text':
                    # Text xabar
                    await client.send_message(entity, text)
                    await client.disconnect()
                    return True, f"✅ Text xabar yuborildi: {group_identifier}"
                    
                elif storage_data:
                    # Arxiv kanalidan media yuklab olish
                    try:
                        # CHAT_ID:MESSAGE_ID ni ajratish
                        if ':' in storage_data:
                            chat_id_str, message_id_str = storage_data.split(':')
                            try:
                                chat_id = int(chat_id_str) if chat_id_str.lstrip('-').isdigit() else chat_id_str
                                message_id = int(message_id_str)
                                
                                # Arxiv kanalidan xabarni olish
                                storage_channel = await client.get_entity(chat_id)
                                
                                msg = await client.get_messages(storage_channel, ids=message_id)
                                
                                if msg:
                                    # Media bilan birga yuborish
                                    if msg.photo:
                                        await client.send_file(entity, msg.photo, caption=text if text else None)
                                    elif msg.video:
                                        await client.send_file(entity, msg.video, caption=text if text else None)
                                    elif msg.document:
                                        await client.send_file(entity, msg.document, caption=text if text else None)
                                    elif msg.audio:
                                        await client.send_file(entity, msg.audio, caption=text if text else None)
                                    elif msg.voice:
                                        await client.send_file(entity, msg.voice, caption=text if text else None)
                                    elif msg.sticker:
                                        await client.send_file(entity, msg.sticker)
                                    elif msg.gif:
                                        await client.send_file(entity, msg.gif, caption=text if text else None)
                                    elif msg.video_note:
                                        await client.send_file(entity, msg.video_note, caption=text if text else None)
                                    else:
                                        # Agar media topilmasa, text yuborish
                                        if text:
                                            await client.send_message(entity, text)
                                        await client.disconnect()
                                        return True, f"⚠️ Faqat text yuborildi (media topilmadi): {group_identifier}"
                                    
                                    await client.disconnect()
                                    return True, f"✅ Media xabar yuborildi: {group_identifier}"
                                else:
                                    await client.disconnect()
                                    return False, f"Arxiv kanalida xabar topilmadi: {storage_data}"
                            except ValueError:
                                logger.error(f"Noto'g'ri storage_data formati: {storage_data}")
                                if text:
                                    await client.send_message(entity, text)
                                    await client.disconnect()
                                    return True, f"⚠️ Faqat text yuborildi (arxiv xato): {group_identifier}"
                                await client.disconnect()
                                return False, f"Noto'g'ri storage_data formati: {storage_data}"
                    except Exception as file_error:
                        logger.error(f"Fayl yuborishda xato: {file_error}")
                        # Agar fayl bilan yuborib bo'lmasa, text yuboramiz
                        if text:
                            await client.send_message(entity, text)
                            await client.disconnect()
                            return True, f"⚠️ Faqat text yuborildi (media xato): {group_identifier}"
                        else:
                            await client.disconnect()
                            return False, f"Fayl yuborib bo'lmadi: {str(file_error)}"
                else:
                    # storage_data yo'q
                    if text:
                        await client.send_message(entity, text)
                        await client.disconnect()
                        return True, f"✅ Text xabar yuborildi: {group_identifier}"
                    else:
                        await client.disconnect()
                        return False, "Xabar ma'lumotlari noto'g'ri"
            else:
                await client.disconnect()
                return False, "Noma'lum xabar formati"
            
        except Exception as e:
            await client.disconnect()
            return False, f"❌ Xabar yuborishda xato: {str(e)}"
            
    except Exception as e:
        logger.error(f"Xabar yuborishda xato: {e}")
        return False, f"❌ Xato: {str(e)}"

# ========== DATABASE FUNCTIONS ==========

def init_database():
    """Bazani yaratish"""
    db_exists = os.path.exists(DB_FILE)
    
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    
    # Jadvalarni yaratish
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        display_name TEXT UNIQUE,
        phone TEXT,
        country_code TEXT,
        username TEXT,
        is_active INTEGER DEFAULT 0,
        is_premium INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        subscription_end DATETIME,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        account_display_name TEXT,
        group_id TEXT,
        group_title TEXT,
        group_username TEXT,
        is_active INTEGER DEFAULT 1,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, account_display_name, group_id)
    )''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        message_type TEXT DEFAULT 'text',
        storage_data TEXT,
        text TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT UNIQUE,
        value TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        status TEXT DEFAULT 'pending',
        admin_note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS user_intervals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER UNIQUE NOT NULL,
        min_interval INTEGER DEFAULT 20,
        max_interval INTEGER DEFAULT 25,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS pending_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT UNIQUE,
        phone TEXT,
        code_hash TEXT,
        user_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS session_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT,
        action TEXT,
        status TEXT,
        message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )''')
    
    # Index yaratish
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_user_id ON accounts(user_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_requests_user_id ON requests(user_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_user_intervals_user_id ON user_intervals(user_id)')
    cursor.execute('CREATE INDEX IF NOT EXISTS idx_pending_sessions_display_name ON pending_sessions(display_name)')
    
    # Default sozlamalar
    default_settings = [
        ('min_interval', '20'),
        ('max_interval', '25'),
        ('random_messages', 'true'),
        ('welcome_message', 'Botdan foydalanish uchun ruxsat kerak. Ruxsat olish uchun @Okean_manager ga murojaat qiling.'),
        ('admin_contact', '@Okean_manager'),
        ('api_id', str(API_ID)),
        ('api_hash', API_HASH),
        ('storage_channel', STORAGE_CHANNEL_USERNAME)
    ]
    
    for key, value in default_settings:
        cursor.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', (key, value))
    
    conn.commit()
    conn.close()
    print("✅ Baza yaratildi/tekshirildi")

def save_setting(key, value):
    """Setting saqlash"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', (key, value))
    conn.commit()
    conn.close()

def get_setting(key, default=None):
    """Setting olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT value FROM settings WHERE key = ?', (key,))
    result = cursor.fetchone()
    conn.close()
    return result[0] if result else default

# ========== USER INTERVAL FUNCTIONS ==========

def save_user_interval(user_id, min_interval, max_interval):
    """Foydalanuvchi intervalini saqlash"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT OR REPLACE INTO user_intervals (user_id, min_interval, max_interval) 
        VALUES (?, ?, ?)
    ''', (user_id, min_interval, max_interval))
    conn.commit()
    conn.close()
    logger.info(f"✅ Foydalanuvchi {user_id} intervali saqlandi: {min_interval}-{max_interval} daqiqa")

def get_user_interval(user_id):
    """Foydalanuvchi intervalini olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT min_interval, max_interval FROM user_intervals WHERE user_id = ?', (user_id,))
    result = cursor.fetchone()
    conn.close()
    
    if result:
        return result[0], result[1]
    else:
        # Global sozlamalardan olish
        global_min = int(get_setting('min_interval', '20'))
        global_max = int(get_setting('max_interval', '25'))
        return global_min, global_max

def get_next_account_number(user_id):
    """Foydalanuvchi uchun keyingi account raqamini olish (max 5 ta)"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    
    # Foydalanuvchining barcha hisoblarini olish
    cursor.execute('''
        SELECT display_name FROM accounts 
        WHERE user_id = ? 
        AND display_name LIKE ?
    ''', (user_id, f'account_{user_id}_%'))
    
    accounts = cursor.fetchall()
    conn.close()
    
    if not accounts:
        return 1
    
    numbers = []
    for acc in accounts:
        try:
            # Format: account_USERID_NUMBER (account_123456789_1)
            parts = acc[0].split('_')
            if len(parts) >= 3 and parts[-1].isdigit():
                numbers.append(int(parts[-1]))
        except:
            continue
    
    if numbers:
        # Faqat 5 tagacha ruxsat berish
        if len(numbers) >= 5:
            return None  # 5 tadan ko'p bo'lmasligi kerak
        
        # 1 dan 5 gacha bo'sh raqamni topish
        for i in range(1, 6):
            if i not in numbers:
                return i
        
        return max(numbers) + 1
    else:
        return 1

def get_user_accounts_count(user_id):
    """Foydalanuvchi hisoblari soni (default hisoblarni hisoblamaydi)"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) FROM accounts WHERE user_id = ? AND (is_default = 0 OR is_default IS NULL)', (user_id,))
    count = cursor.fetchone()[0]
    conn.close()
    return count

def add_user_account(user_id, phone="", country_code="", username="", display_name=None):
    """Foydalanuvchi hisobini qo'shish (max 5 ta)"""
    # Avval hisoblar sonini tekshirish
    accounts_count = get_user_accounts_count(user_id)
    if accounts_count >= 5:
        logger.warning(f"Foydalanuvchi {user_id} allaqachon 5 ta hisobga ega")
        return None
    
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    try:
        if not display_name:
            account_number = get_next_account_number(user_id)
            if account_number is None:
                logger.warning(f"Foydalanuvchi {user_id} uchun hisob limitiga yetildi (5 ta)")
                return None
            
            # Yangi format: account_USERID_NUMBER
            display_name = f"account_{user_id}_{account_number}"
            logger.info(f"🎯 Yangi display name yaratildi: {display_name}")
        
        # Telefon raqamni tekshirish
        if phone:
            cursor.execute('SELECT display_name, user_id FROM accounts WHERE phone = ?', (phone,))
            existing_phone = cursor.fetchone()
            if existing_phone:
                logger.warning(f"Bu telefon raqam allaqachon mavjud: {phone} (Hisob: {existing_phone[0]}, User: {existing_phone[1]})")
                return None
        
        # Display name allaqachon mavjudligini tekshirish
        cursor.execute('SELECT user_id, phone FROM accounts WHERE display_name = ?', (display_name,))
        existing_name = cursor.fetchone()
        if existing_name:
            logger.warning(f"Bu display name allaqachon mavjud: {display_name} (User: {existing_name[0]}, Phone: {existing_name[1]})")
            # Yangi raqam topish
            account_number = get_next_account_number(user_id)
            if account_number:
                display_name = f"account_{user_id}_{account_number}"
                logger.info(f"🔄 Yangi display name: {display_name}")
            else:
                return None
        
        cursor.execute('''
            INSERT INTO accounts (user_id, display_name, phone, country_code, username, is_active, is_premium) 
            VALUES (?, ?, ?, ?, ?, 0, 0)
        ''', (user_id, display_name, phone, country_code, username))
        conn.commit()
        
        logger.info(f"✅ Hisob qo'shildi: {display_name} (User: {user_id}, Phone: +{phone})")
        
        return display_name
        
    except sqlite3.IntegrityError as e:
        logger.error(f"Bazaga qo'shishda xato (IntegrityError): {e}")
        
        # Qaysi constraint buzilganligini aniqlash
        if "display_name" in str(e):
            logger.error(f"Display name conflict: {display_name}")
            # Barcha mavjud display namelarni ko'rish
            cursor.execute('SELECT display_name FROM accounts ORDER BY display_name')
            all_accounts = cursor.fetchall()
            logger.info(f"Barcha mavjud hisoblar: {all_accounts}")
            
        return None
    finally:
        conn.close()

def get_user_accounts(user_id):
    """Foydalanuvchi hisoblarini olish (default hisoblarni ko'rsatmaydi)"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        SELECT display_name, phone, country_code, username, is_active, is_premium, subscription_end 
        FROM accounts 
        WHERE user_id = ? AND (is_default = 0 OR is_default IS NULL)
        ORDER BY display_name
    ''', (user_id,))
    accounts = cursor.fetchall()
    conn.close()
    return accounts

def get_user_by_display_name(display_name):
    """Display name bo'yicha foydalanuvchini topish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT user_id FROM accounts WHERE display_name = ?', (display_name,))
    result = cursor.fetchone()
    conn.close()
    return result[0] if result else None

def get_all_users():
    """Barcha foydalanuvchilarni olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT DISTINCT user_id FROM accounts WHERE user_id != ?', (ADMIN_ID,))
    users = cursor.fetchall()
    conn.close()
    return [u[0] for u in users]

def get_all_active_user_ids():
    """Barcha faol obunali foydalanuvchilarni olish (broadcast uchun)"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    current_time = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    cursor.execute('''
        SELECT DISTINCT user_id FROM accounts 
        WHERE user_id != ? AND subscription_end > ? AND is_active = 1
    ''', (ADMIN_ID, current_time))
    users = cursor.fetchall()
    conn.close()
    return [u[0] for u in users]

def get_user_subscription(user_id):
    """Foydalanuvchi obunasini tekshirish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        SELECT subscription_end, is_premium FROM accounts 
        WHERE user_id = ? AND is_active = 1
        ORDER BY subscription_end DESC LIMIT 1
    ''', (user_id,))
    result = cursor.fetchone()
    conn.close()
    
    if not result:
        return None, False
    
    subscription_end, is_premium = result
    return subscription_end, bool(is_premium)

def update_user_subscription(user_id, days):
    """Foydalanuvchiga obuna berish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    try:
        # subscription_end_str va is_premium ni avvaldan hisoblab qo'yamiz
        if days > 0:
            subscription_end = datetime.now() + timedelta(days=days)
            subscription_end_str = subscription_end.strftime('%Y-%m-%d %H:%M:%S')
            is_premium = 1
        else:
            subscription_end_str = None
            is_premium = 0

        # Avval foydalanuvchi borligini tekshirish
        cursor.execute('SELECT id FROM accounts WHERE user_id = ?', (user_id,))
        account_exists = cursor.fetchone()
        
        if not account_exists:
            # Agar hisob yo'q bo'lsa, yangi default hisob yaratish
            display_name = f"default_{user_id}"
            
            cursor.execute('''
                INSERT INTO accounts (user_id, display_name, phone, country_code, username, is_active, is_premium, is_default, subscription_end) 
                VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?)
            ''', (user_id, display_name, "", "", "", is_premium, subscription_end_str))
            conn.commit()
        
        cursor.execute('''
            UPDATE accounts 
            SET subscription_end = ?, is_premium = ?, is_active = 1 
            WHERE user_id = ?
        ''', (subscription_end_str, is_premium, user_id))
        
        conn.commit()
        
        if days > 0:
            cursor.execute('UPDATE groups SET is_active = 1 WHERE user_id = ?', (user_id,))
            conn.commit()
        
        return subscription_end_str if days > 0 else None
    except Exception as e:
        logger.error(f"update_user_subscription xatosi: {e}")
        conn.rollback()
        return None
    finally:
        conn.close()

async def delete_user_data_from_channel(user_id, context=None):
    """Foydalanuvchi ma'lumotlarini arxiv kanaldan o'chirish"""
    try:
        # Foydalanuvchining barcha media xabarlarini olish
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT storage_data FROM messages WHERE user_id = ? AND storage_data IS NOT NULL', (user_id,))
        storage_items = cursor.fetchall()
        conn.close()
        
        deleted_count = 0
        failed_count = 0
        
        for (storage_data,) in storage_items:
            if storage_data and ':' in storage_data:
                try:
                    chat_id_str, message_id_str = storage_data.split(':')
                    try:
                        chat_id = int(chat_id_str) if chat_id_str.lstrip('-').isdigit() else chat_id_str
                        message_id = int(message_id_str)
                        
                        # Bot orqali xabarni o'chirish
                        if context and context.bot:
                            await context.bot.delete_message(
                                chat_id=chat_id,
                                message_id=message_id
                            )
                            deleted_count += 1
                            logger.info(f"🗑️ Arxivdan xabar o'chirildi: {storage_data}")
                        else:
                            # Agar context bo'lmasa, bot yaratish
                            from telegram import Bot
                            bot = Bot(token=BOT_TOKEN)
                            await bot.delete_message(
                                chat_id=chat_id,
                                message_id=message_id
                            )
                            deleted_count += 1
                            logger.info(f"🗑️ Arxivdan xabar o'chirildi: {storage_data}")
                    except ValueError:
                        logger.error(f"Noto'g'ri message_id formati: {message_id_str}")
                        failed_count += 1
                except Exception as e:
                    logger.error(f"Xabarni o'chirishda xato ({storage_data}): {e}")
                    failed_count += 1
        
        logger.info(f"🗑️ Arxivdan {deleted_count} ta xabar o'chirildi, {failed_count} ta xato")
        return deleted_count, failed_count
        
    except Exception as e:
        logger.error(f"delete_user_data_from_channel xatosi: {e}")
        return 0, 0

def delete_user_data(user_id):
    """Foydalanuvchi ma'lumotlarini tozalash"""
    try:
        user_id = int(user_id)

        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        cursor.execute('DELETE FROM accounts WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM groups WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM messages WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM requests WHERE user_id = ?', (user_id,))
        cursor.execute('DELETE FROM user_intervals WHERE user_id = ?', (user_id,))
        
        conn.commit()
        conn.close()
        return True

    except Exception as e:
        logger.error(f"delete_user_data xatosi: {e}")
        return False

def delete_user_account(user_id, display_name):
    """Foydalanuvchi hisobini o'chirish (session fayli va guruhlar bilan)"""
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        # Hisobni tekshirish
        cursor.execute('SELECT id FROM accounts WHERE user_id = ? AND display_name = ?', (user_id, display_name))
        account = cursor.fetchone()
        
        if not account:
            conn.close()
            return False
        
        # Hisobni o'chirish
        cursor.execute('DELETE FROM accounts WHERE user_id = ? AND display_name = ?', (user_id, display_name))
        
        # Guruhlarni o'chirish
        cursor.execute('DELETE FROM groups WHERE user_id = ? AND account_display_name = ?', (user_id, display_name))
        
        # Pending sessionni o'chirish
        cursor.execute('DELETE FROM pending_sessions WHERE display_name = ?', (display_name,))
        
        conn.commit()
        conn.close()
        
        # Session faylini o'chirish
        session_path = get_session_path(display_name)
        if os.path.exists(session_path):
            os.remove(session_path)
            logger.info(f"📁 Session fayli o'chirildi: {session_path}")
        
        # .session-journal faylini ham o'chirish
        session_journal = session_path + "-journal"
        if os.path.exists(session_journal):
            os.remove(session_journal)
        
        logger.info(f"✅ Hisob o'chirildi: {display_name} (user_id: {user_id})")
        return True
        
    except Exception as e:
        logger.error(f"delete_user_account xatosi: {e}")
        return False

def add_request(user_id, username, first_name, last_name):
    """Yangi so'rov qo'shish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    
    # Avval pending so'rov borligini tekshirish
    cursor.execute('SELECT id FROM requests WHERE user_id = ? AND status = "pending"', (user_id,))
    existing = cursor.fetchone()
    
    if existing:
        conn.close()
        logger.info(f"⚠️ User {user_id} allaqachon so'rov yuborgan (ID: {existing[0]})")
        return existing[0]
    
    try:
        # Usernameni to'g'ri formatlash
        clean_username = username if username else ""
        
        cursor.execute('''
            INSERT INTO requests (user_id, username, first_name, last_name, status) 
            VALUES (?, ?, ?, ?, "pending")
        ''', (user_id, clean_username, first_name, last_name))
        
        conn.commit()
        
        # Yangi qo'shilgan so'rov ID sini olish
        cursor.execute('SELECT last_insert_rowid()')
        request_id = cursor.fetchone()[0]
        
        conn.close()
        logger.info(f"✅ Yangi so'rov qo'shildi: ID={request_id}, user_id={user_id}, username={clean_username}")
        return request_id
        
    except Exception as e:
        logger.error(f"So'rov qo'shishda xato: {e}")
        conn.close()
        return False

def get_pending_requests():
    """Kutilayotgan so'rovlarni olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, user_id, username, first_name, last_name, created_at 
        FROM requests 
        WHERE status = "pending" 
        ORDER BY created_at ASC
    ''')
    requests = cursor.fetchall()
    conn.close()
    
    logger.info(f"📊 Kutilayotgan so'rovlar soni: {len(requests)}")
    return requests

def get_request_by_id(request_id):
    """So'rovni ID bo'yicha olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM requests WHERE id = ?', (request_id,))
    result = cursor.fetchone()
    conn.close()
    return result

def get_request_by_user_id(user_id):
    """So'rovni user_id bo'yicha olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM requests WHERE user_id = ? AND status = "pending" ORDER BY id DESC LIMIT 1', (user_id,))
    result = cursor.fetchone()
    conn.close()
    return result

def update_request_status(request_id, status, admin_note=""):
    """So'rov statusini yangilash"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('UPDATE requests SET status = ?, admin_note = ? WHERE id = ?', (status, admin_note, request_id))
    conn.commit()
    conn.close()
    logger.info(f"📝 So'rov #{request_id} statusi '{status}' ga o'zgartirildi")
    return True

def add_group_batch(user_id, account_display_name, groups_list):
    """Ko'p guruhlarni bir vaqtda qo'shish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    
    added_count = 0
    skipped_count = 0
    
    for group_input in groups_list:
        group_input = group_input.strip()
        if not group_input:
            continue
        
        group_id = None
        group_title = group_input
        
        if group_input.startswith('@'):
            group_username = group_input[1:]
            group_id = group_input
        elif group_input.startswith('https://t.me/'):
            group_username = group_input.split('/')[-1]
            if group_username.startswith('+'):
                group_id = group_username
            else:
                group_id = f"@{group_username}"
        elif group_input.startswith('-100'):
            group_id = group_input
            group_username = ""
        else:
            if group_input.startswith('+'):
                group_id = group_input
                group_username = ""
            else:
                group_id = f"@{group_input}"
                group_username = group_input
        
        try:
            cursor.execute('''
                INSERT OR IGNORE INTO groups (user_id, account_display_name, group_id, group_title, group_username, is_active)
                VALUES (?, ?, ?, ?, ?, ?)
            ''', (user_id, account_display_name, group_id, group_title, group_username, 1))
            
            if cursor.rowcount > 0:
                added_count += 1
            else:
                skipped_count += 1
                
        except Exception as e:
            logger.error(f"Guruh qo'shishda xato: {e}")
            skipped_count += 1
    
    conn.commit()
    conn.close()
    return added_count, skipped_count

def get_user_groups(user_id, account_display_name):
    """Foydalanuvchi guruhlarini olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, group_id, group_title, group_username, is_active 
        FROM groups 
        WHERE user_id = ? AND account_display_name = ? 
        ORDER BY group_title
    ''', (user_id, account_display_name))
    groups = cursor.fetchall()
    conn.close()
    return groups

def update_group_active_status(group_ids, is_active):
    """Guruhlarning faollik holatini o'zgartirish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    
    updated_count = 0
    for group_id in group_ids:
        cursor.execute('UPDATE groups SET is_active = ? WHERE id = ?', (is_active, group_id))
        updated_count += cursor.rowcount
    
    conn.commit()
    conn.close()
    return updated_count

def add_user_message(user_id, text, message_type='text', storage_data=None):
    """Foydalanuvchi xabarini qo'shish (arxiv kanal ma'lumoti bilan)"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO messages (user_id, message_type, storage_data, text) 
        VALUES (?, ?, ?, ?)
    ''', (user_id, message_type, storage_data, text))
    conn.commit()
    conn.close()

def get_user_messages(user_id):
    """Foydalanuvchi xabarlarini olish (barcha turlar)"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, message_type, storage_data, text 
        FROM messages 
        WHERE user_id = ? 
        ORDER BY id
    ''', (user_id,))
    messages = cursor.fetchall()
    conn.close()
    return messages

def get_random_user_message(user_id):
    """Foydalanuvchi uchun random xabar olish (barcha turlar)"""
    messages = get_user_messages(user_id)
    if not messages:
        return None
    msg = random.choice(messages)
    # (id, message_type, storage_data, text)
    return {
        'id': msg[0],
        'message_type': msg[1] or 'text',
        'storage_data': msg[2],  # CHAT_ID:MESSAGE_ID formatida
        'text': msg[3]
    }

def delete_user_messages(user_id):
    """Foydalanuvchi barcha xabarlarini o'chirish (faqat bazadan)"""
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        cursor.execute('DELETE FROM messages WHERE user_id = ?', (user_id,))
        deleted_count = cursor.rowcount
        conn.commit()
        conn.close()
        logger.info(f"✅ {deleted_count} ta xabar bazadan o'chirildi (user_id: {user_id})")
        return deleted_count
    except Exception as e:
        logger.error(f"delete_user_messages xatosi: {e}")
        return 0

def delete_single_message(message_id):
    """Bitta xabarni o'chirish (faqat bazadan)"""
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        
        cursor.execute('DELETE FROM messages WHERE id = ?', (message_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        conn.close()
        return deleted
    except Exception as e:
        logger.error(f"delete_single_message xatosi: {e}")
        return False

def delete_group_by_id(group_id):
    """Guruhni ID bo'yicha o'chirish"""
    try:
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('DELETE FROM groups WHERE id = ?', (group_id,))
        deleted = cursor.rowcount > 0
        conn.commit()
        conn.close()
        return deleted
    except Exception as e:
        logger.error(f"delete_group_by_id xatosi: {e}")
        return False

def get_group_by_id(group_id):
    """Guruhni ID bo'yicha olish"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, user_id, account_display_name, group_id, group_title, group_username, is_active 
        FROM groups 
        WHERE id = ?
    ''', (group_id,))
    group = cursor.fetchone()
    conn.close()
    return group

def log_session_action(display_name, action, status, message):
    """Session logini saqlash"""
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO session_logs (display_name, action, status, message)
        VALUES (?, ?, ?, ?)
    ''', (display_name, action, status, message))
    conn.commit()
    conn.close()

# ========== ADMIN KEYBOARDS ==========

def get_admin_keyboard():
    """Admin panel tugmalari"""
    return ReplyKeyboardMarkup([
        ["📋 Foydalanuvchilar", "⏳ So'rovlar"],
        ["➕ Ruxsat berish", "🗑️ Hisob o'chirish"],
        ["📊 Statistika", "⚙️ Sozlamalar"],
        ["🔄 Session boshqarish", "🔄 Avtomatik yuborish"],
        ["⏸️ To'xtatish", "🔄 Yangilash"],
        ["📢 Xabar yuborish"],
        ["📌 Kanal ID o'rnatish (Ixtiyoriy)"]
    ], resize_keyboard=True)

def get_user_keyboard():
    """Oddiy foydalanuvchi paneli"""
    return ReplyKeyboardMarkup([
        ["➕ Hisob qo'shish", "🧪 Session test"],
        ["📤 Xabar qo'shish", "🔗 Guruh qo'shish"],
        ["👥 Guruhlarni ko'rish", "⚙️ Interval sozlash"],
        ["🎲 Random rejim", "▶️ Boshlash"],
        ["⏹️ To'xtatish", "📋 Hisoblar"],
        ["📝 Xabarlar", "🗑️ Xabarlarni tozalash"],
        ["📊 Statistika"]
    ], resize_keyboard=True)

# ========== ASOSIY HANDLERLAR ==========

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    username = update.effective_user.username
    first_name = update.effective_user.first_name
    last_name = update.effective_user.last_name or ""
    
    logger.info(f"🚀 /start bosildi: user_id={user_id}, username={username}")
    
    if user_id == ADMIN_ID:
        # Global o'zgaruvchilarni yangilash
        global min_interval, max_interval, random_messages
        min_interval = int(get_setting('min_interval', '20'))
        max_interval = int(get_setting('max_interval', '25'))
        random_messages = get_setting('random_messages', 'true').lower() == 'true'
        
        pending_requests = get_pending_requests()
        
        await update.message.reply_text(
            "👑 **Admin Paneli**\n\n"
            f"📊 Jami foydalanuvchilar: {len(get_all_users())}\n"
            f"⏳ Kutilayotgan so'rovlar: {len(pending_requests)}\n"
            f"📦 Arxiv kanal: {get_setting('storage_channel', 'Mavjud emas')}\n\n"
            "Kerakli bo'limni tanlang:",
            reply_markup=get_admin_keyboard()
        )
        
        # Agar so'rovlar bo'lsa, adminni ogohlantirish
        if pending_requests:
            for req in pending_requests:
                req_id, uid, uname, fname, lname, created_at = req
                try:
                    # Created_at ni string formatga o'tkazish
                    if isinstance(created_at, str):
                        date_str = created_at
                    else:
                        date_str = created_at.strftime('%Y-%m-%d %H:%M:%S') if created_at else "Noma'lum"
                    
                    # Username formatini tuzatish
                    username_display = f"@{uname}" if uname else "Yo'q"
                    
                    await update.message.reply_text(
                        f"⚠️ **KUTILAYOTGAN SO'ROV**\n\n"
                        f"👤 Foydalanuvchi: {fname} {lname}\n"
                        f"🔗 Username: {username_display}\n"
                        f"🆔 ID: {uid}\n"
                        f"📅 Sana: {date_str}\n\n"
                        f"✅ Ruxsat: /add {uid} 30\n"
                        f"❌ Rad: /reject {req_id}"
                    )
                except Exception as e:
                    logger.error(f"Adminga so'rov yuborishda xato: {e}")
                    await update.message.reply_text(
                        f"⚠️ SO'ROV (ID: {uid})\n"
                        f"Foydalanuvchi: {fname} {lname}\n"
                        f"Username: @{uname or 'Yoq'}\n"
                        f"✅ Ruxsat: /add {uid} 30\n"
                        f"❌ Rad: /reject {req_id}"
                    )
        return
    
    # Oddiy foydalanuvchi
    subscription_end, is_premium = get_user_subscription(user_id)
    
    has_active_subscription = False
    days_left = 0
    
    if subscription_end:
        try:
            sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
            days_left = (sub_date - datetime.now()).days
            if days_left > 0:
                has_active_subscription = True
        except Exception as e:
            logger.error(f"Sanani o'qishda xato: {e}")
            has_active_subscription = False
    
    if has_active_subscription:
        sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
        
        # Foydalanuvchi intervallarini olish
        user_min_interval, user_max_interval = get_user_interval(user_id)
        
        # Hisoblar sonini olish
        accounts_count = get_user_accounts_count(user_id)
        max_accounts = 5
        accounts_left = max_accounts - accounts_count
        
        await update.message.reply_text(
            f"✅ **Obuna aktiv!**\n\n"
            f"👋 Xush kelibsiz, {first_name}!\n"
            f"📅 Qolgan kunlar: {days_left} kun\n"
            f"⏰ Tugash sanasi: {sub_date.strftime('%Y-%m-%d')}\n"
            f"📊 Hisoblar: {accounts_count}/{max_accounts} ta\n"
            f"⏱️ Interval: {user_min_interval}-{user_max_interval} daqiqa\n"
            f"📦 Media saqlash: Arxiv kanalida\n\n"
            f"🤖 Bot funksiyalaridan foydalaning:",
            reply_markup=get_user_keyboard()
        )
    else:
        # Obuna yo'q yoki muddati o'tgan
        welcome_message = get_setting('welcome_message', '🤖 Botdan foydalanish uchun ruxsat kerak!\n\nℹ️ Ruxsat olish uchun @Okean_manager ga murojaat qiling.')
        await update.message.reply_text(welcome_message)
        
        # So'rov qo'shish
        request_id = add_request(user_id, username, first_name, last_name)
        
        if request_id:
            try:
                await context.bot.send_message(
                    ADMIN_ID,
                    f"📩 **YANGI SO'ROV!**\n\n"
                    f"👤 Foydalanuvchi: {first_name} {last_name}\n"
                    f"🔗 Username: @{username or 'Yoq'}\n"
                    f"🆔 ID: {user_id}\n"
                    f"📅 Sana: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
                    f"✅ Ruxsat berish: /add {user_id} 30\n"
                    f"❌ Rad etish: /reject {request_id}"
                )
            except Exception as e:
                logger.error(f"Admin ga xabar yuborishda xato: {e}")
            
            await update.message.reply_text(
                "✅ **So'rovingiz qabul qilindi!**\n\n"
                "Admin tez orada ruxsat beradi.\n"
                "📩 Xabar: @Okean_manager"
            )
        else:
            # Agar so'rov allaqachon mavjud bo'lsa
            await update.message.reply_text(
                "ℹ️ **Sizning so'rovingiz hali ko'rib chiqilmoqda.**\n\n"
                "Admin javobini kuting yoki @Okean_manager ga murojaat qiling."
            )

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Barcha text habarlarni qayta ishlash"""
    user_id = update.effective_user.id
    text = update.message.text
    
    logger.info(f"📝 Text xabar: user_id={user_id}, text={text}")
    
    # Admin bo'lsa
    if user_id == ADMIN_ID:
        await handle_admin_text(update, context, text)
    else:
        await handle_user_text(update, context, text)

async def handle_media_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Barcha media xabarlarni qayta ishlash (arxiv kanaliga saqlash)"""
    user_id = update.effective_user.id
    mode = context.user_data.get("mode")
    message = update.message
    
    # Faqat add_message rejimida qabul qilish
    if mode != "add_message":
        return
    
    # Obunani tekshirish
    subscription_end, is_premium = get_user_subscription(user_id)
    has_active_subscription = False
    
    if subscription_end:
        try:
            sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
            days_left = (sub_date - datetime.now()).days
            if days_left > 0:
                has_active_subscription = True
        except:
            pass
    
    if not has_active_subscription and user_id != ADMIN_ID:
        await update.message.reply_text("❌ Obunangiz tugagan!", reply_markup=get_user_keyboard())
        return
    
    # Arxiv kanalini tekshirish
    storage_channel = get_storage_channel()
    if storage_channel == 'not_set':
        await update.message.reply_text(
            "❌ **ARXIV KANALI SOZLANMAGAN!**\n\n"
            "Iltimos, admin bilan bog'laning yoki /start ni bosing.",
            reply_markup=get_user_keyboard()
        )
        return
    
    # Media turini aniqlash
    message_type = None
    file_name = None
    caption = message.caption or ""
    
    if message.photo:
        message_type = "photo"
    elif message.video:
        message_type = "video"
        file_name = message.video.file_name
    elif message.document:
        message_type = "document"
        file_name = message.document.file_name
    elif message.audio:
        message_type = "audio"
        file_name = message.audio.file_name
    elif message.voice:
        message_type = "voice"
    elif message.sticker:
        message_type = "sticker"
    elif message.animation:
        message_type = "animation"
        file_name = message.animation.file_name
    elif message.video_note:
        message_type = "video_note"
    
    if message_type:
        # Yuklanmoqda xabarini yuborish
        loading_msg = await update.message.reply_text("⏳ Media arxivlanmoqda...")
        
        try:
            # Media faylni arxiv kanaliga saqlash
            storage_data, error = await save_media_to_channel(
                context.bot, 
                message, 
                user_id, 
                message_type,
                file_name
            )
            
            if storage_data:
                # Xabarni bazaga saqlash
                add_user_message(user_id, caption, message_type, storage_data)
                
                type_names = {
                    'photo': '📷 Rasm',
                    'video': '🎬 Video',
                    'document': '📄 Fayl',
                    'audio': '🎵 Audio',
                    'voice': '🎤 Ovozli xabar',
                    'sticker': '🎨 Stiker',
                    'animation': '🎞 GIF',
                    'video_note': '⭕ Video xabar'
                }
                
                type_name = type_names.get(message_type, message_type)
                caption_text = f"\n📝 Caption: {caption[:50]}..." if caption else ""
                
                # Loading xabarini o'chirish va yangi xabar yuborish
                await loading_msg.delete()
                await update.message.reply_text(
                    f"✅ **XABAR QO'SHILDI!**\n\n"
                    f"📦 Turi: {type_name}\n"
                    f"💾 Saqlandi: Arxiv kanalida{caption_text}\n"
                    f"🔗 Manzil: {storage_data}",
                    reply_markup=get_user_keyboard()
                )
                context.user_data["mode"] = None
                
                logger.info(f"📦 Media arxivlandi: user_id={user_id}, type={message_type}, storage={storage_data}")
            else:
                await loading_msg.delete()
                await update.message.reply_text(
                    f"❌ **XATOLIK!**\n\n{error or 'Media arxivlashda xatolik yuz berdi.'}",
                    reply_markup=get_user_keyboard()
                )
        except Exception as e:
            logger.error(f"Media arxivlashda xato: {e}")
            try:
                await loading_msg.delete()
            except:
                pass
            await update.message.reply_text(
                f"❌ **XATOLIK!**\n\n{str(e)}",
                reply_markup=get_user_keyboard()
            )
        
        logger.info(f"📦 Media xabar saqlandi: user_id={user_id}, type={message_type}")
    else:
        await update.message.reply_text(
            "❌ Bu turdagi xabar qo'llab-quvvatlanmaydi!",
            reply_markup=get_user_keyboard()
        )

async def handle_admin_text(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str):
    """Admin text habarlari"""
    user_id = update.effective_user.id
    mode = context.user_data.get("mode")
    
    # Global o'zgaruvchilarni e'lon qilish
    global is_sending, last_send_time, random_messages
    
    if text == "📋 Foydalanuvchilar":
        users = get_all_users()
        if not users:
            await update.message.reply_text("📭 Hech qanday foydalanuvchi yo'q!")
            return
        
        msg = "📋 **FOYDALANUVCHILAR RO'YXATI**\n\n"
        
        for i, uid in enumerate(users[:20], 1):
            accounts = get_user_accounts(uid)
            subscription_end, is_premium = get_user_subscription(uid)
            
            status = "✅ Premium" if is_premium else "⏰ Aktiv" if subscription_end else "❌ Yo'q"
            accounts_count = len(accounts)
            
            msg += f"{i}. ID: {uid}\n"
            msg += f"   📊 Hisoblar: {accounts_count} ta\n"
            msg += f"   🔧 Status: {status}\n"
            
            if subscription_end:
                try:
                    sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
                    days_left = (sub_date - datetime.now()).days
                    if days_left >= 0:
                        msg += f"   ⏰ Qolgan: {days_left} kun\n"
                except:
                    pass
            
            msg += "\n"
        
        if len(users) > 20:
            msg += f"\n... va yana {len(users) - 20} ta foydalanuvchi"
        
        try:
            await update.message.reply_text(msg, parse_mode='Markdown')
        except Exception as e:
            await update.message.reply_text(msg)
    
    elif text == "⏳ So'rovlar":
        requests = get_pending_requests()
        if not requests:
            await update.message.reply_text("✅ Kutilayotgan so'rovlar yo'q!")
            return
        
        for req in requests:
            req_id, uid, uname, fname, lname, created_at = req
            
            # Created_at ni string formatga o'tkazish
            if isinstance(created_at, str):
                date_str = created_at
            else:
                date_str = created_at.strftime('%Y-%m-%d %H:%M:%S') if created_at else "Noma'lum"
            
            # Username formatini tuzatish
            username_display = f"@{uname}" if uname else "Yo'q"
            
            msg = f"📩 **So'rov #{req_id}**\n"
            msg += f"👤 Foydalanuvchi: {fname} {lname}\n"
            msg += f"🔗 Username: {username_display}\n"
            msg += f"🆔 ID: {uid}\n"
            msg += f"📅 Sana: {date_str}\n"
            msg += f"✅ Ruxsat: /add {uid} 30\n"
            msg += f"❌ Rad: /reject {req_id}\n"
            
            try:
                await update.message.reply_text(msg, parse_mode='Markdown')
            except Exception as e:
                await update.message.reply_text(msg)
        
        await update.message.reply_text(f"📊 Jami kutilayotgan so'rovlar: {len(requests)} ta", reply_markup=get_admin_keyboard())
    
    elif text == "➕ Ruxsat berish":
        await update.message.reply_text(
            "📝 **RUXSAT BERISH**\n\n"
            "Foydalanuvchi ID va kun sonini yuboring:\n\n"
            "Format: ID KUNLAR yoki /add ID KUNLAR\n"
            "Misollar:\n"
            "• /add 123456789 30 - 30 kunlik ruxsat\n"
            "• 123456789 1 - 1 kunlik ruxsat\n\n"
            "Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "grant_access"
    
    elif text == "🗑️ Hisob o'chirish":
        await update.message.reply_text(
            "🗑️ **HISOB O'CHIRISH**\n\n"
            "Foydalanuvchi ID sini yuboring:\n\n"
            "Format: /remove ID yoki REMOVE ID\n"
            "Misol: /remove 123456789\n\n"
            "Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "delete_user"
    
    elif text == "📊 Statistika":
        users = get_all_users()
        total_accounts = 0
        total_groups = 0
        total_messages = 0
        
        for uid in users:
            accounts = get_user_accounts(uid)
            total_accounts += len(accounts)
            
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            cursor.execute('SELECT COUNT(*) FROM groups WHERE user_id = ?', (uid,))
            total_groups += cursor.fetchone()[0]
            
            cursor.execute('SELECT COUNT(*) FROM messages WHERE user_id = ?', (uid,))
            total_messages += cursor.fetchone()[0]
            conn.close()
        
        requests_count = len(get_pending_requests())
        
        msg = "📊 **BOT STATISTIKASI**\n\n"
        msg += f"👥 Foydalanuvchilar: {len(users)} ta\n"
        msg += f"📱 Jami hisoblar: {total_accounts} ta\n"
        msg += f"👥 Jami guruhlar: {total_groups} ta\n"
        msg += f"📝 Jami xabarlar: {total_messages} ta\n"
        msg += f"⏳ Kutilayotgan so'rovlar: {requests_count} ta\n"
        msg += f"📦 Arxiv kanal: {get_setting('storage_channel', STORAGE_CHANNEL_USERNAME)}\n\n"
        msg += f"🔄 Avtomatik yuborish: {'✅ Yoqilgan' if is_sending else '❌ Oʻchirilgan'}\n"
        
        if last_send_time:
            msg += f"⏰ Oxirgi yuborish: {last_send_time}\n"
        
        try:
            await update.message.reply_text(msg, parse_mode='Markdown')
        except Exception as e:
            await update.message.reply_text(msg)
    
    elif text == "⚙️ Sozlamalar":
        keyboard = [
            ["📅 Interval sozlash", "🎲 Random rejim"],
            ["📢 Xush kelib xabari", "📌 Arxiv kanali"],
            ["🔙 Orqaga"]
        ]
        reply_markup = ReplyKeyboardMarkup(keyboard, resize_keyboard=True)
        
        await update.message.reply_text(
            "⚙️ **BOT SOZLAMALARI**\n\n"
            f"📅 Interval: {min_interval}-{max_interval} daqiqa\n"
            f"🎲 Random xabarlar: {'✅ Yoqilgan' if random_messages else '❌ Oʻchirilgan'}\n"
            f"📦 Arxiv kanal: {get_setting('storage_channel', STORAGE_CHANNEL_USERNAME)}\n"
            f"📢 Xush kelib xabari: {get_setting('welcome_message', 'Mavjud emas')[:50]}...\n\n"
            "Kerakli sozlamani tanlang:",
            reply_markup=reply_markup
        )
    
    elif text == "📅 Interval sozlash":
        await update.message.reply_text(
            f"📅 **INTERVAL SOZLASH**\n\n"
            f"Hozirgi interval: {min_interval}-{max_interval} daqiqa\n\n"
            "Yangi intervalni yuboring:\n"
            "Format: min max\n"
            "Misol: 15 30 (15-30 daqiqa)\n\n"
            "Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "set_interval"
    
    elif text == "🎲 Random rejim":
        current = get_setting('random_messages', 'true').lower() == 'true'
        new_setting = not current
        save_setting('random_messages', str(new_setting).lower())
        
        # Global o'zgaruvchini yangilash
        random_messages = new_setting
        
        await update.message.reply_text(
            f"✅ **Random rejim {'yoqildi' if new_setting else 'oʻchirildi'}!**\n\n"
            f"Hozir: {'🎲 Random xabarlar yuboriladi' if new_setting else '📝 Ketma-ket xabarlar yuboriladi'}"
        )
    
    elif text == "📢 Xush kelib xabari":
        current_msg = get_setting('welcome_message', '🤖 Botdan foydalanish uchun ruxsat kerak!')
        await update.message.reply_text(
            f"📢 **XUSH KELIB XABARI**\n\n"
            f"Hozirgi xabar:\n{current_msg}\n\n"
            "Yangi xabarni yuboring:\n\n"
            "Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "set_welcome"
    
    elif text == "📌 Arxiv kanali" or text == "📌 Kanal ID o'rnatish (Ixtiyoriy)":
        current_channel = get_setting('storage_channel', STORAGE_CHANNEL_USERNAME)
        
        await update.message.reply_text(
            f"📌 **ARXIV KANALI**\n\n"
            f"Hozirgi kanal: {current_channel}\n\n"
            "Yangi kanal username ni yuboring:\n"
            "(Misol: @my_storage_channel)\n\n"
            "Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "set_storage_channel"
    
    elif mode == "set_storage_channel":
        # Yangi arxiv kanalini sozlash
        new_channel = text.strip()
        
        if not new_channel.startswith('@'):
            await update.message.reply_text("❌ Kanal username @ bilan boshlanishi kerak!\nMisol: @my_storage_channel")
            return
        
        # Kanalga kirishni tekshirish
        try:
            # Bot kanalda adminligini tekshirish uchun sinov xabari yuborish
            test_msg = await context.bot.send_message(
                chat_id=new_channel,
                text="🤖 **Bot test xabari**\n\nBu kanal arxiv uchun sozlanmoqda..."
            )
            
            # Agar xabar yuborish muvaffaqiyatli bo'lsa
            await context.bot.delete_message(
                chat_id=new_channel,
                message_id=test_msg.message_id
            )
            
            # Sozlamani yangilash
            save_setting('storage_channel', new_channel)
            
            await update.message.reply_text(
                f"✅ **Arxiv kanali yangilandi!**\n\n"
                f"📦 Yangi kanal: {new_channel}\n\n"
                f"Endi barcha media fayllar ushbu kanalga saqlanadi.",
                reply_markup=get_admin_keyboard()
            )
            context.user_data["mode"] = None
            
        except Exception as e:
            await update.message.reply_text(
                f"❌ **XATOLIK!**\n\n"
                f"Kanalga kirishda xatolik: {str(e)}\n\n"
                f"Bot kanalda admin bo'lishi va xabar yubora olishi kerak.",
                reply_markup=get_admin_keyboard()
            )
            context.user_data["mode"] = None
    
    elif text == "🔙 Orqaga":
        await update.message.reply_text("👑 **Admin Paneli**", reply_markup=get_admin_keyboard())
        context.user_data.clear()
    
    elif text == "🔄 Session boshqarish":
        # Pending sessions ro'yxati
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT display_name, phone, user_id FROM pending_sessions')
        pending_sessions = cursor.fetchall()
        conn.close()
        
        if pending_sessions:
            msg = "⏳ **KUTILAYOTGAN SESSIONS**\n\n"
            for session in pending_sessions:
                display_name, phone, uid = session
                msg += f"📱 {display_name} (User: {uid})\n"
                msg += f"   📞 +{phone}\n"
                msg += f"   ⌨️ Kod kiritish: `/code {display_name} KOD`\n\n"
            
            await update.message.reply_text(msg)
        else:
            await update.message.reply_text("✅ Kutilayotgan sessionlar yo'q!")
        
        # Hisoblar ro'yxati
        users = get_all_users()
        
        keyboard = []
        for uid in users[:10]:
            accounts = get_user_accounts(uid)
            for acc in accounts:
                display_name, phone, _, _, is_active, _, _ = acc
                status = "✅" if is_active == 1 else "❌"
                # Display name'ni oddiy ko'rinishda chiqaramiz
                simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
                keyboard.append([f"{status} {simple_name} ({uid})"])
        
        keyboard.append(["🔙 Orqaga"])
        reply_markup = ReplyKeyboardMarkup(keyboard, resize_keyboard=True)
        
        await update.message.reply_text(
            "🔄 **SESSION BOSHQARISH**\n\n"
            "Hisobni tanlang:",
            reply_markup=reply_markup
        )
        context.user_data["mode"] = "select_session_account"
    
    elif text.startswith("✅ ") or text.startswith("❌ "):
        if mode == "select_session_account":
            # Format: "✅ 1 (123456789)" yoki "❌ 1 (123456789)"
            status_char = text[0]
            parts = text[2:].split(" (")
            if len(parts) == 2:
                simple_name = parts[0].strip()
                user_id_str = parts[1].replace(")", "").strip()
                
                try:
                    target_user_id = int(user_id_str)
                    
                    # Asl display name'ni topish
                    accounts = get_user_accounts(target_user_id)
                    display_name = None
                    for acc in accounts:
                        acc_name = acc[0]
                        # Simple name bilan solishtiramiz
                        if simple_name == acc_name.split('_')[-1] if '_' in acc_name else acc_name:
                            display_name = acc_name
                            break
                    
                    if not display_name:
                        await update.message.reply_text("❌ Hisob topilmadi!")
                        return
                    
                    context.user_data["session_account"] = display_name
                    context.user_data["session_user_id"] = target_user_id
                    
                    # Account ma'lumotlarini olish
                    accounts = get_user_accounts(target_user_id)
                    phone = ""
                    is_active = 0
                    for acc in accounts:
                        if acc[0] == display_name:
                            phone = acc[1]
                            is_active = acc[4]
                            break
                    
                    session_exists_flag = session_exists(display_name)
                    
                    keyboard = []
                    if not session_exists_flag:
                        keyboard.append(["📱 Session yaratish"])
                    else:
                        keyboard.append(["🧪 Sessionni test qilish"])
                        if is_active == 1:
                            keyboard.append(["📤 Test xabar yuborish"])
                    
                    keyboard.append(["🔙 Orqaga"])
                    reply_markup = ReplyKeyboardMarkup(keyboard, resize_keyboard=True)
                    
                    status_text = "Faol" if is_active == 1 else "Nofaol"
                    session_text = "Mavjud" if session_exists_flag else "Yo'q"
                    
                    await update.message.reply_text(
                        f"🔄 **SESSION BOSHQARISH**\n\n"
                        f"📱 Hisob: {display_name}\n"
                        f"👤 Foydalanuvchi ID: {target_user_id}\n"
                        f"📞 Telefon: +{phone}\n"
                        f"🔧 Status: {status_text}\n"
                        f"📁 Session fayli: {session_text}\n\n"
                        f"Kerakli amalni tanlang:",
                        reply_markup=reply_markup
                    )
                    context.user_data["mode"] = "manage_session"
                    
                except ValueError:
                    await update.message.reply_text("❌ Xatolik: Noto'g'ri format!")
    
    elif text == "📱 Session yaratish" and mode == "manage_session":
        display_name = context.user_data.get("session_account")
        target_user_id = context.user_data.get("session_user_id")
        
        # Account ma'lumotlarini olish
        accounts = get_user_accounts(target_user_id)
        phone = ""
        for acc in accounts:
            if acc[0] == display_name:
                phone = acc[1]
                break
        
        if not phone:
            await update.message.reply_text("❌ Telefon raqam topilmadi!")
            return
        
        await update.message.reply_text(f"⏳ Session yaratilmoqda: {display_name}...")
        
        success, message = await create_and_auth_session(target_user_id, display_name, phone)
        
        if success:
            await update.message.reply_text(
                f"✅ **SESSION YARATISH NATIJASI**\n\n"
                f"{message}\n\n"
                f"📱 Hisob: {display_name}\n"
                f"📞 Telefon: +{phone}\n\n"
                f"Admin endi kodni kiritishi kerak:\n"
                f"`/code {display_name} KOD`"
            )
        else:
            await update.message.reply_text(
                f"❌ **SESSION YARATISH XATOLIK**\n\n"
                f"{message}"
            )
    
    elif text == "🧪 Sessionni test qilish" and mode == "manage_session":
        display_name = context.user_data.get("session_account")
        
        await update.message.reply_text(f"⏳ Session test qilinmoqda: {display_name}...")
        
        success, message = await test_session(display_name)
        
        await update.message.reply_text(f"📝 **TEST NATIJASI**\n\n{message}")
    
    elif text == "📤 Test xabar yuborish" and mode == "manage_session":
        display_name = context.user_data.get("session_account")
        
        await update.message.reply_text(
            f"📤 **TEST XABAR YUBORISH**\n\n"
            f"📱 Hisob: {display_name}\n\n"
            f"Guruh ID yoki username ni yuboring:\n"
            f"(@guruh_nomi yoki https://t.me/guruh_nomi)\n\n"
            f"Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "send_test_message"
    
    elif mode == "send_test_message":
        display_name = context.user_data.get("session_account")
        group_identifier = text.strip()
        
        test_message = "🤖 Test xabar - Bu bot tomonidan yuborilgan test xabari!"
        
        await update.message.reply_text(f"⏳ Test xabar yuborilmoqda...\nHisob: {display_name}\nGuruh: {group_identifier}")
        
        success, result_message = await send_message_to_group(display_name, group_identifier, test_message)
        
        await update.message.reply_text(f"📝 **TEST XABAR NATIJASI**\n\n{result_message}")
        
        context.user_data["mode"] = "manage_session"
    
    elif text == "🔙 Orqaga" and mode in ["select_session_account", "manage_session"]:
        await update.message.reply_text("👑 **Admin Paneli**", reply_markup=get_admin_keyboard())
        context.user_data.clear()
    
    elif text == "📢 Xabar yuborish":
        active_users = get_all_active_user_ids()
        
        await update.message.reply_text(
            f"📢 **XABAR YUBORISH**\n\n"
            f"👥 Faol foydalanuvchilar: {len(active_users)} ta\n\n"
            f"⌨️ Yubormoqchi bo'lgan xabaringizni yozing:\n\n"
            f"Bekor qilish: /cancel",
            reply_markup=ReplyKeyboardRemove()
        )
        context.user_data["mode"] = "broadcast_message"
    
    elif mode == "broadcast_message":
        # Broadcast xabarni yuborish
        broadcast_text = text.strip()
        
        if not broadcast_text:
            await update.message.reply_text("❌ Xabar bo'sh bo'lishi mumkin emas!")
            return
        
        active_users = get_all_active_user_ids()
        
        if not active_users:
            await update.message.reply_text(
                "❌ Faol foydalanuvchilar yo'q!",
                reply_markup=get_admin_keyboard()
            )
            context.user_data.clear()
            return
        
        await update.message.reply_text(
            f"📤 **Xabar yuborilmoqda...**\n\n"
            f"👥 Jami: {len(active_users)} ta foydalanuvchi\n"
            f"⏳ Iltimos kuting..."
        )
        
        sent_count = 0
        failed_count = 0
        
        for i, target_user_id in enumerate(active_users):
            try:
                await context.bot.send_message(
                    chat_id=target_user_id,
                    text=f"📢 **ADMIN XABARI**\n\n{broadcast_text}"
                )
                sent_count += 1
            except Exception as e:
                logger.error(f"Broadcast xato (user_id: {target_user_id}): {e}")
                failed_count += 1
            
            # 100 xabar/soniya = har bir xabar uchun 0.01 soniya kutish
            if (i + 1) % 100 == 0:
                await asyncio.sleep(1)
            else:
                await asyncio.sleep(0.01)
        
        await update.message.reply_text(
            f"✅ **XABAR YUBORILDI!**\n\n"
            f"📤 Yuborildi: {sent_count} ta\n"
            f"❌ Xato: {failed_count} ta\n"
            f"👥 Jami: {len(active_users)} ta",
            reply_markup=get_admin_keyboard()
        )
        context.user_data.clear()
    
    elif text == "🔄 Avtomatik yuborish":
        # Global o'zgaruvchilarni yangilash
        is_sending = True
        last_send_time = datetime.now().strftime("%H:%M:%S")
        
        await update.message.reply_text(
            "✅ **Avtomatik yuborish yoqildi!**\n\n"
            f"⏰ Interval: {min_interval}-{max_interval} daqiqa\n"
            f"🎲 Random: {'✅ Yoqilgan' if random_messages else '❌ Oʻchirilgan'}\n\n"
            f"Barcha faol hisoblardagi faol guruhlarga xabar yuboriladi."
        )
    
    elif text == "⏸️ To'xtatish":
        # Global o'zgaruvchini yangilash
        is_sending = False
        await update.message.reply_text("⏸️ **Avtomatik yuborish to'xtatildi!**")
    
    elif text == "🔄 Yangilash":
        pending_requests = get_pending_requests()
        await update.message.reply_text(
            f"🔄 **YANGILANDI**\n\n"
            f"📊 Jami foydalanuvchilar: {len(get_all_users())}\n"
            f"⏳ Kutilayotgan so'rovlar: {len(pending_requests)}\n"
            f"📦 Arxiv kanal: {get_setting('storage_channel', STORAGE_CHANNEL_USERNAME)}",
            reply_markup=get_admin_keyboard()
        )
    
    elif mode == "grant_access":
        await process_grant_access(update, context, text)
    
    elif mode == "delete_user":
        await process_delete_user(update, context, text)
    
    elif mode == "set_interval":
        await process_set_interval(update, context, text)
    
    elif mode == "set_welcome":
        await process_set_welcome(update, context, text)
    
    elif text.startswith("/add") or text.lower().startswith("add "):
        await process_add_command(update, context, text)
    
    elif text.startswith("/reject") or text.lower().startswith("reject "):
        await process_reject_command(update, context, text)
    
    elif text.startswith("/remove") or text.lower().startswith("remove "):
        await process_remove_command(update, context, text)
    
    elif text == "/cancel":
        await update.message.reply_text("❌ **Bekor qilindi!**", reply_markup=get_admin_keyboard())
        context.user_data.clear()
    
    else:
        await update.message.reply_text("❌ Noma'lum buyruq! Menyudagi tugmalardan foydalaning.", reply_markup=get_admin_keyboard())

async def handle_user_text(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str):
    """Oddiy foydalanuvchi text habarlari"""
    user_id = update.effective_user.id
    mode = context.user_data.get("mode")
    global is_sending, last_send_time
    
    # Obunani tekshirish
    subscription_end, is_premium = get_user_subscription(user_id)
    
    has_active_subscription = False
    days_left = 0
    
    if subscription_end:
        try:
            sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
            days_left = (sub_date - datetime.now()).days
            if days_left > 0:
                has_active_subscription = True
        except Exception as e:
            logger.error(f"Sanani o'qishda xato: {e}")
            has_active_subscription = False
    
    # Agar obuna aktiv bo'lmasa
    if not has_active_subscription:
        welcome_message = get_setting('welcome_message', '🤖 Botdan foydalanish uchun ruxsat kerak!')
        await update.message.reply_text(welcome_message)
        
        # So'rov qo'shish
        username = update.effective_user.username
        first_name = update.effective_user.first_name
        last_name = update.effective_user.last_name or ""
        
        request_id = add_request(user_id, username, first_name, last_name)
        
        if request_id:
            try:
                await context.bot.send_message(
                    ADMIN_ID,
                    f"📩 **YANGI SO'ROV!**\n\n"
                    f"👤 Foydalanuvchi: {first_name} {last_name}\n"
                    f"🔗 Username: @{username or 'Yoq'}\n"
                    f"🆔 ID: {user_id}\n"
                    f"📅 Sana: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n"
                    f"✅ Ruxsat berish: /add {user_id} 30\n"
                    f"❌ Rad etish: /reject {request_id}"
                )
            except Exception as e:
                logger.error(f"Admin ga xabar yuborishda xato: {e}")
        return
    
    # Agar obuna aktiv bo'lsa
    if text == "➕ Hisob qo'shish":
        # Hisoblar sonini tekshirish
        accounts_count = get_user_accounts_count(user_id)
        if accounts_count >= 5:
            await update.message.reply_text(
                "❌ **Hisob limitiga yetdingiz!**\n\n"
                f"Sizda allaqachon {accounts_count} ta hisob mavjud.\n"
                "Har bir foydalanuvchi maksimal 5 ta hisob qo'sha oladi.",
                reply_markup=get_user_keyboard()
            )
            return
        
        keyboard = [[InlineKeyboardButton("❌ Bekor qilish", callback_data="cancel_add_account")]]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await update.message.reply_text(
            "📱 **TELEFON RAQAM KIRITING**\n\n"
            "Format: +998901234567 yoki 998901234567\n"
            f"📊 Sizda {accounts_count}/5 ta hisob mavjud\n\n"
            "⌨️ Telefon raqamni yozing:",
            reply_markup=reply_markup
        )
        context.user_data["mode"] = "add_account"
    
    elif text == "🧪 Session test":
        accounts = get_user_accounts(user_id)
        if not accounts:
            await update.message.reply_text("❌ Hech qanday hisob yo'q!")
            return
        
        msg = "🔍 **SESSION HOLATI**\n\n"
        
        for acc in accounts:
            display_name, phone, _, _, is_active, _, _ = acc
            
            # Session faylini tekshirish
            session_exists_flag = session_exists(display_name)
            
            # Simple name chiqaramiz
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            
            msg += f"📱 **{simple_name}** (+{phone})\n"
            msg += f"   📁 Session fayli: {'✅ Mavjud' if session_exists_flag else '❌ Yoʻq'}\n"
            msg += f"   🔧 Status: {'✅ Faol' if is_active == 1 else '❌ Nofaol'}\n\n"
        
        await update.message.reply_text(msg, reply_markup=get_user_keyboard())
    
    elif text == "📤 Xabar qo'shish":
        await update.message.reply_text(
            "📝 **XABAR YUBORING**\n\n"
            "Istalgan turdagi xabar yuboring:\n"
            "📷 Rasm\n"
            "🎬 Video\n"
            "📄 Fayl\n"
            "🎵 Audio\n"
            "🎤 Ovozli xabar\n"
            "🎨 Stiker\n"
            "🎞 GIF\n"
            "📝 Matn\n\n"
            "Bu xabarlar guruhlaringizga yuboriladi.\n"
            "📦 Media fayllar arxiv kanalida saqlanadi.\n\n"
            "Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "add_message"
    
    elif text == "🔗 Guruh qo'shish":
        accounts = get_user_accounts(user_id)
        if not accounts:
            await update.message.reply_text("❌ **Avval hisob qo'shing!**", reply_markup=get_user_keyboard())
            return
        
        keyboard = []
        for acc in accounts:
            display_name = acc[0]
            phone = acc[1]
            # Simple name chiqaramiz
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            keyboard.append([f"📱 {simple_name} (+{phone})"])
        
        keyboard.append(["🔙 Orqaga"])
        reply_markup = ReplyKeyboardMarkup(keyboard, resize_keyboard=True)
        
        await update.message.reply_text(
            "📱 **HISOB TANLANG**\n\n"
            "Qaysi hisobga guruh qo'shmoqchisiz?\n\n"
            "Bekor qilish: /cancel",
            reply_markup=reply_markup
        )
        context.user_data["mode"] = "select_account"
    
    elif text == "👥 Guruhlarni ko'rish":
        accounts = get_user_accounts(user_id)
        if not accounts:
            await update.message.reply_text("❌ Hech qanday hisob yo'q!")
            return
        
        msg = "👥 **GURUHLAR RO'YXATI**\n\n"
        
        for acc in accounts:
            display_name = acc[0]
            phone = acc[1]
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            groups = get_user_groups(user_id, display_name)
            
            active_groups = sum(1 for g in groups if g[4] == 1)
            total_groups = len(groups)
            
            msg += f"📱 **{simple_name}** (+{phone})\n"
            msg += f"   📊 Guruhlar: {active_groups}/{total_groups} ta\n\n"
        
        keyboard = [[InlineKeyboardButton("⚙️ Guruhlarni boshqarish", callback_data="manage_groups")]]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        try:
            await update.message.reply_text(msg, reply_markup=reply_markup, parse_mode='Markdown')
        except:
            await update.message.reply_text(msg, reply_markup=reply_markup)
    
    elif text == "⚙️ Interval sozlash":
        # Foydalanuvchi intervalini olish
        user_min_interval, user_max_interval = get_user_interval(user_id)
        
        await update.message.reply_text(
            f"⚙️ **INTERVAL SOZLASH**\n\n"
            f"Hozirgi interval: {user_min_interval}-{user_max_interval} daqiqa\n\n"
            "Yangi intervalni yuboring:\n"
            "Format: min max\n"
            "Misol: 10 20 (10-20 daqiqa)\n\n"
            "Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "set_user_interval"
    
    elif text == "🎲 Random rejim":
        # Foydalanuvchi uchun random rejim sozlash
        current = context.user_data.get("random_messages", True)
        new_setting = not current
        context.user_data["random_messages"] = new_setting
        
        await update.message.reply_text(
            f"✅ **Random rejim {'yoqildi' if new_setting else 'oʻchirildi'}!**\n\n"
            f"Hozir: {'🎲 Random xabarlar yuboriladi' if new_setting else '📝 Ketma-ket xabarlar yuboriladi'}"
        )
    
    elif text == "▶️ Boshlash":
        # Global o'zgaruvchilarni yangilash
        is_sending = True
        last_send_time = datetime.now().strftime("%H:%M:%S")
        
        # Foydalanuvchi intervalini olish
        user_min_interval, user_max_interval = get_user_interval(user_id)
        
        await update.message.reply_text(
            "✅ **Avtomatik yuborish boshlandi!**\n\n"
            f"⏰ Interval: {user_min_interval}-{user_max_interval} daqiqa\n"
            f"🎲 Random: {'✅ Yoqilgan' if context.user_data.get('random_messages', True) else '❌ Oʻchirilgan'}\n\n"
            f"Barcha faol hisoblardagi faol guruhlarga xabar yuboriladi."
        )
    
    elif text == "⏹️ To'xtatish":
        # Global o'zgaruvchini yangilash
        is_sending = False
        await update.message.reply_text("⏹️ **Avtomatik yuborish to'xtatildi!**")
    
    elif text == "📋 Hisoblar":
        accounts = get_user_accounts(user_id)
        if not accounts:
            await update.message.reply_text("📭 Hech qanday hisob yo'q!\n\nHisob qo'shish uchun '➕ Hisob qo'shish' tugmasini bosing.")
            return
        
        keyboard = [
            [InlineKeyboardButton("👁 Hisoblarni ko'rish", callback_data="view_accounts")],
            [InlineKeyboardButton("🗑️ Hisobni o'chirish", callback_data="delete_account_menu")],
            [InlineKeyboardButton("🔙 Orqaga", callback_data="back_to_main")],
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await update.message.reply_text(
            f"📋 **HISOBLAR**\n\n"
            f"📊 Sizda {len(accounts)} ta hisob mavjud.\n\n"
            f"Kerakli amalni tanlang:",
            reply_markup=reply_markup
        )
    
    elif text == "📝 Xabarlar":
        messages = get_user_messages(user_id)
        if not messages:
            await update.message.reply_text("📭 Hech qanday xabar yo'q!")
            return
        
        type_icons = {
            'text': '📝',
            'photo': '📷',
            'video': '🎬',
            'document': '📄',
            'audio': '🎵',
            'voice': '🎤',
            'sticker': '🎨',
            'animation': '🎞',
            'video_note': '⭕'
        }
        
        msg = "📝 **XABARLAR RO'YXATI**\n\n"
        
        for i, m in enumerate(messages[:10], 1):
            # m = (id, message_type, storage_data, text)
            msg_id, msg_type, storage_data, msg_text = m
            msg_type = msg_type or 'text'
            icon = type_icons.get(msg_type, '📦')
            
            if msg_type == 'text' and msg_text:
                display_text = msg_text[:40] + "..." if len(msg_text) > 40 else msg_text
                msg += f"{i}. {icon} {display_text}\n\n"
            elif msg_text:
                display_text = msg_text[:30] + "..." if len(msg_text) > 30 else msg_text
                msg += f"{i}. {icon} [{msg_type.upper()}] {display_text}\n\n"
            else:
                msg += f"{i}. {icon} [{msg_type.upper()}]\n\n"
        
        if len(messages) > 10:
            msg += f"\n... va yana {len(messages) - 10} ta xabar"
        
        await update.message.reply_text(msg)
    
    elif text == "🗑️ Xabarlarni tozalash":
        messages = get_user_messages(user_id)
        if not messages:
            await update.message.reply_text("📭 Hech qanday xabar yo'q!")
            return
        
        keyboard = [
            [InlineKeyboardButton("✅ Ha, tozalash", callback_data="confirm_clear_messages")],
            [InlineKeyboardButton("❌ Yo'q, bekor qilish", callback_data="back_to_main")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await update.message.reply_text(
            f"🗑️ **XABARLARNI TOZALASH**\n\n"
            f"⚠️ Sizda {len(messages)} ta xabar mavjud.\n\n"
            f"Barcha xabarlarni o'chirmoqchimisiz?\n"
            f"Bu amalni bekor qilib bo'lmaydi!",
            reply_markup=reply_markup
        )
    
    elif text == "📊 Statistika":
        accounts = get_user_accounts(user_id)
        total_groups = 0
        active_groups = 0
        total_messages = len(get_user_messages(user_id))
        
        for acc in accounts:
            display_name = acc[0]
            groups = get_user_groups(user_id, display_name)
            total_groups += len(groups)
            active_groups += sum(1 for g in groups if g[4] == 1)
        
        sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
        days_left = (sub_date - datetime.now()).days
        
        # Foydalanuvchi intervalini olish
        user_min_interval, user_max_interval = get_user_interval(user_id)
        
        msg = "📊 **STATISTIKA**\n\n"
        msg += f"📱 Hisoblar: {len(accounts)}/5 ta\n"
        msg += f"👥 Faol guruhlar: {active_groups}/{total_groups} ta\n"
        msg += f"📝 Xabarlar: {total_messages} ta\n"
        msg += f"📅 Obuna: {days_left} kun qoldi\n"
        msg += f"⏱️ Interval: {user_min_interval}-{user_max_interval} daqiqa\n"
        msg += f"📦 Media saqlash: Arxiv kanalida\n"
        msg += f"🔄 Yuborish: {'✅ Yoqilgan' if is_sending else '❌ Oʻchirilgan'}"
        
        try:
            await update.message.reply_text(msg, parse_mode='Markdown')
        except:
            await update.message.reply_text(msg)
    
    elif text.startswith("📱 ") and mode == "select_account":
        simple_name = text[2:].split(" ")[0]
        
        # Asl display name'ni topish
        accounts = get_user_accounts(user_id)
        display_name = None
        for acc in accounts:
            acc_name = acc[0]
            if simple_name == acc_name.split('_')[-1] if '_' in acc_name else acc_name:
                display_name = acc_name
                break
        
        if not display_name:
            await update.message.reply_text("❌ Hisob topilmadi!")
            return
        
        context.user_data["selected_account"] = display_name
        
        await update.message.reply_text(
            f"✅ **{simple_name} tanlandi!**\n\n"
            "Endi guruhlarni yuboring:\n"
            "• Har bir guruh alohida qatorda\n"
            "• @guruh_nomi yoki https://t.me/guruh_nomi\n\n"
            "Bekor qilish: /cancel"
        )
        context.user_data["mode"] = "add_groups"
    
    elif text == "🔙 Orqaga":
        await update.message.reply_text("🤖 **Asosiy menyu**", reply_markup=get_user_keyboard())
        context.user_data.clear()
    
    elif text == "/cancel":
        await update.message.reply_text("❌ **Bekor qilindi!**", reply_markup=get_user_keyboard())
        context.user_data.clear()
    
    elif mode == "add_account":
        accounts_count = get_user_accounts_count(user_id)
        if accounts_count >= 5:
            await update.message.reply_text(
                "❌ **Hisob limitiga yetdingiz!**\n\n"
                "Sizda allaqachon 5 ta hisob mavjud.",
                reply_markup=get_user_keyboard()
            )
            context.user_data.clear()
            return
        
        context.user_data["phone"] = text.strip()
        
        # Telefon raqam formatini tekshirish
        phone = context.user_data["phone"]
        if not phone:
            await update.message.reply_text("❌ Telefon raqam kiritilmadi!")
            return
        
        # Telefon raqamni tozalash
        if phone.startswith('+'):
            phone = phone[1:]
        elif phone.startswith('998'):
            pass
        else:
            await update.message.reply_text("❌ Noto'g'ri format! Misol: +998901234567 yoki 998901234567")
            return
        
        # Display name yaratish
        account_number = get_next_account_number(user_id)
        if account_number is None:
            await update.message.reply_text("❌ Hisob limitiga yetdingiz! Maksimum 5 ta hisob.")
            return
        
        display_name = f"account_{user_id}_{account_number}"
        
        # Hisobni bazaga qo'shish
        result = add_user_account(user_id, phone=phone, country_code="998", username="", display_name=display_name)
        
        if result:
            # Simple name (faqat oxirgi raqam)
            simple_name = str(account_number)
            
            await update.message.reply_text(
                f"✅ **HISOB QO'SHILDI!**\n\n"
                f"📱 Hisob: {simple_name}\n"
                f"📞 Telefon: +{phone}\n\n"
                f"⏳ Kod yuborilmoqda..."
            )
            
            # Session yaratish jarayonini boshlash
            success, message = await create_and_auth_session(user_id, display_name, phone)
            
            if success and message.startswith("ENTER_CODE:"):
                # Foydalanuvchidan kodni so'rash
                pending_display_name = message.replace("ENTER_CODE:", "")
                context.user_data["mode"] = "enter_code"
                context.user_data["pending_account"] = pending_display_name
                
                await update.message.reply_text(
                    f"📱 **KOD YUBORILDI!**\n\n"
                    f"📞 +{phone} raqamiga SMS kod yuborildi.\n\n"
                    f"⌨️ Iltimos, kelgan kodni kiriting:\n"
                    f"(Masalan: 12345)\n\n"
                    f"Bekor qilish: /cancel",
                    reply_markup=ReplyKeyboardRemove()
                )
            elif success:
                await update.message_reply_text(
                    f"✅ **Hisob faollashtirildi!**\n\n{message}",
                    reply_markup=get_user_keyboard()
                )
                context.user_data.clear()
            else:
                await update.message.reply_text(
                    f"⚠️ **Session yaratishda xatolik:**\n\n{message}",
                    reply_markup=get_user_keyboard()
                )
                context.user_data.clear()
        else:
            await update.message.reply_text(
                "❌ Hisob qo'shishda xatolik! Telefon raqam allaqachon mavjud yoki hisob limitiga yetdingiz.",
                reply_markup=get_user_keyboard()
            )
            context.user_data.clear()
    
    elif mode == "add_message":
        # Oddiy text xabar qo'shish
        add_user_message(user_id, text, message_type='text', storage_data=None)
        await update.message.reply_text(
            f"✅ **XABAR QO'SHILDI!**\n\n"
            f"📦 Turi: 📝 Matn\n"
            f"📄 Xabar: {text[:100]}{'...' if len(text) > 100 else ''}",
            reply_markup=get_user_keyboard()
        )
        context.user_data["mode"] = None
    
    elif mode == "add_groups":
        account_display_name = context.user_data.get("selected_account")
        
        if not account_display_name:
            await update.message.reply_text("❌ Xatolik: Hisob tanlanmagan!", reply_markup=get_user_keyboard())
            context.user_data.clear()
            return
        
        groups_input = text.strip()
        groups_list = []
        
        if ',' in groups_input:
            groups_list = [g.strip() for g in groups_input.split(',') if g.strip()]
        else:
            groups_list = [line.strip() for line in groups_input.split('\n') if line.strip()]
        
        if not groups_list:
            await update.message.reply_text("❌ Hech qanday guruh kiritilmadi!", reply_markup=get_user_keyboard())
            return
        
        added_count, skipped_count = add_group_batch(user_id, account_display_name, groups_list)
        
        keyboard = [
            [InlineKeyboardButton("✅ Tugatish", callback_data="finish_groups")],
            [InlineKeyboardButton("🔙 Orqaga", callback_data="back_to_main")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await update.message.reply_text(
            f"📊 **NATIJALAR**\n\n"
            f"✅ Qo'shildi: {added_count} ta guruh\n"
            f"⚠️ O'tkazib yuborildi: {skipped_count} ta (mavjud)\n\n"
            f"Endi nima qilmoqchisiz?",
            reply_markup=reply_markup
        )
    
    elif mode == "set_user_interval":
        try:
            parts = text.split()
            if len(parts) != 2:
                await update.message.reply_text("❌ Format: min max\nMisol: 10 20")
                return
            
            min_val = int(parts[0])
            max_val = int(parts[1])
            
            if min_val <= 0 or max_val <= 0:
                await update.message.reply_text("❌ Interval 0 dan katta bo'lishi kerak!")
                return
            
            if min_val >= max_val:
                await update.message.reply_text("❌ Min interval max dan kichik bo'lishi kerak!")
                return
            
            # Intervalni saqlash
            save_user_interval(user_id, min_val, max_val)
            
            await update.message.reply_text(
                f"✅ **Interval yangilandi!**\n\n"
                f"📅 Yangi interval: {min_val}-{max_val} daqiqa",
                reply_markup=get_user_keyboard()
            )
            context.user_data["mode"] = None
            
        except ValueError:
            await update.message.reply_text("❌ Noto'g'ri format! Faqat raqam kiriting.")
        except Exception as e:
            await update.message.reply_text(f"❌ Xatolik: {str(e)}", reply_markup=get_user_keyboard())
            context.user_data["mode"] = None
    
    elif mode == "enter_code":
        # Foydalanuvchi kodni kiritmoqda
        code = text.strip()
        pending_account = context.user_data.get("pending_account")
        
        if not pending_account:
            # Pending session ni user_id bo'yicha topamiz
            pending_data = get_pending_session_by_user(user_id)
            if pending_data:
                pending_account = pending_data[0]
        
        if not pending_account:
            await update.message.reply_text(
                "❌ Kutilayotgan hisob topilmadi! Iltimos, qaytadan hisob qo'shing.",
                reply_markup=get_user_keyboard()
            )
            context.user_data.clear()
            return
        
        await update.message.reply_text(f"⏳ Kod tekshirilmoqda: {pending_account}...")
        
        success, message = await enter_code(pending_account, code)
        
        if success:
            await update.message.reply_text(
                f"✅ **HISOB FAOLLASHTIRILDI!**\n\n"
                f"📱 Hisob: {pending_account.split('_')[-1] if '_' in pending_account else pending_account}\n"
                f"✅ Status: Faol\n\n"
                f"Endi guruh qo'shishingiz va xabar yuborishingiz mumkin!",
                reply_markup=get_user_keyboard()
            )
            context.user_data.clear()
        elif "2FA" in message or "parol" in message.lower():
            # 2FA parol kerak
            context.user_data["mode"] = "enter_password"
            context.user_data["pending_account"] = pending_account
            
            await update.message.reply_text(
                f"🔐 **2FA PAROL KERAK!**\n\n"
                f"📱 Hisob: {pending_account.split('_')[-1] if '_' in pending_account else pending_account}\n\n"
                f"⌨️ Iltimos, 2FA parolingizni kiriting:\n"
                f"(Agar paroldan keyin kod ham kerak bo'lsa: parol.kod)\n\n"
                f"Bekor qilish: /cancel",
                reply_markup=ReplyKeyboardRemove()
            )
        else:
            await update.message.reply_text(
                f"❌ **KOD XATO!**\n\n{message}\n\n"
                f"Iltimos, to'g'ri kodni kiriting yoki /cancel bosing.",
                reply_markup=ReplyKeyboardRemove()
            )
    
    elif mode == "enter_password":
        # Foydalanuvchi 2FA parolni kiritmoqda
        password_input = text.strip()
        pending_account = context.user_data.get("pending_account")
        
        if not pending_account:
            await update.message.reply_text(
                "❌ Kutilayotgan hisob topilmadi! Iltimos, qaytadan hisob qo'shing.",
                reply_markup=get_user_keyboard()
            )
            context.user_data.clear()
            return
        
        # Parol.kod formatini tekshirish
        password = password_input
        extra_code = None
        if '.' in password_input:
            parts = password_input.rsplit('.', 1)
            if len(parts) == 2 and parts[1].isdigit():
                password = parts[0]
                extra_code = parts[1]
        
        await update.message.reply_text(f"⏳ Parol tekshirilmoqda: {pending_account}...")
        
        success, message = await enter_password(pending_account, password)
        
        if success:
            await update.message.reply_text(
                f"✅ **HISOB TO'LIQ FAOLLASHTIRILDI!**\n\n"
                f"📱 Hisob: {pending_account.split('_')[-1] if '_' in pending_account else pending_account}\n"
                f"🔐 2FA parol tasdiqlandi\n"
                f"✅ Status: To'liq faol\n\n"
                f"Endi guruh qo'shishingiz va xabar yuborishingiz mumkin!",
                reply_markup=get_user_keyboard()
            )
            context.user_data.clear()
        else:
            await update.message.reply_text(
                f"❌ **PAROL XATO!**\n\n{message}\n\n"
                f"Iltimos, to'g'ri parolni kiriting yoki /cancel bosing.",
                reply_markup=ReplyKeyboardRemove()
            )
    
    else:
        await update.message.reply_text("❌ Noma'lum buyruq! Menyudagi tugmalardan foydalaning yoki /start ni bosing.", reply_markup=get_user_keyboard())

# ========== QOLGAN FUNKSIYALAR ==========

def parse_id_days(raw_text: str):
    """raw_text ichidan ID va kunlarni oladi (bardoshli)"""
    if not raw_text:
        return None, None
    s = raw_text.strip()
    s = s.lstrip('/')  # /add ... bo'lsa olib tashla
    # agar boshida 'add' so'zi bo'lsa olib tashla
    if s.lower().startswith('add '):
        s = s[4:].strip()
    parts = s.split()
    if len(parts) < 2:
        return None, None
    try:
        user_id = int(parts[0])
        days = int(parts[1])
        return user_id, days
    except:
        return None, None

def parse_single_id(raw_text: str):
    if not raw_text:
        return None
    s = raw_text.strip()
    s = s.lstrip('/')
    # remove command word if present
    if s.lower().startswith('reject '):
        s = s[7:].strip()
    if s.lower().startswith('remove '):
        s = s[7:].strip()
    parts = s.split()
    if not parts:
        return None
    try:
        return int(parts[0])
    except:
        return None

async def process_grant_access(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str):
    """Grant access from admin mode"""
    try:
        target_user_id, days = parse_id_days(text)
        if target_user_id is None or days is None:
            await update.message.reply_text("❌ Noto'g'ri format! To'g'ri format: ID KUNLAR yoki /add ID KUNLAR")
            return
        
        if days <= 0:
            await update.message.reply_text("❌ Kunlar soni 0 dan katta bo'lishi kerak!")
            return
        
        subscription_end = update_user_subscription(target_user_id, days)
        
        if subscription_end:
            sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
            
            # So'rovni approved qilish
            request = get_request_by_user_id(target_user_id)
            if request:
                update_request_status(request[0], "approved", f"Admin tomonidan {days} kun ruxsat berildi")
            
            # Foydalanuvchiga xabar yuborish
            try:
                await context.bot.send_message(
                    target_user_id,
                    f"🎉 **Tabriklaymiz!**\n\n"
                    f"Sizga {days} kunlik ruxsat berildi!\n"
                    f"⏰ Tugash sanasi: {sub_date.strftime('%Y-%m-%d %H:%M:%S')}\n\n"
                    f"🤖 Endi botdan to'liq foydalanishingiz mumkin!\n"
                    f"Yangilash uchun /start ni bosing."
                )
            except Exception as e:
                logger.error(f"Foydalanuvchiga xabar yuborishda xato: {e}")
            
            await update.message.reply_text(
                f"✅ **Ruxsat berildi!**\n\n"
                f"👤 Foydalanuvchi ID: {target_user_id}\n"
                f"📅 Kunlar: {days} kun\n"
                f"⏰ Tugash sanasi: {sub_date.strftime('%Y-%m-%d %H:%M:%S')}\n\n"
                f"Foydalanuvchi endi botdan foydalana oladi.",
                reply_markup=get_admin_keyboard()
            )
        else:
            await update.message.reply_text("❌ Ruxsat berishda xatolik!", reply_markup=get_admin_keyboard())
        
        context.user_data["mode"] = None
        
    except Exception as e:
        await update.message.reply_text(f"❌ Xatolik: {str(e)}", reply_markup=get_admin_keyboard())
        context.user_data["mode"] = None

async def process_delete_user(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str):
    try:
        target_user_id = parse_single_id(text)
        if target_user_id is None:
            await update.message.reply_text("❌ Noto'g'ri ID! Faqat raqam kiriting.")
            return
        
        # Arxiv kanaldan ma'lumotlarni o'chirish
        deleted_count, failed_count = await delete_user_data_from_channel(target_user_id, context)
        
        # Bazadan ma'lumotlarni o'chirish
        delete_user_data(target_user_id)
        
        await update.message.reply_text(
            f"✅ **Foydalanuvchi o'chirildi!**\n\n"
            f"👤 Foydalanuvchi ID: {target_user_id}\n"
            f"🗑️ Arxivdan o'chirildi: {deleted_count} ta xabar\n"
            f"❌ Arxiv xatolari: {failed_count} ta\n\n"
            f"Barcha ma'lumotlar tozalandi.",
            reply_markup=get_admin_keyboard()
        )
        
        try:
            await context.bot.send_message(
                target_user_id,
                "⚠️ **Sizning hisobingiz o'chirildi!**\n\n"
                "Barcha ma'lumotlaringiz tozalandi.\n"
                "Qayta foydalanish uchun @Okean_manager ga murojaat qiling."
            )
        except:
            pass
        
        context.user_data["mode"] = None
        
    except Exception as e:
        await update.message.reply_text(f"❌ Xatolik: {str(e)}", reply_markup=get_admin_keyboard())
        context.user_data["mode"] = None

async def process_set_interval(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str):
    try:
        parts = text.split()
        if len(parts) != 2:
            await update.message.reply_text("❌ Format: min max\nMisol: 15 30")
            return
        
        min_val = int(parts[0])
        max_val = int(parts[1])
        
        if min_val <= 0 or max_val <= 0:
            await update.message.reply_text("❌ Interval 0 dan katta bo'lishi kerak!")
            return
        
        if min_val >= max_val:
            await update.message.reply_text("❌ Min interval max dan kichik bo'lishi kerak!")
            return
        
        save_setting('min_interval', str(min_val))
        save_setting('max_interval', str(max_val))
        
        # Global o'zgaruvchilarni yangilash
        global min_interval, max_interval
        min_interval = min_val
        max_interval = max_val
        
        await update.message.reply_text(
            f"✅ **Interval yangilandi!**\n\n"
            f"📅 Yangi interval: {min_interval}-{max_interval} daqiqa",
            reply_markup=get_admin_keyboard()
        )
        context.user_data["mode"] = None
        
    except ValueError:
        await update.message.reply_text("❌ Noto'g'ri format! Faqat raqam kiriting.")
    except Exception as e:
        await update.message.reply_text(f"❌ Xatolik: {str(e)}", reply_markup=get_admin_keyboard())
        context.user_data["mode"] = None

async def process_set_welcome(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str):
    save_setting('welcome_message', text)
    
    await update.message.reply_text(
        f"✅ **Xush kelib xabari yangilandi!**\n\n"
        f"Yangi xabar:\n{text[:200]}{'...' if len(text) > 200 else ''}",
        reply_markup=get_admin_keyboard()
    )
    context.user_data["mode"] = None

async def process_add_command(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str = None):
    """/add command or called from text handler"""
    try:
        raw_text = text if text is not None else (update.message.text if update.message and update.message.text else "")
        target_user_id, days = parse_id_days(raw_text)
        if target_user_id is None or days is None:
            # try context.args fallback
            if context.args and len(context.args) >= 2:
                try:
                    target_user_id = int(context.args[0])
                    days = int(context.args[1])
                except:
                    await update.message.reply_text("❌ Format: /add ID KUNLAR\nMisol: /add 123456789 30")
                    return
            else:
                await update.message.reply_text("❌ Format: /add ID KUNLAR\nMisol: /add 123456789 30")
                return
        
        if days <= 0:
            await update.message.reply_text("❌ Kunlar soni 0 dan katta bo'lishi kerak!")
            return
        
        subscription_end = update_user_subscription(target_user_id, days)
        
        if subscription_end:
            sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
            
            # So'rovni approved qilish
            request = get_request_by_user_id(target_user_id)
            if request:
                update_request_status(request[0], "approved", f"Admin tomonidan {days} kun ruxsat berildi")
            
            # Foydalanuvchiga xabar yuborish
            try:
                await context.bot.send_message(
                    target_user_id,
                    f"🎉 **Tabriklaymiz!**\n\n"
                    f"Sizga {days} kunlik ruxsat berildi!\n"
                    f"⏰ Tugash sanasi: {sub_date.strftime('%Y-%m-%d %H:%M:%S')}\n\n"
                    f"🤖 Endi botdan to'liq foydalanishingiz mumkin!\n"
                    f"Yangilash uchun /start ni bosing."
                )
            except Exception as e:
                logger.error(f"Foydalanuvchiga xabar yuborishda xato: {e}")
            
            await update.message.reply_text(
                f"✅ **Ruxsat berildi!**\n\n"
                f"👤 Foydalanuvchi ID: {target_user_id}\n"
                f"📅 Kunlar: {days} kun\n"
                f"⏰ Tugash sanasi: {sub_date.strftime('%Y-%m-%d %H:%M:%S')}",
                reply_markup=get_admin_keyboard()
            )
        else:
            await update.message.reply_text("❌ Ruxsat berishda xatolik!", reply_markup=get_admin_keyboard())
            
    except Exception as e:
        await update.message.reply_text(f"❌ Xatolik: {str(e)}", reply_markup=get_admin_keyboard())

async def process_remove_command(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str = None):
    """/remove or 'remove 123'"""
    try:
        raw_text = text if text is not None else (update.message.text if update.message and update.message.text else "")
        target_user_id = parse_single_id(raw_text)
        if target_user_id is None:
            await update.message.reply_text("❌ Format: /remove ID\nMisol: /remove 123456789")
            return
        
        # Arxiv kanaldan ma'lumotlarni o'chirish
        deleted_count, failed_count = await delete_user_data_from_channel(target_user_id, context)
        
        # Bazadan ma'lumotlarni o'chirish
        delete_user_data(target_user_id)
        
        await update.message.reply_text(
            f"✅ **Foydalanuvchi o'chirildi!**\n\n"
            f"👤 Foydalanuvchi ID: {target_user_id}\n"
            f"🗑️ Arxivdan o'chirildi: {deleted_count} ta xabar\n"
            f"❌ Arxiv xatolari: {failed_count} ta\n\n"
            f"Barcha ma'lumotlar tozalandi.",
            reply_markup=get_admin_keyboard()
        )
        
    except Exception as e:
        await update.message.reply_text(f"❌ Xatolik: {str(e)}", reply_markup=get_admin_keyboard())

async def process_reject_command(update: Update, context: ContextTypes.DEFAULT_TYPE, text: str = None):
    """/reject or 'reject 1'"""
    try:
        raw_text = text if text is not None else (update.message.text if update.message and update.message.text else "")
        request_id = parse_single_id(raw_text)
        if request_id is None:
            await update.message.reply_text("❌ Format: /reject REQUEST_ID\nMisol: /reject 1")
            return
        
        # So'rovni olish
        request = get_request_by_id(request_id)
        if not request:
            await update.message.reply_text(f"❌ So'rov #{request_id} topilmadi!", reply_markup=get_admin_keyboard())
            return
        
        # So'rovni rejected qilish
        update_request_status(request_id, "rejected", "Admin tomonidan rad etildi")
        
        # Foydalanuvchiga xabar yuborish
        target_user_id = request[1]  # user_id
        first_name = request[3]
        last_name = request[4]
        
        try:
            await context.bot.send_message(
                target_user_id,
                f"❌ **Sizning so'rovingiz rad etildi!**\n\n"
                f"👤 Foydalanuvchi: {first_name} {last_name}\n"
                f"🆔 ID: {target_user_id}\n\n"
                f"Qayta urinish uchun @Okean_manager ga murojaat qiling."
            )
        except Exception as e:
            logger.error(f"Foydalanuvchiga xabar yuborishda xato: {e}")
        
        await update.message.reply_text(
            f"✅ **So'rov rad etildi!**\n\n"
            f"📝 So'rov ID: #{request_id}\n"
            f"👤 Foydalanuvchi: {first_name} {last_name}\n"
            f"🆔 ID: {target_user_id}\n\n"
            f"Foydalanuvchi xabarlangan.",
            reply_markup=get_admin_keyboard()
        )
        
    except Exception as e:
        await update.message.reply_text(f"❌ Xatolik: {str(e)}", reply_markup=get_admin_keyboard())

async def code_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Kodni kiritish uchun command"""
    user_id = update.effective_user.id
    
    if user_id != ADMIN_ID:
        await update.message.reply_text("❌ Bu buyruq faqat admin uchun!")
        return
    
    if not context.args or len(context.args) != 2:
        await update.message.reply_text("❌ Format: /code DISPLAY_NAME KOD\nMisol: /code account_123456789_1 12345")
        return
    
    display_name = context.args[0]
    code = context.args[1]
    
    await update.message.reply_text(f"⏳ Kod kiritilmoqda: {display_name}...")
    
    success, message = await enter_code(display_name, code)
    
    log_session_action(display_name, "enter_code", "success" if success else "failed", message)
    
    await update.message.reply_text(f"📝 **KOD NATIJASI**\n\n{message}")
    
    if success:
        # Foydalanuvchiga xabar yuborish
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT user_id FROM accounts WHERE display_name = ?', (display_name,))
        result = cursor.fetchone()
        conn.close()
        
        if result:
            target_user_id = result[0]
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            try:
                await context.bot.send_message(
                    target_user_id,
                    f"🎉 **HISOBINGIZ FAOL QILINDI!**\n\n"
                    f"📱 Hisob: {simple_name}\n"
                    f"✅ Status: Faol\n\n"
                    f"Endi guruh qo'shishingiz va xabar yuborishingiz mumkin!"
                )
            except Exception as e:
                logger.error(f"Foydalanuvchiga xabar yuborishda xato: {e}")

async def password_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """2FA parolini kiritish"""
    user_id = update.effective_user.id
    
    if user_id != ADMIN_ID:
        await update.message.reply_text("❌ Bu buyruq faqat admin uchun!")
        return
    
    if not context.args or len(context.args) != 2:
        await update.message.reply_text("❌ Format: /password DISPLAY_NAME PAROL\nMisol: /password account_123456789_1 mypassword")
        return
    
    display_name = context.args[0]
    password = context.args[1]
    
    await update.message.reply_text(f"⏳ Parol kiritilmoqda: {display_name}...")
    
    success, message = await enter_password(display_name, password)
    
    log_session_action(display_name, "enter_password", "success" if success else "failed", message)
    
    await update.message.reply_text(f"📝 **PAROL NATIJASI**\n\n{message}")
    
    if success:
        # Foydalanuvchiga xabar yuborish
        conn = sqlite3.connect(DB_FILE)
        cursor = conn.cursor()
        cursor.execute('SELECT user_id FROM accounts WHERE display_name = ?', (display_name,))
        result = cursor.fetchone()
        conn.close()
        
        if result:
            target_user_id = result[0]
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            try:
                await context.bot.send_message(
                    target_user_id,
                    f"🔐 **2FA PAROL TASDIQLANDI!**\n\n"
                    f"📱 Hisob: {simple_name}\n"
                    f"✅ Status: To'liq faol\n\n"
                    f"Hisobingiz endi to'liq faol holatda!"
                )
            except Exception as e:
                logger.error(f"Foydalanuvchiga xabar yuborishda xato: {e}")

async def test_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Sessionni test qilish"""
    user_id = update.effective_user.id
    
    if user_id != ADMIN_ID:
        await update.message.reply_text("❌ Bu buyruq faqat admin uchun!")
        return
    
    if not context.args or len(context.args) != 1:
        await update.message.reply_text("❌ Format: /test DISPLAY_NAME\nMisol: /test account_123456789_1")
        return
    
    display_name = context.args[0]
    
    await update.message.reply_text(f"⏳ Session test qilinmoqda: {display_name}...")
    
    success, message = await test_session(display_name)
    
    log_session_action(display_name, "test_session", "success" if success else "failed", message)
    
    await update.message.reply_text(f"📝 **TEST NATIJASI**\n\n{message}")

async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    
    user_id = query.from_user.id
    data = query.data
    
    if data == "manage_groups":
        accounts = get_user_accounts(user_id)
        if not accounts:
            await query.edit_message_text("❌ Hech qanday hisob yo'q!")
            return
        
        keyboard = []
        total_active = 0
        total_inactive = 0
        
        for acc in accounts:
            display_name = acc[0]
            is_account_active = acc[4]  # is_active field
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            groups = get_user_groups(user_id, display_name)
            
            if groups:
                active_groups = sum(1 for g in groups if g[4] == 1)
                inactive_groups = len(groups) - active_groups
                total_active += active_groups
                total_inactive += inactive_groups
                
                account_status = "✅" if is_account_active == 1 else "❌"
                keyboard.append([InlineKeyboardButton(
                    f"{account_status} {simple_name} ({active_groups} faol / {len(groups)} jami)", 
                    callback_data=f"account_{display_name}"
                )])
        
        if keyboard:
            keyboard.append([InlineKeyboardButton("🔙 Orqaga", callback_data="back_to_main")])
            reply_markup = InlineKeyboardMarkup(keyboard)
            
            await query.edit_message_text(
                f"⚙️ **GURUHLARNI BOSHQARISH**\n\n"
                f"📊 Umumiy: {total_active} faol / {total_active + total_inactive} jami\n\n"
                f"Hisobni tanlang:",
                reply_markup=reply_markup
            )
        else:
            await query.edit_message_text("❌ Hech qanday guruh yo'q!")
    
    elif data.startswith("account_"):
        display_name = data.replace("account_", "")
        groups = get_user_groups(user_id, display_name)
        
        if not groups:
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            await query.edit_message_text(f"❌ {simple_name} hisobida guruh yo'q!")
            return
        
        # Statistika
        active_groups = sum(1 for g in groups if g[4] == 1)
        inactive_groups = len(groups) - active_groups
        
        keyboard = []
        for group in groups:
            group_db_id, group_id, group_title, group_username, is_active = group[0], group[1], group[2], group[3], group[4]
            status = "✅" if is_active == 1 else "❌"
            
            if group_username:
                text = f"{status} {group_title} (@{group_username})"
            else:
                text = f"{status} {group_title}"
            
            # Uzun nomlarni qisqartirish
            if len(text) > 40:
                text = text[:37] + "..."
            
            keyboard.append([InlineKeyboardButton(text, callback_data=f"group_{group_db_id}")])
        
        simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
        keyboard.append([
            InlineKeyboardButton("✅ Hammasini yoqish", callback_data=f"enable_all_{display_name}"),
            InlineKeyboardButton("❌ Hammasini o'chirish", callback_data=f"disable_all_{display_name}")
        ])
        keyboard.append([InlineKeyboardButton("🔙 Orqaga", callback_data="manage_groups")])
        
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            f"⚙️ **{simple_name} - GURUHLAR**\n\n"
            f"📊 Statistika: {active_groups} faol / {inactive_groups} nofaol / {len(groups)} jami\n\n"
            f"✅ - faol (xabar yuboriladi)\n"
            f"❌ - nofaol (xabar yuborilmaydi)\n\n"
            f"Guruhni tanlang yoki barchasini o'zgartiring:",
            reply_markup=reply_markup
        )
    
    elif data.startswith("group_") and not data.startswith("group_activate_") and not data.startswith("group_deactivate_") and not data.startswith("group_delete_"):
        group_id = int(data.replace("group_", ""))
        
        # Guruh ma'lumotlarini olish
        group = get_group_by_id(group_id)
        if not group:
            await query.edit_message_text("❌ Guruh topilmadi!")
            return
        
        # group = (id, user_id, account_display_name, group_id, group_title, group_username, is_active)
        _, _, account_name, tg_group_id, group_title, group_username, is_active = group
        
        status = "✅ Faol" if is_active == 1 else "❌ Nofaol"
        username_text = f"\n🔗 Username: @{group_username}" if group_username else ""
        
        keyboard = [
            [InlineKeyboardButton("✅ Foal qilish", callback_data=f"group_activate_{group_id}")],
            [InlineKeyboardButton("❌ Nofoal qilish", callback_data=f"group_deactivate_{group_id}")],
            [InlineKeyboardButton("🗑️ O'chirish", callback_data=f"group_delete_{group_id}")],
            [InlineKeyboardButton("🔙 Bekor qilish", callback_data=f"account_{account_name}")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            f"📢 **GURUH MA'LUMOTLARI**\n\n"
            f"📱 Hisob: {account_name.split('_')[-1] if '_' in account_name else account_name}\n"
            f"📢 Guruh: {group_title}{username_text}\n"
            f"🆔 ID: {tg_group_id}\n"
            f"🔧 Status: {status}\n\n"
            f"Amal tanlang:",
            reply_markup=reply_markup
        )
    
    elif data.startswith("group_activate_"):
        group_id = int(data.replace("group_activate_", ""))
        group = get_group_by_id(group_id)
        
        if not group:
            await query.edit_message_text("❌ Guruh topilmadi!")
            return
        
        account_name = group[2]
        group_title = group[4]
        simple_name = account_name.split('_')[-1] if '_' in account_name else account_name
        
        update_group_active_status([group_id], 1)
        
        await query.edit_message_text(
            f"✅ **GURUH FAOLLASHTIRILDI!**\n\n"
            f"📱 Hisob: {simple_name}\n"
            f"📢 Guruh: {group_title}\n"
            f"🔧 Status: ✅ Faol"
        )
        
        await asyncio.sleep(1.5)
        # Hisobga qaytish
        query.data = f"account_{account_name}"
        await button_callback(update, context)
    
    elif data.startswith("group_deactivate_"):
        group_id = int(data.replace("group_deactivate_", ""))
        group = get_group_by_id(group_id)
        
        if not group:
            await query.edit_message_text("❌ Guruh topilmadi!")
            return
        
        account_name = group[2]
        group_title = group[4]
        simple_name = account_name.split('_')[-1] if '_' in account_name else account_name
        
        update_group_active_status([group_id], 0)
        
        await query.edit_message_text(
            f"❌ **GURUH NOFAOLLASHTIRILDI!**\n\n"
            f"📱 Hisob: {simple_name}\n"
            f"📢 Guruh: {group_title}\n"
            f"🔧 Status: ❌ Nofaol"
        )
        
        await asyncio.sleep(1.5)
        # Hisobga qaytish
        query.data = f"account_{account_name}"
        await button_callback(update, context)
    
    elif data.startswith("group_delete_"):
        group_id = int(data.replace("group_delete_", ""))
        group = get_group_by_id(group_id)
        
        if not group:
            await query.edit_message_text("❌ Guruh topilmadi!")
            return
        
        account_name = group[2]
        group_title = group[4]
        simple_name = account_name.split('_')[-1] if '_' in account_name else account_name
        
        # Tasdiqlash tugmalari
        keyboard = [
            [InlineKeyboardButton("✅ Ha, o'chirish", callback_data=f"group_confirm_delete_{group_id}")],
            [InlineKeyboardButton("❌ Yo'q, bekor qilish", callback_data=f"account_{account_name}")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            f"⚠️ **TASDIQLASH**\n\n"
            f"📢 **{group_title}** guruhini o'chirmoqchimisiz?\n\n"
            f"📱 Hisob: {simple_name}\n\n"
            f"Bu amalni bekor qilib bo'lmaydi!",
            reply_markup=reply_markup
        )
    
    elif data.startswith("group_confirm_delete_"):
        group_id = int(data.replace("group_confirm_delete_", ""))
        group = get_group_by_id(group_id)
        
        if not group:
            await query.edit_message_text("❌ Guruh topilmadi!")
            return
        
        account_name = group[2]
        group_title = group[4]
        simple_name = account_name.split('_')[-1] if '_' in account_name else account_name
        
        # Guruhni o'chirish
        success = delete_group_by_id(group_id)
        
        if success:
            await query.edit_message_text(
                f"✅ **GURUH O'CHIRILDI!**\n\n"
                f"📢 {group_title} muvaffaqiyatli o'chirildi."
            )
        else:
            await query.edit_message_text(
                f"❌ **XATOLIK!**\n\n"
                f"Guruhni o'chirishda xatolik yuz berdi."
            )
        
        await asyncio.sleep(1.5)
        # Hisobga qaytish
        query.data = f"account_{account_name}"
        await button_callback(update, context)
    
    elif data.startswith("enable_all_"):
        display_name = data.replace("enable_all_", "")
        simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
        
        groups = get_user_groups(user_id, display_name)
        group_ids = [g[0] for g in groups]
        
        if group_ids:
            update_group_active_status(group_ids, 1)
        
        await query.edit_message_text(f"✅ **{simple_name}**\n\nBarcha guruhlar faollashtirildi!\nJami: {len(group_ids)} ta guruh")
    
    elif data.startswith("disable_all_"):
        display_name = data.replace("disable_all_", "")
        simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
        
        groups = get_user_groups(user_id, display_name)
        group_ids = [g[0] for g in groups]
        
        if group_ids:
            update_group_active_status(group_ids, 0)
        
        await query.edit_message_text(f"✅ **{simple_name}**\n\nBarcha guruhlar o'chirildi!\nJami: {len(group_ids)} ta guruh")
    
    elif data == "finish_groups":
        await query.edit_message_text("✅ **Guruhlar muvaffaqiyatli qo'shildi!**\n\nEndi asosiy menyudan boshqa funksiyalardan foydalanishingiz mumkin.")
        context.user_data.clear()
    
    elif data == "back_to_main":
        if user_id == ADMIN_ID:
            await context.bot.send_message(chat_id=user_id, text="👑 **Admin Paneli**", reply_markup=get_admin_keyboard())
        else:
            await context.bot.send_message(chat_id=user_id, text="🤖 **Asosiy menyu**", reply_markup=get_user_keyboard())
        await query.delete_message()
    
    elif data == "cancel_add_account":
        # Hisob qo'shishni bekor qilish
        context.user_data.clear()
        await query.edit_message_text("❌ **Bekor qilindi!**\n\nHisob qo'shish bekor qilindi.")
        if user_id == ADMIN_ID:
            await context.bot.send_message(chat_id=user_id, text="👑 **Admin Paneli**", reply_markup=get_admin_keyboard())
        else:
            await context.bot.send_message(chat_id=user_id, text="🤖 **Asosiy menyu**", reply_markup=get_user_keyboard())
    
    elif data == "view_accounts":
        # Hisoblarni ko'rish
        accounts = get_user_accounts(user_id)
        if not accounts:
            await query.edit_message_text("📭 Hech qanday hisob yo'q!")
            return
        
        msg = "📋 **HISOBLAR RO'YXATI**\n\n"
        
        for i, acc in enumerate(accounts, 1):
            display_name, phone, country_code, username, is_active, is_premium, subscription_end = acc
            
            status = "✅ Faol" if is_active == 1 else "❌ Nofaol"
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            
            msg += f"{i}. **{simple_name}**\n"
            msg += f"   📞: +{phone}\n"
            msg += f"   👤: @{username or 'Yoq'}\n"
            msg += f"   📊: {status}\n\n"
        
        keyboard = [[InlineKeyboardButton("🔙 Orqaga", callback_data="back_to_accounts_menu")]]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        try:
            await query.edit_message_text(msg, reply_markup=reply_markup, parse_mode='Markdown')
        except:
            await query.edit_message_text(msg, reply_markup=reply_markup)
    
    elif data == "back_to_accounts_menu":
        # Hisoblar menyusiga qaytish
        accounts = get_user_accounts(user_id)
        
        keyboard = [
            [InlineKeyboardButton("👁 Hisoblarni ko'rish", callback_data="view_accounts")],
            [InlineKeyboardButton("🗑️ Hisobni o'chirish", callback_data="delete_account_menu")],
            [InlineKeyboardButton("🔙 Orqaga", callback_data="back_to_main")],
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            f"📋 **HISOBLAR**\n\n"
            f"📊 Sizda {len(accounts)} ta hisob mavjud.\n\n"
            f"Kerakli amalni tanlang:",
            reply_markup=reply_markup
        )
    
    elif data == "delete_account_menu":
        # O'chirish uchun hisoblar ro'yxati
        accounts = get_user_accounts(user_id)
        if not accounts:
            await query.edit_message_text("📭 Hech qanday hisob yo'q!")
            return
        
        keyboard = []
        for acc in accounts:
            display_name, phone, _, _, is_active, _, _ = acc
            status = "✅" if is_active == 1 else "❌"
            simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
            keyboard.append([InlineKeyboardButton(f"{status} {simple_name} (+{phone})", callback_data=f"confirm_delete_{display_name}")])
        
        keyboard.append([InlineKeyboardButton("🔙 Orqaga", callback_data="back_to_accounts_menu")])
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            "🗑️ **HISOBNI O'CHIRISH**\n\n"
            "⚠️ O'chirmoqchi bo'lgan hisobni tanlang:\n"
            "(Session fayli va barcha guruhlar ham o'chiriladi)",
            reply_markup=reply_markup
        )
    
    elif data.startswith("confirm_delete_"):
        # O'chirishni tasdiqlash
        display_name = data.replace("confirm_delete_", "")
        simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
        
        keyboard = [
            [InlineKeyboardButton("✅ Ha, o'chirish", callback_data=f"do_delete_{display_name}")],
            [InlineKeyboardButton("❌ Yo'q, bekor qilish", callback_data="delete_account_menu")]
        ]
        reply_markup = InlineKeyboardMarkup(keyboard)
        
        await query.edit_message_text(
            f"⚠️ **TASDIQLASH**\n\n"
            f"📱 **{simple_name}** hisobini o'chirmoqchimisiz?\n\n"
            f"Bu amalni bekor qilib bo'lmaydi!\n"
            f"Session fayli va barcha guruhlar ham o'chiriladi.",
            reply_markup=reply_markup
        )
    
    elif data.startswith("do_delete_"):
        # Hisobni o'chirish
        display_name = data.replace("do_delete_", "")
        simple_name = display_name.split('_')[-1] if '_' in display_name else display_name
        
        success = delete_user_account(user_id, display_name)
        
        if success:
            await query.edit_message_text(
                f"✅ **HISOB O'CHIRILDI!**\n\n"
                f"📱 **{simple_name}** muvaffaqiyatli o'chirildi.\n"
                f"Session fayli va barcha guruhlar tozalandi."
            )
        else:
            await query.edit_message_text(
                f"❌ **XATOLIK!**\n\n"
                f"📱 **{simple_name}** hisobini o'chirishda xatolik yuz berdi."
            )
        
        await context.bot.send_message(chat_id=user_id, text="🤖 **Asosiy menyu**", reply_markup=get_user_keyboard())
    
    elif data == "confirm_clear_messages":
        # Xabarlarni tozalash (faqat bazadan)
        deleted_count = delete_user_messages(user_id)
        
        await query.edit_message_text(
            f"✅ **XABARLAR TOZALANDI!**\n\n"
            f"🗑️ {deleted_count} ta xabar bazadan o'chirildi.\n"
            f"📦 Arxiv kanaldagi media fayllar saqlanib qoladi."
        )
        
        await context.bot.send_message(chat_id=user_id, text="🤖 **Asosiy menyu**", reply_markup=get_user_keyboard())

async def cancel_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    if user_id == ADMIN_ID:
        await update.message.reply_text("❌ Bekor qilindi!", reply_markup=get_admin_keyboard())
    else:
        await update.message.reply_text("❌ Bekor qilindi!", reply_markup=get_user_keyboard())
    context.user_data.clear()

# ========== YANGILANGAN AUTO SEND LOOP ==========

async def auto_send_loop():
    """Avtomatik xabar yuborish loopi"""
    global is_sending, last_send_time
    
    print("🔄 Avtomatik yuborish loopi ishga tushdi...")
    
    # Session papkasini yaratish
    init_sessions_dir()
    
    while True:
        try:
            if is_sending:
                users = get_all_users()
                total_sent = 0
                total_failed = 0
                
                for user_id in users:
                    subscription_end, is_premium = get_user_subscription(user_id)
                    
                    if not subscription_end:
                        continue
                    
                    try:
                        sub_date = datetime.strptime(subscription_end, '%Y-%m-%d %H:%M:%S')
                        if datetime.now() > sub_date:
                            continue
                    except:
                        continue
                    
                    accounts = get_user_accounts(user_id)
                    
                    # Foydalanuvchi intervalini olish
                    user_min_interval, user_max_interval = get_user_interval(user_id)
                    
                    for acc in accounts:
                        display_name, phone, _, _, is_active, _, _ = acc
                        
                        if is_active != 1:
                            continue
                        
                        groups = get_user_groups(user_id, display_name)
                        active_groups = [g for g in groups if g[4] == 1]
                        
                        if not active_groups:
                            continue
                        
                        messages = get_user_messages(user_id)
                        
                        if not messages:
                            continue
                        
                        # Random xabar olish (dict formatda)
                        msg_data = get_random_user_message(user_id)
                        
                        if not msg_data:
                            continue
                        
                        # Har bir guruhga xabar yuborish
                        for group in active_groups:
                            group_id = group[1]
                            
                            # Haqiqiy xabar yuborish (arxiv kanal orqali)
                            success, result = await send_message_to_group(display_name, group_id, msg_data)
                            
                            # Log uchun xabar matni
                            log_text = msg_data.get('text', '') or f"[{msg_data.get('message_type', 'unknown')}]"
                            if len(log_text) > 50:
                                log_text = log_text[:50] + "..."
                            
                            if success:
                                total_sent += 1
                                logger.info(f"✅ {display_name} -> {group[2]}: {log_text}")
                            else:
                                total_failed += 1
                                logger.error(f"❌ {display_name} -> {group[2]}: {result}")
                            
                            # Har bir xabar o'rtasida 3-8 soniya kutish
                            await asyncio.sleep(random.uniform(3, 8))
                    
                    # Har bir foydalanuvchi uchun o'z intervalida kutish
                    if total_sent > 0:
                        user_delay = random.randint(user_min_interval * 60, user_max_interval * 60)
                        logger.info(f"⏰ {user_id} uchun keyingi yuborishga {user_delay//60} daqiqa qoldi...")
                        await asyncio.sleep(user_delay)
                
                if total_sent > 0 or total_failed > 0:
                    last_send_time = datetime.now().strftime("%H:%M:%S")
                    logger.info(f"📊 NATIJA: {total_sent} ta xabar yuborildi, {total_failed} ta xatolik")
                else:
                    logger.info("ℹ️ Hech qanday xabar yuborilmadi (aktiv guruhlar yo'q)")
                    
                # Umumiy kutish
                await asyncio.sleep(60)
            
            else:
                await asyncio.sleep(30)
                
        except Exception as e:
            logger.error(f"Auto send loop xatosi: {e}")
            await asyncio.sleep(30)

def start_auto_send():
    """Auto send loopni alohida threadda ishga tushirish"""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    loop.run_until_complete(auto_send_loop())

# ========== MAIN FUNCTION ==========

def main():
    print("\n" + "="*60)
    print("🤖 TELEGRAM BOT ADMIN PANELI")
    print("="*60)
    
    # Baza va sessions papkasini yaratish
    init_database()
    init_sessions_dir()
    
    print(f"\n✅ Baza fayli: {DB_FILE}")
    print(f"✅ Sessions papkasi: {SESSIONS_DIR}")
    print(f"📦 Arxiv kanal: {STORAGE_CHANNEL_USERNAME}")
    print(f"👑 Admin ID: {ADMIN_ID}")
    print(f"📡 API ID: {API_ID}")
    print("="*60)
    
    try:
        # Auto send loopni alohida threadda ishga tushirish
        auto_send_thread = threading.Thread(target=start_auto_send, daemon=True)
        auto_send_thread.start()
        
        # Botni ishga tushirish
        application = Application.builder().token(BOT_TOKEN).build()
        
        # Handlerlarni qo'shish
        application.add_handler(CommandHandler("start", start))
        application.add_handler(CommandHandler("cancel", cancel_command))
        application.add_handler(CommandHandler("code", code_command))
        application.add_handler(CommandHandler("password", password_command))
        application.add_handler(CommandHandler("test", test_command))
        
        # Asosiy komanda handlerlari
        application.add_handler(CommandHandler("add", process_add_command))
        application.add_handler(CommandHandler("reject", process_reject_command))
        application.add_handler(CommandHandler("remove", process_remove_command))
        
        # Message handler - text
        application.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
        
        # Media handlers - barcha turdagi xabarlar uchun
        application.add_handler(MessageHandler(filters.PHOTO, handle_media_message))
        application.add_handler(MessageHandler(filters.VIDEO, handle_media_message))
        application.add_handler(MessageHandler(filters.Document.ALL, handle_media_message))
        application.add_handler(MessageHandler(filters.AUDIO, handle_media_message))
        application.add_handler(MessageHandler(filters.VOICE, handle_media_message))
        application.add_handler(MessageHandler(filters.Sticker.ALL, handle_media_message))
        application.add_handler(MessageHandler(filters.ANIMATION, handle_media_message))
        application.add_handler(MessageHandler(filters.VIDEO_NOTE, handle_media_message))
        
        application.add_handler(CallbackQueryHandler(button_callback))
        
        print("\n🚀 Bot ishga tushmoqda...")
        print("👑 Admin: /start ni bosing")
        print("\n🎯 YANGI KOMMANDALAR:")
        print("  /code DISPLAY_NAME KOD - SMS kodini kiritish")
        print("  /password DISPLAY_NAME PAROL - 2FA parolini kiritish")
        print("  /test DISPLAY_NAME - Sessionni test qilish")
        print("\n📝 Asosiy komandalar:")
        print("  /add ID KUNLAR - Ruxsat berish")
        print("  /reject ID - So'rovni rad etish")
        print("  /remove ID - Foydalanuvchini o'chirish")
        print("\n📦 ARXIV TIZIMI:")
        print(f"  • Media fayllar: {STORAGE_CHANNEL_USERNAME} kanalida saqlanadi")
        print("  • CHAT_ID:MESSAGE_ID formatida bazaga yoziladi")
        print("  • Server xotirasi tejiladi")
        print("  • Obuna tugaganda arxiv kanaldan o'chiriladi")
        print("="*60)
        
        # Polling
        application.run_polling(allowed_updates=Update.ALL_TYPES)
        
    except Exception as e:
        print(f"\n❌ Xatolik: {e}")
        logger.error(f"Main xatosi: {e}")

if __name__ == "__main__":
    main()
