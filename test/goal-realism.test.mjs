// Проверка реалистичности цели: ядро assessGoalRealism (чистое, без сети) — ВЫБОР СВЯЗЫВАЮЩЕГО ограничения.
// Ради этого «нельзя» проверка и существует: не «нужен бюджет $X», а «упирается в людей — бюджет не поможет».
import "./helpers.mjs"; // задаёт env ДО импорта модулей
import { assessGoalRealism } from "../api/goal-realism.js";
import { test } from "node:test";
import assert from "node:assert/strict";

// Капасити одного МОПа: median = устойчивый темп, max = потолок; monthsN — глубина истории.
const cap = (median, max, monthsN = 6) => ({ median, max, monthsN, thin: monthsN < 3 });
const TEAM3 = { A: cap(40, 60), B: cap(40, 60), C: cap(40, 60) }; // сумма: медиана 120, потолок 180 лидов/мес
const WD_FULL = { total: 26, left: 26 }; // весь период впереди → frac=1
const BASE = { earned: 0, avgCheck: 5_000_000, conv: 0.1, cpl: 20_000, cplSource: "по факту", teamCapacityByMop: TEAM3, mopsActiveCount: 3, workdays: WD_FULL };

test("БЮДЖЕТ (выполнимо): команда тянет → связывающее ограничение = деньги, feasible=true", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000 });
  assert.equal(r.leadsNeeded, 100);              // ceil(10 продаж / 0.1)
  assert.equal(r.binding, "budget");
  assert.equal(r.feasible, true);
  assert.equal(r.budgetLower, 2_000_000);        // 100 лидов × 20 000
  assert.match(r.human, /бюджет/i);
});

test("НАПРЯЖЕНИЕ КОМАНДЫ: нужно выше устойчивого темпа, но ниже потолка → team_strain, не feasible", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 80_000_000 });
  assert.equal(r.leadsNeeded, 160);              // между медианой(120) и потолком(180) за период
  assert.equal(r.binding, "team_strain");
  assert.equal(r.feasible, false);
  assert.equal(r.feasibleGoal, 60_000_000);      // устойчивая цель по медиане: floor(120×0.1)×5М
  assert.match(r.human, /на пределе/i);
});

test("УПОР В КОМАНДУ (жёстко): нужно больше исторического потолка → team, бюджет не поможет, +K менеджеров", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 120_000_000 });
  assert.equal(r.leadsNeeded, 240);              // > потолка 180 за период
  assert.equal(r.binding, "team");
  assert.equal(r.feasible, false);
  assert.equal(r.addManagers, 3);                // ceil(3 × (240/120 − 1)) — до устойчивого темпа
  assert.equal(r.feasibleGoal, 60_000_000);
  assert.match(r.human, /КОМАНДУ/);
  assert.match(r.human, /бюджет тут не поможет|не поможет/i);
});

test("БЮДЖЕТ БЕЗ ЦЕНЫ ЛИДА: команда тянет, но CPL нет → budget_unknown, feasible=true, сумму не называем", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000, cpl: null, cplSource: null });
  assert.equal(r.binding, "budget_unknown");
  assert.equal(r.feasible, true);
  assert.equal(r.budgetLower, null);
  assert.match(r.human, /цены лида/i);
});

test("НОВЫЙ МОП (мало истории): помечаем приблизительность, не выдаём одно число по команде", () => {
  const teamThin = { A: cap(40, 60), B: cap(40, 60), C: cap(40, 60), D: cap(5, 8, 1) }; // D — 1 месяц истории
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000, teamCapacityByMop: teamThin, mopsActiveCount: 4 });
  assert.ok(r.thinMops.includes("D"), "новый МОП в списке приблизительных");
  assert.match(r.human, /мало истории|приблизительн/i);
});

test("ИСКАЖЁННЫЙ ЧЕК: доля won-без-суммы выше порога → вердикт помечает, что цифры ориентировочные", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000, baseInaccurate: { count: 12, sharePct: 15 } });
  assert.match(r.human, /без суммы/);
  assert.match(r.human, /ориентировочн/i);
});

test("НЕТ БАЗЫ: конверсия 0 → не считаем (computable=false), а не выдаём фальшивый вердикт", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000, conv: 0 });
  assert.equal(r.computable, false);
  assert.equal(r.feasible, null);
});

test("ОСТАТОК ПЕРИОДА сужает капасити: 5 из 20 дней → даже скромная цель упирается в команду", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 20_000_000, workdays: { total: 20, left: 5 } }); // frac=0.25
  assert.equal(r.leadsNeeded, 40);               // ceil(4 продажи / 0.1)
  assert.equal(r.leadsNeededMonthly, 160);       // 40 / 0.25 — в пересчёте на полный месяц
  assert.equal(r.binding, "team_strain");        // за 5 дней команда столько не пропустит на устойчивом темпе
});

test("ЦЕЛЬ ДОСТИГНУТА: earned ≥ goal → binding=reached, feasible=true, ничего не считаем", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000, earned: 60_000_000 });
  assert.equal(r.binding, "reached");
  assert.equal(r.feasible, true);
});
