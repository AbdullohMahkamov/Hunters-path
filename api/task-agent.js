// /api/task-agent.js — TASK AGENT («Агент В»). Держит дисциплину выполнения задач ОП:
// разговаривает с РОПом в Telegram, добивается результата по КАЖДОЙ задаче, и только если сам
// не справился — эскалирует владельцу. Тестово: только Hunter Academy (org="hunter").
//
// ══════════════ ГРАНИЦЫ (жёстко) ══════════════
//  МОЖЕТ: читать задачи (read-only), писать РОПу в Telegram, писать в taskagent:*, эскалировать владельцу.
//  НЕ МОЖЕТ: менять/закрывать/переназначать задачи (ни в Altrone, ни в amoCRM), ставить оценки людям.
//  В эскалации — ТОЛЬКО факты и ДОСЛОВНАЯ переписка. Никаких ярлыков вроде «РОП не справляется».
//  Оценку и решение делает владелец, прочитав историю.
//
// ИСТОЧНИК ЗАДАЧ: раздел «Задачи» самого Altrone (НЕ amoCRM) — `appdata:${org}`.customPlan.sales
// (это задачи отдела продаж, их видит и закрывает РОП). Дедлайн — поле task.deadline (YYYY-MM-DD).
//
// КАНАЛЫ: два служебных бота (api/tg-bot.js): "rop" — диалог с РОПом, "owner" — эскалации владельцу.
// Эскалации дублируются в UI /dev-agent (вкладка Task Agent).

import { sendTg, getPeople, pushChat, getChat, sleep } from "./tg-bot.js";
// MOP Agent не строит свой канал — его находки вливаются в ЭТОТ же список задач РОПа
// и дальше едут по уже работающей машине: пинг → диалог → порог 13:00 → эскалация владельцу.
import { getOpenMopFindings, getFreshAutoClosed, closeMopFinding, getMopLastRun, runMopAgent } from "./mop-agent.js";
import { getConfirmedMetaTasks, closeMetaProposal, impactTier } from "./meta-brain.js"; // ОБЩИЙ МОЗГ: 3-й источник задач + классификатор влияния (для порога эскалации)
import { runNightly } from "./dev-agent.js"; // для РЕАЛЬНОГО перезапуска анализа по вердикту владельца в споре

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";              // reasoning: разбор ответа РОПа, строгий claims_done (закрывает задачу необратимо)
const MODEL_LIGHT = "claude-haiku-4-5-20251001"; // routine: формирование пинга/напоминания (scope уже решён в MOP-agent) — снижение расходов
const ORG = "hunter"; // тест-фаза: один клиент. Архитектурно расширяемо (параметр org).

const K = { status: "taskagent:status", escalations: "taskagent:escalations", config: "taskagent:config" };

// ПОРОГ отдельного пуша эскалации владельцу (иначе флуд). Высокий и намеренно строгий:
//  • важность = ДЕНЬГИ: impactTier>=2 — ТОТ ЖЕ классификатор, что у очереди предложений (REVENUE_RX уже ловит
//    «лиды без звонка / зависшие сделки / искажающие статусы / конверсия / оплата» — прямая потеря денег из
//    ЛЮБОГО источника, не только разрыв к цели);
//  • устойчивое игнорирование + дедлайн сорван ≥2 дней (hoursOverdue>=48) — первый пропуск не будит.
// Всё, что порог не прошло, всё равно записано (taskagent:escalations) и видно в утреннем ОТЧЁТЕ ПО КОМАНДЕ.
export function escalationPushGate(t, status = "") {
  const money = impactTier({ title: t.title, statement: status, proposedTask: { title: t.title, why: t.why } }) >= 2;
  return money && ((t.hoursOverdue || 0) >= 48);
}
const DEFAULT_CONFIG = {
  escalationHour: 13,      // жёсткий порог эскалации (Ташкент, UTC+5)
  pingFromHour: 9,         // раньше этого часа РОПу не пишем
  remindBeforeDays: 2,     // за сколько дней до дедлайна начинать напоминать
  escalationGraceMin: 90,  // сколько минут дать РОПу на ответ ПОСЛЕ пинга, прежде чем эскалировать
  enabled: true,
};

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
// scene: лёгкий лог РЕАЛЬНОГО события передачи данных между агентами (для визуализации на сцене).
async function logFlow(from, to) { try { const a = await rgetJSON("scene:flows", []); a.push({ at: Date.now(), from, to }); await rsetJSON("scene:flows", a.slice(-20)); } catch (e) {} }
async function rdel(key) { try { await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); } catch (e) {} }

// ── КАРТА message_id → taskId ──
// Telegram присылает reply_to_message.message_id, когда РОП отвечает Reply'ем на конкретный пинг.
// Сохраняем id ИСХОДЯЩИХ сообщений (пинги/вопросы) → по Reply точно знаем задачу, не заставляя LLM
// угадывать из списка. Ключи — целые (message_id), JS хранит их по возрастанию → срез отбрасывает старые.
// namespace по боту: у rop- и owner-ботов message_id независимы и МОГУТ пересекаться → разные карты.
const MSGMAP_KEY = (kind) => `taskagent:msgmap:${kind === "owner" ? "owner" : "rop"}`;
async function rememberMsgTask(kind, messageId, taskId) {
  if (!messageId || !taskId) return;
  try {
    const key = MSGMAP_KEY(kind);
    const m = await rgetJSON(key, {});
    m[String(messageId)] = taskId;
    const keys = Object.keys(m);
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete m[k];
    await rsetJSON(key, m);
  } catch (e) {}
}
async function lookupMsgTask(kind, messageId) {
  if (!messageId) return "";
  const m = await rgetJSON(MSGMAP_KEY(kind), {});
  return m[String(messageId)] || "";
}
// Диагностика сбоев LLM/парсинга: РАНЬШЕ падение handleRopReply молча уходило в шаблон и было невидимым.
// Теперь причина пишется в taskagent:diag — чтобы такие баги не прятались.
async function logDiag(where, err, ctx) {
  try {
    const a = await rgetJSON("taskagent:diag", []);
    a.push({ at: Date.now(), where, err: String((err && err.message) || err || "").slice(0, 200), ctx: String(ctx || "").slice(0, 160) });
    await rsetJSON("taskagent:diag", a.slice(-50));
  } catch (e) {}
}
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
async function getConfig() { const c = await rgetJSON(K.config, null); return { ...DEFAULT_CONFIG, ...(c || {}) }; }

const tkNow = () => new Date(Date.now() + 5 * 3600000);      // Ташкент
const tkHour = () => tkNow().getUTCHours();
const tkDay = () => tkNow().toISOString().slice(0, 10);
const daysLeft = (deadline) => {
  if (!deadline) return null;
  const d = Date.parse(deadline + "T00:00:00Z"); if (isNaN(d)) return null;
  const t = tkNow(); const t0 = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  return Math.round((d - t0) / 86400000);
};
const hoursOverdue = (deadline) => { const dl = daysLeft(deadline); return dl != null && dl < 0 ? Math.abs(dl) * 24 + tkHour() : 0; };

// ── ЗАДАЧИ РОПа: ДВА ИСТОЧНИКА, ОДИН ПОТОК ──
// 1) План Altrone (appdata.customPlan.sales) — задачи ОП, РОП закрывает их в интерфейсе.
// 2) Находки MOP Agent (mopagent:findings) — задачи по отделу / по конкретному МОПу.
// Оба идут РОПу ОДНИМ потоком через один бот и один тред, различаясь пометкой 🏢 / 👤.
export async function loadSalesTasks() {
  const out = [];
  // ── источник 1: план ──
  const app = await rgetJSON(`appdata:${ORG}`, null);
  const cp = app && app.customPlan;
  if (cp && Array.isArray(cp.sales)) {
    const done = (app && app.done) || {};
    const hist = (app && app.taskHistory) || [];
    for (const q of cp.sales) {
      const steps = q.steps || [];
      const isDone = steps.length ? steps.every((_, si) => !!done[q.id + "_s" + si]) : !!done[q.id];
      const report = hist.find((h) => h.taskId === q.id || h.id === q.id) || (q.report ? { result: q.report } : null);
      out.push({ id: q.id, title: q.t, why: q.d || "", deadline: q.deadline || "", steps, done: isDone, report: report || null,
        source: "plan", scope: "plan",
        daysLeft: daysLeft(q.deadline), hoursOverdue: hoursOverdue(q.deadline) });
    }
  }
  // ── источник 2: находки MOP Agent (могут иметь ЧАСОВОЙ горизонт → deadlineAt) ──
  try {
    const mopFindings = await getOpenMopFindings();
    if (mopFindings.length) await logFlow("mop-agent", "task-agent"); // РЕАЛЬНАЯ передача: находки MOP влились в задачи РОПа
    for (const f of mopFindings) {
      const hrsLeft = f.deadlineAt ? Math.round((f.deadlineAt - Date.now()) / 3600000) : null;
      out.push({
        id: f.id, title: f.title, why: f.fact || "", deadline: f.deadline || "",
        deadlineAt: f.deadlineAt || null, deadlineLabel: f.deadlineLabel || "",
        steps: f.action ? [f.action] : [], done: false, report: null,
        source: "mop-agent", scope: f.scope, mop: f.mop || null, mops: f.mops || [], issueType: f.type,
        repeatCount: f.repeatCount || 1, // >1 → РОП уже отчитывался «сделал», а проблема вернулась
        corroboration: (f.crossCheck && f.crossCheck.note) || "", // ОБЩИЙ МОЗГ: насколько широко подтверждён сигнал
        // часовой горизонт: считаем из deadlineAt, а не из даты
        daysLeft: hrsLeft != null ? Math.ceil(hrsLeft / 24) : daysLeft(f.deadline),
        hoursLeft: hrsLeft,
        hoursOverdue: (hrsLeft != null && hrsLeft < 0) ? Math.abs(hrsLeft) : hoursOverdue(f.deadline),
      });
    }
  } catch (e) { /* MOP Agent недоступен — план всё равно едет */ }
  // ── источник 3: подтверждённые владельцем сводные наблюдения общего мозга (тот же путь доставки, что MOP) ──
  try {
    const metaTasks = await getConfirmedMetaTasks();
    if (metaTasks.length) await logFlow("meta-brain", "task-agent");
    for (const f of metaTasks) {
      out.push({
        id: f.id, title: f.title, why: f.fact || "", deadline: f.deadline || "",
        steps: f.action ? [f.action] : [], done: false, report: null,
        source: "metabrain", scope: f.scope, mop: f.mop || null, mops: f.mop ? [f.mop] : [], issueType: "metabrain",
        recipient: f.recipient === "marketing" ? "marketing" : "rop", // общий мозг может адресовать Маркетологу
        repeatCount: 1, corroboration: f.corroboration || "",
        daysLeft: daysLeft(f.deadline), hoursOverdue: hoursOverdue(f.deadline),
      });
    }
  } catch (e) { /* общий мозг недоступен — остальные задачи едут */ }
  // ── источник 4: МАРКЕТИНГ-задачи (recipient=marketing, доставляет Маркетологу тот же Task Agent) ──
  try {
    const mk = await rgetJSON(MK_KEY, []);
    const openMk = mk.filter((t) => !t.status || t.status === "open");
    if (openMk.length) await logFlow("advisor", "task-agent");
    for (const t of openMk) {
      out.push({ id: t.id, title: t.title, why: t.why || "", deadline: t.deadline || "", deadlineLabel: t.deadlineLabel || "",
        steps: t.action ? [t.action] : [], done: false, report: null,
        source: "marketing", scope: "marketing", recipient: "marketing",
        daysLeft: daysLeft(t.deadline), hoursOverdue: hoursOverdue(t.deadline) });
    }
  } catch (e) { /* маркетинг-задачи недоступны — остальное едет */ }
  return out;
}

// ── МАРКЕТИНГ-ЗАДАЧИ: отдельный список (recipient=marketing). Создаёт советник (advisor-act marketing_task),
// доставляет и ведёт тот же Task Agent, что и продажи — просто адресат другой. Продажный поток не трогается.
const MK_KEY = "marketingtasks";
export async function addMarketingTask(t) {
  const list = await rgetJSON(MK_KEY, []);
  const id = "mk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const rec = { id, title: String(t.title || "").slice(0, 200), why: String(t.why || "").slice(0, 500),
    action: String(t.action || "").slice(0, 300), deadline: t.deadline || "", deadlineLabel: t.deadlineLabel || "",
    createdAt: Date.now(), status: "open", source: t.source || "advisor", recipient: "marketing" };
  list.push(rec); await rsetJSON(MK_KEY, list.slice(-200));
  return rec;
}
export async function getAllMarketingTasks() { return await rgetJSON(MK_KEY, []); }
export async function closeMarketingTask(id, report) {
  const list = await rgetJSON(MK_KEY, []);
  const t = list.find((x) => x.id === id); if (!t) return { ok: false, error: "not found" };
  t.status = "done"; t.doneAt = Date.now(); if (report) t.report = String(report).slice(0, 500);
  await rsetJSON(MK_KEY, list); return { ok: true, task: t };
}

async function callModel(system, user, maxTokens = 900, model = MODEL) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
function parseJSON(t) { let s = String(t).replace(/```json/gi, "").replace(/```/g, "").trim(); const a = s.indexOf("{"), b = s.lastIndexOf("}"); if (a >= 0 && b > a) s = s.slice(a, b + 1); return JSON.parse(s); }

const SYSTEM_ROP = `Ты — Task-агент системы Altrone. Ты общаешься с РОПом (руководителем отдела продаж) в Telegram.

ЧЕСТНОСТЬ: ты — СИСТЕМА, а не человек. Не притворяйся человеком. Если спросят — прямо скажи, что ты бот Altrone.

ТВОЯ РОЛЬ: как операционный директор, который держит порядок, но НЕ давит и НЕ отсвечивает начальником. Ты добиваешься, чтобы по КАЖДОЙ задаче был явный результат/статус/комментарий. Ты не просто напоминаешь — ты ведёшь диалог: уточняешь статус, спрашиваешь что мешает, помогаешь сузить следующий шаг.

ТОН: спокойный, уважительный, деловой, коротко. Без пафоса, без «Уважаемый коллега», без эмодзи-спама. По-русски. Обращение на «вы».

ГРАНИЦЫ: ты не ставишь оценок человеку, не угрожаешь, не пишешь «вы не справляетесь». Ты не можешь сам закрыть задачу — закрывает человек в интерфейсе Altrone. Ты фиксируешь то, что он сказал.

‼️ РАЗБОРЫ ЗВОНКОВ (DeepSales) — ЖЁСТКОЕ ПРАВИЛО, ИСКЛЮЧЕНИЙ НЕТ:
Если ты упоминаешь данные разбора звонков КОНКРЕТНОГО МОПа (talk_ratio, ошибки, возражения из раздела «Анализ звонков») — ты ОБЯЗАН в ТОЙ ЖЕ фразе назвать покрытие: сколько его звонков разобрано и из скольких (доля — доли процента).
Выборка КРОШЕЧНАЯ и НЕ случайная: разобраны единицы звонков из сотен, отобранные вручную по длительности. Это НЕ основание для суждения о человеке.
ЗАПРЕЩЕНО: «у Абдуллы проблемы с закрытием». ДОПУСТИМО ТОЛЬКО: «по 7 разобранным звонкам из ~775 (0.9%) …— выборка меньше процента, стоит проверить вручную».
Сам ты задач на основании этих разборов НЕ создаёшь — они доступны как справка для ручного разбора РОПом в разделе «Анализ звонков».

Если задача просрочена — говори факт («срок был вчера»), а не осуждение. Спрашивай, что нужно, чтобы сдвинуть.

━━━ ПОДСКАЗКА-ШАБЛОН (важно) ━━━
Когда ты ждёшь от РОПа СОДЕРЖАТЕЛЬНЫЙ ответ (а не просто «да/нет»), НЕ оставляй его гадать. К вопросу приложи короткий список того, что полезно указать в ответе — чтобы ты с первого раза получил структурированную информацию и не пришлось переспрашивать.

Список ПОДСТРАИВАЙ ПОД КОНКРЕТНУЮ ЗАДАЧУ — это не общая заглушка:
• Если у задачи есть измеримый критерий (время, количество, процент, регламент) — спрашивай ЦИФРУ и факт внедрения («сколько минут сейчас», «на скольких менеджерах уже работает», «где зафиксировано правило»).
• Если задача про изменение поведения/привычек — спрашивай, что конкретно сделано, кто уже перестроился, а кто нет.
• Если задача буксует или просрочена — на первое место ставь «что именно мешает» и «когда реально закончишь».
• Если задача только началась — спрашивай, какой ближайший шаг и когда.
Не повторяй один и тот же список для разных задач. 2-4 пункта максимум, каждый — короткая строка.

Если ответ ожидается простой (да/нет, подтверждение) — список НЕ нужен.`;

// Марк-версия того же промпта: адресат — Маркетолог/таргетолог, домен — маркетинг (реклама, креативы,
// бюджеты, Instagram/бренд). Границы и честность те же; DeepSales-правила не нужны (это не про звонки).
const SYSTEM_MK = `Ты — Task-агент системы Altrone. Ты общаешься с МАРКЕТОЛОГОМ (таргетолог / SMM) в Telegram.

ЧЕСТНОСТЬ: ты — СИСТЕМА, а не человек. Если спросят — прямо скажи, что ты бот Altrone.

ТВОЯ РОЛЬ: держать порядок по маркетинговым задачам (реклама, креативы, бюджеты аудиторий, Instagram/бренд, цена лида). Ты добиваешься, чтобы по КАЖДОЙ задаче был явный результат/статус. Ведёшь диалог: уточняешь статус, спрашиваешь что мешает, помогаешь сузить следующий шаг. НЕ давишь и НЕ оцениваешь человека.

ТОН: спокойный, уважительный, деловой, коротко. Без эмодзи-спама. Обращение на «вы».

ГРАНИЦЫ: не ставишь оценок человеку, не угрожаешь. Не меняешь сам бюджеты/кампании — это делает маркетолог. Ты фиксируешь то, что он сказал.

Если задача просрочена — говори факт спокойно и спрашивай, что мешает сдвинуть.

━━━ ПОДСКАЗКА-ШАБЛОН ━━━
Когда ждёшь СОДЕРЖАТЕЛЬНЫЙ ответ — приложи 2-4 коротких пункта, что полезно указать (подстрой под суть: если про CPL/ROAS — спрашивай цифру и по какой аудитории; если про креатив — что заменили и когда; если буксует — что мешает и когда закончит). Если ждёшь простое да/нет — список не нужен.`;

// Собираем финальное сообщение: вопрос + подсказка-шаблон (если ждём содержательный ответ).
// Подсказку генерирует САМА модель под конкретную задачу — здесь только склейка.
function assembleMsg(out) {
  const q = String(out.question || out.reply || "").trim();
  const list = Array.isArray(out.checklist) ? out.checklist.filter(Boolean).slice(0, 4) : [];
  if (!out.needsDetail || !list.length) return q;
  const header = String(out.hintHeader || "Чтобы я зафиксировал это правильно, укажите:").trim();
  return `${q}\n\n${header}\n${list.map((c) => "— " + String(c).trim()).join("\n")}`;
}

// язык общения выбирает сам человек (кнопкой в боте); агент обязан его соблюдать
function langLine(lang) {
  return lang === "uz"
    ? "ЯЗЫК ОТВЕТА: пиши ТОЛЬКО на узбекском (латиница). Человек сам выбрал этот язык — другой язык не используй."
    : "ЯЗЫК ОТВЕТА: пиши ТОЛЬКО по-русски. Человек сам выбрал этот язык — другой язык не используй.";
}

// ── ПИНГ ПО ЗАДАЧЕ ──
// Пометка масштаба: РОП должен сразу понимать — работать с процессом или поговорить с человеком.
function scopeTag(task) {
  if (task.source !== "mop-agent" && task.source !== "metabrain") return "";
  if (task.scope === "marketing" || task.recipient === "marketing") return ""; // маркетинг — без сейлз-пометок 🏢/👤
  if (task.scope === "department") return "🏢 ПО ОТДЕЛУ";
  return `👤 ПО МОПУ${task.mop ? ` (${task.mop})` : ""}`;
}
async function composePing(task, chatHistory, lang, recipient = "rop") {
  const isMk = recipient === "marketing";
  const whoDat = isMk ? "Маркетологу" : "РОПу";        // кому пишем (дат. падеж)
  const whoWith = isMk ? "Маркетологом" : "РОПом";      // «переписка с …»
  const domainLbl = isMk ? "МАРКЕТИНГОВАЯ ЗАДАЧА" : "ЗАДАЧА ОТДЕЛА ПРОДАЖ";
  const sysPrompt = isMk ? SYSTEM_MK : SYSTEM_ROP;
  const overdue = task.hoursOverdue > 0;
  const tag = scopeTag(task);
  // Состав затронутых людей у задачи ПО ОТДЕЛУ меняется день ко дню — он пересобирается при каждом
  // прогоне MOP Agent. Даём его модели ОТДЕЛЬНОЙ строкой и требуем назвать поимённо: без имён РОПу
  // не с кем разговаривать («наладить процесс» без списка людей — это не задача, а лозунг).
  const who = (task.mops || []).length ? task.mops.join(", ") : "";
  const repeatLine = task.repeatCount > 1
    ? `\nПОВТОРНЫЙ ЗАХОД (${task.repeatCount}-й раз): РОП уже отчитывался, что закрыл это, но в данных проблема снова видна. Скажи это прямо и без обвинений: «отмечали как решённое, но факт повторился». Спроси, что мешает закрепить.`
    : "";
  const user = `${langLine(lang)}
${tag ? `\nМАСШТАБ ЗАДАЧИ: ${tag}. Начни сообщение ровно с этой пометки «${tag}» отдельной строкой — РОП должен сразу видеть, это вопрос процесса или разговор с конкретным человеком.\n${task.scope === "department" ? "Это СИСТЕМНАЯ проблема (встречается у нескольких менеджеров) — формулируй управленчески, про процесс, а НЕ про вину конкретного человека." : "Это ТОЧЕЧНЫЙ случай у одного человека — попроси РОПа поговорить с ним. Никаких ярлыков вроде «плохо работает», только факт и действие."}` : ""}${repeatLine}
${who ? `ЗАТРОНУТЫЕ СОТРУДНИКИ (актуально на сейчас, состав мог смениться со вчера): ${who}. ОБЯЗАТЕЛЬНО назови их поимённо в сообщении — иначе РОПу непонятно, с кем говорить.` : ""}
${task.deadlineLabel ? `СРОК (жёсткое правило, не обсуждается): ${task.deadlineLabel}` : ""}

${domainLbl}:
Название: ${task.title}
Зачем: ${task.why}
Шаги: ${(task.steps || []).join(" | ")}
Срок: ${task.deadline || "не задан"} ${overdue ? `(ПРОСРОЧЕНО на ${Math.round(task.hoursOverdue / 24)} дн)` : (task.daysLeft != null ? `(осталось ${task.daysLeft} дн)` : "")}
Статус в системе: ${task.done ? "отмечена выполненной" : "НЕ выполнена"}
Отчёт по задаче: ${task.report ? "есть" : "НЕТ"}

ПРЕДЫДУЩАЯ ПЕРЕПИСКА С ${whoWith} ПО ЭТОЙ ЗАДАЧЕ (может быть пустой):
${chatHistory || "(переписки ещё не было)"}

Напиши ${whoDat} ОДНО короткое сообщение (2-4 предложения). Если это первое обращение — представься как система Altrone. Спроси конкретно про статус ЭТОЙ задачи. Если просрочено — скажи факт спокойно и спроси, что мешает.
И СРАЗУ приложи подсказку-шаблон: что полезно указать в ответе ИМЕННО ПО ЭТОЙ ЗАДАЧЕ (см. правила в системном промпте). Пункты подстрой под суть задачи — у задачи с измеримым критерием и у задачи про причину задержки списки ДОЛЖНЫ отличаться.

Верни СТРОГО JSON, весь текст — на ВЫБРАННОМ ЧЕЛОВЕКОМ языке (см. ЯЗЫК ОТВЕТА выше), а не на языке задачи:
{"question":"текст вопроса","needsDetail":true,"hintHeader":"строка-заголовок подсказки, например «Чтобы я зафиксировал это правильно, укажите:»","checklist":["пункт 1","пункт 2","пункт 3"]}
needsDetail=false и пустой checklist — только если ждёшь простое да/нет.`;
  let out;
  // 1400 токенов: вопрос + подсказка (на 700 JSON обрывался и агент сваливался в дефолтный шаблон)
  // Haiku: формирование пинга — routine (scope/люди уже решены выше). При сбое — надёжный fallback ниже.
  try { out = parseJSON(await callModel(sysPrompt, user, 1400, MODEL_LIGHT)); }
  // Fallback тоже должен нести пометку масштаба, имена и срок — иначе при сбое модели РОП получит
  // обезличенное «какой статус?», из которого непонятно ни с кем говорить, ни к какому сроку.
  catch (e) {
    out = {
      question: `${tag ? tag + "\n" : ""}Здравствуйте! Я система Altrone. Какой статус по задаче «${task.title}»?${who ? ` Затронуты: ${who}.` : ""} Срок: ${task.deadlineLabel || task.deadline || "не задан"}.`,
      needsDetail: true, hintHeader: "Чтобы я зафиксировал это правильно, укажите:",
      checklist: ["статус (сделано / в процессе / не начато)", "если не сделано — что мешает", "когда реально планируете закончить"],
    };
  }
  const msg = assembleMsg(out);
  // ОБЩИЙ МОЗГ: строку сверки добавляем ДЕТЕРМИНИРОВАННО (не через модель) — честность о широте сигнала не должна теряться при перефразировании.
  return task.corroboration ? `${msg}\n\n🔎 Сверка сигнала: ${task.corroboration}` : msg;
}

// ── ОБРАБОТКА ОТВЕТА РОПа (вызывается из tg-bot webhook) ──
// Экспортируемый бандл состояния — РОВНО то, что отдаёт action:"state". Для чат-советника (без дублирования сбора).
export async function getTaskStateBundle() {
  const [tasks, st, esc, chat, cfg, people, mopRun, flows] = await Promise.all([
    loadSalesTasks(), rgetJSON(K.status, {}), rgetJSON(K.escalations, []), getChat(), getConfig(), getPeople(),
    getMopLastRun().catch(() => null), rgetJSON("scene:flows", []),
  ]);
  return { tasks, status: st, escalations: esc.slice(-40).reverse(), chat: chat.slice(-120), config: cfg, people,
    mopAgent: mopRun, flows: flows.slice(-8), now: { tashkentHour: tkHour(), tashkentDay: tkDay() } };
}

// Уведомление владельцу об ОСПАРИВАНИИ находки — с кнопками решения (✅ агент / 👤 РОП / 📝 учту).
// Это НЕ «эскалация как проигнорировано» — РОП ответил; это «есть спор фактов, реши».
async function notifyOwnerDispute(taskId, task, dispute) {
  const people = await getPeople();
  if (!(people.owner && people.owner.chatId)) return;
  const title = task ? task.title : taskId;
  const txt = `⚖️ <b>РОП оспорил находку</b>\n<b>Задача:</b> ${title}\n\n🤖 <b>Агент:</b> ${String(dispute.agentClaim || "—").slice(0, 500)}\n👤 <b>РОП:</b> ${String(dispute.ropClaim || "—").slice(0, 500)}\n\nОбе версии сохранены. Нажмите кнопку — <b>или ответьте текстом</b> свой вердикт/указание (напр. «проверь сначала — запроси у РОПа список», «пусть агент переанализирует»).`;
  const kb = { reply_markup: { inline_keyboard: [
    [{ text: "✅ Прав агент", callback_data: `disp:agent:${taskId}` }, { text: "👤 Прав РОП", callback_data: `disp:rop:${taskId}` }],
    [{ text: "📝 Учту, оставить открытым", callback_data: `disp:noted:${taskId}` }],
  ] } };
  const r = await sendTg("owner", people.owner.chatId, txt, kb);
  if (r.ok) { await rememberMsgTask("owner", r.messageId, taskId); await pushChat({ role: "agent", text: `⚖️ Оспорено РОПом (владельцу — на решение). Агент: ${dispute.agentClaim}. РОП: ${dispute.ropClaim}`, taskId }); }
}

export async function handleRopReply(text, replyToMsgId) {
  const cfg = await getConfig();
  if (!cfg.enabled || !AKEY) return;
  const tasks = await loadSalesTasks();
  const open = tasks.filter((t) => !t.done);
  // reply-контекст: если РОП ответил Reply'ем на пинг — берём задачу напрямую из карты message_id→taskId
  const replyTaskId = await lookupMsgTask("rop", replyToMsgId);
  const replyTask = replyTaskId ? open.find((t) => t.id === replyTaskId) : null;
  const chat = await getChat();
  const recent = chat.slice(-16).map((m) => `${m.role === "rop" ? "РОП" : (m.role === "owner" ? "ВЛАДЕЛЕЦ" : "АГЕНТ")}${m.taskId ? ` [задача ${m.taskId}]` : ""}: ${m.text}`).join("\n");

  const people0 = await getPeople();
  const ropLang = (people0.rop && people0.rop.lang) || "ru";
  const user = `${langLine(ropLang)}

ОТКРЫТЫЕ ЗАДАЧИ ОТДЕЛА ПРОДАЖ:
${open.map((t) => `- [${t.id}] ${scopeTag(t) ? scopeTag(t) + " " : ""}${t.title} | срок ${t.deadlineLabel || t.deadline || "нет"} ${t.hoursOverdue > 0 ? "(ПРОСРОЧЕНО)" : ""}`).join("\n") || "(открытых задач нет)"}

ПЕРЕПИСКА (последнее):
${recent}
${replyTask ? `\nРОП ОТВЕТИЛ (Reply) на сообщение по задаче [${replyTask.id}] «${replyTask.title}» — его сообщение почти наверняка относится ИМЕННО к этой задаче; используй этот taskId, если из текста явно не следует другое.` : ""}
НОВОЕ СООБЩЕНИЕ РОПа: ${text}

Ответь РОПу по делу (2-4 предложения) и определи, к какой задаче относится его сообщение.
Если от него снова ждёшь СОДЕРЖАТЕЛЬНЫЙ ответ (он ответил расплывчато / нужен статус / нужна причина) — приложи подсказку-шаблон, подстроенную под ЭТУ задачу (см. правила в системном промпте). Если ответ исчерпывающий и переспрашивать нечего — needsDetail=false.

Верни СТРОГО JSON, на языке переписки:
{"reply":"текст ответа РОПу","needsDetail":true,"hintHeader":"заголовок подсказки","checklist":["пункт 1","пункт 2"],"taskId":"id задачи или пусто","status":"in_progress|blocked|claims_done|disputed|unclear|none","note":"кратко что зафиксировал","disputeClaim":"ТОЛЬКО если status=disputed — суть контр-версии РОПа своими словами (что он утверждает ВМЕСТО факта находки); иначе пусто"}
status: in_progress — работает; blocked — что-то мешает; claims_done — говорит что сделал; disputed — ОСПАРИВАЕТ сам ФАКТ находки («это неверно, на самом деле так-то», приводит контр-факт); unclear — непонятно; none — не про задачи.

claims_done ставь СТРОГО: только если человек ЯВНО и КОНКРЕТНО сказал, что сделал (что именно сделал / с кем поговорил / что изменилось). Расплывчатое «вроде норм», «да там ок», «разберёмся», «посмотрю» — это НЕ claims_done, это unclear, и needsDetail=true. Не выдавай желаемое за сделанное: по claims_done с needsDetail=false задача закрывается автоматически, откатить это человек не сможет.

disputed ставь СТРОГО: только когда РОП оспаривает САМ ФАКТ находки (утверждает, что данные/вывод неверны, и приводит свою версию — «я проверил, там на самом деле так-то»). Это НЕ claims_done («сделал») и НЕ blocked («мешает»). При disputed задача НЕ закрывается: обе версии — агента и РОПа — сохраняются владельцу для решения, а в disputeClaim передай суть контр-версии РОПа. В reply ответь РОПу нейтрально: «спор зафиксирован, передал владельцу на решение» — без спора с ним и без признания вины.

ВАЖНО про закрытие: задачи с пометкой 🏢/👤 (находки по отделу/по МОПу) закрываются ПРЯМО ЗДЕСЬ, по твоей оценке ответа — НЕ отправляй РОПа закрывать их в интерфейсе, карточки там нет. Остальные задачи плана он закрывает сам в интерфейсе Altrone и оставляет отчёт.`;

  // 1500 токенов: JSON здесь БОЛЬШЕ, чем у пинга (reply+checklist+taskId+status+note). На 900 узбекский
  // ответ обрывался → parseJSON падал → немой русский шаблон (это и был баг «бот игнорирует РОПа»).
  let out = null, llmErr = null;
  for (let attempt = 0; attempt < 2 && !out; attempt++) {
    try { out = parseJSON(await callModel(SYSTEM_ROP, user, 1500)); }
    catch (e) { llmErr = e; }
  }
  if (!out) {
    // Не прячем сбой и НЕ вводим РОПа в заблуждение generic-переспросом. Фиксируем причину и честно
    // отвечаем НА ЯЗЫКЕ РОПа. taskId берём из reply-контекста, чтобы задача не «уехала» в эскалацию зря.
    await logDiag("handleRopReply", llmErr, text);
    out = ropLang === "uz"
      ? { reply: "Xabaringizni oldim va saqlab qo'ydim. Javobni tayyorlashda vaqtincha texnik nosozlik bo'ldi — tez orada shu mavzu bo'yicha to'liq javob beraman.", needsDetail: false, hintHeader: "", checklist: [], taskId: replyTaskId || "", status: "unclear", note: "LLM/parse error" }
      : { reply: "Сообщение получил и сохранил. При подготовке ответа была техническая заминка — вернусь с ответом по существу совсем скоро.", needsDetail: false, hintHeader: "", checklist: [], taskId: replyTaskId || "", status: "unclear", note: "LLM/parse error" };
  }
  out.reply = assembleMsg({ question: out.reply, needsDetail: out.needsDetail, hintHeader: out.hintHeader, checklist: out.checklist });

  const taskId = out.taskId || replyTaskId || "";
  // помечаем последнее сообщение РОПа принадлежностью к задаче
  if (taskId) {
    const all = await getChat();
    for (let i = all.length - 1; i >= 0; i--) { if (all[i].role === "rop" && !all[i].taskId) { all[i].taskId = taskId; break; } }
    await rsetJSON("taskagent:chat", all.slice(-400));
  }
  // фиксируем статус: РОП ответил → эскалации по этой задаче сегодня не будет
  const st = await rgetJSON(K.status, {});
  if (taskId) {
    st[taskId] = { ...(st[taskId] || {}), ropRepliedAt: Date.now(), ropRepliedDay: tkDay(), state: out.status || "unclear", note: out.note || "" };
    // ── ОСПАРИВАНИЕ: РОП оспорил САМ ФАКТ находки → структурно храним ДВЕ версии, НЕ закрываем, шлём владельцу с кнопками ──
    if (out.status === "disputed") {
      const t0 = open.find((t) => t.id === taskId);
      // append-only: если по этой задаче уже был спор — не затираем прошлую версию, ведём историю
      const prior = (st[taskId].dispute && st[taskId].dispute.history) || (st[taskId].dispute ? [{ ...st[taskId].dispute }] : []);
      st[taskId].dispute = {
        at: Date.now(),
        agentClaim: t0 ? (t0.why || t0.title || "") : "",
        ropClaim: String(out.disputeClaim || text || "").slice(0, 800),
        resolvedByOwner: null,
        history: prior,
      };
      try { await notifyOwnerDispute(taskId, t0, st[taskId].dispute); } catch (e) {}
    }
    await rsetJSON(K.status, st);
  }
  // Находку MOP Agent РОП закрывает СЛОВОМ (карточки в интерфейсе у неё нет).
  // ЖЁСТКИЙ ГЕЙТ, не мягче, чем у задач плана: закрываем ТОЛЬКО если модель И признала ответ
  // «сделано» (claims_done), И сочла его исчерпывающим (needsDetail=false). Расплывчатое
  // «вроде норм / посмотрю / да там ок» даёт needsDetail=true → находка НЕ закрывается,
  // агент продолжает спрашивать, а к порогу эскалации она уедет владельцу.
  // Плюс последний рубеж: даже закрытую словом находку следующий прогон перепроверяет ПО ДАННЫМ —
  // если факт не исчез, она вернётся с пометкой «СНОВА (2-й раз)».
  if (taskId && out.status === "claims_done" && out.needsDetail === false) {
    const t0 = open.find((t) => t.id === taskId);
    if (t0 && t0.source === "mop-agent") {
      try { await closeMopFinding(taskId, "rop_reported", out.note || text, t0.repeatCount || 1); } catch (e) {}
    } else if (t0 && t0.source === "metabrain") {
      try { await closeMetaProposal(taskId, "rop_reported"); } catch (e) {}
    }
  }
  const people = await getPeople();
  if (people.rop && people.rop.chatId && out.reply) {
    const r = await sendTg("rop", people.rop.chatId, out.reply);
    await pushChat({ role: "agent", text: out.reply, taskId });
    if (r.ok && taskId) await rememberMsgTask("rop", r.messageId, taskId); // РОП может ответить Reply'ем на этот вопрос
  }
  return { ok: true, taskId, status: out.status };
}

// ── ОБРАБОТКА ОТВЕТА МАРКЕТОЛОГА (вызывается из tg-bot webhook, ?bot=marketing) ──
// Тот же движок статус/закрытие, что у РОПа, но только по маркетинг-задачам и без dispute-цикла
// (маркетинг-задачи создаёт советник — это action-item, а не спорная находка по человеку).
export async function handleMarketingReply(text, replyToMsgId) {
  const cfg = await getConfig();
  if (!cfg.enabled || !AKEY) return;
  const tasks = (await loadSalesTasks()).filter((t) => t.recipient === "marketing" && !t.done);
  const replyTaskId = await lookupMsgTask("marketing", replyToMsgId);
  const replyTask = replyTaskId ? tasks.find((t) => t.id === replyTaskId) : null;
  const chat = await getChat();
  const recent = chat.slice(-16).map((m) => `${m.role === "agent" ? "АГЕНТ" : (m.role === "marketing" ? "МАРКЕТОЛОГ" : (m.role === "owner" ? "ВЛАДЕЛЕЦ" : "РОП"))}${m.taskId ? ` [задача ${m.taskId}]` : ""}: ${m.text}`).join("\n");
  const people0 = await getPeople();
  const lang = (people0.marketing && people0.marketing.lang) || "ru";
  const user = `${langLine(lang)}

ОТКРЫТЫЕ МАРКЕТИНГОВЫЕ ЗАДАЧИ:
${tasks.map((t) => `- [${t.id}] ${t.title} | срок ${t.deadlineLabel || t.deadline || "нет"} ${t.hoursOverdue > 0 ? "(ПРОСРОЧЕНО)" : ""}`).join("\n") || "(открытых задач нет)"}

ПЕРЕПИСКА (последнее):
${recent}
${replyTask ? `\nМАРКЕТОЛОГ ОТВЕТИЛ (Reply) на сообщение по задаче [${replyTask.id}] «${replyTask.title}» — используй этот taskId, если из текста явно не следует другое.` : ""}
НОВОЕ СООБЩЕНИЕ МАРКЕТОЛОГА: ${text}

Ответь по делу (2-4 предложения) и определи, к какой задаче относится. Если ждёшь содержательный ответ — приложи подсказку-шаблон.
Верни СТРОГО JSON, на языке переписки:
{"reply":"текст","needsDetail":true,"hintHeader":"заголовок","checklist":["п1","п2"],"taskId":"id или пусто","status":"in_progress|blocked|claims_done|unclear|none","note":"кратко"}
claims_done ставь СТРОГО: только если ЯВНО и КОНКРЕТНО сказал, что сделал (что именно). Расплывчатое «вроде ок / посмотрю» — это unclear, needsDetail=true. По claims_done+needsDetail=false задача ЗАКРЫВАЕТСЯ автоматически, откатить нельзя.`;
  let out = null, err = null;
  for (let a = 0; a < 2 && !out; a++) { try { out = parseJSON(await callModel(SYSTEM_MK, user, 1200)); } catch (e) { err = e; } }
  if (!out) {
    await logDiag("handleMarketingReply", err, text);
    out = { reply: lang === "uz" ? "Xabaringizni oldim va saqladim. Tez orada javob beraman." : "Сообщение получил и сохранил. Вернусь с ответом совсем скоро.", needsDetail: false, hintHeader: "", checklist: [], taskId: replyTaskId || "", status: "unclear", note: "LLM/parse error" };
  }
  out.reply = assembleMsg({ question: out.reply, needsDetail: out.needsDetail, hintHeader: out.hintHeader, checklist: out.checklist });
  const taskId = out.taskId || replyTaskId || "";
  if (taskId) {
    const all = await getChat();
    for (let i = all.length - 1; i >= 0; i--) { if (all[i].role === "marketing" && !all[i].taskId) { all[i].taskId = taskId; break; } }
    await rsetJSON("taskagent:chat", all.slice(-400));
  }
  const st = await rgetJSON(K.status, {});
  if (taskId) { st[taskId] = { ...(st[taskId] || {}), ropRepliedAt: Date.now(), ropRepliedDay: tkDay(), state: out.status || "unclear", note: out.note || "" }; await rsetJSON(K.status, st); }
  if (taskId && out.status === "claims_done" && out.needsDetail === false) {
    const t0 = tasks.find((t) => t.id === taskId);
    // маркетинг-задача от общего мозга (mb_) закрывается в его предложениях, своя (mk_) — в marketingtasks
    if (t0 && t0.source === "metabrain") { try { await closeMetaProposal(taskId, "marketing_reported"); } catch (e) {} }
    else { try { await closeMarketingTask(taskId, out.note || text); } catch (e) {} }
  }
  const people = await getPeople();
  if (people.marketing && people.marketing.chatId && out.reply) {
    const r = await sendTg("marketing", people.marketing.chatId, out.reply);
    await pushChat({ role: "agent", text: out.reply, taskId });
    if (r.ok && taskId) await rememberMsgTask("marketing", r.messageId, taskId);
  }
  return { ok: true, taskId, status: out.status };
}

// Решение владельца по ОСПАРИВАНИЮ (кнопки disp:agent|rop|noted). Обе версии остаются в истории — финальный статус их НЕ затирает.
// Необратимых авто-действий нет: агент лишь фиксирует решение владельца.
export async function handleDisputeResolve(action, taskId) {
  const st = await rgetJSON(K.status, {});
  const s = st[taskId];
  if (!s || !s.dispute) return { ok: false, toast: "спор не найден" };
  s.dispute.resolvedByOwner = action; s.dispute.resolvedAt = Date.now();
  const LBL = { agent: "оставлена (прав агент — РОП должен выполнить)", rop: "снята (принята версия РОПа)", noted: "оставлена под перепроверку данными" };
  if (action === "rop") {
    s.state = "resolved_rop";
    const tasks = await loadSalesTasks(); const t0 = tasks.find((t) => t.id === taskId);
    if (t0 && t0.source === "mop-agent") { try { await closeMopFinding(taskId, "owner_accepted_rop", s.dispute.ropClaim || "", t0.repeatCount || 1); } catch (e) {} }
    else if (t0 && t0.source === "metabrain") { try { await closeMetaProposal(taskId, "owner_accepted_rop"); } catch (e) {} }
  } else if (action === "agent") { s.state = "disputed_owner_agent"; } // остаётся открытой, РОП должен выполнить
  else { s.state = "disputed_noted"; }                                  // остаётся открытой под перепроверку
  await rsetJSON(K.status, st);
  return { ok: true, toast: "Решение принято", ownerMsg: `⚖️ Спор по задаче «${taskId}»: ${LBL[action] || action}. Обе версии сохранены в истории.` };
}

// ══ ОТВЕТ ВЛАДЕЛЬЦА НА ЭСКАЛАЦИЮ ══
// Владелец отвечает боту эскалаций свободным текстом («напомни мягко, не к спеху» / «сними с контроля»).
// Агент превращает инструкцию в КОНКРЕТНОЕ сообщение РОПу (на языке РОПа, тоном владельца) и коротко
// подтверждает владельцу. Привязка к задаче: reply_to_message → owner-карта, иначе последняя незакрытая
// эскалация (тот же класс reply-контекста, что чинили у РОПа — привязка явная, а не «на угад»).
const SYSTEM_OWNER = `Ты — Task-агент системы Altrone. С тобой в Telegram общается ВЛАДЕЛЕЦ бизнеса — он отвечает на ЭСКАЛАЦИЮ по задаче отдела продаж.

Твоя работа: превратить инструкцию владельца в КОНКРЕТНОЕ сообщение РОПу и коротко подтвердить владельцу, что ты сделал.

Правила:
- Сообщение РОПу пиши тоном, который задал владелец (мягко / настойчиво / срочно / «не к спеху» — ровно как он сказал). Ты — система Altrone, не человек: без давления, без ярлыков и оценок человека, коротко и по делу.
- Опирайся на КОНКРЕТНУЮ задачу и переписку — напоминай именно про эту задачу, а не абстрактно.
- Если владелец решает снять задачу с контроля («оставь / не трогай / хватит / снимаю») — action="close", РОПу НЕ пиши (ropMessage пусто).
- Если сообщение владельца не про эту задачу — action="none", ropMessage пусто, а в ownerReply коротко ответь ему по сути.

Верни СТРОГО JSON:
{"action":"message_rop|close|none","ropMessage":"текст сообщения РОПу на ЕГО языке — пусто, если не шлём","ownerReply":"короткое подтверждение владельцу на ЕГО языке: что именно ты сделал/отправил"}`;

// ── DISPUTE-AWARE: владелец отвечает СВОБОДНЫМ ТЕКСТОМ на ОСПАРИВАНИЕ (не только кнопки) ──
// Понимает контекст спора (обе версии), записывает вердикт владельца, и РЕАЛЬНО действует
// (перезапуск анализа / запрос данных у РОПа), а не обещает. «pending» — спор остаётся открытым.
const SYSTEM_OWNER_DISPUTE = `Ты — Task-агент Altrone. ВЛАДЕЛЕЦ отвечает СВОБОДНЫМ ТЕКСТОМ на ОСПАРИВАНИЕ находки — спор фактов между агентом и РОПом. Твоя задача: понять его ВЕРДИКТ и ИСПОЛНИТЬ его реально, не на словах.

- verdict="agent" — владелец согласен с агентом (находка остаётся, РОП должен выполнить).
- verdict="rop" — владелец принял версию РОПа (находка снимается).
- verdict="noted" — оставить открытой, просто зафиксировать.
- verdict="pending" — владелец НЕ решил окончательно: хочет СНАЧАЛА проверить / получить данные / переанализировать. Спор ОСТАЁТСЯ открытым, а ты РЕАЛЬНО делаешь запрошенное (запрос РОПу и/или перезапуск анализа), НЕ просто обещаешь.
- ropMessage — если владелец просит что-то запросить/передать РОПу (напр. «пришли список 82 лидов с ID и статусами») → сформулируй на языке РОПа; иначе пусто.
- rerun — если владелец просит ЗАНОВО прогнать анализ: "mop" (Супервайзер — находки по МОПам/статусам/дозвону) | "dev" (Менеджер по аналитике — метрики/корректность) | пусто. Выбери по сути спора.
- ownerReply — короткое ЧЕСТНОЕ подтверждение владельцу на ЕГО языке про УЖЕ сделанное (запросил у РОПа X, перезапустил анализ Y, зафиксировал вердикт). Без «сделаю» — только про факт.
Никаких необратимых действий с людьми. Верни СТРОГО JSON:
{"verdict":"agent|rop|noted|pending","ropMessage":"...или пусто","rerun":"mop|dev или пусто","ownerReply":"..."}`;

async function handleOwnerDisputeReply(text, taskId, task, dispute, people, ropLang, ownerLang) {
  const chat = await getChat();
  const recent = chat.slice(-12).map((m) => `${m.role === "rop" ? "РОП" : (m.role === "owner" ? "ВЛАДЕЛЕЦ" : "АГЕНТ")}: ${m.text}`).join("\n");
  const user = `ЯЗЫК СООБЩЕНИЯ РОПу: ${ropLang === "uz" ? "узбекский (латиница)" : "русский"}. ЯЗЫК ВЛАДЕЛЬЦУ: ${ownerLang === "uz" ? "узбекский (латиница)" : "русский"}.

СПОР ПО ЗАДАЧЕ: [${taskId}] ${task ? task.title : ""}
🤖 ВЕРСИЯ АГЕНТА: ${dispute.agentClaim}
👤 ВЕРСИЯ РОПа: ${dispute.ropClaim}

ПЕРЕПИСКА (последнее):
${recent || "(пусто)"}

РЕШЕНИЕ/УКАЗАНИЕ ВЛАДЕЛЬЦА (свободный текст): ${text}

Определи по правилам и верни СТРОГО JSON.`;
  let out = null, err = null;
  for (let a = 0; a < 2 && !out; a++) { try { out = parseJSON(await callModel(SYSTEM_OWNER_DISPUTE, user, 1000)); } catch (e) { err = e; } }
  if (!out) {
    await logDiag("handleOwnerDisputeReply", err, text);
    if (people.owner && people.owner.chatId) await sendTg("owner", people.owner.chatId, ownerLang === "uz" ? "Qaroringizni oldim, lekin qayta ishlashda nosozlik bo'ldi — qayta yuboring." : "Ваш вердикт получил, но при обработке была заминка — повторите, пожалуйста.");
    return { ok: false, error: "llm", dispute: true };
  }
  // 1) записываем вердикт владельца на спор — ТРЕТЬЯ грань записи, рядом с версиями агента и РОПа
  const st = await rgetJSON(K.status, {});
  if (st[taskId] && st[taskId].dispute) { st[taskId].dispute.ownerVerdict = String(text).slice(0, 700); st[taskId].dispute.ownerVerdictAt = Date.now(); await rsetJSON(K.status, st); }
  // 2) финальный вердикт → закрываем спор общим обработчиком; pending — оставляем открытым
  let resolved = null;
  if (["agent", "rop", "noted"].includes(out.verdict)) { try { await handleDisputeResolve(out.verdict, taskId); resolved = out.verdict; } catch (e) {} }
  // 3) реальный запрос РОПу
  let sentToRop = false;
  if (String(out.ropMessage || "").trim() && people.rop && people.rop.chatId) {
    const r = await sendTg("rop", people.rop.chatId, out.ropMessage);
    if (r.ok) { await pushChat({ role: "agent", text: out.ropMessage, taskId }); await rememberMsgTask("rop", r.messageId, taskId); sentToRop = true; }
  }
  // 4) РЕАЛЬНЫЙ перезапуск анализа (не обещание)
  let reran = null;
  try { if (out.rerun === "mop") { await runMopAgent(); reran = "mop"; } else if (out.rerun === "dev") { await runNightly("nightly", false); reran = "dev"; } } catch (e) {}
  // 5) подтверждение владельцу
  if (people.owner && people.owner.chatId && String(out.ownerReply || "").trim()) { await sendTg("owner", people.owner.chatId, out.ownerReply); await pushChat({ role: "agent", text: out.ownerReply, taskId, to: "owner" }); }
  return { ok: true, taskId, dispute: true, verdict: out.verdict, resolved, sentToRop, reran };
}

export async function handleOwnerReply(text, replyToMsgId) {
  const cfg = await getConfig();
  if (!cfg.enabled || !AKEY) return { ok: false, skipped: "disabled" };
  const people = await getPeople();
  const ropLang = (people.rop && people.rop.lang) || "ru";
  const ownerLang = (people.owner && people.owner.lang) || "ru";

  // 1) к какой эскалации/задаче относится ответ владельца
  const escs = await rgetJSON(K.escalations, []);
  let taskId = await lookupMsgTask("owner", replyToMsgId);
  if (!taskId) { const last = [...escs].reverse().find((e) => !e.resolved); taskId = last ? last.taskId : ""; }
  const esc = [...escs].reverse().find((e) => e.taskId === taskId) || null;
  const tasks = await loadSalesTasks();
  const task = tasks.find((t) => t.id === taskId) || (esc ? { id: taskId, title: esc.title, deadline: esc.deadline } : null);

  // Если по этой задаче ИДЁТ неразрешённый спор → dispute-aware ветка: понимаем контекст спора,
  // а НЕ трактуем ответ владельца как обычную «инструкцию РОПу» (это и был баг «ИИ не понимает контекст»).
  const st0 = await rgetJSON(K.status, {});
  const dispute = (st0[taskId] && st0[taskId].dispute && !st0[taskId].dispute.resolvedByOwner) ? st0[taskId].dispute : null;
  if (dispute) return await handleOwnerDisputeReply(text, taskId, task, dispute, people, ropLang, ownerLang);

  const chat = await getChat();
  const recent = chat.slice(-16).map((m) => `${m.role === "rop" ? "РОП" : (m.role === "owner" ? "ВЛАДЕЛЕЦ" : "АГЕНТ")}: ${m.text}`).join("\n");

  const user = `ЯЗЫК СООБЩЕНИЯ РОПу: ${ropLang === "uz" ? "узбекский (латиница)" : "русский"} — РОП сам выбрал этот язык.
ЯЗЫК ПОДТВЕРЖДЕНИЯ ВЛАДЕЛЬЦУ: ${ownerLang === "uz" ? "узбекский (латиница)" : "русский"}.

ЗАДАЧА ПОД ЭСКАЛАЦИЕЙ: ${task ? `[${task.id}] ${task.title}` : "(не удалось определить задачу)"}
СРОК: ${(task && (task.deadlineLabel || task.deadline)) || "не задан"}
СТАТУС ЭСКАЛАЦИИ: ${esc ? esc.status : "нет данных"}

ПЕРЕПИСКА С РОПом (последнее):
${recent || "(пусто)"}

ИНСТРУКЦИЯ ВЛАДЕЛЬЦА: ${text}

Сформулируй по правилам системного промпта и верни СТРОГО JSON.`;

  let out = null, err = null;
  for (let a = 0; a < 2 && !out; a++) { try { out = parseJSON(await callModel(SYSTEM_OWNER, user, 1200)); } catch (e) { err = e; } }
  if (!out) {
    await logDiag("handleOwnerReply", err, text);
    if (people.owner && people.owner.chatId) await sendTg("owner", people.owner.chatId, ownerLang === "uz" ? "Ko'rsatmangizni oldim, lekin qayta ishlashda texnik nosozlik bo'ldi — iltimos, qayta yuboring." : "Инструкцию получил, но при обработке была техническая заминка — повторите, пожалуйста.");
    return { ok: false, error: "llm" };
  }

  // адресат инструкции владельца — по задаче: продажи → РОП, маркетинг → Маркетолог
  const rcpt = (task && task.recipient) || "rop";
  const person = people[rcpt];
  let sentToRop = false;
  if (out.action === "message_rop" && String(out.ropMessage || "").trim() && person && person.chatId) {
    const r = await sendTg(rcpt, person.chatId, out.ropMessage);
    if (r.ok) {
      await pushChat({ role: "agent", text: out.ropMessage, taskId });
      await rememberMsgTask(rcpt, r.messageId, taskId); // получатель сможет ответить Reply'ем
      sentToRop = true;
      // владелец вмешался и дал задаче ход → отметим, чтобы не эскалировать её повторно в тот же день
      if (taskId) { const st = await rgetJSON(K.status, {}); st[taskId] = { ...(st[taskId] || {}), ownerActedDay: tkDay(), ownerActedAt: Date.now() }; await rsetJSON(K.status, st); }
    }
  }
  if (out.action === "close" && taskId) {
    const st = await rgetJSON(K.status, {});
    st[taskId] = { ...(st[taskId] || {}), ownerResolved: true, ownerResolvedAt: Date.now() };
    await rsetJSON(K.status, st);
    if (esc) { esc.resolved = true; await rsetJSON(K.escalations, escs.slice(-200)); }
  }
  if (people.owner && people.owner.chatId && String(out.ownerReply || "").trim()) {
    await sendTg("owner", people.owner.chatId, out.ownerReply);
    await pushChat({ role: "agent", text: out.ownerReply, taskId, to: "owner" });
  }
  return { ok: true, taskId, action: out.action, sentToRop };
}

// ── КНОПКИ ПОД ЭСКАЛАЦИЕЙ (callback_query) ── быстрые типовые решения владельца.
// remind — напомнить РОПу по задаче (переиспользуем composePing: тон/шаблон/язык уже в нём);
// close — снять с контроля; self — подсказать владельцу ответить текстом (Reply → handleOwnerReply).
export async function handleOwnerButton(action, taskId) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { ok: false, toast: "агент выключен" };
  const people = await getPeople();
  const escs = await rgetJSON(K.escalations, []);
  const esc = [...escs].reverse().find((e) => e.taskId === taskId) || null;
  const tasks = await loadSalesTasks();
  const task = tasks.find((t) => t.id === taskId) || (esc ? { id: taskId, title: esc.title, deadline: esc.deadline, source: "plan" } : null);
  // получатель напоминания — по задаче: продажи → РОП, маркетинг → Маркетолог
  const rcpt = (task && task.recipient) || "rop";
  const person = people[rcpt];
  const rLang = (person && person.lang) || "ru";
  const rWho = rcpt === "marketing" ? "Маркетологу" : "РОПу";

  if (action === "close") {
    const st = await rgetJSON(K.status, {});
    st[taskId] = { ...(st[taskId] || {}), ownerResolved: true, ownerResolvedAt: Date.now() };
    await rsetJSON(K.status, st);
    if (esc) { esc.resolved = true; await rsetJSON(K.escalations, escs.slice(-200)); }
    return { ok: true, action, toast: "Снято с контроля", ownerMsg: `✅ Снято с контроля: «${task ? task.title : taskId}». ${rWho} не пишу.` };
  }
  if (action === "self") {
    return { ok: true, action, toast: "Ответьте текстом (Reply)", ownerMsg: `✍️ Ответьте на это сообщение (Reply) вашей инструкцией — я передам ${rWho} в нужном тоне (например «напомни мягко, не к спеху»).` };
  }
  if (action === "remind") {
    if (!task) return { ok: false, toast: "Задача не найдена" };
    let sent = false;
    try {
      const chat = await getChat();
      const hist = chat.filter((m) => m.taskId === taskId).map((m) => `${m.role === "agent" ? "АГЕНТ" : (m.role === "marketing" ? "МАРКЕТОЛОГ" : "РОП")}: ${m.text}`).join("\n");
      const msg = await composePing(task, hist, rLang, rcpt);
      if (person && person.chatId) {
        const r = await sendTg(rcpt, person.chatId, msg);
        if (r.ok) {
          await pushChat({ role: "agent", text: msg, taskId });
          await rememberMsgTask(rcpt, r.messageId, taskId);
          const st = await rgetJSON(K.status, {}); st[taskId] = { ...(st[taskId] || {}), ownerActedDay: tkDay(), ownerActedAt: Date.now() }; await rsetJSON(K.status, st);
          sent = true;
        }
      }
    } catch (e) { await logDiag("handleOwnerButton/remind", e, taskId); }
    return { ok: sent, action, toast: sent ? `Напомнил ${rWho}` : "Не удалось отправить", ownerMsg: sent ? `🔔 Напомнил ${rWho} по задаче «${task.title}».` : "Не удалось напомнить — попробуйте позже." };
  }
  return { ok: false, toast: "неизвестное действие" };
}

// ── ТИК: пинги + порог эскалации ──
export async function runTick(force) {
  const cfg = await getConfig();
  if (!cfg.enabled) return { ok: true, skipped: "выключен" };
  const people = await getPeople();
  const tasks = await loadSalesTasks();
  const open = tasks.filter((t) => !t.done);
  const st = await rgetJSON(K.status, {});
  const chat = await getChat();
  const hour = tkHour(), day = tkDay();
  const pinged = [], escalated = [];
  const autoClosedNotified = [];

  // ── УВЕДОМЛЕНИЕ ОБ АВТО-ЗАКРЫТИИ находок MOP Agent ──
  // Без него РОП через неделю не поймёт, куда делась задача, которую он не закрывал сам.
  try {
    if (people.rop && people.rop.chatId) {
      for (const f of await getFreshAutoClosed()) {
        // Не пишем про задачу, которую РОП НИКОГДА НЕ ВИДЕЛ: сообщение «задача снята» о задаче,
        // которой ему не присылали, — это шум и повод для недоумения.
        if (!(st[f.id] && st[f.id].pingDay)) continue;
        const uz = ((people.rop && people.rop.lang) || "ru") === "uz";
        let txt;
        if (f.status === "invalidated") {
          // ЧЕСТНО: проблема НЕ решена — она оказалась недоказуемой (данные ненадёжны).
          // Выдать это за «всё исправилось» значило бы соврать в самой доверительной точке.
          txt = uz
            ? `⚠️ <b>Vazifa bekor qilindi</b>\n\n«${f.title}»\n\nBu muammo hal qilingani uchun emas — uni tekshirish uchun ma'lumotlar ishonchsiz bo'lib chiqdi. Sizdan hech narsa talab qilinmaydi.`
            : `⚠️ <b>Задача снята</b>\n\n«${f.title}»\n\nНе потому что решена — а потому что данные, на которых она построена, оказались недостоверными. От вас ничего не требуется.`;
        } else {
          txt = uz
            ? `✅ <b>Avtomatik yopildi</b>\n\n«${f.title}»\n\nTekshiruvda muammo qayta tasdiqlanmadi — ma'lumotlarda u endi ko'rinmayapti. Sizdan hech narsa talab qilinmaydi.`
            : `✅ <b>Автоматически закрыто</b>\n\n«${f.title}»\n\nПри проверке проблема больше не подтвердилась — в данных её уже нет. От вас ничего не требуется.`;
        }
        const r = await sendTg("rop", people.rop.chatId, txt);
        if (r.ok) { await pushChat({ role: "agent", text: txt, taskId: f.id }); autoClosedNotified.push(f.title); await sleep(400); } // пауза между отправками в один чат
      }
    }
  } catch (e) { /* не блокируем тик */ }

  for (const t of open) {
    const s = st[t.id] || {};
    // Находка MOP Agent — это уже готовая задача с фактом, её отдаём РОПу сразу при обнаружении,
    // а не за remindBeforeDays до срока (у точечных срок вообще «до конца дня»).
    const near = t.source === "mop-agent" || t.source === "metabrain" || (t.daysLeft != null && t.daysLeft <= cfg.remindBeforeDays);
    if (!near && !force) continue;

    // получатель задачи: продажи → РОП (по умолчанию), маркетинг → Маркетолог
    const rcpt = t.recipient || "rop";
    const person = people[rcpt];
    // 1) ПИНГ получателю — один раз в день по задаче, в рабочие часы
    const canPing = person && person.chatId && (hour >= cfg.pingFromHour || force) && s.pingDay !== day;
    if (canPing) {
      const hist = chat.filter((m) => m.taskId === t.id).map((m) => `${m.role === "agent" ? "АГЕНТ" : (m.role === "marketing" ? "МАРКЕТОЛОГ" : "РОП")}: ${m.text}`).join("\n");
      try {
        const msg = await composePing(t, hist, person.lang || "ru", rcpt);
        const r = await sendTg(rcpt, person.chatId, msg);
        if (r.ok) {
          await pushChat({ role: "agent", text: msg, taskId: t.id });
          await rememberMsgTask(rcpt, r.messageId, t.id); // Reply получателя на этот пинг → сопоставим с задачей
          st[t.id] = { ...s, pingDay: day, pingAt: Date.now(), state: s.state || "pinged" };
          pinged.push({ id: t.id, title: t.title, recipient: rcpt });
          await sleep(400); // пауза между пингами в один чат
        }
      } catch (e) { /* пропускаем задачу */ }
    }

    // 2) ЖЁСТКИЙ ПОРОГ ЭСКАЛАЦИИ: к escalationHour нет ни выполнения, ни ответа, ни действия
    const s2 = st[t.id] || {};
    const repliedToday = s2.ropRepliedDay === day;
    const alreadyEscalatedToday = s2.escalatedDay === day;
    const timeReached = hour >= cfg.escalationHour;
    // ВАЖНО: не эскалируем в том же тике, что и первый пинг — человеку надо дать время ответить.
    // Эскалация только если после пинга прошло >= escalationGraceMin минут.
    const pingAgeMin = s2.pingAt ? (Date.now() - s2.pingAt) / 60000 : -1;
    const hadTimeToAnswer = pingAgeMin >= (cfg.escalationGraceMin || 90);
    if (timeReached && hadTimeToAnswer && !repliedToday && !alreadyEscalatedToday && !t.done && s2.pingDay === day) {
      // статус — только факты, без суждений о человеке
      let status;
      if (t.hoursOverdue > 0) status = `просрочена на ${Math.round(t.hoursOverdue)} ч (срок был ${t.deadlineLabel || t.deadline})`;
      else if (s2.state === "in_progress") status = "в процессе, результата пока нет";
      else status = "не начата (нет ни отметки о выполнении, ни ответа)";
      const tag = scopeTag(t); // владелец видит: это находка по отделу или по конкретному человеку
      const conv = chat.filter((m) => m.taskId === t.id);
      const esc = {
        id: "esc_" + Date.now() + "_" + t.id, taskId: t.id, title: t.title, deadline: t.deadline || "не задан",
        status, conversation: conv.map((m) => ({ role: m.role, text: m.text, at: m.at })), at: Date.now(), day,
      };
      const list = await rgetJSON(K.escalations, []);
      list.push(esc);
      await rsetJSON(K.escalations, list.slice(-200));
      // ПОРОГ отдельного пуша владельцу (иначе флуд). Записываем ВСЕГДА (esc выше) — оно попадёт в утренний
      // отчёт по команде («просрочено N, тормозит X»). НО будим владельца отдельным сообщением ТОЛЬКО когда:
      //  1) задача про деньги (impactTier>=2 — тот же классификатор, что у очереди предложений: лиды без
      //     звонка, зависшие сделки, искажающие статусы уже попадают сюда через REVENUE_RX);
      //  2) устойчивое игнорирование + дедлайн сорван ≥2 дней (hoursOverdue>=48). Первый пропуск не будит.
      const pushOwner = escalationPushGate(t, status);
      // владельцу в Telegram — ТОЛЬКО факты + дословная переписка (только по высокому порогу)
      if (pushOwner && people.owner && people.owner.chatId) {
        const rWho = rcpt === "marketing" ? "Маркетолог" : "РОП";
        const rWhoDat = rcpt === "marketing" ? "Маркетологу" : "РОПу";
        const convTxt = conv.length
          ? conv.map((m) => `${m.role === "agent" ? "Агент" : (m.role === "marketing" ? "Маркетолог" : "РОП")}: ${m.text}`).join("\n\n")
          : `(переписки не было — ${rWho} не отвечал)`;
        const txt = `⚠️ <b>Эскалация Task-агента</b>\n${tag ? `${tag}\n` : ""}\n<b>Задача:</b> ${t.title}\n<b>Срок:</b> ${t.deadlineLabel || t.deadline || "не задан"}\n<b>Статус:</b> ${status}\n\n<b>Переписка с ${rWho === "Маркетолог" ? "Маркетологом" : "РОПом"} (дословно):</b>\n${convTxt}\n\n<i>Ответьте на это сообщение — я передам ${rWhoDat} или сниму задачу с контроля.</i>`;
        // Кнопки — быстрые типовые решения (дополнение к текстовому ответу, не замена).
        const kb = { reply_markup: { inline_keyboard: [
          [{ text: "🔔 Напомнить РОПу ещё раз", callback_data: `esc:remind:${t.id}` }],
          [{ text: "✅ Снять с контроля", callback_data: `esc:close:${t.id}` }, { text: "✍️ Написать самому", callback_data: `esc:self:${t.id}` }],
        ] } };
        const er = await sendTg("owner", people.owner.chatId, txt, kb);
        if (er.ok) { await rememberMsgTask("owner", er.messageId, t.id); await sleep(400); } // reply-контекст + пауза между отправками в один чат
      }
      st[t.id] = { ...s2, escalatedDay: day, escalatedAt: Date.now() };
      escalated.push({ id: t.id, title: t.title, status });
    }
  }
  await rsetJSON(K.status, st);
  return { ok: true, tashkentHour: hour, openTasks: open.length, pinged, escalated, autoClosedNotified };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "state";
  const isProd = process.env.NODE_ENV === "production";
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const isCron = cronSecret ? (authHeader === `Bearer ${cronSecret}`) : (!isProd && (q.cron === "1" || b.cron === true));
  const sess = await getSession(q.session || b.session);
  const isAdmin = !!sess && sess.role === "admin";
  if (!isAdmin && !(action === "tick" && isCron)) { res.status(403).json({ error: "admin only (или cron с секретом)" }); return; }

  try {
    if (action === "state") {
      const b = await getTaskStateBundle();
      res.status(200).json({ ok: true, ...b });
      return;
    }
    if (action === "tick") { const r = await runTick(!!b.force); res.status(200).json(isAdmin ? r : { ok: !!r.ok, ran: true }); return; }
    // РАЗОВОЕ ОБЪЯВЛЕНИЕ — отправить готовый текст РОПу/владельцу через канал Тренера (админ + подтверждение владельца).
    // Для срочных распоряжений команде (напр. запрет фраз) до полноценного скрипта. Логируется в chat.
    if (action === "announce") {
      const text = String((b.text || "")).trim();
      if (!text) { res.status(400).json({ error: "нужен text" }); return; }
      const to = b.to === "owner" ? "owner" : "rop";
      const people = await getPeople();
      const p = people[to];
      if (!p || !p.chatId) { res.status(400).json({ error: `${to} не привязан` }); return; }
      const r = await sendTg(to, p.chatId, text);
      if (r.ok) await pushChat({ role: "agent", text, taskId: null });
      res.status(200).json({ ok: !!r.ok, sent: !!r.ok, to, name: p.name, error: r.error || null });
      return;
    }
    // РАЗОВАЯ ПЕРЕОБРАБОТКА сообщения РОПа через исправленный handleRopReply (когда старый баг съел ответ).
    // Текст в чат НЕ дублируем — он уже там; прогоняем только генерацию ответа. Админ.
    if (action === "reprocess-rop") {
      const txt = String((b.text || "")).trim();
      if (!txt) { res.status(400).json({ error: "нужен text" }); return; }
      const r = await handleRopReply(txt, b.replyToMsgId || null);
      res.status(200).json({ ok: true, reprocessed: true, result: r || null });
      return;
    }
    // ТЕСТ/разовый прогон инструкции владельца по эскалации (то, что в норме приходит owner-вебхуком).
    // ВНИМАНИЕ: при action=message_rop реально отправит сообщение РОПу. Админ.
    if (action === "reprocess-owner") {
      const txt = String((b.text || "")).trim();
      if (!txt) { res.status(400).json({ error: "нужен text" }); return; }
      const r = await handleOwnerReply(txt, b.replyToMsgId || null);
      res.status(200).json({ ok: true, result: r || null });
      return;
    }
    // решение владельца по ОСПАРИВАНИЮ из панели (дубль кнопок owner-бота): decision = agent|rop|noted
    if (action === "resolve-dispute") {
      const decision = String(b.decision || q.decision || "").trim();
      const tId = String(b.taskId || q.taskId || "").trim();
      if (!["agent", "rop", "noted"].includes(decision) || !tId) { res.status(400).json({ error: "нужны taskId и decision=agent|rop|noted" }); return; }
      res.status(200).json(await handleDisputeResolve(decision, tId));
      return;
    }
    // ПРЕДПРОСМОТР пинга — составить сообщение БЕЗ отправки РОПу (проверка подсказок под разные задачи)
    if (action === "preview_ping") {
      const tasks = await loadSalesTasks();
      let t = tasks.find((x) => x.id === (q.taskId || b.taskId));
      if (b.synthetic) { const s = b.synthetic; t = { id: s.id || "synthetic", title: s.title, why: s.why || "", steps: s.steps || [], deadline: s.deadline || "", done: false, report: null, daysLeft: daysLeft(s.deadline), hoursOverdue: hoursOverdue(s.deadline) }; }
      if (!t) { res.status(404).json({ error: "task not found" }); return; }
      const chat = await getChat();
      const hist = chat.filter((m) => m.taskId === t.id).map((m) => `${m.role === "rop" ? "РОП" : "АГЕНТ"}: ${m.text}`).join("\n");
      const pv = await getPeople();
      const message = await composePing(t, hist, (q.lang || b.lang || (pv.rop && pv.rop.lang) || "ru"));
      res.status(200).json({ ok: true, taskId: t.id, title: t.title, deadline: t.deadline, daysLeft: t.daysLeft, hoursOverdue: t.hoursOverdue, message });
      return;
    }
    if (action === "set_config") {
      const cur = await getConfig(); const inc = b.config || {}; const next = { ...cur };
      for (const k of ["escalationHour", "pingFromHour", "remindBeforeDays"]) if (typeof inc[k] === "number" && isFinite(inc[k]) && inc[k] >= 0) next[k] = inc[k];
      if (typeof inc.enabled === "boolean") next.enabled = inc.enabled;
      await rsetJSON(K.config, next);
      res.status(200).json({ ok: true, config: next }); return;
    }
    if (action === "reset") {
      await Promise.all([rdel(K.status), rdel(K.escalations), rdel("taskagent:chat")]);
      res.status(200).json({ ok: true, reset: true }); return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
}
