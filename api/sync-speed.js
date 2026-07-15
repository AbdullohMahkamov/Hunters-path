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
  // ЭТАПЫ ДЛЯ РАСЧЁТА % ДОЗВОНА — только ДЕФОЛТ. Правится из админ-панели (Redis), не в коде:
  // у каждого клиента своя структура воронки, и выбор этапов — настройка, а не задача разработчика.
  // Здесь: Yangi LID + Bog'lanib bo'lmadi + Bog'lanib bo'lmadi 2 (этапы «входа» в HunterAcademy).
  dozvonStages: [83475718, 83475726, 83475730],
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
  if (org === "hunter") {
    // Hunter: дефолты живут в коде, но КАЖДЫЙ параметр можно переопределить из админ-панели
    // (ключ metricscfg:hunter в Redis). Иначе настройку метрик у первого клиента пришлось бы
    // менять коммитом — а она должна меняться в два клика, как у любого другого клиента.
    const ov = await redisGetCfg(redisUrl, redisToken, "metricscfg:hunter");
    return { org, token: process.env.AMOCRM_TOKEN, ...HUNTER_CFG, ...(ov || {}) };
  }
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
    dozvonStages: Array.isArray(s.dozvonStages) ? s.dozvonStages : [], // этапы «входа» для % дозвона
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

  // === СПИСОК ЭТАПОВ ВОРОНКИ: ?action=stages&session=... (только админ) ===
  // Нужен, чтобы ВЫБРАТЬ этапы для dozvonStages, а не хардкодить их в коде.
  // У каждого клиента своя структура пайплайна, поэтому при онбординге выбор этапов — такая же
  // двухкликовая настройка в панели, как выбор финального этапа продажи. Этот эндпоинт её и кормит.
  // Лёгкий: один запрос в amoCRM, тяжёлый расчёт speed не запускается.
  if (((req.query && req.query.action) || "") === "stages") {
    const role = await sessionRole(redisUrl, redisToken, (req.query && req.query.session) || "");
    if (role !== "admin") { res.status(403).json({ error: "admin only" }); return; }
    const pr = await fetch(`${base}/leads/pipelines`, { headers: H });
    if (!pr.ok) { res.status(200).json({ ok: false, error: `amoCRM ответил ${pr.status}` }); return; }
    const pd = await pr.json();
    const pipelines = ((pd._embedded && pd._embedded.pipelines) || []).map((p) => ({
      id: p.id, name: p.name, isMain: p.is_main === true,
      statuses: ((p._embedded && p._embedded.statuses) || [])
        .sort((a, b) => (a.sort || 0) - (b.sort || 0))
        .map((s) => ({ id: s.id, name: s.name, sort: s.sort, type: s.type })), // type: 1 = успех, 2 = провал
    }));
    res.status(200).json({
      ok: true, org, pipelineInUse: PIPELINE_ID_NAME,
      dozvonStages: cfg.dozvonStages || [], // что выбрано сейчас (пусто = метрика не настроена)
      reachedSec: cfg.reachedSec != null ? cfg.reachedSec : 40,
      soldStatus: SOLD_STATUS, lostStatus: LOST_STATUS,
      pipelines,
    });
    return;
  }

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

    // ═══ ЖЁСТКИЙ ОБЩИЙ ДЕДЛАЙН ПРОГОНА ═══
    // Лимит функции на Vercel — 300с. Если мы в него не влезаем, нас убивают ДО записи кэша,
    // и наружу это выглядит как «метрики замерли» (так и случилось: кэш стоял 7 часов).
    // Правило: функция ОБЯЗАНА вернуться и записать кэш. Лучше свежие данные с честной отметкой
    // «выгружено не полностью» (по ней агенты молчат), чем 504 и вечно старый кэш.
    // Поэтому каждая фаза выгрузки проверяет дедлайн и прекращает добирать страницы.
    const RUN_T0 = Date.now();
    const HARD_BUDGET_MS = 235000; // 235с из 300с; остаток — на расчёты, запись в Redis и ответ
    const timeLeft = () => HARD_BUDGET_MS - (Date.now() - RUN_T0);
    const outOfTime = () => timeLeft() <= 0;
    const T = {}; // тайминги фаз (мс) — видно, куда реально уходит время
    let leadsTruncated = false, assignTruncated = false;

    // 2) Тянем ЛИДЫ месяца: id -> {created_at, responsible, status, price, lossId}
    const tLeads = Date.now();
    const leadInfo = {};
    let page = 1, guard = 0;
    while (guard < 80) {
      guard++;
      if (outOfTime()) { leadsTruncated = true; break; }
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
    T.leads = Date.now() - tLeads;
    T.leadsCount = Object.keys(leadInfo).length;

    // 2b) ПУЛ ДОЗВОНА — лиды, которые СЕЙЧАС стоят на этапах «входа» (dozvonStages).
    // Критично: пул определяется ТЕКУЩИМ ЭТАПОМ, а не датой создания. Лид, созданный в прошлом
    // месяце и до сих пор висящий в «Bog'lanib bo'lmadi», обязан быть в пуле — а месячная выгрузка
    // (filter[created_at][from]=monthStart) его не содержит. Поэтому тянем пул ОТДЕЛЬНО, по фильтру
    // статусов, без фильтра по дате, и доливаем в leadInfo.
    // Помечаем: _pool — в пуле; _poolOnly — пришёл ТОЛЬКО из пула (старше месяца) и потому НЕ должен
    // попадать в месячные агрегаты, иначе он исказит статистику за период.
    const DOZVON_STAGES = (cfg.dozvonStages || []).map(Number).filter(Boolean);
    const DZ_SET = new Set(DOZVON_STAGES);
    const tPool = Date.now();
    let poolTruncated = false, poolAdded = 0;
    const poolNowIds = [];
    const addPoolLead = (L) => {
      poolNowIds.push(String(L.id));
      if (leadInfo[L.id]) { leadInfo[L.id]._pool = true; return; } // лид этого месяца — уже есть
      leadInfo[L.id] = {                                            // лид старше месяца — доливаем
        id: L.id, name: L.name || "", created: L.created_at, resp: L.responsible_user_id,
        status: L.status_id, price: L.price || 0,
        lossId: (L.loss_reason_id != null ? L.loss_reason_id : null),
        firstCall: null, reachedReal: false, calls: 0, tasks: 0, tasksDone: 0,
        _pool: true, _poolOnly: true, // НЕ участвует в месячных агрегатах
      };
      poolAdded++;
    };
    if (DOZVON_STAGES.length && pipelineId) {
      page = 1; guard = 0;
      while (guard < 40) {
        guard++;
        if (outOfTime()) { poolTruncated = true; break; }
        const stFilter = DOZVON_STAGES
          .map((sid, i) => `filter[statuses][${i}][pipeline_id]=${pipelineId}&filter[statuses][${i}][status_id]=${sid}`)
          .join("&");
        const r = await fetch(`${base}/leads?limit=250&page=${page}&${stFilter}`, { headers: H });
        if (r.status === 204) break;
        if (!r.ok) { poolTruncated = true; break; } // сбой → пул неполный, метрике доверять нельзя
        const d = await r.json();
        const arr = (d._embedded && d._embedded.leads) || [];
        for (const L of arr) addPoolLead(L);
        if (arr.length < 250) break;
        page++;
        await new Promise(rs => setTimeout(rs, 150));
      }
      if (guard >= 40) poolTruncated = true;
    }

    // ═══ НАКОПИТЕЛЬНЫЙ ПУЛ ЗА ДЕНЬ ═══
    // Мгновенный срез «кто СЕЙЧАС на входе» даёт ОШИБКУ ВЫЖИВШЕГО: МОП дозвонился — и тут же
    // двинул карточку дальше. Лид покидает пул в момент УСПЕХА, и в срезе остаётся только осадок
    // из недозвонов (проверено на живых данных: 11% против реальных 45%).
    // Поэтому копим ОБЪЕДИНЕНИЕ всех срезов за день: лид, стоявший на входе в 09:00 и уехавший
    // дальше после разговора, остаётся в сегодняшнем пуле и честно считается дозвоном.
    const poolDayKey = K(`poolday:${new Date((dayStart2 + TZ_OFFSET2) * 1000).toISOString().slice(0, 10)}`);
    let poolSnapshots = 1;
    let dayPoolIds = new Set(poolNowIds);
    if (DOZVON_STAGES.length) {
      const prevRaw = await redisGetCfg(redisUrl, redisToken, poolDayKey);
      if (prevRaw && Array.isArray(prevRaw.ids)) {
        for (const id of prevRaw.ids) dayPoolIds.add(String(id));
        poolSnapshots = (prevRaw.snaps || 1) + 1;
      }
      // TTL 3 суток: ключ дневной, копить его вечно незачем
      await fetch(`${redisUrl}/set/${encodeURIComponent(poolDayKey)}?EX=259200`, {
        method: "POST", headers: { Authorization: `Bearer ${redisToken}` },
        body: JSON.stringify({ ids: [...dayPoolIds], snaps: poolSnapshots, at: Date.now() }),
      });
    }

    // Лиды из ранних срезов, которых уже нет ни на входе, ни в месячной выгрузке (старые, ушедшие
    // дальше) — догружаем по ID, иначе их сегодняшний дозвон потеряется.
    const missingIds = [...dayPoolIds].filter((id) => !leadInfo[id]);
    if (missingIds.length) {
      for (let i = 0; i < missingIds.length && !outOfTime(); i += 200) {
        const chunk = missingIds.slice(i, i + 200);
        const q = chunk.map((id) => `filter[id][]=${id}`).join("&");
        const r = await fetch(`${base}/leads?limit=250&${q}`, { headers: H });
        if (!r.ok) { poolTruncated = true; break; }
        const d = await r.json();
        for (const L of ((d._embedded && d._embedded.leads) || [])) addPoolLead(L);
      }
    }
    // помечаем принадлежность к ДНЕВНОМУ пулу (а не только к текущему срезу)
    for (const id of dayPoolIds) if (leadInfo[id]) leadInfo[id]._pool = true;

    T.pool = Date.now() - tPool;
    T.poolAdded = poolAdded;
    T.poolNow = poolNowIds.length;
    T.poolDay = dayPoolIds.size;

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
    const tCallEv = Date.now();
    page = 1; guard = 0;
    while (guard < 120) {
      guard++;
      if (outOfTime()) { eventsTruncated = true; break; } // не успели — честно помечаем неполноту
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
    T.callEvents = Date.now() - tCallEv;
    T.callEventPages = guard;

    // 3b) Тянем события СМЕНЫ ОТВЕТСТВЕННОГО — чтобы знать, когда лид назначен на менеджера
    // (для метрики "первый звонок после назначения"). В debug не нужны — пропускаем ради скорости.
    // Эта фаза — ВТОРОСТЕПЕННАЯ (нужна только для метрики «первый звонок после назначения»).
    // Она НЕ кормит детекторы MOP Agent, поэтому при нехватке времени жертвуем именно ей,
    // а не звонками: приоритет у данных, на которых строятся находки по людям.
    const tAssign = Date.now();
    page = 1; guard = 0;
    while (!DEBUG_CALLS && guard < 60) {
      guard++;
      if (outOfTime()) { assignTruncated = true; break; }
      const url = `${base}/events?filter[type]=entity_responsible_changed` +
        `&filter[created_at][from]=${monthStart}&limit=250&page=${page}&order[created_at]=asc`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) { assignTruncated = true; break; }
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
    T.assignEvents = Date.now() - tAssign;
    T.assignPages = guard;

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
    // ПОТОЛОК лидов для чтения нот. Раньше был 600 и служил защитой от таймаута — но ноты теперь
    // читаются пулом (26с на 600 лидов вместо ~240с), и от таймаута защищает БЮДЖЕТ ВРЕМЕНИ, а не
    // этот потолок. Оставляем его высоким — как предохранитель от патологического клиента.
    // ВАЖНО: если потолок всё же срежет лидов, это ТА ЖЕ неполнота, что и обрезка по времени —
    // reachedReal у срезанных не посчитан, дозвон занижен. Раньше паспорт этого НЕ ловил и врал
    // notesComplete=true, хотя 600 — это ровно потолок, а лидов со звонками было больше.
    const MAX_LEADS_CHECK = 3000;
    let toCheck = leadIdsToCheck.slice(0, MAX_LEADS_CHECK);
    const leadsCapped = leadIdsToCheck.length - toCheck.length; // > 0 → ноты прочитаны НЕ по всем
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
    // ⚠️ РЕЙТ-ЛИМИТ. Первая версия пула гнала 6 воркеров без пауз (~25+ запросов/с при лимите
    // amoCRM ~7/с). amoCRM отвечал 429, а код делал `if (!r.ok) return` — МОЛЧА выбрасывал лид.
    // Ноты не прочитаны → reachedReal не выставлен → дозвон занижен. И паспорт при этом врал
    // notesComplete=true, потому что считал только обрезку по времени, а не СБОИ.
    // Симптом был противоестественный: прочитали БОЛЬШЕ лидов (602 из 602) — а дозвон УПАЛ
    // (184 → 165). Чем быстрее гнали, тем больше данных теряли.
    // Поэтому: пейсим под лимит, ретраим 429/5xx, и КАЖДЫЙ невосстановимый сбой считаем неполнотой.
    const NOTES_CONCURRENCY = 6;
    const NOTES_TARGET_RPS = 6;                                    // ниже лимита amoCRM (~7/с)
    const GAP_MS = Math.ceil(1000 * NOTES_CONCURRENCY / NOTES_TARGET_RPS); // пауза на воркер
    const NOTES_BUDGET_MS = Math.max(0, timeLeft() - 15000);
    const notesT0 = Date.now();
    const sleep = (ms) => new Promise((rs) => setTimeout(rs, ms));
    let notesTruncated = 0, notesFailed = 0, notes429 = 0, notesRetried = 0, notesGone = 0;
    const notesFailStatus = {}; // код → сколько раз (чтобы не гадать, что именно сломалось)
    let qi = 0;

    const readLeadNotes = async (lid) => {
      let r = null;
      // до 3 попыток: 429 (рейт-лимит) и 5xx — восстановимые, ждём и повторяем
      for (let attempt = 0; attempt < 3; attempt++) {
        r = await fetch(`${base}/leads/${lid}/notes?limit=250`, { headers: H });
        if (r.ok || r.status === 204) break;
        if (r.status === 429 || r.status >= 500) {
          if (r.status === 429) notes429++;
          notesRetried++;
          const ra = parseInt(r.headers.get("retry-after") || "0", 10);
          await sleep(ra > 0 ? ra * 1000 : 800 * (attempt + 1)); // бэкофф
          continue;
        }
        break; // 4xx кроме 429 — повтор не поможет
      }
      // ЛИД УДАЛЁН (404/410) — это НЕ потеря данных, это лид, которого больше нет.
      // Разница принципиальна: «мы не смогли прочитать» → метрике верить нельзя (агент молчит);
      // «лида больше не существует» → его просто нет в знаменателе, метрика остаётся честной.
      // Без этого различия 2 удалённых лида из 604 глушили агента по всей метрике — это не
      // осторожность, а бесполезность: удаляют карточки регулярно, агент молчал бы всегда.
      if (r && (r.status === 404 || r.status === 410)) {
        notesGone++;
        if (leadInfo[lid]) leadInfo[lid]._gone = true; // исключаем из всех расчётов
        return;
      }
      if (!r || (!r.ok && r.status !== 204)) {         // настоящая потеря: 429/5xx исчерпаны, 403, сеть
        notesFailed++;
        if (r) notesFailStatus[r.status] = (notesFailStatus[r.status] || 0) + 1;
        return;
      }
      if (r.status === 204) return;
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
        const t0 = Date.now();
        try { await readLeadNotes(lid); } catch (e) { notesFailed++; } // сетевой сбой — тоже потеря, не молчим
        const spent = Date.now() - t0;
        if (spent < GAP_MS) await sleep(GAP_MS - spent); // держим совокупный темп ниже лимита amoCRM
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
      if (L._gone) continue; // лид удалён из amoCRM — не считаем ни в числителе, ни в знаменателе
      // Лид, долитый ТОЛЬКО ради пула дозвона (создан раньше текущего месяца), в месячные
      // агрегаты не входит — иначе статистика за период поедет: в неё попадут чужие периоды.
      if (L._poolOnly) continue;
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

    // ═══ % ДОЗВОНА ПО ЭТАПУ ВОРОНКИ (заменяет дневные метрики «по дате создания» / «по дате звонка») ═══
    // Пул = лиды, которые СЕЙЧАС на этапах входа (dozvonStages), любой давности.
    // Из пула: скольким звонили СЕГОДНЯ и скольким из них дозвонились (разговор ≥ reachedSec).
    // Лиды, ушедшие дальше по воронке, в метрику не входят вообще — даже если им сегодня звонили:
    // метрика мерит РАБОТУ НА ВХОДЕ, а не всю воронку.
    const dozvonByMop = {};
    const DZ = { pool: 0, calledToday: 0, reachedToday: 0 };
    for (const name of Object.values(ACTIVE_MOPS)) dozvonByMop[name] = { pool: 0, calledToday: 0, reachedToday: 0 };
    for (const id in leadInfo) {
      const L = leadInfo[id];
      if (!L._pool) continue;                     // не на этапах входа → метрика его не касается
      if (L._gone) continue;                      // лид удалён из amoCRM — не в знаменателе
      const mop = ACTIVE_MOPS[L.resp];
      if (!mop) continue;                         // лид без действующего МОПа (не разобран/уволенный)
      const calledToday = (L._callTs || []).some((ts) => ts >= dayStart2);
      const reachedToday = !!L.reachedRealToday;  // разговор ≥ порога ИМЕННО сегодня
      const B = dozvonByMop[mop];
      B.pool++; DZ.pool++;
      if (calledToday) { B.calledToday++; DZ.calledToday++; }
      if (reachedToday) { B.reachedToday++; DZ.reachedToday++; }
    }
    // ПОГРЕШНОСТЬ МЕТОДА — не на веру, а числом.
    // Пул собирается ЧАСОВЫМИ срезами, а не непрерывной записью. Лид, который между двумя
    // прогонами успел и появиться на входе, и уйти с него (МОП дозвонился и сразу двинул карточку),
    // не попадёт ни в один срез. Оцениваем такие случаи СВЕРХУ: лид создан сегодня, сегодня же
    // звонили, сейчас НЕ на входе и ни в одном срезе его не было.
    // Оценка именно верхняя: часть таких лидов могла вообще не стоять на выбранных этапах
    // (например, попасть сразу в «Неразобранное», которое в dozvonStages не входит).
    let poolMissedEstimate = 0;
    for (const id in leadInfo) {
      const L = leadInfo[id];
      if (L._pool) continue;
      if (!ACTIVE_MOPS[L.resp]) continue;
      if ((L.created || 0) < dayStart2) continue;                       // не сегодняшний — не судим
      if (!(L._callTs || []).some((ts) => ts >= dayStart2)) continue;   // сегодня не звонили
      if (DZ_SET.has(L.status)) continue;                               // всё ещё на входе (значит в пуле)
      poolMissedEstimate++;
    }

    const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);
    const dozvon = {
      // как настроено (видно в UI, чтобы цифра не была «магической»)
      stages: DOZVON_STAGES.map((sid) => ({ id: sid, name: statusNameById[sid] || String(sid) })),
      thresholdSec: REACHED_SEC,
      configured: DOZVON_STAGES.length > 0,
      // ГЛАВНАЯ ЦИФРА: из тех, кому сегодня звонили, — скольким дозвонились
      pool: DZ.pool, calledToday: DZ.calledToday, reachedToday: DZ.reachedToday,
      pct: pct(DZ.reachedToday, DZ.calledToday),          // % дозвона (из набранных)
      coveragePct: pct(DZ.calledToday, DZ.pool),          // % пула, который вообще набрали сегодня
      byMop: Object.entries(dozvonByMop).map(([name, b]) => ({
        name, pool: b.pool, calledToday: b.calledToday, reachedToday: b.reachedToday,
        pct: pct(b.reachedToday, b.calledToday), coveragePct: pct(b.calledToday, b.pool),
      })).sort((a, b) => b.pool - a.pool),
      // ── ЧЕСТНЫЙ ПАСПОРТ САМОГО МЕТОДА ──
      // Через месяц кто угодно (человек, Growth Agent, MOP Agent) увидит здесь ЯВНО:
      // это дискретная выборка, а не непрерывная запись. Расхождение в единицы процентов —
      // ожидаемая погрешность метода, а НЕ повод искать очередной баг.
      poolSampling: "hourly",
      poolSnapshots,                    // сколько срезов пула уже склеено за сегодня
      poolSize: dayPoolIds.size,        // размер накопленного дневного пула
      poolNow: poolNowIds.length,       // сколько стоит на входе прямо сейчас
      poolMissedEstimate,               // ВЕРХНЯЯ оценка лидов, проскочивших между срезами
      samplingNote: "Пул склеен из часовых срезов, а не из непрерывного отслеживания. Лид, успевший появиться на входе и уйти с него между двумя прогонами, в пул не попадает — poolMissedEstimate даёт верхнюю оценку таких случаев. Расхождение в единицы процентов — погрешность метода, не баг.",
      // полнота ДАННЫХ (отдельно от погрешности МЕТОДА)
      complete: !poolTruncated && notesTruncated === 0 && notesFailed === 0 && !eventsTruncated,
      poolTruncated,
      definition: "Пул — лиды, стоявшие на этапах входа в любой момент сегодня (склейка часовых срезов, любая давность лида). % дозвона = из тех, кому сегодня звонили, дозвонились (разговор ≥ порога).",
    };

    // ДЕТЕКТОР ТЕЛЕФОНИИ — теперь не «информационный сигнал», а ГЕЙТ.
    // 14.07.2026 подтверждено диагностикой: звонки, сделанные с ЛИЧНЫХ телефонов МОПов через
    // приложение «Мои Звонки», в amoCRM НЕ ПОПАДАЮТ ВООБЩЕ (проверено 26 звонков — 0 долетело;
    // все ноты в CRM оказались от Utel и принадлежали другим звонкам). Для системы такой звонок
    // не существует. Значит счётчик calls занижен, и детектор «лид без единого звонка» может
    // обвинить человека, который звонил — просто мимо CRM.
    // Этот детектор ровно об этом и сигналил (лид без звонков, но с активностью в CRM), но был
    // информационным и веса не имел. Теперь его показание — основание МОЛЧАТЬ.
    const telPct = telTotal ? Math.round(telNoCallButActive / telTotal * 100) : 0;
    const TEL_BYPASS_PCT = cfg.telephonyBypassPct != null ? cfg.telephonyBypassPct : 5;
    const telephony = {
      total: telTotal, noCallButActive: telNoCallButActive, noCallButActivePct: telPct,
      // ГЛАВНОЕ ПОЛЕ: подозрение, что звонки идут мимо CRM → метрикам звонков верить нельзя
      callsBypassSuspected: telPct >= TEL_BYPASS_PCT,
      thresholdPct: TEL_BYPASS_PCT,
      warning: telPct >= TEL_BYPASS_PCT
        ? `${telNoCallButActive} лид(ов) (${telPct}%) имеют активность в CRM, но НИ ОДНОГО звонка. Похоже, часть звонков идёт мимо amoCRM (личные телефоны / «Мои Звонки»). Метрика звонков ЗАНИЖЕНА, детектор «лид без звонка» отключён.`
        : null,
    };
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
      reach, // ← дозвон по лидам за МЕСЯЦ (по всем попыткам)
      dozvon, // ← % дозвона ПО ЭТАПУ ВОРОНКИ (настраивается в панели: dozvonStages)
      mopIssues: mopIssues.slice(0, 400), // сырые факты по МОПам для MOP Agent (без суждений)
      // ПАСПОРТ ПОЛНОТЫ ДАННЫХ — едет вместе с фактами, а не в диагностике сбоку.
      // MOP Agent обязан на него смотреть ДО того, как заводить находку на человека:
      //  notesComplete=false  → reachedReal недосчитан → status_mismatch НЕДОСТОВЕРЕН (молчать)
      //  eventsComplete=false → calls недосчитан      → no_call НЕДОСТОВЕРЕН (молчать)
      // Правило простое: если система чего-то не успела прочитать — это не повод обвинять человека.
      mopMeta: {
        stalledNoCallHours: STALLED_NO_CALL_HOURS, reachedSec: REACHED_SEC,
        // Полнота нот = не обрезаны по времени, не срезаны потолком, лиды докачаны И НИ ОДИН
        // запрос нот не провалился. Последнее — самое коварное: сбойный лид выглядит как лид
        // без разговора, то есть занижает дозвон и прячет status_mismatch. Любая из ЧЕТЫРЁХ дыр
        // → данные неполные → MOP Agent молчит, а не обвиняет человека.
        notesComplete: notesTruncated === 0 && leadsCapped === 0 && !leadsTruncated && notesFailed === 0,
        eventsComplete: !eventsTruncated && !leadsTruncated,
        notesUnread: notesTruncated + leadsCapped + notesFailed,
        leadsComplete: !leadsTruncated,
        // Звонки могут идти МИМО CRM (личные телефоны). Данные при этом «полные» с точки зрения
        // amoCRM — просто звонка там нет. Никакой паспорт полноты этого не поймает, поэтому
        // сигнал вынесен отдельным полем: по нему MOP Agent обязан молчать про «не звонил».
        callsBypassSuspected: telPct >= TEL_BYPASS_PCT,
        telephonyPct: telPct,
      },
      // КУДА УХОДИТ ВРЕМЯ — видно в ответе и в кэше. Без этого прогон падал с 504 «вслепую»:
      // функцию убивали до ответа, и ни одной цифры о причине наружу не попадало.
      _timings: { ...T, totalMs: Date.now() - RUN_T0, budgetMs: HARD_BUDGET_MS,
        truncated: { leads: leadsTruncated, callEvents: eventsTruncated, assignEvents: assignTruncated, notes: notesTruncated } },
      _callDiag: {
        notesSeen, callNotesSeen,
        longCallNotes: reachedSet, // ЯВНОЕ ИМЯ: это ЗВОНКИ ≥порога, а НЕ лиды
        _warning: "longCallNotes — счётчик ЗВОНКОВ, не лидов. НЕ делить на количество лидов. Дозвон по лидам — в поле reach.",
        // читаемость прогона: сколько лидов проверили на ноты, за сколько, и не оборвались ли по бюджету
        leadsChecked: toCheck.length - notesTruncated - notesFailed - notesGone, leadsPlanned: toCheck.length,
        leadsWithCalls: leadIdsToCheck.length, leadsCapped, // capped > 0 → потолок срезал лидов
        notesMs, notesTruncated,
        // сбои чтения нот: failed > 0 → дозвон ЗАНИЖЕН, доверять ему нельзя
        notesFailed, notes429, notesRetried, targetRps: NOTES_TARGET_RPS,
        notesFailStatus, // какие именно коды сломались — чтобы не гадать
        // удалённые лиды (404/410) — НЕ неполнота: их просто нет, они исключены из расчётов
        notesGone,
        // если > 0 — часть лидов НЕ прочитана: дозвон и mopIssues занижены, но кэш свежий (это осознанный размен)
        _truncWarning: (notesTruncated > 0 || notesFailed > 0 || leadsCapped > 0)
          ? `Ноты прочитаны НЕ полностью: бюджет ${notesTruncated}, сбои ${notesFailed} (429: ${notes429}), потолок ${leadsCapped}. Дозвон и mopIssues ЗАНИЖЕНЫ — MOP Agent по ним молчит.`
          : (notesGone > 0 ? `Удалённых лидов: ${notesGone} — исключены из расчётов. На полноту данных не влияет.` : null),
      },
    };
    await redisSet(redisUrl, redisToken, K("speed"), JSON.stringify(result));
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "speed sync failed", detail: String(err) });
  }
}
