// /api/telegram-chats.js — читает сохранённые Telegram-чаты и считает аналитику.
// GET ?action=list — список чатов (кто ждёт ответа, время ответа)
// GET ?action=chat&chatId=... — переписка конкретного чата
// Только для админа (сессия).

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  const d = await r.json();
  return d && d.result ? d.result : null;
}
async function getSession(session) {
  if (!session) return null;
  try {
    const raw = await redisGet(`session:${session}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const session = (req.query && req.query.session) || (req.headers && req.headers["x-session"]);
  const sess = await getSession(session);
  if (!sess || sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }

  const action = (req.query && req.query.action) || "list";
  const TZ = 5 * 3600;
  const now = Math.floor(Date.now() / 1000);

  try {
    if (action === "list") {
      const idx = JSON.parse((await redisGet("tg:chats_index")) || "{}");
      const chats = Object.values(idx).map(c => {
        const waitMin = c.waitingReply ? Math.round((now - c.lastTs) / 60) : 0;
        return {
          chatId: c.chatId,
          name: c.name || c.username || String(c.chatId),
          username: c.username || "",
          lastText: c.lastText || "",
          lastTs: c.lastTs,
          lastTime: new Date((c.lastTs + TZ) * 1000).toISOString().slice(5, 16).replace("T", " "),
          waitingReply: !!c.waitingReply,       // клиент написал, ответа нет
          waitingMinutes: waitMin,
        };
      }).sort((a, b) => b.lastTs - a.lastTs);

      // аналитика: сколько клиентов ждут ответа, и как давно
      const waiting = chats.filter(c => c.waitingReply);
      const waitingLong = waiting.filter(c => c.waitingMinutes > 30); // ждут >30 мин
      res.status(200).json({
        ok: true,
        total_chats: chats.length,
        waiting_reply: waiting.length,
        waiting_over_30min: waitingLong.length,
        chats,
      });
      return;
    }

    if (action === "chat") {
      const chatId = req.query && req.query.chatId;
      if (!chatId) { res.status(400).json({ error: "no chatId" }); return; }
      const msgs = JSON.parse((await redisGet(`tgchat:${chatId}`)) || "[]");
      // считаем время ответа менеджера (от сообщения клиента до ответа владельца)
      let replyTimes = [];
      for (let i = 1; i < msgs.length; i++) {
        if (!msgs[i - 1].isOwner && msgs[i].isOwner) {
          const dt = Math.round((msgs[i].ts - msgs[i - 1].ts) / 60);
          if (dt >= 0 && dt < 60 * 24 * 7) replyTimes.push(dt);
        }
      }
      const avgReply = replyTimes.length ? Math.round(replyTimes.reduce((a, b) => a + b, 0) / replyTimes.length) : null;
      res.status(200).json({
        ok: true,
        chatId,
        messages: msgs.map(m => ({
          ...m,
          time: new Date((m.ts + TZ) * 1000).toISOString().slice(5, 16).replace("T", " "),
        })),
        avg_reply_minutes: avgReply,
      });
      return;
    }

    res.status(400).json({ error: "unknown action" });
  } catch (e) {
    res.status(500).json({ error: "failed", detail: String(e).slice(0, 200) });
  }
}
