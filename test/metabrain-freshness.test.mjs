// ГЕЙТ СВЕЖЕСТИ metabrain: задачу РОПу нельзя ставить/держать, если её факт больше НЕ подтверждается данными.
// Ставить задачу по решённой проблеме — хуже, чем не ставить. Плюс разовая перегейтировка и подача снятых РОПу.
import { resetMocks, kvSetJSON, kvGetJSON, setAnthropic } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const M = await import("../api/meta-brain.js");
const DAY = 86400000;
const now = Date.now();

beforeEach(() => resetMocks());

test("гейт свежести: НЕ переподтверждённое ≥3 дней → снято (invalidated); переподтверждённое сегодня → живёт", async () => {
  kvSetJSON("taskagent:people", { owner: { chatId: 1 } });
  kvSetJSON("metabrain:config", { enabled: true, staleAfterDays: 3, maxPerDay: 5, digest: true });
  kvSetJSON("metabrain:proposals", [
    { id: "stale1", status: "confirmed", auto: true, confidence: "high", topicKey: "leads_no_call", fingerprint: "leads_no_call",
      title: "27 лидов без звонка", at: now - 6 * DAY, lastSeenAt: now - 4 * DAY, proposedTask: { title: "Обзвонить", recipient: "rop", why: "факт" } },
    { id: "fresh1", status: "confirmed", auto: true, confidence: "high", topicKey: "false_status", fingerprint: "false_status",
      title: "Ложные статусы", at: now - 6 * DAY, lastSeenAt: now - 4 * DAY, proposedTask: { title: "Поправить", recipient: "rop", why: "факт" } },
  ]);
  // Модель СЕГОДНЯ снова видит в данных только false_status (leads_no_call больше не всплывает — проблема ушла).
  setAnthropic(() => ({ content: [{ type: "text", text: JSON.stringify([
    { title: "Ложные статусы всё ещё есть", topicKey: "false_status", confidence: "high", statement: "видно в воронке", proposedTask: { title: "Поправить статусы", recipient: "rop", why: "факт" } },
  ]) }], stop_reason: "end_turn" }));
  await M.runDailyBrain("hunter", true);
  const props = kvGetJSON("metabrain:proposals");
  const stale = props.find((p) => p.id === "stale1");
  const fresh = props.find((p) => p.id === "fresh1");
  assert.equal(stale.status, "closed", "факт не подтверждён 4 дня → задача снята");
  assert.equal(stale.invalidated, true);
  assert.equal(stale.closeReason, "not_reproduced");
  assert.notEqual(fresh.status, "closed", "переподтверждён сегодня → остаётся в работе");
  assert.equal(fresh.lastSeenAt >= now - DAY, true, "lastSeenAt обновлён на сегодня");
});

test("гейт НЕ трогает свежее наблюдение того же дня (at=сегодня)", async () => {
  kvSetJSON("taskagent:people", { owner: { chatId: 1 } });
  kvSetJSON("metabrain:config", { enabled: true, staleAfterDays: 3, maxPerDay: 5, digest: true });
  kvSetJSON("metabrain:proposals", [
    { id: "today1", status: "confirmed", auto: true, confidence: "high", topicKey: "t1", fingerprint: "t1",
      title: "Свежая находка", at: now, lastSeenAt: now, proposedTask: { title: "Разобрать", recipient: "rop", why: "факт" } },
  ]);
  setAnthropic(() => ({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" }));
  await M.runDailyBrain("hunter", true);
  assert.notEqual(kvGetJSON("metabrain:proposals").find((p) => p.id === "today1").status, "closed");
});

test("getFreshInvalidatedMeta: отдаёт снятое с mb_-префиксом ОДИН раз (ropNotified), не трогает выполненные", async () => {
  kvSetJSON("metabrain:proposals", [
    { id: "x1", status: "closed", invalidated: true, ropNotified: false, title: "Проблема ушла", proposedTask: { title: "T" } },
    { id: "x2", status: "closed", closeReason: "rop_reported", title: "Выполнено РОПом" }, // НЕ invalidated → не подаём
  ]);
  const first = await M.getFreshInvalidatedMeta();
  assert.equal(first.length, 1);
  assert.equal(first[0].id, "mb_x1", "task-agent ждёт id в форме mb_<propId>");
  const second = await M.getFreshInvalidatedMeta();
  assert.equal(second.length, 0, "повторно не отдаём — ropNotified выставлен");
});

test("regateConfirmedMeta: confirmed+auto → pending (под гейт); confirmed вручную и pending не тронуты", async () => {
  kvSetJSON("metabrain:proposals", [
    { id: "a", status: "confirmed", auto: true, title: "Авто-раздан РОПу" },
    { id: "b", status: "confirmed", auto: false, title: "Подтверждён владельцем вручную" },
    { id: "c", status: "pending", title: "Ждёт" },
  ]);
  const r = await M.regateConfirmedMeta("hunter");
  assert.equal(r.regated, 1);
  const props = kvGetJSON("metabrain:proposals");
  assert.equal(props.find((p) => p.id === "a").status, "pending");
  assert.equal(props.find((p) => p.id === "a").auto, false);
  assert.equal(props.find((p) => p.id === "b").status, "confirmed", "ручное подтверждение владельца не откатываем");
  assert.equal(props.find((p) => p.id === "c").status, "pending");
});
