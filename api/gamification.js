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

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json(); return d && d.result != null ? d.result : null;
}
async function redisSet(key, value) {
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: typeof value === "string" ? value : JSON.stringify(value) });
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
  { prizeName: "Стикерпак Hunter", prizeValue: 10000 },
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
    points: { reach: 60, fastCall: 40, taskDone: 30, dailyPlan: 250, dailyConv: 150 },
    dailyPlanTarget: 3000000, // дневной план продаж (сум) для бонуса «закрыл дневной план»
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
  if (!bySales && !byConv) return null;
  const revenue = (bySales && bySales.revenue) || 0;
  const plan = (plans && plans[mopId]) || 0;
  return {
    // нормируемые метрики (для уровней) — из тех же источников, что видит МОП в кабинете
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
  return { level: 0, lastLevelMonth: "", carry: 0, earnedMonth: 0, pointsMonth: "", spent: 0, bonus: 0, opensDay: "", opensToday: 0, dailyDay: "", planDaysMonth: 0, convDaysMonth: 0, todayPlanAwarded: false, todayConvAwarded: false, inventory: [], levelHistory: [], caseHistory: [] };
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
  // 1) баллы: банкуем прошлый месяц в carry при смене месяца, затем считаем текущий
  if (st.pointsMonth && st.pointsMonth !== mkey) {
    st.carry = (st.carry || 0) + (st.earnedMonth || 0);
    st.spent = 0; // списания привязаны к месячному балансу; переносим только заработанное
    st.planDaysMonth = 0; st.convDaysMonth = 0; st.dailyDay = ""; st.todayPlanAwarded = false; st.todayConvAwarded = false;
  }
  st.pointsMonth = mkey;

  // дневные достижения — раз в день при выполнении (накапливаем за месяц)
  const today = dateKey(nowTk());
  if (st.dailyDay !== today) { st.dailyDay = today; st.todayPlanAwarded = false; st.todayConvAwarded = false; }
  if (!st.todayPlanAwarded && (m.revenueToday || 0) >= (cfg.dailyPlanTarget || 3000000)) { st.planDaysMonth = (st.planDaysMonth || 0) + 1; st.todayPlanAwarded = true; }
  const lvIdx = Math.min(11, Math.max(0, (st.level || 1) - 1));
  const convTarget = (cfg.levels[lvIdx] && cfg.levels[lvIdx].conv) || 3;
  if (!st.todayConvAwarded && (m.conv || 0) >= convTarget) { st.convDaysMonth = (st.convDaysMonth || 0) + 1; st.todayConvAwarded = true; }

  st.earnedMonth = earnedPoints(m, cfg, st);

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
        // валидация суммы шансов кейса = 100
        if (incoming.case && Array.isArray(incoming.case.items)) {
          const sum = incoming.case.items.reduce((s, it) => s + (Number(it.chance) || 0), 0);
          if (Math.round(sum) !== 100) { res.status(200).json({ ok: false, error: `Сумма шансов кейса = ${sum}%, должна быть 100%` }); return; }
        }
        const norm = normalizeConfig(Object.assign({}, cfg, incoming));
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
        st.bonus = (st.bonus || 0) - balanceOf(st); // текущий баланс → 0
        await saveMopState(org, mopId, st);
        res.status(200).json({ ok: true, balance: balanceOf(st) });
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
        st = recomputeMop(st, m, cfg, monthKey(nowTk()));
        await saveMopState(org, mopId, st);
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
      // дневной лимит открытий
      const today = dateKey(nowTk());
      if (st.opensDay !== today) { st.opensDay = today; st.opensToday = 0; }
      const perDay = cfg.case.perDay || 2;
      if ((st.opensToday || 0) >= perDay) { res.status(200).json({ ok: false, error: "Лимит на сегодня исчерпан" }); return; }
      if (balanceOf(st) < price) { res.status(200).json({ ok: false, error: "Недостаточно баллов" }); return; }
      st.opensToday = (st.opensToday || 0) + 1;
      st.spent = (st.spent || 0) + price;
      const prizeItem = pickCasePrize(cfg.case.items); // рандом ТОЛЬКО на сервере
      const won = {
        id: "cs" + Date.now() + Math.floor(Math.random() * 1000),
        type: "case", name: prizeItem.name, value: prizeItem.value || 0, image: prizeItem.image || "",
        status: "pending", wonAt: new Date().toISOString(),
      };
      st.inventory = st.inventory || [];
      st.inventory.unshift(won);
      st.caseHistory = st.caseHistory || [];
      st.caseHistory.unshift({ name: won.name, at: won.wonAt });
      if (st.caseHistory.length > 50) st.caseHistory = st.caseHistory.slice(0, 50);
      await saveMopState(org, mopId, st);
      await pushDrop(org, { who: sess.mopName || mopId, name: won.name, value: won.value, image: won.image, type: "case", at: won.wonAt });
      res.status(200).json({ ok: true, prize: { name: won.name, value: won.value, image: won.image }, balance: balanceOf(st), opensLeft: Math.max(0, perDay - st.opensToday) });
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
  return { updated, leveled, month: mkey };
}
