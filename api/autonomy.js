// api/autonomy.js — ДЕТЕРМИНИРОВАННЫЙ классификатор «рутина vs стратегия» для поэтапного снятия гейта (Шаг 3).
// Числа/правила в коде (ROUTINE), как THRESHOLDS в diagnostic.js. LLM НЕ решает рутинность — только формулирует текст.
// Классификатор работает на числах/флагах ДО формулировки. По умолчанию автономия ВЫКЛЮЧЕНА (kill switch).

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORG = "hunter";
const DAY = 86400000;

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }

// ── ПОРОГИ (утверждены владельцем; выведены из реального шума прогноза ±10%) ──
export const ROUTINE = {
  gapPctMin: 5,             // < 5% цели → задача НЕ создаётся вообще (шум, темп закроет сам)
  gapPctMax: 15,            // 5–15% И
  gapAbsMax: 30_000_000,    // ≤ 30M сум (~9 продаж) → авто-кандидат; крупнее → к владельцу
  whitelistTtlDays: 90,     // тема протухает после 90 дней бездействия
};
const AUTONOMY_DEFAULT = { enabled: false, maxPerDay: 2, maxPerRopChat: 2 }; // старт: автономия ВЫКЛ
const K = { autonomy: `planner:autonomy:${ORG}`, whitelist: `planner:autowhitelist:${ORG}`, log: (day) => `planner:autonomous:${ORG}:${day}`, appdata: `appdata:${ORG}` };

export function tkDay() { return new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10); }

// ── Kill switch / конфиг автономии ──
export async function getAutonomy() { return { ...AUTONOMY_DEFAULT, ...((await rgetJSON(K.autonomy, {})) || {}) }; }
export async function setAutonomyEnabled(on) { const c = await getAutonomy(); c.enabled = !!on; c.changedAt = Date.now(); await rsetJSON(K.autonomy, c); return c; }

// ── gapBand: доверие привязано к РАЗМЕРУ интервенции, не к цели ──
export function gapBand(gapUZS) { if (gapUZS <= 10_000_000) return "le10m"; if (gapUZS <= 20_000_000) return "le20m"; if (gapUZS <= 30_000_000) return "le30m"; return "big"; }
export function whitelistKey(topicKey, gapUZS) { return `${topicKey}@${gapBand(gapUZS)}`; }
export async function isWhitelisted(topicKey, gapUZS) { const wl = (await rgetJSON(K.whitelist, {})) || {}; const e = wl[whitelistKey(topicKey, gapUZS)]; return !!(e && e.lastUsedAt && (Date.now() - e.lastUsedAt) < ROUTINE.whitelistTtlDays * DAY); }
export async function touchWhitelist(topicKey, gapUZS) { const wl = (await rgetJSON(K.whitelist, {})) || {}; wl[whitelistKey(topicKey, gapUZS)] = { lastUsedAt: Date.now() }; await rsetJSON(K.whitelist, wl); }
export async function removeWhitelist(topicKey, gapUZS) { const wl = (await rgetJSON(K.whitelist, {})) || {}; delete wl[whitelistKey(topicKey, gapUZS)]; await rsetJSON(K.whitelist, wl); }

// ── КЛАССИФИКАТОР (чистая функция: числа/флаги в ctx, без Redis и без LLM) → "auto" | "gated" ──
// ctx: { autonomyEnabled, gapPct, gapAbs, funnelTrust, dataFresh, telephonySuspicious, whitelisted, todayAutoCount, todayRopCount, maxPerDay, maxPerRopChat }
export function classifyTaskRisk(task, ctx) {
  if (ctx.gapPct == null || ctx.gapAbs == null) return { decision: "gated", reason: "нет чисел разрыва — к владельцу" };
  if (ctx.gapPct < ROUTINE.gapPctMin) return { decision: "skip", reason: `разрыв ${ctx.gapPct}% < ${ROUTINE.gapPctMin}% — в пределах шума, задача не нужна` };
  if (!ctx.autonomyEnabled) return { decision: "gated", reason: "автономия выключена (kill switch)" };
  if (task.recipient !== "rop") return { decision: "gated", reason: "маркетинг — всегда к владельцу (деньги/канал)" };
  if (ctx.gapPct > ROUTINE.gapPctMax || ctx.gapAbs > ROUTINE.gapAbsMax) return { decision: "gated", reason: `крупный разрыв (${ctx.gapPct}% / ${ctx.gapAbs} сум) — стратегия` };
  if (ctx.funnelTrust !== "verified" || ctx.dataFresh !== true || ctx.telephonySuspicious === true) return { decision: "gated", reason: "данные ненадёжны/устарели — к владельцу независимо от размера" };
  if (!ctx.whitelisted) return { decision: "gated", reason: "тема ещё не подтверждалась владельцем (первый раз — к нему)" };
  if ((ctx.todayAutoCount || 0) >= (ctx.maxPerDay ?? AUTONOMY_DEFAULT.maxPerDay)) return { decision: "gated", reason: "суточный лимит авто-задач исчерпан" };
  if (task.recipient === "rop" && (ctx.todayRopCount || 0) >= (ctx.maxPerRopChat ?? AUTONOMY_DEFAULT.maxPerRopChat)) return { decision: "gated", reason: "лимит авто-задач в чат РОПа исчерпан" };
  return { decision: "auto", reason: "рутина: малый разрыв, in-process, verified, тема проверена, лимит не исчерпан" };
}

// ПОВТОРНАЯ проверка ПЕРЕД самой отправкой — читает ЖИВОЙ флаг (закрывает гонку kill switch↔отправка)
export async function reassessBeforeDispatch(task, baseCtx) {
  const live = await getAutonomy();
  const cnt = await autonomousCountToday();
  return classifyTaskRisk(task, { ...baseCtx, autonomyEnabled: live.enabled, maxPerDay: live.maxPerDay, maxPerRopChat: live.maxPerRopChat, todayAutoCount: cnt.total, todayRopCount: cnt.rop });
}

// ── Лимиты/лог автономных задач за сутки ──
export async function autonomousCountToday() { const log = (await rgetJSON(K.log(tkDay()), [])) || []; const live = log.filter((x) => !x.cancelled); return { total: live.length, rop: live.filter((x) => x.recipient === "rop").length, log }; }
export async function recordAutonomous(rec) { const day = tkDay(); const log = (await rgetJSON(K.log(day), [])) || []; log.push({ ...rec, at: Date.now(), cancelled: false }); await rsetJSON(K.log(day), log.slice(-50)); return rec; }
export async function getTodayAutonomous() { return ((await rgetJSON(K.log(tkDay()), [])) || []).filter((x) => !x.cancelled); }

// ── ОТЗЫВ автономной задачи (владелец нажал «Отозвать») ──
// Убирает задачу из плана РОПа (auto — только rop), помечает лог. Возвращает данные для нейтрального уведомления исполнителя.
export async function cancelAutonomousTask(taskId) {
  const app = (await rgetJSON(K.appdata, {})) || {};
  const sales = (app.customPlan && app.customPlan.sales) || [];
  const t = sales.find((x) => x.id === taskId);
  if (!t) return { ok: false, error: "задача не найдена (возможно, уже закрыта)" };
  app.customPlan.sales = sales.filter((x) => x.id !== taskId);
  if (app.done) delete app.done[taskId];
  await rsetJSON(K.appdata, app);
  // помечаем в логе автономных
  const day = tkDay(); const log = (await rgetJSON(K.log(day), [])) || [];
  for (const x of log) if (x.taskId === taskId) x.cancelled = true;
  await rsetJSON(K.log(day), log);
  return { ok: true, title: t.t, recipient: "rop" };
}
