// /api/deepsales.js — интеграция с DeepSales (анализ звонков).
// Секреты ТОЛЬКО из переменных окружения (никогда не из тела/чата):
//   DEEPSALES_EMAIL / DEEPSALES_PASSWORD — Basic-авторизация на audio-analyze
//   DEEPSALES_BEARER_TOKEN — Bearer на dashboard-эндпоинты (call-analysis, transcription)
// Отправка аудио идёт СО СТОРОНЫ СЕРВЕРА (Vercel скачивает запись из amoCRM и шлёт в DeepSales) —
// клиентские записи не проходят через локальную машину/переписку.
//
// action=analyze  body:{ items:[{link, crm_manager_id, leadId}] } → скачать .wav → POST audio-analyze → audio_id
// action=result   body:{ ids:[audio_id] } | ?audio_id=  → GET call-analysis + transcription (Bearer)
// Лимиты DeepSales: 60/мин dashboard (audio-analyze), 600/мин analysis (call-analysis/transcription) — заложены паузами.

import { getVerifiedFunnel } from "./dev-agent.js"; // для «разговор→сделка» в baseline/progress
import { sendDigest } from "./digest.js"; // компактные метрики владельцу в Digest-бот (owner-путь)
import { sendTg, getPeople } from "./tg-bot.js"; // план на подтверждение — в owner-бот (кнопки)

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DS = "https://dashboard.deepsales.uz";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// МОПы: amoCRM user id → имя (тот же маппинг, что в sync-speed HUNTER_CFG.mops)
const MOPS = { 13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda", 13833590: "Begoyim", 13681582: "Abulbositxon" };
// имя МОПа → manager_id в DeepSales (реальные аккаунты менеджеров, заведены владельцем).
// НЕ секрет — это внутренние id аккаунтов, держим в коде рядом с маппингом имён.
// 1443 («Hunter») — технический аккаунт, остаётся фолбэком для звонков без опознанного МОПа.
const DS_MANAGERS = { "Abdulla-Legenda": 1444, "Samandar": 1445, "Begoyim": 1446, "Komiljon": 1447, "Abulbositxon": 1448 };

async function getSession(session) {
  if (!session || !REDIS_URL) return null;
  try {
    const r = await fetch(`${REDIS_URL}/get/session:${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const d = await r.json();
    return d && d.result ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}

// ===== ХРАНЕНИЕ РАЗБОРОВ ЗВОНКОВ =====
// callanalysis:${org}:${leadId} → массив записей (у лида может быть несколько разобранных звонков)
// callanalysis:list:${org}      → лёгкий индекс (таблица + статистика без чтения полных записей)
async function rgetJSON(key, dflt) {
  try {
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const d = await r.json();
    return d && d.result != null ? JSON.parse(d.result) : dflt;
  } catch (e) { return dflt; }
}
async function rsetJSON(key, v) {
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) });
    return true;
  } catch (e) { return false; }
}
const CA_KEY = (org, leadId) => `callanalysis:${org}:${leadId}`;
const CA_LIST = (org) => `callanalysis:list:${org}`;

// «Главная проблема звонка» одной строкой — детерминированно, без ИИ: ошибка, привязанная
// к критерию с НАИМЕНЬШИМ баллом; фолбэк — первая ошибка; иначе итог разговора.
function headlineOf(ca) {
  const ms = (ca && ca.mistakes) || [];
  if (!ms.length) return String((ca && ca.final_outcome) || "явных ошибок не найдено").slice(0, 110);
  const cs = (ca && ca.criteria_scores) || {};
  let best = ms[0], bestScore = Infinity;
  for (const m of ms) {
    const sc = m.criterion_code != null && cs[m.criterion_code] != null ? Number(cs[m.criterion_code]) : null;
    if (sc != null && sc < bestScore) { bestScore = sc; best = m; }
  }
  return String(best.mistake || "").slice(0, 110);
}
async function caIndexUpsert(org, row) {
  const list = await rgetJSON(CA_LIST(org), []);
  const i = list.findIndex((x) => String(x.audioFileId) === String(row.audioFileId));
  if (i >= 0) list[i] = { ...list[i], ...row }; else list.push(row);
  list.sort((a, b) => String(b.callDate || "").localeCompare(String(a.callDate || "")));
  await rsetJSON(CA_LIST(org), list.slice(0, 500));
}
async function caRecordUpsert(org, leadId, rec) {
  const arr = await rgetJSON(CA_KEY(org, leadId), []);
  const i = arr.findIndex((x) => String(x.audioFileId) === String(rec.audioFileId));
  if (i >= 0) arr[i] = { ...arr[i], ...rec }; else arr.push(rec);
  await rsetJSON(CA_KEY(org, leadId), arr);
}

// ===== БАНДЛ ДЛЯ АГЕНТОВ =====
// Единый источник разборов звонков для MOP-Agent / Task-Agent / чата.
// ЖЁСТКО несёт coverage: выборка мала и НЕ случайна — агент обязан это произносить
// при КАЖДОМ упоминании конкретного МОПа, иначе получится вывод о человеке по 4% данных.
export async function getCallAnalysisBundle(org = "hunter") {
  const all = await rgetJSON(CA_LIST(org), []);
  const list = all.filter((x) => x.state === "done");
  if (!list.length) return { coverage: { analyzed: 0 }, team: null, byMop: {}, recent: [], disclaimer: "разборов звонков ещё нет — не ссылайся на них" };
  // знаменатель покрытия: оценка звонков МОПа за ТЕКУЩИЙ месяц из speed (leads × avgCallsPerLead)
  const speed = await rgetJSON(org === "hunter" ? "speed" : `speed:${org}`, null);
  const monthCalls = {};
  for (const m of ((speed && speed.mops) || [])) {
    const est = Math.round((m.leads || 0) * (m.avgCallsPerLead || 0));
    if (est > 0) monthCalls[m.name] = est;
  }
  const avg = (a) => (a.length ? +(a.reduce((s, x) => s + x, 0) / a.length).toFixed(1) : null);
  const grp = (f) => { const o = {}; for (const x of list) { const k = f(x); if (!k) continue; (o[k] = o[k] || []).push(x); } return o; };
  const tally = (arr, key) => { const o = {}; for (const x of arr) for (const t of (x[key] || [])) o[t] = (o[t] || 0) + 1; return o; };
  // средний балл по каждому критерию DeepSales (code-agnostic): работает с любыми настроенными
  // критериями, включая новый "Mahsulot haqida to'g'ri va rasmiy ma'lumot berish" (ось достоверности).
  const critAvg = (arr) => {
    const codes = new Set();
    for (const x of arr) for (const k of Object.keys(x.criteriaScores || {})) codes.add(k);
    const o = {};
    for (const k of codes) { const vals = arr.map((x) => x.criteriaScores && x.criteriaScores[k]).filter((v) => v != null); if (vals.length) o[k] = { avg: avg(vals), n: vals.length }; }
    return o;
  };
  const stat = (arr) => (arr && arr.length ? {
    n: arr.length,
    talkRatio: avg(arr.map((x) => x.talkRatio).filter((v) => v != null)),
    avgScore: avg(arr.map((x) => x.score).filter((v) => v != null)),
    mistakesPerCall: avg(arr.map((x) => x.mistakesCount || 0)),
    mistakeTags: tally(arr, "mistakeTags"), objectionTags: tally(arr, "objectionTags"),
    criteriaAvg: critAvg(arr),
  } : null);
  const dates = list.map((x) => x.callDate).filter(Boolean).sort();
  const byStatus = grp((x) => x.status);
  const byMop = {};
  for (const [name, arr] of Object.entries(grp((x) => x.mop))) {
    byMop[name] = { ...stat(arr), analyzed: arr.length,
      monthCallsEstimate: monthCalls[name] || null,
      sharePctApprox: monthCalls[name] ? +(arr.length / monthCalls[name] * 100).toFixed(1) : null };
  }
  // ── РЕЙТИНГ МОПов по ТЕКУЩЕМУ критерию (единая шкала) ──
  // Балл overallScore при РАЗНЫХ критериях несравним (старые прогоны — другая шкала). Поэтому
  // рейтинг считаем только по записям с самым частым (= текущим) кодом критерия. Это авто-адаптируется:
  // по мере новых прогонов текущий критерий вытесняет старые.
  const codeFreq = {};
  for (const x of list) for (const k of Object.keys(x.criteriaScores || {})) codeFreq[k] = (codeFreq[k] || 0) + 1;
  const currentCriterion = Object.keys(codeFreq).sort((a, b) => codeFreq[b] - codeFreq[a])[0] || null;
  const rating = [];
  for (const [name, arr] of Object.entries(grp((x) => x.mop))) {
    const cur = currentCriterion ? arr.filter((x) => x.criteriaScores && x.criteriaScores[currentCriterion] != null) : arr;
    if (!cur.length) continue;
    const won = cur.filter((x) => x.status === "won"), lost = cur.filter((x) => x.status === "lost");
    rating.push({
      mop: name, n: cur.length,
      avgScore: avg(cur.map((x) => x.score).filter((v) => v != null)),
      wonScore: won.length ? avg(won.map((x) => x.score).filter((v) => v != null)) : null,
      lostScore: lost.length ? avg(lost.map((x) => x.score).filter((v) => v != null)) : null,
      talkRatio: avg(cur.map((x) => x.talkRatio).filter((v) => v != null)),
      mistakesPerCall: avg(cur.map((x) => x.mistakesCount || 0)),
      analyzed: byMop[name].analyzed, sharePctApprox: byMop[name].sharePctApprox,
    });
  }
  rating.sort((a, b) => (b.avgScore || 0) - (a.avgScore || 0));
  return {
    rating, currentCriterion,
    coverage: {
      analyzed: list.length,
      window: { from: dates[0] || null, to: dates[dates.length - 1] || null },
      byMop: Object.fromEntries(Object.entries(byMop).map(([k, v]) => [k, { analyzed: v.analyzed, monthCallsEstimate: v.monthCallsEstimate, sharePctApprox: v.sharePctApprox }])),
      denominatorNote: "monthCallsEstimate — ОЦЕНКА числа звонков МОПа за ТЕКУЩИЙ месяц (speed: leads×avgCallsPerLead). Окно выборки шире месяца, поэтому sharePctApprox — верхняя граница доли.",
      sampling: "НЕ случайная выборка: брались только звонки 2-4 мин по лидам со статусом won/lost. Это качественный сигнал, НЕ статистическая оценка.",
      lastAnalyzedAt: list.map((x) => x.analyzedAt).filter(Boolean).sort().pop() || null,
    },
    team: { won: stat(byStatus.won || []), lost: stat(byStatus.lost || []), all: stat(list) },
    byMop,
    recent: list.slice(0, 20).map((x) => ({ leadId: x.leadId, mop: x.mop, status: x.status, callDate: x.callDate, score: x.score, talkRatio: x.talkRatio, headline: x.headline })),
    disclaimer: "ОБЯЗАТЕЛЬНО И БЕЗ ИСКЛЮЧЕНИЙ: при ЛЮБОМ упоминании данных конкретного МОПа называй покрытие — сколько его звонков проанализировано из скольких и долю (byMop[имя].analyzed / monthCallsEstimate / sharePctApprox). Выборка мала и НЕ случайна: это повод проверить вручную, а не вывод о человеке. Фразы вида «Х плохо закрывает» без указания доли — ЗАПРЕЩЕНЫ.",
  };
}

// ===== ПЛАНИРОВЩИК НЕДЕЛЬНОГО БЮДЖЕТА ТРАНСКРИБАЦИИ =====
// Раз в неделю решает, СКОЛЬКО звонков и ЧЬИХ слать на анализ, чтобы дефицитные минуты шли туда,
// где полезнее, а не поровну. Две оси → приоритет = ХУДШАЯ из них. Нет данных по достоверности —
// НЕ выдумываем: помечаем «недостаточно данных» и приоритет ведём ТОЛЬКО по продажам.
const PLAN_CFG_KEY = (org) => `transcriptplan:cfg:${org}`;
async function planCfg(org) {
  const d = await rgetJSON(PLAN_CFG_KEY(org), {}) || {};
  return {
    weeklyMinutes: d.weeklyMinutes != null ? d.weeklyMinutes : 70,   // недельный лимит минут (файла)
    avgMinPerCall: d.avgMinPerCall != null ? d.avgMinPerCall : 3,    // ~средняя длительность файла, мин
    reliabilityCode: d.reliabilityCode || null,                      // код критерия достоверности (ставим, когда узнаем)
    sales: { lowRatio: d.salesLowRatio != null ? d.salesLowRatio : 0.8, highRatio: d.salesHighRatio != null ? d.salesHighRatio : 1.2 },
    reliability: { low: d.reliabilityLow != null ? d.reliabilityLow : 15, high: d.reliabilityHigh != null ? d.reliabilityHigh : 30 }, // пороги провизорные до уточнения шкалы
  };
}
export async function getWeeklyTranscriptionPlan(org = "hunter") {
  const cfg = await planCfg(org);
  const dash = await rgetJSON(org === "hunter" ? "dashboard" : `dashboard:${org}`, null);
  const ca = await getCallAnalysisBundle(org).catch(() => null);
  const mopsByConv = (dash && dash.mopsByConv) || [];
  const withLeads = mopsByConv.filter((m) => (m.leads || 0) > 0);
  const teamConv = withLeads.length ? +(withLeads.reduce((s, m) => s + (m.conv || 0), 0) / withLeads.length).toFixed(2) : 0;
  const rank = { low: 1, medium: 2, high: 3 }; // performance rank: low = хуже = приоритетнее
  const rows = [];
  for (const m of withLeads) {
    // ── ось ПРОДАЖИ (performance): conv относительно среднего по команде ──
    const ratio = teamConv > 0 ? (m.conv || 0) / teamConv : 1;
    const salesPerf = ratio >= cfg.sales.highRatio ? "high" : (ratio <= cfg.sales.lowRatio ? "low" : "medium");
    // ── ось ДОСТОВЕРНОСТЬ: балл нужного критерия. Нет кода/нет данных → НЕ считаем осью ──
    const cell = cfg.reliabilityCode && ca && ca.byMop && ca.byMop[m.name] && ca.byMop[m.name].criteriaAvg && ca.byMop[m.name].criteriaAvg[cfg.reliabilityCode];
    let relPerf = null, relScore = null, relN = 0, relNote = null;
    if (cell && cell.n > 0) { relScore = cell.avg; relN = cell.n; relPerf = relScore >= cfg.reliability.high ? "high" : (relScore <= cfg.reliability.low ? "low" : "medium"); }
    else relNote = cfg.reliabilityCode ? "недостаточно данных по оси достоверности (критерий отсутствует в разобранных звонках МОПа) — приоритет только по продажам" : "код критерия достоверности не задан — ось выключена, приоритет только по продажам";
    // ── приоритет = ХУДШАЯ (минимальная performance) из доступных осей ──
    const perfs = [salesPerf]; if (relPerf) perfs.push(relPerf);
    const worstRank = Math.min(...perfs.map((p) => rank[p]));
    const overall = worstRank === 1 ? "low" : (worstRank === 2 ? "medium" : "high");
    const weight = 4 - worstRank; // low-perf(1)→вес 3 (больше звонков), high-perf(3)→вес 1
    rows.push({ mop: m.name, conv: m.conv, sold: m.sold, leads: m.leads, salesPerf, ratioToTeam: +ratio.toFixed(2), relPerf, relScore, relN, relNote, overallPerf: overall, priorityWeight: weight });
  }
  const totalW = rows.reduce((s, r) => s + r.priorityWeight, 0) || 1;
  for (const r of rows) {
    r.minutesBudget = +(cfg.weeklyMinutes * r.priorityWeight / totalW).toFixed(1);
    r.calls = Math.max(0, Math.round(r.minutesBudget / cfg.avgMinPerCall));
  }
  rows.sort((a, b) => b.priorityWeight - a.priorityWeight || (a.conv - b.conv));
  return {
    org, generatedForWeekOf: null, // проставляется вызывающей стороной (в скрипте нет Date-ограничений)
    config: cfg, teamConv,
    plan: rows,
    totals: { weeklyMinutesLimit: cfg.weeklyMinutes, plannedCalls: rows.reduce((s, r) => s + r.calls, 0), plannedMinutes: +rows.reduce((s, r) => s + r.calls * cfg.avgMinPerCall, 0).toFixed(1) },
    reliabilityAxis: cfg.reliabilityCode ? `критерий ${cfg.reliabilityCode}` : "ВЫКЛЮЧЕНА (код критерия достоверности не задан) — план только по продажам",
    disclaimer: "Ось достоверности основана на КРОШЕЧНОЙ невыборочной выборке разборов — это ОДИН из сигналов приоритизации бюджета, НЕ оценка МОПа. Где данных по критерию нет — приоритет только по продажам, отсутствующее НЕ додумывается.",
  };
}

// ── BASELINE / PROGRESS ── снимок «до» + сравнение «стало» (кейс роста Hunter Academy + материал продукта).
async function computeBaselineSnapshot(org) {
  const ca = await getCallAnalysisBundle(org).catch(() => null);
  const dash = await rgetJSON(org === "hunter" ? "dashboard" : `dashboard:${org}`, null);
  let dealConvPct = null, dealConvTrust = null;
  try {
    const f = await getVerifiedFunnel(org);
    const st = (f.stages || []).find((s) => s.transitionFromPrev && /разговор.*сделк/i.test(s.transitionFromPrev.name || ""));
    if (st) { dealConvPct = st.transitionFromPrev.pct; dealConvTrust = st.transitionFromPrev.trust; }
  } catch (e) {}
  const mops = (dash && dash.mopsByConv) || [];
  const team = ca && ca.team && ca.team.all ? ca.team.all : null;
  return {
    dealConvPct, dealConvTrust,                       // «разговор→сделка» (verified), %
    teamDsScore: team ? team.avgScore : null,         // средний балл команды по DeepSales-критерию
    violations: team ? team.mistakeTags || {} : {},   // частота нарушений: {company_info(ложные гарантии), greeting, close…}
    objections: team ? team.objectionTags || {} : {},
    perMop: mops.map((m) => {
      const r = ca && ca.rating ? ca.rating.find((x) => x.mop === m.name) : null;
      return { mop: m.name, conv: m.conv != null ? m.conv : null, sold: m.sold, leads: m.leads, dsScore: r ? r.avgScore : null, analyzed: r ? r.analyzed : 0, mistakesPerCall: r ? r.mistakesPerCall : null };
    }),
    caCoverage: ca && ca.coverage ? { analyzed: ca.coverage.analyzed, window: ca.coverage.window } : null,
  };
}
function diffSnapshots(base, now) {
  const d = (a, bb, p) => (a != null && bb != null) ? +(bb - a).toFixed(p) : null;
  const vio = {}; const tags = new Set([...Object.keys(base.violations || {}), ...Object.keys(now.violations || {})]);
  for (const t of tags) { const f = (base.violations || {})[t] || 0, tt = (now.violations || {})[t] || 0; vio[t] = { from: f, to: tt, delta: tt - f }; }
  const perMop = (now.perMop || []).map((m) => { const bm = (base.perMop || []).find((x) => x.mop === m.mop) || {}; return { mop: m.mop, conv: { from: bm.conv, to: m.conv, delta: d(bm.conv, m.conv, 2) }, dsScore: { from: bm.dsScore, to: m.dsScore, delta: d(bm.dsScore, m.dsScore, 1) } }; });
  return { dealConv: { from: base.dealConvPct, to: now.dealConvPct, delta: d(base.dealConvPct, now.dealConvPct, 2) }, teamDsScore: { from: base.teamDsScore, to: now.teamDsScore, delta: d(base.teamDsScore, now.teamDsScore, 1) }, violations: vio, perMop };
}

// ── КОМПАКТНАЯ СВОДКА МЕТРИК ВЛАДЕЛЬЦУ (owner-путь): цифры + Δ к прошлой неделе. БЕЗ разборов нарушений — детали у РОПа.
const LASTMETRICS_KEY = (org) => `progress:lastmetrics:${org}`;
function mDelta(delta, unit) { if (delta == null || delta === 0) return ""; return ` (${delta > 0 ? "▲+" : "▼"}${delta}${unit || ""})`; }
async function buildMetricsDigest(org) {
  const now = await computeBaselineSnapshot(org);
  const last = await rgetJSON(LASTMETRICS_KEY(org), null);
  const base = await rgetJSON(`progress:baseline:${org}`, null);
  const cmp = last || base;
  const d = (a, b, p) => (a != null && b != null) ? +(b - a).toFixed(p) : null;
  const cov = now.caCoverage || {};
  const perMop = (now.perMop || []).slice().sort((a, b) => (b.dsScore || 0) - (a.dsScore || 0));
  let s = `📊 <b>Звонки — сводка метрик</b>\n\n`;
  s += `Разговор→сделка: <b>${now.dealConvPct != null ? now.dealConvPct + "%" : "—"}</b>${mDelta(cmp ? d(cmp.dealConvPct, now.dealConvPct, 2) : null, " п.п.")}\n`;
  s += `Средний балл звонков: <b>${now.teamDsScore != null ? now.teamDsScore : "—"}</b>${mDelta(cmp ? d(cmp.teamDsScore, now.teamDsScore, 1) : null, "")}\n`;
  s += `Разобрано: <b>${cov.analyzed || 0}</b> звонков${cov.window ? ` (по ${cov.window.to})` : ""}\n\n`;
  s += `<b>По менеджерам</b> (балл · конверсия):\n`;
  for (const m of perMop) s += `• ${m.mop}: ${m.dsScore != null ? m.dsScore : "—"} · ${m.conv != null ? m.conv + "%" : "—"}\n`;
  s += `\n<i>${last ? "Δ — к прошлой сводке" : (base ? "Δ — к старту (baseline)" : "первая сводка — Δ появится со следующей")}. Детальные разборы и задания команде — у РОПа.</i>`;
  return s;
}

// Недельный план транскрибации → владельцу в Digest как ПРЕДЛОЖЕНИЕ (анализ не запускается сам).
async function buildPlanDigest(org) {
  const p = await getWeeklyTranscriptionPlan(org);
  const rows = p.plan || [];
  const lvl = (x) => x === "low" ? "🔴 плотно" : x === "medium" ? "🟡 средне" : "🟢 эталон";
  let s = `🗓 <b>План разбора звонков на неделю</b>\n\n`;
  s += `Бюджет: <b>${p.totals.weeklyMinutesLimit} мин</b> (~${p.totals.plannedCalls} звонков). Приоритет — где хуже из двух осей: продажи × достоверность.\n\n`;
  for (const r of rows) s += `• <b>${r.mop}</b>: ${r.calls} зв · ${r.minutesBudget} мин — ${lvl(r.overallPerf)}\n`;
  s += `\nИтого <b>${p.totals.plannedCalls} звонков / ${p.totals.plannedMinutes} мин</b>.\n<i>Это ПРЕДЛОЖЕНИЕ — анализ НЕ запущен. Подтвердите запуск, чтобы начать разбор по этому плану.</i>`;
  return s;
}

// Решение владельца по недельному плану (кнопки owner-бота tplan:run|review|decline).
async function sendPlanProposal(org) {
  const plan = await getWeeklyTranscriptionPlan(org);
  await rsetJSON(`transcriptplan:pending:${org}`, { at: Date.now(), plan: plan.plan, totals: plan.totals, confirmed: false, declined: false });
  const people = await getPeople();
  if (!(people.owner && people.owner.chatId)) return;
  const kb = { reply_markup: { inline_keyboard: [
    [{ text: "✅ Запустить", callback_data: "tplan:run" }, { text: "🔄 Пересмотр", callback_data: "tplan:review" }],
    [{ text: "✖️ Отказ", callback_data: "tplan:decline" }],
  ] } };
  await sendTg("owner", people.owner.chatId, await buildPlanDigest(org), kb);
}
// self-call к своим же action'ам (audit-pick/analyze) — по CRON_SECRET, чтобы изолировать тяжёлые шаги по одному вызову.
const SELF_BASE = "https://hunters-path.vercel.app/api/deepsales";
async function selfCall(body) {
  const cs = process.env.CRON_SECRET || "";
  try { const r = await fetch(SELF_BASE, { method: "POST", headers: { "content-type": "application/json", ...(cs ? { Authorization: `Bearer ${cs}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(250000) }); return await r.json(); } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}
// ИСПОЛНИТЕЛЬ (ДНЕВНОЙ РИТМ): недельный бюджет тратится РАВНОМЕРНО по дням (≈недельная норма/7 в день на МОПа).
// Один вызов = дневная порция ОДНОГО МОПа (audit-pick без оплаты → analyze с оплатой; дедуп внутри audit-pick).
// Крон дёргает несколько раз в день → каждый МОП получает свою дневную порцию; прогресс виден каждый день.
async function execDaily(org) {
  const key = `transcriptplan:pending:${org}`;
  const pend = await rgetJSON(key, null);
  if (!pend || !pend.confirmed || !pend.spend) return { done: true, note: "нет активного запуска" };
  const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10); // дата по Ташкенту
  pend.spend.byMop = pend.spend.byMop || {};
  pend.spend.daily = pend.spend.daily || {};
  pend.spend.daily[today] = pend.spend.daily[today] || {};
  const dayMap = pend.spend.daily[today];
  const plan = pend.plan || [];
  const perMin = (pend.totals && pend.totals.plannedCalls) ? pend.totals.plannedMinutes / pend.totals.plannedCalls : 3;
  // следующий МОП: дневная норма (недельная/7) ещё не выбрана И недельный кап не достигнут
  let target = null, need = 0;
  for (const r of plan) {
    if (!(r.calls > 0)) continue;
    const dailyTarget = Math.max(1, Math.round(r.calls / 7));
    const sentToday = dayMap[r.mop] || 0;
    const weeklySent = pend.spend.byMop[r.mop] || 0;
    if (sentToday >= dailyTarget || weeklySent >= r.calls) continue;
    target = r; need = Math.min(dailyTarget - sentToday, r.calls - weeklySent); break;
  }
  if (!target) {
    const weekDone = plan.every((r) => !(r.calls > 0) || (pend.spend.byMop[r.mop] || 0) >= r.calls);
    if (weekDone && !pend.spend.weekDoneNotified) {
      pend.spend.weekDoneNotified = true; await rsetJSON(key, pend);
      try { const ppl = await getPeople(); const tot = Object.values(pend.spend.byMop).reduce((s, n) => s + n, 0);
        if (ppl.owner && ppl.owner.chatId) await sendTg("owner", ppl.owner.chatId, `✅ Недельный план разбора звонков выполнен полностью: <b>${tot}</b> звонков за неделю. Результаты — в «Анализ звонков» и метриках.`); } catch (e) {}
    } else { await rsetJSON(key, pend); }
    return { done: true, today, note: weekDone ? "неделя выполнена" : "дневная норма на сегодня выбрана" };
  }
  const budgetMin = Math.max(6, Math.round(need * perMin));
  const pick = await selfCall({ action: "audit-pick", mop: target.mop, budgetMin, longMax: need, medMax: need });
  const cand = (pick.calls || []).slice(0, need); // жёсткий кап дневной нормой
  let sent = 0;
  for (let i = 0; i < cand.length; i += 40) {
    const items = cand.slice(i, i + 40).map((c) => ({ link: c.link, mop: target.mop, leadId: c.leadId }));
    const res = await selfCall({ action: "analyze", items });
    const arr = res.out || res.results || res.items || [];
    sent += Array.isArray(arr) ? arr.filter((x) => x && x.ok).length : 0;
  }
  // свежих нет (0) → закрываем дневную норму этого МОПа, чтобы крон не крутился на нём весь день
  dayMap[target.mop] = (dayMap[target.mop] || 0) + (cand.length ? sent : Math.max(1, Math.round(target.calls / 7)));
  pend.spend.byMop[target.mop] = (pend.spend.byMop[target.mop] || 0) + sent;
  await rsetJSON(key, pend);
  return { done: false, mop: target.mop, sent, picked: cand.length, today, weeklySent: pend.spend.byMop[target.mop], weeklyTarget: target.calls };
}

export async function handlePlanButton(act, org = "hunter") {
  const key = `transcriptplan:pending:${org}`;
  const pend = await rgetJSON(key, null);
  const people = await getPeople();
  const ownerChat = people.owner && people.owner.chatId;
  if (act === "review") { await sendPlanProposal(org); return { ok: true, toast: "План пересобран — прислал заново" }; }
  if (act === "decline") {
    if (pend) { pend.declined = true; pend.confirmed = false; pend.spend = null; await rsetJSON(key, pend); }
    return { ok: true, toast: "План отклонён", ownerMsg: "✖️ План на эту неделю отклонён — разбор звонков не запускается." };
  }
  if (act === "cancel") { if (pend) { pend.confirmed = false; pend.spend = null; await rsetJSON(key, pend); } return { ok: true, toast: "Отменено", ownerMsg: "✖️ Запуск отменён — ничего не списано." }; }
  if (act === "run") {
    if (!pend) return { ok: false, toast: "нет активного плана" };
    pend.confirmed = true; pend.confirmedAt = Date.now(); pend.declined = false; await rsetJSON(key, pend);
    // ФИНАЛЬНЫЙ денежный гейт — «Запустить» НЕ тратит, тратит только «Потратить».
    const usd = Math.round((pend.totals ? pend.totals.plannedMinutes : 0) * 0.056);
    const kb = { reply_markup: { inline_keyboard: [[{ text: "💸 Потратить и разобрать", callback_data: "tplan:spend" }], [{ text: "✖️ Отмена", callback_data: "tplan:cancel" }]] } };
    if (ownerChat) await sendTg("owner", ownerChat, `✅ План подтверждён: <b>${pend.totals ? pend.totals.plannedCalls : "?"} звонков / ${pend.totals ? pend.totals.plannedMinutes : "?"} мин</b>. Уже разобранные исключаются автоматически.\n\n<b>Это спишет реальные минуты DeepSales (~$${usd}).</b>\nПодтвердите трату, чтобы начать разбор:`, kb);
    return { ok: true, toast: "Подтверждено — нужен финальный шаг «Потратить»" };
  }
  if (act === "spend") {
    if (!pend || !pend.confirmed) return { ok: false, toast: "нет подтверждённого плана" };
    if (pend.spend && pend.spend.weekDoneNotified) return { ok: true, toast: "неделя уже разобрана" };
    // Только ИНИЦИИРУЕМ. Разбор ведёт крон plan-exec — дневными порциями (без гонки инлайн/крон).
    if (!pend.spend) { pend.spend = { startedAt: Date.now(), byMop: {}, daily: {} }; await rsetJSON(key, pend); }
    if (ownerChat) await sendTg("owner", ownerChat, `🚀 Запущено. Недельный план разбираю РАВНОМЕРНО по дням (≈1/7 в день на менеджера) — так прогресс виден каждый день, а не одним куском. По концу недели пришлю итог; результаты подтягиваются в «Анализ звонков» и метрики.`);
    return { ok: true, toast: "Запущено — разбор пойдёт по дням" };
  }
  return { ok: false, toast: "неизвестное действие" };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "";

  // гейт — только суперадмин (hunter). Анализ звонков — чувствительная операция.
  const sess = await getSession(q.session || b.session);
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const isCron = cronSecret ? (authHeader === `Bearer ${cronSecret}`) : false;
  // Чтение раздела — admin + РОП (РОПу нужно для разбора с командой). Запуск анализа — только admin. Метрики-сводка — крон по секрету.
  const isAdmin = !!(sess && sess.role === "admin");
  const isRop = !!(sess && sess.role === "rop");
  const READ_ONLY = new Set(["list", "get", "bundle"]);
  const CRON_OK = new Set(["metrics-digest", "plan-digest", "plan-exec", "audit-pick", "analyze"]);
  if (!(isAdmin || (isRop && READ_ONLY.has(action)) || (isCron && CRON_OK.has(action)))) { res.status(403).json({ error: "admin (или РОП — только чтение)" }); return; }
  const org = (sess && sess.org) || "hunter";

  // === ЧТЕНИЕ РАЗДЕЛА (admin + РОП). Секреты DeepSales не нужны — читаем своё хранилище. ===
  if (action === "bundle") { res.status(200).json({ ok: true, ...(await getCallAnalysisBundle(org)) }); return; }
  if (action === "plan") { res.status(200).json({ ok: true, ...(await getWeeklyTranscriptionPlan(org)) }); return; }
  if (action === "baseline-save") {
    const key = `progress:baseline:${org}`;
    const existing = await rgetJSON(key, null);
    if (existing && !b.force) { res.status(200).json({ ok: true, alreadyExists: true, at: existing.at, label: existing.label, note: "baseline уже зафиксирован — НЕ перезаписываю (передай force:true, если реально надо заменить точку отсчёта)" }); return; }
    const snap = await computeBaselineSnapshot(org);
    const rec = { at: Date.now(), label: String(b.label || "Снимок ДО внедрения нового скрипта и жёсткого контроля"), ...snap };
    await rsetJSON(key, rec);
    res.status(200).json({ ok: true, saved: true, baseline: rec });
    return;
  }
  if (action === "baseline-get") { res.status(200).json({ ok: true, baseline: await rgetJSON(`progress:baseline:${org}`, null) }); return; }
  if (action === "progress") {
    const base = await rgetJSON(`progress:baseline:${org}`, null);
    if (!base) { res.status(400).json({ error: "нет baseline — сначала baseline-save" }); return; }
    const now = await computeBaselineSnapshot(org);
    res.status(200).json({ ok: true, baselineAt: base.at, baselineLabel: base.label, diff: diffSnapshots(base, now), from: base, to: now });
    return;
  }
  if (action === "plan-digest") {
    const plan = await getWeeklyTranscriptionPlan(org);
    await rsetJSON(`transcriptplan:pending:${org}`, { at: Date.now(), plan: plan.plan, totals: plan.totals, confirmed: false, declined: false }); // ждёт решения владельца
    const msg = await buildPlanDigest(org);
    // Решение (кнопки) — в owner-бот (Digest-бот без вебхука, кнопки там не нажать). Digest остаётся для read-сводок.
    const people = await getPeople();
    let r = { ok: false, error: "owner не привязан" };
    if (people.owner && people.owner.chatId) {
      const kb = { reply_markup: { inline_keyboard: [
        [{ text: "✅ Запустить", callback_data: "tplan:run" }, { text: "🔄 Пересмотр", callback_data: "tplan:review" }],
        [{ text: "✖️ Отказ", callback_data: "tplan:decline" }],
      ] } };
      r = await sendTg("owner", people.owner.chatId, msg, kb);
    }
    res.status(200).json({ ok: !!(r && r.ok), sent: !!(r && r.ok), preview: msg, error: (r && r.error) || null });
    return;
  }
  if (action === "plan-exec") { res.status(200).json(await execDaily(org)); return; } // крон: дневная порция разбора (равномерно по дням)
  if (action === "plan-reset-spend") { // сбросить прогресс разбора (после багфикса) — переразобрать все МОПы
    if (!isAdmin) { res.status(403).json({ error: "admin only" }); return; }
    const p = await rgetJSON(`transcriptplan:pending:${org}`, null);
    if (p && p.spend) { p.spend.byMop = {}; p.spend.daily = {}; p.spend.weekDoneNotified = false; delete p.spend.done; delete p.spend.complete; await rsetJSON(`transcriptplan:pending:${org}`, p); }
    res.status(200).json({ ok: true, reset: true, hasSpend: !!(p && p.spend) });
    return;
  }
  if (action === "metrics-digest") {
    const msg = await buildMetricsDigest(org);
    const r = await sendDigest(msg);
    // после успешной отправки фиксируем текущий снимок как «прошлую сводку» для Δ следующей недели
    if (r && r.ok) { const snap = await computeBaselineSnapshot(org); await rsetJSON(LASTMETRICS_KEY(org), { at: Date.now(), ...snap }); }
    res.status(200).json({ ok: !!(r && r.ok), sent: !!(r && r.ok), preview: msg, error: (r && r.error) || null });
    return;
  }
  if (action === "plan-config") {
    if (!isAdmin) { res.status(403).json({ error: "admin only" }); return; }
    const cur = await rgetJSON(PLAN_CFG_KEY(org), {}) || {};
    const patch = {};
    for (const k of ["weeklyMinutes", "avgMinPerCall", "reliabilityCode", "salesLowRatio", "salesHighRatio", "reliabilityLow", "reliabilityHigh"]) {
      if (b[k] !== undefined) patch[k] = b[k];
    }
    if (!Object.keys(patch).length) { res.status(400).json({ error: "нечего менять", current: cur }); return; }
    const next = { ...cur, ...patch };
    await rsetJSON(PLAN_CFG_KEY(org), next);
    res.status(200).json({ ok: true, config: next });
    return;
  }
  if (action === "list") {
    let rows = (await rgetJSON(CA_LIST(org), [])).filter((x) => x.state === "done");
    const fmop = q.mop || b.mop, fst = q.status || b.status;
    if (fmop) rows = rows.filter((x) => x.mop === fmop);
    if (fst) rows = rows.filter((x) => x.status === fst);
    res.status(200).json({ ok: true, action: "list", count: rows.length, rows });
    return;
  }
  if (action === "get") {
    const leadId = q.leadId || b.leadId, aid = q.audioFileId || b.audioFileId;
    if (!leadId && !aid) { res.status(400).json({ error: "нужен leadId или audioFileId" }); return; }
    let lid = leadId;
    if (!lid) { const row = (await rgetJSON(CA_LIST(org), [])).find((x) => String(x.audioFileId) === String(aid)); lid = row && row.leadId; }
    if (!lid) { res.status(404).json({ error: "не найдено" }); return; }
    const arr = await rgetJSON(CA_KEY(org, lid), []);
    const rec = aid ? arr.find((x) => String(x.audioFileId) === String(aid)) : arr[0];
    res.status(200).json({ ok: true, record: rec || null });
    return;
  }

  // === AUDIT-PICK: репрезентативная выборка на ОДНОГО МОПа для глубокого аудита ===
  // Смесь по 2 осям: исход (won/lost) × позиция звонка в лиде (первый/повторный), разброс по времени.
  // Бюджет по РЕАЛЬНОМУ файлу (HEAD → Content-Length/16000). Балансируем, но не подгоняем: чего
  // реально нет — того не будет, состав честно показываем.
  if (action === "audit-pick") {
    const AMO = process.env.AMOCRM_TOKEN;
    if (!AMO) { res.status(500).json({ error: "нет AMOCRM_TOKEN" }); return; }
    const mopName = q.mop || b.mop;
    const mopId = Object.keys(MOPS).find((id) => MOPS[id] === mopName);
    if (!mopId) { res.status(400).json({ error: `неизвестный МОП "${mopName}" (есть: ${Object.values(MOPS).join(", ")})` }); return; }
    const budgetMin = Number(q.budgetMin || b.budgetMin || 60);
    const minSec = parseInt(q.minSec || b.minSec || 120, 10);   // не берём совсем короткие гудки/сбросы
    const maxSec = parseInt(q.maxSec || b.maxSec || 1200, 10);  // до 20 мин — длинные полные циклы продажи
    const sinceDays = parseInt(q.sinceDays || b.sinceDays || 45, 10);
    // полосы длительности (по разговору): short 2-4мин, medium 5-10мин, long 10-20мин
    const bandOf = (sec) => (sec <= 240 ? "short" : (sec <= 600 ? "medium" : "long"));
    const targets = { long: parseInt(q.longMax || b.longMax || 2, 10), medium: parseInt(q.medMax || b.medMax || 4, 10), short: 999 };
    const SUB = "huntercademy", SOLD = 142, LOST = 143, BYTES_PER_SEC = 16000;
    const base = `https://${SUB}.amocrm.ru/api/v4`, H = { Authorization: `Bearer ${AMO}` };
    const sinceTs = Math.floor(Date.now() / 1000) - sinceDays * 86400;
    // исключаем уже проанализированные аудио (чтобы не платить дважды за ту же запись)
    const doneIdx = await rgetJSON(CA_LIST(org), []);
    const doneLeads = new Set(doneIdx.map((x) => String(x.leadId)));

    // 1) ВСЕ won/lost лиды этого МОПа в окне. Фильтр по ответственному ДУБЛИРУЕМ В КОДЕ —
    //    URL-фильтр amoCRM ненадёжен, иначе в выборку попадут чужие звонки.
    const wonL = [], lostL = [];
    for (let page = 1; page <= 10; page++) {
      const r = await fetch(`${base}/leads?limit=250&page=${page}&filter[responsible_user_id]=${mopId}&filter[updated_at][from]=${sinceTs}`, { headers: H });
      if (r.status === 204 || !r.ok) break;
      const d = await r.json();
      const ls = (d._embedded && d._embedded.leads) || [];
      for (const L of ls) {
        if (String(L.responsible_user_id) !== String(mopId)) continue; // ГАРАНТИЯ: только этот МОП
        if (L.status_id === SOLD) wonL.push(L.id); else if (L.status_id === LOST) lostL.push(L.id);
      }
      if (ls.length < 250) break;
      await sleep(170);
    }
    // разброс по времени: сканируем ВСЕ won (их мало) + равномерную выборку lost по всему диапазону
    const spread = (a, n) => (a.length <= n ? a.slice() : a.filter((_, i) => i % Math.ceil(a.length / n) === 0).slice(0, n));
    const toScan = [...wonL.map((id) => ({ id, status: "won" })), ...spread(lostL, 90).map((id) => ({ id, status: "lost" }))];
    // 2) ноты → кандидаты, помечаем первый/повторный звонок (по порядку внутри лида)
    const cands = [];
    for (const L of toScan.slice(0, 130)) {
      const r = await fetch(`${base}/leads/${L.id}/notes?limit=250`, { headers: H });
      await sleep(160);
      if (!r.ok || r.status === 204) continue;
      const d = await r.json();
      const calls = ((d._embedded && d._embedded.notes) || [])
        .filter((n) => n.note_type === "call_in" || n.note_type === "call_out")
        .map((n) => ({ ts: n.created_at, dur: parseInt((n.params || {}).duration || 0, 10) || 0, link: (n.params || {}).link }))
        .filter((c) => c.link).sort((a, b2) => a.ts - b2.ts);
      calls.forEach((c, i) => {
        if (c.dur < minSec || c.dur > maxSec || c.ts < sinceTs) return;
        cands.push({ leadId: L.id, status: L.status, dur: c.dur, link: c.link, ts: c.ts, isFirst: i === 0, callDate: new Date(c.ts * 1000).toISOString().slice(0, 10), alreadyDone: doneLeads.has(String(L.id)) });
      });
    }
    // 3) баланс по 3 осям: полоса длительности → внутри неё round-robin по won/lost × первый/повторный,
    //    с разбросом по времени. Порядок набора: сначала длинные (их мало и они дорогие), потом средние,
    //    потом добиваем короткими. Уже проанализированные записи исключены (не платим дважды).
    const budgetSec = budgetMin * 60;
    const sub = ["won-first", "lost-first", "won-repeat", "lost-repeat"];
    const shelves = { short: {}, medium: {}, long: {} };
    for (const c of cands) {
      if (c.alreadyDone) continue;
      const sh = shelves[bandOf(c.dur)]; const k = `${c.status}-${c.isFirst ? "first" : "repeat"}`;
      (sh[k] = sh[k] || []).push(c);
    }
    for (const band of Object.keys(shelves)) for (const k in shelves[band]) shelves[band][k].sort((a, b2) => a.ts - b2.ts);
    const sel = []; let est = 0;
    // баланс-каунтеры: не даём выборке залиться тем, чего много (lost/повторные), когда won/первых мало
    let cWon = 0, cLost = 0, cFirst = 0, cRepeat = 0;
    const used = new Set(); const ukey = (c) => c.leadId + ":" + c.ts;
    // потолок бюджета на полосу — чтобы длинные/средние не съели весь час и коротким осталось место
    const bandCap = { long: Math.round(budgetSec * 0.40), medium: Math.round(budgetSec * 0.42), short: budgetSec };
    const pullBand = (band, maxCount, cap) => {
      const sh = shelves[band]; const idx = {}; sub.forEach((k) => (idx[k] = 0));
      let n = 0, spent = 0, moved = true;
      while (n < maxCount && est < budgetSec && spent < cap && moved) {
        moved = false;
        for (const k of sub) {
          if (n >= maxCount || est >= budgetSec || spent >= cap) break;
          const arr = sh[k] || [];
          while (idx[k] < arr.length && used.has(ukey(arr[idx[k]]))) idx[k]++;
          if (idx[k] < arr.length) {
            const c = arr[idx[k]++]; const ef = Math.round(c.dur * 1.1); // реальный ratio файл/разговор ~1.1 (не 1.2 — иначе бюджет убегает)
            if (est + ef > budgetSec + 120 || spent + ef > cap) continue; // не перелетать общий бюджет И потолок полосы
            if (c.status === "lost" && cLost >= cWon + 2) continue; // не флудить lost, когда won исчерпан
            if (!c.isFirst && cRepeat >= cFirst + 2) continue;      // не флудить повторные, когда первых мало
            used.add(ukey(c)); sel.push(c); est += ef; spent += ef; n++; moved = true;
            if (c.status === "won") cWon++; else cLost++;
            if (c.isFirst) cFirst++; else cRepeat++;
          }
        }
      }
    };
    pullBand("long", targets.long, bandCap.long);
    pullBand("medium", targets.medium, bandCap.medium);
    pullBand("short", targets.short, budgetSec);
    // недобрали бюджет (коротких/чего-то мало) — добираем чем реально есть, без потолков
    if (est < budgetSec * 0.95) for (const band of ["medium", "short"]) pullBand(band, 999, budgetSec);
    // 4) HEAD выбранных: реальный fileSec + живость
    const final = [];
    for (const c of sel) {
      let fileSec = null;
      try { const h = await fetch(c.link, { method: "HEAD", signal: AbortSignal.timeout(12000) }); if (h.ok) { const len = parseInt(h.headers.get("content-length") || "0", 10); if (len > 0) fileSec = Math.round(len / BYTES_PER_SEC); } } catch (e) { /* мёртвая */ }
      await sleep(80);
      if (fileSec == null) continue;
      final.push({ leadId: c.leadId, status: c.status, position: c.isFirst ? "первый" : "повторный", band: bandOf(c.dur), talkSec: c.dur, fileSec, link: c.link, callDate: c.callDate });
    }
    final.sort((a, b2) => a.callDate.localeCompare(b2.callDate));
    const comp = { won: 0, lost: 0, "первый": 0, "повторный": 0, short: 0, medium: 0, long: 0 }; let sec = 0;
    for (const c of final) { comp[c.status]++; comp[c.position]++; comp[c.band]++; sec += c.fileSec; }
    res.status(200).json({
      ok: true, action: "audit-pick", mop: mopName, mopId, budgetMin,
      scanned: { wonLeads: wonL.length, lostLeads: lostL.length, notesScanned: toScan.slice(0, 130).length, candidateCalls: cands.length,
        freshCandidatesByBand: cands.reduce((o, c) => { if (!c.alreadyDone) o[bandOf(c.dur)] = (o[bandOf(c.dur)] || 0) + 1; return o; }, { short: 0, medium: 0, long: 0 }) },
      composition: comp, totalFileMin: +(sec / 60).toFixed(1),
      dateSpan: final.length ? { from: final[0].callDate, to: final[final.length - 1].callDate } : null,
      calls: final,
    });
    return;
  }

  // === PICK: исторический отбор звонков по СТАТУСУ лида (won/lost) за месяц ===
  // Нужен для контрастного анализа: debug=calls умеет только «сегодня», а нам нужны записи любой давности.
  // Только amoCRM — секреты DeepSales тут не требуются (поэтому до их проверки).
  if (action === "pick") {
    const AMO = process.env.AMOCRM_TOKEN;
    if (!AMO) { res.status(500).json({ error: "нет AMOCRM_TOKEN" }); return; }
    const SUB = "huntercademy", SOLD = 142, LOST = 143; // MOPS — на уровне модуля
    const minSec = parseInt(q.minSec || b.minSec || 120, 10);
    const maxSec = parseInt(q.maxSec || b.maxSec || 240, 10);
    const need = Math.min(parseInt(q.need || b.need || 15, 10), 25);
    const SCAN_CAP = Math.min(parseInt(q.scanCap || b.scanCap || 200, 10), 300);
    const sinceDays = parseInt(q.sinceDays || b.sinceDays || 60, 10); // свежесть звонка: старые записи Utel могут быть вычищены
    const sinceTs = Math.floor(Date.now() / 1000) - sinceDays * 86400;
    const BYTES_PER_SEC = 16000; // 8кГц 16-бит моно — проверено: 1402284Б / 88с ≈ 15935
    const base = `https://${SUB}.amocrm.ru/api/v4`;
    const H = { Authorization: `Bearer ${AMO}` };
    const TZ = 5 * 3600;
    const nl = new Date(Date.now() + TZ * 1000);
    const monthStart = Math.floor(Date.UTC(nl.getUTCFullYear(), nl.getUTCMonth(), 1) / 1000) - TZ;

    // 1) лиды, тронутые в этом месяце → делим на won/lost (только наши МОПы)
    const wonLeads = [], lostLeads = [];
    for (let page = 1; page <= 6; page++) {
      const r = await fetch(`${base}/leads?limit=250&page=${page}&filter[updated_at][from]=${monthStart}`, { headers: H });
      if (r.status === 204 || !r.ok) break;
      const d = await r.json();
      const leads = (d._embedded && d._embedded.leads) || [];
      for (const L of leads) {
        if (!MOPS[L.responsible_user_id]) continue;
        if (L.status_id === SOLD) wonLeads.push(L); else if (L.status_id === LOST) lostLeads.push(L);
      }
      if (leads.length < 250) break;
      await sleep(180);
    }

    // 2) по каждому лиду — ноты, берём САМЫЙ ДЛИННЫЙ звонок в диапазоне [minSec..maxSec]
    const pickFrom = async (leads, status) => {
      const out = [];
      for (const L of leads.slice(0, SCAN_CAP)) {
        if (out.length >= need) break;
        const r = await fetch(`${base}/leads/${L.id}/notes?limit=250`, { headers: H });
        await sleep(170); // ~6/с — под лимит amoCRM (~7/с)
        if (!r.ok || r.status === 204) continue;
        const d = await r.json();
        let best = null;
        for (const n of ((d._embedded && d._embedded.notes) || [])) {
          if (n.note_type !== "call_in" && n.note_type !== "call_out") continue;
          const p = n.params || {};
          const dur = parseInt(p.duration || 0, 10) || 0;
          if (dur < minSec || dur > maxSec || !p.link) continue;
          if (n.created_at < sinceTs) continue; // только свежие — старые записи Utel могут быть удалены
          if (!best || dur > best.dur) best = { dur, link: p.link, ts: n.created_at };
        }
        if (!best) continue;
        // HEAD: (1) жива ли ссылка, (2) РЕАЛЬНАЯ длительность файла — DeepSales считает бюджет по файлу
        // (с гудками), а не по времени разговора из amoCRM. Проверено: 55с разговора = 88с файла.
        let fileSec = null;
        try {
          const h = await fetch(best.link, { method: "HEAD", signal: AbortSignal.timeout(12000) });
          if (h.ok) { const len = parseInt(h.headers.get("content-length") || "0", 10); if (len > 0) fileSec = Math.round(len / BYTES_PER_SEC); }
        } catch (e) { /* мёртвая ссылка */ }
        await sleep(100);
        if (fileSec == null) continue; // ссылка недоступна — пропускаем, чтобы не слать битое
        out.push({ leadId: L.id, status, mop: MOPS[L.responsible_user_id], talkSec: best.dur, fileSec, link: best.link, callDate: new Date(best.ts * 1000).toISOString().slice(0, 10) });
      }
      return out;
    };
    const won = await pickFrom(wonLeads, "won");
    const lost = await pickFrom(lostLeads, "lost");
    const sumFile = (a) => a.reduce((s, x) => s + (x.fileSec || 0), 0);
    const sumTalk = (a) => a.reduce((s, x) => s + (x.talkSec || 0), 0);
    res.status(200).json({
      ok: true, action: "pick", filter: { minSec, maxSec, need, scanCap: SCAN_CAP, sinceDays },
      scanned: { wonLeadsThisMonth: wonLeads.length, lostLeadsThisMonth: lostLeads.length },
      won, lost,
      // БЮДЖЕТ считаем по fileSec (весь файл с гудками) — именно его тарифицирует DeepSales.
      totals: {
        wonCount: won.length, lostCount: lost.length,
        wonFileMin: +(sumFile(won) / 60).toFixed(1), lostFileMin: +(sumFile(lost) / 60).toFixed(1),
        totalFileMin: +((sumFile(won) + sumFile(lost)) / 60).toFixed(1),
        totalTalkMin: +((sumTalk(won) + sumTalk(lost)) / 60).toFixed(1),
      },
    });
    return;
  }

  const EMAIL = process.env.DEEPSALES_EMAIL, PASSWORD = process.env.DEEPSALES_PASSWORD, BEARER = process.env.DEEPSALES_BEARER_TOKEN;
  if (!EMAIL || !PASSWORD || !BEARER) { res.status(500).json({ error: "не заданы env: DEEPSALES_EMAIL / DEEPSALES_PASSWORD / DEEPSALES_BEARER_TOKEN" }); return; }
  const basic = "Basic " + Buffer.from(`${EMAIL}:${PASSWORD}`).toString("base64");

  // === ANALYZE: скачать запись из amoCRM (server-side) и отправить в DeepSales ===
  if (action === "analyze") {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) { res.status(400).json({ error: "нужен items: [{link, crm_manager_id, leadId}]" }); return; }
    if (items.length > 40) { res.status(400).json({ error: "не более 40 записей за вызов (бюджет/таймаут) — дробите на партии" }); return; }
    // Каждый звонок уходит на РЕАЛЬНЫЙ аккаунт своего МОПа в DeepSales (DS_MANAGERS) — тогда их
    // кабинет (Рейтинг/Менеджеры) показывает верную атрибуцию. Если МОП не опознан — технический
    // аккаунт из env (фолбэк). Наша собственная привязка (mop/lead/статус) всё равно хранится у нас.
    if (!Object.keys(DS_MANAGERS).length) { res.status(500).json({ error: "DS_MANAGERS пуст" }); return; }
    const out = [];
    for (const it of items) {
      try {
        if (!it.link) { out.push({ leadId: it.leadId || null, ok: false, error: "нужен link" }); continue; }
        // audio_url — DeepSales сам скачивает запись (Utel публичен, CORS *).
        // строго реальный аккаунт МОПа. 1443 («Hunter») служебный — к МОПам НЕ привязываем,
        // поэтому неопознанный МОП пропускаем с ошибкой, а не шлём на служебный (иначе кривая атрибуция).
        const mgr = DS_MANAGERS[it.mop];
        if (!mgr) { out.push({ leadId: it.leadId, ok: false, error: `МОП "${it.mop || "?"}" не сопоставлен с DeepSales manager_id — пропущено` }); continue; }
        const fd = new FormData();
        fd.append("audio_url", it.link);
        fd.append("manager_id", String(mgr));
        const r = await fetch(`${DS}/api/crm/audio-analyze`, { method: "POST", headers: { Authorization: basic, Accept: "application/json" }, body: fd, signal: AbortSignal.timeout(90000) });
        let body; try { body = await r.json(); } catch (e) { body = { _text: (await r.text().catch(() => "")).slice(0, 200) }; }
        // DeepSales отдаёт id в data.audio_file_id (не audio_id). data.duration — длительность ВСЕГО файла
        // (включая гудки): именно она тратит бюджет минут, а не duration разговора из amoCRM.
        const D = body.data || {};
        const aid = D.audio_file_id || D.audio_id || D.id || body.audio_id || body.id || null;
        // mop/leadStatus возвращаем обратно — это НАША привязка результата к менеджеру и исходу сделки
        out.push({ leadId: it.leadId, mop: it.mop || null, dsManagerId: mgr, leadStatus: it.status || null, ok: r.status < 300, status: r.status, audio_id: aid, amoSeconds: it.duration || null, fileSeconds: D.duration || null, resp: body });
        // ЗАГОТОВКА в хранилище: привязку (чей звонок) знаем только мы — DeepSales её не вернёт
        if (aid) {
          const stub = { audioFileId: aid, leadId: it.leadId, mop: it.mop || null, mopId: it.mopId || null,
            status: it.status || null, callDate: it.callDate || null, talkSec: it.duration || null,
            fileSec: D.duration || null, state: "pending", sentAt: new Date().toISOString() };
          await caRecordUpsert(org, it.leadId, stub);
          await caIndexUpsert(org, stub);
        }
      } catch (e) { out.push({ leadId: it.leadId, ok: false, error: String(e).slice(0, 140) }); }
      await sleep(1200); // 60/мин dashboard — с запасом
    }
    res.status(200).json({ ok: true, action: "analyze", count: out.length, results: out });
    return;
  }

  // === RESULT: опрос результата по audio_id (Bearer) ===
  if (action === "result") {
    const ids = Array.isArray(b.ids) ? b.ids : (q.audio_id ? [q.audio_id] : []);
    if (!ids.length) { res.status(400).json({ error: "нужен ids: [audio_id] или ?audio_id=" }); return; }
    if (ids.length > 60) { res.status(400).json({ error: "не более 60 id за вызов" }); return; }
    const bget = async (path) => {
      const r = await fetch(`${DS}${path}`, { headers: { Authorization: `Bearer ${BEARER}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      let body; try { body = await r.json(); } catch (e) { body = { _s: r.status }; }
      return { status: r.status, body };
    };
    const out = [];
    let saved = 0;
    for (const aid of ids) {
      const ca = await bget(`/api/call-analysis?audio_id=${encodeURIComponent(aid)}`);
      await sleep(120); // 600/мин analysis
      const tr = await bget(`/api/transcription?audio_id=${encodeURIComponent(aid)}`);
      await sleep(120);
      out.push({ audio_id: aid, call_analysis: ca, transcription: tr });

      // === СОХРАНЕНИЕ (не только показ) ===
      const A = ca.status === 200 && ca.body && ca.body.data ? ca.body.data : null;
      const T = tr.status === 200 && tr.body && tr.body.data ? tr.body.data : null;
      if (!A || !T) continue;
      // НАША привязка: из заготовки (analyze) либо из body.attrib — для backfill уже отправленных
      // записей без повторной отправки аудио (бюджет минут не тратится).
      const idx = await rgetJSON(CA_LIST(org), []);
      const attrib = Array.isArray(b.attrib) ? b.attrib : [];
      const stub = idx.find((x) => String(x.audioFileId) === String(aid))
        || attrib.find((a) => String(a.audioFileId || a.audio_id) === String(aid))
        || {};
      const rec = {
        audioFileId: aid, leadId: stub.leadId || null, mop: stub.mop || null, mopId: stub.mopId || null,
        status: stub.status || null, callDate: stub.callDate || null, talkSec: stub.talkSec || null,
        fileSec: (T.audio && T.audio.duration) || stub.fileSec || null,
        category: (A.category && A.category.name) || null,
        overallScore: A.overall_score != null ? A.overall_score : null,
        criteriaScores: A.criteria_scores || {}, criteriaExplanations: A.criteria_explanations || {},
        talkRatio: T.talk_ratio != null ? T.talk_ratio : null,
        objections: A.objections || [], mistakes: A.mistakes || [], mistakesCount: A.mistakes_count || (A.mistakes || []).length,
        finalOutcome: A.final_outcome || null, nextSteps: A.next_steps || null, feedback: A.feedback || null,
        infoAboutClient: A.info_about_client || null,
        transcript: (T.segments || []).map((s) => ({ speaker: s.speaker, text: s.text, timestamp: s.timestamp })),
        state: "done", analyzedAt: new Date().toISOString(),
      };
      await caRecordUpsert(org, rec.leadId, rec);
      await caIndexUpsert(org, {
        audioFileId: aid, leadId: rec.leadId, mop: rec.mop, mopId: rec.mopId, status: rec.status,
        callDate: rec.callDate, talkSec: rec.talkSec, fileSec: rec.fileSec,
        score: rec.overallScore, talkRatio: rec.talkRatio, headline: headlineOf(A),
        mistakeTags: (rec.mistakes || []).map((m) => m.tag).filter(Boolean),
        objectionTags: (rec.objections || []).map((o) => o.tag).filter(Boolean),
        // criteriaScores в индекс (плоский объект ~5-8 чисел) — чтобы бандл считал средние по критериям
        // без чтения полных записей. Ось «достоверность продукта» = средний балл нужного критерия.
        criteriaScores: rec.criteriaScores || {},
        mistakesCount: rec.mistakesCount, category: rec.category, state: "done", analyzedAt: rec.analyzedAt,
      });
      saved++;
    }
    res.status(200).json({ ok: true, action: "result", results: out, saved });
    return;
  }

  res.status(400).json({ error: "action: bundle | plan | list | get | pick | analyze | result" });
}
