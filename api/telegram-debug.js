// /api/telegram-debug.js — проверка состояния Telegram-подключения.
// Открой: /api/telegram-debug?session=ТВОЯ_СЕССИЯ
// Показывает: сохранённое соединение, разрешения, свежий connection от Telegram.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json(); return d && d.result ? d.result : null;
}
async function getSession(session) {
  if (!session) return null;
  try { const raw = await redisGet(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

export default async function handler(req, res) {
  const session = req.query && req.query.session;
  const sess = await getSession(session);
  if (!sess || sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }

  try {
    const conn = JSON.parse((await redisGet("tg:connection")) || "{}");
    const idx = JSON.parse((await redisGet("tg:chats_index")) || "{}");

    // проверяем бота
    let botInfo = null;
    if (BOT_TOKEN) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
        botInfo = await r.json();
      } catch (e) {}
    }

    // пробуем получить свежее business connection напрямую
    let freshConn = null;
    if (BOT_TOKEN && conn.connection_id) {
      try {
        const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getBusinessConnection?business_connection_id=${encodeURIComponent(conn.connection_id)}`);
        freshConn = await r.json();
      } catch (e) { freshConn = { error: String(e).slice(0, 100) }; }
    }

    res.status(200).json({
      ok: true,
      saved_connection: {
        has_connection_id: !!conn.connection_id,
        connection_id_preview: conn.connection_id ? conn.connection_id.slice(0, 8) + "..." : null,
        user_id: conn.user_id,
        can_reply: conn.can_reply,
        enabled: conn.enabled,
      },
      bot: botInfo && botInfo.ok ? { username: botInfo.result.username, id: botInfo.result.id } : { error: "bot token issue" },
      fresh_connection_from_telegram: freshConn,
      chats_stored: Object.keys(idx).length,
      sample_chat_ids: Object.keys(idx).slice(0, 3),
      hint: "Если can_reply=false или fresh_connection показывает ошибку — проблема в разрешении/подключении. Если chats_stored мало — бот видит мало активных чатов.",
    });
  } catch (e) {
    res.status(500).json({ error: "failed", detail: String(e).slice(0, 300) });
  }
}
