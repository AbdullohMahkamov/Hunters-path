// /api/ingest.js — ПРИЁМНИК unified-данных (docs/hunter-ai-integration-spec.md) для клиентов с source:"unified".
// Преобразует lead/call/employee в ТОТ ЖЕ внутренний кэш-контракт, что пишет sync-speed/sync
// (speed:${org}, dashboard:${org}, snap:${date}:${org}) — весь downstream (дашборд, агенты, геймификация)
// работает без изменений. Звонки приходят напрямую → нет машинерии нот/событий/пейсинга amoCRM.
//
// Шаг 2: ядро (чистый computeMetrics + накопление сырья + runIngest) + админ-тест ingest_test.
// Шаг 3 добавит Pull (bridgeUrl) и Push (webhook). Шаг 4 — тест на мок-данных.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function isSuperAdmin(session) { if (!session) return false; try { const raw = await rget(`session:${encodeURIComponent(session)}`); const s = raw ? JSON.parse(raw) : null; return !!(s && s.role === "admin" && s.org === "hunter"); } catch (e) { return false; } }

const TZ = 5 * 3600000; // Ташкент
const median = (arr) => { const v = (arr || []).filter((x) => x != null); if (!v.length) return null; const s = [...v].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const toMs = (iso) => { if (!iso) return 0; const t = Date.parse(iso); return isNaN(t) ? 0 : t; };

// ── ЧИСТЫЙ РАСЧЁТ: unified {leads, calls, employees} + cfg → {dashboard, speed, snap} ──
// Тестируется локально без Redis. cfg: {reachedSec, dozvonStages[], noContactStages[], noContactReasons[],
// fakeNumReasons[], contactedReasons[], mops:{empId:name}}. isComplete — флаг полноты (из is_complete мостика).
export function computeMetrics(raw, cfg, isComplete, nowMs) {
  nowMs = nowMs || 0;
  const tk = new Date(nowMs + TZ);
  const monthStart = Date.UTC(tk.getUTCFullYear(), tk.getUTCMonth(), 1) - TZ;
  const dayStart = Date.UTC(tk.getUTCFullYear(), tk.getUTCMonth(), tk.getUTCDate()) - TZ;
  const tkDayStr = new Date(nowMs + TZ).toISOString().slice(0, 10);
  const reachedSec = cfg.reachedSec != null ? cfg.reachedSec : 40;
  const NCR = new Set(cfg.noContactReasons || []), FNR = new Set(cfg.fakeNumReasons || []), CR = new Set(cfg.contactedReasons || []);
  const NCS = new Set(cfg.noContactStages || []), DZ = new Set((cfg.dozvonStages || []).map(String));
  const empByName = {}; for (const e of (raw.employees || [])) empByName[String(e.id)] = e.name || String(e.id);
  const mopIds = Object.keys(cfg.mops || {}).length ? Object.keys(cfg.mops) : (raw.employees || []).map((e) => String(e.id));
  const mopSet = new Set(mopIds.map(String));
  const empName = (id) => (cfg.mops && cfg.mops[String(id)]) || empByName[String(id)] || String(id);

  // звонки по лиду
  const callsByLead = {};
  for (const c of (raw.calls || [])) { const lid = String(c.lead_id); (callsByLead[lid] = callsByLead[lid] || []).push(c); }
  const leadCall = (lid) => {
    const cs = callsByLead[lid] || []; let reached = false, first = null, reachedToday = false, todayCount = 0;
    for (const c of cs) { const st = toMs(c.started_at); if (c.answered && (c.duration_seconds || 0) >= reachedSec) { reached = true; if (st >= dayStart) reachedToday = true; } if (st && (first === null || st < first)) first = st; if (st >= dayStart) todayCount++; }
    return { reached, first, count: cs.length, reachedToday, todayCount };
  };

  const mk = () => ({ leads: 0, sold: 0, noContact: 0, fakeNums: 0, reachedCall: 0, calledLeads: 0, firstCallMins: [], cycles: [], revenue: 0 });
  const mkD = () => ({ leads: 0, reachedCall: 0, calledLeads: 0, fakeNums: 0, firstCallMins: [] });
  const M = {}, D = {}; for (const id of mopIds) { M[String(id)] = mk(); D[String(id)] = mkD(); }
  const mopIssues = []; const dz = {}; for (const id of mopIds) dz[String(id)] = { pool: 0, calledToday: 0, reachedToday: 0 };
  let soldToday = 0, revenueToday = 0;

  for (const L of (raw.leads || [])) {
    const empId = String(L.responsible_employee_id);
    if (!mopSet.has(empId)) continue;
    const created = toMs(L.created_at);
    const type = (L.status && L.status.type) || "open";
    const statusName = (L.status && L.status.name) || "";
    const statusId = String((L.status && L.status.id) != null ? L.status.id : "");
    const lossName = (L.loss_reason && L.loss_reason.name) || "";
    const paid = L.payment && L.payment.is_paid ? (L.payment.amount || 0) : 0;
    const lc = leadCall(String(L.id));
    const isFake = type === "lost" && FNR.has(lossName);

    // ── МЕСЯЦ ──
    if (created >= monthStart) {
      const m = M[empId];
      if (isFake) { m.fakeNums++; }
      else {
        m.leads++;
        if (type === "won") { m.sold++; m.revenue += paid; }
        let nc = false;
        if (type === "lost" && CR.has(lossName)) { /* контакт был — не недозвон */ }
        else if (type === "lost" && NCR.has(lossName)) nc = true;
        else if (NCS.has(statusName)) nc = true;
        if (nc) m.noContact++;
        if (lc.count > 0) m.calledLeads++;
        if (lc.reached) m.reachedCall++;
        if (lc.first && lc.first >= created) m.firstCallMins.push(Math.round((lc.first - created) / 60000));
        if (type === "won" && L.updated_at) { const cl = toMs(L.updated_at); if (cl > created) m.cycles.push((cl - created) / 86400000); }
        if (lc.reached && NCS.has(statusName)) mopIssues.push({ type: "status_mismatch", mop: empName(empId), leadId: L.id, name: L.name || "" });
        if (lc.count === 0 && type === "open") mopIssues.push({ type: "no_call", mop: empName(empId), leadId: L.id, name: L.name || "", status: statusName });
      }
    }
    // продажи/касса сегодня (по факту оплаты, иначе по updated_at выигранной сделки)
    if (type === "won") { const saleTs = (L.payment && L.payment.paid_at) ? toMs(L.payment.paid_at) : toMs(L.updated_at); if (saleTs >= dayStart) { soldToday++; revenueToday += paid; } }

    // ── ПУЛ ДОЗВОНА: лид СЕЙЧАС на этапе «входа» (dozvonStages) ──
    if (DZ.has(statusId) && !isFake) { const b = dz[empId]; b.pool++; if (lc.todayCount > 0) b.calledToday++; if (lc.reachedToday) b.reachedToday++; }

    // ── СЕГОДНЯ ──
    if (created >= dayStart || lc.todayCount > 0) {
      const d = D[empId];
      if (isFake) { d.fakeNums++; }
      else { d.leads++; if (lc.todayCount > 0) d.calledLeads++; if (lc.reachedToday) d.reachedCall++; if (lc.first && lc.first >= dayStart && lc.first >= created) d.firstCallMins.push(Math.round((lc.first - created) / 60000)); }
    }
  }

  const mopsByConv = mopIds.map((id) => { const m = M[String(id)]; const rd = m.leads; return {
    id: String(id), name: empName(id), leads: m.leads, sold: m.sold, revenue: m.revenue,
    conv: rd > 0 ? +(m.sold / rd * 100).toFixed(2) : 0,
    reachPct: rd > 0 ? +((rd - m.noContact) / rd * 100).toFixed(0) : 0,
    reached: Math.max(0, rd - m.noContact), reachDenom: rd, fakeNums: m.fakeNums,
    dealCycleDays: median(m.cycles) != null ? Math.round(median(m.cycles)) : null,
  }; });
  const mopsBySales = [...mopsByConv].sort((a, b) => b.sold - a.sold);
  const speedMops = mopIds.map((id) => { const m = M[String(id)]; const rd = m.leads; return {
    id: String(id), name: empName(id), leads: m.leads, reached: m.reachedCall,
    reachPct: rd > 0 ? Math.min(100, Math.round(m.reachedCall / rd * 100)) : 0,
    calledLeads: m.calledLeads, medianFirstCallMin: median(m.firstCallMins) != null ? Math.round(median(m.firstCallMins)) : null,
    taskRate: null, tasksDonePct: null,
  }; });
  const mopsDay = mopIds.map((id) => { const d = D[String(id)]; return {
    id: String(id), name: empName(id), leads: d.leads, reached: d.reachedCall,
    reachedPct: d.leads > 0 ? Math.min(100, Math.round(d.reachedCall / d.leads * 100)) : 0,
    calledLeads: d.calledLeads, fakeNums: d.fakeNums, medianFirstCallMin: median(d.firstCallMins) != null ? Math.round(median(d.firstCallMins)) : null,
  }; });

  const totalLeads = mopsByConv.reduce((s, m) => s + m.leads, 0);
  const soldTeam = mopsByConv.reduce((s, m) => s + m.sold, 0);
  const revenueTeam = mopsByConv.reduce((s, m) => s + (m.revenue || 0), 0);
  const noContactTeam = mopIds.reduce((s, id) => s + M[String(id)].noContact, 0);
  const conv = totalLeads > 0 ? +(soldTeam / totalLeads * 100).toFixed(2) : 0;
  const noContactPct = totalLeads > 0 ? +(noContactTeam / totalLeads * 100).toFixed(0) : 0;
  const leadsToday = mopsDay.reduce((s, m) => s + m.leads, 0);
  const avgCheck = soldTeam > 0 ? Math.round(revenueTeam / soldTeam) : 0;
  const cycleAll = []; for (const id of mopIds) cycleAll.push(...M[String(id)].cycles);
  const dealCycleMedianDays = median(cycleAll) != null ? Math.round(median(cycleAll)) : null;
  const DZagg = mopIds.reduce((a, id) => { const b = dz[String(id)]; a.pool += b.pool; a.calledToday += b.calledToday; a.reachedToday += b.reachedToday; return a; }, { pool: 0, calledToday: 0, reachedToday: 0 });
  const pct = (a, b) => (b ? Math.min(100, Math.round(a / b * 100)) : 0);
  const updatedAt = new Date(nowMs).toISOString();

  const dashboard = {
    updatedAt, period: "Текущий месяц",
    totals: {
      leads: totalLeads, sold: soldTeam, revenue: revenueTeam, newSalesRevenue: revenueTeam, soldTeam, revenueTeam,
      conv, avgCheck, avgCheckMedian: avgCheck, noContactPct, ownExcluded: 0,
      dealCycleMedianDays, paidReceiptCount: null, goal: null,
      leadsAll: totalLeads, soldAll: soldTeam, soldTeamAll: soldTeam, revenueAll: revenueTeam, convAll: conv, noContactPctAll: noContactPct,
      soldToday, revenueToday, leadsToday, convAudit: conv, noContactPctAudit: noContactPct, leadsAudit: totalLeads,
    },
    mopsByConv, mopsBySales, problems: [], problemsAll: [], adsets: [],
    velocity: { median: dealCycleMedianDays, avg: dealCycleMedianDays, count: cycleAll.length, stages: [] },
    suspicious: [],
  };
  const speed = {
    updatedAt, period: "Текущий месяц", mops: speedMops, mopsDay,
    mopIssues: mopIssues.slice(0, 400),
    reach: { reachedLeads: speedMops.reduce((s, m) => s + m.reached, 0), leads: totalLeads },
    dozvon: { pool: DZagg.pool, calledToday: DZagg.calledToday, reachedToday: DZagg.reachedToday, pct: pct(DZagg.reachedToday, DZagg.calledToday), coveragePct: pct(DZagg.calledToday, DZagg.pool),
      byMop: mopIds.map((id) => { const b = dz[String(id)]; return { name: empName(id), pool: b.pool, calledToday: b.calledToday, reachedToday: b.reachedToday, pct: pct(b.reachedToday, b.calledToday) }; }) },
    mopMeta: {
      reachedSec, notesComplete: !!isComplete, eventsComplete: !!isComplete, leadsComplete: !!isComplete, notesUnread: 0,
      // unified: звонки приходят напрямую, «мимо CRM» тут не бывает → детектор no_call НАДЁЖЕН
      callsBypassSuspected: false, telephonyPct: 0,
    },
    telephony: { total: totalLeads, noCallButActive: 0, noCallButActivePct: 0, callsBypassSuspected: false, warning: null },
    complete: !!isComplete,
    _source: "unified",
  };
  const snap = { date: tkDayStr, sold: soldTeam, revenue: revenueTeam, soldPeriod: soldTeam, conv, leads: totalLeads, noContactPct, avgCheck, avgCheckMedian: avgCheck, dealCycleMedianDays, reached: speedMops.reduce((s, m) => s + m.reached, 0) };
  return { dashboard, speed, snap, tkDayStr };
}

// ── НАКОПЛЕНИЕ СЫРЬЯ (merge по id) — инкремент от мостика не теряет историю ──
// v1: raw хранится JSON-картой на org. Для больших баз позже перейти на per-id/чанки + прунинг старше N дней.
async function mergeRaw(org, u) {
  const kl = `ingest:${org}:leads`, kc = `ingest:${org}:calls`, ke = `ingest:${org}:employees`;
  const [leads, calls, emps] = await Promise.all([rgetJSON(kl, {}), rgetJSON(kc, {}), rgetJSON(ke, {})]);
  for (const l of (u.leads || [])) if (l && l.id != null) leads[String(l.id)] = l;
  for (const c of (u.calls || [])) if (c && c.id != null) calls[String(c.id)] = c;
  for (const e of (u.employees || [])) if (e && e.id != null) emps[String(e.id)] = e;
  await Promise.all([rsetJSON(kl, leads), rsetJSON(kc, calls), rsetJSON(ke, emps)]);
  return { leads: Object.values(leads), calls: Object.values(calls), employees: Object.values(emps) };
}

function ingestCfgFrom(clientcfg) {
  return {
    reachedSec: clientcfg.reachedSec != null ? clientcfg.reachedSec : 40,
    dozvonStages: clientcfg.dozvonStages || [], noContactStages: clientcfg.noContactStages || [],
    noContactReasons: clientcfg.noContactReasons || [], fakeNumReasons: clientcfg.fakeNumReasons || [],
    contactedReasons: clientcfg.contactedReasons || [], mops: clientcfg.mops || {},
  };
}

// ── ОРКЕСТРАЦИЯ: merge сырья → пересчёт из полного набора → запись кэшей (тот же контракт, что sync-speed) ──
export async function runIngest(org, unified, isComplete, nowMs) {
  const clientcfg = await rgetJSON(`clientcfg:${org}`, null);
  if (!clientcfg || clientcfg.source !== "unified") return { ok: false, error: "org не unified" };
  const cfg = ingestCfgFrom(clientcfg);
  const raw = await mergeRaw(org, unified || {});
  const { dashboard, speed, snap } = computeMetrics(raw, cfg, isComplete, nowMs || Date.now());
  await Promise.all([
    rsetJSON(`dashboard:${org}`, dashboard),
    rsetJSON(`speed:${org}`, speed),
    rsetJSON(`snap:${snap.date}:${org}`, snap),
  ]);
  // список снимков (для динамики Growth), как у sync.js
  const kSnapList = `snap:list:${org}`;
  const dates = await rgetJSON(kSnapList, []);
  if (!dates.includes(snap.date)) { dates.push(snap.date); await rsetJSON(kSnapList, dates.slice(-60)); }
  return { ok: true, org, leads: raw.leads.length, calls: raw.calls.length, employees: raw.employees.length, isComplete: !!isComplete,
    totals: { leads: dashboard.totals.leads, sold: dashboard.totals.sold, conv: dashboard.totals.conv } };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "";

  // ingest_test (суперадмин): принять inline unified-payload, прогнать runIngest, вернуть результат.
  // Для шага 4 (тест на мок-данных). Pull (bridgeUrl) и Push (webhook) — шаг 3.
  if (action === "ingest_test") {
    if (!(await isSuperAdmin(q.session || b.session))) { res.status(403).json({ error: "superadmin only" }); return; }
    const org = String(b.org || q.org || "");
    if (!org || org === "hunter") { res.status(400).json({ error: "нужен org (не hunter)" }); return; }
    const payload = b.payload || {};
    const r = await runIngest(org, payload, payload.is_complete !== false, b.nowMs || Date.now());
    res.status(200).json(r); return;
  }

  res.status(501).json({ error: "ingest: Pull/Push — шаг 3; сейчас доступен только ingest_test (суперадмин)" });
}
