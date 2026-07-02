// /api/demo.js — управление демо-аккаунтами (только для админа).
// Создать (до 5), список, удалить. Каждый демо = своя org со своими данными + код доступа.
import crypto from "crypto";

const MAX_DEMOS = 5;

async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return JSON.parse(d.result);
  } catch (e) { return null; }
}
async function redisSet(url, token, key, value) {
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  return r.ok;
}
async function redisDel(url, token, key) {
  await fetch(`${url}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
}
async function getSession(url, token, session) {
  if (!session) return null;
  const info = await redisGet(url, token, `session:${session}`);
  return info;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).json({ error: "Upstash env not set" }); return; }

  try {
    const { action, session, demoId } = req.body || {};
    const sess = await getSession(url, token, session);
    // Только админ управляет демо-аккаунтами
    if (!sess || sess.role !== "admin") { res.status(403).json({ error: "Только для админа" }); return; }

    const listKey = "demos:list";
    let demos = (await redisGet(url, token, listKey)) || [];

    if (action === "list") {
      res.status(200).json({ ok: true, demos, max: MAX_DEMOS });
      return;
    }

    if (action === "create") {
      if (demos.length >= MAX_DEMOS) { res.status(200).json({ ok: false, error: `Максимум ${MAX_DEMOS} демо-аккаунтов` }); return; }
      const n = demos.length + 1;
      const org = "demo_" + crypto.randomBytes(4).toString("hex");
      const code = Math.random().toString().slice(2, 8); // 6-значный код доступа
      const demo = { id: "d" + Date.now(), name: "Демо " + n, org, code, created: Date.now() };
      demos.push(demo);
      await redisSet(url, token, listKey, JSON.stringify(demos));
      res.status(200).json({ ok: true, demo, demos });
      return;
    }

    if (action === "delete") {
      const demo = demos.find(d => d.id === demoId);
      if (demo) {
        // удаляем данные этого демо-аккаунта
        await redisDel(url, token, `appdata:${demo.org}`);
      }
      demos = demos.filter(d => d.id !== demoId);
      await redisSet(url, token, listKey, JSON.stringify(demos));
      res.status(200).json({ ok: true, demos });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    res.status(500).json({ error: "demo failed", detail: String(err) });
  }
}
