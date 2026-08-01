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
import { sendTg, getPeople } from "./tg-bot.js"; // уведомить исполнителя при снятии неактуальной задачи (сверка)

const CRON_SECRET = process.env.CRON_SECRET;

const THIN_MONTH_SOLD = 10; // < столько продаж в текущем месяце → он «пустой», база берётся из закрытого месяца

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORG = "hunter";

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }

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
      // КОНКРЕТИКА ДЛЯ МАРКЕТИНГА: сколько лидов ДОБРАТЬ до пика ёмкости и во сколько это обойдётся при текущем CPL
      leadsToPeak: Math.max(0, Math.round(capMax - capMed)),
      budgetToPeak: cpl > 0 ? Math.round(Math.max(0, capMax - capMed) * cpl) : null,
      cpl,
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
    // ПРОГНОЗ РЕКЛАМНОГО БЮДЖЕТА — честно: достижимая часть берётся конверсией/чеком на ТЕКУЩЕМ трафике (доп. бюджет
    // почти не нужен); отдельный инкремент — только лиды до пика. Полную цель лидами не закрыть (команда не обработает).
    if (L.leadsToPeak != null) {
      s += L.leadsToPeak > 0 && L.budgetToPeak != null
        ? `\n💰 Рекламный бюджет: достижимые ~${fmt(o.feasibleGoal)} берутся конверсией/чеком на текущем трафике — доп. бюджет почти не нужен. Рост лидов до пика (+${L.leadsToPeak}/мес) ≈ +${fmt(L.budgetToPeak)} сум/мес (CPL ${fmt(L.cpl)}). Полную цель лидами НЕ закрыть — команда не обработает больше.`
        : `\n💰 Рекламный бюджет: достижимая часть берётся конверсией/чеком на текущем трафике — заметный доп. бюджет не требуется. Больше лидов команда сейчас не обработает.`;
    }
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

// ── РАЗЛОЖЕНИЕ КОНВЕРСИИ на ДОЗВОН × ЗАКРЫТИЕ (чистое, тестируемо) ──
// conv(лид→продажа) = dozvon(лид→разговор) × closing(разговор→продажа). Показывает, ГДЕ резерв: поднять дозвон
// до лучшего в команде или закрытие до лучшего. reserveStep — где рычаг больше (там и работать в первую очередь).
export function funnelReserve(convNow, dozvonNow, bestDozvon, bestClosing) {
  if (!(convNow > 0) || !(dozvonNow > 0)) return null;
  const closingNow = convNow / dozvonNow;
  const bd = bestDozvon && bestDozvon > dozvonNow ? Math.min(bestDozvon, 1) : dozvonNow;
  const bc = bestClosing && bestClosing > closingNow ? bestClosing : closingNow;
  const convViaDozvon = bd * closingNow;   // если бы все дозванивались как лучший
  const convViaClosing = dozvonNow * bc;   // если бы все закрывали как лучший
  const dozvonGain = convViaDozvon - convNow, closingGain = convViaClosing - convNow;
  return {
    dozvonPct: +(dozvonNow * 100).toFixed(1), closingPct: +(closingNow * 100).toFixed(2),
    bestDozvonPct: +(bd * 100).toFixed(1), bestClosingPct: +(bc * 100).toFixed(2),
    convViaDozvon, convViaClosing,
    reserveStep: closingGain >= dozvonGain ? "closing" : "dozvon", // где резерв больше
  };
}

// ── РЫЧАГИ → ЗАДАЧИ ОДНИМ ПАКЕТОМ (чистое, тестируемо) ──
// Из вердикта выводим ОПЕРАЦИОННЫЕ задачи РОПу (закрытие, дозвон отстающего) — их одна кнопка и раздаёт.
// Деньги/наём (реклама, +менеджеры, снижение цели) — НЕ задачи исполнителям, а решения владельца (очередь «Решения»).
export function deriveLeverTasks(v) {
  if (!v || !v.computable) return [];
  const tasks = [], d = v.decomp;
  if (d && d.reserveStep === "closing" && d.bestClosingPct > d.closingPct) {
    tasks.push({
      leverKey: "closing",
      title: `Поднять закрытие сделок к лучшему в команде (~${d.bestClosingPct}%)`,
      why: `Команда закрывает ${d.closingPct}% разговоров, лучший — ${d.bestClosingPct}%. Разобрать разговоры слабых менеджеров против лучшего, подтянуть скрипт закрытия. Главный рычаг: без найма и без новых лидов.`,
      recipient: "rop", scope: "department",
      steps: [
        "Прослушать 5–7 звонков лучшего закрывающего — выписать, как он доводит до оплаты",
        "Прослушать по 5 звонков слабых менеджеров — отметить, на каком шаге теряется сделка",
        "Собрать/обновить скрипт закрытия по лучшему (работа с возражениями, дожим, следующий шаг)",
        "Провести разбор с командой и закрепить скрипт в ежедневной работе",
        "Через неделю перепроверить закрытие по свежим разговорам",
      ],
    });
  }
  if (d && d.worstDozvonMop && d.worstDozvonMop.pct < d.bestDozvonPct - 10) {
    tasks.push({
      leverKey: `dozvon:${d.worstDozvonMop.name}`, // ключ включает МОПа → сменился отстающий → старая задача снимется
      title: `Подтянуть дозвон: ${d.worstDozvonMop.name} (${d.worstDozvonMop.pct}% против ${d.bestDozvonPct}%)`,
      why: `Дозвон ${d.worstDozvonMop.name} — ${d.worstDozvonMop.pct}% против ${d.bestDozvonPct}% у лучших. Разобрать причины (скорость первого звонка, число попыток), скорректировать.`,
      recipient: "rop", scope: "pointwise", mop: d.worstDozvonMop.name,
      steps: [
        `Проверить скорость первого звонка у ${d.worstDozvonMop.name} — насколько медленнее нормы (цель — 15 минут)`,
        "Посмотреть число попыток дозвона на лид — хватает ли попыток в первый день",
        "Разобрать 5 недозвонов: причина (время суток, каналы, отказ)",
        `Ввести правило: первый звонок в 15 минут, минимум 3 попытки; проговорить с ${d.worstDozvonMop.name}`,
        "Через неделю перепроверить дозвон по нотам amoCRM",
      ],
    });
  }
  // МАРКЕТИНГ: КОНКРЕТНАЯ задача с числами (лиды + бюджет), НЕ вопрос «посчитай сам». Только достижимый инкремент —
  // до ПИКА ёмкости команды (больше лидов команда не обработает, и полные 250М лидами не закрыть). ВТОРИЧНО к закрытию.
  const L = v.levers;
  if (L && L.leadsToPeak > 0 && L.budgetToPeak != null) {
    tasks.push({
      leverKey: "mkt:leads",
      title: `Привлечь +${L.leadsToPeak} лидов/мес (до пика ёмкости команды), бюджет ≤ ${fmt(L.budgetToPeak)} сум`,
      why: `Конкретно: добрать до +${L.leadsToPeak} лидов/мес при текущей цене лида ${fmt(L.cpl)} сум → бюджет ~${fmt(L.budgetToPeak)} сум/мес. Это ПОТОЛОК по лидам: больше команда не обработает, и полную цель лидами не закрыть. Каналы — текущие (не разгонять новые под низкое закрытие). ВАЖНО: это ВТОРИЧНО — приоритет закрытие сделок; увеличение бюджета сверх — решение владельца.`,
      recipient: "marketing", scope: "marketing",
      leads: L.leadsToPeak, budgetUZS: L.budgetToPeak, cplUZS: L.cpl,
      steps: [
        `Добрать +${L.leadsToPeak} лидов/мес по ТЕКУЩИМ каналам (не разгонять новые под низкое закрытие)`,
        `Держать цену лида ≤ ${fmt(L.cpl)} сум, бюджет ≤ ${fmt(L.budgetToPeak)} сум/мес`,
        "Согласовать увеличение бюджета с владельцем (реклама — его решение)",
        "Следить за качеством лидов — не гнать объём в ущерб релевантности",
      ],
    });
  }
  return tasks;
}

// ── ПОСТРОИТЕЛЬ ПЛАНА ПОД ЦЕЛЬ: декомпозиция на ВСЕ рычаги, находки агентов → подзадачи по смыслу ──
// Правило: план покрывает КАЖДЫЙ рычаг (лиды/конверсия(дозвон×закрытие)/чек/найм); где резерва нет или
// это решение владельца — пишем ЯВНО, не опускаем. Находки МОП/мозга привязываются к рычагу как подзадачи.
const FIND_LEVER_RX = [
  [/дозвон|недозвон|не набрал|без единой|попыт|первого звонка|не звонил/i, "dozvon"],
  [/закрыт|диагностик|\bцен[ауые]|гаранти|дожим|возражен|оффер|ценност|поспешн|договор|скрипт/i, "closing"],
  [/статус|ложн|обновлен/i, "closing"],
  [/\bлид|трафик|реклам|креатив|бюджет|аудитор|кампан/i, "leads"],
];
function leverOfFinding(text) { const t = String(text || "").toLowerCase(); for (const [rx, k] of FIND_LEVER_RX) if (rx.test(t)) return k; return null; }
async function gatherFindings(org = ORG) {
  const out = [];
  try { const mf = (await rgetJSON("mopagent:findings", [])) || []; for (const f of mf) if (f && !["closed", "auto_closed", "invalidated"].includes(f.status)) out.push({ title: f.title || "", why: f.fact || "" }); } catch (e) {}
  try { const mp = (await rgetJSON("metabrain:proposals", [])) || []; for (const p of mp) if (p && (p.status === "confirmed" || (p.status === "pending" && p.auto))) out.push({ title: p.title || "", why: p.statement || "" }); } catch (e) {}
  return out;
}
export async function buildGoalPlan(org = ORG) {
  const v = await assessRealism(org);
  const goalUZS = (await getGoal(org) || {}).amountUZS || 0;
  const findings = await gatherFindings(org);
  const byLever = { dozvon: [], closing: [], leads: [] }, unmapped = [];
  for (const f of findings) { const lk = leverOfFinding(`${f.title} ${f.why}`); if (byLever[lk]) byLever[lk].push(f.title); else unmapped.push(f.title); }
  const d = v.decomp, L = v.levers || {}, levers = [], ownerDecisions = [];
  if (d && d.worstDozvonMop && d.worstDozvonMop.pct < d.bestDozvonPct - 10) {
    levers.push({ key: `dozvon:${d.worstDozvonMop.name}`, lever: "Конверсия · Дозвон", recipient: "rop", kind: "task",
      title: `Подтянуть дозвон: ${d.worstDozvonMop.name} (${d.worstDozvonMop.pct}% → ${d.bestDozvonPct}%)`,
      subtasks: [...byLever.dozvon.map((t) => ({ text: t, from: "агент" })), { text: `Скорость первого звонка ${d.worstDozvonMop.name} (цель 15 мин), число попыток`, from: "вердикт" }, { text: "Правило: первый звонок в 15 мин, ≥3 попытки; перепроверка по нотам", from: "вердикт" }] });
  }
  if (d && d.bestClosingPct > d.closingPct) {
    levers.push({ key: "closing", lever: "Конверсия · Закрытие", recipient: "rop", kind: "task",
      title: `Поднять закрытие ${d.closingPct}% → ${d.bestClosingPct}% (уровень лучшего в команде)`,
      subtasks: [{ text: "Прослушать 5–7 звонков лучшего закрывающего — выписать приёмы", from: "вердикт" }, { text: "Прослушать по 5 звонков слабых — где теряется сделка", from: "вердикт" }, ...byLever.closing.map((t) => ({ text: t, from: "агент" })), { text: "Собрать скрипт закрытия, разбор с командой, перепроверка через неделю", from: "вердикт" }] });
  }
  const leadsSub = [{ text: `Держать поток лидов ≥ текущего${L.leadsToPeak > 0 ? ` + добор ~${L.leadsToPeak}/мес до пика ёмкости` : ""}`, from: "вердикт" }, { text: "Следить за качеством лидов по кампаниям — релевантность под закрытие", from: "вердикт" }, { text: `Держать цену лида${L.cpl ? ` ≤ ${fmt(L.cpl)} сум` : " (число появится с августовской статистикой)"}, не давать расти`, from: "вердикт" }, ...byLever.leads.map((t) => ({ text: t, from: "агент" }))];
  levers.push({ key: "mkt:leads", lever: "Лиды", recipient: "marketing", kind: "task", title: "Держать поток лидов под цель", subtasks: leadsSub });
  levers.push({ key: "check", lever: "Чек", kind: "note", title: "Резерва почти нет: офлайн уже ~30%, потолок +14% — не приоритет" });
  if (v.binding === "team" && v.feasibleGoal && goalUZS && v.feasibleGoal < goalUZS) {
    ownerDecisions.push({ key: "hiring", title: `Разрыв ${fmt(goalUZS - v.feasibleGoal)} сум — сверх возможностей команды`, options: [`+${v.addManagers} ${plMgr(v.addManagers)}`, `снизить цель до ${fmt(v.feasibleGoal)} сум`] });
  }
  return { goalUZS, feasibleGoal: v.feasibleGoal || null, levers, ownerDecisions, unmapped };
}

// ── СВЕРКА ЗАДАЧ С ТЕКУЩИМ ВЕРДИКТОМ (актуальность) ──
// Задачи-рычаги (leverKey) должны ЗЕРКАЛИТЬ актуальные рычаги цели: чей резерв пропал — снимаем, недостающие —
// создаём. Идемпотентно (повтор кнопки не плодит дубли). opts.cleanSlate — «чистый старт»: снять ВСЕ задачи плана
// (advisor/reconcile/plan), не входящие в текущие рычаги (для нового месяца). opts.silent — без пингов исполнителям.
export async function reconcileGoalTasks(org = ORG, opts = {}) {
  const cleanSlate = !!opts.cleanSlate, silent = !!opts.silent;
  const v = await assessRealism(org);
  const desired = deriveLeverTasks(v);
  const desiredKeys = new Set(desired.map((d) => d.leverKey).filter(Boolean));
  const app = (await rgetJSON(`appdata:${org}`, {})) || {};
  app.customPlan = app.customPlan || {};
  if (!Array.isArray(app.customPlan.sales)) app.customPlan.sales = [];
  const mtasks = (await rgetJSON("marketingtasks", [])) || [];
  const closed = [], created = [];
  const genId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  // 1) СНЯТЬ неактуальное. lever-задача устарела, если её leverKey больше не в desired. При cleanSlate снимаем И
  //    обычные задачи плана (source advisor/reconcile/plan) не из desired — новый месяц с чистого листа.
  const desiredByKey = new Map(desired.filter((x) => x.leverKey).map((x) => [x.leverKey, x]));
  const stepsOf = (want) => (Array.isArray(want.steps) ? want.steps.map((s) => String(s).slice(0, 200)).slice(0, 8) : []);
  const seenKeys = new Set(); // дедуп: один рычаг = одна задача (закрываем дубли с тем же leverKey)
  const keptSales = [];
  for (const t of app.customPlan.sales) {
    const isLever = !!t.leverKey;
    if (isLever && !cleanSlate) {
      const want = desiredByKey.get(t.leverKey);
      if (want && want.recipient !== "marketing" && !seenKeys.has(t.leverKey)) { // АКТУАЛЬНА и первая → обновляем содержимое (числа/шаги), id сохраняем
        seenKeys.add(t.leverKey);
        t.t = String(want.title).slice(0, 200); t.d = String(want.why || "").slice(0, 800); t.steps = stepsOf(want);
        keptSales.push(t);
      } else { closed.push({ id: t.id, title: t.t, to: "rop", leverKey: t.leverKey }); if (app.done) delete app.done[t.id]; } // резерв пропал ИЛИ дубль → снять
    } else if (cleanSlate) { closed.push({ id: t.id, title: t.t, to: "rop", leverKey: t.leverKey || null }); if (app.done) delete app.done[t.id]; } // ЧИСТЫЙ СТАРТ = полный сброс: сносим ВСЁ (и рычаги тоже), ниже пересоздадим актуальные
    else keptSales.push(t);
  }
  app.customPlan.sales = keptSales;
  for (const mt of mtasks) {
    if (!mt || mt.status === "done") continue;
    const isLever = !!mt.leverKey;
    if (isLever && !cleanSlate) {
      const want = desiredByKey.get(mt.leverKey);
      if (want && want.recipient === "marketing" && !seenKeys.has(mt.leverKey)) { seenKeys.add(mt.leverKey); mt.title = String(want.title).slice(0, 200); mt.why = String(want.why || "").slice(0, 800); mt.action = stepsOf(want).join(" | "); }
      else { mt.status = "done"; mt.doneAt = Date.now(); mt.doneBy = "reconcile:stale"; closed.push({ id: mt.id, title: mt.title, to: "marketing", leverKey: mt.leverKey }); }
    } else if (cleanSlate) { mt.status = "done"; mt.doneAt = Date.now(); mt.doneBy = "reconcile:stale"; closed.push({ id: mt.id, title: mt.title, to: "marketing", leverKey: mt.leverKey || null }); }
  }
  // ЧИСТЫЙ СТАРТ: закрыть накопившиеся находки МОП-агента и подтверждённые предложения мозга (просрочка/дубли с
  // прошлого месяца). Валидные вернутся СВЕЖИМИ на ближайших прогонах агентов (с новыми сроками), стухшие — нет.
  let mopClosed = 0, metaClosed = 0;
  if (cleanSlate) {
    try {
      const mf = (await rgetJSON("mopagent:findings", [])) || [];
      let ch = false;
      for (const f of mf) { if (f && !["closed", "auto_closed", "invalidated"].includes(f.status)) { f.status = "closed"; f.closedAt = Date.now(); f.closeReason = "чистый старт месяца"; mopClosed++; ch = true; } }
      if (ch) await rsetJSON("mopagent:findings", mf);
    } catch (e) { /* не критично */ }
    try {
      const mp = (await rgetJSON("metabrain:proposals", [])) || [];
      let ch = false;
      for (const p of mp) { if (p && (p.status === "confirmed" || (p.status === "pending" && p.auto))) { p.status = "closed"; p.closedAt = Date.now(); p.closeReason = "чистый старт месяца"; metaClosed++; ch = true; } }
      if (ch) await rsetJSON("metabrain:proposals", mp);
    } catch (e) { /* не критично */ }
  }
  // 2) СОЗДАТЬ недостающие desired (по leverKey — без дублей; seenKeys уже содержит обновлённые в п.1)
  for (const d of desired) {
    if (!d.leverKey || seenKeys.has(d.leverKey)) continue;
    const steps = Array.isArray(d.steps) ? d.steps.map((s) => String(s).slice(0, 200)).slice(0, 8) : [];
    if (d.recipient === "marketing") {
      mtasks.push({ id: genId("mk_"), title: String(d.title).slice(0, 200), why: String(d.why || "").slice(0, 800), action: steps.join(" | "), status: "open", source: "reconcile", recipient: "marketing", leverKey: d.leverKey, createdAt: Date.now() });
      created.push({ title: d.title, to: "marketing" });
    } else {
      app.customPlan.sales.push({ id: genId("adv_"), t: String(d.title).slice(0, 200), d: String(d.why || "").slice(0, 800), deadline: "", steps, source: "reconcile", leverKey: d.leverKey, createdAt: Date.now() });
      created.push({ title: d.title, to: "rop" });
    }
    seenKeys.add(d.leverKey);
  }
  await rsetJSON(`appdata:${org}`, app);
  await rsetJSON("marketingtasks", mtasks);
  // Уведомление исполнителям о СНЯТИИ (нейтрально). При cleanSlate — без пингов (массовая чистка).
  if (!silent && !cleanSlate && closed.length) {
    try {
      const ppl = await getPeople();
      for (const c of closed) {
        const role = c.to === "marketing" ? "marketing" : "rop";
        const p = ppl[role];
        if (p && p.chatId) { await sendTg(role, p.chatId, `📌 Задача «${c.title}» снята — по свежим данным она больше не актуальна для цели. Делать ничего не нужно.`); }
      }
    } catch (e) { /* уведомления не критичны */ }
  }
  const salesNow = app.customPlan.sales.map((t) => ({ t: String(t.t || "").slice(0, 32), leverKey: t.leverKey || null, steps: (t.steps || []).length }));
  return { ok: true, cleanSlate, closed, created, desiredCount: desired.length, mopClosed, metaClosed, salesNow };
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
  // ЗАРАБОТАНО = выручка В ПЕРИОДЕ ЦЕЛИ. Если цель на БУДУЩИЙ месяц (напр. август, а сейчас июль) — период ещё
  // не начался, earned=0. Иначе июльская касса ошибочно засчиталась бы в августовскую цель (баг: «недостижимо»).
  const goalIsCurrentMonth = goal.period && goal.period.label === curLabel;
  const earned = opts.earnedUZS != null ? opts.earnedUZS : (goalIsCurrentMonth ? (f.revenue || 0) : 0);
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
  // ── РАЗЛОЖЕНИЕ КОНВЕРСИИ: лид→РАЗГОВОР→продажа (дозвон × закрытие) + где резерв + гейт полноты замера ──
  // Данные из накопительного замера дозвона (reachMonthAccum в ключе speed). Если coverage низкий — честно
  // помечаем «предварительно» и НЕ выдаём число за факт (правило полноты данных).
  try {
    if (out.computable && out.human && conv > 0) { // conv — базовая (при пустом текущем месяце берётся из закрытого)
      const speed = await rgetJSON("speed", null);
      let rma = speed && speed.reachMonthAccum;
      // СТЫК МЕСЯЦЕВ: текущий накопитель дозвона пуст (август только начался) → реконструируем из ПОСЛЕДНЕГО
      // ЗАКРЫТОГО месяца (speedreach:<YYYY-MM>), чтобы рычаги закрытия/дозвона встали из проверенных данных сразу.
      if (!rma || !(rma.reachedLeads > 0)) {
        const lmD = new Date(Date.UTC(nowTk.getUTCFullYear(), nowTk.getUTCMonth() - 1, 1));
        const lm = `${lmD.getUTCFullYear()}-${String(lmD.getUTCMonth() + 1).padStart(2, "0")}`;
        const acc = await rgetJSON(`speedreach:${lm}`, null);
        const byMopCap = (dash && dash.teamCapacity && dash.teamCapacity.byMop) || {};
        if (acc && acc.reached && Object.keys(acc.reached).length) {
          const reachedByMop = {};
          for (const mop of Object.values(acc.reached)) reachedByMop[mop] = (reachedByMop[mop] || 0) + 1;
          const byMop = Object.entries(byMopCap).map(([name, c]) => { const leads = (c.months && c.months[lm]) || 0; const reached = reachedByMop[name] || 0; return { name, leads, reached, dozvonPct: leads ? Math.round(reached / leads * 100) : null }; });
          const totalLeads = byMop.reduce((s, m) => s + m.leads, 0);
          rma = { month: lm, reachedLeads: Object.keys(acc.reached).length, leads: totalLeads, coveragePct: 100, byMop };
        }
      }
      if (rma && rma.reachedLeads > 0 && rma.leads > 0) {
        const dozvonNow = rma.reachedLeads / rma.leads;
        // ПРОДАЖИ по МОПам — за ТОТ ЖЕ месяц, что и дозвон (rma.month): когорта из teamCapacity.byMop[].soldMonths.
        // На стыке месяцев (август пустой, дозвон ещё июльский) это даёт закрытие по июлю, а не по нулевому августу.
        const dm = rma.month;
        const byMopCap = (dash && dash.teamCapacity && dash.teamCapacity.byMop) || {};
        const salesByMop = {};
        for (const [name, c] of Object.entries(byMopCap)) salesByMop[name] = (c.soldMonths && c.soldMonths[dm]) || 0;
        if (!Object.values(salesByMop).some((x) => x > 0)) for (const m of ((dash && dash.mopsByConv) || [])) if (m && m.name) salesByMop[m.name] = m.sold || 0; // фолбэк на текущие, если когорты нет
        // лучший в команде на каждом шаге (порог значимости, чтобы не брать шум малого объёма)
        let bestDozvon = dozvonNow, bestClosing = 0, worstDozvon = null;
        for (const b of (rma.byMop || [])) {
          if (b.leads >= 100 && b.dozvonPct != null) {
            if (b.dozvonPct / 100 > bestDozvon) bestDozvon = b.dozvonPct / 100;
            if (worstDozvon == null || b.dozvonPct < worstDozvon.pct) worstDozvon = { name: b.name, pct: b.dozvonPct };
          }
          const sold = salesByMop[b.name] || 0;
          if (b.reached >= 25 && sold > 0) { const cl = sold / b.reached; if (cl > bestClosing) bestClosing = cl; }
        }
        const dec = funnelReserve(conv, dozvonNow, bestDozvon, bestClosing);
        if (dec) {
          out.decomp = { ...dec, coveragePct: rma.coveragePct, provisional: rma.coveragePct < 75, worstDozvonMop: worstDozvon };
          const prov = rma.coveragePct < 75 ? ` ⚠️ замер дозвона ещё дозаполняется (coverage ${rma.coveragePct}%) — цифры предварительные` : "";
          const stepWord = dec.reserveStep === "closing" ? "ЗАКРЫТИИ (разговор→продажа)" : "ДОЗВОНЕ (лид→разговор)";
          // потолок рычага-резерва в деньгах: если довести отстающий шаг до ЛУЧШЕГО в команде
          const convCeil = dec.reserveStep === "closing" ? dec.convViaClosing : dec.convViaDozvon;
          const leadsRef = (f.leads > 0 ? f.leads : ((out.levers && out.levers.leadsForGoal) || 0)) // на стыке месяцев берём эталон лидов, не нулевой август
          const revCeil = (leadsRef > 0 && avgCheck > 0) ? Math.floor(leadsRef * convCeil) * avgCheck : null;
          out.human += `\n🔬 Разложение конверсии ${(conv * 100).toFixed(1)}% = дозвон ${dec.dozvonPct}% × закрытие ${dec.closingPct}%.`
            + ` Лучшие в команде: дозвон ${dec.bestDozvonPct}%, закрытие ${dec.bestClosingPct}%. Резерв — в основном в ${stepWord}.`
            + (revCeil ? ` Если подтянуть его к лучшему в команде — конверсия ~${(convCeil * 100).toFixed(1)}% → ~${fmt(revCeil)} сум на текущем трафике БЕЗ найма (это потолок: лучший держит темп не на всех лидах, но показывает, куда бить).` : ``)
            + (worstDozvon && worstDozvon.pct < dec.bestDozvonPct - 10 ? ` По дозвону отстаёт ${worstDozvon.name} (${worstDozvon.pct}%) — точечная задача РОПу.` : ``)
            + prov;
        }
      }
    }
  } catch (e) { /* разложение не критично для вердикта */ }
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
    formatFunnel: (dash && dash.formatFunnel) || null,   // конверсия по форматам (O'quv turi) + coverage
  };
}

const CRON_OK = new Set(["preview", "capacity-dump", "reconcile", "clean-slate", "plan-preview"]); // preview/dump READ-ONLY; reconcile — ежедневная сверка; clean-slate — разовый чистый старт (пересоздаёт актуальные рычаги)
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
    if (action === "reconcile") { res.status(200).json(await reconcileGoalTasks(ORG)); return; }        // ЕЖЕДНЕВНО: сверка задач с вердиктом (снять отпавшие, создать недостающие)
    if (action === "clean-slate") { res.status(200).json(await reconcileGoalTasks(ORG, { cleanSlate: true, silent: true })); return; }
    if (action === "plan-preview") { res.status(200).json(await buildGoalPlan(ORG)); return; } // READ-ONLY: структура плана под цель (до раздачи) // РАЗОВО: чистый старт месяца (снять всё лишнее)
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
