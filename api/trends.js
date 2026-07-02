// /api/trends.js — отдаёт историю ежедневных снимков для графика динамики.
async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return JSON.parse(d.result);
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).json({ error: "Upstash env not set" }); return; }

  try {
    const dates = (await redisGet(url, token, "snap:list")) || [];
    if (!dates.length) { res.status(200).json({ ok: true, snaps: [] }); return; }

    // тянем последние N снимков (максимум 30 для графика)
    const recent = dates.slice(-30);
    const snaps = [];
    for (const dt of recent) {
      const s = await redisGet(url, token, `snap:${dt}`);
      if (s) snaps.push(s);
    }
    res.status(200).json({ ok: true, snaps });
  } catch (err) {
    res.status(500).json({ error: "trends failed", detail: String(err) });
  }
}
