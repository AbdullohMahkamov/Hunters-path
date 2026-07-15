// /api/scene-activity.js — АКТИВНОСТЬ МОПов В CRM → состояние ПОЗЫ персонажа на сцене.
// Презентационный слой, ОТДЕЛЬНЫЙ от пузырей-фраз (scene-bubbles.js) — не смешивать.
//
// Состояние по «последнему действию в amoCRM» (ЛЮБОЙ тип: статус, звонок, заметка, задача…):
//   active  — < activeMin мин  → персонаж работает (idle-покачивание у стола)
//   away    — < awayMin мин    → короткая отлучка к кулеру/принтеру и обратно
//   quiet   — >= awayMin мин    → стоит без анимации (нейтральный простой, НЕ осуждающая поза)
//   idle    — вне рабочих часов → нейтральный простой без выводов (офис не работает)
//   unknown — данные неполны (труркация) → сцена НЕ меняет позу
//
// ⚠️ ЧЕСТНОСТЬ: это активность В CRM, а НЕ «работает ли человек». Звонок с личного телефона или
//    просмотр лида могут НЕ логироваться как событие — тогда покажет «тихо», хотя МОП занят.
//    Смягчено тем, что учитываем ЛЮБОЕ действие (статус/задача/заметка), не только звонки —
//    но оговорку не забыть при доработке. Свой trust-гейт: при труркации событий поза не меняется.
//
// ⚠️ БУДУЩАЯ ДОРАБОТКА (важно, зафиксировано по замечанию владельца 15.07.2026):
//    Если у МОПа звонки идут МИМО CRM (callsBypassSuspected, «Мои Звонки»/личный телефон) — он может
//    реально работать, но по CRM-событиям выглядеть «quiet» → поза «стоит без анимации» ЧИТАЕТСЯ как
//    «бездействует» на уровне ВИЗУАЛА, а не только метрики. Пример: Komiljon был quiet по CRM при
//    подтверждённой активности по личным звонкам. Сейчас это ОЖИДАЕМО (договорились строить позу
//    только на CRM-активности). НО когда появится НАДЁЖНЫЙ источник по личным звонкам (нормальная
//    интеграция телефонии/«Мои Звонки» в проде) — вернуться и решить, должен ли он тоже влиять на ПОЗУ
//    (а не только на пузыри-фразы scene-bubbles), чтобы не повторить ложное «бездействие» в визуале.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SUBDOMAIN = "huntercademy";
const MOPS = { 13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda", 13833590: "Begoyim", 13681582: "Abulbositxon" };
const CACHE_MIN = 5;
// ПОРОГИ — в Redis (sceneactivity:config), здесь дефолты. Не хардкод.
const DEFAULT_CFG = { activeMin: 5, awayMin: 60, workStartHour: 9, workEndHour: 19 };

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetTTL(key, v, ttlSec) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}?EX=${ttlSec}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); } catch (e) {} }
async function sessionRole(session) { if (!session) return null; try { const raw = await rget(`session:${encodeURIComponent(session)}`); return raw ? JSON.parse(raw).role : null; } catch (e) { return null; } }

async function build(cfg) {
  const token = process.env.AMOCRM_TOKEN;
  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  // окно = awayMin + запас: нужно лишь понять, было ли действие за последние awayMin минут
  const winMin = cfg.awayMin + 5;
  const from = Math.floor(Date.now() / 1000) - winMin * 60;
  const lastByUser = {};
  let truncated = false, page = 1;
  while (page <= 6) {
    let r;
    try { r = await fetch(`${base}/events?limit=100&page=${page}&order[created_at]=desc&filter[created_at][from]=${from}`, { headers: H }); }
    catch (e) { truncated = true; break; }
    if (r.status === 204) break;
    if (!r.ok) { truncated = true; break; }
    const d = await r.json();
    const events = (d._embedded && d._embedded.events) || [];
    for (const e of events) { const u = e.created_by; if ((e.created_at || 0) > (lastByUser[u] || 0)) lastByUser[u] = e.created_at; }
    if (events.length < 100) break;
    page++;
  }
  if (page > 6) truncated = true;

  // рабочие часы (Ташкент, UTC+5)
  const tkHour = new Date(Date.now() + 5 * 3600000).getUTCHours();
  const offHours = tkHour < cfg.workStartHour || tkHour >= cfg.workEndHour;
  const now = Math.floor(Date.now() / 1000);

  const items = Object.entries(MOPS).map(([uid, name]) => {
    if (truncated) return { name, state: "unknown", minAgo: null };           // trust-гейт: не меняем позу
    if (offHours) return { name, state: "idle", minAgo: null };               // офис не работает — без выводов
    const last = lastByUser[uid];
    const minAgo = last ? Math.round((now - last) / 60) : null;
    let state;
    if (minAgo != null && minAgo < cfg.activeMin) state = "active";
    else if (minAgo != null && minAgo < cfg.awayMin) state = "away";
    else state = "quiet";                                                     // нет действий за awayMin мин
    return { name, state, minAgo };
  });
  return { ok: true, at: Date.now(), truncated, offHours, cfg, items };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "state";
  const cfg = { ...DEFAULT_CFG, ...(await rgetJSON("sceneactivity:config", null) || {}) };

  if (action === "preview") { // админ: пересобрать и вернуть детали (для проверки)
    if ((await sessionRole(q.session || b.session)) !== "admin") { res.status(403).json({ error: "admin only" }); return; }
    res.status(200).json(await build(cfg)); return;
  }
  // state — кэш для сцены (5 мин)
  const cached = await rgetJSON("sceneactivity:hunter", null);
  if (cached && Date.now() - cached.at < CACHE_MIN * 60000) { res.status(200).json({ ok: true, cached: true, items: cached.items }); return; }
  const fresh = await build(cfg);
  await rsetTTL("sceneactivity:hunter", fresh, CACHE_MIN * 60);
  res.status(200).json({ ok: !!fresh.ok, items: fresh.items || [] });
}
