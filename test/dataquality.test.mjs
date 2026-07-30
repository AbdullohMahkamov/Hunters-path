// Качество данных: won-без-суммы как самодокладываемая метрика — доля + порог неточности.
import "./helpers.mjs";
import { assessWonNoAmount } from "../api/sync.js";
import { test } from "node:test";
import assert from "node:assert/strict";

test("assessWonNoAmount: доля и порог 10% (граница НЕ включительно)", () => {
  assert.deepEqual(assessWonNoAmount(0, 40), { count: 0, soldThisMonth: 40, sharePct: 0, thresholdPct: 10, inaccurate: false });
  const at10 = assessWonNoAmount(4, 40); // ровно 10% → НЕ неточно (шум)
  assert.equal(at10.sharePct, 10);
  assert.equal(at10.inaccurate, false);
  const over = assessWonNoAmount(5, 40); // 12.5% → неточно
  assert.equal(over.sharePct, 12.5);
  assert.equal(over.inaccurate, true);
});

test("assessWonNoAmount: нет продаж → без деления, не неточно", () => {
  const r = assessWonNoAmount(0, 0);
  assert.equal(r.sharePct, 0);
  assert.equal(r.inaccurate, false);
});

test("assessWonNoAmount: порог настраивается", () => {
  assert.equal(assessWonNoAmount(1, 20, 3).sharePct, 5);       // 5% > 3 → неточно
  assert.equal(assessWonNoAmount(1, 20, 3).inaccurate, true);
  assert.equal(assessWonNoAmount(1, 20, 10).inaccurate, false); // 5% < 10
});
