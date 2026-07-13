// /api/knowledge.js — КОЛЛЕКТИВНЫЙ РАЗУМ.
// Отчёты о решённых задачах (с положительным результатом) обезличиваются ИИ и складываются
// в ОБЩУЮ базу знаний `knowledge:solutions` (от всех клиентов). Потом эти проверенные подходы
// подмешиваются в генерацию плана/советов другим — если ниша и проблема совпадают.
// Ниша хранится per-org: `knowledge:niche:${org}` (поле у клиента).

export const config = { api: { bodyParser: { sizeLimit: "2mb" } } };

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const SOL_KEY = "knowledge:solutions";
const MAX_SOLUTIONS = 500;

async function rget(key) {
  try {
    const r = await fetch(`${URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const d = await r.json();
    return d && d.result != null ? d.result : null;
  } catch (e) { return null; }
}
async function rset(key, value) {
  try {
    await fetch(`${URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` }, body: typeof value === "string" ? value : JSON.stringify(value) });
  } catch (e) { /* ignore */ }
}
async function getSession(session) {
  if (!session) return null;
  try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

// Чтение общей базы решений и ниши org — экспортируем для plan-stream/audit-plan (ретривал).
export async function readSolutions() {
  try { const raw = await rget(SOL_KEY); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
}
export async function readNiche(org) {
  const v = await rget(`knowledge:niche:${org || "hunter"}`);
  return v ? String(v) : "";
}

// Подбор релевантных проверенных решений по нише + тегам проблем (теговый матчинг).
// problemHints — массив строк (названия проблем/ключевые слова из аудита).
export async function retrieveSolutions(org, problemHints, limit = 4) {
  const all = await readSolutions();
  if (!all.length) return [];
  const niche = (await readNiche(org)).toLowerCase();
  const hints = (problemHints || []).join(" ").toLowerCase();
  const scored = all.map((s) => {
    let score = 0;
    const sn = (s.niche || "").toLowerCase();
    if (niche && sn && (sn.includes(niche) || niche.includes(sn))) score += 3; // совпадение ниши
    for (const tag of (s.problemTags || [])) { if (hints && hints.includes(String(tag).toLowerCase())) score += 2; }
    // мягкое совпадение по словам подхода/проблемы
    const text = ((s.approach || "") + " " + (s.problem || "")).toLowerCase();
    for (const w of hints.split(/[^a-zа-яё0-9]+/i)) { if (w.length > 4 && text.includes(w)) score += 0.5; }
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.s);
}

async function anonymizeSolution(report, nicheHint) {
  if (!AKEY) return null;
  const SYSTEM = `Ты обрабатываешь отчёт предпринимателя о РЕШЁННОЙ бизнес-задаче для ОБЩЕЙ базы знаний, которой пользуются РАЗНЫЕ компании.

Твоя работа:
1) ОБЕЗЛИЧЬ: полностью убери названия компаний, имена людей (менеджеров/клиентов), конкретные суммы выручки и любые персональные/чувствительные данные. Оставь только переиспользуемую суть.
2) Извлеки переиспользуемый ПОДХОД (что конкретно сделали — по шагам, кратко), какую ПРОБЛЕМУ это решило, и КАЧЕСТВЕННЫЙ результат (без точных цифр — «дозвон вырос», «стали быстрее закрывать» и т.п.).
3) Проставь нишу и теги проблемы (короткие ключевые слова на русском: «дозвон», «мало лидов», «закрытие», «реклама», «средний чек», «отложенные» и т.п.).

Ответь СТРОГО JSON, без markdown:
{"niche":"...","problem":"кратко проблема","problemTags":["тег1","тег2"],"approach":"что сделали (обезличено)","outcome":"качественный результат"}`;
  const USER = `НИША БИЗНЕСА (подсказка, может быть пустой): ${nicheHint || "не указана — определи по контексту"}
ЗАДАЧА: ${report.taskTitle || ""}
РАЗДЕЛ: ${report.section || ""}
ЧТО СДЕЛАЛИ: ${report.whatDone || ""}
РЕЗУЛЬТАТ: ${report.result || ""}`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 700, system: SYSTEM, messages: [{ role: "user", content: USER }] }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    let text = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    return JSON.parse(text);
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!URL || !TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const action = (req.query && req.query.action) || (req.body && req.body.action);
  const sess = await getSession(session);
  if (!sess) { res.status(403).json({ error: "no session" }); return; }
  if (sess.role === "mop") { res.status(403).json({ error: "forbidden" }); return; }
  const org = sess.org || "hunter";

  try {
    // Ниша org (поле у клиента)
    if (action === "get_niche") { res.status(200).json({ ok: true, niche: await readNiche(org) }); return; }
    if (req.method === "POST" && action === "set_niche") {
      if (sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }
      await rset(`knowledge:niche:${org}`, String((req.body && req.body.niche) || "").trim());
      res.status(200).json({ ok: true, saved: true });
      return;
    }

    // Отчёт о закрытой задаче → в общую базу (только положительный результат)
    if (req.method === "POST" && action === "submit") {
      const b = req.body || {};
      if (!b.positive) { res.status(200).json({ ok: true, stored: false, reason: "not_positive" }); return; }
      const niche = await readNiche(org);
      const sol = await anonymizeSolution(b, niche);
      if (!sol || !(sol.approach)) { res.status(200).json({ ok: true, stored: false, reason: "extract_failed" }); return; }
      const entry = {
        id: "sol_" + Date.now() + "_" + Math.floor(Math.random() * 1e4),
        niche: sol.niche || niche || "",
        problem: sol.problem || "",
        problemTags: Array.isArray(sol.problemTags) ? sol.problemTags.slice(0, 6) : [],
        approach: sol.approach,
        outcome: sol.outcome || "",
        taskTitle: b.taskTitle || "",
        createdAt: new Date().toISOString(),
      };
      const all = await readSolutions();
      all.unshift(entry);
      await rset(SOL_KEY, all.slice(0, MAX_SOLUTIONS));
      res.status(200).json({ ok: true, stored: true });
      return;
    }

    // Просмотр базы (админ) — для отладки/курации
    if (action === "list") {
      if (sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }
      const all = await readSolutions();
      res.status(200).json({ ok: true, count: all.length, solutions: all.slice(0, 100) });
      return;
    }

    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err) });
  }
}
