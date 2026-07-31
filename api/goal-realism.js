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
    baselineClosed: !!baselineClosed,
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
    const addPart = o.addManagers > 0 ? `+${o.addManagers} ${plMgr(o.addManagers)}, либо ` : ""; // без людей-числа не пишем «+null»
    s = `❗ Упирается в КОМАНДУ, не в бюджет. Чтобы закрыть цель, ${needLine}. `
      + `Команда за всю историю максимум тянула ~${fmt(t.sumMaxMonth)} лидов/мес (устойчиво ~${fmt(t.sumMedianMonth)}). `
      + `Даже на пределе столько не обработать — рекламный бюджет тут не поможет. `
      + `Достижимо: ${addPart}цель ≤ ${fmt(o.feasibleGoal)} сум выполнима текущими силами на устойчивом темпе.`;
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
  const out = assessGoalRealism({
    goalUZS: goal.amountUZS, earned, avgCheck, conv,
    cpl, cplSource, teamCapacityByMop, mopsActiveCount, workdays, baseInaccurate, thinMonths, baselineLabel, baselineClosed,
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
