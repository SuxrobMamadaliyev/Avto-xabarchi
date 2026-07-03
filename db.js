// db.js — MongoDB (mongoose) asosidagi ma'lumotlar bazasi moduli
// Butun bot holati bitta "singleton" hujjatda saqlanadi (groups, matn, interval va h.k.)

const mongoose = require('mongoose');

const SINGLETON_ID = 'bot_state';

const BotStateSchema = new mongoose.Schema(
  {
    _id: { type: String, default: SINGLETON_ID },
    groups: {
      type: Map,
      of: new mongoose.Schema(
        { title: String, addedAt: Number },
        { _id: false }
      ),
      default: {},
    },
    broadcastText: {
      type: String,
      default: "Bu — avtomatik xabar matni. Uni 'Habar matni' tugmasi orqali o'zgartiring.",
    },
    intervalSeconds: { type: Number, default: 120 },
    autoHabarOn: { type: Boolean, default: false },
    admins: { type: [Number], default: [] },
    forceSubChannels: {
      type: [
        {
          chatId: Number,
          username: String,
          title: String,
          inviteLink: String,
          _id: false,
        },
      ],
      default: [],
    },
  },
  { minimize: false }
);

const BotState = mongoose.model('BotState', BotStateSchema);

// ---------- Ulanish ----------
async function connect(uri) {
  if (!uri) {
    throw new Error('MONGODB_URI berilmagan. .env faylida MONGODB_URI ni kiriting.');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log('✅ MongoDB ga ulandi.');
}

// ---------- Mongoose Map -> oddiy JS object ----------
function mapToObject(map) {
  if (!map) return {};
  if (map instanceof Map) return Object.fromEntries(map);
  return map; // allaqachon plain object bo'lishi mumkin (lean holatda)
}

// ---------- Xotiradagi ishchi nusxani (plain object) yuklash ----------
async function load() {
  let doc = await BotState.findById(SINGLETON_ID);
  if (!doc) {
    doc = await BotState.create({ _id: SINGLETON_ID });
  }
  const obj = doc.toObject();
  obj.groups = mapToObject(obj.groups);
  return obj;
}

// ---------- Xotiradagi holatni to'liq Mongo hujjatiga yozish ----------
let saveQueue = Promise.resolve();

function save(data) {
  // Ketma-ket yozishlarni saflashtiramiz — bir vaqtda bir nechta save() chaqirilsa ham
  // ma'lumotlar bir-birini "yorib o'tmasligi" uchun.
  saveQueue = saveQueue
    .then(() =>
      BotState.findByIdAndUpdate(
        SINGLETON_ID,
        {
          groups: data.groups,
          broadcastText: data.broadcastText,
          intervalSeconds: data.intervalSeconds,
          autoHabarOn: data.autoHabarOn,
          admins: data.admins,
          forceSubChannels: data.forceSubChannels,
        },
        { upsert: true }
      )
    )
    .catch((err) => console.error('❌ MongoDB save xatosi:', err.message));
  return saveQueue;
}

module.exports = { connect, load, save };
