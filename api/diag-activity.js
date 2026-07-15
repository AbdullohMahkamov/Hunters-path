// /api/diag-activity.js — РАЗОВАЯ ДИАГНОСТИКА (только админ), read-only.
// Вопрос: какие ДЕЙСТВИЯ МОПов реально логируются в amoCRM /events и насколько надёжны —
// чтобы решить, можно ли строить ПОЗУ персонажа (активен/отошёл/тихо) на «последнем действии в CRM».
//
// Запрашивает /events ВСЕХ типов за окно (по умолчанию 3ч), группирует по created_by (пользователь),
// маппит user_id → имя МОПа. По каждому: последнее действие (тип + минут назад), разбивка по типам.
// Плюс: список всех встреченных типов (что вообще логируется) и флаг труркации (риск потери, как
// eventsComplete у звонков). Ничего не пишет. После разбора — удалить.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SUBDOMAIN = "huntercademy";
// user_id → имя (из HUNTER_CFG.mops в sync-speed.js)
const MOPS = { 13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda", 13833590: "Begoyim", 13681582: "Abulbositxon" };

async function sessionRole(session) {
  if (!session) return null;
  try { const r = await fetch(`${REDIS_URL}/get/session:${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); if (!d || d.result == null) return null; const s = JSON.parse(d.result); return s && s.role; } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {};
  const role = await sessionRole(q.session);
  if (role !== "admin") { res.status(403).json({ error: "admin only" }); return; }
  const token = process.env.AMOCRM_TOKEN;
  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const hours = Math.min(24, parseInt(q.hours || "3", 10) || 3);
  const from = Math.floor(Date.now() / 1000) - hours * 3600;

  // тянем /events ВСЕХ типов за окно, order desc, до 6 страниц (600 событий)
  let page = 1, truncated = false, apiError = null;
  const perUser = {};       // uid → { last, lastType, count, types:{} }
  const allTypes = {};      // type → count (что вообще логируется)
  let totalEvents = 0;
  while (page <= 6) {
    const url = `${base}/events?limit=100&page=${page}&order[created_at]=desc&filter[created_at][from]=${from}`;
    let r;
    try { r = await fetch(url, { headers: H }); } catch (e) { apiError = String(e && e.message || e); truncated = true; break; }
    if (r.status === 204) break;
    if (!r.ok) { apiError = `amoCRM ${r.status}`; truncated = true; break; }
    const d = await r.json();
    const events = (d._embedded && d._embedded.events) || [];
    for (const e of events) {
      totalEvents++;
      allTypes[e.type] = (allTypes[e.type] || 0) + 1;
      const uid = e.created_by;
      if (!perUser[uid]) perUser[uid] = { last: 0, lastType: "", count: 0, types: {} };
      const u = perUser[uid];
      u.count++;
      u.types[e.type] = (u.types[e.type] || 0) + 1;
      if ((e.created_at || 0) > u.last) { u.last = e.created_at; u.lastType = e.type; }
    }
    if (events.length < 100) break;
    page++;
  }
  if (page > 6) truncated = true; // упёрлись в потолок страниц — событий больше, чем прочитали

  const now = Math.floor(Date.now() / 1000);
  const mopRows = Object.entries(MOPS).map(([uid, name]) => {
    const u = perUser[uid];
    if (!u || !u.last) return { name, uid: +uid, lastActionMinAgo: null, lastType: null, actionsInWindow: 0, types: {} };
    return { name, uid: +uid, lastActionMinAgo: Math.round((now - u.last) / 60), lastType: u.lastType, actionsInWindow: u.count, types: u.types };
  }).sort((a, b) => (a.lastActionMinAgo ?? 1e9) - (b.lastActionMinAgo ?? 1e9));

  res.status(200).json({
    ok: true, windowHours: hours, totalEvents,
    reliability: { truncated, apiError, note: truncated ? "часть событий не прочитана (потолок/сбой/таймаут) — риск потери, как eventsComplete у звонков" : "за окно прочитаны все события" },
    availableEventTypes: allTypes,       // что вообще логируется в CRM (доступность действий)
    mops: mopRows,                        // по каждому МОПу: последнее действие + разбивка
    caveat: "Активность В CRM ≠ работает ли человек. Звонок с личного телефона / просмотр лида могут НЕ логироваться как событие.",
  });
}
