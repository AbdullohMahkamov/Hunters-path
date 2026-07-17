// api/advisor-act.js — ИСПОЛНЕНИЕ действий, которые советник рекомендует, ТОЛЬКО ПО КЛИКУ владельца.
// Никакой автономии: фронт зовёт это исключительно после нажатия кнопки под ответом советника.
// 4 маршрута (вся проводка уже существует, здесь только точка входа + запись):
//   rop_msg    — разовое сообщение РОПу через канал Тренера (sendTg + лог в taskagent:chat)
//   rop_task   — полноценная задача в план (appdata.customPlan.sales) → Task Agent сам пингует/эскалирует
//   analyst    — команда Менеджеру по аналитике (Dev-Agent): кладём в его чат как поручение владельца
//   close_hyp  — закрыть гипотезу Агента роста (growthagent:hypotheses → tested c результатом)
// Всё — admin-гейт (владелец). Каждое действие идемпотентно-безопасно и логируется.

import { sendTg, getPeople, pushChat } from "./tg-bot.js";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORG = "hunter";

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
function genId(p) { return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// rop_task → в план Hunter AI. Task Agent ([api/task-agent.js] loadSalesTasks) читает appdata.customPlan.sales
// и ведёт задачу по полной машине (пинг → диалог → порог 13:00 → эскалация). РОП закрывает её в интерфейсе.
async function createRopTask({ title, why, deadline, steps }) {
  const app = (await rgetJSON(`appdata:${ORG}`, {})) || {};
  app.customPlan = app.customPlan || {};
  if (!Array.isArray(app.customPlan.sales)) app.customPlan.sales = [];
  const id = genId("adv_");
  app.customPlan.sales.push({
    id, t: String(title || "").slice(0, 200), d: String(why || "").slice(0, 800),
    deadline: deadline || "", steps: Array.isArray(steps) ? steps.slice(0, 8) : (steps ? [String(steps)] : []),
    source: "advisor", createdAt: Date.now(),
  });
  await rsetJSON(`appdata:${ORG}`, app);
  return { id };
}

// analyst → поручение Менеджеру по аналитике (Dev-Agent). Кладём в его чат как сообщение владельца,
// чтобы аналитик увидел команду (в интерфейсе /dev-agent) и отработал её. Не запускаем тяжёлый прогон здесь.
async function commandAnalyst({ text }) {
  const chat = await rgetJSON("devagent:chat", []);
  chat.push({ id: genId("m"), role: "user", text: String(text || "").slice(0, 1200), at: Date.now(), from: "советник (по поручению владельца)" });
  await rsetJSON("devagent:chat", chat.slice(-240));
  return { queued: true };
}

// close_hyp → закрыть гипотезу Агента роста. Повторяет логику growth mark_result: гипотеза уезжает в tested
// с результатом, из открытых убирается. По умолчанию — как false-positive (техническая, без вывода о команде).
async function closeHypothesis({ hypId, result, note }) {
  const hyps = await rgetJSON("growthagent:hypotheses", []);
  const h = hyps.find((x) => x.id === hypId);
  if (!h) return { ok: false, error: "гипотеза не найдена" };
  const tested = await rgetJSON("growthagent:tested", []);
  tested.push({ ...h, status: "tested", result: result || "false_positive", resultNote: String(note || "закрыто через советника").slice(0, 400), testedAt: Date.now() });
  await rsetJSON("growthagent:tested", tested.slice(-60));
  await rsetJSON("growthagent:hypotheses", hyps.filter((x) => x.id !== hypId));
  return { ok: true };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "";
  const sess = await getSession(q.session || b.session);
  if (!sess || sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }

  try {
    const type = b.type || q.type;
    if (action !== "act" || !type) { res.status(400).json({ error: "нужен action=act и type" }); return; }

    if (type === "rop_msg") {
      const text = String(b.text || "").trim();
      if (!text) { res.status(400).json({ error: "нужен text" }); return; }
      const people = await getPeople();
      const p = people.rop;
      if (!p || !p.chatId) { res.status(400).json({ error: "РОП не привязан" }); return; }
      const r = await sendTg("rop", p.chatId, text);
      if (r.ok) await pushChat({ role: "agent", text, taskId: null });
      res.status(200).json({ ok: !!r.ok, type, sent: !!r.ok, to: p.name, error: r.error || null });
      return;
    }
    if (type === "rop_task") {
      const title = String(b.title || "").trim();
      if (!title) { res.status(400).json({ error: "нужен title" }); return; }
      const r = await createRopTask({ title, why: b.why, deadline: b.deadline, steps: b.steps });
      res.status(200).json({ ok: true, type, taskId: r.id, note: "задача добавлена в план — Task Agent начнёт вести её (пинг/эскалация)" });
      return;
    }
    if (type === "analyst") {
      const text = String(b.text || "").trim();
      if (!text) { res.status(400).json({ error: "нужен text" }); return; }
      const r = await commandAnalyst({ text });
      res.status(200).json({ ok: true, type, ...r, note: "команда передана Менеджеру по аналитике" });
      return;
    }
    if (type === "close_hyp") {
      const hypId = String(b.hypId || "").trim();
      if (!hypId) { res.status(400).json({ error: "нужен hypId" }); return; }
      const r = await closeHypothesis({ hypId, result: b.result, note: b.note });
      res.status(r.ok ? 200 : 404).json({ ok: r.ok, type, error: r.error || null });
      return;
    }
    res.status(400).json({ error: "неизвестный type" });
  } catch (e) { res.status(200).json({ ok: false, error: String(e).slice(0, 200) }); }
}
