// /api/user-data.js — хранит всё состояние пользователя (чаты, прогресс, настройки) в облаке.
// Ключ данных = org (организация), чтобы потом легко разделить по клиентам.
// Требует валидную сессию.

async function getSession(url, token, session) {
  if (!session) return null;
  try {
    const r = await fetch(`${url}/get/session:${encodeURIComponent(session)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return JSON.parse(d.result);
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).json({ error: "Upstash env not set" }); return; }

  try {
    const { action, session, data } = req.body || {};
    const sess = await getSession(url, token, session);
    if (!sess) { res.status(401).json({ error: "no session" }); return; }

    // Данные храним по организации (org). Роль внутри — из сессии.
    const key = `appdata:${sess.org}`;

    if (action === "load") {
      const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!d || d.result == null) { res.status(200).json({ ok: true, data: null, role: sess.role, org: sess.org }); return; }
      res.status(200).json({ ok: true, data: JSON.parse(d.result), role: sess.role, org: sess.org });
      return;
    }

    if (action === "save") {
      await fetch(`${url}/set/${key}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(data || {}),
      });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    res.status(500).json({ error: "user-data failed", detail: String(err) });
  }
}
