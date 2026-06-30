// /api/dashboard.js — отдаёт готовый кэш дашборда из Upstash (быстро, без обращения к amoCRM).
export default async function handler(req, res) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "Upstash env not set" }); return; }

  try {
    const r = await fetch(`${redisUrl}/get/dashboard`, {
      headers: { Authorization: `Bearer ${redisToken}` },
    });
    const data = await r.json();
    // Upstash возвращает {result: "<строка JSON>"} или {result: null}
    if (!data || data.result == null) {
      res.status(200).json({ empty: true });
      return;
    }
    let parsed;
    try { parsed = JSON.parse(data.result); } catch (e) { parsed = null; }
    if (!parsed) { res.status(200).json({ empty: true }); return; }
    res.status(200).json(parsed);
  } catch (err) {
    res.status(500).json({ error: "Dashboard read failed", detail: String(err) });
  }
}
