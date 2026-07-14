// /api/plan-stream.js — потоковая генерация плана: модель СНАЧАЛА вслух разбирает ситуацию
// (стримится по токенам, как в VSCode), ПОТОМ выдаёт маркер ===PLAN=== и строго JSON плана.
// Данные аудита — те же, что у /api/audit-plan. Стриминг — как у /api/chat.

import { retrieveSolutions } from "./knowledge.js"; // коллективный разум: проверенные подходы из общей базы

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

async function readCache(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return JSON.parse(d.result);
  } catch (e) { return null; }
}
async function resolveOrg(session) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!session || !url || !token) return "hunter";
  try {
    const r = await fetch(`${url}/get/session:${session}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (d && d.result) { const s = JSON.parse(d.result); return (s && s.org) || "hunter"; }
  } catch (e) { /* ignore */ }
  return "hunter";
}
// подсказки о проблемах бизнеса — для матчинга решений в общей базе
function buildProblemHints(dash, speed, auditProblems) {
  const hints = [];
  if (auditProblems) for (const p of auditProblems) hints.push(p.name);
  if (dash && dash.totals) {
    const t = dash.totals;
    const nc = t.noContactPctAudit != null ? t.noContactPctAudit : t.noContactPct;
    if (nc != null && nc >= 30) hints.push("дозвон", "потеря до контакта");
    const conv = t.convAudit != null ? t.convAudit : t.conv;
    if (conv != null && conv < 3) hints.push("конверсия", "закрытие сделки");
  }
  if (speed && speed.mops) {
    for (const m of speed.mops) { if (m.medianFirstCallMin != null && m.medianFirstCallMin > 30) { hints.push("скорость дозвона", "первый звонок"); break; } }
  }
  return hints;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set" }); return; }

  try {
    const { goal, currentSales, lang, adjust, session } = req.body || {};
    const org = await resolveOrg(session);
    const dash = await readCache("dashboard");
    const speed = await readCache("speed");

    // ── СБОРКА АУДИТА (1:1 с audit-plan.js) ──
    let auditText = "ПЕРИОД АУДИТА: данные о проблемах и потерях — за последние 3-4 месяца.\n\n";
    if (currentSales) auditText += `ТЕКУЩИЕ ПРОДАЖИ: ${currentSales}\n`;
    if (dash && dash.totals) {
      const t = dash.totals;
      if (t.soldPeriod != null) auditText += `Продаж за 3-4 месяца: ${t.soldPeriod}, выручка за период ${t.revenuePeriod}. В этом месяце: ${t.sold} продаж.\n`;
      else auditText += `Продаж в этом месяце: ${t.sold}, выручка ${t.revenue}.\n`;
      const convA = t.convAudit != null ? t.convAudit : t.conv;
      const ncA = t.noContactPctAudit != null ? t.noContactPctAudit : t.noContactPct;
      auditText += `За период (3-4 мес): конверсия ${convA}%, средний чек ${t.avgCheck}, потеря до контакта ${ncA}%.\n`;
    }
    const auditProblems = (dash && dash.problemsAll && dash.problemsAll.length) ? dash.problemsAll : (dash && dash.problems);
    if (auditProblems && auditProblems.length) auditText += "Главные причины потерь:\n" + auditProblems.map(p => `- ${p.name}: ${p.count}`).join("\n") + "\n";
    if (speed && speed.mops && speed.mops.length) {
      auditText += "Дисциплина менеджеров:\n" + speed.mops.map(m => `- ${m.name}: 1-й звонок ${m.medianFirstCallMin ?? "?"}мин, звонков/лид ${m.avgCallsPerLead}, закрыл рано ${m.earlyClosePct}%, задачи ${m.taskRate}%`).join("\n");
    }
    if (!auditText.trim()) auditText = "Данных мало. Составь общий план роста продаж.";

    // КОЛЛЕКТИВНЫЙ РАЗУМ: подмешиваем проверенные подходы похожих бизнесов из общей базы
    let kbBlock = "";
    try {
      const hints = buildProblemHints(dash, speed, auditProblems);
      const solutions = await retrieveSolutions(org, hints, 4);
      if (solutions.length) {
        kbBlock = "\n\nПРОВЕРЕННЫЕ ПОДХОДЫ ПОХОЖИХ БИЗНЕСОВ (реальный обезличенный опыт из общей базы; адаптируй те, что подходят к этой ситуации, не копируй слепо):\n" +
          solutions.map((s, i) => `${i + 1}. Проблема: ${s.problem || (s.problemTags || []).join(", ")}. Подход: ${s.approach}. Итог: ${s.outcome}`).join("\n");
      }
    } catch (e) { /* ignore */ }

    const SYSTEM = `Ты — коммерческий директор, помогаешь ОБЫЧНОМУ предпринимателю БЕЗ опыта в маркетинге и продажах. Эксперт здесь ТЫ, не он.

ОБРАЩЕНИЕ: обращайся к предпринимателю ТОЛЬКО на «Вы» (вежливо, уважительно). В узбекском — форма «Siz» и вежливые формы глаголов («hisoblang/yozing/qo'shing/yo'naltiring», не «hisobla/yoz»). Язык — грамотный и чистый, уровня C1 (образованный носитель), но простой и понятный, без жаргона.

СНАЧАЛА коротко и простым человеческим языком (3-5 предложений, без жаргона и англицизмов) разбери ситуацию вслух: что видишь в данных, где именно теряет клиентов и деньги, что мешает дойти до цели. Пиши живо, будто думаешь вслух и объясняешь другу — это увидит предприниматель.

ПОТОМ с новой строки выведи РОВНО маркер:
===PLAN===
и сразу после него — СТРОГО JSON плана задач, без markdown и без текста после:
{"marketing":[{"t":"крупная задача","d":"зачем простыми словами","deadline":"YYYY-MM-DD","steps":["конкретное действие 1","действие 2"]}],"sales":[{"t":"...","d":"...","deadline":"YYYY-MM-DD","steps":["..."]}]}

Правила плана: разделы marketing (привлечение клиентов) и sales (обработка, дозвон, доведение до покупки, средний чек). 2-3 крупные задачи на раздел, у каждой 2-4 конкретных под-шага — действия, понятные новичку («позвони…», «напиши…», «попроси менеджера…»). Простой язык, привязка к реальным проблемам из аудита. Задачи ведут от точки А к цели.

ДЕДЛАЙН (обязательное поле "deadline" у КАЖДОЙ задачи): реалистичная дата завершения в формате YYYY-MM-DD. Отсчитывай от СЕГОДНЯШНЕЙ даты (она дана в контексте). Срочные задачи «сделать сейчас» — 1-3 дня, средние — 5-10 дней, крупные — до 20 дней, но НЕ дальше конца текущего месяца (план месячный). Разноси сроки: не ставь всем задачам одну дату. Владелец сможет поправить срок вручную.

Если в контексте есть блок «ПРОВЕРЕННЫЕ ПОДХОДЫ ПОХОЖИХ БИЗНЕСОВ» — опирайся на этот реальный опыт (что уже сработало у других), адаптируя под ситуацию этого предпринимателя. Не копируй дословно — бери суть.
${lang === "uz" ? "Весь текст (и разбор, и план) — на ЖИВОМ, грамотном узбекском (латиница), как образованный НОСИТЕЛЬ языка, а НЕ дословный перевод с русского. Естественные узбекские слова и обороты, без русизмов и мешанины с русским. Просто и понятно. Кривой/машинный узбекский недопустим." : "Весь текст — ПО-РУССКИ."}`;

    const adjustLine = (adjust && String(adjust).trim())
      ? `\n\nПРАВКА ОТ ПРЕДПРИНИМАТЕЛЯ (обязательно учти): ${String(adjust).trim()}` : "";
    // сегодняшняя дата (Ташкент, UTC+5) — нужна, чтобы ИИ посчитал реальные дедлайны задач
    const todayTk = new Date(Date.now() + 5 * 3600000);
    const todayStr = todayTk.toISOString().slice(0, 10);
    const monthEnd = new Date(Date.UTC(todayTk.getUTCFullYear(), todayTk.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    const USER = `СЕГОДНЯ: ${todayStr} (конец текущего месяца: ${monthEnd}). Дедлайны задач считай от этой даты.\n\nАУДИТ БИЗНЕСА (точка А):\n${auditText}${kbBlock}\n\nЦЕЛЬ (точка Б): ${goal || "не указана, составь план на рост"}${adjustLine}\n\nРазбери ситуацию вслух, затем ===PLAN=== и JSON.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 2500, system: SYSTEM, messages: [{ role: "user", content: USER }], stream: true }),
    });
    if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "Anthropic error", detail: t }); return; }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inTok = 0, outTok = 0; // расход токенов за план
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "message_start" && evt.message && evt.message.usage) inTok = evt.message.usage.input_tokens || 0;
          if (evt.type === "message_delta" && evt.usage && evt.usage.output_tokens != null) outTok = evt.usage.output_tokens;
          if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") res.write(evt.delta.text);
        } catch (e) { /* неполные */ }
      }
    }
    res.write(`\n[[TOK:${inTok},${outTok}]]`); // маркер расхода токенов — фронт покажет мелко
    res.end();
  } catch (err) {
    try { res.status(500).json({ error: "plan-stream failed", detail: String(err) }); } catch (e) { res.end(); }
  }
}
