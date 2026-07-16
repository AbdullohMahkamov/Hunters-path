// /api/task-agent.js — TASK AGENT («Агент В»). Держит дисциплину выполнения задач ОП:
// разговаривает с РОПом в Telegram, добивается результата по КАЖДОЙ задаче, и только если сам
// не справился — эскалирует владельцу. Тестово: только Hunter Academy (org="hunter").
//
// ══════════════ ГРАНИЦЫ (жёстко) ══════════════
//  МОЖЕТ: читать задачи (read-only), писать РОПу в Telegram, писать в taskagent:*, эскалировать владельцу.
//  НЕ МОЖЕТ: менять/закрывать/переназначать задачи (ни в Hunter AI, ни в amoCRM), ставить оценки людям.
//  В эскалации — ТОЛЬКО факты и ДОСЛОВНАЯ переписка. Никаких ярлыков вроде «РОП не справляется».
//  Оценку и решение делает владелец, прочитав историю.
//
// ИСТОЧНИК ЗАДАЧ: раздел «Задачи» самого Hunter AI (НЕ amoCRM) — `appdata:${org}`.customPlan.sales
// (это задачи отдела продаж, их видит и закрывает РОП). Дедлайн — поле task.deadline (YYYY-MM-DD).
//
// КАНАЛЫ: два служебных бота (api/tg-bot.js): "rop" — диалог с РОПом, "owner" — эскалации владельцу.
// Эскалации дублируются в UI /dev-agent (вкладка Task Agent).

import { sendTg, getPeople, pushChat, getChat } from "./tg-bot.js";
// MOP Agent не строит свой канал — его находки вливаются в ЭТОТ же список задач РОПа
// и дальше едут по уже работающей машине: пинг → диалог → порог 13:00 → эскалация владельцу.
import { getOpenMopFindings, getFreshAutoClosed, closeMopFinding, getMopLastRun } from "./mop-agent.js";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";
const ORG = "hunter"; // тест-фаза: один клиент. Архитектурно расширяемо (параметр org).

const K = { status: "taskagent:status", escalations: "taskagent:escalations", config: "taskagent:config" };
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
// 1) План Hunter AI (appdata.customPlan.sales) — задачи ОП, РОП закрывает их в интерфейсе.
// 2) Находки MOP Agent (mopagent:findings) — задачи по отделу / по конкретному МОПу.
// Оба идут РОПу ОДНИМ потоком через один бот и один тред, различаясь пометкой 🏢 / 👤.
async function loadSalesTasks() {
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
        // часовой горизонт: считаем из deadlineAt, а не из даты
        daysLeft: hrsLeft != null ? Math.ceil(hrsLeft / 24) : daysLeft(f.deadline),
        hoursLeft: hrsLeft,
        hoursOverdue: (hrsLeft != null && hrsLeft < 0) ? Math.abs(hrsLeft) : hoursOverdue(f.deadline),
      });
    }
  } catch (e) { /* MOP Agent недоступен — план всё равно едет */ }
  return out;
}

async function callModel(system, user, maxTokens = 900) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}
function parseJSON(t) { let s = String(t).replace(/```json/gi, "").replace(/```/g, "").trim(); const a = s.indexOf("{"), b = s.lastIndexOf("}"); if (a >= 0 && b > a) s = s.slice(a, b + 1); return JSON.parse(s); }

const SYSTEM_ROP = `Ты — Task-агент системы Hunter AI. Ты общаешься с РОПом (руководителем отдела продаж) в Telegram.

ЧЕСТНОСТЬ: ты — СИСТЕМА, а не человек. Не притворяйся человеком. Если спросят — прямо скажи, что ты бот Hunter AI.

ТВОЯ РОЛЬ: как операционный директор, который держит порядок, но НЕ давит и НЕ отсвечивает начальником. Ты добиваешься, чтобы по КАЖДОЙ задаче был явный результат/статус/комментарий. Ты не просто напоминаешь — ты ведёшь диалог: уточняешь статус, спрашиваешь что мешает, помогаешь сузить следующий шаг.

ТОН: спокойный, уважительный, деловой, коротко. Без пафоса, без «Уважаемый коллега», без эмодзи-спама. По-русски. Обращение на «вы».

ГРАНИЦЫ: ты не ставишь оценок человеку, не угрожаешь, не пишешь «вы не справляетесь». Ты не можешь сам закрыть задачу — закрывает человек в интерфейсе Hunter AI. Ты фиксируешь то, что он сказал.

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
  if (task.source !== "mop-agent") return "";
  if (task.scope === "department") return "🏢 ПО ОТДЕЛУ";
  return `👤 ПО МОПУ${task.mop ? ` (${task.mop})` : ""}`;
}
async function composePing(task, chatHistory, lang) {
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

ЗАДАЧА ОТДЕЛА ПРОДАЖ:
Название: ${task.title}
Зачем: ${task.why}
Шаги: ${(task.steps || []).join(" | ")}
Срок: ${task.deadline || "не задан"} ${overdue ? `(ПРОСРОЧЕНО на ${Math.round(task.hoursOverdue / 24)} дн)` : (task.daysLeft != null ? `(осталось ${task.daysLeft} дн)` : "")}
Статус в системе: ${task.done ? "отмечена выполненной" : "НЕ выполнена"}
Отчёт по задаче: ${task.report ? "есть" : "НЕТ"}

ПРЕДЫДУЩАЯ ПЕРЕПИСКА С РОПом ПО ЭТОЙ ЗАДАЧЕ (может быть пустой):
${chatHistory || "(переписки ещё не было)"}

Напиши РОПу ОДНО короткое сообщение (2-4 предложения). Если это первое обращение — представься как система Hunter AI. Спроси конкретно про статус ЭТОЙ задачи. Если просрочено — скажи факт спокойно и спроси, что мешает.
И СРАЗУ приложи подсказку-шаблон: что полезно указать в ответе ИМЕННО ПО ЭТОЙ ЗАДАЧЕ (см. правила в системном промпте). Пункты подстрой под суть задачи — у задачи с измеримым критерием и у задачи про причину задержки списки ДОЛЖНЫ отличаться.

Верни СТРОГО JSON, весь текст — на ВЫБРАННОМ ЧЕЛОВЕКОМ языке (см. ЯЗЫК ОТВЕТА выше), а не на языке задачи:
{"question":"текст вопроса","needsDetail":true,"hintHeader":"строка-заголовок подсказки, например «Чтобы я зафиксировал это правильно, укажите:»","checklist":["пункт 1","пункт 2","пункт 3"]}
needsDetail=false и пустой checklist — только если ждёшь простое да/нет.`;
  let out;
  // 1400 токенов: вопрос + подсказка (на 700 JSON обрывался и агент сваливался в дефолтный шаблон)
  try { out = parseJSON(await callModel(SYSTEM_ROP, user, 1400)); }
  // Fallback тоже должен нести пометку масштаба, имена и срок — иначе при сбое модели РОП получит
  // обезличенное «какой статус?», из которого непонятно ни с кем говорить, ни к какому сроку.
  catch (e) {
    out = {
      question: `${tag ? tag + "\n" : ""}Здравствуйте! Я система Hunter AI. Какой статус по задаче «${task.title}»?${who ? ` Затронуты: ${who}.` : ""} Срок: ${task.deadlineLabel || task.deadline || "не задан"}.`,
      needsDetail: true, hintHeader: "Чтобы я зафиксировал это правильно, укажите:",
      checklist: ["статус (сделано / в процессе / не начато)", "если не сделано — что мешает", "когда реально планируете закончить"],
    };
  }
  return assembleMsg(out);
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

export async function handleRopReply(text) {
  const cfg = await getConfig();
  if (!cfg.enabled || !AKEY) return;
  const tasks = await loadSalesTasks();
  const open = tasks.filter((t) => !t.done);
  const chat = await getChat();
  const recent = chat.slice(-16).map((m) => `${m.role === "rop" ? "РОП" : (m.role === "owner" ? "ВЛАДЕЛЕЦ" : "АГЕНТ")}${m.taskId ? ` [задача ${m.taskId}]` : ""}: ${m.text}`).join("\n");

  const people0 = await getPeople();
  const ropLang = (people0.rop && people0.rop.lang) || "ru";
  const user = `${langLine(ropLang)}

ОТКРЫТЫЕ ЗАДАЧИ ОТДЕЛА ПРОДАЖ:
${open.map((t) => `- [${t.id}] ${scopeTag(t) ? scopeTag(t) + " " : ""}${t.title} | срок ${t.deadlineLabel || t.deadline || "нет"} ${t.hoursOverdue > 0 ? "(ПРОСРОЧЕНО)" : ""}`).join("\n") || "(открытых задач нет)"}

ПЕРЕПИСКА (последнее):
${recent}

НОВОЕ СООБЩЕНИЕ РОПа: ${text}

Ответь РОПу по делу (2-4 предложения) и определи, к какой задаче относится его сообщение.
Если от него снова ждёшь СОДЕРЖАТЕЛЬНЫЙ ответ (он ответил расплывчато / нужен статус / нужна причина) — приложи подсказку-шаблон, подстроенную под ЭТУ задачу (см. правила в системном промпте). Если ответ исчерпывающий и переспрашивать нечего — needsDetail=false.

Верни СТРОГО JSON, на языке переписки:
{"reply":"текст ответа РОПу","needsDetail":true,"hintHeader":"заголовок подсказки","checklist":["пункт 1","пункт 2"],"taskId":"id задачи или пусто","status":"in_progress|blocked|claims_done|unclear|none","note":"кратко что зафиксировал"}
status: in_progress — работает; blocked — что-то мешает; claims_done — говорит что сделал; unclear — непонятно; none — не про задачи.

claims_done ставь СТРОГО: только если человек ЯВНО и КОНКРЕТНО сказал, что сделал (что именно сделал / с кем поговорил / что изменилось). Расплывчатое «вроде норм», «да там ок», «разберёмся», «посмотрю» — это НЕ claims_done, это unclear, и needsDetail=true. Не выдавай желаемое за сделанное: по claims_done с needsDetail=false задача закрывается автоматически, откатить это человек не сможет.

ВАЖНО про закрытие: задачи с пометкой 🏢/👤 (находки по отделу/по МОПу) закрываются ПРЯМО ЗДЕСЬ, по твоей оценке ответа — НЕ отправляй РОПа закрывать их в интерфейсе, карточки там нет. Остальные задачи плана он закрывает сам в интерфейсе Hunter AI и оставляет отчёт.`;

  let out;
  try { out = parseJSON(await callModel(SYSTEM_ROP, user, 900)); }
  catch (e) { out = { reply: "Принял. Уточните, пожалуйста, по какой задаче и какой сейчас статус?", needsDetail: true, hintHeader: "Чтобы зафиксировать правильно, укажите:", checklist: ["о какой задаче речь", "статус (сделано / в процессе / не начато)", "если не сделано — что мешает"], taskId: "", status: "unclear", note: "" }; }
  out.reply = assembleMsg({ question: out.reply, needsDetail: out.needsDetail, hintHeader: out.hintHeader, checklist: out.checklist });

  const taskId = out.taskId || "";
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
    }
  }
  const people = await getPeople();
  if (people.rop && people.rop.chatId && out.reply) {
    await sendTg("rop", people.rop.chatId, out.reply);
    await pushChat({ role: "agent", text: out.reply, taskId });
  }
  return { ok: true, taskId, status: out.status };
}

// ── ТИК: пинги + порог эскалации ──
async function runTick(force) {
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
        if (r.ok) { await pushChat({ role: "agent", text: txt, taskId: f.id }); autoClosedNotified.push(f.title); }
      }
    }
  } catch (e) { /* не блокируем тик */ }

  for (const t of open) {
    const s = st[t.id] || {};
    // Находка MOP Agent — это уже готовая задача с фактом, её отдаём РОПу сразу при обнаружении,
    // а не за remindBeforeDays до срока (у точечных срок вообще «до конца дня»).
    const near = t.source === "mop-agent" || (t.daysLeft != null && t.daysLeft <= cfg.remindBeforeDays);
    if (!near && !force) continue;

    // 1) ПИНГ РОПу — один раз в день по задаче, в рабочие часы
    const canPing = people.rop && people.rop.chatId && (hour >= cfg.pingFromHour || force) && s.pingDay !== day;
    if (canPing) {
      const hist = chat.filter((m) => m.taskId === t.id).map((m) => `${m.role === "rop" ? "РОП" : "АГЕНТ"}: ${m.text}`).join("\n");
      try {
        const msg = await composePing(t, hist, (people.rop && people.rop.lang) || "ru");
        const r = await sendTg("rop", people.rop.chatId, msg);
        if (r.ok) {
          await pushChat({ role: "agent", text: msg, taskId: t.id });
          st[t.id] = { ...s, pingDay: day, pingAt: Date.now(), state: s.state || "pinged" };
          pinged.push({ id: t.id, title: t.title });
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
      // владельцу в Telegram — ТОЛЬКО факты + дословная переписка
      if (people.owner && people.owner.chatId) {
        const convTxt = conv.length
          ? conv.map((m) => `${m.role === "rop" ? "РОП" : "Агент"}: ${m.text}`).join("\n\n")
          : "(переписки не было — РОП не отвечал)";
        const txt = `⚠️ <b>Эскалация Task-агента</b>\n${tag ? `${tag}\n` : ""}\n<b>Задача:</b> ${t.title}\n<b>Срок:</b> ${t.deadlineLabel || t.deadline || "не задан"}\n<b>Статус:</b> ${status}\n\n<b>Переписка с РОПом (дословно):</b>\n${convTxt}`;
        await sendTg("owner", people.owner.chatId, txt);
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
