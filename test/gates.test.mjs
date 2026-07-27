// ГЕЙТЫ — НЕГАТИВНЫЙ сценарий: без подтверждения задача физически НЕ создаётся и НЕ уходит человеку.
import { resetMocks, kvSetJSON, kvGetJSON, tgCalls } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

beforeEach(() => resetMocks());

// ── pl:confirm — план не раздаётся без подтверждения ──
test("GATE pl:confirm: пока НЕ подтверждён — задачи НЕ в customPlan.sales и НЕ в marketingtasks", async () => {
  const P = await import("../api/planner.js");
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", []);
  kvSetJSON("planner:pending:hunter", { periodKey: "июль 2026", at: Date.now(), reminded: false,
    plan: { facts: {}, tasks: { rop: [{ title: "T1", why: "w", step: "s", deadlineDays: 3 }], marketing: [{ title: "M1", why: "w", step: "s", deadlineDays: 5 }] } } });
  // НЕГАТИВ: наличие pending НЕ создаёт задачи
  assert.equal((kvGetJSON("appdata:hunter").customPlan.sales || []).length, 0, "без confirm задач РОПа нет");
  assert.equal((kvGetJSON("marketingtasks") || []).length, 0, "без confirm маркетинг-задач нет");
  // ПОЗИТИВ: только после confirm — создаются
  await P.handlePlanButton("confirm");
  const sales = kvGetJSON("appdata:hunter").customPlan.sales;
  const mk = kvGetJSON("marketingtasks");
  assert.equal(sales.length, 1, "после confirm задача РОПа создана");
  assert.equal(sales[0].source, "planner");
  assert.equal(mk.length, 1, "после confirm маркетинг-задача создана");
  assert.equal(kvGetJSON("planner:pending:hunter"), null, "pending очищен");
});

test("GATE pl:reject: отклонение → задачи НЕ создаются, уходит в историю", async () => {
  const P = await import("../api/planner.js");
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", []);
  kvSetJSON("planner:pending:hunter", { periodKey: "июль 2026", at: Date.now(), plan: { facts: {}, tasks: { rop: [{ title: "T1", deadlineDays: 3 }], marketing: [] } } });
  await P.handlePlanButton("reject");
  assert.equal((kvGetJSON("appdata:hunter").customPlan.sales || []).length, 0, "после reject задач нет");
  const hist = kvGetJSON("planner:history:hunter") || [];
  assert.ok(hist.some((h) => h.status === "rejected"), "отклонение записано в историю");
});

// ── mb:confirm — предложение мозга не становится задачей без подтверждения ──
test("GATE mb:confirm: pending-предложение НЕ попадает в задачи (getConfirmedMetaTasks пуст)", async () => {
  const MB = await import("../api/meta-brain.js");
  kvSetJSON("metabrain:proposals", [{ id: "abc", status: "pending", title: "T", statement: "s", proposedTask: { title: "Задача", why: "w", recipient: "rop" } }]);
  let confirmed = await MB.getConfirmedMetaTasks();
  assert.equal(confirmed.length, 0, "pending не отдаётся как задача");
  // после подтверждения — отдаётся
  kvSetJSON("metabrain:proposals", [{ id: "abc", status: "confirmed", title: "T", statement: "s", proposedTask: { title: "Задача", why: "w", recipient: "rop" } }]);
  confirmed = await MB.getConfirmedMetaTasks();
  assert.equal(confirmed.length, 1, "confirmed отдаётся как задача");
});

// ── DeepSales spend — без клика «Потратить» разбор НЕ запускается (деньги) ──
test("GATE DeepSales spend: confirmed без spend → разбор НЕ идёт (нет активного запуска)", async () => {
  const DS = await import("../api/deepsales.js");
  kvSetJSON("transcriptplan:pending:hunter", { confirmed: true, spend: null, plan: [{ mop: "X", calls: 5 }], totals: { plannedCalls: 5, plannedMinutes: 15 } });
  const r = await DS.execDaily("hunter");
  assert.equal(r.done, true, "без spend-флага разбор не запускается");
  assert.ok(/нет активного запуска/.test(r.note || ""), `note=${r.note}`);
  // и ничего не ушло в Telegram/аудит
  assert.equal(tgCalls.length, 0, "без spend ничего не отправлено");
});
