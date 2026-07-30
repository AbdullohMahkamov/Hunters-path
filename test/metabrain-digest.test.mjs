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
  assert.equal(M.impactTier(P({ title: "Штраф от налоговой за неоформленный договор" })), 3);         // genuine liability
  assert.equal(M.impactTier(P({ title: "Обещания 100% гарантии трудоустройства" })), 2);              // точность продаж, НЕ юр.риск
  assert.equal(M.impactTier(P({ title: "27 новых лидов без единой попытки звонка" })), 2);
  assert.equal(M.impactTier(P({ title: "103 лида с ложным статусом «не дозвонились»" })), 2);
  assert.equal(M.impactTier(P({ title: "Оформить единый шаблон приветствия" })), 1);
});

test("priorityScore: влияние доминирует, затем уверенность, затем возраст", () => {
  const legal = P({ title: "штраф от налоговой за договор", confidence: "low", at: now });
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

// ── СВОДКА ВЛАДЕЛЬЦУ БОЛЬШЕ НЕ ШЛЁТСЯ (убран слой «система рассказывает о наблюдениях») ──
// Предложения работают ВНУТРИ: накапливаются, советник видит их в чате, результат — задачи в отчёте по команде.
test("meta-brain НЕ шлёт сводку владельцу; предложения остаются внутри", async () => {
  setAnthropic(() => ({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" })); // новых наблюдений нет
  kvSetJSON("taskagent:people", { owner: { chatId: 333, lang: "ru" } });
  kvSetJSON("metabrain:proposals", [
    P({ id: "a", topicKey: "leads_no_call", title: "27 лидов без звонка", at: now - 5 * DAY }),
    P({ id: "b", topicKey: "false_status", title: "103 лида с ложным статусом", at: now - 4 * DAY }),
  ]);
  const r = await M.runDailyBrain("hunter", true);
  assert.equal(r.ok, true);
  assert.equal(r.delivered, false, "флаг доставки владельцу — false (не шлём)");
  const ownerMsgs = tgCalls.filter((c) => c.url.includes("/botOWNTOK/sendMessage") && c.body && c.body.chat_id === 333);
  assert.equal(ownerMsgs.length, 0, "владельцу ничего не ушло");
  const props = kvGetJSON("metabrain:proposals");
  assert.ok(props && props.length >= 2, "предложения не потеряны — работают как вход для задач");
});

test("meta-brain: без привязанного owner не падает и всё равно ничего не шлёт", async () => {
  setAnthropic(() => ({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" }));
  kvSetJSON("taskagent:people", {}); // owner НЕ привязан
  kvSetJSON("metabrain:proposals", [P({ id: "a", topicKey: "leads_no_call", title: "27 лидов без звонка", at: now - 5 * DAY })]);
  const r = await M.runDailyBrain("hunter", true);
  assert.equal(r.ok, true);
  assert.equal(r.delivered, false);
  assert.equal(tgCalls.filter((c) => c.url.includes("/botOWNTOK/sendMessage")).length, 0);
});

// ── САМО-ОТЗЫВ ЛОЖНОЙ adset-spend-находки (артефакт валют) ──
test("детектор ложной adset-spend-находки: срабатывает на mismatch, НЕ на легитимный расход", () => {
  assert.equal(M.isFalseAdsetSpendMismatch({ topicKey: "adset_spend_data_mismatch", title: "Расхождение расходов по аудиториям" }), true);
  assert.equal(M.isFalseAdsetSpendMismatch({ title: "Расходы по аудиториям не совпадают с общим" }), true);
  assert.equal(M.isFalseAdsetSpendMismatch({ title: "Высокий расход на аудиторию X без продаж" }), false); // легитимно, не mismatch
  assert.equal(M.isFalseAdsetSpendMismatch({ title: "27 лидов без звонка" }), false);
});

test("runDailyBrain само-отзывает ложную находку: закрывает предложение И задачу маркетологу", async () => {
  setAnthropic(() => ({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn" }));
  kvSetJSON("taskagent:people", { owner: { chatId: 333 } });
  kvSetJSON("metabrain:proposals", [
    P({ id: "false1", topicKey: "adset_spend_data_mismatch", title: "Расхождение расходов по аудиториям", at: now - 3 * DAY }),
    P({ id: "real1", topicKey: "leads_no_call", title: "27 лидов без звонка", at: now - 5 * DAY }),
  ]);
  kvSetJSON("marketingtasks", [
    { id: "mt1", title: "Проверить выгрузку расходов по аудиториям — не сходятся", status: "open" },
    { id: "mt2", title: "Обновить креативы", status: "open" },
  ]);
  await M.runDailyBrain("hunter", true);
  const props = kvGetJSON("metabrain:proposals");
  assert.equal(props.find((p) => p.id === "false1").status, "closed", "ложное предложение снято");
  assert.equal(props.find((p) => p.id === "real1").status, "pending", "реальное осталось");
  const mt = kvGetJSON("marketingtasks");
  assert.equal(mt.find((x) => x.id === "mt1").status, "done", "задача маркетологу отозвана");
  assert.equal(mt.find((x) => x.id === "mt2").status, "open", "прочие задачи не тронуты");
});
