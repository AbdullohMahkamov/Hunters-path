// ownerDecision в очередь решений: недостижимая часть цели — РЕШЕНИЕ владельца (не задача людям).
// Всплывает в секции «Ждёт решения» отчёта по команде + кнопки «Снизить цель до Y» / «Оставить».
import { resetMocks, kvSetJSON, kvGetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const planner = await import("../api/planner.js");
const reports = await import("../api/reports.js");

beforeEach(() => resetMocks());

// «Полный» ownerDecision: вся цель вне возможностей команды → planner:active.ownerDecisionOnly, без pending-плана.
function seedFullOD() {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", []);
  kvSetJSON("planner:active:hunter", { periodKey: "август 2026", ownerDecisionOnly: true, facts: { ownerDecision: { unreachableUZS: 140000000, feasibleGoalUZS: 60000000, addManagers: 2 } } });
}

test("отчёт: полный ownerDecision → строка «вне возможностей команды» + кнопки снизить/оставить", async () => {
  seedFullOD();
  const r = await reports.buildTeamReport("hunter");
  assert.match(r.text, /вне возможностей команды/);
  assert.match(r.text, /140\s?000\s?000/, "назван недостижимый разрыв");
  assert.match(r.text, /снизить цель до 60\s?000\s?000/);
  const cbs = JSON.stringify(r.decisionButtons);
  assert.match(cbs, /od:lower/);
  assert.match(cbs, /od:dismiss/);
});

test("getOwnerDecision: партиал из pending-плана; dismissed → не показываем", async () => {
  kvSetJSON("planner:pending:hunter", { periodKey: "авг", plan: { facts: { ownerDecision: { unreachableUZS: 50000000, feasibleGoalUZS: 100000000, addManagers: 1 } } } });
  const a = await planner.getOwnerDecision("hunter");
  assert.equal(a.scope, "partial");
  assert.equal(a.od.feasibleGoalUZS, 100000000);
  // снят → нет
  await planner.handleOwnerDecision("dismiss", "hunter");
  assert.equal(await planner.getOwnerDecision("hunter"), null);
});

test("od:lower → цель снижается до достижимой, старый план снят", async () => {
  seedFullOD();
  kvSetJSON("goal:hunter", { amountUZS: 200000000, currency: "UZS", rate: 1, period: { label: "август 2026", start: "2026-08-01", end: "2026-08-31" }, planBuiltFor: null });
  const r = await planner.handleOwnerDecision("lower", "hunter");
  assert.match(r.toast, /снижена/i);
  assert.equal(kvGetJSON("goal:hunter").amountUZS, 60000000, "цель = достижимая feasibleGoalUZS");
  assert.equal(kvGetJSON("planner:pending:hunter"), null, "старый pending снят");
});

test("od:dismiss идемпотентно межканально: повтор = «неактуально» (no-op)", async () => {
  seedFullOD();
  const r1 = await planner.handleOwnerDecision("dismiss", "hunter");
  assert.match(r1.toast, /оставил/i);
  const r2 = await planner.handleOwnerDecision("dismiss", "hunter");
  assert.equal(r2.toast, "решение неактуально", "повтор — no-op");
});

test("отчёт: ownerDecision снят (dismissed) → строки в отчёте нет", async () => {
  seedFullOD();
  await planner.handleOwnerDecision("dismiss", "hunter");
  const r = await reports.buildTeamReport("hunter");
  assert.doesNotMatch(r.text, /вне возможностей команды/);
});
