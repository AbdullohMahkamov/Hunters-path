// /api/audit-plan.js — по данным аудита (проблемы из CRM) + цели генерирует КАСТОМНЫЙ план задач.
// Задачи делятся на разделы marketing/sales. Возвращается один раз и фиксируется на фронте.

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
    const { goal, lang } = req.body || {};

    // Живой аудит: проблемы + дисциплина + KPI
    const dash = await readCache("dashboard");
    const speed = await readCache("speed");

    let auditText = "";
    if (dash && dash.totals) {
      const t = dash.totals;
      auditText += `Продаж за месяц: ${t.sold}, выручка ${t.revenue}, конверсия ${t.conv}%, средний чек ${t.avgCheck}, потеря до контакта ${t.noContactPct}%.\n`;
    }
    if (dash && dash.problems && dash.problems.length) {
      auditText += "Главные причины потерь:\n" + dash.problems.map(p => `- ${p.name}: ${p.count}`).join("\n") + "\n";
    }
    if (speed && speed.mops && speed.mops.length) {
      auditText += "Дисциплина менеджеров:\n" + speed.mops.map(m =>
        `- ${m.name}: 1-й звонок ${m.medianFirstCallMin ?? "?"}мин, звонков/лид ${m.avgCallsPerLead}, закрыл рано ${m.earlyClosePct}%, задачи ${m.taskRate}%`
      ).join("\n");
    }
    if (!auditText) auditText = "Данных мало. Составь общий план роста продаж.";

    const SYSTEM = `Ты — коммерческий директор. По данным аудита бизнеса и цели предпринимателя составь КОНКРЕТНЫЙ план задач для роста продаж.

Раздели задачи на 2 раздела:
- "marketing" — привлечение лидов, реклама, контент, трафик
- "sales" — обработка лидов, дозвон, квалификация, закрытие, работа с отложенными, средний чек

Каждая задача — конкретная, выполнимая, с измеримым результатом. 3-5 задач на раздел. Привязывай к реальным проблемам из аудита.

Отвечай СТРОГО в формате JSON, без markdown:
{"marketing":[{"t":"название","d":"что сделать, 1-2 предложения"}],"sales":[{"t":"название","d":"..."}]}
${lang === "uz" ? "Задачи пиши ПО-УЗБЕКСКИ (латиница)." : "Задачи пиши ПО-РУССКИ."}`;

    const USER = `АУДИТ БИЗНЕСА:\n${auditText}\n\nЦЕЛЬ ПРЕДПРИНИМАТЕЛЯ: ${goal || "не указана, составь план на рост"}\n\nСоставь план задач (JSON).`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: SYSTEM,
        messages: [{ role: "user", content: USER }],
      }),
    });

    if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "Anthropic error", detail: t }); return; }
    const data = await r.json();
    let text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();

    let plan = { marketing: [], sales: [] };
    try { plan = JSON.parse(text); } catch (e) {
      res.status(200).json({ ok: true, plan: { marketing: [], sales: [] }, raw: text, parseError: true });
      return;
    }
    res.status(200).json({ ok: true, plan });
  } catch (err) {
    res.status(500).json({ error: "audit-plan failed", detail: String(err) });
  }
}
