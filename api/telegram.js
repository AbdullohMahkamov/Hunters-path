// /api/telegram.js — приём сообщений из Telegram Business (личный бизнес-аккаунт через подключённого бота).
// Бот подключается в: Telegram → Настройки → Telegram для бизнеса → Чат-боты.
// Этот endpoint = webhook: Telegram шлёт сюда каждое сообщение бизнес-чата.
// Храним сырьё в Upstash, агрегаты считаются отдельно (экономия токенов — как с amoCRM).
//
// ENV: TELEGRAM_BOT_TOKEN (токен от @BotFather), TELEGRAM_WEBHOOK_SECRET (свой секрет для защиты),
//      UPSTASH_REDIS_REST_URL / TELEGRAM_REDIS... (используем общий Upstash).

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmd) {
  // cmd — массив, например ["SET","key","val"]
  const r = await fetch(`${REDIS_URL}/${cmd.map(encodeURIComponent).join("/")}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  return r.json();
}
// для больших значений — POST body
async function redisSet(key, value) {
  const r = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: value,
  });
  return r.json();
}
async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const d = await r.json();
  return d && d.result ? d.result : null;
}

export default async function handler(req, res) {
  // Telegram шлёт POST. Проверяем секрет (защита webhook).
  if (req.method !== "POST") { res.status(200).json({ ok: true, note: "telegram webhook alive" }); return; }
  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    res.status(401).json({ error: "bad secret" }); return;
  }
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }

  try {
    const update = req.body || {};

    // 1) Подключение бота к бизнес-аккаунту
    if (update.business_connection) {
      const bc = update.business_connection;
      await redisSet(`tg:connection`, JSON.stringify({
        connection_id: bc.id, user_id: bc.user && bc.user.id,
        can_reply: bc.rights && bc.rights.can_reply, enabled: bc.is_enabled, date: bc.date,
      }));
      res.status(200).json({ ok: true, connected: true }); return;
    }

    // 2) Новое сообщение в бизнес-чате (от клиента ИЛИ от владельца)
    const msg = update.business_message || update.edited_business_message;
    if (msg) {
      const connId = msg.business_connection_id || "";
      const chatId = msg.chat && msg.chat.id;
      const fromId = msg.from && msg.from.id;
      const text = msg.text || msg.caption || "";
      const ts = msg.date || Math.floor(Date.now() / 1000);
      // определяем: это клиент написал или владелец (ответ)
      // владелец = тот, чей аккаунт подключён (business owner)
      const conn = JSON.parse((await redisGet("tg:connection")) || "{}");
      const ownerId = conn.user_id;
      const isOwner = fromId === ownerId; // true = менеджер/владелец ответил

      // сохраняем сообщение в список чата (ключ по chatId)
      const key = `tgchat:${chatId}`;
      const existing = JSON.parse((await redisGet(key)) || "[]");
      existing.push({
        id: msg.message_id, ts, fromId, isOwner,
        name: msg.from ? [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" ") : "",
        username: msg.from && msg.from.username || "",
        text: text.slice(0, 2000), // ограничиваем длину
      });
      // держим последние 200 сообщений на чат
      const trimmed = existing.slice(-200);
      await redisSet(key, JSON.stringify(trimmed));

      // обновляем индекс чатов (список всех chatId + последнее сообщение)
      const idxRaw = await redisGet("tg:chats_index");
      const idx = JSON.parse(idxRaw || "{}");
      idx[chatId] = {
        chatId,
        name: msg.chat ? [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(" ") || msg.chat.title || "" : "",
        username: msg.chat && msg.chat.username || "",
        lastTs: ts,
        lastText: text.slice(0, 120),
        lastFromOwner: isOwner,
        // если клиент написал и никто не ответил — пометим для алерта
        waitingReply: !isOwner,
      };
      await redisSet("tg:chats_index", JSON.stringify(idx));

      res.status(200).json({ ok: true, stored: true }); return;
    }

    res.status(200).json({ ok: true, ignored: true });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e).slice(0, 200) }); // 200 чтобы Telegram не ретраил бесконечно
  }
}
