// /api/finance-analyze.js — ИИ-анализ финансов месяца. Смотрит финансы (из Sheets, переданы клиентом)
// + живые продажи из CRM (кэш dashboard), даёт разбор и рекомендации по оптимизации.

async function readDashboardCache() {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return typeof d.result === "string" ? JSON.parse(d.result) : d.result;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set" }); return; }

  try {
    const { fin, lang } = req.body || {};
    if (!fin) { res.status(400).json({ error: "no finance data" }); return; }

    // финансовый блок
    const fmt = n => n == null ? "нет данных" : new Intl.NumberFormat("ru-RU").format(Math.round(n));
    let finText = `Месяц: ${fin.month || "?"}\n`;
    finText += `Выручка: ${fmt(fin.revenue)}\n`;
    finText += `Общие расходы: ${fmt(fin.expenses)}\n`;
    finText += `Чистая прибыль (до долей): ${fmt(fin.profit)}\n`;
    if (fin.margin != null) finText += `Рентабельность: ${fin.margin}%\n`;
    if (fin.tax != null) finText += `Налог: ${fmt(fin.tax)}\n`;
    if (fin.profitAfterShares != null) finText += `Остаток после долей: ${fmt(fin.profitAfterShares)}\n`;
    if (Array.isArray(fin.breakdown) && fin.breakdown.length) {
      finText += "\nРасходы по статьям:\n" + fin.breakdown.map(b => `- ${b.name}: ${fmt(b.amount)}`).join("\n");
    }

    // продажи из CRM
    let salesText = "";
    const cache = await readDashboardCache();
    if (cache && cache.totals) {
      const t = cache.totals;
      salesText = `\n\nДанные продаж из CRM (этот месяц):\n- Продаж: ${t.sold}, выручка ${fmt(t.revenue)}\n- Конверсия: ${t.conv}%, средний чек ${fmt(t.avgCheck)}\n- Потеря лидов до контакта: ${t.noContactPct}%`;
    }

    const SYSTEM = `Ты — финансовый директор школы продаж. Проанализируй финансы месяца и дай ЧЁТКИЙ практичный разбор для владельца.

Структура ответа (используй markdown, коротко и по делу):
## Общая оценка
1-2 предложения: прибыльный/убыточный месяц, здоровая ли ситуация.

## Куда уходят деньги
Назови 2-3 самые крупные статьи расходов и их долю. Что раздуто.

## Где оптимизировать
2-3 КОНКРЕТНЫХ действия: что урезать, где тратится неэффективно. С опорой на связь расходов и продаж (окупается ли реклама и т.д.).

## Вывод
1 главная рекомендация на следующий месяц.

Пиши прямо, цифрами, без воды. ${lang === "uz" ? "Отвечай ПО-УЗБЕКСКИ (латиница)." : "Отвечай ПО-РУССКИ."}`;

    const USER = `ФИНАНСЫ:\n${finText}${salesText}\n\nСделай разбор и дай рекомендации по оптимизации.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        system: SYSTEM,
        messages: [{ role: "user", content: USER }],
      }),
    });
    if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "Anthropic error", detail: t }); return; }
    const data = await r.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    res.status(200).json({ ok: true, analysis: text });
  } catch (err) {
    res.status(500).json({ error: "analyze failed", detail: String(err) });
  }
}
