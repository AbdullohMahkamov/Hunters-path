// /api/support-bot.js — Telegram-бот ДЛЯ УЧЕНИКОВ (панель саппорта). ОТДЕЛЬНЫЙ бот, свой токен.
// НЕ переиспользует ботов владельца/РОПа/маркетинга. Логика: персональная ссылка → выдать документы → подтверждение.
// Тексты для ученика — узбекские (как в ТЗ). Internal-логика/ключи — в support.js (префикс support:*).
//
// Actions:
//   POST (webhook от Telegram)      — приём /start <токен> и нажатия кнопки подтверждения
//   GET  ?action=setup&session=...  (admin) — прописать webhook боту
//   GET  ?action=status&session=... (admin) — статус вебхука + username
import { findByToken, markOpened, confirmSend, tgSend, tgSendDocumentById, getBotUsername } from "./support.js";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BOT_TOKEN = () => process.env.TELEGRAM_SUPPORT_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

// узбекские тексты (латиница, C1)
const T = {
  intro: "Assalomu alaykum! 👋\nQuyidagi hujjatlar bilan tanishib chiqing va tasdiqlang:",
  confirmBtn: "✅ Tasdiqlayman",
  done: "Rahmat, qabul qilindi ✅",
  already: "Siz allaqachon tasdiqlagansiz. Rahmat! ✅",
  notFound: "Kechirasiz, havola noto'g'ri yoki muddati o'tgan. Iltimos, operatorga murojaat qiling.",
};

async function getSession(session) {
  if (!session) return null;
  try { const r = await fetch(`${REDIS_URL}/get/session:${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result ? JSON.parse(d.result) : null; } catch (e) { return null; }
}
async function answerCallback(cbId, text) {
  const token = BOT_TOKEN(); if (!token || !cbId) return;
  try { await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: cbId, text: String(text || "").slice(0, 200) }) }); } catch (e) {}
}
async function clearMarkup(chatId, messageId) {
  const token = BOT_TOKEN(); if (!token || !chatId || !messageId) return;
  try { await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }) }); } catch (e) {}
}

// доставка ученику: текст оператора → документы → приглашение подтвердить с кнопкой
async function deliverToStudent(rec, chatId) {
  if (rec.message) await tgSend(chatId, rec.message);
  else await tgSend(chatId, T.intro);
  for (const d of (rec.docs || [])) await tgSendDocumentById(chatId, d.fileId, d.name);
  await tgSend(chatId, "👇", { reply_markup: { inline_keyboard: [[{ text: T.confirmBtn, callback_data: `sup:ok:${rec.token}` }]] } });
}

export default async function handler(req, res) {
  const q = req.query || {};
  const action = q.action || "";

  // ── admin: прописать/проверить webhook ──
  if (req.method === "GET" && (action === "setup" || action === "status")) {
    const sess = await getSession(q.session || "");
    if (!sess || sess.role !== "admin") { res.status(200).json({ ok: false, error: "только админ" }); return; }
    const token = BOT_TOKEN();
    if (!token) { res.status(200).json({ ok: false, error: "нет TELEGRAM_SUPPORT_BOT_TOKEN" }); return; }
    if (action === "status") {
      try {
        const info = await (await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`)).json();
        res.status(200).json({ ok: true, username: await getBotUsername(), webhook: info && info.result });
      } catch (e) { res.status(200).json({ ok: false, error: String(e).slice(0, 120) }); }
      return;
    }
    const host = req.headers && req.headers.host;
    const url = `https://${host}/api/support-bot`;
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ url, secret_token: WEBHOOK_SECRET || undefined, allowed_updates: ["message", "callback_query"] }),
      });
      const d = await r.json();
      res.status(200).json({ ok: !!(d && d.ok), url, username: await getBotUsername(), detail: d && d.description });
    } catch (e) { res.status(200).json({ ok: false, error: String(e).slice(0, 120) }); }
    return;
  }

  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  // проверка секрета вебхука (если задан)
  if (WEBHOOK_SECRET) {
    const got = req.headers && (req.headers["x-telegram-bot-api-secret-token"] || req.headers["X-Telegram-Bot-Api-Secret-Token"]);
    if (got !== WEBHOOK_SECRET) { res.status(200).json({ ok: true, ignored: "bad secret" }); return; }
  }

  try {
    const upd = req.body || {};

    // нажатие кнопки подтверждения
    if (upd.callback_query) {
      const cq = upd.callback_query;
      const data = String(cq.data || "");
      const m = data.match(/^sup:ok:(.+)$/);
      const chatId = cq.message && cq.message.chat && cq.message.chat.id;
      if (!m) { await answerCallback(cq.id, ""); res.status(200).json({ ok: true, ignored: "no match" }); return; }
      const tgUser = { id: cq.from && cq.from.id, username: cq.from && cq.from.username };
      const r = await confirmSend(m[1], tgUser);
      if (!r.ok) { await answerCallback(cq.id, ""); if (chatId) await tgSend(chatId, T.notFound); res.status(200).json({ ok: true }); return; }
      await answerCallback(cq.id, r.already ? "✅" : T.done);
      if (cq.message) await clearMarkup(chatId, cq.message.message_id);
      if (chatId) await tgSend(chatId, r.already ? T.already : T.done);
      res.status(200).json({ ok: true, confirmed: !r.already });
      return;
    }

    // сообщение — ждём /start <токен>
    if (upd.message) {
      const msg = upd.message;
      const chatId = msg.chat && msg.chat.id;
      const text = String(msg.text || "").trim();
      const mStart = text.match(/^\/start\s+(\S+)/);
      if (mStart) {
        const rec = await markOpened(mStart[1]);
        if (!rec) { if (chatId) await tgSend(chatId, T.notFound); res.status(200).json({ ok: true, notFound: true }); return; }
        await deliverToStudent(rec, chatId);
        res.status(200).json({ ok: true, delivered: rec.id });
        return;
      }
      // просто /start без токена или иной текст
      if (chatId) await tgSend(chatId, T.notFound);
      res.status(200).json({ ok: true, ignored: "no token" });
      return;
    }

    res.status(200).json({ ok: true, ignored: "no message/callback" });
  } catch (err) {
    res.status(200).json({ ok: true, error: String(err).slice(0, 200) }); // 200, чтобы Telegram не заспамил ретраями
  }
}
