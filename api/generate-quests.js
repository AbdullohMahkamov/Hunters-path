// /api/generate-quests.js — Крестодатель генерирует ДОП-квесты из текущих проблем.
// Получает: топ проблем + дисциплину из кэша, полный список 24 основных квестов и уже принятых доп-квестов.
// Правило: предлагать ТОЛЬКО то, чего нет среди существующих (не дублировать).

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
    const { existingQuests, acceptedExtra, goal } = req.body || {};
    const GOAL = (goal && goal > 0) ? goal : 250000000;
    const goalShort = GOAL >= 1000000 ? Math.round(GOAL / 1000000) + "М" : String(GOAL);

    // Живые данные: проблемы + дисциплина
    const dash = await readCache("dashboard");
    const speed = await readCache("speed");

    let problemsText = "Нет данных о проблемах (кэш пуст).";
    if (dash && dash.problems && dash.problems.length) {
      problemsText = dash.problems.map(p => `- ${p.name}: ${p.count} потерь`).join("\n");
    }
    let disciplineText = "";
    if (speed && speed.mops && speed.mops.length) {
      disciplineText = "\nДисциплина МОПов:\n" + speed.mops.map(m =>
        `- ${m.name}: 1-й звонок ${m.medianFirstCallMin ?? "?"} мин, звонков/лид ${m.avgCallsPerLead}, закрыл рано ${m.earlyClosePct}%, задачи ${m.taskRate}%`
      ).join("\n");
    }
    let kpiText = "";
    if (dash && dash.totals) {
      const t = dash.totals;
      const gp = GOAL > 0 ? Math.round((t.revenue || 0) / GOAL * 100) : 0;
      kpiText = `\nKPI: продаж ${t.sold}, конверсия ${t.conv}%, путь к ${goalShort} ${gp}%, потеря до контакта ${t.noContactPct}%.`;
    }

    const existingList = (existingQuests || []).map(q => `[${q.id}] ${q.t}`).join("\n");
    const acceptedList = (acceptedExtra || []).map(q => `- ${q.t}`).join("\n") || "(пока нет)";

    const SYSTEM = `Ты — «Крестодатель», коммерческий директор Hunter Academy. Твоя задача — предложить 3-4 НОВЫХ доп-квеста на основе РЕАЛЬНЫХ текущих проблем из amoCRM.

ЖЁСТКОЕ ПРАВИЛО: НЕ предлагай квесты, которые уже есть в списке основных 24 квестов или среди принятых доп-квестов. Если проблема уже закрывается существующим квестом — пропусти её. Предлагай ТОЛЬКО реально новые, незакрытые дыры.

Каждый квест — конкретный, выполнимый, с измеримым результатом. Не теория. Привязан к конкретной проблеме из данных.

Отвечай СТРОГО в формате JSON-массива, без markdown, без пояснений:
[{"t":"Краткое название квеста","d":"Что конкретно сделать, 1-2 предложения","problem":"какую проблему закрывает"}]
Если новых квестов нет (всё уже покрыто) — верни пустой массив [].`;

    const USER = `ТЕКУЩИЕ ПРОБЛЕМЫ (из amoCRM):
${problemsText}
${disciplineText}
${kpiText}

ОСНОВНЫЕ 24 КВЕСТА (НЕ дублировать):
${existingList}

УЖЕ ПРИНЯТЫЕ ДОП-КВЕСТЫ (НЕ дублировать):
${acceptedList}

Предложи 3-4 новых доп-квеста под главные текущие проблемы. Только то, чего ещё нет. Формат — чистый JSON-массив.`;

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: USER }],
      }),
    });

    if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "Anthropic error", detail: t }); return; }
    const data = await r.json();
    let text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
    // вычистить возможные ```json
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();

    let quests = [];
    try { quests = JSON.parse(text); } catch (e) {
      res.status(200).json({ ok: true, quests: [], raw: text, parseError: true });
      return;
    }
    if (!Array.isArray(quests)) quests = [];
    res.status(200).json({ ok: true, quests });
  } catch (err) {
    res.status(500).json({ error: "generate failed", detail: String(err) });
  }
}
