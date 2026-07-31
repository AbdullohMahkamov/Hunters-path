// Конец месяца → система сама просит цель на следующий: в ПОСЛЕДНИЙ день месяца (вычисляется), РОВНО раз.
import { resetMocks, kvSetJSON, kvGetJSON, tgSendCount } from "./helpers.mjs";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

const planner = await import("../api/planner.js");

const realNow = Date.now;
// tkNow = Date.now()+5ч. Ставим UTC-полночь нужного дня → Ташкент 05:00 того же дня.
function freezeUTC(iso) { const ts = Date.parse(iso + "T00:00:00Z"); Date.now = () => ts; }
beforeEach(() => { resetMocks(); kvSetJSON("taskagent:people", { owner: { chatId: 77 } }); });
afterEach(() => { Date.now = realNow; });

test("ПОСЛЕДНИЙ день (авг=31) → уходит запрос на цель следующего месяца, ставится защёлка", async () => {
  freezeUTC("2026-08-31"); // последний день августа
  const r = await planner.nextMonthPrompt("hunter");
  assert.equal(r.sent, true);
  assert.equal(r.nextLabel, "сентябрь 2026", "просит цель именно на следующий месяц");
  assert.equal(tgSendCount("OWNTOK"), 1, "владельцу ушло одно сообщение");
  assert.ok(kvGetJSON("planner:monthprompt:hunter:2026-08"), "защёлка за месяц выставлена");
});

test("НЕ последний день (авг 30-е из 31) → НЕ шлёт (раньше слал 30-го — теперь строго последний)", async () => {
  freezeUTC("2026-08-30");
  const r = await planner.nextMonthPrompt("hunter");
  assert.equal(r.skipped, "not_last_day");
  assert.equal(r.lastDay, 31);
  assert.equal(tgSendCount("OWNTOK"), 0);
});

test("идемпотентно: второй прогон в тот же месяц НЕ шлёт повторно", async () => {
  freezeUTC("2026-08-31");
  await planner.nextMonthPrompt("hunter");
  const r2 = await planner.nextMonthPrompt("hunter");
  assert.equal(r2.skipped, "already_sent");
  assert.equal(tgSendCount("OWNTOK"), 1, "второго сообщения нет");
});

test("середина месяца (15-е) → ничего не шлёт", async () => {
  freezeUTC("2026-08-15");
  const r = await planner.nextMonthPrompt("hunter");
  assert.equal(r.skipped, "not_last_day");
  assert.equal(tgSendCount("OWNTOK"), 0);
});

test("февраль (не високосный) → последний день 28-е, просит март", async () => {
  freezeUTC("2026-02-28"); // 2026 не високосный → 28 дней
  const r = await planner.nextMonthPrompt("hunter");
  assert.equal(r.sent, true);
  assert.equal(r.nextLabel, "март 2026");
  assert.equal(tgSendCount("OWNTOK"), 1);
});

test("30-дневный месяц (апрель) → последний день 30-е (не 31-е)", async () => {
  freezeUTC("2026-04-30");
  const r = await planner.nextMonthPrompt("hunter");
  assert.equal(r.sent, true);
  assert.equal(r.nextLabel, "май 2026");
});

test("цель на следующий месяц уже задана → не дёргает впустую", async () => {
  freezeUTC("2026-08-31");
  kvSetJSON("goal:hunter", { amountUZS: 200000000, period: { label: "сентябрь 2026" } });
  const r = await planner.nextMonthPrompt("hunter");
  assert.equal(r.skipped, "next_goal_already_set");
  assert.equal(tgSendCount("OWNTOK"), 0);
});
