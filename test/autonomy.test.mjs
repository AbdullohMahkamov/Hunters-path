// Шаг 3 — детерминированный классификатор «рутина vs стратегия» + страховки (лимит N, kill switch, гонка, whitelist, отзыв).
import { resetMocks, kvSetJSON, kvGetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const A = await import("../api/autonomy.js");
const DAY = 86400000;
const ropTask = { recipient: "rop", topicKey: "rop_conversion" };
const mktTask = { recipient: "marketing", topicKey: "mkt_leads" };
// база: всё «зелёное» → авто. Точечные правки через override.
function ctx(over = {}) {
  return { autonomyEnabled: true, gapPct: 10, gapAbs: 20_000_000, funnelTrust: "verified", dataFresh: true, telephonySuspicious: false, whitelisted: true, todayAutoCount: 0, todayRopCount: 0, maxPerDay: 2, maxPerRopChat: 2, ...over };
}

beforeEach(() => resetMocks());

// ── ГРАНИЦЫ РАЗРЫВА ──
test("нижний порог: разрыв 4.9% < 5% → skip (задача не нужна), 5.0% → авто", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ gapPct: 4.9 })).decision, "skip");
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ gapPct: 5 })).decision, "auto");
});

test("верхняя граница %: 15% → авто, 15.1% → к владельцу", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ gapPct: 15 })).decision, "auto");
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ gapPct: 15.1 })).decision, "gated");
});

test("верхняя граница суммы: ровно 30M → авто, 30M+1 → к владельцу", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ gapAbs: 30_000_000 })).decision, "auto");
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ gapAbs: 30_000_001 })).decision, "gated");
});

test("нет чисел разрыва → к владельцу", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ gapPct: null })).decision, "gated");
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ gapAbs: null })).decision, "gated");
});

// ── ПОЛУЧАТЕЛЬ / ДАННЫЕ / WHITELIST ──
test("маркетинг всегда к владельцу (деньги/канал), даже при малом разрыве", () => {
  assert.equal(A.classifyTaskRisk(mktTask, ctx()).decision, "gated");
});

test("ненадёжные/устаревшие данные → к владельцу независимо от размера", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ funnelTrust: "suspicious" })).decision, "gated");
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ dataFresh: false })).decision, "gated");
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ telephonySuspicious: true })).decision, "gated");
});

test("тема не в whitelist (первый раз) → к владельцу", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ whitelisted: false })).decision, "gated");
});

// ── KILL SWITCH / ЛИМИТЫ ──
test("kill switch: автономия выключена → к владельцу даже для идеальной рутины", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ autonomyEnabled: false })).decision, "gated");
});

test("суточный лимит N=2 исчерпан → к владельцу", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ todayAutoCount: 2 })).decision, "gated");
});

test("лимит в чат РОПа исчерпан → к владельцу", () => {
  assert.equal(A.classifyTaskRisk(ropTask, ctx({ todayRopCount: 2 })).decision, "gated");
});

// ── WHITELIST: TTL 90 дней, scope по размеру интервенции ──
test("whitelist: touch → is=true; протух (>90 дней) → false", async () => {
  await A.touchWhitelist("rop_conversion", 8_000_000);
  assert.equal(await A.isWhitelisted("rop_conversion", 8_000_000), true);
  // вручную состариваем запись на 91 день
  const wl = kvGetJSON("planner:autowhitelist:hunter");
  wl["rop_conversion@le10m"].lastUsedAt = Date.now() - 91 * DAY;
  kvSetJSON("planner:autowhitelist:hunter", wl);
  assert.equal(await A.isWhitelisted("rop_conversion", 8_000_000), false);
});

test("whitelist scope: подтверждение малого размера НЕ распространяется на крупный band", async () => {
  await A.touchWhitelist("rop_conversion", 8_000_000);   // le10m
  assert.equal(await A.isWhitelisted("rop_conversion", 8_000_000), true);
  assert.equal(await A.isWhitelisted("rop_conversion", 25_000_000), false); // le30m — другой band
});

// ── ГОНКА: kill switch выключен МЕЖДУ классификацией и отправкой ──
test("гонка: задача классифицирована как auto, но автономию выключили ДО отправки → reassess = gated", async () => {
  await A.setAutonomyEnabled(true);
  const base = { gapPct: 10, gapAbs: 20_000_000, funnelTrust: "verified", dataFresh: true, telephonySuspicious: false, whitelisted: true };
  // до выключения — авто
  const before = await A.reassessBeforeDispatch(ropTask, base);
  assert.equal(before.decision, "auto");
  // владелец выключает автономию в этот момент
  await A.setAutonomyEnabled(false);
  const after = await A.reassessBeforeDispatch(ropTask, base);
  assert.equal(after.decision, "gated", "живой флаг перечитан перед отправкой — гонки нет");
});

test("гонка по лимиту: 2 задачи уже записаны сегодня → reassess = gated (перечитан живой счётчик)", async () => {
  await A.setAutonomyEnabled(true);
  const base = { gapPct: 10, gapAbs: 20_000_000, funnelTrust: "verified", dataFresh: true, telephonySuspicious: false, whitelisted: true };
  assert.equal((await A.reassessBeforeDispatch(ropTask, base)).decision, "auto");
  await A.recordAutonomous({ taskId: "a1", recipient: "rop", title: "T1" });
  await A.recordAutonomous({ taskId: "a2", recipient: "rop", title: "T2" });
  assert.equal((await A.reassessBeforeDispatch(ropTask, base)).decision, "gated");
});

// ── ЛОГ АВТОНОМНЫХ / ОТЗЫВ ──
test("recordAutonomous → count и getTodayAutonomous считают только не-отменённые", async () => {
  await A.recordAutonomous({ taskId: "a1", recipient: "rop", title: "T1" });
  await A.recordAutonomous({ taskId: "a2", recipient: "rop", title: "T2" });
  const c = await A.autonomousCountToday();
  assert.equal(c.total, 2);
  assert.equal(c.rop, 2);
  assert.equal((await A.getTodayAutonomous()).length, 2);
});

test("cancelAutonomousTask: убирает задачу из плана РОПа, помечает лог, отдаёт title для нейтрального уведомления", async () => {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [{ id: "a1", t: "Добить 3 тёплых лида до конца недели" }] }, done: { a1: false } });
  await A.recordAutonomous({ taskId: "a1", recipient: "rop", title: "Добить 3 тёплых лида до конца недели" });
  const r = await A.cancelAutonomousTask("a1");
  assert.equal(r.ok, true);
  assert.equal(r.recipient, "rop");
  assert.equal(r.title, "Добить 3 тёплых лида до конца недели");
  // задача убрана из плана
  const app = kvGetJSON("appdata:hunter");
  assert.equal(app.customPlan.sales.length, 0);
  // из сегодняшнего лога ушла (помечена cancelled)
  assert.equal((await A.getTodayAutonomous()).length, 0);
});

test("cancelAutonomousTask: неизвестный id → ok:false с человекочитаемой причиной", async () => {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  const r = await A.cancelAutonomousTask("nope");
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0);
});
