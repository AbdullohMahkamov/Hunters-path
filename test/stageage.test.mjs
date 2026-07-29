// «Дни на этапе» (карта #3): агрегат computeStageAge — сколько дней открытый лид висит на этапе.
import "./helpers.mjs"; // env для импорта модуля
import { computeStageAge } from "../api/sync-speed.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const DAY = 86400;
const now = 1_700_000_000;
const names = { 100: "Ofisga keladi", 200: "Bog'lanib bo'lmadi" };

test("computeStageAge: дата входа из события, из создания, и нижняя граница за окном", () => {
  const leads = [
    { id: 1, name: "Ali", status: 100, resp: 10, _stageChangedAt: now - 6 * DAY },   // 6 дн → застрял
    { id: 2, name: "Vali", status: 100, resp: 10, _stageChangedAt: now - 2 * DAY },  // 2 дн → нет
    { id: 3, name: "Guli", status: 200, resp: 11, created: now - 3 * DAY },          // нет события, создан 3 дн назад → 3 дн
    { id: 4, name: "Dilnoza", status: 200, resp: 11, created: now - 200 * DAY },     // старше окна 90 дн → 90 дн, нижняя граница
  ];
  const r = computeStageAge(leads, names, now, { lookbackDays: 90, stuckDays: 5 });

  assert.equal(r.totalOpen, 4);
  const s100 = r.byStage.find((x) => x.statusId === 100);
  const s200 = r.byStage.find((x) => x.statusId === 200);
  assert.equal(s100.stage, "Ofisga keladi");
  assert.equal(s100.count, 2);
  assert.equal(s100.medianDays, 4);   // median([2,6]) = 4
  assert.equal(s100.maxDays, 6);
  assert.equal(s100.stuck, 1);        // только 6-дневный
  assert.equal(s200.count, 2);
  assert.equal(s200.maxDays, 90);     // нижняя граница за окном
  assert.equal(s200.stuck, 1);        // 90-дневный (3-дневный ниже порога)

  // список застрявших: отсортирован по дням убыв., нижняя граница помечена
  assert.equal(r.stuck.length, 2);
  assert.equal(r.stuck[0].days, 90);
  assert.equal(r.stuck[0].min, true);
  assert.equal(r.stuck[1].days, 6);
  assert.equal(r.stuck[1].min, false);
});

test("computeStageAge: порог застревания настраивается, имя этапа = fallback на id", () => {
  const leads = [{ id: 1, status: 999, _stageChangedAt: now - 4 * DAY }];
  const r = computeStageAge(leads, names, now, { lookbackDays: 90, stuckDays: 3 });
  assert.equal(r.byStage[0].stage, "999"); // нет имени → id строкой
  assert.equal(r.byStage[0].stuck, 1);     // 4 >= порог 3
  assert.equal(r.stuck.length, 1);
});

test("computeStageAge: пусто → пустой, но валидный результат", () => {
  const r = computeStageAge([], names, now, {});
  assert.equal(r.totalOpen, 0);
  assert.equal(r.byStage.length, 0);
  assert.equal(r.stuck.length, 0);
});
