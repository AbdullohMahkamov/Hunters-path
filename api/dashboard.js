// /api/dashboard.js — отдаёт кэш дашборда + кэш скорости/дисциплины из Upstash.
// Мультитенант: ключи с префиксом клиента (hunter — без префикса, как было).
export default async function handler(req, res) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).json({ error: "Upstash env not set" }); return; }

  const org = (req.query && req.query.org) || "hunter";
  const K = (name) => org === "hunter" ? name : `${name}:${org}`;

  async function getKey(key){
    try{
      const r=await fetch(`${url}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${token}`}});
      const d=await r.json();
      if(!d||d.result==null) return null;
      return JSON.parse(d.result);
    }catch(e){ return null; }
  }

  // МОП НЕ имеет доступа к общему дашборду (только свой кабинет через /api/mop)
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  if (session) {
    const sinfo = await getKey(`session:${session}`);
    if (sinfo && sinfo.role === "mop") { res.status(403).json({ error: "Недоступно для этой роли" }); return; }
  }

  try {
    const dash = await getKey(K("dashboard"));
    const speed = await getKey(K("speed"));
    if (!dash) { res.status(200).json({ empty: true, speed }); return; }
    res.status(200).json({ ...dash, speed });
  } catch (err) {
    res.status(500).json({ error: "Dashboard read failed", detail: String(err) });
  }
}
