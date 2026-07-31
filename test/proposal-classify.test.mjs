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

test("low-confidence операционка (один источник, не дырявые данные) → РОПу как «проверить/разобрать»", () => {
  const c = classifyProposal(P({ title: "27 лидов без звонка", confidence: "low" }));
  assert.equal(c.to, "rop");        // поправка 1: low ≠ владельцу
  assert.equal(c.verify, true);     // но формулировка «проверить/разобрать»
});

test("поправка 2: «договор» в технике продаж — НЕ юр.риск (tier2 по «сделк»), уходит РОПу", () => {
  assert.equal(classifyProposal(P({ title: "Менеджеры называют цену или договор раньше диагностики, сделки теряются" })).to, "rop");
});

test("compliance-обещание (гарантия трудоустройства) → РОП разбирает + инфо владельцу (rop_notify), НЕ кнопка согласования", () => {
  assert.equal(classifyProposal(P({ title: "Менеджеры обещают 100% гарантию трудоустройства — запрещено правилами компании" })).to, "rop_notify");
});

test("реальный юр.риск (жалоба/суд) остаётся у владельца, отдельно от compliance-обещаний", () => {
  assert.equal(classifyProposal(P({ title: "Клиент грозит жалобой и судом" })).to, "owner");
});

test("«пока не действовать» (contradiction) → none: вообще не в очереди решений (живёт как контекст в чате)", () => {
  assert.equal(classifyProposal(P({ title: "Сменить скрипт закрытия", contradiction: true })).to, "none");
});

test("настройка CRM/измерений («нельзя отличить выиграли/оплату») → владельцу: меняет условия, не работа с клиентами", () => {
  assert.equal(classifyProposal(P({ title: "В воронке нельзя отличить «выиграли» от «оплату получили»" })).to, "owner");
  assert.equal(classifyProposal(P({ title: "Настроить в amoCRM отдельный статус оплаты" })).to, "owner");
});

test("неясно (tier1, не revenue-тема) → по умолчанию владельцу, консервативно", () => {
  assert.equal(classifyProposal(P({ title: "Провести планёрку в офисе" })).to, "owner");
});
