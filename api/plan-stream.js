// /api/plan-stream.js — потоковая генерация плана: модель СНАЧАЛА вслух разбирает ситуацию
// (стримится по токенам, как в VSCode), ПОТОМ выдаёт маркер ===PLAN=== и строго JSON плана.
// Данные аудита — те же, что у /api/audit-plan. Стриминг — как у /api/chat.

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

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set" }); return; }

  try {
    const { goal, currentSales, lang, adjust } = req.body || {};
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

    const SYSTEM = `Ты — коммерческий директор, помогаешь ОБЫЧНОМУ предпринимателю БЕЗ опыта в маркетинге и продажах. Эксперт здесь ТЫ, не он.

СНАЧАЛА коротко и простым человеческим языком (3-5 предложений, без жаргона и англицизмов) разбери ситуацию вслух: что видишь в данных, где именно теряет клиентов и деньги, что мешает дойти до цели. Пиши живо, будто думаешь вслух и объясняешь другу — это увидит предприниматель.

ПОТОМ с новой строки выведи РОВНО маркер:
===PLAN===
и сразу после него — СТРОГО JSON плана задач, без markdown и без текста после:
{"marketing":[{"t":"крупная задача","d":"зачем простыми словами","steps":["конкретное действие 1","действие 2"]}],"sales":[{"t":"...","d":"...","steps":["..."]}]}

Правила плана: разделы marketing (привлечение клиентов) и sales (обработка, дозвон, доведение до покупки, средний чек). 2-3 крупные задачи на раздел, у каждой 2-4 конкретных под-шага — действия, понятные новичку («позвони…», «напиши…», «попроси менеджера…»). Простой язык, привязка к реальным проблемам из аудита. Задачи ведут от точки А к цели.
${lang === "uz" ? "Весь текст (и разбор, и план) — ПО-УЗБЕКСКИ (латиница)." : "Весь текст — ПО-РУССКИ."}`;

    const adjustLine = (adjust && String(adjust).trim())
      ? `\n\nПРАВКА ОТ ПРЕДПРИНИМАТЕЛЯ (обязательно учти): ${String(adjust).trim()}` : "";
    const USER = `АУДИТ БИЗНЕСА (точка А):\n${auditText}\n\nЦЕЛЬ (точка Б): ${goal || "не указана, составь план на рост"}${adjustLine}\n\nРазбери ситуацию вслух, затем ===PLAN=== и JSON.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 2500, system: SYSTEM, messages: [{ role: "user", content: USER }], stream: true }),
    });
    if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "Anthropic error", detail: t }); return; }

    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
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
          if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") res.write(evt.delta.text);
        } catch (e) { /* неполные */ }
      }
    }
    res.end();
  } catch (err) {
    try { res.status(500).json({ error: "plan-stream failed", detail: String(err) }); } catch (e) { res.end(); }
  }
}
