// api/planner.js — ДВИЖОК «ЦЕЛЬ → ПЛАН → ЗАДАЧИ» (Часть A) + УТРЕННИЙ ОТЧЁТ ПО ЦЕЛИ (Часть B).
//
// ФИЛОСОФИЯ: владелец задаёт цель (goal.js) → planner детерминированно считает РАЗРЫВ до цели, раскладывает
// его на рычаги (арифметика, НЕ LLM), затем LLM ФОРМУЛИРУЕТ задачи ИЗ ГОТОВЫХ ЧИСЕЛ. Первый план под цель
// НЕ уходит людям сам — сперва владельцу на подтверждение (кнопки pl:confirm|reject|recalc), как у meta-brain.
// Только после «Подтвердить» задачи реально создаются (РОП → appdata.customPlan.sales, маркетолог →
// addMarketingTask) и дальше их ведёт task-agent (пинг/эскалация). Если владелец молчит — напоминаем.
//
// ГРАНИЦЫ: числа считаем сами (не LLM); если данных не хватает (forecast недиагностируется) — НЕ строим план
// вслепую, честно показываем «план не построен: чего не хватает». sendTg только owner (до подтверждения).

import { getGoal, setGoal } from "./goal.js";
import { getVerifiedFunnel } from "./dev-agent.js";
import { sendTg, getPeople } from "./tg-bot.js";
import { addMarketingTask } from "./task-agent.js";
import { ROUTINE, getAutonomy, classifyTaskRisk, reassessBeforeDispatch, isWhitelisted, touchWhitelist, autonomousCountToday, recordAutonomous, getTodayAutonomous } from "./autonomy.js";
import { assessRealism } from "./goal-realism.js"; // проверка реалистичности: split задач + гейт автономии

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ORG = "hunter";
const MODEL = "claude-sonnet-5";
const REMIND_AFTER_H = 6; // напомнить владельцу, если план не подтверждён N часов

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
const K = { pending: `planner:pending:${ORG}`, active: `planner:active:${ORG}`, appdata: `appdata:${ORG}`, history: `planner:history:${ORG}` };
async function archivePlan(rec, status) { try { const h = await rgetJSON(K.history, []); h.push({ periodKey: rec.periodKey, at: rec.at, closedAt: Date.now(), status, gap: rec.plan && rec.plan.facts && rec.plan.facts.gap, tasks: rec.plan && rec.plan.tasks }); await rsetJSON(K.history, h.slice(-60)); } catch (e) {} }
const num = (n) => (n == null ? "н/д" : Number(Math.round(n)).toLocaleString("ru-RU"));
const tkNow = () => new Date(Date.now() + 5 * 3600000);

// ── РАБОЧИЕ ДНИ периода (та же логика, что дашборд: считаем по будням из настроек, воскресенье по умолч. выходной)
export async function workingDays(period) {
  const cfg = (await rgetJSON("settings:hunter", {})) || {}; // рабочий график живёт в settings:<org>, не в metricscfg
  const wd = Array.isArray(cfg.workdays) && cfg.workdays.length ? cfg.workdays : [1, 2, 3, 4, 5, 6]; // Пн-Сб
  const today = tkNow().toISOString().slice(0, 10);
  let total = 0, passed = 0;
  const s = new Date(period.start + "T00:00:00Z"), e = new Date(period.end + "T00:00:00Z");
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    if (!wd.includes(d.getUTCDay())) continue;
    total++;
    if (d.toISOString().slice(0, 10) <= today) passed++;
  }
  return { total, passed, left: Math.max(0, total - passed) };
}

// ── ФАКТЫ из verified-воронки (без LLM) ──
export function funnelFacts(funnel) {
  if (!funnel) return null;
  const deal = (funnel.stages || []).find((s) => /Сделка выиграна/.test(s.stage));
  const leadsStage = (funnel.stages || []).find((s) => /Лиды/.test(s.stage));
  const revenue = deal ? deal.money : null;         // касса месяца (соответствует форекасту дашборда)
  const sold = deal ? deal.value : null;
  const leads = leadsStage ? leadsStage.value : null;
  const avgCheck = (funnel.avgCheck && (funnel.avgCheck.median || funnel.avgCheck.mean)) || null;
  const conv = (leads && sold != null) ? sold / leads : null; // лид → сделка
  const trust = deal ? deal.trust : "insufficient";
  return { revenue, sold, leads, avgCheck, conv, trust, bottleneck: funnel.bottleneck || null, telephonySuspicious: funnel.telephonySuspicious, dataFresh: funnel.dataFresh };
}

// ── РАЗБИВКА РАЗРЫВА (детерминированно) ──
export function decomposeGap(gapUZS, f) {
  // сколько ДОП. продаж закрывает разрыв
  const extraSales = f.avgCheck ? Math.ceil(gapUZS / f.avgCheck) : null;
  const half = gapUZS / 2;
  const canLeads = !!(f.conv && f.avgCheck && f.conv > 0);  // рычаг «больше лидов» применим?
  const canConv = !!(f.leads && f.avgCheck && f.sold != null); // рычаг «выше конверсия» применим?
  let leadsLever = null, convLever = null;
  if (canLeads && canConv) {
    // 50/50
    const salesFromLeads = Math.ceil(half / f.avgCheck);
    leadsLever = { extraSales: salesFromLeads, extraLeads: Math.ceil(salesFromLeads / f.conv) };
    const salesFromConv = Math.ceil(half / f.avgCheck);
    const targetSold = (f.sold || 0) + salesFromConv;
    convLever = { extraSales: salesFromConv, currentConvPct: +(f.conv * 100).toFixed(1), neededConvPct: +((targetSold / f.leads) * 100).toFixed(1) };
  } else if (canLeads) {
    leadsLever = { extraSales, extraLeads: Math.ceil(extraSales / f.conv) };
  } else if (canConv) {
    const targetSold = (f.sold || 0) + (extraSales || 0);
    convLever = { extraSales, currentConvPct: f.conv != null ? +(f.conv * 100).toFixed(1) : null, neededConvPct: f.leads ? +((targetSold / f.leads) * 100).toFixed(1) : null };
  }
  return { extraSales, leadsLever, convLever };
}

// ── СБОРКА ПЛАНА (детерминированно) + формулировка задач (LLM из готовых чисел) ──
export async function buildPlan(org = ORG, opts = {}) {
  const goal = await getGoal(org);
  if (!goal || !goal.amountUZS) return { ok: false, reason: "no_goal", human: "Цель не задана — задайте цель, чтобы построить план." };
  const funnel = await getVerifiedFunnel(org).catch(() => null);
  const f = funnelFacts(funnel);
  const period = goal.period || null;
  if (!f || !period) return { ok: false, reason: "no_data", human: "Нет данных воронки/периода — план не построен." };

  // ГЕЙТ ДАННЫХ: не строим план вслепую
  const missing = [];
  if (f.trust !== "verified") missing.push("по продажам и выручке пока мало данных, чтобы строить план");
  if (f.revenue == null) missing.push("нет выручки за период");
  if (!f.avgCheck) missing.push("нет среднего чека");
  const wdays = await workingDays(period);
  if (!wdays.passed) missing.push("период ещё не начался — нет темпа");

  const earned = f.revenue || 0;
  const perWorkday = wdays.passed ? earned / wdays.passed : null;
  const forecast = perWorkday != null ? Math.round(perWorkday * wdays.total) : null;
  const gap = forecast != null ? goal.amountUZS - forecast : null;

  if (missing.length || forecast == null) {
    return { ok: false, reason: "undiagnosable", missing, human: `План не построен: ${missing.join("; ") || "недостаточно данных для прогноза"}.`, facts: f, period, earned, forecast };
  }

  const gapPct = goal.amountUZS > 0 ? +(gap / goal.amountUZS * 100).toFixed(1) : null;
  // КАЧЕСТВО БАЗЫ: выигранные без суммы занижают выручку/чек → база под цель неточна (не выдаём как факт).
  const _dq = await rgetJSON("dashboard", null);
  const _wna = _dq && _dq.dataQuality && _dq.dataQuality.wonNoAmount;
  const baseInaccurate = (_wna && _wna.inaccurate) ? { reason: "won_no_amount", count: _wna.count, sharePct: _wna.sharePct } : null;
  const facts = { goalUZS: goal.amountUZS, currency: goal.currency, amount: goal.amount, period, earned, sold: f.sold, leads: f.leads, avgCheck: f.avgCheck, convPct: f.conv != null ? +(f.conv * 100).toFixed(1) : null, perWorkday, forecast, gap, gapPct, workdays: wdays, bottleneck: f.bottleneck, trust: f.trust, dataFresh: f.dataFresh, telephonySuspicious: f.telephonySuspicious, baseInaccurate };

  if (gap <= 0) {
    return { ok: true, onPace: true, facts, decomposition: null, tasks: { rop: [], marketing: [] }, human: `На текущем темпе цель достигается (прогноз ${num(forecast)} ≥ цель ${num(goal.amountUZS)} сум). План догона не требуется.` };
  }
  // НИЖНИЙ ПОРОГ, ЧУВСТВИТЕЛЬНЫЙ К ОСТАТКУ ВРЕМЕНИ: «шумовая» полоса, которую темп закроет сам, СУЖАЕТСЯ к концу
  // периода. В начале месяца 5% разрыва — норма (дней много). За день до конца те же 5% темп уже не вытянет —
  // «закроет сам» звучало бы ложно. Порог = gapPctMin × доля оставшегося времени, но не ниже 1% (чтобы не срабатывать на пыли округления).
  const timeFrac = wdays.total ? wdays.left / wdays.total : 1;
  const gapPctMinEff = Math.max(1, +(ROUTINE.gapPctMin * timeFrac).toFixed(2));
  if (gapPct != null && gapPct < gapPctMinEff) {
    const nearEnd = timeFrac <= 0.34;
    return { ok: true, onPace: true, belowThreshold: true, facts, decomposition: null, tasks: { rop: [], marketing: [] }, human: `Разрыв ${gapPct}% (${num(gap)} сум) — в пределах нормальных колебаний (<${gapPctMinEff}%${nearEnd ? ", порог ужат под конец периода" : ""}). Текущий темп закрывает его сам, дёргать людей не нужно.` };
  }

  // ── РЕАЛИЗМ: не перекладываем НЕВЫПОЛНИМУЮ часть цели на исполнителей (принцип «б»). ──
  // Если цель ЖЁСТКО упирается в людей (binding "team" — нужно больше исторического потолка), задачи строим
  // под ДОСТИЖИМУЮ часть (feasibleGoal по устойчивому темпу), а разрыв сверх неё — это РЕШЕНИЕ ВЛАДЕЛЬЦА
  // (+K менеджеров / бюджет), а не задача исполнителю. team_strain/capacity_unknown НЕ режем (цель достижима
  // либо не проверена) — там задачи под полную цель, но автономия всё равно гейтится (см. proposePlan).
  const realism = opts.realism || await assessRealism(org).catch(() => null);
  const realismBrief = realism && realism.computable ? { binding: realism.binding, feasible: realism.feasible, feasibleGoal: realism.feasibleGoal, addManagers: realism.addManagers } : null;
  let targetGap = gap;
  if (realism && realism.binding === "team" && realism.feasibleGoal != null && realism.feasibleGoal < goal.amountUZS) {
    const effectiveGoalUZS = Math.round(realism.feasibleGoal);
    targetGap = Math.max(0, Math.round(effectiveGoalUZS - forecast));
    facts.ownerDecision = { unreachableUZS: Math.round(goal.amountUZS - effectiveGoalUZS), feasibleGoalUZS: effectiveGoalUZS, addManagers: realism.addManagers || null };
    facts.effectiveGoalUZS = effectiveGoalUZS;
    facts.targetGap = targetGap;
    // весь разрыв за пределами возможностей команды → исполнителям задач НЕТ, это только решение владельца
    if (targetGap <= 0) {
      return { ok: true, onPace: false, allOwnerDecision: true, facts, realism: realismBrief, decomposition: null, tasks: { rop: [], marketing: [] },
        human: `Команда уже работает на максимуме устойчивого темпа. Разрыв ${num(gap)} сум до цели закрыть силами текущей команды нельзя — это решение владельца: ${realism.addManagers ? `+${realism.addManagers} менеджер(ов)` : "расширение команды"} либо снижение цели до ~${num(effectiveGoalUZS)} сум.` };
    }
  }

  const dec = decomposeGap(targetGap, f);

  // LLM формулирует ЗАДАЧИ ИЗ ГОТОВЫХ ЧИСЕЛ (не считает). Опора — реальное узкое место воронки.
  let tasks = { rop: [], marketing: [] };
  if (AKEY) {
    const sys = `Ты — операционный директор Altrone. Тебе дают ГОТОВЫЕ ЧИСЛА разрыва до цели и узкое место воронки.
Твоя задача — сформулировать КОНКРЕТНЫЕ задачи для их закрытия. Числа НЕ меняй и НЕ выдумывай новые — бери из данных.
2-3 задачи для РОПа (отдел продаж: конверсия, дозвон, закрытие, работа менеджеров — опирайся на узкое место) и 1-2 для маркетолога (реклама/лиды/аудитории — если рычаг «больше лидов» применим).
Каждая задача: короткий title, why (почему и какое число закрывает), первый шаг. Срок — в рамках периода.
Верни СТРОГО JSON без markdown:
{"rop":[{"title":"...","why":"...","step":"...","deadlineDays":7}],"marketing":[{"title":"...","why":"...","step":"...","deadlineDays":7}]}
Язык — русский, простыми словами для владельца. Если рычаг маркетинга не дан в данных — marketing оставь пустым.`;
    const userMsg = `ЦЕЛЬ: ${num(goal.amountUZS)} сум за ${period.label}. Заработано ${num(earned)}, прогноз на конце ${num(forecast)}.
${facts.ownerDecision ? `ВНИМАНИЕ: часть цели выше возможностей команды. Задачи ставь ТОЛЬКО под ДОСТИЖИМУЮ часть — разрыв ${num(targetGap)} сум (до ~${num(facts.effectiveGoalUZS)} сум). Остаток ${num(facts.ownerDecision.unreachableUZS)} сум — решение владельца (+менеджеры/бюджет), НЕ ставь под него задачи людям.` : `РАЗРЫВ ${num(targetGap)} сум.`}
Средний чек ${num(f.avgCheck)} сум → нужно ещё ~${dec.extraSales} продаж.
Рычаг «больше лидов»: ${dec.leadsLever ? `+${dec.leadsLever.extraLeads} лидов даёт +${dec.leadsLever.extraSales} продаж при текущей конверсии` : "не применим (нет данных конверсии)"}.
Рычаг «выше конверсия»: ${dec.convLever ? `поднять конверсию с ${dec.convLever.currentConvPct}% до ${dec.convLever.neededConvPct}% при текущем потоке лидов` : "не применим"}.
Узкое место воронки: ${f.bottleneck ? `${f.bottleneck.stage} (переход «${f.bottleneck.transition}», конверсия ${f.bottleneck.pct}%)` : "не выделено"}.
Осталось рабочих дней в периоде: ${wdays.left}.`;
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: MODEL, max_tokens: 1500, system: sys, messages: [{ role: "user", content: userMsg }] }) });
      const d = await r.json();
      const txt = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim();
      const m = txt.match(/\{[\s\S]*\}/); const o = m ? JSON.parse(m[0]) : null;
      if (o) tasks = { rop: Array.isArray(o.rop) ? o.rop.slice(0, 3) : [], marketing: Array.isArray(o.marketing) ? o.marketing.slice(0, 2) : [] };
    } catch (e) { /* задачи не сформулировались — план всё равно вернём с числами */ }
  }
  // ДЕТЕРМИНИРОВАННЫЙ topicKey (НЕ из LLM-текста): РОП-задачи закрывают узкое место (in-process), маркетинг = лиды
  for (const t of (tasks.rop || [])) { t.topicKey = "rop_conversion"; t.recipient = "rop"; }
  for (const t of (tasks.marketing || [])) { t.topicKey = "mkt_leads"; t.recipient = "marketing"; }
  return { ok: true, onPace: false, facts, decomposition: dec, tasks, realism: realismBrief, human: null };
}

function fmtPlanForOwner(plan) {
  const f = plan.facts;
  const pct = f.goalUZS ? Math.round(f.earned / f.goalUZS * 100) : 0;
  let s = `🎯 <b>План под цель · ${f.period.label}</b>\n\n`;
  s += `Цель: <b>${num(f.goalUZS)} сум</b>${f.currency === "USD" ? ` ($${num(f.amount)})` : ""}\n`;
  s += `Заработано: ${num(f.earned)} (${pct}%) · прогноз на конце: <b>${num(f.forecast)}</b>\n`;
  if (plan.onPace) { s += `\n✅ ${plan.human}`; return s; }
  s += `Разрыв до цели: <b>${num(f.gap)} сум</b> ≈ ${plan.decomposition.extraSales} доп. продаж.\n`;
  s += `Осталось рабочих дней: ${f.workdays.left}.\n`;
  // РЕАЛИЗМ (принцип «б»): если часть цели выше возможностей команды — задачи только под достижимую часть,
  // а невыполнимый остаток честно помечен как РЕШЕНИЕ ВЛАДЕЛЬЦА, а не спущен исполнителям задачей.
  if (f.ownerDecision) {
    s += `\n⚠️ <b>Часть цели выше устойчивых возможностей команды.</b> Задачи ниже — под достижимую часть (~${num(f.effectiveGoalUZS)} сум). Разрыв сверх неё (<b>${num(f.ownerDecision.unreachableUZS)} сум</b>) силами текущей команды не закрыть — это ваше решение: ${f.ownerDecision.addManagers ? `+${f.ownerDecision.addManagers} менеджер(ов)` : "расширение команды"} или скорректировать цель.\n`;
  }
  if (plan.decomposition.leadsLever) s += `• Маркетинг: +${plan.decomposition.leadsLever.extraLeads} лидов → +${plan.decomposition.leadsLever.extraSales} продаж.\n`;
  if (plan.decomposition.convLever && plan.decomposition.convLever.neededConvPct != null) s += `• Продажи: конверсия ${plan.decomposition.convLever.currentConvPct}% → ${plan.decomposition.convLever.neededConvPct}%.\n`;
  if (f.bottleneck) s += `• Узкое место: ${f.bottleneck.stage} (${f.bottleneck.pct}%).\n`;
  const line = (t) => `  – «${t.title}»${t.why ? ` — ${t.why}` : ""}${t.deadlineDays ? ` (срок ${t.deadlineDays} дн.)` : ""}`;
  if (plan.tasks.rop.length) s += `\n<b>РОПу:</b>\n${plan.tasks.rop.map(line).join("\n")}\n`;
  if (plan.tasks.marketing.length) s += `\n<b>Маркетологу:</b>\n${plan.tasks.marketing.map(line).join("\n")}\n`;
  s += `\n<i>Это ПРЕДЛОЖЕНИЕ — задачи ещё не разосланы. Подтвердите, чтобы поставить их РОПу и маркетологу.</i>`;
  return s;
}

// ── ПРЕДЛОЖИТЬ ПЛАН ВЛАДЕЛЬЦУ (крон/ручной). Если план уже строился под этот период — не спамим. ──
export async function proposePlan(org = ORG, force = false, opts = {}) {
  const goal = await getGoal(org);
  if (!goal || !goal.amountUZS) return { ok: false, reason: "no_goal" };
  const pending = await rgetJSON(K.pending, null);
  const active = await rgetJSON(K.active, null);
  const periodKey = goal.period ? goal.period.label : "";
  // уже подтверждён план под этот период → ничего не делаем
  if (!force && active && active.periodKey === periodKey) return { ok: true, skipped: "already_active", periodKey };
  // есть неподтверждённое предложение под этот период → НЕ шлём отдельное напоминание: оно теперь строкой в
  // утреннем отчёте по команде («⏳ план ждёт подтверждения» + кнопки), каждый день, пока не решено.
  if (!force && pending && pending.periodKey === periodKey) {
    return { ok: true, skipped: "pending_waiting", periodKey };
  }
  const plan = await buildPlan(org, opts);
  const ppl = await getPeople();
  // ВЕСЬ РАЗРЫВ за пределами команды → нет задач исполнителям, только решение владельца. Не автодиспатчим, не плодим pending.
  if (plan.allOwnerDecision) {
    if (opts.channel !== "chat" && ppl.owner && ppl.owner.chatId) await sendTg("owner", ppl.owner.chatId, `🎯 <b>Цель «${periodKey}»</b>\n\n${plan.human}`);
    await rsetJSON(K.active, { periodKey, at: Date.now(), ownerDecisionOnly: true, facts: plan.facts });
    return { ok: true, ownerDecisionOnly: true, periodKey, human: plan.human, preview: plan.human };
  }
  if (!plan.ok) {
    // не строим вслепую — честно сообщаем владельцу, чего не хватает (из чата — вернём в чат, не в Telegram)
    if (opts.channel !== "chat" && ppl.owner && ppl.owner.chatId) await sendTg("owner", ppl.owner.chatId, `🎯 <b>План под цель · ${periodKey}</b>\n\n${plan.human || "План не построен."}`);
    return { ok: false, reason: plan.reason, notified: opts.channel !== "chat", human: plan.human };
  }
  if (plan.onPace) {
    if (opts.channel !== "chat" && ppl.owner && ppl.owner.chatId) await sendTg("owner", ppl.owner.chatId, fmtPlanForOwner(plan));
    await rsetJSON(K.active, { periodKey, onPace: true, at: Date.now() });
    return { ok: true, onPace: true, human: plan.human };
  }
  if (pending && pending.periodKey && pending.periodKey !== periodKey) await archivePlan(pending, "expired_unconfirmed");

  // ── КЛАССИФИКАЦИЯ рутина vs стратегия (на числах) → авто-раздача рутинных, гейт остальных ──
  const facts = plan.facts;
  const auto = await getAutonomy();
  // НЕРЕАЛИСТИЧНОСТЬ = ВСЕГДА ГЕЙТ ВЛАДЕЛЬЦА, независимо от классификатора рутинности. Если цель не признана
  // выполнимой (team / team_strain / capacity_unknown → feasible=false), автономия НЕ раздаёт задачи сама.
  const forceGate = !!(plan.realism && plan.realism.feasible === false);
  const baseCtx = { autonomyEnabled: auto.enabled, gapPct: facts.gapPct, gapAbs: facts.gap, funnelTrust: facts.trust, dataFresh: facts.dataFresh, telephonySuspicious: facts.telephonySuspicious, maxPerDay: auto.maxPerDay, maxPerRopChat: auto.maxPerRopChat };
  const allTasks = [...(plan.tasks.rop || []).map((t) => ({ ...t, recipient: "rop" })), ...(plan.tasks.marketing || []).map((t) => ({ ...t, recipient: "marketing" }))];
  const gatedTasks = { rop: [], marketing: [] };
  const dispatched = [];
  for (const t of allTasks) {
    const wl = t.recipient === "rop" ? await isWhitelisted(t.topicKey, facts.gap) : false;
    // ПОВТОРНАЯ проверка ЖИВОГО флага + лимитов ПРЯМО ПЕРЕД отправкой (закрывает гонку kill switch ↔ раздача)
    const d = await reassessBeforeDispatch(t, { ...baseCtx, whitelisted: wl });
    if (d.decision === "skip") continue; // разрыв в пределах шума — задача не нужна вовсе
    if (d.decision === "auto" && !forceGate) {
      const id = await createRopPlanTask(t, periodKey);
      await touchWhitelist(t.topicKey, facts.gap);
      await recordAutonomous({ taskId: id, title: t.title, recipient: "rop", topicKey: t.topicKey, gap: facts.gap, reason: d.reason });
      dispatched.push({ id, title: t.title });
      // ПОСТФАКТУМ владельцу — с кнопкой отзыва (автономно ≠ втайне)
      if (ppl.owner && ppl.owner.chatId) await sendTg("owner", ppl.owner.chatId, `🤖 Автоматически поставил РОПу рутинную задачу: «${t.title}».\nРазрыв ${facts.gapPct}%, тема уже подтверждалась ранее. Если не согласны — отзовите.`, { reply_markup: { inline_keyboard: [[{ text: "❌ Отозвать", callback_data: `au:cancel:${id}` }]] } });
    } else {
      gatedTasks[t.recipient].push(t);
    }
  }

  const hasGated = (gatedTasks.rop.length + gatedTasks.marketing.length) > 0;
  if (!hasGated) { // всё ушло автономно (или гейтить нечего) — pending не создаём
    await rsetJSON(K.active, { periodKey, at: Date.now(), autoOnly: true, dispatched, facts });
    return { ok: true, autoDispatched: dispatched.length, gated: 0, periodKey };
  }
  // gated-часть → владельцу на подтверждение
  const gatedPlan = { ...plan, tasks: gatedTasks };
  const rec = { periodKey, at: Date.now(), plan: gatedPlan, reminded: false, autoDispatched: dispatched.length };
  await rsetJSON(K.pending, rec);
  let sent = false;
  // Из ЧАТА план показывается прямо в чате (советник + кнопки) — в Telegram НЕ дублируем сразу.
  // Если владелец не подтвердит и уйдёт — крон-напоминание (см. начало функции) пришлёт в Telegram как фолбэк.
  if (opts.channel !== "chat" && ppl.owner && ppl.owner.chatId) {
    const kb = { reply_markup: { inline_keyboard: [
      [{ text: "✅ Подтвердить и раздать", callback_data: "pl:confirm" }],
      [{ text: "🔄 Пересчитать", callback_data: "pl:recalc" }, { text: "❌ Отклонить", callback_data: "pl:reject" }],
    ] } };
    const extra = dispatched.length ? `\n\n🤖 ${dispatched.length} рутинн(ых) задач(и) уже поставил сам (см. отдельные сообщения).` : "";
    const r = await sendTg("owner", ppl.owner.chatId, fmtPlanForOwner(gatedPlan) + extra, kb);
    sent = !!(r && r.ok);
  }
  return { ok: true, proposed: true, channel: opts.channel || "telegram", sent, autoDispatched: dispatched.length, gated: gatedTasks.rop.length + gatedTasks.marketing.length, periodKey, preview: fmtPlanForOwner(gatedPlan) };
}

// создание РОП-задачи плана (используется и авто-раздачей, и подтверждением) → id
async function createRopPlanTask(t, periodKey) {
  const app = (await rgetJSON(K.appdata, {})) || {};
  app.customPlan = app.customPlan || {}; if (!Array.isArray(app.customPlan.sales)) app.customPlan.sales = [];
  const dl = t.deadlineDays ? new Date(Date.now() + t.deadlineDays * 86400000 + 5 * 3600000).toISOString().slice(0, 10) : "";
  const id = "plan_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  app.customPlan.sales.push({ id, t: t.title, d: [t.why, t.step].filter(Boolean).join(" — "), deadline: dl, steps: t.step ? [t.step] : [], source: "planner", topicKey: t.topicKey || null, goalPeriod: periodKey, createdAt: Date.now() });
  await rsetJSON(K.appdata, app);
  return id;
}

// ── КНОПКИ ПЛАНА (pl:confirm|reject|recalc) — из tg-bot webhook ──
export async function handlePlanButton(act) {
  const pending = await rgetJSON(K.pending, null);
  if (!pending || !pending.plan) return { toast: "план не найден" };
  if (act === "reject") {
    await archivePlan(pending, "rejected"); // в историю: что предлагали, но владелец отклонил
    await rsetJSON(K.pending, null);
    await rsetJSON(K.active, { periodKey: pending.periodKey, rejected: true, at: Date.now() });
    return { toast: "План отклонён", ownerMsg: `❌ План под цель «${pending.periodKey}» отклонён — задачи не раздаются.` };
  }
  if (act === "recalc") {
    await rsetJSON(K.pending, null);
    const r = await proposePlan(ORG, true);
    return { toast: "Пересчитал", ownerMsg: r.onPace ? null : "🔄 Пересчитал план по свежим данным — см. новое предложение выше." };
  }
  if (act === "confirm") {
    const plan = pending.plan;
    const created = { rop: [], marketing: [] };
    const gapForWl = plan.facts && plan.facts.gap;
    const dl = (days) => days ? new Date(Date.now() + days * 86400000 + 5 * 3600000).toISOString().slice(0, 10) : "";
    // РОП-задачи → план Altrone (task-agent ведёт). Подтверждение владельца → тема в whitelist (дальше идентичная — авто).
    for (const t of (plan.tasks.rop || [])) {
      const id = await createRopPlanTask(t, pending.periodKey);
      created.rop.push(id);
      if (t.topicKey && gapForWl != null) await touchWhitelist(t.topicKey, gapForWl);
    }
    // Маркетинг-задачи → канал маркетолога (в whitelist НЕ добавляем — маркетинг всегда под гейтом)
    for (const t of (plan.tasks.marketing || [])) {
      const r = await addMarketingTask({ title: t.title, why: t.why, action: t.step, deadline: dl(t.deadlineDays), source: "planner" });
      created.marketing.push(r.id);
    }
    await rsetJSON(K.active, { periodKey: pending.periodKey, at: Date.now(), confirmedAt: Date.now(), taskIds: created, facts: plan.facts });
    await rsetJSON(K.pending, null);
    // отметим в цели, что план построен
    try { const g = await getGoal(); if (g) { g.planBuiltFor = pending.periodKey; await rsetJSON(`goal:${ORG}`, g); } } catch (e) {}
    // триггерим тик, чтобы задачи начали разноситься сразу
    return { toast: "Готово — раздаю задачи", ownerMsg: `✅ План принят. Поставил РОПу ${created.rop.length} задач(и) и маркетологу ${created.marketing.length}. Веду их: напоминаю, проверяю статус, эскалирую срывы.`, triggerTick: true };
  }
  return { toast: "?" };
}

// ── РЕШЕНИЕ ВЛАДЕЛЬЦА по НЕДОСТИЖИМОЙ части цели (ownerDecision). Не задача людям: расширить команду/бюджет —
// это реальный мир, система не исполняет. Единственное, что она МОЖЕТ сделать по кнопке — снизить цель до
// достижимой (setGoal → пересборка плана). «Оставить» — владелец держит амбициозную цель, решение за ним. ──
export async function getOwnerDecision(org = ORG) {
  const active = await rgetJSON(K.active, null);
  const pending = await rgetJSON(K.pending, null);
  if (active && active.ownerDecisionOnly && !active.odDismissed && active.facts && active.facts.ownerDecision) return { od: active.facts.ownerDecision, scope: "full" };
  if (pending && pending.plan && pending.plan.facts && pending.plan.facts.ownerDecision && !pending.odDismissed) return { od: pending.plan.facts.ownerDecision, scope: "partial" };
  return null;
}

export async function handleOwnerDecision(act, org = ORG) {
  const cur = await getOwnerDecision(org);
  if (!cur) return { toast: "решение неактуально" }; // уже снято/цель изменилась → повтор из другого канала = no-op
  const od = cur.od;
  if (act === "dismiss") {
    const active = await rgetJSON(K.active, null); if (active && active.ownerDecisionOnly) { active.odDismissed = true; await rsetJSON(K.active, active); }
    const pending = await rgetJSON(K.pending, null); if (pending && pending.plan) { pending.odDismissed = true; await rsetJSON(K.pending, pending); }
    return { toast: "Оставил как есть", ownerMsg: `Ок, цель оставляю. Разрыв сверх возможностей команды (${num(od.unreachableUZS)} сум) остаётся вашим решением — расширить команду или бюджет.` };
  }
  if (act === "lower") {
    const g = await getGoal(org);
    if (!g || !od.feasibleGoalUZS) return { toast: "цель не найдена" };
    const newUZS = Math.round(od.feasibleGoalUZS);
    const adj = { ...g, amountUZS: newUZS, amount: g.currency === "USD" ? Math.round(newUZS / (g.rate || 1)) : newUZS };
    delete adj.planBuiltFor;
    await setGoal(adj, org);
    await rsetJSON(K.pending, null);                                   // старый план под прежнюю цель снимаем
    await rsetJSON(K.active, { periodKey: g.period ? g.period.label : "", at: Date.now(), lowered: true });
    const pr = await proposePlan(org, true, {}).catch(() => null);     // пересобрать план под достижимую цель
    return { toast: "Цель снижена", triggerTick: false, ownerMsg: `✅ Цель снижена до ${num(newUZS)} сум — теперь в пределах команды. Пересобрал план под неё.` };
  }
  return { toast: "?" };
}

// ── ЧАСТЬ B: УТРЕННИЙ ОТЧЁТ ПО ЦЕЛИ (детерминированный, без LLM-тона) ──
export async function buildDailyReport(org = ORG) {
  const goal = await getGoal(org);
  // ГРОМКО, а не молча: без цели утренний отчёт не исчезает, а прямо говорит, чего не хватает.
  if (!goal || !goal.amountUZS) return { ok: true, noGoal: true, human: `🌅 <b>С чего начать день</b>\n\n⚠️ <b>Цель на период не задана.</b>\nЯ не строю план догона и не могу сказать, идёте ли вы к результату. Задайте цель одной фразой в чат: <b>сумма + период</b> — напр. «выручка 1.2 млрд сум за август» или «$100 000 в этом месяце». Как зададите — сразу пришлю план.` };
  const plan = await buildPlan(org); // пересчитываем факты/разрыв на сегодня
  const g = plan.facts || {};
  const active = await rgetJSON(K.active, null);
  let s = `🌅 <b>С чего начать день · ${goal.period ? goal.period.label : ""}</b>\n\n`;
  if (!plan.ok) { s += plan.human || "Данных для оценки цели пока недостаточно."; return { ok: true, human: s, plan }; }
  const pct = g.goalUZS ? Math.round(g.earned / g.goalUZS * 100) : 0;
  const periodPct = g.workdays && g.workdays.total ? Math.round(g.workdays.passed / g.workdays.total * 100) : 0;
  s += `Цель: ${num(g.goalUZS)} сум · заработано <b>${num(g.earned)} (${pct}%)</b> · период пройден на ${periodPct}%\n`;
  if (plan.onPace) s += `✅ На темпе: прогноз ${num(g.forecast)} ≥ цель.\n`;
  else s += `⚠️ Разрыв до цели: <b>${num(g.gap)} сум</b> (≈${plan.decomposition ? plan.decomposition.extraSales : "?"} продаж), осталось ${g.workdays.left} раб. дн.\n`;

  // КАЧЕСТВО ДАННЫХ — самодокладываемая строка: won-без-суммы искажают выручку/чек/базу под цель.
  try {
    const dq = await rgetJSON("dashboard", null);
    const wna = dq && dq.dataQuality && dq.dataQuality.wonNoAmount;
    if (wna && wna.count > 0) s += `\n📉 <b>Качество данных:</b> ${wna.count} выигранн${wna.count === 1 ? "ая сделка" : "ых сделок"} без суммы (${wna.sharePct}% продаж) — выручка и средний чек занижены на эту величину${wna.inaccurate ? ", <b>база под цель НЕТОЧНА</b>" : ""}. Поручите РОПу заполнить суммы.\n`;
  } catch (e) {}

  // ПОСТФАКТУМ: что система поставила САМА (автономно ≠ втайне)
  const autoToday = await getTodayAutonomous();
  if (autoToday.length) s += `\n🤖 Сегодня система сама поставила: ${autoToday.map((x) => `«${x.title}»`).join(", ")}. Не согласны — отзовите в отдельных сообщениях выше.\n`;

  // Активные задачи последнего плана: сколько выполнено/просрочено, критичное сверху
  if (active && active.taskIds) {
    const app = (await rgetJSON(K.appdata, {})) || {}; const done = (app.done) || {};
    const salesPlan = (app.customPlan && app.customPlan.sales) || [];
    const mk = await rgetJSON("marketingtasks", []);
    const st = await rgetJSON("taskagent:status", {});
    const rows = [];
    for (const id of (active.taskIds.rop || [])) { const q = salesPlan.find((x) => x.id === id); if (!q) continue; const isDone = !!done[id]; const overdue = q.deadline && q.deadline < tkNow().toISOString().slice(0, 10) && !isDone; rows.push({ title: q.t, done: isDone, overdue, who: "РОП" }); }
    for (const id of (active.taskIds.marketing || [])) { const t = mk.find((x) => x.id === id); if (!t) continue; const isDone = t.status === "done"; const overdue = t.deadline && t.deadline < tkNow().toISOString().slice(0, 10) && !isDone; rows.push({ title: t.title, done: isDone, overdue, who: "Маркетолог" }); }
    const total = rows.length, doneN = rows.filter((r) => r.done).length, overdueN = rows.filter((r) => r.overdue).length;
    if (total) {
      s += `\n📋 Задачи плана: ${doneN}/${total} выполнено${overdueN ? `, ⚠️ ${overdueN} просрочено` : ""}.\n`;
      const crit = rows.filter((r) => !r.done).sort((a, b) => (b.overdue - a.overdue))[0];
      if (crit) s += `Самое важное: «${crit.title}» (${crit.who})${crit.overdue ? " — просрочено" : ""}.\n`;
    }
  } else {
    // план предложен, но владелец не решил → показываем ЯВНО, что он завис (а не «плана нет»)
    const pending = await rgetJSON(K.pending, null);
    if (pending && pending.at) {
      const d = new Date(pending.at + 5 * 3600000).toISOString().slice(0, 10);
      const days = Math.floor((Date.now() - pending.at) / 86400000);
      s += `\n⏳ План от ${d} ждёт вашего решения${days >= 1 ? ` (${days} дн.)` : ""} — Подтвердить / Отклонить (в owner-боте).\n`;
    } else {
      s += `\n📋 План под цель ещё не построен.\n`;
    }
  }
  // одна главная рекомендация из узкого места
  if (g.bottleneck) s += `\n🎯 Фокус дня: узкое место — ${g.bottleneck.stage} (конверсия ${g.bottleneck.pct}%). Разберитесь здесь в первую очередь.`;
  return { ok: true, human: s, plan };
}

export async function sendDailyReport(org = ORG) {
  const rep = await buildDailyReport(org);
  if (!rep.ok || !rep.human) return { ok: false };
  const ppl = await getPeople();
  if (ppl.owner && ppl.owner.chatId) { await sendTg("owner", ppl.owner.chatId, rep.human); return { ok: true, sent: true }; }
  return { ok: true, sent: false };
}

// ── ЧАСТЬ C: КОНЕЦ МЕСЯЦА → САМ СПРОСИ ЦЕЛЬ НА СЛЕДУЮЩИЙ ──
// Крон дёргает по дням 28-31; шлём РОВНО ОДИН раз за месяц: 30-го числа, а в феврале (нет 30-го) — в последний день.
// Владелец отвечает целью прямо в чат → срабатывает обычный путь цель→реализм→план.
const MONTHS_RU_FULL = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
function monthLabel(mIdx) { const m = ((mIdx % 12) + 12) % 12; return MONTHS_RU_FULL[m]; }
function monthLabelY(y, mIdx) { const yy = y + Math.floor(mIdx / 12); return `${monthLabel(mIdx)} ${yy}`; }

export async function nextMonthPrompt(org = ORG) {
  const now = tkNow(); // Ташкент (как везде в файле: читаем UTC-поля со сдвинутой даты)
  const day = now.getUTCDate(), y = now.getUTCFullYear(), m = now.getUTCMonth();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // ВЫЧИСЛЯЕМ: 28/29/30/31 по месяцу
  if (day !== lastDay) return { ok: true, skipped: "not_last_day", day, lastDay }; // крон ходит ежедневно (28-31), шлём только в последний день


  const monthKey = `${y}-${String(m + 1).padStart(2, "0")}`;
  const guardKey = `planner:monthprompt:${org}:${monthKey}`;
  if (await rgetJSON(guardKey, null)) return { ok: true, skipped: "already_sent", monthKey }; // одно напоминание за месяц

  const nextLabel = monthLabelY(y, m + 1);
  // если цель на следующий месяц уже задана — не дёргаем впустую
  const goal = await getGoal(org);
  if (goal && goal.period && goal.period.label === nextLabel) {
    await rsetJSON(guardKey, { skippedAt: Date.now(), monthKey, reason: "next_goal_already_set" });
    return { ok: true, skipped: "next_goal_already_set", nextLabel };
  }

  // рекап уходящего месяца (если цель была) — чтобы вопрос шёл с контекстом «как закрыли»
  let recap = "";
  if (goal && goal.amountUZS) {
    try {
      const plan = await buildPlan(org);
      const g = plan.facts || {};
      const pct = g.goalUZS ? Math.round((g.earned || 0) / g.goalUZS * 100) : null;
      recap = `Итоги ${goal.period ? goal.period.label : monthLabelY(y, m)}: цель ${num(goal.amountUZS)} сум` +
        (g.earned != null ? `, заработано ${num(g.earned)}${pct != null ? ` (${pct}%)` : ""}` : "") +
        (g.forecast != null && !plan.onPace ? `, прогноз на конце ${num(g.forecast)}` : "") + `.\n\n`;
    } catch (e) { /* рекап не критичен */ }
  }

  const msg = `📅 <b>Месяц заканчивается</b>\n\n${recap}Пора задать цель на <b>${nextLabel}</b>. Напишите её одной фразой прямо в чат — <b>сумма + период</b> (напр. «выручка 1.5 млрд сум за ${monthLabel(m + 1)}»). Как зададите — сразу проверю реалистичность и построю план догона.`;

  const ppl = await getPeople();
  let sent = false;
  if (ppl.owner && ppl.owner.chatId) { const r = await sendTg("owner", ppl.owner.chatId, msg); sent = !!(r && r.ok); }
  await rsetJSON(guardKey, { sentAt: Date.now(), monthKey, nextLabel, sent });
  return { ok: true, sent, monthKey, nextLabel };
}

// ── ЧАСТЬ D: ЗАКРЫТИЕ МЕСЯЦА ──
// Фиксируем ИТОГ завершённого месяца в ПОСТОЯННОЕ хранилище periodresults:<org> (не кэш). Источник — ЗАМОРОЖЕННЫЙ
// снимок последнего дня месяца (snap:<lastDay> хранит month-to-date → на последний день это итог месяца + цель того
// периода). Итог — база для проверки реалистичности (avgCheck/конверсия закрытого месяца), когда текущий месяц ещё
// пустой (начало периода). Плюс отчёт «месяц закрыт» владельцу 1-го числа. Идемпотентно по ключу месяца.
function monthKeyOf(y, mIdx) { const m = ((mIdx % 12) + 12) % 12; const yy = y + Math.floor(mIdx / 12); return `${yy}-${String(m + 1).padStart(2, "0")}`; }
function lastDayOf(y, mIdx) { return new Date(Date.UTC(y, mIdx + 1, 0)).toISOString().slice(0, 10); }

export async function getPeriodResults(org = ORG) { return (await rgetJSON(`periodresults:${org}`, [])) || []; }

export async function closeMonth(org = ORG) {
  const now = tkNow();
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1; // ПРЕДЫДУЩИЙ месяц — его закрываем 1-го числа
  const monthKey = monthKeyOf(py, pm);
  const label = monthLabelY(py, pm);
  const results = (await rgetJSON(`periodresults:${org}`, [])) || [];
  if (results.some((r) => r.month === monthKey)) return { ok: true, skipped: "already_closed", monthKey };
  // Берём снимок месяца с МАКСИМАЛЬНОЙ выручкой: month-to-date растёт в течение месяца → пик = итог месяца.
  // Устойчиво к двум рискам: (1) поздний sync мог перезаписать снимок последнего числа данными нового месяца
  // (≈0); (2) снимка ровно за последнее число может не быть (sync не отработал / выходной). Продаж 31-го может
  // не быть вовсе — не важно: MTD кумулятивна, пик держит итог месяца.
  const list = (await rgetJSON("snap:list", [])) || [];
  const monthDates = list.filter((d) => typeof d === "string" && d.slice(0, 7) === monthKey);
  let snap = null;
  for (const d of monthDates) { const sn = await rgetJSON(`snap:${d}`, null); if (sn && (snap == null || (sn.revenue || 0) > (snap.revenue || 0))) snap = sn; }
  if (!snap) snap = await rgetJSON(`snap:${lastDayOf(py, pm)}`, null); // фолбэк, если snap:list пуст
  if (!snap) return { ok: false, reason: "no_snapshot", monthKey };
  const goalUZS = (snap.goalPeriod === label && snap.goalUZS > 0) ? snap.goalUZS : null; // цель принадлежит ИМЕННО этому месяцу
  const earned = snap.revenue || 0, sold = snap.sold || 0, leads = snap.leads || 0;
  const rec = {
    month: monthKey, label, goalUZS, earned, sold, leads,
    avgCheckMedian: snap.avgCheckMedian != null ? snap.avgCheckMedian : (snap.avgCheck || null),
    convPct: snap.conv != null ? snap.conv : null,
    pct: goalUZS ? Math.round(earned / goalUZS * 100) : null,
    onTarget: goalUZS ? earned >= goalUZS : null,
    closedAt: Date.now(),
  };
  results.push(rec);
  await rsetJSON(`periodresults:${org}`, results.slice(-36)); // до 3 лет истории, постоянно
  return { ok: true, closed: true, result: rec };
}

export async function sendMonthClose(org = ORG) {
  // Закрытие ИДЕМПОТЕНТНО. Отчёт «месяц закрыт» отвязан от самого закрытия: месяц мог закрыть раньше утренний
  // бизнес-отчёт (self-heal) — тогда c.skipped, но ОТЧЁТ ещё не отправлялся. Дубль отсекаем по флагу rec.reported,
  // а НЕ по факту закрытия. Иначе ранний self-heal «съедал» бы отчёт 1-го числа.
  const c = await closeMonth(org);
  if (!c.ok && !c.skipped) return c; // нет снимка — закрыть нечем
  const all = await getPeriodResults(org);
  const rec = c.result || all[all.length - 1]; // запись месяца независимо от того, кто закрыл
  if (!rec) return { ok: true, sent: false, reason: "no_result" };
  if (rec.reported) return { ok: true, skipped: "already_reported", monthKey: rec.month };
  const prev = all.length >= 2 ? all[all.length - 2] : null; // предыдущий закрытый месяц для «что сработало/нет»
  let s = `📅 <b>Месяц закрыт · ${rec.label}</b>\n\n`;
  if (rec.goalUZS) s += `Цель: ${num(rec.goalUZS)} сум · закрыто <b>${num(rec.earned)} (${rec.pct}%)</b> — ${rec.onTarget ? "✅ цель взята" : "⚠️ недобор"}\n`;
  else s += `Заработано: <b>${num(rec.earned)} сум</b> (цель на месяц не задавалась)\n`;
  s += `Продаж: ${num(rec.sold)} · лидов: ${num(rec.leads)} · средний чек: ${num(rec.avgCheckMedian)} сум · конверсия: ${rec.convPct != null ? rec.convPct + "%" : "н/д"}\n`;
  if (prev) {
    const up = [], down = [];
    const cmp = (lbl, cur, old, unit = "") => { if (cur == null || old == null) return; if (cur > old) up.push(`${lbl} ↑`); else if (cur < old) down.push(`${lbl} ↓`); };
    cmp("выручка", rec.earned, prev.earned); cmp("продажи", rec.sold, prev.sold); cmp("конверсия", rec.convPct, prev.convPct, "%"); cmp("чек", rec.avgCheckMedian, prev.avgCheckMedian);
    if (up.length) s += `\n✅ Сработало (к ${prev.label}): ${up.join(", ")}`;
    if (down.length) s += `\n⚠️ Просело (к ${prev.label}): ${down.join(", ")}`;
  }
  try { const dq = await rgetJSON("dashboard", null); const wna = dq && dq.dataQuality && dq.dataQuality.wonNoAmount; if (wna && wna.count > 0) s += `\n📎 Часть сделок закрыта без суммы (${wna.count}, ${wna.sharePct}%) — чек и выручка занижены на эту величину.`; } catch (e) {}
  s += `\n\n<i>Итог сохранён в историю — на нём проверка реалистичности считает достижимую цель следующего месяца.</i>`;
  const ppl = await getPeople();
  let sent = false;
  if (ppl.owner && ppl.owner.chatId) { const r = await sendTg("owner", ppl.owner.chatId, s); sent = !!(r && r.ok); }
  // помечаем именно ОТЧЁТ как отправленный (в самой записи periodresults) — чтобы не продублировать
  rec.reported = true;
  await rsetJSON(`periodresults:${org}`, all);
  return { ok: true, closed: true, sent, monthKey: rec.month };
}

const CRON_OK = new Set(["propose", "daily-report", "month-prompt", "month-close"]);
async function isAuthed(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (auth && CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const s = await getSession((req.query && req.query.session) || (req.body && req.body.session));
  return !!(s && s.role === "admin");
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || (req.body && req.body.action) || "";
  const cronOk = (req.query && req.query.cron === "1") && CRON_OK.has(action);
  if (!cronOk && !(await isAuthed(req))) { res.status(403).json({ error: "forbidden" }); return; }
  try {
    if (action === "build") { res.status(200).json(await buildPlan(ORG)); return; }               // предпросмотр плана (диагностика)
    if (action === "propose") { res.status(200).json(await proposePlan(ORG, req.query && req.query.force === "1")); return; } // крон: предложить владельцу
    if (action === "daily-report") { res.status(200).json(await sendDailyReport(ORG)); return; }   // крон: утренний отчёт
    if (action === "month-prompt") { res.status(200).json(await nextMonthPrompt(ORG)); return; }   // крон: конец месяца → спросить цель на следующий
    if (action === "month-close") { res.status(200).json(await sendMonthClose(ORG)); return; }     // крон 1-го: зафиксировать итог месяца + отчёт
    if (action === "period-results") { res.status(200).json({ ok: true, results: await getPeriodResults(ORG) }); return; } // диагностика/предпросмотр истории
    if (action === "report-preview") { res.status(200).json(await buildDailyReport(ORG)); return; } // предпросмотр отчёта без отправки
    if (action === "state") { res.status(200).json({ pending: await rgetJSON(K.pending, null), active: await rgetJSON(K.active, null), history: await rgetJSON(K.history, []), goal: await getGoal() }); return; }
    if (action === "button") { const r = await handlePlanButton((req.body && req.body.act) || (req.query && req.query.act)); res.status(200).json(r); return; }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
