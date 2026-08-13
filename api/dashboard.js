// /api/dashboard.js — отдаёт кэш дашборда + кэш скорости/дисциплины из Upstash.
// Мультитенант: ключи с префиксом клиента (hunter — без префикса, как было).
// Маркетинг-безопасный срез speed: убираем поимённую дисциплину МОПов, оставляем общую воронку/дозвон.
function safeSpeed(sp) {
  if (!sp || typeof sp !== "object") return sp;
  const s = { ...sp };
  ["mops", "mopsDay", "mopIssues", "suspicious2"].forEach((k) => delete s[k]);
  return s;
}

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
    if (!dash) { res.status(200).json({ empty: true, speed: sinfo.role === "marketing" ? safeSpeed(speed) : speed }); return; }
    // МАРКЕТОЛОГ: режем ПРОДАЖИ/ВЫРУЧКУ/ЦЕЛИ/поимённых МОПов ещё на бэкенде (не только прячем во фронте).
    // Остаётся маркетинг + общая воронка: лиды, реклама/аудитории, конверсия, число продаж (без сумм).
    if (sinfo.role === "marketing") {
      const t = { ...(dash.totals || {}) };
      ["revenue", "newSalesRevenue", "avgCheck", "revenueToday", "revenuePeriod", "goal", "goalUZS"].forEach((k) => delete t[k]);
      const safe = { ...dash, totals: t };
      ["goal", "mopsByConv", "mopsBySales", "soldPriceHist", "soldPayments", "dataQuality", "finance", "periodResults", "monthlyFunnelRevenue"].forEach((k) => delete safe[k]);
      res.status(200).json({ ...safe, speed: safeSpeed(speed), _scope: "marketing" });
      return;
    }
    res.status(200).json({ ...dash, speed });
  } catch (err) {
    res.status(500).json({ error: "Dashboard read failed", detail: String(err) });
  }
}
