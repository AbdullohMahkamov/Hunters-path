// /api/sync-speed.js — оценка дисциплины МОПов из СОБЫТИЙ amoCRM.
// Мультитенант: настройки клиента из конфига (org). Витрина hunter = дефолт.

const HUNTER_CFG = {
  subdomain: "huntercademy",
  pipelineName: "HunterAcademy",
  soldStatus: 142,     // Sotildi
  lostStatus: 143,     // Yopildi
  ownThreshold: 1600000,
  noReachReasonId: 22815982, // "3 marta bog'lanib bo'lmadi"
  mops: {
    13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda",
    13833590: "Begoyim", 13681582: "Abulbositxon",
  },
};

async function redisGetCfg(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return d && d.result != null ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}
async function resolveConfig(org, redisUrl, redisToken) {
  org = org || "hunter";
  if (org === "hunter") return { org, token: process.env.AMOCRM_TOKEN, ...HUNTER_CFG };
  const s = await redisGetCfg(redisUrl, redisToken, `clientcfg:${org}`);
  if (!s || !s.subdomain || !s.token) return null;
  return {
    org, token: s.token, subdomain: s.subdomain,
    pipelineName: s.pipeline || "",
    soldStatus: s.soldStatus != null ? s.soldStatus : null,
    lostStatus: s.lostStatus != null ? s.lostStatus : null,
    ownThreshold: s.ownThreshold != null ? s.ownThreshold : 0,
    noReachReasonId: s.noReachReasonId != null ? s.noReachReasonId : null,
    mops: s.mops || {},
  };
}

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
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "Upstash env not set" }); return; }

  const org = (req.query && req.query.org) || "hunter";
  const cfg = await resolveConfig(org, redisUrl, redisToken);
  if (!cfg) { res.status(400).json({ error: `Клиент "${org}" не настроен` }); return; }

  const token = cfg.token;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }

  const SUBDOMAIN = cfg.subdomain;
  const PIPELINE_ID_NAME = cfg.pipelineName;
  const SOLD_STATUS = cfg.soldStatus;
  const LOST_STATUS = cfg.lostStatus;
  const OWN_THRESHOLD = cfg.ownThreshold;
  const ACTIVE_MOPS = cfg.mops || {};
  const NO_REACH_REASON_ID = cfg.noReachReasonId;
  const K = (name) => org === "hunter" ? name : `${name}:${org}`;

  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  // === РАБОЧЕЕ ВРЕМЯ (для честной скорости первого звонка) ===
  // читаем настройки клиента: workdays [0..6, 0=Вс], workStart/workEnd "HH:MM"
  const TZ_OFFSET = 5 * 3600; // Ташкент UTC+5
  let workdays = [1,2,3,4,5,6]; // по умолчанию Пн–Сб
  let workStartMin = 10 * 60;   // 10:00
  let workEndMin = 20 * 60;     // 20:00
  try {
    const sr = await fetch(`${redisUrl}/get/${encodeURIComponent(`settings:${org}`)}`, { headers: { Authorization: `Bearer ${redisToken}` } });
    const sd = await sr.json();
    const st = (sd && sd.result) ? JSON.parse(sd.result) : null;
    if (st) {
      if (Array.isArray(st.workdays) && st.workdays.length) workdays = st.workdays;
      const parseHM = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ""); return m ? (parseInt(m[1],10)*60 + parseInt(m[2],10)) : null; };
      const ws = parseHM(st.workStart); if (ws != null) workStartMin = ws;
      const we = parseHM(st.workEnd);   if (we != null) workEndMin = we;
    }
  } catch (e) {}
  if (workEndMin <= workStartMin) workEndMin = workStartMin + 60; // страховка
  const workLenMin = workEndMin - workStartMin;

  // локальные компоненты (Ташкент) из unix-времени
  function localParts(ts) {
    const d = new Date((ts + TZ_OFFSET) * 1000);
    return { dow: d.getUTCDay(), min: d.getUTCHours()*60 + d.getUTCMinutes(),
             y: d.getUTCFullYear(), m: d.getUTCMonth(), day: d.getUTCDate() };
  }
  // начало след. рабочего дня (в рабочих минутах внутри дня = 0), возвращает unix
  // считаем РАБОЧИЕ минуты между created и firstCall (ночь/выходные не учитываются)
  function workingMinutes(startTs, endTs) {
    if (endTs <= startTs) return 0;
    // идём по дням от start до end, суммируем пересечение с рабочим окном рабочих дней
    let total = 0;
    let cur = startTs;
    let guard = 0;
    while (cur < endTs && guard < 400) {
      guard++;
      const p = localParts(cur);
      const dayIsWork = workdays.includes(p.dow);
      const winStart = startOfLocalDay(cur) + workStartMin*60;
      const winEnd   = startOfLocalDay(cur) + workEndMin*60;
      if (dayIsWork) {
        const segStart = Math.max(cur, winStart);
        const segEnd   = Math.min(endTs, winEnd);
        if (segEnd > segStart) total += (segEnd - segStart) / 60;
      }
      // переходим к началу следующего дня
      cur = startOfLocalDay(cur) + 24*3600;
    }
    return Math.round(total);
  }
  function startOfLocalDay(ts) {
    const d = new Date((ts + TZ_OFFSET) * 1000);
    const midnightUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    return Math.floor(midnightUTC/1000) - TZ_OFFSET;
  }

  try {
    // 1) Найдём pipeline_id воронки HunterAcademy
    let pipelineId = null;
    const pr = await fetch(`${base}/leads/pipelines`, { headers: H });
    if (pr.ok) {
      const pd = await pr.json();
      for (const p of ((pd._embedded && pd._embedded.pipelines) || []))
        if (p.name === PIPELINE_ID_NAME) pipelineId = p.id;
    }

    // 1б) Тянем названия причин потери, чтобы отличить «неверный номер» / «телефон отключён»
    const lossNameById = {};
    try {
      let lp = 1;
      while (lp < 10) {
        const lr = await fetch(`${base}/leads/loss_reasons?limit=250&page=${lp}`, { headers: H });
        if (!lr.ok) break;
        const ld = await lr.json();
        const arr = (ld._embedded && ld._embedded.loss_reasons) || [];
        for (const x of arr) lossNameById[x.id] = (x.name || "").toLowerCase();
        if (arr.length < 250) break;
        lp++;
      }
    } catch (e) { /* если не вышло — работаем по старой логике */ }
    // хелперы: распознать причину по названию
    const isWrongNumber = (id) => { const n = lossNameById[id] || ""; return n.includes("xato raqam") || n.includes("неверный номер") || n.includes("неправильн"); };
    const isPhoneOff = (id) => { const n = lossNameById[id] || ""; return n.includes("o'chirilgan") || n.includes("o‘chirilgan") || n.includes("отключ"); };

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
          id: L.id,
          name: L.name || "",
          created: L.created_at,
          closed: L.closed_at || 0,
          updated: L.updated_at || 0,
          resp: L.responsible_user_id,
          status: L.status_id,
          price: L.price || 0,
          lossId: L.loss_reason_id || null,
          firstCall: null,   // время первого исходящего звонка
          reachedReal: false,// реальный разговор >60 сек
          calls: 0,          // кол-во исходящих звонков
          tasks: 0,          // кол-во задач
          tasksDone: 0,      // выполненных задач (нажат «выполнено»)
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
          if (li.callsToday === undefined) li.callsToday = 0;
          li._callTs = li._callTs || [];
          li._callTs.push(e.created_at); // время каждого звонка — для дневной статистики
        }
      }
      if (events.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // 3b) Тянем события СМЕНЫ ОТВЕТСТВЕННОГО — чтобы знать, когда лид назначен на менеджера
    // (для метрики "первый звонок после назначения")
    page = 1; guard = 0;
    while (guard < 60) {
      guard++;
      const url = `${base}/events?filter[type]=entity_responsible_changed` +
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
        // собираем ВСЕ моменты назначения ответственного (лид может переназначаться несколько раз)
        li._assignTs = li._assignTs || [];
        li._assignTs.push(e.created_at);
      }
      if (events.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // TZ и начало сегодняшнего дня (UTC+5) — нужно и для звонков, и для дневной статистики
    const TZ_OFFSET2 = 5 * 3600;
    const nowLocal2 = new Date(Date.now() + TZ_OFFSET2 * 1000);
    const dayStart2 = Math.floor(new Date(Date.UTC(nowLocal2.getUTCFullYear(), nowLocal2.getUTCMonth(), nowLocal2.getUTCDate())).getTime() / 1000) - TZ_OFFSET2;

    // 3a) ЗВОНКИ С ДЛИТЕЛЬНОСТЬЮ — из notes каждого лида (надёжно, как /leads/{id}/notes).
    // Utel пишет params.duration (сек). Разговор дольше REACHED_SEC = реальный дозвон.
    // Тянем только по лидам, которые нам нужны (созданные сегодня + за месяц, где были звонки),
    // чтобы не перегружать: приоритет — сегодняшние лиды (для метрики «за сегодня»).
    const REACHED_SEC = 40;
    let notesSeen = 0, callNotesSeen = 0, reachedSet = 0;
    // собираем ID лидов, у которых были звонки (calls>0) — по ним проверяем длительность
    const leadIdsToCheck = Object.keys(leadInfo).filter(id => {
      const li = leadInfo[id];
      return li && li.calls > 0; // были звонки — есть смысл проверять дозвон
    });
    // ограничим, чтобы не улететь по времени: сначала сегодняшние, потом остальные
    leadIdsToCheck.sort((a, b) => {
      const ta = (leadInfo[a].created || 0) >= dayStart2 ? 0 : 1;
      const tb = (leadInfo[b].created || 0) >= dayStart2 ? 0 : 1;
      return ta - tb;
    });
    const MAX_LEADS_CHECK = 400; // потолок, чтобы уложиться в лимит времени
    const toCheck = leadIdsToCheck.slice(0, MAX_LEADS_CHECK);
    for (const lid of toCheck) {
      try {
        const r = await fetch(`${base}/leads/${lid}/notes?limit=250`, { headers: H });
        if (!r.ok) continue;
        const d = await r.json();
        const notes = (d._embedded && d._embedded.notes) || [];
        for (const n of notes) {
          notesSeen++;
          if (n.note_type !== "call_out" && n.note_type !== "call_in") continue;
          callNotesSeen++;
          const p = n.params || {};
          const dur = parseInt(p.duration != null ? p.duration : (p.DURATION || 0), 10) || 0;
          if (dur >= REACHED_SEC) { leadInfo[lid].reachedReal = true; reachedSet++; }
        }
      } catch (e) { /* пропускаем сбойный лид */ }
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
        if (t.is_completed) li.tasksDone = (li.tasksDone || 0) + 1;
      }
      if (tasks.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // 4) Считаем дисциплину по каждому действующему МОПу
    const stat = {}; // mopName -> агрегаты
    const statDay = {}; // mopName -> агрегаты ТОЛЬКО за сегодня
    for (const name of Object.values(ACTIVE_MOPS)) {
      stat[name] = { leads:0, firstCallTimes:[], firstCallAssignTimes:[], reached:0, callsTotal:0, withTask:0,
                     closedEarly:0, noReachClosed:0, tasksTotal:0, tasksDone:0 };
      statDay[name] = { leads:0, firstCallTimes:[], firstCallAssignTimes:[], callsTotal:0, withTask:0, tasksTotal:0, tasksDone:0, reached:0, calledLeads:0 };
    }

    const suspicious2 = []; // подозрительные по звонкам (этап 2)
    const nowSec2 = Math.floor(Date.now() / 1000);
    const STALL_DAYS = 7; // лид без движения дольше 7 дней = завис

    for (const id in leadInfo) {
      const L = leadInfo[id];
      const mop = ACTIVE_MOPS[L.resp];
      if (!mop) continue;
      // исключаем "своих"
      if (L.status === SOLD_STATUS && L.price <= OWN_THRESHOLD) continue;
      const S = stat[mop];
      S.leads++;
      S.callsTotal += L.calls;
      // «ставит задачи» считаем ТОЛЬКО среди дозвонившихся (задача ставится после разговора)
      if (L.reachedReal && L.tasks > 0) S.withTask++;
      S.tasksTotal += (L.tasks || 0);
      S.tasksDone += (L.tasksDone || 0);
      if (L.firstCall) {
        const mins = workingMinutes(L.created, L.firstCall);
        if (mins >= 0 && mins < 60*24*14) S.firstCallTimes.push(mins);
        // ПОСЛЕДНЕЕ назначение ответственного ДО первого звонка (лид мог переназначаться)
        // берём только назначения, которые были ДО звонка
        let assignTs = null;
        if (Array.isArray(L._assignTs)) {
          const before = L._assignTs.filter(ts => ts <= L.firstCall);
          if (before.length) assignTs = Math.max(...before);
        }
        // если валидных назначений до звонка нет — берём создание (только если оно до звонка)
        if (assignTs === null && L.created <= L.firstCall) assignTs = L.created;
        // считаем только при корректных данных (назначение реально было до звонка)
        if (assignTs !== null && L.firstCall >= assignTs) {
          const minsA = workingMinutes(assignTs, L.firstCall);
          if (minsA >= 0 && minsA < 60*24*14) S.firstCallAssignTimes.push(minsA);
        }
      }
      // === СЕГОДНЯ: активность по звонкам, сделанным сегодня ===
      const callsToday = (L._callTs || []).filter(ts => ts >= dayStart2).length;
      const leadCreatedToday = (L.created || 0) >= dayStart2;
      // лид входит в дневную статистику, если сегодня по нему звонили ИЛИ он создан сегодня
      const inTodayStat = callsToday > 0 || leadCreatedToday;
      if (inTodayStat) {
        const D = statDay[mop];
        D.leads++;                              // ВСЕ лиды с сегодняшней активностью (единый знаменатель)
        D.callsTotal += callsToday;
        if (callsToday > 0) D.calledLeads++;    // сегодня звонили по этому лиду
        if (L.reachedReal && callsToday > 0) D.reached++; // и был реальный дозвон
        if (L.reachedReal && callsToday > 0 && L.tasks > 0) D.withTask++; // задачи только среди дозвонившихся
        D.tasksTotal += (L.tasks || 0);
        D.tasksDone += (L.tasksDone || 0);
        if (L.firstCall && L.firstCall >= dayStart2) {
          const mins = workingMinutes(L.created, L.firstCall);
          if (mins >= 0 && mins < 60*24*14) D.firstCallTimes.push(mins);
          let assignTs = null;
          if (Array.isArray(L._assignTs)) {
            const before = L._assignTs.filter(ts => ts <= L.firstCall);
            if (before.length) assignTs = Math.max(...before);
          }
          if (assignTs === null && L.created <= L.firstCall) assignTs = L.created;
          if (assignTs !== null && L.firstCall >= assignTs) {
            const minsA = workingMinutes(assignTs, L.firstCall);
            if (minsA >= 0 && minsA < 60*24*14) D.firstCallAssignTimes.push(minsA);
          }
        }
      }
      // РЕАЛЬНЫЙ ДОЗВОН — только если был разговор дольше 60 сек
      if (L.reachedReal) S.reached++;
      // ДЕТЕКТОР ХАЛТУРЫ (с учётом «мёртвых» номеров):
      if (L.status === LOST_STATUS) {
        if (isWrongNumber(L.lossId)) {
          // неверный номер — не халтура
        }
        else if (L.lossId === NO_REACH_REASON_ID || isPhoneOff(L.lossId)) {
          S.noReachClosed++;
          if (L.calls < 3) {
            S.closedEarly++;
            // [ЗВОНКИ] закрыл «не дозвонился» с 0-1 звонком
            if (L.calls <= 1) {
              suspicious2.push({ id: L.id, name: L.name, price: null, responsible: mop,
                closed_at: L.closed || L.updated, created_at: L.created,
                cat: "calls", type: "early_close", label: `Закрыл «не дозвонился» (${L.calls} звонк.)` });
            }
          }
        }
      }
      // [ЗВОНКИ] дозвон, но мгновенное закрытие: позвонил и закрыл в течение 2 минут
      if (L.status === LOST_STATUS && L.firstCall && L.closed && (L.closed - L.firstCall) >= 0 && (L.closed - L.firstCall) < 120) {
        suspicious2.push({ id: L.id, name: L.name, price: null, responsible: mop,
          closed_at: L.closed, created_at: L.created,
          cat: "calls", type: "instant_close", label: "Дозвон и мгновенное закрытие (<2 мин)" });
      }
      // [ВОРОНКА] лид завис: открыт (не продан/не закрыт), без изменений дольше 7 дней
      if (L.status !== SOLD_STATUS && L.status !== LOST_STATUS && L.updated && (nowSec2 - L.updated) > STALL_DAYS * 24 * 3600) {
        const days = Math.floor((nowSec2 - L.updated) / (24 * 3600));
        suspicious2.push({ id: L.id, name: L.name, price: null, responsible: mop,
          closed_at: L.updated, created_at: L.created,
          cat: "funnel", type: "stalled", label: `Лид завис (${days} дн. без движения)` });
      }
    }

    // 5) Формируем результат
    const mops = Object.entries(stat).map(([name, S]) => {
      const medMin = median(S.firstCallTimes);
      const medAssign = median(S.firstCallAssignTimes);
      return {
        name,
        leads: S.leads,
        reached: S.reached,          // сколько лидов реально дозвонились (>40 сек)
        fastFirstCalls: S.firstCallTimes.filter(mn => mn < 15).length, // 1-й звонок < 15 мин (для геймификации)
        medianFirstCallMin: medMin !== null ? Math.round(medMin) : null,
        medianFirstCallAssignMin: medAssign !== null ? Math.round(medAssign) : null, // 1-й звонок после назначения
        avgCallsPerLead: S.leads ? +(S.callsTotal / S.leads).toFixed(1) : 0,
        taskRate: S.reached ? Math.round(S.withTask / S.reached * 100) : 0,
        // % закрытых "не дозвонился" при < 3 звонках (халтура) — оставлено для совместимости
        earlyClosePct: S.noReachClosed ? Math.round(S.closedEarly / S.noReachClosed * 100) : 0,
        noReachClosed: S.noReachClosed,
        closedEarly: S.closedEarly,
        // % дозвона в дисциплине берётся на фронте из sync.js (mopsByConv.reachPct) — рабочий источник
        // задачи: всего и реально выполнено (нажат «выполнено»)
        tasksTotal: S.tasksTotal,
        tasksDone: S.tasksDone,
        tasksDonePct: S.tasksTotal ? Math.round(S.tasksDone / S.tasksTotal * 100) : 0,
      };
    }).sort((a,b)=> (a.medianFirstCallMin??9e9) - (b.medianFirstCallMin??9e9));

    // мопы за сегодня (те же метрики, но только по лидам, созданным сегодня)
    const mopsDay = Object.entries(statDay).map(([name, D]) => {
      const medMin = median(D.firstCallTimes);
      const medAssign = median(D.firstCallAssignTimes);
      return {
        name,
        leads: D.leads,
        medianFirstCallMin: medMin !== null ? Math.round(medMin) : null,
        medianFirstCallAssignMin: medAssign !== null ? Math.round(medAssign) : null,
        avgCallsPerLead: D.leads ? +(D.callsTotal / D.leads).toFixed(1) : 0,
        taskRate: D.reached ? Math.min(100, Math.round(D.withTask / D.reached * 100)) : 0,
        reachedPct: D.leads ? Math.min(100, Math.round(D.reached / D.leads * 100)) : 0,     // реальный дозвон (>40 сек)
        reached: D.reached,             // сколько дозвонились (штук)
        calledLeads: D.calledLeads,     // скольким звонили (штук)
        calledPct: D.leads ? Math.min(100, Math.round(D.calledLeads / D.leads * 100)) : 0,  // % кому звонили
        tasksTotal: D.tasksTotal,
        tasksDone: D.tasksDone,
        tasksDonePct: D.tasksTotal ? Math.min(100, Math.round(D.tasksDone / D.tasksTotal * 100)) : 0,
      };
    }).sort((a,b)=> (a.medianFirstCallMin??9e9) - (b.medianFirstCallMin??9e9));

    const result = { updatedAt: new Date().toISOString(), period: "Текущий месяц", mops, mopsDay, suspicious2: suspicious2.slice(0, 300), _callDiag: { notesSeen, callNotesSeen, reachedSet } };
    await redisSet(redisUrl, redisToken, K("speed"), JSON.stringify(result));
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "speed sync failed", detail: String(err) });
  }
}
