// Принцип «б»: невыполнимую часть цели НЕ спускаем исполнителям задачей + нереалистичность = ВСЕГДА гейт.
// Детерминированность: период берём ПОЛНОСТЬЮ ПРОШЕДШИЙ → passed=total → forecast=earned, числа не зависят от даты.
import { resetMocks, kvSetJSON, kvGetJSON, setAnthropic } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const planner = await import("../api/planner.js");

beforeEach(() => resetMocks());

// прошедший месяц (июнь 2026 относительно «сегодня» 2026-07) — все рабочие дни в прошлом → forecast=earned
const PAST = { start: "2026-06-01", end: "2026-06-30", label: "июнь 2026", kind: "month" };
// verified-воронка строится из dashboard.totals (getVerifiedFunnel) + speed.mops (reached)
function verifiedDash(revenue, sold = 20, leads = 200) {
  return {
    updatedAt: new Date().toISOString(),
    totals: { leads, sold, revenue, avgCheck: 5_000_000, avgCheckMedian: 5_000_000, newSalesRevenue: revenue, dealCycleMedianDays: 10, paidReceiptCount: 3 },
    mopsByConv: [{ name: "A" }, { name: "B" }, { name: "C" }],
    velocity: { stages: [] },
  };
}
const SPEED = { mops: [{ reached: 60 }, { reached: 60 }, { reached: 60 }] };
const TASKS_JSON = () => ({ content: [{ type: "text", text: JSON.stringify({ rop: [{ title: "Дожать тёплых", why: "разрыв", step: "обзвон", deadlineDays: 5 }], marketing: [] }) }], stop_reason: "end_turn", usage: {} });

test("SPLIT (б): жёсткий упор в людей → задачи под ДОСТИЖИМУЮ часть, остаток помечен как решение владельца", async () => {
  setAnthropic(TASKS_JSON);
  kvSetJSON("dashboard", verifiedDash(30_000_000)); // earned=30М → forecast=30М (месяц прошёл)
  kvSetJSON("speed", SPEED);
  kvSetJSON("goal:hunter", { amountUZS: 200_000_000, currency: "UZS", period: PAST });

  const plan = await planner.buildPlan("hunter", { realism: { computable: true, binding: "team", feasible: false, feasibleGoal: 60_000_000, addManagers: 2 } });
  assert.equal(plan.ok, true);
  assert.ok(plan.facts.ownerDecision, "разрыв сверх достижимого помечен как решение владельца");
  assert.equal(plan.facts.effectiveGoalUZS, 60_000_000, "задачи строятся под достижимую часть (feasibleGoal)");
  assert.equal(plan.facts.ownerDecision.unreachableUZS, 140_000_000, "невыполнимый остаток = цель − достижимое");
  assert.equal(plan.facts.ownerDecision.addManagers, 2);
  assert.ok(plan.tasks.rop.length >= 1, "под достижимую часть задачи всё же есть");
});

test("ВЕСЬ разрыв за пределами команды (feasibleGoal ≤ forecast) → задач НЕТ, только решение владельца", async () => {
  setAnthropic(TASKS_JSON);
  kvSetJSON("dashboard", verifiedDash(30_000_000)); // forecast=30М
  kvSetJSON("speed", SPEED);
  kvSetJSON("goal:hunter", { amountUZS: 200_000_000, currency: "UZS", period: PAST });

  const plan = await planner.buildPlan("hunter", { realism: { computable: true, binding: "team", feasible: false, feasibleGoal: 20_000_000, addManagers: 3 } });
  assert.equal(plan.allOwnerDecision, true, "нет задач исполнителям — команда уже на максимуме");
  assert.equal(plan.tasks.rop.length, 0);
  assert.equal(plan.tasks.marketing.length, 0);
  assert.match(plan.human, /решение владельца/i);
});

test("ГЕЙТ АВТОНОМИИ: нереалистичная цель НЕ раздаётся сама — та же рутинная задача, что при feasible уходит авто, здесь гейтится", async () => {
  // сцена, в которой РОП-задача проходит классификатор как «авто»: малый разрыв, verified, тема в whitelist, автономия ВКЛ
  const scene = () => {
    kvSetJSON("dashboard", verifiedDash(90_000_000)); // earned=90М, goal=100М → разрыв 10М (10%, ≤30М) — рутинный band
    kvSetJSON("speed", SPEED);
    kvSetJSON("goal:hunter", { amountUZS: 100_000_000, currency: "UZS", period: PAST });
    kvSetJSON("planner:autonomy:hunter", { enabled: true, maxPerDay: 5, maxPerRopChat: 5 });
    kvSetJSON("planner:autowhitelist:hunter", { "rop_conversion@le10m": { lastUsedAt: Date.now() } }); // тема уже подтверждалась
    kvSetJSON("taskagent:people", { owner: { chatId: 1 }, rop: { chatId: 2 } });
  };

  // (1) FEASIBLE → задача уходит АВТОНОМНО
  setAnthropic(TASKS_JSON); scene();
  const rFeasible = await planner.proposePlan("hunter", true, { realism: { computable: true, binding: "budget", feasible: true } });
  assert.equal(rFeasible.autoDispatched, 1, "реалистичная цель: рутинная РОП-задача раздана сама");
  assert.equal(rFeasible.gated, 0);

  // (2) НЕ FEASIBLE (та же задача, тот же band) → forceGate → к владельцу, НЕ авто
  resetMocks(); setAnthropic(TASKS_JSON); scene();
  const rUnreal = await planner.proposePlan("hunter", true, { realism: { computable: true, binding: "team_strain", feasible: false, feasibleGoal: 80_000_000 } });
  assert.equal(rUnreal.autoDispatched, 0, "нереалистичная цель: ничего не раздано автономно");
  assert.ok(rUnreal.gated >= 1, "задача ушла на подтверждение владельцу");
  assert.ok(kvGetJSON("planner:pending:hunter"), "создан pending на подтверждение");
});
