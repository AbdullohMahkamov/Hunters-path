// /api/dashboard.js — отдаёт кэш дашборда + кэш скорости/дисциплины из Upstash.
// Мультитенант: ключи с префиксом клиента (hunter — без префикса, как было).
export default async function handler(req, res) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).json({ error: "Upstash env not set" }); return; }

  async function getKey(key){
    try{
      const r=await fetch(`${url}/get/${encodeURIComponent(key)}`,{headers:{Authorization:`Bearer ${token}`}});
      const d=await r.json();
      if(!d||d.result==null) return null;
      return JSON.parse(d.result);
    }catch(e){ return null; }
  }

  // ДОСТУП: дашборд содержит коммерцию (выручка/сделки/воронка) — только по валидной сессии.
  // org берём ИЗ СЕССИИ (не из query), иначе любой мог бы читать чужой кабинет через ?org=.
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const sinfo = session ? await getKey(`session:${session}`) : null;
  if (!sinfo) { res.status(401).json({ error: "Требуется авторизация" }); return; }
  // МОП — только свой кабинет (/api/mop); саппорт — только своя панель
  if (sinfo.role === "mop" || sinfo.role === "support") { res.status(403).json({ error: "Недоступно для этой роли" }); return; }
  const org = sinfo.org || "hunter";
  const K = (name) => org === "hunter" ? name : `${name}:${org}`;

  try {
    const dash = await getKey(K("dashboard"));
    const speed = await getKey(K("speed"));
    if (!dash) { res.status(200).json({ empty: true, speed }); return; }
    // МАРКЕТОЛОГ: владелец разрешил все разделы дашборда КРОМЕ Финансов → отдаём полный dash, режем только finance.
    if (sinfo.role === "marketing") {
      const safe = { ...dash }; delete safe.finance;
      res.status(200).json({ ...safe, speed, _scope: "marketing" });
      return;
    }
    res.status(200).json({ ...dash, speed });
  } catch (err) {
    res.status(500).json({ error: "Dashboard read failed", detail: String(err) });
  }
}
