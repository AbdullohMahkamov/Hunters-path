// Единый источник очереди решений (getDecisions) — и для отчёта по команде, и для Mini App. Все 5 типов.
import { resetMocks, kvSetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const reports = await import("../api/reports.js");

beforeEach(() => resetMocks());

test("getDecisions: план, meta-brain, DeepSales, ownerDecision, цель — все с типами advisor-act", async () => {
  kvSetJSON("transcriptplan:pending:hunter", { totals: { plannedMinutes: 100 }, declined: false });                 // DeepSales
  kvSetJSON("planner:pending:hunter", { periodKey: "август 2026", plan: { facts: { gap: 30000000, gapPct: 5 } } }); // план
  kvSetJSON("planner:active:hunter", { ownerDecisionOnly: true, facts: { ownerDecision: { unreachableUZS: 140000000, feasibleGoalUZS: 60000000, addManagers: 2 } } }); // OD
  kvSetJSON("metabrain:proposals", [{ id: "p1", status: "pending", title: "27 лидов без звонка", confidence: "high", at: Date.now() - 5 * 86400000 }]); // meta
  // цель не задана → goal item

  const items = await reports.getDecisions("hunter");
  const byKind = Object.fromEntries(items.map((it) => [it.kind, it]));

  assert.ok(byKind.deepsales, "DeepSales");
  assert.equal(byKind.deepsales.actions[0].type, "ds_run");

  assert.ok(byKind.plan, "план");
  assert.ok(byKind.plan.actions.some((a) => a.type === "plan_confirm"));

  assert.ok(byKind.ownerdecision, "ownerDecision");
  assert.ok(byKind.ownerdecision.actions.some((a) => a.type === "od_lower"));
  assert.match(byKind.ownerdecision.detail, /снизить цель до 60\s?000\s?000/);

  assert.ok(byKind.meta, "meta-brain");
  assert.equal(byKind.meta.actions[0].type, "mb_confirm");
  assert.equal(byKind.meta.actions[0].id, "p1");

  assert.ok(byKind.goal, "запрос цели (self-heal)");
  assert.equal(byKind.goal.actions[0].type, "__goto_chat");
});

test("getDecisions: пусто → пустой список (Mini App покажет «всё под контролем»)", async () => {
  // цель на ТЕКУЩИЙ месяц задана → даже goal-карточки нет
  const now = new Date(Date.now() + 5 * 3600000);
  const RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
  kvSetJSON("goal:hunter", { amountUZS: 100000000, period: { label: `${RU[now.getUTCMonth()]} ${now.getUTCFullYear()}` } });
  const items = await reports.getDecisions("hunter");
  assert.equal(items.length, 0);
});

test("getDecisions структура для Mini App: только kind/id/title/detail/actions наружу (без Telegram-строк)", async () => {
  kvSetJSON("planner:pending:hunter", { periodKey: "авг", plan: { facts: { gap: 10000000 } } });
  kvSetJSON("goal:hunter", { amountUZS: 1, period: { label: "август 2026" } }); // не текущий → но goal тоже придёт; проверяем именно поля plan
  const items = await reports.getDecisions("hunter");
  const plan = items.find((it) => it.kind === "plan");
  // внутренние поля (line/tgButtons) существуют в getDecisions, но endpoint их вырежет — здесь проверяем, что actions есть
  assert.ok(Array.isArray(plan.actions) && plan.actions.length >= 1);
  assert.ok(plan.title && plan.detail);
});
