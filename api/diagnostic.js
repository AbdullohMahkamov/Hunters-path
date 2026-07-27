// api/diagnostic.js — ДИАГНОСТИЧЕСКИЙ РЕЖИМ советника.
// Открытые «почему X» вопросы с временным окном → оконный анализ ВСЕХ осей (продажи / маркетинг / звонки)
// + сравнение с ПРЕДЫДУЩИМ равным окном + ДЕТЕРМИНИРОВАННЫЕ пороги «отклонение vs шум» (числа в коде,
// LLM их НЕ переоценивает — использует как данность). Синтез (в chat.js) отвечает «отклонение или норма и на какой оси».
//
// Данные (только чтение, без Meta/amoCRM/Telegram напрямую):
//  • продажи по дням — из снимков snap:<date> (накопительные месячные тоталы → разница соседних дней)
//  • маркетинг — marketingagent:history (дневные CTR/CAC/ROAS/spend)
//  • звонки — callanalysis:list:<org> (по callDate/score), с обязательной пометкой малого покрытия
//  • узкое место/цикл — getVerifiedFunnel

import { getVerifiedFunnel } from "./dev-agent.js";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORG = "hunter";
const DAY = 86400000;

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }

// ПОРОГИ «отклонение vs шум» — согласованные числа (Пуассон/σ при текущих объёмах). Тюнятся тут при накоплении истории.
export const THRESHOLDS = {
  salesPct: 35,        // продажи окно-vs-окно: ±35% ≈ 1σ Пуассона при ~8 продаж/нед
  revenuePct: 35,
  leadsPct: 20,        // лиды объёмнее → порог туже
  zeroSalesStreak: 3,  // ≥3 нулевых дня подряд = аномалия (2 = шум при цикле ~2.2 дн)
  ctrPct: 20, cplPct: 25, spendPct: 30,
  callScoreDrop: 15,   // падение средней оценки звонков ≥15 п.
  callMinSample: 5,    // …и не меньше 5 разборов в окне, иначе insufficient
};

function tkDay(offset = 0) { return new Date(Date.now() + 5 * 3600000 - offset * DAY).toISOString().slice(0, 10); }

// ── ОКНО АНАЛИЗА ──
export function resolveDiagWindow(text, funnel) {
  const t = String(text || "").toLowerCase();
  let explicit = 0;
  const m = t.match(/(\d+)\s*(дн|day|kun)/);
  if (m) explicit = parseInt(m[1], 10);
  else if (/недел|week|hafta/.test(t)) explicit = 7;
  else if (/месяц|month|\boy\b/.test(t)) explicit = 30;
  const cycle = (funnel && funnel.dealCycle && funnel.dealCycle.companyMedianDays) || 2.2;
  const contextDays = Math.max(7, Math.ceil(3 * cycle));
  const windowDays = Math.max(explicit || 0, contextDays);
  const winSet = new Set(Array.from({ length: windowDays }, (_, i) => tkDay(i)));                 // последние N дней
  const prevSet = new Set(Array.from({ length: windowDays }, (_, i) => tkDay(windowDays + i)));    // предыдущие N дней
  return { windowDays, explicit: explicit || null, contextDays, cycle, winSet, prevSet,
    reason: `окно ${windowDays} дн (макс из: явное ${explicit || "—"}, 7, 3×цикл ${cycle})` };
}

const pctDelta = (now, prev) => (now == null || prev == null || prev === 0) ? null : +(((now - prev) / Math.abs(prev)) * 100).toFixed(1);

// ── ОСЬ ПРОДАЖИ (из снимков) ──
async function salesAxis(win) {
  const list = (await rgetJSON("snap:list", [])) || [];
  const need = list.slice(-(win.windowDays * 2 + 2));
  const snaps = {};
  for (const d of need) { const s = await rgetJSON(`snap:${d}`, null); if (s) snaps[d] = s; }
  const dates = Object.keys(snaps).sort();
  if (dates.length < 3) return { deviation: "insufficient", note: "недостаточно снимков для оконного сравнения" };
  // суммы per-day дельт по полю в наборе дат
  const sumField = (field, set) => {
    let sum = 0, ok = false;
    for (let i = 1; i < dates.length; i++) {
      const d = dates[i]; if (!set.has(d)) continue;
      const a = snaps[d][field], b = snaps[dates[i - 1]][field];
      if (a == null || b == null) continue;
      const delta = a - b; if (delta < 0) continue;   // отрицательное = смена месяца, пропускаем
      sum += delta; ok = true;
    }
    return ok ? sum : null;
  };
  const soldW = sumField("sold", win.winSet), soldP = sumField("sold", win.prevSet);
  const revW = sumField("revenue", win.winSet), revP = sumField("revenue", win.prevSet);
  const leadsW = sumField("leads", win.winSet), leadsP = sumField("leads", win.prevSet);
  // серия нулевых дней продаж (самые свежие дни подряд с 0 продаж)
  let streak = 0;
  for (let i = dates.length - 1; i >= 1; i--) {
    const a = snaps[dates[i]].sold, b = snaps[dates[i - 1]].sold;
    if (a == null || b == null) break;
    const delta = a - b; if (delta < 0) break;
    if (delta === 0) streak++; else break;
  }
  const soldPct = pctDelta(soldW, soldP), revPct = pctDelta(revW, revP), leadsPct = pctDelta(leadsW, leadsP);
  const dev = (streak >= THRESHOLDS.zeroSalesStreak)
    || (soldPct != null && Math.abs(soldPct) >= THRESHOLDS.salesPct)
    || (revPct != null && Math.abs(revPct) >= THRESHOLDS.revenuePct)
    || (leadsPct != null && Math.abs(leadsPct) >= THRESHOLDS.leadsPct);
  const canCompare = soldPct != null || revPct != null;
  return {
    deviation: dev ? "yes" : (canCompare || streak > 0 ? "no" : "insufficient"),
    sold: { window: soldW, prev: soldP, deltaPct: soldPct, threshold: THRESHOLDS.salesPct },
    revenue: { window: revW, prev: revP, deltaPct: revPct, threshold: THRESHOLDS.revenuePct },
    leads: { window: leadsW, prev: leadsP, deltaPct: leadsPct, threshold: THRESHOLDS.leadsPct },
    zeroSalesStreakDays: streak, zeroStreakThreshold: THRESHOLDS.zeroSalesStreak,
    note: canCompare ? null : "предыдущего окна для сравнения мало — вывод по текущему окну и серии нулей",
  };
}

// ── ОСЬ МАРКЕТИНГ (из marketingagent:history) ──
async function marketingAxis(win) {
  const hist = (await rgetJSON("marketingagent:history", [])) || [];
  if (!hist.length) return { deviation: "insufficient", note: "истории маркетинга пока нет (marketing-agent недавно запущен)" };
  const avg = (arr, f) => { const v = arr.map((x) => x[f]).filter((x) => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; };
  const wPts = hist.filter((h) => win.winSet.has(h.day));
  const pPts = hist.filter((h) => win.prevSet.has(h.day));
  if (wPts.length < 2 || pPts.length < 2) return { deviation: "insufficient", note: `мало дневных точек (окно ${wPts.length}, пред. ${pPts.length}) — сравнивать рано`, windowPoints: wPts.length };
  const ctrPct = pctDelta(avg(wPts, "accountCtr"), avg(pPts, "accountCtr"));
  const spendPct = pctDelta(avg(wPts, "totalSpend"), avg(pPts, "totalSpend"));
  const cacPct = pctDelta(avg(wPts, "cac"), avg(pPts, "cac"));
  const dev = (ctrPct != null && Math.abs(ctrPct) >= THRESHOLDS.ctrPct)
    || (cacPct != null && Math.abs(cacPct) >= THRESHOLDS.cplPct)
    || (spendPct != null && Math.abs(spendPct) >= THRESHOLDS.spendPct);
  return {
    deviation: dev ? "yes" : "no",
    ctr: { deltaPct: ctrPct, threshold: THRESHOLDS.ctrPct },
    cac: { deltaPct: cacPct, threshold: THRESHOLDS.cplPct },
    spend: { deltaPct: spendPct, threshold: THRESHOLDS.spendPct },
  };
}

// ── ОСЬ ЗВОНКИ (из callanalysis:list, по callDate/score) — с обязательной пометкой малого покрытия ──
async function callsAxis(win) {
  const all = (await rgetJSON(`callanalysis:list:${ORG}`, [])) || [];
  const done = all.filter((x) => x.state === "done" && x.callDate && x.score != null);
  if (!done.length) return { deviation: "insufficient", note: "разборов звонков нет" };
  const inSet = (set) => done.filter((x) => set.has(String(x.callDate).slice(0, 10)));
  const wCalls = inSet(win.winSet), pCalls = inSet(win.prevSet);
  const avg = (a) => a.length ? +(a.reduce((s, x) => s + x.score, 0) / a.length).toFixed(1) : null;
  const wScore = avg(wCalls), pScore = avg(pCalls);
  if (wCalls.length < THRESHOLDS.callMinSample) return { deviation: "insufficient", windowCount: wCalls.length, note: `в окне разобрано ${wCalls.length} звонк(ов) (<${THRESHOLDS.callMinSample}) — качество звонков за окно не диагностируется, покрытие ничтожно` };
  const drop = (pScore != null && wScore != null) ? +(pScore - wScore).toFixed(1) : null;
  const dev = drop != null && drop >= THRESHOLDS.callScoreDrop;
  return { deviation: dev ? "yes" : (drop != null ? "no" : "insufficient"), windowCount: wCalls.length, prevCount: pCalls.length, windowAvgScore: wScore, prevAvgScore: pScore, scoreDrop: drop, threshold: THRESHOLDS.callScoreDrop, note: `покрытие ничтожно (${wCalls.length} разборов) — вывод по звонкам это ГИПОТЕЗА, не факт` };
}

// ── СБОРКА ──
export async function buildDiagnosticBundle(org = ORG, text = "") {
  const funnel = await getVerifiedFunnel(org).catch(() => null);
  const win = resolveDiagWindow(text, funnel);
  const [sales, marketing, calls] = await Promise.all([salesAxis(win).catch(() => ({ deviation: "insufficient" })), marketingAxis(win).catch(() => ({ deviation: "insufficient" })), callsAxis(win).catch(() => ({ deviation: "insufficient" }))]);
  const deviations = [];
  if (sales.deviation === "yes") deviations.push("продажи/лиды");
  if (marketing.deviation === "yes") deviations.push("маркетинг");
  if (calls.deviation === "yes") deviations.push("качество звонков");
  const verdict = deviations.length ? `ОТКЛОНЕНИЕ на оси: ${deviations.join(", ")}` : "в пределах нормальных колебаний (по заданным порогам)";
  return {
    window: { days: win.windowDays, explicit: win.explicit, cycleDays: win.cycle, reason: win.reason },
    funnel: funnel ? { bottleneck: funnel.bottleneck, telephonySuspicious: funnel.telephonySuspicious, dealCycleMedianDays: funnel.dealCycle && funnel.dealCycle.companyMedianDays } : null,
    sales, marketing, calls, deviations, verdict, thresholds: THRESHOLDS,
  };
}

// текст для контекста советника (LLM получает вердикты+числа как ДАННОСТЬ)
export function formatDiagnostic(b) {
  const f = (v) => v == null ? "н/д" : (typeof v === "number" ? v.toLocaleString("ru-RU") : v);
  const pct = (x) => x == null ? "н/д" : (x > 0 ? "+" : "") + x + "%";
  let s = `\n\n=== ДИАГНОСТИКА ЗА ОКНО (${b.window.days} дн; ${b.window.reason}) ===\n`;
  s += `ГОТОВЫЙ ВЕРДИКТ ПО ПОРОГАМ (используй как ДАННОСТЬ, НЕ переоценивай «много/мало»): ${b.verdict}\n\n`;
  // продажи
  const S = b.sales;
  if (S.deviation === "insufficient") s += `Продажи: ${S.note || "недостаточно данных"}\n`;
  else {
    s += `Продажи (окно vs пред. окно): продаж ${f(S.sold.window)} vs ${f(S.sold.prev)} (${pct(S.sold.deltaPct)}, порог ±${S.sold.threshold}%); выручка ${pct(S.revenue.deltaPct)}; лиды ${pct(S.leads.deltaPct)} (порог ±${S.leads.threshold}%). Серия нулевых дней подряд: ${S.zeroSalesStreakDays} (тревога при ≥${S.zeroStreakThreshold}). Вердикт оси: ${S.deviation === "yes" ? "ОТКЛОНЕНИЕ" : "норма"}.\n`;
    if (S.note) s += `  (${S.note})\n`;
  }
  // маркетинг
  const M = b.marketing;
  if (M.deviation === "insufficient") s += `Маркетинг: ${M.note || "недостаточно данных"}\n`;
  else s += `Маркетинг (окно vs пред.): CTR ${pct(M.ctr.deltaPct)} (порог ±${M.ctr.threshold}%), CAC ${pct(M.cac.deltaPct)} (±${M.cac.threshold}%), расход ${pct(M.spend.deltaPct)} (±${M.spend.threshold}%). Вердикт: ${M.deviation === "yes" ? "ОТКЛОНЕНИЕ" : "норма"}.\n`;
  // звонки
  const C = b.calls;
  if (C.deviation === "insufficient") s += `Звонки: ${C.note || "недостаточно данных"}\n`;
  else s += `Звонки (окно vs пред.): средняя оценка ${f(C.windowAvgScore)} vs ${f(C.prevAvgScore)} (падение ${f(C.scoreDrop)} п., порог ≥${C.threshold}; разборов в окне ${C.windowCount}). ${C.note}. Вердикт: ${C.deviation === "yes" ? "ОТКЛОНЕНИЕ" : "норма"}.\n`;
  if (b.funnel && b.funnel.bottleneck) s += `Узкое место воронки: ${b.funnel.bottleneck.stage} (${b.funnel.bottleneck.pct}%). Медианный цикл сделки: ${b.funnel.dealCycleMedianDays} дн.\n`;
  return s;
}
