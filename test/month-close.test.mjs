// Закрытие месяца: фиксация итога в ПОСТОЯННОЕ хранилище + отчёт владельцу + база для проверки реалистичности.
import { resetMocks, kvSetJSON, kvGetJSON, tgSendCount, tgTo } from "./helpers.mjs";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const planner = await import("../api/planner.js");
const realism = await import("../api/goal-realism.js");

const realNow = Date.now;
function freezeUTC(iso) { const ts = Date.parse(iso + "T00:00:00Z"); Date.now = () => ts; }
beforeEach(() => resetMocks());
afterEach(() => { Date.now = realNow; });

// снимок последнего дня июля = замороженный итог месяца + цель того периода
const julySnap = { date: "2026-07-31", goalUZS: 100000000, goalPeriod: "июль 2026", revenue: 95000000, sold: 19, leads: 210, avgCheckMedian: 5000000, conv: 9 };

test("closeMonth: фиксирует итог июля из снимка 31-го, считает % и недобор, кладёт в periodresults", async () => {
  freezeUTC("2026-08-01"); // 1-е августа по Ташкенту → закрываем ИЮЛЬ
  kvSetJSON("snap:2026-07-31", julySnap);
  const r = await planner.closeMonth("hunter");
  assert.equal(r.closed, true);
  assert.equal(r.result.month, "2026-07");
  assert.equal(r.result.earned, 95000000);
  assert.equal(r.result.goalUZS, 100000000);
  assert.equal(r.result.pct, 95);
  assert.equal(r.result.onTarget, false, "95М < 100М → недобор");
  assert.equal(r.result.avgCheckMedian, 5000000);
  assert.equal(r.result.convPct, 9);
  const stored = kvGetJSON("periodresults:hunter");
  assert.equal(stored.length, 1, "итог сохранён в постоянное хранилище");
});

test("closeMonth: идемпотентно — второй прогон не дублирует", async () => {
  freezeUTC("2026-08-01");
  kvSetJSON("snap:2026-07-31", julySnap);
  await planner.closeMonth("hunter");
  const r2 = await planner.closeMonth("hunter");
  assert.equal(r2.skipped, "already_closed");
  assert.equal(kvGetJSON("periodresults:hunter").length, 1);
});

test("closeMonth: цель другого периода в снимке → goalUZS не подставляется (не путаем месяцы)", async () => {
  freezeUTC("2026-08-01");
  kvSetJSON("snap:2026-07-31", { ...julySnap, goalPeriod: "август 2026" }); // цель уже августовская
  const r = await planner.closeMonth("hunter");
  assert.equal(r.result.goalUZS, null, "цель принадлежит не июлю → не берём");
  assert.equal(r.result.earned, 95000000, "но выручку июля фиксируем");
});

test("sendMonthClose: отчёт «месяц закрыт» уходит владельцу с итогом против цели", async () => {
  freezeUTC("2026-08-01");
  kvSetJSON("snap:2026-07-31", julySnap);
  kvSetJSON("taskagent:people", { owner: { chatId: 999 } });
  const r = await planner.sendMonthClose("hunter");
  assert.equal(r.sent, true);
  assert.equal(tgSendCount("OWNTOK"), 1);
  const msg = tgTo("OWNTOK")[0].body.text;
  assert.match(msg, /Месяц закрыт.*июль 2026/s);
  assert.match(msg, /95%/);
  assert.match(msg, /недобор/);
});

test("closeMonth: нет снимка последнего дня → честно не закрываем (а не пишем нули)", async () => {
  freezeUTC("2026-08-01"); // снимка нет
  const r = await planner.closeMonth("hunter");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "no_snapshot");
});

test("реализм: текущий месяц пустой → база avgCheck/конверсии из закрытого месяца", async () => {
  // цель на август, но продаж в августе почти нет (тонкий месяц)
  kvSetJSON("goal:hunter", { amountUZS: 150000000, currency: "UZS", period: { label: "август 2026", start: "2026-08-01", end: "2026-08-31" } });
  kvSetJSON("dashboard", {
    updatedAt: new Date().toISOString(),
    totals: { leads: 40, sold: 2, revenue: 6000000, avgCheck: 3000000, avgCheckMedian: 3000000, newSalesRevenue: 6000000 },
    mopsByConv: [{ name: "A" }, { name: "B" }, { name: "C" }],
    teamCapacity: { thinMonths: 3, byMop: { A: { median: 40, max: 60, monthsN: 6 }, B: { median: 40, max: 60, monthsN: 6 }, C: { median: 40, max: 60, monthsN: 6 } } },
    velocity: { stages: [] },
  });
  kvSetJSON("speed", { mops: [{ reached: 60 }, { reached: 60 }, { reached: 60 }] });
  // закрытый июль — база: чек 5М, конверсия 10%
  kvSetJSON("periodresults:hunter", [{ month: "2026-07", label: "июль 2026", goalUZS: 100000000, earned: 95000000, sold: 19, leads: 210, avgCheckMedian: 5000000, convPct: 10 }]);

  const r = await realism.assessRealism("hunter");
  assert.equal(r.baselineLabel, "июль 2026", "база взята из закрытого месяца");
  assert.match(r.human, /закрытого месяца \(июль 2026\)/, "вердикт честно помечает базу");
});
