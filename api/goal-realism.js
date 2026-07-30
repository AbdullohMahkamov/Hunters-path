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

import { getGoal } from "./goal.js";
import { getVerifiedFunnel } from "./dev-agent.js";
import { funnelFacts, workingDays, getPeriodResults } from "./planner.js";

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
    baseInaccurate = null, thinMonths = 3, baselineLabel = null,
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

  // ── ВЫБОР СВЯЗЫВАЮЩЕГО ОГРАНИЧЕНИЯ (приоритет: нет истории → упор в людей → напряжение → деньги) ──
  // Без истории капасити НЕ заявляем «выполнимо» на одном бюджете — сначала честно «капасити не проверить».
  let binding, feasibleGoal = null, addManagers = null;
  if (!team) {
    binding = "capacity_unknown";           // по команде нет истории → пропускную способность не проверить
  } else if (leadsNeeded > team.capMaxPeriod) {
    binding = "team";                       // даже на историческом пике не обработать → бюджет не поможет
    feasibleGoal = team.feasibleRevMedian;
    // сколько людей ДОБАВИТЬ, чтобы цель бралась на УСТОЙЧИВОМ темпе (по медиане, не по пику): масштабируем команду
    addManagers = team.capMedianPeriod > 0 ? Math.max(1, Math.ceil(N * (leadsNeeded / team.capMedianPeriod - 1))) : null;
  } else if (leadsNeeded > team.capMedianPeriod) {
    binding = "team_strain";                // выше устойчивого темпа, но в пределах пика → достижимо на пределе
    feasibleGoal = team.feasibleRevMedian;
  } else if (budgetLower != null) {
    binding = "budget";                     // команда тянет → вопрос в деньгах
  } else {
    binding = "budget_unknown";             // команда тянет, но цену лида назвать нечем
  }

  const out = {
    computable: true, binding,
    feasible: binding === "budget" || binding === "budget_unknown",
    remaining, salesNeeded, leadsNeeded, leadsNeededMonthly, perMopMonthly,
    frac: +frac.toFixed(3), cpl, cplSource, budgetLower,
    team, thinMops, mopsActiveCount: N, feasibleGoal, addManagers,
    convPct: +(conv * 100).toFixed(1),
    avgCheckInaccurate: baseInaccurate || null,
    baselineLabel: baselineLabel || null,
  };
  out.human = buildVerdict(out);
  return out;
}

// ── ЧЕЛОВЕЧЕСКИЙ ВЕРДИКТ (детерминированный текст, готовый для чата) ──
function buildVerdict(o) {
  const t = o.team;
  const needLine = `нужно ~${fmt(o.leadsNeededMonthly)} лидов/мес${o.mopsActiveCount ? ` (≈${fmt(o.perMopMonthly)} на менеджера)` : ""}`;
  let s = "";

  if (o.binding === "team") {
    s = `❗ Упирается в КОМАНДУ, не в бюджет. Чтобы закрыть цель, ${needLine}. `
      + `Команда за всю историю максимум тянула ~${fmt(t.sumMaxMonth)} лидов/мес (устойчиво ~${fmt(t.sumMedianMonth)}). `
      + `Даже на пределе столько не обработать — рекламный бюджет тут не поможет. `
      + `Достижимо: +${o.addManagers} ${o.addManagers === 1 ? "менеджер" : "менеджера"}, либо цель ≤ ${fmt(o.feasibleGoal)} сум выполнима текущими силами на устойчивом темпе.`;
  } else if (o.binding === "team_strain") {
    s = `⚠️ Цель НА ПРЕДЕЛЕ команды. ${cap(needLine)} — это выше устойчивого темпа (~${fmt(t.sumMedianMonth)} лидов/мес), но в рамках исторического потолка (~${fmt(t.sumMaxMonth)}). `
      + `Достижимо, но держать весь месяц на пике тяжело. Устойчивая цель без перегруза ≤ ${fmt(o.feasibleGoal)} сум. `
      + (o.budgetLower != null ? `Рекламный бюджет под неё: ~${fmt(o.budgetLower)} сум (${o.cplSource}).` : `Цену лида назвать нечем — задайте ориентир, посчитаю бюджет.`);
  } else if (o.binding === "budget") {
    s = `✅ Команда физически потянет: ${needLine}${t ? `, это в пределах обычного темпа (~${fmt(t.sumMedianMonth)} лидов/мес)` : ""}. `
      + `Вопрос в деньгах: чтобы столько лидов набрать, нужно ~${fmt(o.budgetLower)} сум рекламного бюджета (${o.cplSource}). `
      + `Это НИЖНЯЯ граница — при росте объёма цена лида обычно растёт, фактически выйдет дороже. Есть такой бюджет?`;
  } else if (o.binding === "budget_unknown") {
    s = `✅ Команда потянет${t ? ` (~${fmt(t.sumMedianMonth)} лидов/мес устойчиво)` : ""}: ${needLine}. `
      + `Стоимость назвать не могу — нет данных о цене лида (ни факта по рекламе, ни ориентира). Задайте ориентир цены лида — посчитаю бюджет.`;
  } else if (o.binding === "capacity_unknown") {
    s = `${cap(needLine)}. По команде пока нет истории загрузки — пропускную способность проверить не могу, поэтому «упрётся ли в людей» не скажу. `
      + (o.budgetLower != null ? `По деньгам: ~${fmt(o.budgetLower)} сум рекламного бюджета (${o.cplSource}, нижняя граница).` : `Цену лида назвать тоже нечем — задайте ориентир.`);
  }

  // рычаг конверсии — всегда как альтернатива
  s += `\nРычаг конверсии: сейчас ${o.convPct}% (лид→сделка). Поднять её — и лидов, и бюджета нужно меньше при той же цели.`;
  // приблизительность по новым МОПам
  if (o.thinMops && o.thinMops.length) s += `\n⚠️ По ${o.thinMops.join(", ")} мало истории — их капасити оценочна, цифры по команде приблизительные.`;
  // искажение среднего чека
  if (o.avgCheckInaccurate) s += `\n📎 Расчёт опирается на средний чек, а он сейчас неточен: ${o.avgCheckInaccurate.count} сделок закрыты без суммы (${o.avgCheckInaccurate.sharePct}%). Цифры ориентировочные — точнее станет, когда суммы проставят.`;
  // база из закрытого месяца (текущий ещё пустой)
  if (o.baselineLabel) s += `\n📈 Средний чек и конверсия взяты из закрытого месяца (${o.baselineLabel}) — текущий период ещё пустой. Пересчитаю по факту, когда пойдут продажи.`;
  return s;
}
function cap(x) { return x ? x.charAt(0).toUpperCase() + x.slice(1) : x; }

// ── АСИНХРОННАЯ ОБЁРТКА: собирает входы (цель, воронка, капасити, CPL) и зовёт ядро ──
export async function assessRealism(org = ORG) {
  const goal = await getGoal(org);
  if (!goal || !goal.amountUZS) return { computable: false, reason: "no_goal", feasible: null };
  const funnel = await getVerifiedFunnel(org).catch(() => null);
  const f = funnelFacts(funnel);
  if (!f) return { computable: false, reason: "no_funnel", feasible: null };
  const workdays = goal.period ? await workingDays(goal.period) : null;
  const dash = await rgetJSON("dashboard", null);
  const teamCapacityByMop = (dash && dash.teamCapacity && dash.teamCapacity.byMop) || {};
  const thinMonths = (dash && dash.teamCapacity && dash.teamCapacity.thinMonths) || 3;
  const mopsActiveCount = (dash && Array.isArray(dash.mopsByConv)) ? dash.mopsByConv.length : Object.keys(teamCapacityByMop).length;
  const wna = dash && dash.dataQuality && dash.dataQuality.wonNoAmount;
  const baseInaccurate = (wna && wna.inaccurate) ? { count: wna.count, sharePct: wna.sharePct } : null;
  const { cpl, cplSource } = await resolveCpl(dash);

  // БАЗА avgCheck/конверсии: если текущий месяц ещё пустой (начало периода) — берём ИТОГ ПОСЛЕДНЕГО ЗАКРЫТОГО
  // месяца (planner.getPeriodResults). Иначе достижимая цель считалась бы на тонких/нулевых данных августа.
  let avgCheck = f.avgCheck, conv = f.conv, baselineLabel = null;
  if ((f.sold || 0) < THIN_MONTH_SOLD) {
    const results = await getPeriodResults(org).catch(() => []);
    const last = (results && results.length) ? results[results.length - 1] : null;
    if (last && (last.avgCheckMedian || last.convPct != null)) {
      if (last.avgCheckMedian) avgCheck = last.avgCheckMedian;
      if (last.convPct != null) conv = last.convPct / 100;
      baselineLabel = last.label;
    }
  }
  return assessGoalRealism({
    goalUZS: goal.amountUZS, earned: f.revenue || 0, avgCheck, conv,
    cpl, cplSource, teamCapacityByMop, mopsActiveCount, workdays, baseInaccurate, thinMonths, baselineLabel,
  });
}
