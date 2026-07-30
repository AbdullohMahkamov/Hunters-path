// pt2: межканальная идемпотентность. Подтверждение плана/предложения через ОДИН обработчик
// (chat → advisor-act и Telegram → tg-bot зовут его же) → повтор из другого канала = no-op, без дублей.
import { resetMocks, kvSetJSON, kvGetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const planner = await import("../api/planner.js");
const mb = await import("../api/meta-brain.js");

beforeEach(() => resetMocks());

test("ПЛАН: подтвердил (канал 1) → задачи созданы, pending снят; повтор (канал 2) = «план не найден», без дублей", async () => {
  kvSetJSON("goal:hunter", { amountUZS: 150000000, period: { label: "июль 2026" } });
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", []);
  kvSetJSON("planner:pending:hunter", {
    periodKey: "июль 2026", at: Date.now(),
    plan: { facts: { gap: 30000000 }, tasks: {
      rop: [{ title: "Дожать тёплых лидов", topicKey: "rop_conversion", why: "разрыв", step: "обзвон" }],
      marketing: [{ title: "Поднять лиды в TASHKENT", why: "мало лидов", step: "бюджет" }],
    } },
  });

  // КАНАЛ 1 (чат): подтверждение
  const r1 = await planner.handlePlanButton("confirm");
  assert.ok(r1.triggerTick, "подтверждение просит запустить Task Agent");
  const app1 = kvGetJSON("appdata:hunter");
  const mk1 = kvGetJSON("marketingtasks");
  assert.equal(app1.customPlan.sales.length, 1, "РОП-задача создана");
  assert.equal(mk1.length, 1, "маркетинг-задача создана");
  assert.equal(kvGetJSON("planner:pending:hunter"), null, "pending снят");
  const active = kvGetJSON("planner:active:hunter");
  assert.ok(active && active.taskIds, "active с taskIds — план ведётся");
  assert.equal(kvGetJSON("goal:hunter").planBuiltFor, "июль 2026", "planBuiltFor заполнен");

  // КАНАЛ 2 (Telegram-кнопка осталась живой): повтор того же подтверждения
  const r2 = await planner.handlePlanButton("confirm");
  assert.equal(r2.toast, "план не найден", "повтор из другого канала — no-op");
  assert.equal(kvGetJSON("appdata:hunter").customPlan.sales.length, 1, "НЕТ дубля РОП-задачи");
  assert.equal(kvGetJSON("marketingtasks").length, 1, "НЕТ дубля маркетинг-задачи");
});

test("ПРЕДЛОЖЕНИЕ МОЗГА: подтвердил (канал 1) → status confirmed; повтор (канал 2) = «уже обработано»", async () => {
  kvSetJSON("taskagent:people", { rop: { chatId: 111 } });
  kvSetJSON("metabrain:proposals", [
    { id: "p1", status: "pending", fingerprint: "fp1", title: "27 лидов без звонка", proposedTask: { title: "обзвонить", recipient: "rop" } },
  ]);
  const r1 = await mb.handleMetaButton("confirm", "p1", "host");
  assert.equal(r1.ok, true);
  assert.equal(kvGetJSON("metabrain:proposals").find((p) => p.id === "p1").status, "confirmed");

  const r2 = await mb.handleMetaButton("confirm", "p1", "host");
  assert.equal(r2.toast, "уже обработано", "повтор из другого канала — no-op");
  // статус не изменился повторно (остался confirmed, не двойная обработка)
  assert.equal(kvGetJSON("metabrain:proposals").find((p) => p.id === "p1").status, "confirmed");
});

test("ОТЗЫВ ЗАДАЧИ: план-режим proposePlan не шлёт в Telegram (channel=chat)", async () => {
  kvSetJSON("goal:hunter", { amountUZS: 150000000, period: { label: "июль 2026", start: "2026-07-01", end: "2026-07-31" } });
  // без funnel данных proposePlan вернёт not-ok, но ГЛАВНОЕ — в chat-режиме НЕ шлёт Telegram
  const { tgCalls } = await import("./helpers.mjs");
  tgCalls.length = 0;
  await planner.proposePlan("hunter", true, { channel: "chat" });
  const ownerSends = tgCalls.filter((c) => c.url.includes("/botOWNTOK/sendMessage"));
  assert.equal(ownerSends.length, 0, "chat-режим НЕ дублирует план в Telegram");
});
