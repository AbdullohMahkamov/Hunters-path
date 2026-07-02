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
    const { goal, currentSales, lang } = req.body || {};

    // Живой аудит: проблемы + дисциплина + KPI (проблемы считаются за ~4 месяца в sync.js)
    const dash = await readCache("dashboard");
    const speed = await readCache("speed");

    let auditText = "";
    auditText += "ПЕРИОД АУДИТА: данные о проблемах и потерях — за последние 3-4 месяца (не только текущий месяц), чтобы картина была полной.\n\n";
    if (currentSales) {
      auditText += `ТЕКУЩИЕ ПРОДАЖИ (со слов предпринимателя): ${currentSales}\n`;
    }
    if (dash && dash.totals) {
      const t = dash.totals;
      if (t.soldPeriod != null) {
        auditText += `Продаж за 3-4 месяца: ${t.soldPeriod}, выручка за период ${t.revenuePeriod}. В этом месяце: ${t.sold} продаж.\n`;
      } else {
        auditText += `Продаж в этом месяце: ${t.sold}, выручка ${t.revenue}.\n`;
      }
      auditText += `Конверсия ${t.conv}%, средний чек ${t.avgCheck}, потеря до контакта ${t.noContactPct}%.\n`;
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

    const SYSTEM = `Ты — коммерческий директор. По данным аудита бизнеса (точка А), текущим продажам и цели предпринимателя (точка Б) составь КОНКРЕТНЫЙ план роста.

Раздели задачи на 2 раздела:
- "marketing" — привлечение лидов, реклама, контент, трафик
- "sales" — обработка лидов, дозвон, квалификация, закрытие, работа с отложенными, средний чек

Структура: каждая задача — это КРУПНАЯ задача с 2-4 конкретными под-шагами. Крупных задач 2-3 на раздел. Привязывай к реальным проблемам из аудита. Под-шаги — маленькие, выполнимые за день-два.

Отвечай СТРОГО в формате JSON, без markdown:
{"marketing":[{"t":"крупная задача","d":"зачем это, 1 предложение","steps":["под-шаг 1","под-шаг 2"]}],"sales":[{"t":"...","d":"...","steps":["..."]}]}
${lang === "uz" ? "Пиши ПО-УЗБЕКСКИ (латиница)." : "Пиши ПО-РУССКИ."}`;

    const USER = `АУДИТ БИЗНЕСА (точка А):\n${auditText}\n\nЦЕЛЬ — куда хочет дойти (точка Б): ${goal || "не указана, составь план на рост"}\n\nСоставь план задач с под-шагами (JSON). Задачи должны вести от точки А к точке Б.`;

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
