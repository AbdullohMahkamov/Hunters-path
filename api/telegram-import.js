// /api/telegram-import.js — приём экспорта истории Telegram + сегментация для реактивации.
// POST { session, action:"import", chats:[...] } — загрузка обработанных чатов (сегментация на клиенте, т.к. файл большой)
// GET  ?action=segments&session=... — получить сегменты
// GET  ?action=segment&name=...&session=... — чаты одного сегмента
// Admin only.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json();
  return d && d.result ? d.result : null;
}
async function redisSet(key, value) {
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: value });
}
async function getSession(session) {
  if (!session) return null;
  try { const raw = await redisGet(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const sess = await getSession(session);
  if (!sess || sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }
  const org = sess.org || "hunter";

  try {
    // === ЗАГРУЗКА сегментированных чатов (сегментация сделана на клиенте) ===
    if (req.method === "POST" && req.body && req.body.action === "import") {
      const segments = req.body.segments || {}; // {segName:[{id,name,lastText,lastDate},...]}
      const stats = req.body.stats || {};
      await redisSet(`tgseg:${org}`, JSON.stringify({ segments, stats, importedAt: Math.floor(Date.now() / 1000) }));
      res.status(200).json({ ok: true, saved: Object.keys(segments).length });
      return;
    }

    // === СПИСОК СЕГМЕНТОВ (сводка) ===
    if (req.query && req.query.action === "segments") {
      const raw = await redisGet(`tgseg:${org}`);
      if (!raw) { res.status(200).json({ ok: true, segments: null }); return; }
      const data = JSON.parse(raw);
      const summary = Object.entries(data.segments || {}).map(([name, chats]) => ({
        name, count: chats.length,
      }));
      res.status(200).json({ ok: true, summary, stats: data.stats, importedAt: data.importedAt });
      return;
    }

    // === ЧАТЫ ОДНОГО СЕГМЕНТА ===
    if (req.query && req.query.action === "segment") {
      const name = req.query.name;
      const raw = await redisGet(`tgseg:${org}`);
      if (!raw) { res.status(200).json({ ok: true, chats: [] }); return; }
      const data = JSON.parse(raw);
      const chats = (data.segments && data.segments[name]) || [];
      res.status(200).json({ ok: true, name, chats });
      return;
    }

    res.status(400).json({ error: "unknown action" });
  } catch (e) {
    res.status(500).json({ error: "failed", detail: String(e).slice(0, 300) });
  }
}
