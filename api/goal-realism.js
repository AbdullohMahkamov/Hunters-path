// api/goal-realism.js — ПРОВЕРКА РЕАЛИСТИЧНОСТИ ЦЕЛИ (детерминированно, НЕ LLM).
//
// ФИЛОСОФИЯ: планировщик умеет считать РАЗРЫВ до цели, но не умеет сказать «нельзя». Эта проверка идёт
// ПЕРЕД построением плана (сначала «реально ли», потом «вот план») и называет СВЯЗЫВАЮЩЕЕ ограничение —
// то, во что цель упирается на самом деле — из четырёх:
//   1) БЮДЖЕТ      — сколько лидов нужно и сколько это стоит при текущей цене лида (НИЖНЯЯ граница: при
//                    росте объёма цена лида растёт). Систе­ма называет сумму и СПРАШИВАЕТ владельца, не решает.
//   2) КОНВЕРСИЯ   — при текущей конверсии столько лидов → столько продаж. Низкая конверсия раздувает
//                    нужное число лидов → рычаг = конверсия (всегда как альтернатива).
//   3) КАПАСИТИ    — сколько лидов физически обработает менеджер. Медиана = устойчивый темп (по ней считаем
//                    достижимую цель), максимум = потолок при напряжении (пик, НЕ норма). Если нужно больше
//                    на человека, чем команда когда-либо тянула, — упор в ЛЮДЕЙ, бюджет не поможет.
//   4) СРЕДНИЙ ЧЕК — определяет, сколько продаж нужно. Искажён выигранными-без-суммы → вердикт помечает,
//                    что цифры ориентировочные (доля искажения выше порога).
//
// ВЕРДИКТ не «реально/нереально», а: связывающее ограничение + условия достижимости (+K менеджеров ИЛИ
// цель ≤ Y выполнима текущими силами). Числа считаем сами; в чат уходит готовый человеческий текст (human).

import { getGoal, parseGoalText } from "./goal.js";
import { getVerifiedFunnel } from "./dev-agent.js";
import { funnelFacts, workingDays, getPeriodResults } from "./planner.js";

const CRON_SECRET = process.env.CRON_SECRET;

const THIN_MONTH_SOLD = 10; // < столько продаж в текущем месяце → он «пустой», база берётся из закрытого месяца

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORG = "hunter";

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }

const fmt = (n) => (n == null ? "н/д" : Number(Math.round(n)).toLocaleString("ru-RU"));

// ── ЦЕНА ЛИДА (CPL): приоритет — ФАКТ по рекламе за месяц, иначе ОРИЕНТИР владельца, иначе нет ──
// В начале месяца факта мало (лидов < 30) → падаем на ориентир. Источник всегда честно называем в вердикте.
export async function resolveCpl(dash) {
  try {
    const snap = await rgetJSON("marketingagent:snapshot", null);
    const spendUZS = snap && snap.currency && snap.currency.aligned ? snap.currency.spendUZS : null;
    const leads = dash && dash.totals ? dash.totals.leads : null;
    if (spendUZS > 0 && leads >= 30) return { cpl: Math.round(spendUZS / leads), cplSource: "по факту рекламы за месяц" };
  } catch (e) { /* факт недоступен — идём к ориентиру */ }
  try {
    const biz = await rgetJSON("bizsettings:hunter", null);
    if (biz && biz.cplNorm && biz.cplNorm.value > 0) return { cpl: Math.round(biz.cplNorm.value), cplSource: "по вашему ориентиру цены лида" };
  } catch (e) { /* ориентира нет */ }
  return { cpl: null, cplSource: null };
}

// ── ЧИСТОЕ ЯДРО (тестируемо, без сети): все входы — числа/объекты, на выходе вердикт ──
export function assessGoalRealism(inp) {
  const {
    goalUZS, earned = 0, avgCheck, conv, cpl = null, cplSource = null,
    teamCapacityByMop = {}, mopsActiveCount, workdays = null,
    baseInaccurate = null, thinMonths = 3, baselineLabel = null, baselineClosed = false,
    convBest = null, convBestLabel = null,       // СВОЙ лучший лид→продажа (из истории) — рычаг конверсии
    checkCeiling = null, checkCeilNote = null,    // потолок чека (сдвиг в офлайн) — рычаг чека, капнутый
  } = inp;

  const remaining = Math.max(0, (goalUZS || 0) - (earned || 0));
  if (!(avgCheck > 0) || !(conv > 0)) {
    return { computable: false, reason: "no_base", remaining, feasible: null, human: "Реалистичность оценить не могу: нет надёжного среднего чека или конверсии по воронке." };
  }
  if (remaining <= 0) {
    return { computable: true, binding: "reached", feasible: true, remaining: 0, salesNeeded: 0, leadsNeeded: 0, human: "Цель уже достигнута на текущей выручке — проверять нечего." };
  }

  const salesNeeded = Math.ceil(remaining / avgCheck);
  const leadsNeeded = Math.ceil(salesNeeded / conv);
  const budgetLower = cpl > 0 ? Math.round(leadsNeeded * cpl) : null;

  // доля периода, которая ещё ВПЕРЕДИ (1 = весь период). Капасити — месячная; сводим к остатку периода.
  const frac = (workdays && workdays.total) ? Math.max(0.0001, workdays.left / workdays.total) : 1;
  const leadsNeededMonthly = Math.round(leadsNeeded / frac); // эквивалент «в пересчёте на полный месяц»

  // ── КАПАСИТИ КОМАНДЫ ──
  const entries = Object.entries(teamCapacityByMop);
  const withHistory = entries.filter(([, c]) => c && c.monthsN > 0 && c.median != null);
  const thinMops = entries.filter(([, c]) => !c || (c.monthsN || 0) < thinMonths).map(([n]) => n);
  const N = mopsActiveCount || entries.length || withHistory.length || 1;
  const perMopMonthly = Math.round(leadsNeededMonthly / N);

  let team = null;
  if (withHistory.length) {
    const sumMedian = withHistory.reduce((a, [, c]) => a + (c.median || 0), 0); // устойчивый темп команды, лиды/мес
    const sumMax = withHistory.reduce((a, [, c]) => a + (c.max || 0), 0);       // потолок при напряжении, лиды/мес
    const capMedianPeriod = sumMedian * frac; // сколько команда вытянет за ОСТАТОК периода на устойчивом темпе
    const capMaxPeriod = sumMax * frac;       // …на пике
    const feasibleRevMedian = (earned || 0) + Math.floor(capMedianPeriod * conv) * avgCheck;
    const feasibleRevMax = (earned || 0) + Math.floor(capMaxPeriod * conv) * avgCheck;
    team = { mopsWithHistory: withHistory.length, sumMedianMonth: Math.round(sumMedian), sumMaxMonth: Math.round(sumMax), capMedianPeriod: Math.round(capMedianPeriod), capMaxPeriod: Math.round(capMaxPeriod), feasibleRevMedian, feasibleRevMax };
  }

  // ── ТРИ МНОЖИТЕЛЯ: выручка = ЛИДЫ × КОНВЕРСИЯ × ЧЕК. Рычаги в порядке дешевизны и обратимости:
  //    сначала КОНВЕРСИЯ (вернуть свой лучший лид→продажа), потом ЧЕК (сдвиг в офлайн, капнут +14%),
  //    и только если и этого мало — ЛИДЫ через НАЙМ (последний рычаг). Раньше конверсия и чек стояли
  //    КОНСТАНТОЙ, поэтому вердикт всегда упирался в людей — это и была ошибка.
  const cBest = (convBest && convBest > conv) ? convBest : conv;              // свой лучший (≥ текущего)
  const chkCeil = (checkCeiling && checkCeiling > avgCheck) ? checkCeiling : avgCheck; // потолок чека
  let binding, feasibleGoal = null, addManagers = null, levers = null;
  if (!team) {
    binding = "capacity_unknown";           // по команде нет истории → пропускную способность не проверить
  } else {
    const capMed = team.capMedianPeriod, capMax = team.capMaxPeriod;          // устойчивая / пиковая пропускная (лиды/период)
    const revNow    = (earned || 0) + Math.floor(capMed * conv)  * avgCheck;  // как есть
    const revConv   = (earned || 0) + Math.floor(capMed * cBest) * avgCheck;  // вернуть лучшую конверсию
    const revChk    = (earned || 0) + Math.floor(capMed * cBest) * chkCeil;   // + потолок чека
    const revBudget = (earned || 0) + Math.floor(capMax * cBest) * chkCeil;   // + БОЛЬШЕ ЛИДОВ до пика (реклама, БЕЗ найма)
    // лиды/бюджет под цель ПОСЛЕ выжатых конверсии+чека
    const salesForGoal = Math.ceil(remaining / chkCeil);
    const leadsForGoal = Math.ceil(salesForGoal / cBest);
    const budgetForGoal = cpl > 0 ? Math.round(leadsForGoal * cpl / frac) : null; // в пересчёте на месяц
    levers = {
      convNowPct: +(conv * 100).toFixed(2), convBestPct: +(cBest * 100).toFixed(2), convBestLabel,
      checkNow: Math.round(avgCheck), checkCeil: Math.round(chkCeil), checkCeilNote,
      revNow, revConv, revChk, revBudget,
      convGain: revConv - revNow, checkGain: revChk - revConv, budgetGain: revBudget - revChk,
      leadsForGoal, budgetForGoal,
    };
    feasibleGoal = revBudget;               // максимум БЕЗ найма = лучшая конверсия + потолок чека + лиды до пика
    if (goalUZS <= revNow) binding = "reachable_now";        // берётся текущими показателями
    else if (goalUZS <= revConv) binding = "conversion";     // хватит вернуть свою лучшую конверсию
    else if (goalUZS <= revChk) binding = "check";           // конверсия + сдвиг чека (офлайн)
    else if (goalUZS <= revBudget) binding = "budget";       // + больше лидов до пика команды (реклама), найма НЕТ
    else {                                                    // НАЙМ — ПОСЛЕДНИЙ рычаг: даже пик×лучшая конв×чек мало
      binding = "team";
      addManagers = capMed > 0 ? Math.max(1, Math.ceil(N * (leadsForGoal / capMed - 1))) : null;
    }
  }

  const out = {
    computable: true, binding,
    feasible: ["reachable_now", "conversion", "check", "budget"].includes(binding), // достижимо БЕЗ найма (budget = реклама, не люди)
    remaining, salesNeeded, leadsNeeded, leadsNeededMonthly, perMopMonthly,
    frac: +frac.toFixed(3), cpl, cplSource, budgetLower,
    team, thinMops, mopsActiveCount: N, feasibleGoal, addManagers, levers,
    convPct: +(conv * 100).toFixed(1),
    avgCheckInaccurate: baseInaccurate || null,
    baselineLabel: baselineLabel || null,
    baselineClosed: !!baselineClosed,
  };
  out.human = buildVerdict(out);
  return out;
}

// ── ЧЕЛОВЕЧЕСКИЙ ВЕРДИКТ (детерминированный текст, готовый для чата) ──
// ПОРЯДОК РЫЧАГОВ: конверсия → чек → найм. Найм называется ТОЛЬКО когда конверсии и чека не хватает.
function buildVerdict(o) {
  const t = o.team, L = o.levers;
  const convLine = L ? `вернуть вашу лучшую конверсию ${L.convBestPct}%${L.convBestLabel ? ` (${L.convBestLabel})` : ""} — сейчас ${L.convNowPct}%` : "";
  const checkLine = L && L.checkCeil > L.checkNow ? `поднять чек ${fmt(L.checkNow)}→${fmt(L.checkCeil)}${L.checkCeilNote ? ` (${L.checkCeilNote})` : ""}` : "";
  let s = "";

  if (o.binding === "reachable_now") {
    s = `✅ Цель берётся текущими показателями (конверсия ${L.convNowPct}%, чек ${fmt(L.checkNow)}) на устойчивом темпе команды. Ни найма, ни изменения конверсии/чека не требуется.`;
  } else if (o.binding === "conversion") {
    s = `✅ Без найма и без изменения чека. Достаточно ${convLine}. На текущем трафике это закрывает цель. Найм НЕ нужен — рычаг в качестве работы с лидами (закрытие/дозвон), а не в числе людей.`;
  } else if (o.binding === "check") {
    s = `✅ Без найма. Нужны ДВА своих рычага: ${convLine}; и ${checkLine}. Вместе закрывают цель на текущем трафике. Число людей увеличивать не требуется.`;
  } else if (o.binding === "budget") {
    const budgLine = L.budgetForGoal != null ? ` (~${fmt(L.budgetForGoal)} сум рекламы/мес, ${o.cplSource || "нижняя граница"})` : "";
    s = `Без найма, но нужен РОСТ ТРАФИКА. Сначала свои рычаги: ${convLine}${checkLine ? `, и ${checkLine}` : ""}. Этого на текущем трафике не хватает, но команда способна обработать больше лидов (до пика ~${fmt(t.sumMaxMonth)}/мес) — добрать их РЕКЛАМОЙ${budgLine}, а не людьми. Найм не нужен.`;
  } else if (o.binding === "team") {
    const addPart = o.addManagers > 0 ? `нанять +${o.addManagers} ${plMgr(o.addManagers)}` : `нарастить трафик`;
    s = `❗ Даже выжав СВОИ рычаги — ${convLine}${checkLine ? `, и ${checkLine}` : ""} — на текущем трафике выходит ~${fmt(o.feasibleGoal)} сум. Остаток до цели уже требует БОЛЬШЕ ЛИДОВ: ${addPart}. `
      + `Это ПОСЛЕДНИЙ рычаг: сначала конверсия и чек (дешевле, быстрее, обратимо), найм — если и их не хватает. Устойчивая цель без найма ≤ ${fmt(o.feasibleGoal)} сум.`;
  } else if (o.binding === "capacity_unknown") {
    s = `По команде пока нет истории загрузки — пропускную способность проверить не могу, поэтому «упрётся ли в людей» не скажу. `
      + (o.budgetLower != null ? `По деньгам: ~${fmt(o.budgetLower)} сум рекламного бюджета (${o.cplSource}, нижняя граница).` : `Цену лида назвать нечем — задайте ориентир.`);
  }

  // разложение рычагов в деньгах — когда есть
  if (L && ["team", "budget", "check", "conversion"].includes(o.binding)) {
    s += `\n💡 Рычаги в деньгах (порядок: сначала свои, найм — последним): конверсия ${L.convNowPct}→${L.convBestPct}% даёт +${fmt(L.convGain)}`
      + (L.checkGain > 0 ? `; чек до потолка ещё +${fmt(L.checkGain)} (ограничен форматом, ~+14%)` : ``)
      + (L.budgetGain > 0 ? `; лиды до пика команды ещё +${fmt(L.budgetGain)} (реклама, без найма)` : ``) + `.`;
  }
  // приблизительность по новым МОПам
  if (o.thinMops && o.thinMops.length) s += `\n⚠️ По ${o.thinMops.join(", ")} мало истории — их капасити оценочна, цифры по команде приблизительные.`;
  // искажение среднего чека
  if (o.avgCheckInaccurate) s += `\n📎 Расчёт опирается на средний чек, а он сейчас неточен: ${o.avgCheckInaccurate.count} сделок закрыты без суммы (${o.avgCheckInaccurate.sharePct}%). Цифры ориентировочные — точнее станет, когда суммы проставят.`;
  // ЧЕСТНО про базу расчёта (чек и конверсия): текущий месяц (почти прожит) или последний закрытый (текущий пуст)
  if (o.baselineLabel) s += o.baselineClosed
    ? `\n📈 Средний чек и конверсия — из закрытого месяца (${o.baselineLabel}): текущий период ещё пустой. Пересчитаю по факту, когда пойдут продажи.`
    : `\n📈 Средний чек и конверсия — по текущему месяцу (${o.baselineLabel}).`;
  return s;
}
function cap(x) { return x ? x.charAt(0).toUpperCase() + x.slice(1) : x; }
// Русское склонение «менеджер» по числу: 1→менеджер, 2-4→менеджера, 5-20/0→менеджеров.
function plMgr(n) { const a = Math.abs(n) % 100, b = a % 10; if (a > 10 && a < 20) return "менеджеров"; if (b > 1 && b < 5) return "менеджера"; if (b === 1) return "менеджер"; return "менеджеров"; }

const medArr = (a) => { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

// ── КАПАСИТИ ПО ПОСЛЕДНИМ 3 МЕСЯЦАМ С УЧЁТОМ ТЕНДЕНЦИИ (роста/спада) ──
// Медиана ВСЕЙ истории слепа к росту: разгонные месяцы вечно тянут её вниз, и команда, которая набрала темп,
// выглядит слабее, чем есть (напр. Abdulla-Legenda: месяцы [16, 425, 421] → медиана всей истории 228, хотя
// реальный текущий темп ~421). Поэтому при постановке цели берём ОКНО последних 3 завершённых месяцев и смотрим
// направление: устойчиво растёт → берём последний месяц (текущий уровень), устойчиво падает → тоже последний
// (ниже, честно), разнонаправленно → медиану окна (устойчивая середина, гасит одиночный спайк/провал).
//   includeCurrent — включить текущий месяц в окно, если сегодня ПОСЛЕДНИЙ день месяца (он уже прожит, как и в
//   базе чек/конверсии) — чтобы оценка не «прыгала» на стыке 31-е→1-е.
export function recentCapacity(months, monthNow, includeCurrent = false) {
  const entries = Object.entries(months || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const usable = entries.filter(([mk]) => mk < monthNow || (includeCurrent && mk === monthNow));
  const vals = usable.slice(-3).map(([, v]) => v);
  const n = vals.length;
  if (!n) return { base: null, max: null, monthsN: 0, trend: "none", window: [] };
  const med = medArr(vals), mx = Math.max(...vals);
  let trend = "flat", base = med;
  if (n >= 2) {
    const up = vals.every((v, i) => i === 0 || v >= vals[i - 1]) && vals[n - 1] > vals[0];   // монотонный рост
    const down = vals.every((v, i) => i === 0 || v <= vals[i - 1]) && vals[n - 1] < vals[0]; // монотонный спад
    if (up) { trend = "up"; base = vals[n - 1]; }
    else if (down) { trend = "down"; base = vals[n - 1]; }
  }
  return { base, max: mx, monthsN: n, trend, window: vals, latest: vals[n - 1], median: med };
}

// ── АСИНХРОННАЯ ОБЁРТКА: собирает входы (цель, воронка, капасити, CPL) и зовёт ядро ──
// opts (все необязательны, для READ-ONLY превью гипотетической цели — ничего не мутируем):
//   goalUZS/period — оценить цель, ОТЛИЧНУЮ от сохранённой (напр. август, пока стоит июльская);
//   earnedUZS      — переопределить «уже заработано» (для превью свежего месяца ставим 0, т.к. живая
//                    воронка сегодня показывает выручку ТЕКУЩЕГО месяца, а не оцениваемого будущего).
export async function assessRealism(org = ORG, opts = {}) {
  const stored = await getGoal(org);
  const goal = (opts.goalUZS != null)
    ? { amountUZS: opts.goalUZS, period: opts.period || (stored && stored.period) || null }
    : stored;
  if (!goal || !goal.amountUZS) return { computable: false, reason: "no_goal", feasible: null };
  const funnel = await getVerifiedFunnel(org).catch(() => null);
  const f = funnelFacts(funnel);
  if (!f) return { computable: false, reason: "no_funnel", feasible: null };
  const workdays = goal.period ? await workingDays(goal.period) : null;
  const dash = await rgetJSON("dashboard", null);
  const rawByMop = (dash && dash.teamCapacity && dash.teamCapacity.byMop) || {};
  const monthNow = (dash && dash.teamCapacity && dash.teamCapacity.monthNow) || (new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7));
  // текущий месяц включаем в окно капасити, если сегодня ПОСЛЕДНИЙ день месяца (он уже прожит ~полностью)
  const nowD = new Date(Date.now() + 5 * 3600000);
  const isLastDayOfMonth = new Date(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() + 1)).getUTCMonth() !== nowD.getUTCMonth();
  // ТЕНДЕНЦИЯ: капасити каждого МОПа берём по последним 3 месяцам с учётом направления (не медиана всей истории).
  // Фолбэк на старую медиану/макс, если помесячного грида ещё нет (до первого sync с полем months).
  const teamCapacityByMop = {}, trends = {};
  for (const [name, c] of Object.entries(rawByMop)) {
    if (c && c.months) {
      const r = recentCapacity(c.months, monthNow, isLastDayOfMonth);
      teamCapacityByMop[name] = { median: r.base, max: r.max, monthsN: r.monthsN };
      trends[name] = { trend: r.trend, window: r.window };
    } else if (c) {
      teamCapacityByMop[name] = { median: c.median, max: c.max, monthsN: c.monthsN };
    }
  }
  const thinMonths = (dash && dash.teamCapacity && dash.teamCapacity.thinMonths) || 3;
  const mopsActiveCount = (dash && Array.isArray(dash.mopsByConv)) ? dash.mopsByConv.length : Object.keys(teamCapacityByMop).length;
  const wna = dash && dash.dataQuality && dash.dataQuality.wonNoAmount;
  const baseInaccurate = (wna && wna.inaccurate) ? { count: wna.count, sharePct: wna.sharePct } : null;
  const { cpl, cplSource } = await resolveCpl(dash);

  // БАЗА avgCheck/конверсии — и вердикт ЧЕСТНО пишет, на какой посчитан:
  //  • если ТЕКУЩИЙ месяц уже наполнен (≥ порога продаж) — берём его (в конце месяца он прожит на ~99%, это
  //    полнее любого прошлого). Метка — текущий календарный месяц (это НЕ обязательно период цели: цель на
  //    август, а база — июль, если считаем 31 июля).
  //  • если текущий пустой (начало периода) — берём ИТОГ ПОСЛЕДНЕГО ЗАКРЫТОГО месяца (periodresults).
  const RU_MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const nowTk = new Date(Date.now() + 5 * 3600000);
  const curLabel = `${RU_MONTHS[nowTk.getUTCMonth()]} ${nowTk.getUTCFullYear()}`;
  let avgCheck = f.avgCheck, conv = f.conv, baselineLabel = curLabel, baselineClosed = false;
  if ((f.sold || 0) < THIN_MONTH_SOLD) {
    const results = await getPeriodResults(org).catch(() => []);
    const last = (results && results.length) ? results[results.length - 1] : null;
    if (last && (last.avgCheckMedian || last.convPct != null)) {
      if (last.avgCheckMedian) avgCheck = last.avgCheckMedian;
      if (last.convPct != null) conv = last.convPct / 100;
      baselineLabel = last.label; baselineClosed = true;
    }
  }
  const earned = opts.earnedUZS != null ? opts.earnedUZS : (f.revenue || 0);
  // РЫЧАГ КОНВЕРСИИ: свой лучший лид→продажа из истории (объём ≥500 лидов, не текущий незрелый месяц).
  let convBest = null, convBestLabel = null;
  for (const m of ((dash && dash.monthlyFunnel) || [])) {
    if (m.leads >= 500 && m.monthsAgo >= 1 && m.convPeriodPct != null) {
      const c = m.convPeriodPct / 100;
      if (convBest == null || c > convBest) { convBest = c; convBestLabel = `ваш ${m.month}`; }
    }
  }
  // РЫЧАГ ЧЕКА: потолок = офлайн-прайс (сдвиг формата), капнут ~+14% над онлайном. Продукт: 1 курс, 2 формата.
  const fmtPrices = (dash && dash.formatPrices) || { online: 3.5e6, offline: 4.0e6 };
  const checkCeiling = fmtPrices.offline || null;
  const out = assessGoalRealism({
    goalUZS: goal.amountUZS, earned, avgCheck, conv,
    cpl, cplSource, teamCapacityByMop, mopsActiveCount, workdays, baseInaccurate, thinMonths, baselineLabel, baselineClosed,
    convBest, convBestLabel, checkCeiling, checkCeilNote: "сдвиг в офлайн, потолок +14%",
  });
  // ТЕНДЕНЦИЯ последних 3 месяцев — в вердикт и в данные (капасити взята по текущему темпу, не по медиане всей истории).
  const growing = Object.entries(trends).filter(([, t]) => t.trend === "up").map(([n]) => n);
  const declining = Object.entries(trends).filter(([, t]) => t.trend === "down").map(([n]) => n);
  out.trends = trends;
  if (out.computable && out.human) {
    if (growing.length || declining.length) {
      const parts = [];
      if (growing.length) parts.push(`растут — ${growing.join(", ")}`);
      if (declining.length) parts.push(`снижаются — ${declining.join(", ")}`);
      out.human += `\n📊 Тенденция за 3 мес: ${parts.join("; ")}. Капасити взята по ТЕКУЩЕМУ темпу (у растущих — последний месяц, а не заниженная медиана всей истории).`;
    } else {
      out.human += `\n📊 Тенденция за 3 мес: тренда нет — капасити по медиане последних 3 месяцев.`;
    }
  }
  return out;
}

// ── READ-ONLY ПРЕВЬЮ ВЕРДИКТА для гипотетической цели (ничего не сохраняет). Использует ТУ ЖЕ разборку цели
// (parseGoalText) и ту же оценку, что сработают в живом пути завтра → превью и живой прогон совпадут. ──
export async function previewRealism(text, org = ORG) {
  const parsed = await parseGoalText(text || "");
  if (!parsed || !parsed.ok || !(parsed.amountUZS > 0)) return { ok: false, error: (parsed && parsed.error) || "не распознал сумму/период цели" };
  // Свежий месяц: earned=0 (оцениваемый период ещё не начался; живая воронка сегодня — про текущий месяц).
  const verdict = await assessRealism(org, { goalUZS: parsed.amountUZS, period: parsed.period, earnedUZS: 0 });
  return { ok: true, parsed: { amountUZS: parsed.amountUZS, currency: parsed.currency, amount: parsed.amount, period: parsed.period, metric: parsed.metric }, verdict };
}

// READ-ONLY ДАМП входов расчёта устойчивой цели — ничего не считает по-новому, показывает то, что УЖЕ хранится
// (teamCapacity по каждому МОПу) + факты воронки/CPL, которые подставляются в формулу. Для аудита «откуда 102».
export async function capacityDump(org = ORG) {
  const dash = await rgetJSON("dashboard", null);
  const tc = (dash && dash.teamCapacity) || null;
  const byMop = (tc && tc.byMop) || {};
  const entries = Object.entries(byMop);
  const withHistory = entries.filter(([, c]) => c && c.monthsN > 0 && c.median != null);
  const sumMedian = withHistory.reduce((a, [, c]) => a + (c.median || 0), 0);
  const sumMax = withHistory.reduce((a, [, c]) => a + (c.max || 0), 0);
  const funnel = await getVerifiedFunnel(org).catch(() => null);
  const f = funnelFacts(funnel);
  const { cpl, cplSource } = await resolveCpl(dash);
  const results = await getPeriodResults(org).catch(() => []);
  return {
    monthNow: tc && tc.monthNow, thinMonths: tc && tc.thinMonths, generatedAt: tc && tc.generatedAt,
    perMop: entries.map(([name, c]) => ({ name, median: c.median, max: c.max, monthsN: c.monthsN, thin: c.thin, currentPartial: c.currentPartial, months: c.months || null })),
    inWithHistory: withHistory.map(([n]) => n),
    sumMedianMonth: Math.round(sumMedian), sumMaxMonth: Math.round(sumMax), mopsActiveCount: entries.length,
    funnelJuly: f ? { sold: f.sold, revenue: f.revenue, leads: f.leads, avgCheck: f.avgCheck, convPct: f.conv != null ? +(f.conv * 100).toFixed(2) : null } : null,
    cpl, cplSource,
    lastClosedPeriod: (results && results.length) ? results[results.length - 1] : null,
    monthlyFunnel: (dash && dash.monthlyFunnel) || null, // помесячная конверсия лид→продажа (когортная)
    soldPriceHist: (dash && dash.soldPriceHist) || null, // распределение цен продаж (офлайн/онлайн)
    soldPayments: (dash && dash.soldPayments) || null,   // скидка vs рассрочка + невыбранная выручка
  };
}

const CRON_OK = new Set(["preview", "capacity-dump"]); // оба READ-ONLY, ничего не мутируют
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "";
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  const authed = (auth && CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) || (q.cron === "1" && CRON_OK.has(action));
  if (!authed) { res.status(403).json({ error: "forbidden" }); return; }
  try {
    if (action === "preview") { res.status(200).json(await previewRealism(b.text || q.text || "", ORG)); return; }
    if (action === "capacity-dump") { res.status(200).json(await capacityDump(ORG)); return; }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
