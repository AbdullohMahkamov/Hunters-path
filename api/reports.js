// api/reports.js — ДВА УТРЕННИХ ОТЧЁТА владельцу вместо слоя «система рассказывает о наблюдениях».
//   ОТЧЁТ 1 БИЗНЕС: продажи/выручка/лиды за вчера + цена лида + расход на рекламу + прогресс к цели месяца.
//   ОТЧЁТ 2 КОМАНДА: задачи (поставлено/сделано/просрочено/кто тормозит) + новые задачи из наблюдений +
//                    РЕШЕНИЯ, которые ждут владельца (трата DeepSales, подтверждение плана) — строкой + кнопкой.
// Правило: решения владельца остаются доступными В TELEGRAM (кнопка под отчётом), пока очереди в Mini App нет.
// Под каждым отчётом — кнопка «Разобрать в советнике» (тот же handoff, что у дайджеста: ?advisor=<token>).

import { sendTg, getPeople } from "./tg-bot.js";
import { getGoal } from "./goal.js";
import { getVerifiedFunnel } from "./dev-agent.js";
import { funnelFacts, workingDays, closeMonth, getOwnerDecision } from "./planner.js";
import { resolveCpl } from "./goal-realism.js";
import { loadSalesTasks } from "./task-agent.js"; // авторитетный список задач (план + MOP + мозг + маркетинг)
import { priorityScore, OPEN_STATUSES } from "./meta-brain.js"; // ранжирование предложений мозга для секции решений
import { genToken, saveRawHandoff } from "./digest.js";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const ORG = "hunter";

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

const num = (n) => (n == null ? "н/д" : Number(Math.round(n)).toLocaleString("ru-RU"));
const short = (s, n) => { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; };
const MINIAPP_URL = "https://test.hunterai.uz/tg"; // Mini App владельца (кнопка «Разобрать» открывает его)
const tkDate = (offsetDays = 0) => new Date(Date.now() + 5 * 3600000 - offsetDays * 86400000).toISOString().slice(0, 10);
const today0 = () => tkDate(0);

const RU_MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const curMonthLabel = () => { const n = new Date(Date.now() + 5 * 3600000); return `${RU_MONTHS[n.getUTCMonth()]} ${n.getUTCFullYear()}`; };

// ── Прогресс к цели (детерминированно, БЕЗ LLM — не дёргаем генерацию задач planner) ──
async function goalProgress(org) {
  const goal = await getGoal(org);
  if (!goal || !goal.amountUZS) return { hasGoal: false };
  // СТАРАЯ ЦЕЛЬ на стыке месяцев: если период цели ≠ текущий месяц (напр. 1-го числа цель ещё июльская, а идёт
  // август), НЕ показываем бредовый прогресс (июльская цель против пустого августа). Честно: «цель не задана».
  if (goal.period && goal.period.label && goal.period.label !== curMonthLabel()) return { hasGoal: false, stale: true, staleLabel: goal.period.label };
  const funnel = await getVerifiedFunnel(org).catch(() => null);
  const f = funnelFacts(funnel);
  const wdays = goal.period ? await workingDays(goal.period) : null;
  const earned = (f && f.revenue) || 0;
  const perWorkday = wdays && wdays.passed ? earned / wdays.passed : null;
  const forecast = perWorkday != null ? Math.round(perWorkday * wdays.total) : null;
  const gap = forecast != null ? goal.amountUZS - forecast : null;
  const remaining = Math.max(0, goal.amountUZS - earned);
  const pct = goal.amountUZS > 0 ? Math.round(earned / goal.amountUZS * 100) : 0;
  const onPace = gap != null ? gap <= 0 : null;
  return { hasGoal: true, goal, earned, forecast, gap, remaining, pct, onPace, workdaysLeft: wdays ? wdays.left : null, avgCheck: f && f.avgCheck };
}

// ── ОТЧЁТ 1: БИЗНЕС ──
export async function buildBusinessReport(org = ORG) {
  const yKey = tkDate(1); // вчера по Ташкенту
  const yd = await rgetJSON(`bizday:${yKey}`, null);
  const dash = await rgetJSON("dashboard", null);
  const { cpl, cplSource } = await resolveCpl(dash);
  const snap = await rgetJSON("marketingagent:snapshot", null);
  const spendUZS = snap && snap.currency && snap.currency.aligned ? snap.currency.spendUZS : null;
  const gp = await goalProgress(org);

  let s = `📊 <b>Бизнес · вчера (${yKey})</b>\n\n`;
  if (yd) s += `Продаж: <b>${num(yd.sold)}</b> · выручка: <b>${num(yd.revenue)} сум</b> · лидов: <b>${num(yd.leads)}</b>\n`;
  else s += `Данных за вчера пока нет (первый день сбора или пропуск синхронизации).\n`;
  s += `Цена лида: ${cpl != null ? `${num(cpl)} сум` : "н/д"}${cplSource ? ` (${cplSource})` : ""} · расход на рекламу: ${spendUZS != null ? `${num(spendUZS)} сум за месяц` : "н/д"}\n`;
  if (gp.hasGoal) {
    const paceStr = gp.onPace === true ? "✅ успеваем" : gp.onPace === false ? `⚠️ отстаём (прогноз ${num(gp.forecast)}, разрыв ${num(gp.gap)} сум)` : "темп не диагностируется";
    s += `\nЦель ${gp.goal.period ? gp.goal.period.label : ""}: закрыто <b>${num(gp.earned)} из ${num(gp.goal.amountUZS)}</b> (${gp.pct}%) · осталось ${num(gp.remaining)} сум · ${paceStr}`;
  } else if (gp.stale) {
    s += `\n⚠️ Цель на <b>${curMonthLabel()}</b> ещё не задана (предыдущая «${gp.staleLabel}» закрыта). Задайте цель на месяц фразой в чат — до этого прогресс не считаю.`;
  } else {
    s += `\n⚠️ Цель на период не задана — прогресс не считается. Задайте цель фразой в чат (сумма + период).`;
  }

  const seed = `Разбери сегодняшний бизнес-отчёт и скажи, на что смотреть в первую очередь. Вчера: продаж ${yd ? yd.sold : "н/д"}, выручка ${yd ? yd.revenue : "н/д"}, лидов ${yd ? yd.leads : "н/д"}. Цена лида ${cpl != null ? cpl : "н/д"}, расход на рекламу ${spendUZS != null ? spendUZS : "н/д"}. ${gp.hasGoal ? `Цель ${gp.goal.amountUZS}: закрыто ${gp.earned} (${gp.pct}%), прогноз ${gp.forecast}, ${gp.onPace ? "успеваем" : "отстаём"}.` : "Цель не задана."} Что важнее всего сейчас?`;
  return { text: s, seed, title: `Бизнес ${yKey}` };
}

// ── ЕДИНЫЙ ИСТОЧНИК «ЧТО ЖДЁТ РЕШЕНИЯ ВЛАДЕЛЬЦА» ──
// Один список — и для отчёта по команде (Telegram: line + callback-кнопки), и для очереди решений в Mini App
// (структура + типы advisor-act). Так каналы не разъезжаются. Типы: план, meta-brain, DeepSales, ownerDecision, цель.
export async function getDecisions(org = ORG) {
  const items = [];
  // 1) DeepSales — трата на разбор звонков (без подтверждения звонки не разбираются)
  const ds = await rgetJSON(`transcriptplan:pending:${org}`, null);
  if (ds && !ds.declined && !ds.spend) {
    const usd = Math.round((ds.totals ? ds.totals.plannedMinutes : 0) * 0.056);
    items.push({ kind: "deepsales", title: `Разбор звонков (~$${usd})`, detail: "Трата на разбор звонков — без неё звонки не разбираются.",
      line: `⏳ Трата на разбор звонков (~$${usd}) — <b>без неё звонки не разбираются</b>.`,
      tgButtons: [[{ text: `🎧 Разобрать звонки (~$${usd})`, callback_data: "tplan:run" }]],
      actions: [{ type: "ds_run", label: `🎧 Разобрать (~$${usd})` }] });
  }
  // 2) План под цель ждёт подтверждения
  const pend = await rgetJSON(`planner:pending:${org}`, null);
  if (pend && pend.plan) {
    const g = pend.plan.facts || {};
    items.push({ kind: "plan", title: `План под цель «${pend.periodKey || ""}»`, detail: `Разрыв ${num(g.gap)} сум${g.gapPct != null ? ` (${g.gapPct}%)` : ""}. Осталось раб. дней: ${g.workdays ? g.workdays.left : "—"}.`,
      line: `⏳ План под цель «${pend.periodKey || ""}» ждёт подтверждения${g.gap != null ? ` (разрыв ${num(g.gap)} сум)` : ""}.`,
      tgButtons: [[{ text: "✅ Подтвердить план", callback_data: "pl:confirm" }, { text: "❌ Отклонить", callback_data: "pl:reject" }]],
      actions: [{ type: "plan_confirm", label: "✅ Подтвердить и раздать" }, { type: "plan_recalc", label: "🔄 Пересчитать" }, { type: "plan_reject", label: "❌ Отклонить", warn: true }] });
  }
  // 3) ownerDecision — недостижимая часть цели (решение владельца, не задача людям)
  const odRec = await getOwnerDecision(org).catch(() => null);
  if (odRec) {
    const od = odRec.od, feas = od.feasibleGoalUZS, unreach = od.unreachableUZS, k = od.addManagers;
    items.push({ kind: "ownerdecision", title: `${odRec.scope === "full" ? "Цель целиком" : "Часть цели"} вне возможностей команды`, detail: `${num(unreach)} сум не закрыть текущими силами${k ? `, +${k} менеджер(ов)` : ""}. Команда/бюджет или снизить цель до ${num(feas)} сум.`,
      line: `⚠️ ${odRec.scope === "full" ? "Цель целиком" : "Часть цели"} вне возможностей команды: ${num(unreach)} сум не закрыть текущими силами${k ? `, нужно +${k} менеджер(ов)` : ""}. Это ваше решение — команда/бюджет или снизить цель до ${num(feas)} сум.`,
      tgButtons: [[{ text: `📉 Снизить цель до ${num(feas)}`, callback_data: "od:lower" }, { text: "Оставить", callback_data: "od:dismiss" }]],
      actions: [{ type: "od_lower", label: `📉 Снизить до ${num(feas)}` }, { type: "od_dismiss", label: "Оставить" }] });
  }
  // 4) Предложения общего мозга — топ-3 по важности
  const props = ((await rgetJSON("metabrain:proposals", [])) || []).filter((p) => p && OPEN_STATUSES.includes(p.status));
  if (props.length) {
    const nowMs = Date.now();
    props.sort((a, b) => priorityScore(b, nowMs) - priorityScore(a, nowMs));
    for (const p of props.slice(0, 3)) {
      items.push({ kind: "meta", id: p.id, title: String(p.title || "Предложение системы").slice(0, 70), detail: p.why || p.summary || (p.proposedTask && p.proposedTask.title) || "",
        line: `🧠 ${String(p.title || "Предложение системы").slice(0, 70)}`,
        tgButtons: [[{ text: `✅ ${short(p.title, 16)}`, callback_data: `mb:confirm:${p.id}` }, { text: "❌", callback_data: `mb:reject:${p.id}` }]],
        actions: [{ type: "mb_confirm", id: p.id, label: "✅ Принять" }, { type: "mb_reject", id: p.id, label: "❌ Отклонить", warn: true }] });
    }
    if (props.length > 3) items.push({ kind: "meta_more", title: `…и ещё ${props.length - 3}`, detail: "Разобрать в советнике.", line: `…и ещё ${props.length - 3} — разобрать в советнике.`, tgButtons: [], actions: [] });
  }
  // 5) ЗАПРОС ЦЕЛИ (self-heal): нет цели на текущий месяц или она устарела. В отчёте это ведёт бизнес-отчёт →
  //    line/tgButtons пустые (только для Mini App-очереди, где кнопка ведёт в чат).
  const goal = await getGoal(org);
  const stale = goal && goal.period && goal.period.label && goal.period.label !== curMonthLabel();
  if (!goal || !goal.amountUZS || stale) {
    items.push({ kind: "goal", title: `Задать цель на ${curMonthLabel()}`, detail: stale ? `Предыдущая «${goal.period.label}» закрыта. Напишите новую цель в чате советника.` : "Цель на месяц не задана. Напишите её в чате советника.",
      line: "", tgButtons: [], actions: [{ type: "__goto_chat", label: "📝 Задать цель в чате" }] });
  }
  return items;
}

// ── ОТЧЁТ 2: КОМАНДА ──
const OBS_SOURCES = new Set(["mop-agent", "metabrain"]); // задачи, рождённые слоем наблюдений

export async function buildTeamReport(org = ORG) {
  const today = today0();
  // Тот же авторитетный список, что ведёт Task Agent: план + находки MOP + подтверждённый мозг + маркетинг.
  const tasks = await loadSalesTasks().catch(() => []);
  // Кто на каких аккаунтах + ОСОЗНАННОЕ совмещение ролей (taskagent:rolecombine, напр. {marketing:"owner"}).
  const ppl = await getPeople().catch(() => ({}));
  const combine = (await rgetJSON("taskagent:rolecombine", {})) || {};
  const roleOf = (t) => (t.recipient === "marketing" || t.source === "marketing") ? "marketing" : "rop";
  // Ярлык получателя. Если роль осознанно совмещена с владельцем — помечаем «(вы)», чтобы ваши же просрочки
  // не читались как проблема дисциплины подчинённых.
  const whoOf = (t) => { const r = roleOf(t); const lbl = r === "marketing" ? "Маркетолог" : "РОП"; return combine[r] === "owner" ? `${lbl} (вы)` : lbl; };

  const assigned = tasks.length;
  const doneN = tasks.filter((t) => t.done).length;
  const overdue = tasks.filter((t) => !t.done && (t.hoursOverdue || 0) > 0);
  const obsInWork = tasks.filter((t) => OBS_SOURCES.has(t.source)).length; // результат работы наблюдений — задачи в работе

  let s = `👥 <b>Команда · ${today}</b>\n\n`;
  s += `Задачи: поставлено <b>${assigned}</b> · сделано <b>${doneN}</b> · просрочено <b>${overdue.length}</b>\n`;
  if (overdue.length) {
    const top = overdue.slice(0, 5).map((t) => `• «${String(t.title).slice(0, 60)}» — ${whoOf(t)}${t.deadline ? ` (срок ${t.deadline})` : ""}`).join("\n");
    s += `Тормозит:\n${top}\n`;
  } else if (assigned) {
    s += `Просрочек нет.\n`;
  }
  if (obsInWork > 0) s += `Задач из наблюдений системы (МОПы/мозг) в работе: <b>${obsInWork}</b>\n`;

  // ЗДОРОВЬЕ ДОСТАВКИ: не молчим о собственной неисправности. Если задачи есть, а получатель НЕ привязан к
  // боту (нет chatId) — они физически не уходят. Говорим об этом ГРОМКО, а не создаём задачи в пустоту.
  const openRop = tasks.some((t) => !t.done && roleOf(t) === "rop");
  const openMkt = tasks.some((t) => !t.done && roleOf(t) === "marketing");
  const warn = [];
  if (openRop && !(ppl.rop && ppl.rop.chatId)) warn.push("РОП не привязан к боту — задачи отдела продаж НЕ доставляются");
  if (openMkt && !(ppl.marketing && ppl.marketing.chatId)) warn.push("маркетолог не привязан к боту — маркетинг-задачи НЕ доставляются");
  // КОЛЛИЗИЯ АККАУНТОВ: две роли на одном chatId ДОПУСТИМЫ только если совмещение помечено осознанно
  // (rolecombine). Непомеченное совпадение — подозрительно (случайность, которую иначе никто не заметит).
  const byChat = {};
  for (const r of ["owner", "rop", "marketing"]) { const c = ppl[r] && ppl[r].chatId; if (c != null) (byChat[c] = byChat[c] || []).push(r); }
  for (const roles of Object.values(byChat)) {
    if (roles.length < 2) continue;
    const sanctioned = roles.some((base) => roles.every((r) => r === base || combine[r] === base));
    if (!sanctioned) warn.push(`роли «${roles.join(" + ")}» на одном аккаунте, но совмещение НЕ помечено — проверьте, не случайность ли (иначе пометьте как осознанное)`);
  }
  if (warn.length) s += `\n⚠️ <b>Проверьте доставку:</b> ${warn.join("; ")}.\n`;

  // ── РЕШЕНИЯ, которые ждут владельца — ЕДИНЫЙ источник getDecisions (тот же, что у Mini App-очереди) ──
  const items = await getDecisions(org);
  const decisions = [], kbRows = [];
  for (const it of items) { if (it.line) decisions.push(it.line); for (const row of (it.tgButtons || [])) kbRows.push(row); }
  if (decisions.length) s += `\n<b>Ждёт вашего решения:</b>\n${decisions.join("\n")}\n`;

  const seed = `Разбери отчёт по команде и подскажи, что делать в первую очередь и кому поставить задачу. Задач ${assigned}, сделано ${doneN}, просрочено ${overdue.length}${overdue.length ? ` (${overdue.slice(0, 3).map((t) => t.title).join("; ")})` : ""}. Из наблюдений в работе: ${obsInWork}.${decisions.length ? ` Ждут решения: ${decisions.join(" ")}` : ""}`;
  return { text: s, seed, title: `Команда ${today}`, decisionButtons: kbRows };
}

async function sendReport(org, kind) {
  // САМО-ПОДСТРАХОВКА: закрываем предыдущий месяц, если крон закрытия не отработал (идемпотентно — после первого
  // раза no-op). Так periodresults (база проверки реалистичности) гарантированно заполнен уже к первому утреннему
  // отчёту месяца, даже если отдельный крон month-close 1-го числа не сработал.
  if (kind === "business") { try { await closeMonth(org); } catch (e) { /* закрытие не должно ронять отчёт */ } }
  const built = kind === "business" ? await buildBusinessReport(org) : await buildTeamReport(org);
  const ppl = await getPeople();
  if (!(ppl.owner && ppl.owner.chatId)) return { ok: true, sent: false, reason: "owner не привязан" };
  const token = genToken();
  await saveRawHandoff(token, built.seed, built.title);
  // клавиатура: строки-решения (callback, работают прямо в Telegram) + кнопка, ОТКРЫВАЮЩАЯ Mini App с контекстом
  // отчёта (web_app → /tg?advisor=token; токен hf+base36 уже в алфавите [A-Za-z0-9_-]).
  const rows = [...(built.decisionButtons || []), [{ text: "🧠 Разобрать в советнике", web_app: { url: `${MINIAPP_URL}?advisor=${token}` } }]];
  const r = await sendTg("owner", ppl.owner.chatId, built.text, { reply_markup: { inline_keyboard: rows } });
  return { ok: !!(r && r.ok), sent: !!(r && r.ok), kind };
}

const CRON_OK = new Set(["business", "team"]);
async function isAuthed(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (auth && CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const s = await getSession((req.query && req.query.session) || (req.body && req.body.session));
  return !!(s && s.role === "admin");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const action = (req.query && req.query.action) || (req.body && req.body.action) || "";
  const cronOk = (req.query && req.query.cron === "1") && CRON_OK.has(action);
  if (!cronOk && !(await isAuthed(req))) { res.status(403).json({ error: "forbidden" }); return; }
  try {
    if (action === "business") { res.status(200).json(await sendReport(ORG, "business")); return; }
    if (action === "team") { res.status(200).json(await sendReport(ORG, "team")); return; }
    if (action === "business-preview") { res.status(200).json(await buildBusinessReport(ORG)); return; }
    if (action === "team-preview") { res.status(200).json(await buildTeamReport(ORG)); return; }
    if (action === "decisions") { // очередь решений для Mini App — только структура (без Telegram-строк/кнопок)
      const items = (await getDecisions(ORG)).map(({ kind, id, title, detail, actions }) => ({ kind, id, title, detail, actions }));
      res.status(200).json({ ok: true, items }); return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
