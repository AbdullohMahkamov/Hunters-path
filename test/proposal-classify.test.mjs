// Разделение предложений мозга по ЦЕНЕ ОШИБКИ: операционка ОП → авто РОПу; дорогое/условное/ненадёжное → владельцу.
import "./helpers.mjs";
import { classifyProposal } from "../api/meta-brain.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const P = (o) => ({ confidence: "high", proposedTask: { recipient: "rop" }, ...o });

test("операционка ОП (коучинг закрытия, tier2, РОП, надёжно) → РОПу автоматом", () => {
  assert.equal(classifyProposal(P({ title: "Разобрать с Komiljon схему закрытия без диагностики" })).to, "rop");
});

test("зависшие лиды / статусы (tier2, РОП) → РОПу", () => {
  assert.equal(classifyProposal(P({ title: "Обзвонить 27 зависших лидов без звонка" })).to, "rop");
  assert.equal(classifyProposal(P({ title: "Поправить ложные статусы в воронке" })).to, "rop");
});

test("юридический риск (tier3) → владельцу", () => {
  assert.equal(classifyProposal(P({ title: "Жалоба клиента, грозит суд по договору" })).to, "owner");
});

test("адресат маркетинг (деньги/канал) → владельцу, даже если revenue-тема", () => {
  assert.equal(classifyProposal(P({ title: "Поднять бюджет на аудиторию с высокой конверсией", proposedTask: { recipient: "marketing" } })).to, "owner");
});

test("ненадёжные данные (confidence low = suspicious/неполное окно) → владельцу", () => {
  assert.equal(classifyProposal(P({ title: "27 лидов без звонка", confidence: "low" })).to, "owner");
});

test("«пока не действовать» (contradiction) → владельцу", () => {
  assert.equal(classifyProposal(P({ title: "Сменить скрипт закрытия", contradiction: true })).to, "owner");
});

test("неясно (tier1, не revenue-тема) → по умолчанию владельцу, консервативно", () => {
  assert.equal(classifyProposal(P({ title: "Провести планёрку в офисе" })).to, "owner");
});
