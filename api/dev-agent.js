// /api/dev-agent.js — ВНУТРЕННИЙ агент-ревизор Hunter AI с постоянной памятью.
// Только для админа (основателя). НЕ клиентская фича. Он ПРЕДЛАГАЕТ — решает человек.
//
// ══════════════ ГРАНИЦЫ (жёстко, вне текущей версии НЕ реализуем даже частично) ══════════════
//  Агент МОЖЕТ: читать всё (read-only), писать ТОЛЬКО в devagent:*, слать сообщения основателю.
//  Агент НЕ МОЖЕТ и не будет: менять код, автодеплой, писать в продакшн-данные/таблицы клиентов,
//  дёргать вендоров телефонии. Фикс он отдаёт как ГОТОВЫЙ ПРОМПТ для Claude Code — человек вставляет
//  вручную. Автоматических действий над кодом/инфраструктурой/клиентскими данными — НЕТ.
//
// ИСТОЧНИК ДАННЫХ О ЗВОНКАХ — ТОЛЬКО amoCRM API (для всех клиентов). Никаких вендор-специфичных
// интеграций телефонии. call_count=0 в amoCRM принимается как данность; при подозрении агент лишь
// ПРЕДУПРЕЖДАЕТ о возможной проблеме телефонии НА СТОРОНЕ КЛИЕНТА, не обвиняя сотрудника.
//
// Компромиссы против ТЗ (serverless): git log+diff — через GitHub API (в функции нет git CLI);
// «объём звонков за 14 дней» — собственный ряд агента в devagent:series:* (снапшоты его не хранят);
// cron-аутентификация — Authorization: Bearer $CRON_SECRET (стандарт Vercel) с fallback ?cron=1.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";

const K = {
  findings: "devagent:findings", hypotheses: "devagent:hypotheses", decisions: "devagent:decisions",
  fixed: "devagent:fixed", chat: "devagent:chat", conflog: "devagent:conflog",
  config: "devagent:config", idmap: "devagent:idmap",
  quota: (d) => `devagent:quota:${d}`, series: (name, org) => `devagent:series:${name}:${org}`,
};
const CAP = { findings: 60, hypotheses: 60, decisions: 200, fixed: 120, chat: 240, conflog: 300, series: 30 };

// Пороги — НЕ хардкод: дефолты, переопределяются через админ-панель (devagent:config).
const DEFAULT_CONFIG = {
  noCallThreshold: 30,     // % лидов без звонка, но с активностью → suspicious (телефония клиента)
  callDropThreshold: 60,   // % обвала объёма звонков за день против среднего за 14 дней
  chatDailyLimit: 20,      // ручных сообщений в день (уведомление, не блокировка)
  nightlyDailyLimit: 1,    // плановых (cron) вызовов Claude в сутки
  minEvidenceConfirm: 3,   // минимум независимых наблюдений для статуса confirmed
  spinMinSample: 60,       // минимум круток кейса, чтобы судить о шансах
};

async function rget(key) {
  try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; }
}
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, value) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(value) }); return true; } catch (e) { return false; } }
async function rdel(key) { try { await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); } catch (e) {} }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

let _idc = 0;
function newId(p) { _idc++; return `${p}_${Date.now().toString(36)}_${_idc}`; }
function todayKey() { return new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10); } // МСК

async function getConfig() { const c = await rgetJSON(K.config, null); return { ...DEFAULT_CONFIG, ...(c || {}) }; }

// ── ОБЕЗЛИЧИВАНИЕ ──────────────────────────────────────────────────────────────────
// Реальные имена клиентов (org) и сотрудников (МОП) НИКОГДА не уходят в промпт к модели.
// Маппing real→alias хранится локально в devagent:idmap. Обезличиваем весь промпт целиком
// на границе вызова; вывод модели де-обезличиваем только для показа основателю.
async function listOrgs() {
  const clients = await rgetJSON("clients:list", []);
  const orgs = ["hunter"]; for (const c of (clients || [])) if (c && c.org && !orgs.includes(c.org)) orgs.push(c.org);
  return orgs;
}
async function listMopNames() {
  const accounts = await rgetJSON("mops:accounts", []);
  const names = new Set();
  for (const a of (accounts || [])) { if (a && a.name) names.add(String(a.name)); }
  return names;
}
async function buildIdMap() {
  const map = await rgetJSON(K.idmap, { orgs: {}, mops: {}, oc: 0, mc: 0 });
  map.orgs = map.orgs || {}; map.mops = map.mops || {}; map.oc = map.oc || 0; map.mc = map.mc || 0;
  const orgs = await listOrgs();
  for (const o of orgs) { if (!map.orgs[o]) { map.oc++; map.orgs[o] = `client_${map.oc}`; } }
  const mopNames = await listMopNames();
  // добавим имена МОПов из speed каждого org (на случай, если их нет в mops:accounts)
  for (const o of orgs) { const sp = await rgetJSON(o === "hunter" ? "speed" : `speed:${o}`, null); if (sp && Array.isArray(sp.mops)) for (const m of sp.mops) if (m && m.name) mopNames.add(String(m.name)); }
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const n of mopNames) { if (!map.mops[n]) { const a = map.mc < 26 ? alpha[map.mc] : `Z${map.mc}`; map.mc++; map.mops[n] = `mop_${a}`; } }
  await rsetJSON(K.idmap, map);
  return map;
}
function pairsLongestFirst(obj) { return Object.entries(obj).sort((a, b) => b[0].length - a[0].length); }
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function anonymize(str, map) {
  let s = String(str);
  for (const [real, alias] of pairsLongestFirst(map.orgs)) if (real && real !== "hunter") s = s.replace(new RegExp(escRe(real), "g"), alias);
  for (const [real, alias] of pairsLongestFirst(map.mops)) if (real) s = s.replace(new RegExp(escRe(real), "g"), alias);
  // hunter отдельно (короткое слово) — заменяем как отдельный org-идентификатор
  if (map.orgs.hunter) s = s.replace(/\bhunter\b/g, map.orgs.hunter);
  return s;
}
function deanonymize(str, map) {
  let s = String(str);
  const inv = {};
  for (const [real, alias] of Object.entries(map.orgs)) inv[alias] = real;
  for (const [real, alias] of Object.entries(map.mops)) inv[alias] = real;
  for (const [alias, real] of pairsLongestFirst(inv).map(([a, r]) => [a, r])) s = s.replace(new RegExp(escRe(alias), "g"), real);
  return s;
}

// ── ПАМЯТЬ ─────────────────────────────────────────────────────────────────────────
async function readMemory() {
  const [findings, hypotheses, decisions, fixed, chat] = await Promise.all([
    rgetJSON(K.findings, []), rgetJSON(K.hypotheses, []), rgetJSON(K.decisions, []), rgetJSON(K.fixed, []), rgetJSON(K.chat, []),
  ]);
  return { findings, hypotheses, decisions, fixed, chat };
}

// ── КОНКРЕТНЫЕ АГРЕГАТЫ (read-only, только amoCRM для звонков) ────────────────────────
function ageH(ts) { if (!ts) return null; const t = typeof ts === "string" ? Date.parse(ts) : (ts > 1e12 ? ts : ts * 1000); return t ? +(((Date.now() - t) / 3600000).toFixed(1)) : null; }
const okRange = (v, lo, hi) => v == null || (v >= lo && v <= hi);

async function gatherAggregates(cfg) {
  const orgs = await listOrgs();
  const perClient = [];
  const outOfRange = [];       // метрики вне логического диапазона
  const telephonySuspects = []; // клиенты с возможной проблемой телефонии
  const caseOdds = [];          // сверка шансов кейса с фактом
  const callVolume = [];        // объём звонков за сутки vs 14д (ряд агента)

  for (const org of orgs) {
    const kd = org === "hunter" ? "dashboard" : `dashboard:${org}`;
    const ks = org === "hunter" ? "speed" : `speed:${org}`;
    const [dash, speed, gcfg, spinlog] = await Promise.all([
      rgetJSON(kd, null), rgetJSON(ks, null), rgetJSON(`gamification:config:${org}`, null), rgetJSON(`gamification:spinlog:${org}`, []),
    ]);
    const c = { org, hasDash: !!dash, hasSpeed: !!speed };
    if (dash) { const t = dash.totals || {}; c.dashboard = { ageHours: ageH(dash.updatedAt), sold: t.sold, revenue: t.revenue, conv: t.conv, avgCheck: t.avgCheck, noContactPct: t.noContactPct, leads: t.leads };
      if (!okRange(t.conv, 0, 100)) outOfRange.push({ org, metric: "conv", value: t.conv });
      if (!okRange(t.noContactPct, 0, 100)) outOfRange.push({ org, metric: "noContactPct", value: t.noContactPct });
    }
    if (speed) {
      c.speed = { ageHours: ageH(speed.updatedAt), callDiag: speed._callDiag || null,
        today: (speed.mopsDay || []).map((m) => ({ name: m.name, leads: m.leads, reached: m.reached, reachedPct: m.reachedPct, called: m.calledLeads })) };
      // out-of-range по МОПам (дозвон>100, отрицательные значения и т.п.)
      for (const m of [...(speed.mops || []), ...(speed.mopsDay || [])]) {
        for (const [k, lo, hi] of [["reachedPct", 0, 100], ["reachPct", 0, 100], ["calledPct", 0, 100], ["tasksDonePct", 0, 100], ["medianFirstCallMin", 0, 1e6], ["reached", 0, 1e7], ["leads", 0, 1e7]]) {
          if (m[k] != null && !okRange(m[k], lo, hi)) outOfRange.push({ org, mop: m.name, metric: k, value: m[k] });
        }
      }
      // ДЕТЕКТОР ТЕЛЕФОНИИ (на клиента): % лидов без звонка, но с активностью
      if (speed.telephony && speed.telephony.total >= 20) {
        const pct = speed.telephony.noCallButActivePct;
        c.telephony = speed.telephony;
        if (pct >= cfg.noCallThreshold) telephonySuspects.push({ org, pct, total: speed.telephony.total, noCallButActive: speed.telephony.noCallButActive });
      }
      // ОБЪЁМ ЗВОНКОВ за сутки vs среднее за 14д — ведём собственный ряд в devagent:*
      const volToday = (speed.mopsDay || []).reduce((s, m) => s + (m.called || m.calledLeads || 0), 0);
      const series = await rgetJSON(K.series("callvol", org), []);
      const prev = series.filter((x) => x.date !== todayKey()).slice(-14);
      const avg = prev.length ? Math.round(prev.reduce((s, x) => s + x.vol, 0) / prev.length) : null;
      const dropPct = (avg != null && avg > 0) ? Math.round((1 - volToday / avg) * 100) : null;
      callVolume.push({ org, volToday, avg14: avg, samples: prev.length, dropPct, suspicious: dropPct != null && dropPct >= cfg.callDropThreshold });
      // записываем сегодняшнюю точку (перезапись за день — норм)
      const upd = series.filter((x) => x.date !== todayKey()); upd.push({ date: todayKey(), vol: volToday });
      await rsetJSON(K.series("callvol", org), upd.slice(-CAP.series));
    }
    // СВЕРКА ШАНСОВ КЕЙСА: заданные chance vs фактическое распределение (до 1000 круток)
    if (gcfg && gcfg.case && Array.isArray(gcfg.case.items) && Array.isArray(spinlog)) {
      const N = spinlog.length;
      if (N >= cfg.spinMinSample) {
        const obs = {}; for (const s of spinlog) obs[s.n] = (obs[s.n] || 0) + 1;
        const rows = gcfg.case.items.map((it) => { const got = obs[it.name] || 0; const actualPct = +(got / N * 100).toFixed(1); return { name: it.name, chance: it.chance, actualPct, delta: +(actualPct - it.chance).toFixed(1), n: got }; });
        const flagged = rows.filter((r) => Math.abs(r.delta) >= Math.max(5, r.chance * 0.4));
        caseOdds.push({ org, spins: N, rows, flagged });
      } else if (N > 0) {
        caseOdds.push({ org, spins: N, insufficient: true, note: `${N} круток, мало для суждения (нужно ≥${cfg.spinMinSample})` });
      }
    }
    perClient.push(c);
  }
  return { perClient, outOfRange, telephonySuspects, caseOdds, callVolume, orgsScanned: orgs.length };
}

// ── DATA TRUST LAYER ────────────────────────────────────────────────────────────────
// ЕДИНСТВЕННЫЙ интерфейс, через который Growth Agent (Агент Б) получает данные клиента.
// Возвращает воронку с trust-статусом каждого этапа/перехода: verified | suspicious | insufficient.
// Growth Agent имеет право строить гипотезу ТОЛЬКО на 'verified' переходах.
const MIN_LEADS_TRUST = 30; // мало лидов за период → insufficient
// история снимков (для динамики конверсии/чека по неделям) — те же snap:${date}, что пишет sync.js
async function readSnapHistory(org, days = 21) {
  const kl = org === "hunter" ? "snap:list" : `snap:list:${org}`;
  const dates = (await rgetJSON(kl, [])) || [];
  const recent = dates.slice(-days);
  const snaps = await Promise.all(recent.map((d) => rgetJSON(org === "hunter" ? `snap:${d}` : `snap:${d}:${org}`, null)));
  return snaps.filter(Boolean);
}
export async function getVerifiedFunnel(org) {
  const cfg = await getConfig();
  const kd = org === "hunter" ? "dashboard" : `dashboard:${org}`;
  const ks = org === "hunter" ? "speed" : `speed:${org}`;
  const [dash, speed, snaps] = await Promise.all([rgetJSON(kd, null), rgetJSON(ks, null), readSnapHistory(org)]);
  const t = (dash && dash.totals) || {};
  const leads = t.leads != null ? t.leads : null;
  const sold = t.sold != null ? t.sold : null;
  const revenue = t.revenue != null ? t.revenue : null;
  const avgCheck = t.avgCheck != null ? t.avgCheck : null;
  const avgCheckMedian = t.avgCheckMedian != null ? t.avgCheckMedian : null;
  const dealCycleDays = t.dealCycleMedianDays != null ? t.dealCycleMedianDays : null;
  const paidReceiptCount = t.paidReceiptCount != null ? t.paidReceiptCount : null;
  const called = speed && Array.isArray(speed.mops) ? speed.mops.reduce((s, m) => s + (m.calledLeads || 0), 0) : null;
  const reached = speed && Array.isArray(speed.mops) ? speed.mops.reduce((s, m) => s + (m.reached || 0), 0) : null;
  const tel = speed && speed.telephony;
  const telSuspicious = !!(tel && tel.total >= 20 && tel.noCallButActivePct >= cfg.noCallThreshold);
  const dashAge = dash ? ageH(dash.updatedAt) : null;
  const dataFresh = dashAge != null && dashAge < 48;
  const lowLeads = leads != null && leads < MIN_LEADS_TRUST;
  const pct = (a, b) => (a != null && b) ? +(a / b * 100).toFixed(1) : null;
  const minTrust = (x, y) => [x, y].includes("insufficient") ? "insufficient" : ([x, y].includes("suspicious") ? "suspicious" : "verified");
  const tLeads = leads == null ? "insufficient" : (lowLeads ? "insufficient" : "verified");
  const tCalled = telSuspicious ? "suspicious" : (called == null ? "insufficient" : (lowLeads ? "insufficient" : "verified"));
  const tReached = telSuspicious ? "suspicious" : (reached == null ? "insufficient" : (lowLeads ? "insufficient" : "verified"));
  const tSold = sold == null ? "insufficient" : (lowLeads ? "insufficient" : "verified");
  // деньги по этапам: до сделки денег нет, на сделке — выручка (бюджет+доплаты)
  const stages = [
    { stage: "Лиды", value: leads, money: null, trust: tLeads },
    { stage: "Звонили (набрали)", value: called, money: null, trust: tCalled, transitionFromPrev: { name: "лиды → обзвон", pct: pct(called, leads), trust: minTrust(tLeads, tCalled) } },
    { stage: "Дозвон (реальный разговор ≥40с)", value: reached, money: null, trust: tReached, transitionFromPrev: { name: "обзвон → дозвон", pct: pct(reached, called), trust: minTrust(tCalled, tReached) } },
    { stage: "Сделка выиграна (Sotildi)", value: sold, money: revenue, trust: tSold, transitionFromPrev: { name: "разговор → сделка", pct: pct(sold, reached), trust: minTrust(tReached, tSold) } },
    { stage: "Оплачено", value: null, money: null, trust: "insufficient", transitionFromPrev: { name: "сделка → оплата", pct: null, trust: "insufficient", note: "в amoCRM клиента нет отдельного поля/статуса оплаты — «выиграно» ≠ «оплачено». Инфо-сигнал: сделок с чеком To'lov cheki = " + (paidReceiptCount != null ? paidReceiptCount : "н/д") } },
  ];
  // ЯВНАЯ ТОЧКА МАКС. ОТТОКА — только среди verified-переходов (drop = 100 - конверсия перехода)
  let maxDropOff = null;
  for (const s of stages) { const tr = s.transitionFromPrev; if (tr && tr.trust === "verified" && tr.pct != null) { const drop = +(100 - tr.pct).toFixed(1); if (!maxDropOff || drop > maxDropOff.dropPct) maxDropOff = { transition: tr.name, toStage: s.stage, convPct: tr.pct, dropPct: drop }; } }
  const bottleneck = maxDropOff ? { stage: maxDropOff.toStage, transition: maxDropOff.transition, pct: maxDropOff.convPct } : null;
  const undiagnosable = stages.filter((s) => s.transitionFromPrev && s.transitionFromPrev.trust !== "verified")
    .map((s) => ({ transition: s.transitionFromPrev.name, trust: s.transitionFromPrev.trust, reason: s.transitionFromPrev.trust === "suspicious" ? "данные звонков ненадёжны (детектор телефонии клиента)" : "недостаточно данных за период" }));
  // ДИНАМИКА по snap-истории: конверсия и средний чек — раннее vs позднее окно (~2 недели)
  let dynamics = null;
  if (snaps.length >= 4) {
    const half = Math.floor(snaps.length / 2);
    const early = snaps.slice(0, half), late = snaps.slice(half);
    const avg = (arr, k) => { const v = arr.map((x) => x[k]).filter((x) => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null; };
    const mk = (k) => { const e = avg(early, k), l = avg(late, k); return (e != null && l != null) ? { from: e, to: l, delta: +(l - e).toFixed(1) } : null; };
    dynamics = { window: `${snaps.length} снимков`, conv: mk("conv"), avgCheck: mk("avgCheck"), avgCheckMedian: mk("avgCheckMedian"), trust: (telSuspicious ? "suspicious" : (lowLeads ? "insufficient" : "verified")) };
  }
  return {
    org, period: "текущий месяц", dataFresh, telephonySuspicious: telSuspicious,
    stages,
    avgCheck: { mean: avgCheck, median: avgCheckMedian, trust: tSold, note: "медиана устойчивее к редким крупным сделкам" },
    dealCycle: { companyMedianDays: dealCycleDays, byMop: (dash && dash.mopsByConv || []).map((m) => ({ name: m.name, days: m.dealCycleDays })).filter((x) => x.days != null), trust: tSold },
    ltv: { value: null, trust: "insufficient", note: "повторные продажи/LTV по контактам пока не считаются (нужна contact-группировка)" },
    paymentInfo: { paidReceiptCount, trust: "info", note: "справочно: сделки с приложенным чеком оплаты; не является trust-статусом «оплачено»" },
    maxDropOff, bottleneck, dynamics, undiagnosable,
    openStageDistribution: (dash && dash.velocity && dash.velocity.stages) ? dash.velocity.stages : null,
  };
}

// ── GIT LOG + DIFF по ключевым модулям (через GitHub API, read-only) ────────────────
const KEY_MODULE_RE = /(sync-speed|sync|dashboard|finance|gamification|dev-agent|user-data|mop|activity)\.js$/;
async function readGitLog(hours) {
  const repo = process.env.GITHUB_REPO || "AbdullohMahkamov/Hunters-path";
  const token = process.env.GITHUB_TOKEN || "";
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const headers = { "User-Agent": "hunter-devagent", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=40`, { headers });
    if (!r.ok) return { available: false, note: `GitHub API ${r.status}${token ? "" : " (нет GITHUB_TOKEN)"}`, commits: [] };
    const arr = await r.json();
    if (!Array.isArray(arr)) return { available: false, note: "unexpected", commits: [] };
    const commits = arr.map((c) => ({ sha: (c.sha || "").slice(0, 7), fullSha: c.sha, msg: (c.commit && c.commit.message || "").split("\n")[0], date: c.commit && c.commit.author && c.commit.author.date }));
    // diff по ключевым модулям — до 6 последних коммитов
    const keyDiffs = [];
    for (const c of commits.slice(0, 6)) {
      try {
        const d = await fetch(`https://api.github.com/repos/${repo}/commits/${c.fullSha}`, { headers });
        if (!d.ok) continue;
        const det = await d.json();
        for (const f of (det.files || [])) {
          if (!KEY_MODULE_RE.test(f.filename)) continue;
          keyDiffs.push({ sha: c.sha, file: f.filename, status: f.status, changes: `+${f.additions}/-${f.deletions}`, patch: (f.patch || "").slice(0, 700) });
        }
      } catch (e) { /* skip */ }
    }
    return { available: true, commits: commits.map((c) => ({ sha: c.sha, msg: c.msg, date: c.date })), keyDiffs: keyDiffs.slice(0, 12) };
  } catch (e) { return { available: false, note: String(e), commits: [] }; }
}

// ── СИСТЕМНЫЙ ПРОМПТ ────────────────────────────────────────────────────────────────
const SYSTEM = `Ты — технический ревизор Hunter AI, тиражируемого SaaS для аналитики отделов продаж на базе amoCRM (много клиентов). Твоя работа — находить проблемы в системе раньше, чем их найдёт клиент.

Работаешь с одним человеком — основателем. Он ждёт прямоты, а не вежливости. Неправ — скажи. Данных мало для вывода — скажи «не знаю». По-русски, коротко, без воды и лести.

ЖЁСТКИЕ ГРАНИЦЫ (ты их не нарушаешь даже частично): ты только ЧИТАЕШЬ и ПРЕДЛАГАЕШЬ. Никаких изменений кода, автодеплоя, записи в данные клиентов. Фикс — только как ГОТОВЫЙ ПРОМПТ для Claude Code, человек вставит сам.

ИСТОЧНИК ДАННЫХ О ЗВОНКАХ — ТОЛЬКО amoCRM. Если у клиента много лидов без звонка, но с другой активностью в CRM — это сигнал ВОЗМОЖНОЙ проблемы телефонии НА СТОРОНЕ КЛИЕНТА (звонят не через amoCRM / интеграция настроена не полностью). НИКОГДА не формулируй это как «сотрудник X не работает». Предлагай клиенту проверить настройки телефонии в его amoCRM.

ПРАВИЛА ПАМЯТИ:
- Гипотеза НЕ становится finding (confirmed) при менее чем 3 независимых наблюдениях (evidence). Меньше — статус остаётся гипотезой, и явно пиши «N наблюдений, недостаточно для подтверждения».
- Confidence растёт ТОЛЬКО с новыми evidence. Каждое изменение confidence — с полем "reason".
- Не повторяй то, что в 'fixed'; не переоткрывай отклонённое в 'decisions'.
- Не суди о людях по ненадёжным данным (suspicious/insufficient метрики).

Все идентификаторы уже обезличены (client_N, mop_A) — так и оперируй ими.

ФОРМАТ — строго JSON, без markdown и текста вокруг:
{
  "findings":[{"id","claim","confidence":0..1,"status":"confirmed","evidence":["..."],"source":"...","reason":"..."}],
  "hypotheses":[{"id","claim","confidence":0..1,"status":"testing|needs_data|likely|rejected","evidence":["..."],"source":"...","reason":"..."}],
  "questions_for_human":["..."],
  "report":"краткий отчёт (5-12 строк, важное сверху)",
  "suggested_prompts":[{"title":"...","prompt":"готовый самодостаточный промпт для Claude Code: файл, что менять, как проверить"}]
}
Сохраняй существующие id при обновлении; для новых id оставь пустым.`;

function buildNightlyContent({ memory, agg, git, weekly }) {
  if (weekly) {
    return `РЕЖИМ: НЕДЕЛЬНАЯ РЕВИЗИЯ ПАМЯТИ (отдельный отчёт, НЕ обычный ночной анализ).
Вот вся твоя память целиком:
findings: ${JSON.stringify(memory.findings)}
hypotheses: ${JSON.stringify(memory.hypotheses)}
decisions: ${JSON.stringify(memory.decisions)}
fixed: ${JSON.stringify(memory.fixed.map((f) => f.claim || f))}

Свежие агрегаты для сверки: ${JSON.stringify(agg)}

Ответь на вопросы ревизии:
1. Какие из твоих находок ПРОТИВОРЕЧАТ друг другу?
2. Какие основаны на данных, которые с тех пор ИЗМЕНИЛИСЬ?
3. Что понизить в confidence или УДАЛИТЬ (status:"rejected", reason)?
Верни JSON того же формата. report — это отчёт по ревизии, не по новым проблемам.`;
  }
  return `ТВОЯ ПАМЯТЬ:
findings: ${JSON.stringify(memory.findings)}
hypotheses: ${JSON.stringify(memory.hypotheses)}
decisions (решения человека): ${JSON.stringify(memory.decisions.slice(-30))}
fixed (уже исправлено): ${JSON.stringify(memory.fixed.map((f) => f.claim || f))}

АГРЕГАТЫ ЗА СУТКИ (конкретные источники):
1) Кейсы — заданные шансы vs факт: ${JSON.stringify(agg.caseOdds)}
2) Звонки (только amoCRM) — объём за сутки vs среднее за 14д: ${JSON.stringify(agg.callVolume)}
3) Метрики МОПов вне логического диапазона: ${JSON.stringify(agg.outOfRange)}
4) Клиенты с возможной проблемой телефонии (% лидов без звонка, но с активностью > порога): ${JSON.stringify(agg.telephonySuspects)}
   (это сигнал на СТОРОНЕ КЛИЕНТА, не повод обвинять сотрудника)
5) Обзор по клиентам: ${JSON.stringify(agg.perClient)}

ИЗМЕНЕНИЯ В КОДЕ за 24ч:
commits: ${git.available ? JSON.stringify(git.commits) : "(git недоступен: " + git.note + ")"}
diff по ключевым модулям (расчёт метрик, ролл кейса, парсинг конфигов): ${git.available ? JSON.stringify(git.keyDiffs) : "—"}

ЗАДАЧА:
1. Проверь висящие гипотезы — данные подтверждают/опровергают? Двигай confidence только с evidence (+reason). Помни правило ≥3 наблюдений для confirmed.
2. Найди новое: аномалии, противоречия, метрики, которые не сходятся.
3. Проверь, не сломали ли вчерашние коммиты работавшее (смотри diff по ключевым модулям).
4. Задай вопросы, если данных не хватает.
Верни строго JSON.`;
}

async function callModel(system, userContent, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Anthropic ${r.status}: ${t.slice(0, 300)}`); }
  const d = await r.json(); const u = d.usage || {};
  return { text: (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim(), tokens: (u.input_tokens || 0) + (u.output_tokens || 0) };
}
function parseJSON(text) { let t = text.replace(/```json/gi, "").replace(/```/g, "").trim(); const s = t.indexOf("{"), e = t.lastIndexOf("}"); if (s >= 0 && e > s) t = t.slice(s, e + 1); return JSON.parse(t); }

function mergeMemoryList(prevList, newList, kind, conflog, fixedClaims, rejectedClaims, minEvidence) {
  const prevById = {}; for (const p of prevList) if (p && p.id) prevById[p.id] = p;
  const out = [];
  for (const it of (newList || [])) {
    if (!it || !it.claim) continue;
    const claimLc = String(it.claim).toLowerCase();
    if (fixedClaims.has(claimLc) || rejectedClaims.has(claimLc)) continue;
    let id = it.id && prevById[it.id] ? it.id : (it.id || newId(kind));
    const prev = prevById[id];
    const conf = typeof it.confidence === "number" ? Math.max(0, Math.min(1, it.confidence)) : (prev ? prev.confidence : 0.3);
    const evidence = Array.isArray(it.evidence) ? it.evidence.slice(0, 12) : (prev ? prev.evidence : []);
    let status = it.status || (prev && prev.status) || (kind === "finding" ? "confirmed" : "testing");
    let reason = it.reason || (prev && prev.reason) || "";
    // ПРАВИЛО: confirmed требует ≥ minEvidence независимых наблюдений
    if (status === "confirmed" && evidence.length < minEvidence) {
      status = "likely";
      reason = `${evidence.length} наблюдений, недостаточно для подтверждения (нужно ≥${minEvidence}). ${reason}`.trim();
    }
    if (prev && typeof prev.confidence === "number" && Math.abs((prev.confidence || 0) - conf) >= 0.01)
      conflog.push({ id, kind, from: prev.confidence, to: conf, reason: it.reason || "(без причины)", at: Date.now() });
    out.push({ id, claim: it.claim, confidence: conf, status, evidence, source: it.source || (prev && prev.source) || "nightly", reason, created: prev ? prev.created : Date.now(), updated: Date.now() });
  }
  return out;
}

async function pushChat(role, text, meta) {
  const chat = await rgetJSON(K.chat, []);
  chat.push({ id: newId("m"), role, text: text || "", ...(meta || {}), at: Date.now() });
  await rsetJSON(K.chat, chat.slice(-CAP.chat));
}

async function bumpQuota(field) { const key = K.quota(todayKey()); const q = await rgetJSON(key, { nightly: 0, chat: 0 }); q[field] = (q[field] || 0) + 1; await rsetJSON(key, q); return q; }
async function getQuota() { return await rgetJSON(K.quota(todayKey()), { nightly: 0, chat: 0 }); }

// ── НОЧНОЙ ПРОГОН / НЕДЕЛЬНАЯ РЕВИЗИЯ ────────────────────────────────────────────────
async function runNightly(mode, viaCron) {
  const cfg = await getConfig();
  // лимит плановых (cron) вызовов: не более nightlyDailyLimit в сутки — уведомление, не блокировка
  if (viaCron) {
    const q = await getQuota();
    if ((q.nightly || 0) >= cfg.nightlyDailyLimit) { return { ok: false, skipped: true, reason: "плановый лимит вызовов на сегодня исчерпан" }; }
  }
  const map = await buildIdMap();
  const memory = await readMemory();
  const agg = await gatherAggregates(cfg);
  const git = await readGitLog(mode === "weekly" ? 24 * 7 : 24);
  const rawContent = buildNightlyContent({ memory, agg, git, weekly: mode === "weekly" });
  const content = anonymize(rawContent, map); // реальные имена НЕ уходят в модель
  const { text, tokens } = await callModel(SYSTEM, content, 8000);
  await bumpQuota("nightly");
  let out; try { out = parseJSON(text); } catch (e) {
    await pushChat("agent", `Прогон: не смог разобрать ответ модели в JSON.\n\n${deanonymize(text, map).slice(0, 4000)}`, { kind: mode === "weekly" ? "weekly" : "nightly", tokens });
    return { ok: false, error: "parse_failed" };
  }
  const conflog = await rgetJSON(K.conflog, []);
  const fixedClaims = new Set((memory.fixed || []).map((f) => String(f.claim || f).toLowerCase()));
  const rejectedClaims = new Set((memory.decisions || []).filter((d) => d.verdict === "rejected").map((d) => String(d.claim || "").toLowerCase()));
  let findings = mergeMemoryList(memory.findings, out.findings, "finding", conflog, fixedClaims, rejectedClaims, cfg.minEvidenceConfirm);
  let hypotheses = mergeMemoryList(memory.hypotheses, out.hypotheses, "hyp", conflog, fixedClaims, rejectedClaims, cfg.minEvidenceConfirm);
  // элементы, не дотянувшие до confirmed, переезжают из findings в hypotheses
  const demoted = findings.filter((f) => f.status !== "confirmed");
  findings = findings.filter((f) => f.status === "confirmed");
  hypotheses = [...demoted, ...hypotheses].slice(0, CAP.hypotheses);
  findings = findings.slice(0, CAP.findings);
  await Promise.all([rsetJSON(K.findings, findings), rsetJSON(K.hypotheses, hypotheses), rsetJSON(K.conflog, conflog.slice(-CAP.conflog))]);
  const report = deanonymize((out.report || "Прогон завершён.").trim(), map);
  const questions = (Array.isArray(out.questions_for_human) ? out.questions_for_human : []).map((q) => deanonymize(q, map));
  const prompts = (Array.isArray(out.suggested_prompts) ? out.suggested_prompts.slice(0, 8) : []).map((p) => ({ title: deanonymize(p.title || "Фикс", map), prompt: deanonymize(p.prompt || "", map) }));
  await pushChat("agent", report, { kind: mode === "weekly" ? "weekly" : "nightly", tokens, questions, suggested_prompts: prompts, stats: { findings: findings.length, hypotheses: hypotheses.length, outOfRange: agg.outOfRange.length, telephonySuspects: agg.telephonySuspects.length } });
  return { ok: true, report, findings: findings.length, hypotheses: hypotheses.length, questions, suggested_prompts: prompts, tokens };
}

// ── ДНЕВНАЯ ПЕРЕПИСКА ────────────────────────────────────────────────────────────────
async function runChat(userText) {
  const cfg = await getConfig();
  const map = await buildIdMap();
  const q = await getQuota();
  const overLimit = (q.chat || 0) >= cfg.chatDailyLimit; // уведомление, НЕ блокировка
  await pushChat("human", userText);
  const memory = await readMemory();
  const agg = await gatherAggregates(cfg);
  const history = (await rgetJSON(K.chat, [])).slice(-20).map((m) => `${m.role === "human" ? "ОСНОВАТЕЛЬ" : "АГЕНТ"}: ${m.text}`).join("\n");
  const sys = SYSTEM + `\n\nСЕЙЧАС: живой диалог с основателем (не ночной прогон). Отвечай ТЕКСТОМ (не JSON), прямо и по делу. Опирайся на память и данные. Если предлагаешь фикс — дай готовый промпт для Claude Code прямо в ответе (в блоке \`\`\`).`;
  const rawContent = `ТВОЯ ПАМЯТЬ:\nfindings: ${JSON.stringify(memory.findings)}\nhypotheses: ${JSON.stringify(memory.hypotheses)}\ndecisions: ${JSON.stringify(memory.decisions.slice(-20))}\nfixed: ${JSON.stringify(memory.fixed.map((f) => f.claim || f))}\n\nАГРЕГАТЫ: ${JSON.stringify({ outOfRange: agg.outOfRange, telephonySuspects: agg.telephonySuspects, callVolume: agg.callVolume, caseOdds: agg.caseOdds })}\n\nПЕРЕПИСКА:\n${history}\n\nОтветь на последнюю реплику основателя.`;
  const { text, tokens } = await callModel(sys, anonymize(rawContent, map), 2200);
  await bumpQuota("chat");
  let reply = deanonymize(text, map);
  if (overLimit) reply = `⚠️ Дневной лимит ручного чата (${cfg.chatDailyLimit} сообщений) превышен — это защита от расходов, но я не блокирую тебя. Лимит сбросится завтра, порог настраивается.\n\n` + reply;
  await pushChat("agent", reply, { kind: "reply", tokens });
  return { ok: true, reply, tokens, overLimit };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  if (!AKEY) { res.status(500).json({ error: "no ANTHROPIC_API_KEY" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "state";
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const isCron = cronSecret ? (authHeader === `Bearer ${cronSecret}`) : (q.cron === "1" || b.cron === true);
  const sess = await getSession(q.session || b.session);
  const isAdmin = !!sess && sess.role === "admin";
  const cronActions = new Set(["nightly", "weekly_review"]);
  if (!isAdmin && !(cronActions.has(action) && isCron)) { res.status(403).json({ error: "admin only (или cron с секретом)" }); return; }

  try {
    if (action === "state") {
      const map = await rgetJSON(K.idmap, { orgs: {}, mops: {} });
      const [memory, conflog, cfg, quota] = await Promise.all([readMemory(), rgetJSON(K.conflog, []), getConfig(), getQuota()]);
      // де-обезличиваем для показа основателю (в памяти хранится обезличенно)
      const de = (arr) => (arr || []).map((it) => ({ ...it, claim: deanonymize(it.claim || "", map), evidence: (it.evidence || []).map((e) => deanonymize(e, map)), reason: deanonymize(it.reason || "", map) }));
      res.status(200).json({ ok: true, findings: de(memory.findings), hypotheses: de(memory.hypotheses), decisions: memory.decisions, fixed: memory.fixed, chat: memory.chat, conflog: conflog.slice(-60), config: cfg, quota });
      return;
    }
    if (action === "get_config") { res.status(200).json({ ok: true, config: await getConfig() }); return; }
    if (action === "verified_funnel") { res.status(200).json({ ok: true, funnel: await getVerifiedFunnel(String(q.org || b.org || "hunter")) }); return; }
    if (action === "set_config") {
      const cur = await getConfig(); const inc = b.config || {};
      const next = { ...cur };
      for (const k of Object.keys(DEFAULT_CONFIG)) if (typeof inc[k] === "number" && isFinite(inc[k]) && inc[k] >= 0) next[k] = inc[k];
      await rsetJSON(K.config, next);
      res.status(200).json({ ok: true, config: next }); return;
    }
    if (action === "chat") { const text = String(b.text || "").trim(); if (!text) { res.status(400).json({ error: "empty text" }); return; } res.status(200).json(await runChat(text)); return; }
    // nightly/weekly: cron-триггер (не админ) НИКОГДА не отдаёт отчёт в ответе (в нём реальные имена) —
    // только факт запуска; сам отчёт пишется в память, админ читает его через state. Полный результат — только админу.
    if (action === "nightly") { const r = await runNightly("nightly", isCron && !isAdmin); res.status(200).json(isAdmin ? r : { ok: !!r.ok, ran: !!r.ok }); return; }
    if (action === "weekly_review") { const r = await runNightly("weekly", isCron && !isAdmin); res.status(200).json(isAdmin ? r : { ok: !!r.ok, ran: !!r.ok }); return; }

    if (action === "decision") {
      const verdict = String(b.verdict || "");
      if (!["approved", "rejected", "fixed"].includes(verdict)) { res.status(400).json({ error: "bad verdict" }); return; }
      const map = await rgetJSON(K.idmap, { orgs: {}, mops: {} });
      const decisions = await rgetJSON(K.decisions, []);
      const listKey = b.kind === "finding" ? K.findings : K.hypotheses;
      const list = await rgetJSON(listKey, []);
      const item = list.find((x) => x.id === b.refId);
      // claim в решениях храним ОБЕЗЛИЧЕННО (как в памяти), чтобы не утёк в промпт
      const claimStored = (item && item.claim) || anonymize(b.claim || "", map);
      decisions.push({ id: newId("dec"), refId: b.refId || "", kind: b.kind || "", claim: claimStored, verdict, note: anonymize(b.note || "", map), at: Date.now() });
      await rsetJSON(K.decisions, decisions.slice(-CAP.decisions));
      await rsetJSON(listKey, list.filter((x) => x.id !== b.refId));
      if (verdict === "fixed" && (item || b.claim)) {
        const fixed = await rgetJSON(K.fixed, []);
        fixed.push({ id: newId("fix"), claim: claimStored, note: anonymize(b.note || "", map), at: Date.now() });
        await rsetJSON(K.fixed, fixed.slice(-CAP.fixed));
      }
      await pushChat("human", `[решение: ${verdict}] ${deanonymize(claimStored, map)}${b.note ? " — " + b.note : ""}`, { kind: "decision" });
      res.status(200).json({ ok: true }); return;
    }

    if (action === "reset") {
      await Promise.all([rdel(K.findings), rdel(K.hypotheses), rdel(K.chat), rdel(K.conflog)]);
      if (b.full === true || q.full === "1") { await Promise.all([rdel(K.decisions), rdel(K.fixed), rdel(K.idmap)]); }
      res.status(200).json({ ok: true, reset: true, full: b.full === true || q.full === "1" }); return;
    }

    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
}
