// /api/sync-speed.js — оценка дисциплины МОПов из СОБЫТИЙ amoCRM (Вариант В: все события месяца).
// Считает: скорость 1-го звонка, настойчивость дозвона, "закрыл рано" (детектор халтуры), задачи.
// Тяжёлый модуль — тянет события пачками. Запуск: ночью (Cron) или вручную.

const SUBDOMAIN = "huntercademy";
const PIPELINE_ID_NAME = "HunterAcademy";
const SOLD_STATUS = 142;     // Sotildi
const LOST_STATUS = 143;     // Yopildi
const OWN_THRESHOLD = 1600000;

const ACTIVE_MOPS = {
  13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda",
  13833590: "Begoyim", 13681582: "Abulbositxon",
};
// loss reason id "3 marta bog'lanib bo'lmadi"
const NO_REACH_REASON_ID = 22815982;

async function redisSet(url, token, key, value) {
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  return r.ok;
}

function median(arr){
  if(!arr.length) return null;
  const s=[...arr].sort((a,b)=>a-b);
  const m=Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "Upstash env not set" }); return; }

  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  try {
    // 1) Найдём pipeline_id воронки HunterAcademy
    let pipelineId = null;
    const pr = await fetch(`${base}/leads/pipelines`, { headers: H });
    if (pr.ok) {
      const pd = await pr.json();
      for (const p of ((pd._embedded && pd._embedded.pipelines) || []))
        if (p.name === PIPELINE_ID_NAME) pipelineId = p.id;
    }

    // 2) Тянем ЛИДЫ месяца: id -> {created_at, responsible, status, price, lossId}
    const leadInfo = {};
    let page = 1, guard = 0;
    while (guard < 80) {
      guard++;
      let url = `${base}/leads?limit=250&page=${page}&filter[created_at][from]=${monthStart}`;
      if (pipelineId) url += `&filter[pipeline_id]=${pipelineId}`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) { res.status(r.status).json({ error: "leads error", detail: (await r.text()).slice(0,300) }); return; }
      const d = await r.json();
      const leads = (d._embedded && d._embedded.leads) || [];
      for (const L of leads) {
        leadInfo[L.id] = {
          created: L.created_at,
          resp: L.responsible_user_id,
          status: L.status_id,
          price: L.price || 0,
          lossId: L.loss_reason_id || null,
          firstCall: null,   // время первого исходящего звонка
          calls: 0,          // кол-во исходящих звонков
          tasks: 0,          // кол-во задач
        };
      }
      if (leads.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // 3) Тянем СОБЫТИЯ месяца пачками: только outgoing_call (звонки), привязка к лидам
    const evTypes2 = "outgoing_call";
    page = 1; guard = 0;
    while (guard < 120) {
      guard++;
      const url = `${base}/events?filter[type]=${evTypes2}` +
        `&filter[created_at][from]=${monthStart}&limit=250&page=${page}&order[created_at]=asc`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) break;
      const d = await r.json();
      const events = (d._embedded && d._embedded.events) || [];
      for (const e of events) {
        if (e.entity_type !== "lead") continue;
        const li = leadInfo[e.entity_id];
        if (!li) continue;
        if (e.type === "outgoing_call") {
          li.calls++;
          if (li.firstCall === null || e.created_at < li.firstCall) li.firstCall = e.created_at;
        }
      }
      if (events.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // 3b) ЗАДАЧИ — через отдельный эндпоинт /tasks (привязаны к лиду через entity_id, entity_type=leads)
    page = 1; guard = 0;
    while (guard < 120) {
      guard++;
      const url = `${base}/tasks?limit=250&page=${page}&filter[created_at][from]=${monthStart}`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) break;
      const d = await r.json();
      const tasks = (d._embedded && d._embedded.tasks) || [];
      for (const t of tasks) {
        const et = t.entity_type;
        if (et !== "leads" && et !== "lead") continue;
        const li = leadInfo[t.entity_id];
        if (!li) continue;
        li.tasks++;
      }
      if (tasks.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // 4) Считаем дисциплину по каждому действующему МОПу
    const stat = {}; // mopName -> агрегаты
    for (const name of Object.values(ACTIVE_MOPS)) {
      stat[name] = { leads:0, firstCallTimes:[], reached:0, callsTotal:0, withTask:0,
                     closedEarly:0, noReachClosed:0 };
    }

    for (const id in leadInfo) {
      const L = leadInfo[id];
      const mop = ACTIVE_MOPS[L.resp];
      if (!mop) continue;
      // исключаем "своих"
      if (L.status === SOLD_STATUS && L.price <= OWN_THRESHOLD) continue;
      const S = stat[mop];
      S.leads++;
      S.callsTotal += L.calls;
      if (L.tasks > 0) S.withTask++;
      if (L.firstCall) {
        S.reached++;
        const mins = (L.firstCall - L.created) / 60;
        if (mins >= 0 && mins < 60*24*14) S.firstCallTimes.push(mins);
      }
      // ДЕТЕКТОР ХАЛТУРЫ: закрыл "3 marta bog'lanib bo'lmadi", а звонков < 3
      if (L.status === LOST_STATUS && L.lossId === NO_REACH_REASON_ID) {
        S.noReachClosed++;
        if (L.calls < 3) S.closedEarly++;
      }
    }

    // 5) Формируем результат
    const mops = Object.entries(stat).map(([name, S]) => {
      const medMin = median(S.firstCallTimes);
      return {
        name,
        leads: S.leads,
        medianFirstCallMin: medMin !== null ? Math.round(medMin) : null,
        avgCallsPerLead: S.leads ? +(S.callsTotal / S.leads).toFixed(1) : 0,
        taskRate: S.leads ? Math.round(S.withTask / S.leads * 100) : 0,
        // % закрытых "не дозвонился" при < 3 звонках (халтура)
        earlyClosePct: S.noReachClosed ? Math.round(S.closedEarly / S.noReachClosed * 100) : 0,
        noReachClosed: S.noReachClosed,
        reachedPct: S.leads ? Math.round(S.reached / S.leads * 100) : 0,
      };
    }).sort((a,b)=> (a.medianFirstCallMin??9e9) - (b.medianFirstCallMin??9e9));

    const result = { updatedAt: new Date().toISOString(), period: "Текущий месяц", mops };
    await redisSet(redisUrl, redisToken, "speed", JSON.stringify(result));
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "speed sync failed", detail: String(err) });
  }
}
