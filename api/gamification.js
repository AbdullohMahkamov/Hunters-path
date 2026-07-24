// /api/gamification.js — система геймификации МОПов (НОВЫЙ слой, ничего старого не трогает).
// Два слоя:
//   Слой 1 — баллы (копятся автоматически из метрик amoCRM) + один стандартный кейс с рулеткой.
//   Слой 2 — 12 уровней: макс +1 в календарный месяц, уровень никогда не падает, приз гарантирован каждому.
//
// Данные берутся из УЖЕ существующих кэшей (dashboard/speed), не собираются заново.
// Весь рандом кейса, списание баллов и повышение уровня — ТОЛЬКО здесь, на сервере.
//
// Хранилище (Upstash Redis):
//   gamification:config:${org}          → конфиг (баллы, кейс, 12 уровней, вкл/выкл). Дефолт при первом запуске.
//   gamification:mop:${org}:${mopId}    → { level, lastLevelMonth, carry, earnedMonth, pointsMonth, spent, inventory[], levelHistory[], caseHistory[] }

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// fetch с таймаутом и ретраем: подвисший коннект Upstash отваливается за timeoutMs и
// повторяется на новом (обычно здоровом), вместо зависания до убийства функции (~21с → 500 пусто).
async function rfetch(url, opts = {}, { timeoutMs = 3500, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } catch (e) {
      lastErr = e;
      if (attempt < retries) await new Promise(rs => setTimeout(rs, 150 * (attempt + 1)));
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}
async function redisGet(key) {
  const r = await rfetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json(); return d && d.result != null ? d.result : null;
}
async function redisSet(key, value) {
  await rfetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: typeof value === "string" ? value : JSON.stringify(value) });
}
async function getSession(session) {
  if (!session) return null;
  try { const raw = await redisGet(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function readCache(org) {
  const key = (org && org !== "hunter") ? `dashboard:${org}` : "dashboard";
  try { const raw = await redisGet(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function readSpeed(org) {
  const key = (org && org !== "hunter") ? `speed:${org}` : "speed";
  try { const raw = await redisGet(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

// ─────────────────────────── ДЕФОЛТНЫЙ КОНФИГ ───────────────────────────
const LEVEL_NAMES = ["Новобранец", "Боец", "Стрелок", "Охотник", "Следопыт", "Ветеран", "Мастер", "Элита", "Ас", "Хантер", "Легенда", "ТИТАН"];
// нормативы по бэндам: [дозвон%, конверсия%, задачи%, 1-й звонок ≤ мин, план%]
const BANDS = [
  { reach: 60, conv: 3.0, tasks: 70, call: 30, plan: 70 },   // ур. 1-3
  { reach: 65, conv: 4.0, tasks: 80, call: 20, plan: 85 },   // ур. 4-6
  { reach: 70, conv: 4.5, tasks: 85, call: 20, plan: 100 },  // ур. 7-9
  { reach: 75, conv: 5.0, tasks: 90, call: 15, plan: 100 },  // ур. 10-12
];
// призы по умолчанию (крупные на квартальных вехах 3/6/9/12)
const LEVEL_PRIZES = [
  { prizeName: "Стикерпак Altrone", prizeValue: 10000 },
  { prizeName: "Фирменная кружка", prizeValue: 30000 },
  { prizeName: "TWS-наушники", prizeValue: 150000 },
  { prizeName: "Ваучер 50 000", prizeValue: 50000 },
  { prizeName: "Пауэрбанк", prizeValue: 120000 },
  { prizeName: "Смарт-часы", prizeValue: 400000 },
  { prizeName: "Ваучер 100 000", prizeValue: 100000 },
  { prizeName: "Колонка JBL", prizeValue: 350000 },
  { prizeName: "AirPods", prizeValue: 900000 },
  { prizeName: "Ваучер 250 000", prizeValue: 250000 },
  { prizeName: "Смартфон", prizeValue: 2000000 },
  { prizeName: "iPhone", prizeValue: 6000000 },
];
function defaultConfig() {
  return {
    enabled: true,
    // баллы подобраны так, чтобы активный МОП за день набирал заметно больше цены кейса
    // (типичный день ≈ 2500–3500 баллов) → баллов хватает на 1–2 открытия в день.
    points: { reach: 50, fastCall: 40, taskDone: 20, dailyPlan: 60 }, // дозвон / скорость / задачи / план
    dailyPlanTarget: 3000000, // дневной план продаж (сум)
    firstCallMax: 30,         // SLA 1-го звонка (мин) — все новые лиды взять ≤ X мин
    taskGoal: 70,             // задачи за сегодня ≥ X% → балл
    dozvonCoef: 0.6,          // цель дозвона = взято_лидов × коэффициент (округл. вверх)
    freezeTime: "16:00",      // после этого времени (МСК) новые лиды не увеличивают цель дозвона
    calcTime: "18:00",        // в это время (МСК) дневные баллы фиксируются и зачисляются на баланс
    stickerCashback: 20,      // если из кейса выпал стикер/смайлик (ценность 0) → вернуть N баллов
    salesRewards: [           // продажи за месяц → бесплатные открытия кейса (3 порога)
      { sales: 5000000, opens: 1 },
      { sales: 10000000, opens: 3 },
      { sales: 20000000, opens: 7 },
    ],
    case: {
      price: 800,        // по карману на каждый день (настраивается)
      perDay: 2,         // сколько раз в день можно открыть (настраивается)
      image: "",         // URL фото кейса (если пусто — рисуем лут-кейс)
      items: [
        { name: "Стикер / кола / чипсы", chance: 30, value: 10000 },
        { name: "Кофе / обед", chance: 25, value: 25000 },
        { name: "Ваучер 30 000", chance: 20, value: 30000 },
        { name: "Ваучер 50 000", chance: 15, value: 50000 },
        { name: "Ваучер 100 000", chance: 10, value: 100000 },
      ],
    },
    levels: LEVEL_NAMES.map((name, i) => ({
      name,
      ...BANDS[Math.floor(i / 3)],
      prizeName: LEVEL_PRIZES[i].prizeName,
      prizeValue: LEVEL_PRIZES[i].prizeValue,
    })),
    updatedAt: new Date().toISOString(),
  };
}
async function getConfig(org) {
  const raw = await redisGet(`gamification:config:${org}`);
  if (raw) { try { const c = JSON.parse(raw); if (c && c.levels && c.case) return normalizeConfig(c); } catch (e) { /* ignore */ } }
  const def = defaultConfig();
  await redisSet(`gamification:config:${org}`, def);
  return def;
}
// защита от кривого конфига (недостающие поля → дефолты)
function normalizeConfig(c) {
  const d = defaultConfig();
  c.points = Object.assign({}, d.points, c.points || {});
  if (!c.dailyPlanTarget || c.dailyPlanTarget < 1) c.dailyPlanTarget = d.dailyPlanTarget;
  if (!c.firstCallMax || c.firstCallMax < 1) c.firstCallMax = d.firstCallMax;
  if (!c.taskGoal || c.taskGoal < 1) c.taskGoal = d.taskGoal;
  if (!c.dozvonCoef || c.dozvonCoef <= 0) c.dozvonCoef = d.dozvonCoef;
  if (!c.freezeTime) c.freezeTime = d.freezeTime;
  if (!c.calcTime) c.calcTime = d.calcTime;
  if (c.stickerCashback == null || c.stickerCashback < 0) c.stickerCashback = d.stickerCashback;
  if (!Array.isArray(c.salesRewards)) c.salesRewards = d.salesRewards;
  c.case = c.case || d.case;
  c.case.price = c.case.price || d.case.price;
  if (c.case.perDay == null || c.case.perDay < 1) c.case.perDay = d.case.perDay;
  if (!Array.isArray(c.case.items) || !c.case.items.length) c.case.items = d.case.items;
  if (!Array.isArray(c.levels) || c.levels.length !== 12) c.levels = d.levels;
  if (typeof c.enabled !== "boolean") c.enabled = true;
  return c;
}

// ─────────────────────────── МЕТРИКИ МОПА ───────────────────────────
// Дата в поясе Ташкента (UTC+5), как в остальном коде.
function nowTk() { return new Date(Date.now() + 5 * 3600 * 1000); }
function monthKey(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; }
function dateKey(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`; }
// текущее московское время (UTC+3) в минутах от полуночи — для заморозки цели дозвона
function nowMskMinutes() { const d = new Date(Date.now() + 3 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function parseFreezeMinutes(s) { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "16:00")); if (!m) return 16 * 60; return Math.min(1439, (parseInt(m[1], 10) || 0) * 60 + (parseInt(m[2], 10) || 0)); }
function workDaysPassed(d) {
  const y = d.getUTCFullYear(), mo = d.getUTCMonth(), day = d.getUTCDate();
  let wd = 0;
  for (let dd = 1; dd <= day; dd++) { if (new Date(Date.UTC(y, mo, dd)).getUTCDay() !== 0) wd++; } // пн-сб
  return wd;
}
// Собирает метрики одного МОПа из кэшей. Возвращает null если данных нет.
function mopMetrics(mopId, cache, speed, plans) {
  if (!cache || !cache.mopsBySales) return null;
  const bySales = (cache.mopsBySales || []).find(m => String(m.id) === String(mopId));
  const byConv = (cache.mopsByConv || []).find(m => String(m.id) === String(mopId));
  const sp = ((speed && speed.mops) || []).find(m => String(m.id != null ? m.id : m.name) === String(mopId));
  const spDay = ((speed && speed.mopsDay) || []).find(m => String(m.id != null ? m.id : m.name) === String(mopId));
  if (!bySales && !byConv) return null;
  const revenue = (bySales && bySales.revenue) || 0;
  const plan = (plans && plans[mopId]) || 0;
  return {
    // нормируемые метрики (для уровней) — из тех же источников, что видит МОП в кабинете
    leadsMonth: byConv && byConv.leads != null ? byConv.leads : ((bySales && bySales.leads) || 0), // лиды за месяц — для оценки типичного дня
    reachPct: byConv && byConv.reachPct != null ? byConv.reachPct : (bySales && bySales.reachPct) || 0,
    conv: byConv && byConv.conv != null ? byConv.conv : (bySales && bySales.conv) || 0,
    taskRate: sp && sp.taskRate != null ? sp.taskRate : 0,
    firstCallMin: sp && sp.medianFirstCallMin != null ? sp.medianFirstCallMin : null,
    planPct: plan > 0 ? Math.round(revenue / plan * 100) : 0,
    // счётчики (для баллов)
    reached: sp && sp.reached != null ? sp.reached : (bySales && bySales.reached) || 0,
    fastFirstCalls: sp && sp.fastFirstCalls != null ? sp.fastFirstCalls : 0,
    tasksDone: sp && sp.tasksDone != null ? sp.tasksDone : 0,
    tasksDonePct: sp && sp.tasksDonePct != null ? sp.tasksDonePct : 0,
    // сегодняшние счётчики (для ежедневного заработка)
    leadsToday: spDay && spDay.leads != null ? spDay.leads : 0,                 // взято новых лидов за сегодня (знаменатель дозвона)
    todayReached: spDay && spDay.reached != null ? spDay.reached : 0,           // дозвоны за сегодня (штук)
    firstCallTimesDay: (spDay && Array.isArray(spDay.firstCallTimesDay)) ? spDay.firstCallTimesDay : [], // времена 1-го звонка по сегодняшним лидам
    tasksTotalToday: spDay && spDay.tasksTotal != null ? spDay.tasksTotal : 0,  // задач поставлено сегодня
    tasksDoneToday: spDay && spDay.tasksDone != null ? spDay.tasksDone : 0,     // задач выполнено сегодня
    revenueToday: (bySales && bySales.revenueToday) || 0,
    revenue, plan,
  };
}
// Начислено баллов за ТЕКУЩИЙ месяц. reach/fast/task — из месячных агрегатов;
// dailyPlan/dailyConv — из счётчиков дней (накапливаются раз в день при выполнении).
function earnedPoints(m, cfg, st) {
  const p = cfg.points;
  return Math.round(
    (p.reach || 0) * (m.reached || 0) +
    (p.fastCall || 0) * (m.fastFirstCalls || 0) +
    (p.taskDone || 0) * (m.tasksDone || 0) +
    (p.dailyPlan || 0) * ((st && st.planDaysMonth) || 0) +
    (p.dailyConv || 0) * ((st && st.convDaysMonth) || 0)
  );
}

// ─────────────────────────── СОСТОЯНИЕ МОПА ───────────────────────────
function emptyState() {
  return { level: 0, lastLevelMonth: "", carry: 0, earnedMonth: 0, earnedDays: 0, earnedToday: 0, pointsMonth: "", spent: 0, bonus: 0, opensDay: "", opensToday: 0, dailyDay: "", planDaysMonth: 0, convDaysMonth: 0, callDaysMonth: 0, taskDaysMonth: 0, reachDaysMonth: 0, todayPlanAwarded: false, todayConvAwarded: false, todayCallAwarded: false, todayTaskAwarded: false, todayReachAwarded: false, freeOpens: 0, salesClaimedDay: "", salesClaimedTiers: [], dozvonDenom: 0, dozvonDenomDay: "", dozvonFrozen: false, todayCredited: false, creditedTodayValue: 0, inventory: [], levelHistory: [], caseHistory: [] };
}
async function getMopState(org, mopId) {
  const raw = await redisGet(`gamification:mop:${org}:${mopId}`);
  if (raw) { try { return Object.assign(emptyState(), JSON.parse(raw)); } catch (e) { /* ignore */ } }
  return emptyState();
}
async function saveMopState(org, mopId, st) {
  await redisSet(`gamification:mop:${org}:${mopId}`, st);
}
function balanceOf(st) { return Math.max(0, (st.carry || 0) + (st.earnedMonth || 0) + (st.bonus || 0) - (st.spent || 0)); }

// Экспорт для чат-советника: баллы/уровни всех МОПов org (то же, что action:"list_balances", без дублирования).
export async function getBalancesSummary(org) {
  org = org || "hunter";
  try {
    const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]").filter(a => (a.org || "hunter") === org);
    const out = [];
    for (const a of accounts) { const st = await getMopState(org, a.mopId); out.push({ name: a.name || a.login, balance: balanceOf(st), level: st.level || 0, earnedMonth: st.earnedMonth || 0 }); }
    return out;
  } catch (e) { return []; }
}

// Лента живых дропов отдела (для «forcedrop»-тикера).
async function getDrops(org) {
  const raw = await redisGet(`gamification:drops:${org}`);
  if (raw) { try { return JSON.parse(raw); } catch (e) { /* ignore */ } }
  return [];
}
async function pushDrop(org, entry) {
  const arr = await getDrops(org);
  arr.unshift(entry);
  await redisSet(`gamification:drops:${org}`, arr.slice(0, 30));
}
// Лог круток кейса (последние 1000) — только имя приза + время. Для Dev-Agent: сверка
// заданных шансов с фактическим распределением. Пишем write-only, поведение кейса не меняем.
async function pushSpin(org, name, value) {
  try {
    const raw = await redisGet(`gamification:spinlog:${org}`);
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift({ n: name, v: value || 0, at: Date.now() });
    await redisSet(`gamification:spinlog:${org}`, arr.slice(0, 1000));
  } catch (e) { /* ignore */ }
}
function bandNormsForLevel(cfg, level) {
  const idx = Math.min(12, Math.max(1, level)) - 1;
  return cfg.levels[idx];
}
function metricsMeetNorms(m, norms) {
  return (m.reachPct >= norms.reach) &&
    (m.conv >= norms.conv) &&
    (m.taskRate >= norms.tasks) &&
    (m.firstCallMin != null && m.firstCallMin <= norms.call) &&
    (m.planPct >= norms.plan);
}
// Пересчёт баллов + попытка поднять уровень для одного МОПа. Идемпотентно в пределах месяца.
function recomputeMop(st, m, cfg, mkey) {
  // ЕЖЕДНЕВНАЯ модель: считаем заработок за СЕГОДНЯ и банкуем по дням.
  const today = dateKey(nowTk());
  // При смене дня/месяца период уже завершён — банкуем весь заработок дня (план + остальное).
  const creditedYesterday = () => st.earnedToday || 0;
  // смена месяца → весь месяц в carry, сброс
  if (st.pointsMonth && st.pointsMonth !== mkey) {
    st.carry = (st.carry || 0) + (st.earnedDays || 0) + creditedYesterday();
    st.spent = 0;
    st.earnedDays = 0; st.earnedToday = 0; st.dailyDay = ""; st.todayCredited = false; st.creditedTodayValue = 0;
    st.planDaysMonth = 0; st.convDaysMonth = 0; st.callDaysMonth = 0; st.taskDaysMonth = 0; st.reachDaysMonth = 0;
    st.todayPlanAwarded = false; st.todayConvAwarded = false; st.todayCallAwarded = false; st.todayTaskAwarded = false; st.todayReachAwarded = false;
  }
  st.pointsMonth = mkey;
  // смена дня → банкуем вчерашний зачтённый день, обнуляем сегодня
  if (st.dailyDay !== today) {
    st.earnedDays = (st.earnedDays || 0) + creditedYesterday();
    st.earnedToday = 0; st.dailyDay = today; st.todayCredited = false; st.creditedTodayValue = 0;
    st.todayPlanAwarded = false; st.todayConvAwarded = false; st.todayCallAwarded = false; st.todayTaskAwarded = false; st.todayReachAwarded = false;
  }
  // 4 ДНЕВНЫЕ БИНАРНЫЕ ЦЕЛИ (по сегодняшним данным)
  const p = cfg.points;
  const coef = cfg.dozvonCoef || 0.6;
  const callSla = cfg.firstCallMax || 30;
  const taskGoalPct = cfg.taskGoal || 70;
  const planTarget = cfg.dailyPlanTarget || 3000000;

  // ── ДОЗВОН: цель = взято_лидов × коэф (округл. вверх); знаменатель замораживается после freezeTime ──
  if (st.dozvonDenomDay !== today) { st.dozvonDenomDay = today; st.dozvonDenom = 0; st.dozvonFrozen = false; }
  const freezeMin = parseFreezeMinutes(cfg.freezeTime);
  if (nowMskMinutes() < freezeMin) {
    st.dozvonDenom = m.leadsToday || 0;               // до заморозки — знаменатель растёт по факту
  } else if (!st.dozvonFrozen) {
    if ((st.dozvonDenom || 0) === 0) st.dozvonDenom = m.leadsToday || 0; // не успели снять до заморозки — берём текущее
    st.dozvonFrozen = true;                            // фиксируем
  }
  const dozvonGoal = Math.ceil((st.dozvonDenom || 0) * coef);
  const reachMet = dozvonGoal > 0 && (m.todayReached || 0) >= dozvonGoal;

  // ── СКОРОСТЬ: все новые лиды взяты в работу ≤ SLA минут ──
  const callWithin = (m.firstCallTimesDay || []).filter(t => t != null && t <= callSla).length;
  const speedMet = (m.leadsToday || 0) > 0 && callWithin >= (m.leadsToday || 0);

  // ── ЗАДАЧИ: выполнено ≥ порога от поставленных ──
  const taskPct = (m.tasksTotalToday || 0) > 0 ? (m.tasksDoneToday / m.tasksTotalToday * 100) : 0;
  const taskMet = (m.tasksTotalToday || 0) > 0 && taskPct >= taskGoalPct;

  // ── ПЛАН ──
  const planMet = (m.revenueToday || 0) >= planTarget;

  // ПЛАН (продажа) — свершившийся факт: зачисляем в баланс СРАЗУ.
  // ДОЗВОН/СКОРОСТЬ/ЗАДАЧИ — за день ещё меняются: зачисляем в calcTime (18:00 МСК).
  const planPts = planMet ? (p.dailyPlan || 0) : 0;
  const otherPts = (reachMet ? (p.reach || 0) : 0) + (speedMet ? (p.fastCall || 0) : 0) + (taskMet ? (p.taskDone || 0) : 0);
  st.earnedToday = Math.round(planPts + otherPts); // всего за сегодня (для «Сегодня набрано»)
  const calcMin = parseFreezeMinutes(cfg.calcTime || "18:00");
  const deferredIn = nowMskMinutes() >= calcMin;   // «отложенная» часть зачтена (после 18:00)
  st.todayCredited = deferredIn;
  // в балансе сегодня: план всегда + остальное только после 18:00
  st.creditedTodayValue = Math.round(planPts + (deferredIn ? otherPts : 0));
  st.earnedMonth = (st.earnedDays || 0) + (st.creditedTodayValue || 0);
  // ПРОДАЖИ ЗА СЕГОДНЯ → бесплатные открытия кейса (дневной лимит: не использовал — сгорели)
  if (st.salesClaimedDay !== today) { st.salesClaimedDay = today; st.salesClaimedTiers = []; st.freeOpens = 0; }
  const dayRev = m.revenueToday || 0;
  (cfg.salesRewards || []).forEach((tier, i) => {
    if (dayRev >= (tier.sales || 0) && !(st.salesClaimedTiers || []).includes(i)) {
      st.freeOpens = (st.freeOpens || 0) + (tier.opens || 0);
      st.salesClaimedTiers = st.salesClaimedTiers || [];
      st.salesClaimedTiers.push(i);
    }
  });

  // 2) уровень: макс +1 за календарный месяц, только вверх
  if ((st.level || 0) < 12 && st.lastLevelMonth !== mkey) {
    const target = (st.level || 0) + 1;
    const norms = cfg.levels[target - 1];
    if (metricsMeetNorms(m, norms)) {
      st.level = target;
      st.lastLevelMonth = mkey;
      const prize = {
        id: "lv" + Date.now() + Math.floor(Math.random() * 1000),
        type: "level", level: target, name: norms.prizeName, value: norms.prizeValue, image: norms.prizeImage || "",
        status: "pending", wonAt: new Date().toISOString(), month: mkey,
      };
      st.inventory = st.inventory || [];
      st.inventory.unshift(prize);
      st.levelHistory = st.levelHistory || [];
      st.levelHistory.unshift({ month: mkey, level: target, name: norms.prizeName });
    }
  }
  return st;
}

// ─────────────────────────── ВЗВЕШЕННЫЙ РАНДОМ (кейс) ───────────────────────────
function pickCasePrize(items) {
  const total = items.reduce((s, it) => s + (Number(it.chance) || 0), 0) || 1;
  let x = Math.random() * total;
  for (const it of items) { x -= (Number(it.chance) || 0); if (x <= 0) return it; }
  return items[items.length - 1];
}

// ─────────────────────────── HANDLER ───────────────────────────
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, max-age=0"); // никогда не кэшировать (цена/баланс всегда свежие)
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const action = (req.query && req.query.action) || (req.body && req.body.action);
  const isCron = req.query && req.query.cron === "1"; // Vercel cron дергает GET без сессии
  const sess = await getSession(session);

  try {
    // ── КРОН: пересчёт всех МОПов (без сессии) ──
    if (action === "recalc" && (isCron || (sess && sess.role === "admin"))) {
      const org = (sess && sess.org) || (req.query && req.query.org) || "hunter";
      const out = await recalcAll(org);
      res.status(200).json({ ok: true, ...out });
      return;
    }

    if (!sess) { res.status(403).json({ error: "no session" }); return; }
    const org = sess.org || "hunter";
    const cfg = await getConfig(org);

    // ══════════════ АДМИН ══════════════
    if (sess.role === "admin") {
      if (action === "get_config") { res.status(200).json({ ok: true, config: cfg }); return; }

      if (action === "reset_config") {
        const def = defaultConfig();
        await redisSet(`gamification:config:${org}`, def);
        res.status(200).json({ ok: true, config: def });
        return;
      }

      // сброс только экономики (баллы/цена/лимит) — призы, уровни и фото сохраняются
      if (action === "reset_economy") {
        const def = defaultConfig();
        cfg.points = def.points;
        cfg.case.price = def.case.price;
        cfg.case.perDay = def.case.perDay;
        cfg.updatedAt = new Date().toISOString();
        await redisSet(`gamification:config:${org}`, cfg);
        res.status(200).json({ ok: true, config: cfg });
        return;
      }

      if (req.method === "POST" && action === "set_config") {
        const incoming = req.body && req.body.config;
        if (!incoming) { res.status(400).json({ error: "no config" }); return; }
        const norm = normalizeConfig(Object.assign({}, cfg, incoming));
        // авто-нормализация шансов кейса к 100% — чтобы сохранение (цена/лимит/и т.д.) НИКОГДА не блокировалось
        if (norm.case && Array.isArray(norm.case.items) && norm.case.items.length) {
          const sum = norm.case.items.reduce((s, it) => s + (Number(it.chance) || 0), 0);
          if (sum <= 0) { const eq = Math.round(10000 / norm.case.items.length) / 100; norm.case.items.forEach(it => { it.chance = eq; }); }
          else if (Math.round(sum) !== 100) { norm.case.items.forEach(it => { it.chance = Math.round((Number(it.chance) || 0) / sum * 10000) / 100; }); }
        }
        norm.updatedAt = new Date().toISOString();
        await redisSet(`gamification:config:${org}`, norm);
        res.status(200).json({ ok: true, config: norm });
        return;
      }

      if (action === "list_inventory") {
        const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]").filter(a => (a.org || "hunter") === org);
        const list = [];
        for (const a of accounts) {
          const st = await getMopState(org, a.mopId);
          (st.inventory || []).forEach(it => list.push({ ...it, mopId: a.mopId, mopName: a.name || a.login }));
        }
        list.sort((x, y) => (x.status === y.status ? 0 : x.status === "pending" ? -1 : 1) || (new Date(y.wonAt) - new Date(x.wonAt)));
        res.status(200).json({ ok: true, inventory: list });
        return;
      }

      // список балансов всех МОПов
      if (action === "list_balances") {
        const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]").filter(a => (a.org || "hunter") === org);
        const balances = [];
        for (const a of accounts) {
          const st = await getMopState(org, a.mopId);
          balances.push({ mopId: a.mopId, mopName: a.name || a.login, balance: balanceOf(st), bonus: st.bonus || 0, earnedMonth: st.earnedMonth || 0, level: st.level || 0 });
        }
        res.status(200).json({ ok: true, balances });
        return;
      }

      // начислить (или списать, если отрицательное) баллы МОПу
      if (req.method === "POST" && action === "grant_points") {
        const { mopId, amount } = req.body || {};
        const amt = parseInt(amount, 10) || 0;
        if (!mopId || !amt) { res.status(200).json({ ok: false, error: "Укажите МОПа и число баллов" }); return; }
        const st = await getMopState(org, mopId);
        st.bonus = (st.bonus || 0) + amt;
        await saveMopState(org, mopId, st);
        res.status(200).json({ ok: true, balance: balanceOf(st) });
        return;
      }

      // обнулить баланс баллов МОПа
      if (req.method === "POST" && action === "zero_points") {
        const { mopId } = req.body || {};
        if (!mopId) { res.status(200).json({ ok: false, error: "no mopId" }); return; }
        const st = await getMopState(org, mopId);
        st.spent = (st.carry || 0) + (st.earnedMonth || 0); // спишем всё заработанное → баланс 0
        st.bonus = 0;                                        // бонус тоже 0
        st.freeOpens = 0;                                    // и бесплатные открытия
        await saveMopState(org, mopId, st);
        res.status(200).json({ ok: true, balance: balanceOf(st) });
        return;
      }

      // сбросить дневное состояние МОПа (открытия/лимит/бесплатные/цели дня)
      if (req.method === "POST" && action === "reset_day") {
        const { mopId } = req.body || {};
        if (!mopId) { res.status(200).json({ ok: false, error: "no mopId" }); return; }
        const st = await getMopState(org, mopId);
        st.opensToday = 0; st.opensDay = "";
        st.freeOpens = 0; st.salesClaimedDay = ""; st.salesClaimedTiers = [];
        st.dozvonDenom = 0; st.dozvonDenomDay = ""; st.dozvonFrozen = false;
        st.earnedToday = 0; st.dailyDay = "";
        st.todayPlanAwarded = false; st.todayConvAwarded = false; st.todayCallAwarded = false; st.todayTaskAwarded = false; st.todayReachAwarded = false;
        await saveMopState(org, mopId, st);
        res.status(200).json({ ok: true });
        return;
      }

      // очистить инвентарь МОПа
      if (req.method === "POST" && action === "clear_inventory") {
        const { mopId } = req.body || {};
        if (!mopId) { res.status(200).json({ ok: false, error: "no mopId" }); return; }
        const st = await getMopState(org, mopId);
        st.inventory = [];
        await saveMopState(org, mopId, st);
        res.status(200).json({ ok: true });
        return;
      }

      if (req.method === "POST" && action === "mark_delivered") {
        const { mopId, itemId } = req.body || {};
        const st = await getMopState(org, mopId);
        const it = (st.inventory || []).find(x => x.id === itemId);
        if (it) { it.status = "delivered"; it.deliveredAt = new Date().toISOString(); await saveMopState(org, mopId, st); }
        res.status(200).json({ ok: true });
        return;
      }
    }

    // ══════════════ МОП ══════════════
    const mopId = sess.role === "mop" ? sess.mopId : (req.query && req.query.mopId) || (req.body && req.body.mopId);

    if (action === "state") {
      if (!cfg.enabled) { res.status(200).json({ ok: true, enabled: false }); return; }
      if (!mopId) { res.status(400).json({ error: "no mopId" }); return; }
      const cache = await readCache(org), speed = await readSpeed(org);
      const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");
      const m = mopMetrics(mopId, cache, speed, plans);
      let st = await getMopState(org, mopId);
      if (m) {
        const before = st.level || 0;
        const snapBefore = JSON.stringify(st);          // ОПТИМИЗАЦИЯ: пишем в Redis только если recompute реально
        st = recomputeMop(st, m, cfg, monthKey(nowTk())); // что-то изменил (смена дня/месяца, зачёт в 18:00, левелап,
        if (JSON.stringify(st) !== snapBefore) await saveMopState(org, mopId, st); // freeOpens). Иначе поллинг = read-only.
        if ((st.level || 0) > before) {
          const lp = st.inventory[0];
          await pushDrop(org, { who: sess.mopName || mopId, name: lp.name, value: lp.value, image: lp.image, type: "level", level: st.level, at: lp.wonAt });
        }
      }
      const recentDrops = await getDrops(org);
      res.status(200).json({ ok: true, ...buildStatePayload(st, m, cfg), recentDrops });
      return;
    }

    if (req.method === "POST" && action === "open_case") {
      if (!cfg.enabled) { res.status(200).json({ ok: false, error: "Геймификация выключена" }); return; }
      if (!mopId) { res.status(400).json({ error: "no mopId" }); return; }
      // свежий пересчёт баллов перед списанием
      const cache = await readCache(org), speed = await readSpeed(org);
      const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");
      const m = mopMetrics(mopId, cache, speed, plans);
      let st = await getMopState(org, mopId);
      if (m) st = recomputeMop(st, m, cfg, monthKey(nowTk()));
      const price = cfg.case.price;
      const today = dateKey(nowTk());
      if (st.opensDay !== today) { st.opensDay = today; st.opensToday = 0; }
      const perDay = cfg.case.perDay || 2;
      const useFree = (st.freeOpens || 0) > 0;
      if (useFree) {
        st.freeOpens = st.freeOpens - 1; // бесплатное открытие за продажи — без лимита и без списания
      } else {
        if ((st.opensToday || 0) >= perDay) { res.status(200).json({ ok: false, error: "Лимит на сегодня исчерпан" }); return; }
        if (balanceOf(st) < price) { res.status(200).json({ ok: false, error: "Недостаточно баллов" }); return; }
        st.opensToday = (st.opensToday || 0) + 1;
        st.spent = (st.spent || 0) + price;
      }
      const prizeItem = pickCasePrize(cfg.case.items); // рандом ТОЛЬКО на сервере
      // стикер/смайлик (ценность 0) → кэшбек баллами
      const cashback = ((prizeItem.value || 0) <= 0) ? (cfg.stickerCashback || 0) : 0;
      if (cashback > 0) st.bonus = (st.bonus || 0) + cashback;
      const won = {
        id: "cs" + Date.now() + Math.floor(Math.random() * 1000),
        type: "case", name: prizeItem.name, value: prizeItem.value || 0, image: prizeItem.image || "", cashback,
        status: cashback > 0 ? "cashback" : "pending", wonAt: new Date().toISOString(),
      };
      st.inventory = st.inventory || [];
      st.inventory.unshift(won); // всё в инвентарь; стикеры — со статусом "cashback" (не требуют выдачи)
      st.caseHistory = st.caseHistory || [];
      st.caseHistory.unshift({ name: won.name, at: won.wonAt });
      if (st.caseHistory.length > 50) st.caseHistory = st.caseHistory.slice(0, 50);
      await saveMopState(org, mopId, st);
      await pushDrop(org, { who: sess.mopName || mopId, name: won.name, value: won.value, image: won.image, type: "case", at: won.wonAt });
      await pushSpin(org, won.name, won.value); // лог крутки для сверки шансов (Dev-Agent)
      res.status(200).json({ ok: true, prize: { name: won.name, value: won.value, image: won.image, cashback }, balance: balanceOf(st), opensLeft: Math.max(0, perDay - st.opensToday), freeOpens: st.freeOpens || 0 });
      return;
    }

    res.status(400).json({ error: "unknown action or no access" });
  } catch (e) {
    res.status(200).json({ ok: false, error: "Ошибка сервера: " + String(e).slice(0, 200) });
  }
}

// payload для кабинета МОПа
function buildStatePayload(st, m, cfg) {
  const level = st.level || 0;
  const next = level < 12 ? cfg.levels[level] : null; // нормы след. уровня (level — 0-based индекс следующего)
  const norms = next ? { reach: next.reach, conv: next.conv, tasks: next.tasks, call: next.call, plan: next.plan } : null;
  const progress = (m && norms) ? [
    { key: "reach", fact: m.reachPct, norm: norms.reach, met: m.reachPct >= norms.reach, unit: "%", higher: true },
    { key: "conv", fact: m.conv, norm: norms.conv, met: m.conv >= norms.conv, unit: "%", higher: true },
    { key: "tasks", fact: m.taskRate, norm: norms.tasks, met: m.taskRate >= norms.tasks, unit: "%", higher: true },
    { key: "call", fact: m.firstCallMin, norm: norms.call, met: m.firstCallMin != null && m.firstCallMin <= norms.call, unit: "min", higher: false },
    { key: "plan", fact: m.planPct, norm: norms.plan, met: m.planPct >= norms.plan, unit: "%", higher: true },
  ] : [];
  const metCount = progress.filter(p => p.met).length;
  const today = dateKey(nowTk());
  const perDay = cfg.case.perDay || 2;
  const opensToday = st.opensDay === today ? (st.opensToday || 0) : 0;
  return {
    enabled: true,
    level,
    levelName: level > 0 ? cfg.levels[level - 1].name : "",
    nextLevel: level < 12 ? level + 1 : null,
    nextLevelName: next ? next.name : null,
    lockedThisMonth: st.lastLevelMonth === monthKey(nowTk()),
    balance: balanceOf(st),
    earnedMonth: st.earnedMonth || 0,
    progress, metCount, normsCount: progress.length,
    levels: cfg.levels.map((l, i) => ({ n: i + 1, name: l.name, prizeName: l.prizeName, prizeValue: l.prizeValue, prizeImage: l.prizeImage || "", done: (i + 1) <= level, current: (i + 1) === level })),
    case: { price: cfg.case.price, items: cfg.case.items, perDay, image: cfg.case.image || "" },
    opensToday, opensLeft: Math.max(0, perDay - opensToday),
    points: cfg.points,
    dailyPlanTarget: cfg.dailyPlanTarget || 3000000,
    freeOpens: st.freeOpens || 0,
    salesRewards: cfg.salesRewards || [],
    firstCallMax: cfg.firstCallMax || 30,
    taskGoal: cfg.taskGoal || 70,
    dozvonCoef: cfg.dozvonCoef || 0.6,
    freezeTime: cfg.freezeTime || "16:00",
    calcTime: cfg.calcTime || "18:00",
    earnedTodayLive: st.earnedToday || 0,
    todayCredited: !!st.todayCredited,
    creditedNow: st.creditedTodayValue || 0,                                        // уже в балансе сегодня (план + остальное после 18:00)
    pendingCredit: Math.max(0, (st.earnedToday || 0) - (st.creditedTodayValue || 0)), // ждёт зачёта в 18:00
    maxPoints: (cfg.points.reach || 0) + (cfg.points.fastCall || 0) + (cfg.points.taskDone || 0) + (cfg.points.dailyPlan || 0),
    earn: m ? (() => {
      const coef = cfg.dozvonCoef || 0.6;
      const callSla = cfg.firstCallMax || 30;
      const taskGoalPct = cfg.taskGoal || 70;
      const tgt = cfg.dailyPlanTarget || 3000000;
      const denom = st.dozvonDenom || 0;
      const dozvonGoal = Math.ceil(denom * coef);
      const reached = m.todayReached || 0;
      // оценка типичного дня: месячные лиды / прошедшие рабочие дни (fallback 20)
      const wdp = workDaysPassed(nowTk());
      const estLeads = wdp > 0 && (m.leadsMonth || 0) > 0 ? Math.round(m.leadsMonth / wdp) : 20;
      const estGoal = Math.ceil(estLeads * coef);
      const callWithin = (m.firstCallTimesDay || []).filter(t => t != null && t <= callSla).length;
      const leads = m.leadsToday || 0;
      const tDone = m.tasksDoneToday || 0, tTotal = m.tasksTotalToday || 0;
      const taskPct = tTotal > 0 ? Math.round(tDone / tTotal * 100) : 0;
      const rev = m.revenueToday || 0;
      return {
        dozvon: { done: dozvonGoal > 0 && reached >= dozvonGoal, x: reached, y: dozvonGoal, denom, frozen: !!st.dozvonFrozen, remain: Math.max(0, dozvonGoal - reached), est: estGoal, estLeads, pts: cfg.points.reach || 0 },
        speed: { done: leads > 0 && callWithin >= leads, x: callWithin, y: leads, sla: callSla, remain: Math.max(0, leads - callWithin), pts: cfg.points.fastCall || 0 },
        task: { done: tTotal > 0 && taskPct >= taskGoalPct, x: tDone, y: tTotal, goalPct: taskGoalPct, remain: Math.max(0, Math.ceil(tTotal * taskGoalPct / 100) - tDone), pts: cfg.points.taskDone || 0 },
        plan: { done: rev >= tgt, cur: rev, target: tgt, remain: Math.max(0, tgt - rev), pts: cfg.points.dailyPlan || 0 },
      };
    })() : null,
    inventory: st.inventory || [],
    caseHistory: st.caseHistory || [],
  };
}

// Пересчёт всех зарегистрированных МОПов (крон/админ)
async function recalcAll(org) {
  const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]").filter(a => (a.org || "hunter") === org);
  const cfg = await getConfig(org);
  const cache = await readCache(org), speed = await readSpeed(org);
  const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");
  const mkey = monthKey(nowTk());
  let updated = 0, leveled = 0;
  for (const a of accounts) {
    const m = mopMetrics(a.mopId, cache, speed, plans);
    if (!m) continue;
    let st = await getMopState(org, a.mopId);
    const before = st.level || 0;
    st = recomputeMop(st, m, cfg, mkey);
    await saveMopState(org, a.mopId, st);
    updated++;
    if ((st.level || 0) > before) {
      leveled++;
      const lp = st.inventory[0];
      await pushDrop(org, { who: a.name || a.mopId, name: lp.name, value: lp.value, image: lp.image, type: "level", level: st.level, at: lp.wonAt });
    }
  }
  const chanceSum = (cfg.case.items || []).reduce((s, it) => s + (Number(it.chance) || 0), 0);
  return {
    updated, leveled, month: mkey, casePrice: cfg.case.price, perDay: cfg.case.perDay, dailyPlanTarget: cfg.dailyPlanTarget,
    chanceSum: Math.round(chanceSum * 100) / 100,
    caseItems: (cfg.case.items || []).map(it => ({ n: it.name, chance: it.chance, value: it.value })),
  };
}
