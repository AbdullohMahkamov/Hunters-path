// /api/activity.js — Активность МОПов: звонки, движение по воронке, задачи, закрытия, новые лиды.
// Тяжёлый сбор из amoCRM → кэшируется. Свежесть: если кэшу >1 часа, пересобираем (обходит лимит крона Hobby).
// action: "get" (из кэша, собрать если устарел), "refresh" (принудительно собрать сейчас).

const SUBDOMAIN = "huntercademy";
const ACTIVE_MOPS = {
  13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda",
  13833590: "Begoyim", 13681582: "Abulbositxon",
};
const SOLD = "Sotildi", CLOSED_LOST = "Yopildi";

async function redisGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return typeof d.result === "string" ? JSON.parse(d.result) : d.result;
  } catch (e) { return null; }
}
async function redisSet(url, token, key, valObj, ttl) {
  try {
    const path = ttl ? `${url}/set/${encodeURIComponent(key)}?EX=${ttl}` : `${url}/set/${encodeURIComponent(key)}`;
    await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(valObj) });
  } catch (e) { /* не критично */ }
}

// YYYY-MM-DD в таймзоне Ташкента (UTC+5) из unix-секунд
function dayKey(unixSec) {
  const d = new Date((unixSec + 5 * 3600) * 1000);
  return d.toISOString().slice(0, 10);
}

async function collectActivity(token) {
  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  // структура: mop -> { calls:{day:n}, moves:{}, tasks:{}, closes:{}, leads:{} }  (day => счётчик)
  const acc = {};
  for (const name of Object.values(ACTIVE_MOPS)) {
    acc[name] = { calls: {}, moves: {}, tasks: {}, closes: {}, leads: {} };
  }
  const bump = (name, kind, day) => {
    if (!acc[name]) return;
    acc[name][kind][day] = (acc[name][kind][day] || 0) + 1;
  };

  // 1) СОБЫТИЯ: звонки (outgoing_call) + смена статуса (lead_status_changed) с начала месяца
  const evTypes = "outgoing_call,lead_status_changed";
  let page = 1, guard = 0;
  while (guard < 200) {
    guard++;
    const url = `${base}/events?filter[type]=${evTypes}` +
      `&filter[created_at][from]=${monthStart}&limit=250&page=${page}&order[created_at]=asc`;
    const r = await fetch(url, { headers: H });
    if (r.status === 204) break;
    if (!r.ok) break;
    const d = await r.json();
    const events = (d._embedded && d._embedded.events) || [];
    for (const e of events) {
      const mop = ACTIVE_MOPS[e.created_by];
      if (!mop) continue;
      const day = dayKey(e.created_at || 0);
      if (e.type === "outgoing_call") bump(mop, "calls", day);
      else if (e.type === "lead_status_changed") bump(mop, "moves", day);
    }
    if (events.length < 250) break;
    page++;
    await new Promise(rs => setTimeout(rs, 120));
  }

  // 2) ЗАДАЧИ выполненные (is_completed) с начала месяца
  page = 1; guard = 0;
  while (guard < 120) {
    guard++;
    const url = `${base}/tasks?limit=250&page=${page}&filter[updated_at][from]=${monthStart}`;
    const r = await fetch(url, { headers: H });
    if (r.status === 204) break;
    if (!r.ok) break;
    const d = await r.json();
    const tasks = (d._embedded && d._embedded.tasks) || [];
    for (const t of tasks) {
      if (!t.is_completed) continue;
      const mop = ACTIVE_MOPS[t.responsible_user_id];
      if (!mop) continue;
      const day = dayKey(t.complete_till || t.updated_at || 0);
      bump(mop, "tasks", day);
    }
    if (tasks.length < 250) break;
    page++;
    await new Promise(rs => setTimeout(rs, 120));
  }

  // 3) СДЕЛКИ: закрытия (продал/проиграл) по closed_at + новые лиды по created_at
  //    Тянем сделки за последние ~120 дней, чтобы поймать закрытия старой базы.
  const lookback = monthStart - 120 * 24 * 3600;
  // статусы
  let statusName = {};
  try {
    const pr = await fetch(`${base}/leads/pipelines`, { headers: H });
    const pd = await pr.json();
    for (const p of (pd._embedded && pd._embedded.pipelines) || []) {
      for (const s of (p._embedded && p._embedded.statuses) || []) statusName[s.id] = s.name;
    }
  } catch (e) {}
  page = 1; guard = 0;
  while (guard < 120) {
    guard++;
    const url = `${base}/leads?limit=250&page=${page}&filter[created_at][from]=${lookback}`;
    const r = await fetch(url, { headers: H });
    if (r.status === 204) break;
    if (!r.ok) break;
    const d = await r.json();
    const leads = (d._embedded && d._embedded.leads) || [];
    for (const L of leads) {
      const mop = ACTIVE_MOPS[L.responsible_user_id];
      if (!mop) continue;
      const st = statusName[L.status_id] || "";
      // новый лид — по дате создания
      if ((L.created_at || 0) >= monthStart) bump(mop, "leads", dayKey(L.created_at));
      // закрытие — по дате закрытия (вкл. старую базу)
      if ((st === SOLD || st === CLOSED_LOST) && (L.closed_at || 0) >= monthStart) {
        bump(mop, "closes", dayKey(L.closed_at));
      }
    }
    if (leads.length < 250) break;
    page++;
    await new Promise(rs => setTimeout(rs, 120));
  }

  return { collectedAt: Math.floor(Date.now() / 1000), monthStart, mops: acc };
}

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  const rurl = process.env.UPSTASH_REDIS_REST_URL, rtoken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }

  const action = (req.body && req.body.action) || (req.query && req.query.action) || "get";
  const CACHE_KEY = "activity:v1";
  const FRESH_SEC = 3600; // 1 час

  try {
    // get: отдаём кэш; если устарел (>1ч) — пересобираем
    if (action === "get") {
      const cached = rurl ? await redisGet(rurl, rtoken, CACHE_KEY) : null;
      const age = cached ? (Math.floor(Date.now() / 1000) - (cached.collectedAt || 0)) : Infinity;
      if (cached && age < FRESH_SEC) {
        res.status(200).json({ ok: true, ...cached, cached: true, ageSec: age });
        return;
      }
      // устарело — собираем свежее
      const fresh = await collectActivity(token);
      if (rurl) await redisSet(rurl, rtoken, CACHE_KEY, fresh, 172800); // 2 дня хранения
      res.status(200).json({ ok: true, ...fresh, cached: false });
      return;
    }
    // refresh: принудительный сбор
    if (action === "refresh") {
      const fresh = await collectActivity(token);
      if (rurl) await redisSet(rurl, rtoken, CACHE_KEY, fresh, 172800);
      res.status(200).json({ ok: true, ...fresh, cached: false });
      return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    res.status(500).json({ error: "activity failed", detail: String(err) });
  }
}
