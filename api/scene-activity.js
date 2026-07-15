// /api/scene-activity.js — АКТИВНОСТЬ МОПов В CRM → состояние ПОЗЫ + ЖУРНАЛ входа/выхода из состояний.
// Презентационный слой, ОТДЕЛЬНЫЙ от пузырей-фраз (scene-bubbles.js) — не смешивать.
//
// Каждый item несёт ДВА поля (по «последнему действию в amoCRM», ЛЮБОЙ тип события):
//   pose  — ЧТО ДЕЛАЕТ ПЕРСОНАЖ В СЦЕНЕ:
//           active(<activeMin)=покачивание · inactive(activeMin..absentMin)=«zzz» у стола ·
//           leave(>=absentMin ИЛИ нет активности ИЛИ ночь)=выход за дверь · unknown(труркация)=«?» у стола
//   state — ЧТО ПИШЕТСЯ В ЖУРНАЛ (запись для реальных выводов о людях):
//           active/inactive/absent/offHours(ночь≠прогул)/unknown(нет данных)
//
// ══════════════════════════════════════════════════════════════════════════════════════════════
// ⚠️ РАЗВЕДЕНИЕ ПОЗЫ И ЖУРНАЛА (решение владельца 15.07 — поверх прежнего жёсткого условия):
//   • ПОЗА: персонаж ВЫХОДИТ из комнаты после absentMin ВСЕГДА. callsBypassSuspected на позу НЕ влияет
//     (владелец выбрал «выход всегда, игнор bypass» — чтобы сцена ночью пустела, а не стояла).
//   • ЖУРНАЛ: жёсткое условие СОХРАНЕНО. Пока callsBypassSuspected === true (звонки идут мимо CRM через
//     личный телефон — Komiljon и др.), в ЗАПИСИ период = "unknown"/noData:true reason:"bypass" =
//     «нет данных», НЕ «отсутствие». Причина прежняя: не документировать реально работающих как прогул.
//     Ночь пишется как "offHours" (не absent), чтобы дневной отчёт не считал нерабочее время отсутствием.
//   ПРИМЕЧАНИЕ: callsBypassSuspected — ГЛОБАЛЬНЫЙ сигнал телефонии (не per-MOP). См. [[data-completeness-passport]].
//   ⚠️ Если владелец захочет, чтобы и ЖУРНАЛ писал прямое "absent" при bypass — заменить ветку
//     `if (bypass) ... state:"unknown"` на state:"absent". Это перевернёт прежнее жёсткое условие ОСОЗНАННО.
// ══════════════════════════════════════════════════════════════════════════════════════════════
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SUBDOMAIN = "huntercademy";
const MOPS = { 13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda", 13833590: "Begoyim", 13681582: "Abulbositxon" };
const CACHE_MIN = 5;
const JOURNAL_CAP = 800;
// ПОРОГИ — в Redis (sceneactivity:config), здесь дефолты.
const DEFAULT_CFG = { activeMin: 5, absentMin: 30, workStartHour: 9, workEndHour: 19 };

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rset(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); } catch (e) {} }
async function rsetTTL(key, v, ttlSec) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}?EX=${ttlSec}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); } catch (e) {} }
async function sessionRole(session) { if (!session) return null; try { const raw = await rget(`session:${encodeURIComponent(session)}`); return raw ? JSON.parse(raw).role : null; } catch (e) { return null; } }

async function build(cfg, opts) {
  const forceOnHours = !!(opts && opts.forceOnHours); // админ-диагностика: пропустить off-hours, чтобы увидеть гейт absent/bypass в нерабочее время (журнал НЕ пишем)
  const token = process.env.AMOCRM_TOKEN;
  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;

  // ── ЖЁСТКОЕ УСЛОВИЕ: читаем callsBypassSuspected из кэша speed (тот же сигнал, что глушит no_call) ──
  const speed = await rgetJSON("speed", null);
  const bypass = !!(speed && ((speed.mopMeta && speed.mopMeta.callsBypassSuspected) || (speed.telephony && speed.telephony.callsBypassSuspected)));

  // события за окно (absentMin + запас) — нужно понять, было ли действие за последние absentMin минут
  const winMin = cfg.absentMin + 5;
  const from = Math.floor(Date.now() / 1000) - winMin * 60;
  const lastByUser = {};
  const lastEventByUser = {}; // диагностика: детали последнего события {type, entity_type, entity_id, created_at}
  let truncated = false, page = 1;
  while (page <= 6) {
    let r;
    try { r = await fetch(`${base}/events?limit=100&page=${page}&order[created_at]=desc&filter[created_at][from]=${from}`, { headers: H }); }
    catch (e) { truncated = true; break; }
    if (r.status === 204) break;
    if (!r.ok) { truncated = true; break; }
    const d = await r.json();
    const events = (d._embedded && d._embedded.events) || [];
    for (const e of events) {
      const u = e.created_by;
      if ((e.created_at || 0) > (lastByUser[u] || 0)) {
        lastByUser[u] = e.created_at;
        lastEventByUser[u] = { type: e.type, entity_type: e.entity_type, entity_id: e.entity_id, created_at: e.created_at };
      }
    }
    if (events.length < 100) break;
    page++;
  }
  if (page > 6) truncated = true;

  const tkHour = new Date(Date.now() + 5 * 3600000).getUTCHours();
  const offHours = !forceOnHours && (tkHour < cfg.workStartHour || tkHour >= cfg.workEndHour);
  const now = Math.floor(Date.now() / 1000);

  // pose = что делает персонаж в СЦЕНЕ; state = что пишется в ЖУРНАЛ (запись для реальных выводов).
  // Решение владельца (15.07): ПОЗА выходит из комнаты после absentMin ВСЕГДА — bypass позу НЕ трогает.
  // ЖУРНАЛ: жёсткое условие СОХРАНЕНО — при bypass период = "unknown"/нет данных, НЕ "отсутствие".
  const items = Object.entries(MOPS).map(([uid, name]) => {
    if (truncated) return { name, pose: "unknown", state: "unknown", minAgo: null, noData: true, reason: "truncation" }; // не видим — не выгоняем, «?» у стола
    const last = lastByUser[uid];
    const minAgo = last ? Math.round((now - last) / 60) : null;
    if (minAgo != null && minAgo < cfg.activeMin) return { name, pose: "active", state: "active", minAgo, noData: false };
    if (minAgo != null && minAgo < cfg.absentMin) return { name, pose: "inactive", state: "inactive", minAgo, noData: false };
    // >= absentMin (или активности нет вовсе) → персонаж ВЫХОДИТ (pose:leave), bypass позу не трогает.
    if (offHours) return { name, pose: "leave", state: "offHours", minAgo, noData: false };                 // журнал: ночь ≠ прогул
    if (bypass)   return { name, pose: "leave", state: "unknown", minAgo, noData: true, reason: "bypass" };  // журнал: «нет данных», НЕ отсутствие
    return { name, pose: "leave", state: "absent", minAgo, noData: false };
  });

  // диагностика последнего события по каждому МОПу (только в preview — см. handler; в state не отдаём)
  const lastEvents = {};
  for (const [uid, name] of Object.entries(MOPS)) lastEvents[name] = lastEventByUser[uid] || null;

  return { ok: true, at: Date.now(), truncated, offHours, bypassSuspected: bypass, cfg, items, lastEvents };
}

// ── ЖУРНАЛ: фиксируем момент ВХОДА в новое состояние (для отчёта «кто когда активен/отсутствовал») ──
async function updateJournal(items) {
  const lastMap = await rgetJSON("sceneactivity:last", {});
  const now = Date.now();
  const entries = [];
  for (const it of items) {
    const prev = lastMap[it.name];
    if (prev !== it.state) {
      entries.push({ mop: it.name, state: it.state, at: now, noData: !!it.noData, reason: it.reason || null });
      lastMap[it.name] = it.state;
    }
  }
  if (entries.length) {
    const log = await rgetJSON("sceneactivity:journal", []);
    await rset("sceneactivity:journal", log.concat(entries).slice(-JOURNAL_CAP));
    await rset("sceneactivity:last", lastMap);
  }
  return entries.length;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "state";
  const cfg = { ...DEFAULT_CFG, ...(await rgetJSON("sceneactivity:config", null) || {}) };

  // журнал за день (админ) — для отчёта
  if (action === "journal") {
    if ((await sessionRole(q.session || b.session)) !== "admin") { res.status(403).json({ error: "admin only" }); return; }
    const log = await rgetJSON("sceneactivity:journal", []);
    res.status(200).json({ ok: true, journal: log, note: "noData:true reason:bypass — период «нет данных» (звонки мимо CRM), НЕ отсутствие" });
    return;
  }
  if (action === "preview") { // админ: пересобрать + зафиксировать журнал + вернуть детали
    if ((await sessionRole(q.session || b.session)) !== "admin") { res.status(403).json({ error: "admin only" }); return; }
    const force = q.force === "1" || b.force === "1"; // read-only диагностика: игнорировать off-hours, журнал НЕ трогать
    const r = await build(cfg, { forceOnHours: force });
    if (!force) await updateJournal(r.items);
    else r.probe = "forceOnHours: off-hours пропущен для проверки гейта; журнал НЕ записан";
    res.status(200).json(r); return;
  }
  // state — кэш для сцены (5 мин). Журнал обновляется при каждой пересборке.
  const cached = await rgetJSON("sceneactivity:hunter", null);
  if (cached && Date.now() - cached.at < CACHE_MIN * 60000) { res.status(200).json({ ok: true, cached: true, items: cached.items }); return; }
  const fresh = await build(cfg);
  await updateJournal(fresh.items);
  await rsetTTL("sceneactivity:hunter", fresh, CACHE_MIN * 60);
  res.status(200).json({ ok: !!fresh.ok, items: fresh.items || [] });
}
