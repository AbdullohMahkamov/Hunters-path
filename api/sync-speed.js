// /api/sync-speed.js — оценка дисциплины МОПов из СОБЫТИЙ amoCRM.
// Мультитенант: настройки клиента из конфига (org). Витрина hunter = дефолт.

const HUNTER_CFG = {
  subdomain: "huntercademy",
  pipelineName: "HunterAcademy",
  soldStatus: 142,     // Sotildi
  lostStatus: 143,     // Yopildi
  ownThreshold: 1600000,
  noReachReasonId: 22815982, // "3 marta bog'lanib bo'lmadi"
  reachedSec: 40,      // порог «реального дозвона» (сек). НЕ хардкод — правится в конфиге клиента.
  // Этапы «не дозвонились» (для MOP Agent: ловим лидов, где разговор БЫЛ, а статус остался этим)
  noContactStages: ["Bog'lanib bo'lmadi", "Bog'lanib bo'lmadi 2", "O'ylab ko'radidan keyin bog'lanib bo'lmadi"],
  stalledNoCallHours: 4, // лид в работе N часов, звонков ноль → точечная задача РОПу
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
    reachedSec: s.reachedSec != null ? s.reachedSec : 40, // порог дозвона (сек), дефолт 40
    noContactStages: s.noContactStages || [],
    stalledNoCallHours: s.stalledNoCallHours != null ? s.stalledNoCallHours : 4,
    mops: s.mops || {},
  };
}

// роль по сессии — нужна только для гейта debug-режима (админ)
async function sessionRole(url, token, session) {
  if (!session) return null;
  try {
    const r = await fetch(`${url}/get/session:${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!d || d.result == null) return null;
    const s = JSON.parse(d.result);
    return s && s.role;
  } catch (e) { return null; }
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

  // TZ и начало сегодняшнего дня (Ташкент, UTC+5) — нужно и для звонков, и для дневной статистики.
  // Считаем РАНО: в debug-режиме сужаем выборку событий до сегодняшних, иначе запрос не укладывается в лимит.
  const TZ_OFFSET2 = 5 * 3600;
  const nowLocal2 = new Date(Date.now() + TZ_OFFSET2 * 1000);
  const dayStart2 = Math.floor(new Date(Date.UTC(nowLocal2.getUTCFullYear(), nowLocal2.getUTCMonth(), nowLocal2.getUTCDate())).getTime() / 1000) - TZ_OFFSET2;
  // === DEBUG (разовая диагностика, только админ): ?debug=calls&mop=Имя&session=... ===
  // Сверяем каждое событие звонка за сегодня с фактической нотой (длительностью).
  // В обычный ответ/кэш не попадает и в лог не пишется.
  const DEBUG_CALLS = ((req.query && req.query.debug) || "") === "calls";
  const DEBUG_MOP = (req.query && req.query.mop) || "";
  const now = new Date();
  // monthStart — по календарю Ташкента (UTC+5), консистентно с dayStart2 ниже;
  // иначе фильтр amoCRM терял лиды, созданные 00:00–05:00 1-го числа месяца.
  const _tzoffMs = 5 * 3600;
  const _nlMs = new Date(Date.now() + _tzoffMs * 1000);
  const monthStart = Math.floor(Date.UTC(_nlMs.getUTCFullYear(), _nlMs.getUTCMonth(), 1) / 1000) - _tzoffMs;

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
    const statusNameById = {}; // id этапа → имя (нужно MOP Agent'у: ловим «разговор был, а статус „не дозвонились"»)
    const pr = await fetch(`${base}/leads/pipelines`, { headers: H });
    if (pr.ok) {
      const pd = await pr.json();
      for (const p of ((pd._embedded && pd._embedded.pipelines) || [])) {
        if (p.name === PIPELINE_ID_NAME) pipelineId = p.id;
        for (const st of ((p._embedded && p._embedded.statuses) || [])) statusNameById[st.id] = st.name;
      }
    }
    // ЗАЩИТА: без pipelineId фильтр по воронке не применится → метрики соберутся по чужим воронкам.
    // Прерываем, чтобы разовый сбой /pipelines не портил кэш speed.
    if (!pipelineId) { res.status(502).json({ error: "amoCRM: воронка не получена — sync-speed прерван, кэш не изменён" }); return; }

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
    // В debug-режиме берём только СЕГОДНЯШНИЕ события — иначе месячная выборка не укладывается в лимит времени.
    const evFrom = DEBUG_CALLS ? dayStart2 : monthStart;
    const evTypes2 = "outgoing_call";
    // ПОЛНОТА СОБЫТИЙ ЗВОНКОВ — критична: из них берётся счётчик calls, а на нём стоит детектор
    // «лид без единого звонка». Если amoCRM оборвёт выдачу (429/500) и мы просто выйдем из цикла,
    // у лидов с недокачанных страниц останется calls=0 — и агент обвинит МОПа в том, что тот НЕ
    // звонил, хотя звонки были, их просто не отдали. Поэтому любой обрыв фиксируем флагом,
    // а MOP Agent по такому прогону обязан молчать (см. гейт в mop-agent.js).
    let eventsTruncated = false;
    page = 1; guard = 0;
    while (guard < 120) {
      guard++;
      const url = `${base}/events?filter[type]=${evTypes2}` +
        `&filter[created_at][from]=${evFrom}&limit=250&page=${page}&order[created_at]=asc`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;               // 204 = данных больше нет → выборка ПОЛНАЯ
      if (!r.ok) { eventsTruncated = true; break; } // сбой API → данные НЕПОЛНЫЕ, звонки недосчитаны
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
    if (guard >= 120) eventsTruncated = true; // упёрлись в потолок страниц — событий больше, чем прочитали

    // 3b) Тянем события СМЕНЫ ОТВЕТСТВЕННОГО — чтобы знать, когда лид назначен на менеджера
    // (для метрики "первый звонок после назначения"). В debug не нужны — пропускаем ради скорости.
    page = 1; guard = 0;
    while (!DEBUG_CALLS && guard < 60) {
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

    // 3a) ЗВОНКИ С ДЛИТЕЛЬНОСТЬЮ — из notes каждого лида (надёжно, как /leads/{id}/notes).
    // Источник данных о звонках — ТОЛЬКО amoCRM API (ноты call_in/call_out, params.duration в сек).
    // Никаких вендор-специфичных интеграций телефонии: клиент сам настраивает свою телефонию так,
    // чтобы она передавала звонки в его amoCRM. Разговор дольше REACHED_SEC = реальный дозвон.
    // Тянем только по лидам, которые нам нужны (созданные сегодня + за месяц, где были звонки),
    // чтобы не перегружать: приоритет — сегодняшние лиды (для метрики «за сегодня»).
    const REACHED_SEC = cfg.reachedSec != null ? cfg.reachedSec : 40; // из конфига клиента, дефолт 40
    let notesSeen = 0, callNotesSeen = 0, reachedSet = 0;
    const dbgNotesByLead = {}; // lid -> [{ts, dur, type}] только за сегодня (только в debug)
    // собираем ID лидов, у которых были звонки (calls>0) — по ним проверяем длительность
    const leadIdsToCheck = Object.keys(leadInfo).filter(id => {
      const li = leadInfo[id];
      return li && li.calls > 0; // были звонки — есть смысл проверять дозвон
    });
    // ПРИОРИТЕТ проверки нот: лиды с активностью СЕГОДНЯ (звонили сегодня ИЛИ созданы сегодня).
    // Важно: старый лид, которого обзванивают сегодня, тоже нужен для метрики «За сегодня» —
    // иначе он окажется за лимитом, его ноты не прочитаются и дозвон за сегодня не засчитается
    // (симптом: «звонили 40, дозвон 8» — звонили из событий не капается, а reached из нот — да).
    const isTodayActive = (li) => (li.created || 0) >= dayStart2 || (li._callTs || []).some(ts => ts >= dayStart2);
    leadIdsToCheck.sort((a, b) => {
      const ta = isTodayActive(leadInfo[a]) ? 0 : 1;
      const tb = isTodayActive(leadInfo[b]) ? 0 : 1;
      return ta - tb;
    });
    const MAX_LEADS_CHECK = 600; // потолок, чтобы уложиться в лимит времени (сегодняшние — в начале)
    let toCheck = leadIdsToCheck.slice(0, MAX_LEADS_CHECK);
    // DEBUG: читаем ноты ТОЛЬКО по лидам нужного МОПа с сегодняшними звонками — иначе запрос не укладывается в лимит
    if (DEBUG_CALLS) {
      toCheck = Object.keys(leadInfo).filter((id) => {
        const li = leadInfo[id];
        const mn = ACTIVE_MOPS[li.resp];
        if (!mn || (DEBUG_MOP && mn !== DEBUG_MOP)) return false;
        return (li._callTs || []).some((ts) => ts >= dayStart2);
      });
    }
    // ЧТЕНИЕ НОТ — ПАРАЛЛЕЛЬНО, С ПУЛОМ И БЮДЖЕТОМ ВРЕМЕНИ.
    // История: раньше ноты тянулись строго по одной (600 лидов × ~0.4с ≈ 240с) — вместе с лидами
    // и событиями функция вылезала за лимит Vercel (300с), падала с 504 и НЕ ДОХОДИЛА до записи
    // кэша. Снаружи это выглядело как «метрики замерли»: дашборд и агенты часами читали старый
    // speed. Поэтому здесь два предохранителя:
    //   1) пул из NOTES_CONCURRENCY воркеров (amoCRM держит ~7 запросов/с — берём 6, с запасом);
    //   2) БЮДЖЕТ ВРЕМЕНИ: как только он исчерпан, чтение нот обрывается, но прогон продолжается
    //      и КЭШ ВСЁ РАВНО ЗАПИСЫВАЕТСЯ. Свежие данные с частично непрочитанными нотами лучше,
    //      чем 504 и вечно старый кэш. Сколько лидов не дочитали — видно в _callDiag.notesTruncated.
    const NOTES_CONCURRENCY = 6;
    const NOTES_BUDGET_MS = 150000; // 150с из 300с бюджета функции — остальное на лиды/события/запись
    const notesT0 = Date.now();
    let notesTruncated = 0;
    let qi = 0;

    const readLeadNotes = async (lid) => {
      const r = await fetch(`${base}/leads/${lid}/notes?limit=250`, { headers: H });
      if (!r.ok) return;
      const d = await r.json();
      const notes = (d._embedded && d._embedded.notes) || [];
      for (const n of notes) {
        notesSeen++;
        if (n.note_type !== "call_out" && n.note_type !== "call_in") continue;
        callNotesSeen++;
        const p = n.params || {};
        const dur = parseInt(p.duration != null ? p.duration : (p.DURATION || 0), 10) || 0;
        const nts = n.created_at || 0;
        // debug: копим сырые ноты звонков за сегодня (для сверки события звонка с длительностью)
        if (DEBUG_CALLS && nts >= dayStart2) {
          (dbgNotesByLead[lid] = dbgNotesByLead[lid] || []).push({ ts: nts, dur, type: n.note_type, callStatus: p.call_status != null ? String(p.call_status) : null });
        }
        if (dur >= REACHED_SEC) {
          leadInfo[lid].reachedReal = true; reachedSet++;
          if (nts >= dayStart2) leadInfo[lid].reachedRealToday = true; // реальный дозвон ИМЕННО сегодня (разговор ≥ REACHED_SEC)
        }
      }
    };

    const worker = async () => {
      while (qi < toCheck.length) {
        if (Date.now() - notesT0 > NOTES_BUDGET_MS) { notesTruncated = toCheck.length - qi; qi = toCheck.length; return; }
        const lid = toCheck[qi++];
        try { await readLeadNotes(lid); } catch (e) { /* пропускаем сбойный лид */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(NOTES_CONCURRENCY, toCheck.length) }, worker));
    const notesMs = Date.now() - notesT0;


    // === DEBUG-ВЫВОД: сверяем каждое событие звонка за сегодня с фактической нотой (длительностью) ===
    // Только по query-параметру и только для админа. В обычный ответ/кэш не попадает.
    if (DEBUG_CALLS) {
      const role = await sessionRole(redisUrl, redisToken, (req.query && req.query.session) || "");
      if (role !== "admin") { res.status(403).json({ error: "debug: admin only" }); return; }
      const hhmm = (ts) => new Date((ts + TZ_OFFSET2) * 1000).toISOString().slice(11, 16);
      const rows = [];
      const buckets = { noteMissing: 0, dur0: 0, s1_9: 0, s10_39: 0, s40plus: 0 };
      for (const id in leadInfo) {
        const L = leadInfo[id];
        const mopName = ACTIVE_MOPS[L.resp];
        if (!mopName) continue;
        if (DEBUG_MOP && mopName !== DEBUG_MOP) continue;
        const events = (L._callTs || []).filter((ts) => ts >= dayStart2).sort((a, b) => a - b);
        if (!events.length) continue;
        const notes = (dbgNotesByLead[id] || []).slice().sort((a, b) => a.ts - b.ts);
        const used = new Set();
        for (const ets of events) {
          // ищем ноту, ближайшую по времени к событию (окно ±5 мин)
          let bi = -1, bd = 1e9;
          notes.forEach((nt, i) => { if (used.has(i)) return; const d = Math.abs(nt.ts - ets); if (d < bd && d <= 300) { bd = d; bi = i; } });
          const note = bi >= 0 ? (used.add(bi), notes[bi]) : null;
          const dur = note ? note.dur : null;
          let verdict;
          if (!note) { verdict = "НЕТ НОТЫ — событие звонка есть, записи о разговоре нет (подозрение на баг стыковки телефонии)"; buckets.noteMissing++; }
          else if (dur === 0) { verdict = "0 сек — не взяли трубку"; buckets.dur0++; }
          else if (dur < 10) { verdict = `${dur} сек — сброс`; buckets.s1_9++; }
          else if (dur < REACHED_SEC) { verdict = `${dur} сек — короткий разговор (ниже порога ${REACHED_SEC}с)`; buckets.s10_39++; }
          else { verdict = `${dur} сек — ДОЗВОН (≥${REACHED_SEC}с)`; buckets.s40plus++; }
          rows.push({ leadId: Number(id), mop: mopName, callAtTashkent: hhmm(ets), eventTs: ets, noteFound: !!note, duration: dur, noteType: note ? note.type : null, callStatus: note ? note.callStatus : null, verdict });
        }
      }
      rows.sort((a, b) => a.eventTs - b.eventTs);
      const reachedLeads = new Set(rows.filter((r) => r.duration != null && r.duration >= REACHED_SEC).map((r) => r.leadId));
      const calledLeads = new Set(rows.map((r) => r.leadId));
      res.status(200).json({
        ok: true, debug: "calls", mop: DEBUG_MOP || "(все МОПы)", tashkentDay: new Date((dayStart2 + TZ_OFFSET2) * 1000).toISOString().slice(0, 10),
        reachedSecThreshold: REACHED_SEC,
        summary: { callEventsToday: rows.length, calledLeads: calledLeads.size, reachedLeads: reachedLeads.size, buckets },
        calls: rows,
      });
      return;
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
    // ── для MOP Agent: сырые факты по МОПам (расхождение статус/факт, лиды без звонка) ──
    const mopIssues = [];
    const NO_CONTACT_STAGES = new Set(cfg.noContactStages || []);
    const STALLED_NO_CALL_HOURS = cfg.stalledNoCallHours != null ? cfg.stalledNoCallHours : 4;
    // ДЕТЕКТОР ТЕЛЕФОНИИ (на КЛИЕНТА, не на МОПа персонально): лиды без единого звонка в amoCRM,
    // но с другой активностью в CRM (задача/закрытая задача/смена ответственного). Сигнал ВОЗМОЖНОЙ
    // проблемы телефонии на стороне клиента (звонят не через amoCRM / интеграция настроена не полностью).
    let telTotal = 0, telNoCallButActive = 0;

    for (const id in leadInfo) {
      const L = leadInfo[id];
      const mop = ACTIVE_MOPS[L.resp];
      if (!mop) continue;
      // исключаем "своих"
      if (L.status === SOLD_STATUS && L.price <= OWN_THRESHOLD) continue;
      const S = stat[mop];
      S.leads++;
      S.callsTotal += L.calls;
      // детектор телефонии: лид без звонка, но с другой CRM-активностью
      telTotal++;
      if ((L.calls || 0) === 0 && (((L.tasks || 0) > 0) || ((L.tasksDone || 0) > 0) || (Array.isArray(L._assignTs) && L._assignTs.length > 0))) telNoCallButActive++;
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
        if (L.reachedRealToday) D.reached++; // реальный дозвон СЕГОДНЯ (разговор ≥40 сек именно сегодня)
        if (L.reachedRealToday && L.tasks > 0) D.withTask++; // задачи только среди дозвонившихся сегодня
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
      // РЕАЛЬНЫЙ ДОЗВОН — только если был разговор ≥ REACHED_SEC (40 сек)
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
      // ═══ ПРОБЛЕМЫ ПО МОПам (для MOP Agent) — ТОЛЬКО ФАКТЫ, без оценок ═══
      {
        const stName2 = statusNameById[L.status] || "";
        const inNoContactStage = NO_CONTACT_STAGES.has(stName2);
        const lostAsNoReach = (L.status === LOST_STATUS) && (L.lossId === NO_REACH_REASON_ID);
        // 1) РАСХОЖДЕНИЕ СТАТУСА И ФАКТА: разговор ≥ порога БЫЛ, а лид всё ещё числится «не дозвонились»
        if (L.reachedReal && (inNoContactStage || lostAsNoReach)) {
          mopIssues.push({ type: "status_mismatch", mop, leadId: L.id, name: L.name || "",
            status: stName2 || "закрыт: не дозвонились" });
        }
        // 2) ЛИД БЕЗ ЕДИНОГО ЗВОНКА: в работе N+ часов, звонков ноль
        if (L.status !== SOLD_STATUS && L.status !== LOST_STATUS && (L.calls || 0) === 0 && L.created) {
          const hrs = Math.floor((nowSec2 - L.created) / 3600);
          if (hrs >= STALLED_NO_CALL_HOURS) {
            mopIssues.push({ type: "no_call", mop, leadId: L.id, name: L.name || "", hours: hrs, status: stName2 });
          }
        }
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
        fastFirstCalls: D.firstCallTimes.filter(mn => mn < 15).length, // быстрый 1-й звонок сегодня (для геймификации)
        firstCallTimesDay: D.firstCallTimes.map(x => Math.round(x)).slice(0, 300), // времена 1-го звонка (мин) по сегодняшним лидам — для SLA-счётчика
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

    // детектор телефонии на КЛИЕНТА: % лидов без звонка, но с активностью в CRM (сигнал возможной проблемы телефонии клиента)
    const telephony = { total: telTotal, noCallButActive: telNoCallButActive, noCallButActivePct: telTotal ? Math.round(telNoCallButActive / telTotal * 100) : 0 };
    // ДОЗВОН ПО ЛИДАМ (правильная метрика): сколько ЛИДОВ имели разговор ≥ REACHED_SEC.
    // ВАЖНО: reachedSet — это счётчик НОТ (каждый длинный звонок), а НЕ лидов. Раньше он отдавался
    // агентам как есть, они делили его на кол-во лидов и получали фантомные ~81% «дозвона».
    const reachedLeadsTotal = mops.reduce((s, m) => s + (m.reached || 0), 0);
    const leadsTotal = mops.reduce((s, m) => s + (m.leads || 0), 0);
    const reach = {
      leads: leadsTotal,
      reachedLeads: reachedLeadsTotal,
      reachedPct: leadsTotal ? Math.round(reachedLeadsTotal / leadsTotal * 100) : null,
      thresholdSec: REACHED_SEC,
      definition: "лид считается дозвонившимся, если был хотя бы один разговор длиннее порога (по нотам amoCRM)",
    };
    const result = {
      updatedAt: new Date().toISOString(), period: "Текущий месяц", mops, mopsDay,
      suspicious2: suspicious2.slice(0, 300), telephony,
      reach, // ← единственная корректная метрика дозвона по лидам
      mopIssues: mopIssues.slice(0, 400), // сырые факты по МОПам для MOP Agent (без суждений)
      // ПАСПОРТ ПОЛНОТЫ ДАННЫХ — едет вместе с фактами, а не в диагностике сбоку.
      // MOP Agent обязан на него смотреть ДО того, как заводить находку на человека:
      //  notesComplete=false  → reachedReal недосчитан → status_mismatch НЕДОСТОВЕРЕН (молчать)
      //  eventsComplete=false → calls недосчитан      → no_call НЕДОСТОВЕРЕН (молчать)
      // Правило простое: если система чего-то не успела прочитать — это не повод обвинять человека.
      mopMeta: {
        stalledNoCallHours: STALLED_NO_CALL_HOURS, reachedSec: REACHED_SEC,
        notesComplete: notesTruncated === 0,
        eventsComplete: !eventsTruncated,
        notesUnread: notesTruncated,
      },
      _callDiag: {
        notesSeen, callNotesSeen,
        longCallNotes: reachedSet, // ЯВНОЕ ИМЯ: это ЗВОНКИ ≥порога, а НЕ лиды
        _warning: "longCallNotes — счётчик ЗВОНКОВ, не лидов. НЕ делить на количество лидов. Дозвон по лидам — в поле reach.",
        // читаемость прогона: сколько лидов проверили на ноты, за сколько, и не оборвались ли по бюджету
        leadsChecked: toCheck.length - notesTruncated, leadsPlanned: toCheck.length,
        notesMs, notesTruncated,
        // если > 0 — часть лидов НЕ прочитана: дозвон и mopIssues занижены, но кэш свежий (это осознанный размен)
        _truncWarning: notesTruncated > 0
          ? `Бюджет чтения нот исчерпан: не дочитано ${notesTruncated} лид(ов). Дозвон и mopIssues занижены. Поднять NOTES_CONCURRENCY или сузить выборку.`
          : null,
      },
    };
    await redisSet(redisUrl, redisToken, K("speed"), JSON.stringify(result));
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "speed sync failed", detail: String(err) });
  }
}
