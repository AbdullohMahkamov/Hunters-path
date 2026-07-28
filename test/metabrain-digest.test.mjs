// Разгрузка очереди решений (meta-brain): приоритет по влиянию, группировка, эскалация,
// протухание, фиксация доставки, и что старые pending попадают в сводку (не теряются).
import { resetMocks, kvSetJSON, kvGetJSON, tgCalls, setAnthropic } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const M = await import("../api/meta-brain.js");
const DAY = 86400000;
const now = Date.now();
const P = (over) => ({ id: over.id || ("p" + Math.random().toString(36).slice(2, 7)), status: "pending", confidence: "med", at: now, proposedTask: { title: "сделать" }, ...over });

beforeEach(() => resetMocks());

// ── ПРИОРИТЕТ (границы) ──
test("impactTier: юр.риск > выручка > прочее (детерминированно по смыслу)", () => {
  assert.equal(M.impactTier(P({ title: "Обещания 100% гарантии трудоустройства" })), 3);
  assert.equal(M.impactTier(P({ title: "27 новых лидов без единой попытки звонка" })), 2);
  assert.equal(M.impactTier(P({ title: "103 лида с ложным статусом «не дозвонились»" })), 2);
  assert.equal(M.impactTier(P({ title: "Оформить единый шаблон приветствия" })), 1);
});

test("priorityScore: влияние доминирует, затем уверенность, затем возраст", () => {
  const legal = P({ title: "гарантия трудоустройства", confidence: "low", at: now });
  const revHigh = P({ title: "лиды без звонка", confidence: "high", at: now });
  const revLow = P({ title: "лиды без звонка", confidence: "low", at: now });
  const revOld = P({ title: "лиды без звонка", confidence: "low", at: now - 10 * DAY });
  assert.ok(M.priorityScore(legal, now) > M.priorityScore(revHigh, now), "юр.риск (даже low) > выручка high");
  assert.ok(M.priorityScore(revHigh, now) > M.priorityScore(revLow, now), "внутри выручки: high > low");
  assert.ok(M.priorityScore(revOld, now) > M.priorityScore(revLow, now), "старее → выше (эскалация возрастом)");
});

// ── ЭСКАЛАЦИЯ ──
test("isEscalated: важное >=3д → эскалирует; свежее — нет; мелочь — никогда", () => {
  assert.equal(M.isEscalated(P({ title: "лиды без звонка", at: now - 4 * DAY }), now, 3), true);
  assert.equal(M.isEscalated(P({ title: "лиды без звонка", at: now - 2 * DAY }), now, 3), false);
  assert.equal(M.isEscalated(P({ title: "шаблон приветствия", at: now - 30 * DAY }), now, 3), false);
});

// ── ПРОТУХАНИЕ ──
test("expiryVerdict: мелочь старая → expire; важное старое → escalate (не протухает молча); свежее → keep", () => {
  const cfg = { escalateAfterDays: 3, expireAfterDays: 10 };
  assert.equal(M.expiryVerdict(P({ title: "шаблон приветствия", at: now - 11 * DAY }), now, cfg), "expire");
  assert.equal(M.expiryVerdict(P({ title: "шаблон приветствия", at: now - 5 * DAY }), now, cfg), "keep");
  assert.equal(M.expiryVerdict(P({ title: "лиды без звонка", at: now - 5 * DAY }), now, cfg), "escalate");
  assert.equal(M.expiryVerdict(P({ title: "лиды без звонка", at: now - 1 * DAY }), now, cfg), "keep");
});

// ── ГРУППИРОВКА ──
test("группировка: два предложения с одним topicKey → одна группа, count=2", () => {
  const props = [
    P({ topicKey: "closing_without_diagnostics", title: "Закрытие без диагностики у Бегойим" }),
    P({ topicKey: "closing_without_diagnostics", title: "Закрытие без диагностики у Самандара" }),
    P({ topicKey: "leads_no_call", title: "27 лидов без звонка" }),
  ];
  const dg = M.buildDigest(props, now, { escalateAfterDays: 3, expireAfterDays: 10 });
  const closing = dg.groups.find((g) => g.key === "closing_without_diagnostics");
  assert.equal(closing.count, 2);
  assert.equal(dg.groups.length, 2);
});

// ── СВОДКА РАЗДЕЛЯЕТ ПРОТУХШЕЕ ──
test("buildDigest: мелочь старая уходит в expired, важное остаётся в открытых", () => {
  const props = [
    P({ title: "шаблон приветствия", at: now - 11 * DAY }),           // minor old → expire
    P({ title: "27 лидов без звонка", at: now - 5 * DAY }),           // important old → keep (escalate)
    P({ title: "новая тема выручки: дожим сделок", at: now }),        // fresh → keep
  ];
  const dg = M.buildDigest(props, now, { escalateAfterDays: 3, expireAfterDays: 10 });
  assert.equal(dg.expired.length, 1);
  assert.equal(dg.totalOpen, 2);
});

// ── 13 PENDING НЕ ТЕРЯЮТСЯ ──
test("13 старых pending попадают в сводку (ни одно не потеряно)", () => {
  const props = [];
  for (let i = 0; i < 13; i++) props.push(P({ id: "old" + i, topicKey: "t" + i, title: "лиды без звонка " + i, at: now - 5 * DAY }));
  const dg = M.buildDigest(props, now, { escalateAfterDays: 3, expireAfterDays: 10 });
  const inGroups = dg.groups.reduce((n, g) => n + g.count, 0);
  assert.equal(dg.totalOpen, 13);
  assert.equal(inGroups, 13);
  assert.equal(dg.top.length, 3, "топ-3 для сводки");
});

// ── ДОСТАВКА ФИКСИРУЕТСЯ (через runDailyBrain) ──
test("доставка сводки фиксируется: lastdelivery.ok=true + сообщение владельцу", async () => {
  setAnthropic(() => ({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" })); // новых наблюдений нет
  kvSetJSON("taskagent:people", { owner: { chatId: 333, lang: "ru" } });
  kvSetJSON("metabrain:proposals", [
    P({ id: "a", topicKey: "leads_no_call", title: "27 лидов без звонка", at: now - 5 * DAY }),
    P({ id: "b", topicKey: "false_status", title: "103 лида с ложным статусом", at: now - 4 * DAY }),
  ]);
  const r = await M.runDailyBrain("hunter", true);
  assert.equal(r.ok, true);
  const ownerMsgs = tgCalls.filter((c) => c.url.includes("/botOWNTOK/sendMessage") && c.body && c.body.chat_id === 333);
  assert.ok(ownerMsgs.length >= 1, "сводка ушла владельцу");
  const del = kvGetJSON("metabrain:lastdelivery");
  assert.equal(del.ok, true);
  assert.ok(del.messageId, "messageId сохранён");
});

test("доставка НЕ молчит при сбое: owner не привязан → lastdelivery.ok=false", async () => {
  setAnthropic(() => ({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" }));
  kvSetJSON("taskagent:people", {}); // owner НЕ привязан
  kvSetJSON("metabrain:proposals", [P({ id: "a", topicKey: "leads_no_call", title: "27 лидов без звонка", at: now - 5 * DAY })]);
  await M.runDailyBrain("hunter", true);
  const del = kvGetJSON("metabrain:lastdelivery");
  assert.equal(del.ok, false);
  assert.ok(del.error, "причина сбоя доставки записана, а не проглочена");
});
