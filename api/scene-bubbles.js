// /api/scene-bubbles.js — ПРЕЗЕНТАЦИОННЫЙ слой сцены: короткая фактическая фраза для пузыря
// над каждым МОПом. Отдельный лёгкий вызов модели, НЕ смешивать с логикой агентов (Dev/Growth/Task/MOP).
//
// СТРОГО НА ФАКТАХ: модель формулирует фразу только из переданных данных, без домыслов о человеке
// (настроение/усталость/мотивация — запрещены). Data trust layer: если по МОПу звонковые данные
// suspicious/insufficient — call-факты НЕ используются (та же логика, что глушит MOP Agent).
//
// Источник — тот же кэш speed (sync-speed.js). Кэш фраз на CACHE_MIN минут (модель не дёргается на кадр).
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001"; // дёшево и быстро — фраза короткая
const ORG = "hunter";
const CACHE_MIN = 5;
// 5 активных МОПов (совпадают с реальными именами в метриках)
const MOPS = ["Komiljon", "Samandar", "Begoyim", "Abdulla-Legenda", "Abulbositxon"];

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v, ttlSec) { try { const u = ttlSec ? `${REDIS_URL}/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `${REDIS_URL}/set/${encodeURIComponent(key)}`; await fetch(u, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

async function callModel(system, user, maxTokens = 40) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

const SYSTEM = `Сформулируй ОДНУ короткую фразу для текстового пузыря персонажа в офисной сцене, СТРОГО основываясь на переданных фактах.
ЖЁСТКИЙ ЛИМИТ: НЕ БОЛЕЕ 6 СЛОВ. Это предел, превышать нельзя — пузырь физически не поместится на сцене. Короче — лучше.
НЕ добавляй ничего, чего нет в данных — никаких предположений о настроении, усталости, мотивации или личных качествах человека.
Если фактов мало или они нейтральны (просто идёт обычная работа) — верни нейтральную фразу про факт занятости, не выдумывай деталей.
Если в фактах есть находка «разговор был, статус не обновлён» — можно нейтрально указать на неё как на ФАКТ (не обвинение: не «забыл/схалтурил»).
Числа пиши ЦИФРАМИ (14, а не «четырнадцать»).
Верни ТОЛЬКО фразу — без кавычек, без пояснений, без имени. По-русски.
Примеры допустимого (≤6 слов): «16 лидов в работе», «статус не обновлён», «в работе».`;

// собрать факты по одному МОПу С УЧЁТОМ TRUST
function factsFor(name, speed) {
  const meta = speed.mopMeta || {};
  const notesOk = meta.notesComplete === true;         // расхождение статуса достоверно?
  const leadsOk = meta.leadsComplete !== false;        // лиды докачаны?
  const callsOk = meta.eventsComplete === true && meta.callsBypassSuspected !== true; // звонки достоверны?
  const day = (speed.mopsDay || []).find((m) => m.name === name) || null;
  let sm = 0, nc = 0;
  for (const i of (speed.mopIssues || [])) if (i.mop === name) { if (i.type === "status_mismatch") sm++; else if (i.type === "no_call") nc++; }

  const facts = { name, trust: { notesOk, leadsOk, callsOk } };
  if (leadsOk && day) facts.leadsInWork = day.leads;                 // лиды — проверенный факт
  if (notesOk && sm > 0) facts.statusMismatch = sm;                  // расхождение — проверенный факт
  if (callsOk && day) { facts.calledToday = day.calledLeads; facts.reachedToday = day.reached; } // звонки — только если verified
  if (callsOk && nc > 0) facts.noCall = nc;                          // no_call — только если звонки verified
  facts.callsExcluded = !callsOk;                                    // пометка: звонки исключены как недостоверные
  return facts;
}

// детерминированная фраза строго из фактов — фолбэк, если модель недоступна ИЛИ вышла за 6 слов
function factPhrase(f) {
  if (f.leadsInWork != null && f.statusMismatch != null) return `${f.leadsInWork} лидов, ${f.statusMismatch} без статуса`;
  if (f.leadsInWork != null) return `${f.leadsInWork} лидов в работе`;
  if (f.statusMismatch != null) return `${f.statusMismatch} лидов без статуса`;
  return "в работе";
}
function factsToPrompt(f) {
  const lines = [`Менеджер: ${f.name}.`];
  if (f.leadsInWork != null) lines.push(`Лидов в работе сегодня: ${f.leadsInWork}.`);
  if (f.statusMismatch != null) lines.push(`Открытых лидов, где разговор состоялся, но статус не обновлён: ${f.statusMismatch}.`);
  if (f.calledToday != null) lines.push(`Сегодня набирал лидов: ${f.calledToday}, из них дозвонился: ${f.reachedToday}.`);
  if (f.noCall != null) lines.push(`Лидов в работе без единого звонка: ${f.noCall}.`);
  if (f.callsExcluded) lines.push(`(Данные по звонкам по этому менеджеру сейчас недостоверны — НЕ используй факты про звонки.)`);
  if (lines.length === 1) lines.push(`Особых событий в данных нет — обычная работа.`);
  return lines.join("\n");
}

async function build(force) {
  const speed = await rgetJSON(ORG === "hunter" ? "speed" : `speed:${ORG}`, null);
  if (!speed) return { ok: false, error: "нет данных speed" };
  const out = [];
  for (const name of MOPS) {
    const f = factsFor(name, speed);
    let phrase = "";
    try { phrase = await callModel(SYSTEM, factsToPrompt(f), 40); }
    catch (e) { phrase = factPhrase(f); } // модель недоступна → детерминированный факт
    phrase = phrase.replace(/^["'«»]+|["'«».]+$/g, "").trim();
    // жёсткий лимит ≤6 слов: НЕ обрезаем (это ломает фразу), а заменяем на детерминированный факт
    if (phrase.split(/\s+/).filter(Boolean).length > 6 || phrase.length < 2) phrase = factPhrase(f);
    out.push({ name, facts: f, phrase });
  }
  await rsetJSON("scenebubbles:hunter", { at: Date.now(), items: out }, CACHE_MIN * 60);
  return { ok: true, at: Date.now(), items: out };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "state";
  const sess = await getSession(q.session || b.session);
  const isAdmin = !!sess && sess.role === "admin" && sess.org === "hunter";
  // ⛔ ВСЯ сцена-пузыри — только суперадмин (хардкод списка МОПов Hunter Academy). Иначе клиент увидел бы чужих сотрудников.
  if (!isAdmin) { res.status(403).json({ error: "superadmin only — привязано к Hunter Academy" }); return; }

  // preview — только админ: пересобрать и вернуть факты+фразы (для проверки, что модель держится в рамках)
  if (action === "preview") {
    if (!isAdmin) { res.status(403).json({ error: "admin only" }); return; }
    if (!AKEY) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set" }); return; }
    res.status(200).json(await build(true));
    return;
  }
  // state — кэш для сцены (если протух — пересобрать)
  const cached = await rgetJSON("scenebubbles:hunter", null);
  if (cached && Date.now() - cached.at < CACHE_MIN * 60000) {
    res.status(200).json({ ok: true, cached: true, items: cached.items.map((x) => ({ name: x.name, phrase: x.phrase })) });
    return;
  }
  if (!AKEY) { res.status(200).json({ ok: true, items: [] }); return; }
  const fresh = await build(false);
  res.status(200).json({ ok: !!fresh.ok, items: (fresh.items || []).map((x) => ({ name: x.name, phrase: x.phrase })) });
}
