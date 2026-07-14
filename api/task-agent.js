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

// ── ЗАДАЧИ ОП (read-only из appdata) ──
async function loadSalesTasks() {
  const app = await rgetJSON(`appdata:${ORG}`, null);
  const cp = app && app.customPlan;
  if (!cp || !Array.isArray(cp.sales)) return [];
  const done = (app && app.done) || {};
  const hist = (app && app.taskHistory) || [];
  return cp.sales.map((q) => {
    const steps = q.steps || [];
    const isDone = steps.length ? steps.every((_, si) => !!done[q.id + "_s" + si]) : !!done[q.id];
    const report = hist.find((h) => h.taskId === q.id || h.id === q.id) || (q.report ? { result: q.report } : null);
    return { id: q.id, title: q.t, why: q.d || "", deadline: q.deadline || "", steps, done: isDone, report: report || null,
      daysLeft: daysLeft(q.deadline), hoursOverdue: hoursOverdue(q.deadline) };
  });
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

// ── ПИНГ ПО ЗАДАЧЕ ──
async function composePing(task, chatHistory) {
  const overdue = task.hoursOverdue > 0;
  const user = `ЗАДАЧА ОТДЕЛА ПРОДАЖ:
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

Верни СТРОГО JSON, всё на языке задачи (если задача на узбекском — пиши по-узбекски):
{"question":"текст вопроса","needsDetail":true,"hintHeader":"строка-заголовок подсказки, например «Чтобы я зафиксировал это правильно, укажите:»","checklist":["пункт 1","пункт 2","пункт 3"]}
needsDetail=false и пустой checklist — только если ждёшь простое да/нет.`;
  let out;
  try { out = parseJSON(await callModel(SYSTEM_ROP, user, 700)); }
  catch (e) { out = { question: `Здравствуйте! Я система Hunter AI. Какой статус по задаче «${task.title}»? Срок: ${task.deadline || "не задан"}.`, needsDetail: true, hintHeader: "Чтобы я зафиксировал это правильно, укажите:", checklist: ["статус (сделано / в процессе / не начато)", "если не сделано — что мешает", "когда реально планируете закончить"] }; }
  return assembleMsg(out);
}

// ── ОБРАБОТКА ОТВЕТА РОПа (вызывается из tg-bot webhook) ──
export async function handleRopReply(text) {
  const cfg = await getConfig();
  if (!cfg.enabled || !AKEY) return;
  const tasks = await loadSalesTasks();
  const open = tasks.filter((t) => !t.done);
  const chat = await getChat();
  const recent = chat.slice(-16).map((m) => `${m.role === "rop" ? "РОП" : (m.role === "owner" ? "ВЛАДЕЛЕЦ" : "АГЕНТ")}${m.taskId ? ` [задача ${m.taskId}]` : ""}: ${m.text}`).join("\n");

  const user = `ОТКРЫТЫЕ ЗАДАЧИ ОТДЕЛА ПРОДАЖ:
${open.map((t) => `- [${t.id}] ${t.title} | срок ${t.deadline || "нет"} ${t.hoursOverdue > 0 ? "(ПРОСРОЧЕНО)" : ""}`).join("\n") || "(открытых задач нет)"}

ПЕРЕПИСКА (последнее):
${recent}

НОВОЕ СООБЩЕНИЕ РОПа: ${text}

Ответь РОПу по делу (2-4 предложения) и определи, к какой задаче относится его сообщение.
Если от него снова ждёшь СОДЕРЖАТЕЛЬНЫЙ ответ (он ответил расплывчато / нужен статус / нужна причина) — приложи подсказку-шаблон, подстроенную под ЭТУ задачу (см. правила в системном промпте). Если ответ исчерпывающий и переспрашивать нечего — needsDetail=false.

Верни СТРОГО JSON, на языке переписки:
{"reply":"текст ответа РОПу","needsDetail":true,"hintHeader":"заголовок подсказки","checklist":["пункт 1","пункт 2"],"taskId":"id задачи или пусто","status":"in_progress|blocked|claims_done|unclear|none","note":"кратко что зафиксировал"}
status: in_progress — работает; blocked — что-то мешает; claims_done — говорит что сделал (напомни закрыть в интерфейсе и оставить отчёт); unclear — непонятно; none — не про задачи.`;

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

  for (const t of open) {
    const s = st[t.id] || {};
    const near = t.daysLeft != null && t.daysLeft <= cfg.remindBeforeDays; // срок близко или прошёл
    if (!near && !force) continue;

    // 1) ПИНГ РОПу — один раз в день по задаче, в рабочие часы
    const canPing = people.rop && people.rop.chatId && (hour >= cfg.pingFromHour || force) && s.pingDay !== day;
    if (canPing) {
      const hist = chat.filter((m) => m.taskId === t.id).map((m) => `${m.role === "rop" ? "РОП" : "АГЕНТ"}: ${m.text}`).join("\n");
      try {
        const msg = await composePing(t, hist);
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
      if (t.hoursOverdue > 0) status = `просрочена на ${Math.round(t.hoursOverdue)} ч (срок был ${t.deadline})`;
      else if (s2.state === "in_progress") status = "в процессе, результата пока нет";
      else status = "не начата (нет ни отметки о выполнении, ни ответа)";
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
        const txt = `⚠️ <b>Эскалация Task-агента</b>\n\n<b>Задача:</b> ${t.title}\n<b>Срок:</b> ${t.deadline || "не задан"}\n<b>Статус:</b> ${status}\n\n<b>Переписка с РОПом (дословно):</b>\n${convTxt}`;
        await sendTg("owner", people.owner.chatId, txt);
      }
      st[t.id] = { ...s2, escalatedDay: day, escalatedAt: Date.now() };
      escalated.push({ id: t.id, title: t.title, status });
    }
  }
  await rsetJSON(K.status, st);
  return { ok: true, tashkentHour: hour, openTasks: open.length, pinged, escalated };
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
      const [tasks, st, esc, chat, cfg, people] = await Promise.all([
        loadSalesTasks(), rgetJSON(K.status, {}), rgetJSON(K.escalations, []), getChat(), getConfig(), getPeople(),
      ]);
      res.status(200).json({ ok: true, tasks, status: st, escalations: esc.slice(-40).reverse(), chat: chat.slice(-120), config: cfg, people,
        now: { tashkentHour: tkHour(), tashkentDay: tkDay() } });
      return;
    }
    if (action === "tick") { const r = await runTick(!!b.force); res.status(200).json(isAdmin ? r : { ok: !!r.ok, ran: true }); return; }
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
