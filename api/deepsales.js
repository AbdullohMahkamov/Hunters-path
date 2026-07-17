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
  return {
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "";

  // гейт — только суперадмин (hunter). Анализ звонков — чувствительная операция.
  const sess = await getSession(q.session || b.session);
  // Чтение раздела — admin + РОП (РОПу нужно для разбора с командой). Запуск анализа — только admin.
  const isAdmin = !!(sess && sess.role === "admin");
  const isRop = !!(sess && sess.role === "rop");
  const READ_ONLY = new Set(["list", "get", "bundle"]);
  if (!(isAdmin || (isRop && READ_ONLY.has(action)))) { res.status(403).json({ error: "admin (или РОП — только чтение)" }); return; }
  const org = (sess && sess.org) || "hunter";

  // === ЧТЕНИЕ РАЗДЕЛА (admin + РОП). Секреты DeepSales не нужны — читаем своё хранилище. ===
  if (action === "bundle") { res.status(200).json({ ok: true, ...(await getCallAnalysisBundle(org)) }); return; }
  if (action === "plan") { res.status(200).json({ ok: true, ...(await getWeeklyTranscriptionPlan(org)) }); return; }
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
