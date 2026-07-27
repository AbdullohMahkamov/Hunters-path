// getVerifiedFunnel: trust-статусы, узкое место, поведение при недостатке данных.
import { kv, resetMocks, kvSetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const now = () => new Date().toISOString();
function seedDash({ leads, sold, revenue }) {
  kvSetJSON("dashboard", { updatedAt: now(), mopsByConv: [], velocity: { stages: null }, totals: { leads, sold, revenue, avgCheck: revenue && sold ? Math.round(revenue / sold) : null, avgCheckMedian: null, dealCycleMedianDays: 2, paidReceiptCount: null, newSalesRevenue: revenue } });
}

beforeEach(() => resetMocks());

test("funnel: достаточно данных → verified + узкое место среди verified-переходов", async () => {
  const { getVerifiedFunnel } = await import("../api/dev-agent.js");
  seedDash({ leads: 1148, sold: 36, revenue: 120_000_000 });
  kvSetJSON("speed", { mops: [{ reached: 600 }], telephony: null });
  const f = await getVerifiedFunnel("hunter");
  const deal = f.stages.find((s) => /Сделка выиграна/.test(s.stage));
  assert.equal(deal.trust, "verified", "сделка verified при 1148 лидах");
  assert.ok(f.bottleneck, "узкое место определено");
  // максимальный отток — на переходе разговор→сделка (6% против 52% дозвона)
  assert.ok(/сделк/i.test(f.bottleneck.transition), `узкое место = ${f.bottleneck.transition}`);
  assert.ok(f.bottleneck.pct < 15, `конверсия узкого места ~6%, а не ${f.bottleneck.pct}`);
});

test("funnel: мало лидов (<30) → insufficient, узкое место НЕ выдумывается", async () => {
  const { getVerifiedFunnel } = await import("../api/dev-agent.js");
  seedDash({ leads: 5, sold: 1, revenue: 3_000_000 });
  kvSetJSON("speed", { mops: [{ reached: 3 }], telephony: null });
  const f = await getVerifiedFunnel("hunter");
  const deal = f.stages.find((s) => /Сделка выиграна/.test(s.stage));
  assert.equal(deal.trust, "insufficient");
  assert.equal(f.bottleneck, null, "на недостоверных данных узкое место не строим");
  assert.ok((f.undiagnosable || []).length > 0, "переходы помечены как недиагностируемые");
});

test("funnel: телефония подозрительна → переход дозвона suspicious, не verified", async () => {
  const { getVerifiedFunnel } = await import("../api/dev-agent.js");
  seedDash({ leads: 1148, sold: 36, revenue: 120_000_000 });
  kvSetJSON("speed", { mops: [{ reached: 600 }], telephony: { total: 30, noCallButActivePct: 40 } });
  const f = await getVerifiedFunnel("hunter");
  assert.equal(f.telephonySuspicious, true);
  const reachTrans = f.stages.find((s) => s.transitionFromPrev && /дозвон/i.test(s.transitionFromPrev.name));
  assert.equal(reachTrans.transitionFromPrev.trust, "suspicious", "дозвон помечен suspicious при плохой телефонии");
});
