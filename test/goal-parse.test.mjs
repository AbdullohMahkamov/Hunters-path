// Разбор периода цели (parsePeriod) — кириллица в regex, чтобы «следующий/текущий месяц» не проваливались
// в дефолт (баг: \w не матчит кириллицу). Плюс склонение «менеджеров» в вердикте реалистичности.
import "./helpers.mjs";
import { parseGoalText } from "../api/goal.js";
import { assessGoalRealism } from "../api/goal-realism.js";
import { test } from "node:test";
import assert from "node:assert/strict";

// tkNow = сейчас+5ч; месяц теста — текущий, «следующий» = +1. Проверяем ОТНОСИТЕЛЬНО, а не жёстко «август».
const RU = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
function monthLabel(offset) { const n = new Date(Date.now() + 5 * 3600000); const d = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset, 1)); return `${RU[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }

test("parsePeriod: «следующий/следующем месяц(е)» → +1 месяц (кириллица в regex)", async () => {
  for (const t of ["250 млн в следующем месяце", "250 млн на следующий месяц"]) {
    const r = await parseGoalText(t);
    assert.equal(r.ok, true);
    assert.equal(r.amountUZS, 250000000, `сумма: ${t}`);
    assert.equal(r.period.label, monthLabel(1), `период должен быть следующим месяцем: ${t}`);
  }
});

test("parsePeriod: «текущий/этот месяц» → текущий месяц", async () => {
  for (const t of ["100 млн в текущем месяце", "100 млн этот месяц"]) {
    const r = await parseGoalText(t);
    assert.equal(r.period.label, monthLabel(0), `период должен быть текущим: ${t}`);
  }
});

test("parsePeriod: явный месяц по имени → этот месяц/следующий год корректно", async () => {
  const r = await parseGoalText("250 млн на август");
  assert.equal(r.amountUZS, 250000000);
  assert.ok(/август/.test(r.period.label));
});

test("вердикт: склонение «менеджеров» верное и нет «+null» когда addManagers пуст", () => {
  // team-bound: нужно людей больше, чем команда тянет
  const v = assessGoalRealism({ goalUZS: 250e6, earned: 0, avgCheck: 3.5e6, conv: 0.0264,
    teamCapacityByMop: { A: { median: 1110, max: 1790, monthsN: 5 } }, mopsActiveCount: 5, workdays: { total: 26, left: 26 } });
  assert.equal(v.binding, "team");
  assert.ok(v.addManagers >= 5);
  assert.match(v.human, /менеджеров/, "5+ → «менеджеров», не «менеджера»");
  assert.doesNotMatch(v.human, /\+null|undefined/, "нет мусорных плейсхолдеров");
});

test("вердикт: frac=0 (период уже прошёл) → не пишем «+null менеджера», только устойчивую цель", () => {
  // капасити за период = 0 → addManagers=null; текст не должен содержать «+null»
  const v = assessGoalRealism({ goalUZS: 250e6, earned: 0, avgCheck: 3.5e6, conv: 0.0264,
    teamCapacityByMop: { A: { median: 1110, max: 1790, monthsN: 5 } }, mopsActiveCount: 5, workdays: { total: 26, left: 0 } });
  assert.doesNotMatch(v.human, /\+null/);
});
