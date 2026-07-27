// Планировщик: арифметика разрыва и разбивки 50/50 — числа, на основе которых людям ставят задачи.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("decomposeGap: разбивка 50/50 на лиды и конверсию (фикс. входные)", async () => {
  const P = await import("../api/planner.js");
  const f = { avgCheck: 3_350_000, conv: 0.031, leads: 1148, sold: 36 };
  const gap = 51_800_000;
  const dec = P.decomposeGap(gap, f);
  assert.equal(dec.extraSales, Math.ceil(gap / 3_350_000), "доп. продажи = разрыв / средний чек");
  assert.ok(dec.leadsLever && dec.convLever, "оба рычага применимы");
  const salesHalf = Math.ceil((gap / 2) / 3_350_000);
  assert.equal(dec.leadsLever.extraSales, salesHalf, "половина разрыва в продажах через лиды");
  assert.equal(dec.leadsLever.extraLeads, Math.ceil(salesHalf / 0.031), "доп. лиды = доп.продажи / конверсия");
  assert.ok(dec.convLever.neededConvPct > dec.convLever.currentConvPct, "нужная конверсия выше текущей");
});

test("decomposeGap: без конверсии рычаг лидов не строится (не выдумывает)", async () => {
  const P = await import("../api/planner.js");
  const dec = P.decomposeGap(1e7, { avgCheck: 1e6, conv: null, leads: null, sold: 5 });
  assert.equal(dec.leadsLever, null);
  assert.equal(dec.convLever, null);
  assert.equal(dec.extraSales, 10);
});
