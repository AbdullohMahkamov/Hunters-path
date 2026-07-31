// Проверка реалистичности цели: ядро assessGoalRealism (чистое, без сети) — ТРИ МНОЖИТЕЛЯ (лиды×конверсия×чек).
// Рычаги в порядке: конверсия → чек → лиды(реклама до пика) → НАЙМ (последним). Найм называется, только когда
// своих рычагов не хватает. Ради этого «нельзя» проверка и существует.
import "./helpers.mjs"; // задаёт env ДО импорта модулей
import { assessGoalRealism } from "../api/goal-realism.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const cap = (median, max, monthsN = 6) => ({ median, max, monthsN, thin: monthsN < 3 });
const TEAM3 = { A: cap(40, 60), B: cap(40, 60), C: cap(40, 60) }; // медиана 120, пик 180 лидов/мес
const WD_FULL = { total: 26, left: 26 }; // весь период впереди → frac=1
const BASE = { earned: 0, avgCheck: 5_000_000, conv: 0.1, cpl: 20_000, cplSource: "по факту", teamCapacityByMop: TEAM3, mopsActiveCount: 3, workdays: WD_FULL };
// revNow=floor(120×0.1)×5М=60М; revBudget(пик)=floor(180×0.1)×5М=90М (без рычагов конверсии/чека)

test("БЕРЁТСЯ СЕЙЧАС: цель ≤ выручки на устойчивом темпе → reachable_now, feasible=true", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000 });
  assert.equal(r.binding, "reachable_now");
  assert.equal(r.feasible, true);
});

test("РЫЧАГ КОНВЕРСИИ ПЕРВЫМ: цель закрывается возвратом к своей лучшей конверсии → conversion, БЕЗ найма", () => {
  // convBest 0.15 > 0.1: revConv=floor(120×0.15)×5М=90М ≥ 80М
  const r = assessGoalRealism({ ...BASE, goalUZS: 80_000_000, convBest: 0.15, convBestLabel: "ваш июнь" });
  assert.equal(r.binding, "conversion");
  assert.equal(r.feasible, true);
  assert.match(r.human, /без найма/i);
  assert.match(r.human, /конверси/i);
  assert.doesNotMatch(r.human, /нанять|\+\d+ менеджер/i); // найм НЕ называем
});

test("РЫЧАГ ЧЕКА ВТОРЫМ: не хватило конверсии, добирает чек → check, БЕЗ найма", () => {
  // conv 0.1→0.11 (revConv=floor(120×0.11)×5М=65М), чек 5М→6М: revChk=floor(120×0.11)×6М=78М ≥ 75М
  const r = assessGoalRealism({ ...BASE, goalUZS: 75_000_000, convBest: 0.11, checkCeiling: 6_000_000 });
  assert.equal(r.binding, "check");
  assert.equal(r.feasible, true);
  assert.match(r.human, /чек/i);
});

test("РЫЧАГ ЛИДОВ (реклама до пика) ТРЕТЬИМ: своих рычагов мало, но команда потянет больше лидов → budget, найма НЕТ", () => {
  // без convBest/checkCeiling: revChk=60М; revBudget(пик)=90М. Цель 80М между ними → добрать лиды рекламой.
  const r = assessGoalRealism({ ...BASE, goalUZS: 80_000_000 });
  assert.equal(r.binding, "budget");
  assert.equal(r.feasible, true);              // без найма
  assert.match(r.human, /реклам/i);
  assert.match(r.human, /найм не нужен|без найма/i);
});

test("НАЙМ ПОСЛЕДНИМ: даже пик×лучшая конверсия×чек не дотягивают → team, +K менеджеров", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 200_000_000 }); // > revBudget 90М даже с рычагами
  assert.equal(r.binding, "team");
  assert.equal(r.feasible, false);
  assert.ok(r.addManagers >= 1);
  assert.match(r.human, /последний рычаг/i);
  assert.match(r.human, /нанять|менеджер/i);
});

test("feasibleGoal = максимум БЕЗ найма (пик × лучшая конверсия × потолок чека)", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 500_000_000, convBest: 0.12, checkCeiling: 6_000_000 });
  assert.equal(r.binding, "team");
  // revBudget = floor(180×0.12)×6М = 21×6М = 126М
  assert.equal(r.feasibleGoal, 126_000_000);
});

test("НЕТ ИСТОРИИ КОМАНДЫ: capacity_unknown (не выдаём «выполнимо» вслепую)", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000, teamCapacityByMop: {}, mopsActiveCount: 0 });
  assert.equal(r.binding, "capacity_unknown");
});

test("НОВЫЙ МОП (мало истории): помечаем приблизительность", () => {
  const teamThin = { A: cap(40, 60), B: cap(40, 60), C: cap(40, 60), D: cap(5, 8, 1) };
  const r = assessGoalRealism({ ...BASE, goalUZS: 300_000_000, teamCapacityByMop: teamThin, mopsActiveCount: 4 });
  assert.ok(r.thinMops.includes("D"));
  assert.match(r.human, /мало истории|приблизительн/i);
});

test("ИСКАЖЁННЫЙ ЧЕК: доля won-без-суммы выше порога → вердикт помечает ориентировочность", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 300_000_000, baseInaccurate: { count: 12, sharePct: 15 } });
  assert.match(r.human, /без суммы/);
  assert.match(r.human, /ориентировочн/i);
});

test("НЕТ БАЗЫ: конверсия 0 → computable=false, а не фальшивый вердикт", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000, conv: 0 });
  assert.equal(r.computable, false);
  assert.equal(r.feasible, null);
});

test("ЦЕЛЬ ДОСТИГНУТА: earned ≥ goal → reached, feasible=true", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 50_000_000, earned: 60_000_000 });
  assert.equal(r.binding, "reached");
  assert.equal(r.feasible, true);
});

test("порядок рычагов монотонен: revNow ≤ revConv ≤ revChk ≤ revBudget", () => {
  const r = assessGoalRealism({ ...BASE, goalUZS: 999_000_000, convBest: 0.14, checkCeiling: 6_000_000 });
  const L = r.levers;
  assert.ok(L.revNow <= L.revConv, "конверсия не уменьшает");
  assert.ok(L.revConv <= L.revChk, "чек не уменьшает");
  assert.ok(L.revChk <= L.revBudget, "лиды до пика не уменьшают");
});
