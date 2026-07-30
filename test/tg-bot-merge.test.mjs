// Слияние ботов: РОП-бот обслуживает и маркетолога. Роль — по КОДУ при привязке и по chatId при сообщениях,
// а НЕ по вебхуку. Отдельный маркетинг-бот больше не обязателен. Владелец — отдельный бот (не трогаем).
import { resetMocks, kvSetJSON, kvGetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const tg = await import("../api/tg-bot.js");
const handler = tg.default;

const SECRET = "whsecret"; // helpers.mjs → TELEGRAM_WEBHOOK_SECRET
function webhook(bot, message) {
  return { method: "POST", query: { bot }, headers: { "x-telegram-bot-api-secret-token": SECRET }, body: { message } };
}
function mockRes() { return { _c: 0, _j: null, status(c) { this._c = c; return this; }, json(o) { this._j = o; return this; } }; }

beforeEach(() => { resetMocks(); kvSetJSON("taskagent:bindcode", { rop: "ROPCODE", owner: "OWNCODE", marketing: "MKTCODE" }); });

test("МАРКЕТОЛОГ привязывается через РОП-бот своим кодом (отдельный бот не нужен)", async () => {
  const res = mockRes();
  await handler(webhook("rop", { chat: { id: 777 }, text: "/start MKTCODE", from: { first_name: "Marketer" } }), res);
  assert.equal(res._j.bound, "marketing");
  assert.equal(kvGetJSON("taskagent:people").marketing.chatId, 777, "привязан как маркетолог, не РОП");
  assert.equal(kvGetJSON("taskagent:people").rop, undefined, "РОП не перезаписан");
});

test("РОП привязывается через РОП-бот своим кодом", async () => {
  const res = mockRes();
  await handler(webhook("rop", { chat: { id: 111 }, text: "/start ROPCODE", from: { first_name: "Rop" } }), res);
  assert.equal(res._j.bound, "rop");
  assert.equal(kvGetJSON("taskagent:people").rop.chatId, 111);
});

test("сообщение от маркетолога на РОП-боте маршрутизируется как маркетинг (по chatId, не по вебхуку)", async () => {
  kvSetJSON("taskagent:people", { marketing: { chatId: 777, lang: "ru" }, rop: { chatId: 111, lang: "ru" } });
  const res = mockRes();
  await handler(webhook("rop", { chat: { id: 777 }, text: "готово, бюджет поднял", from: { first_name: "Marketer" } }), res);
  assert.equal(res._j.stored, true, "принято и сохранено (не «вы не подключены»)");
  // сообщение легло в общий тред как роль marketing
  const chat = kvGetJSON("taskagent:chat") || [];
  assert.ok(chat.some((m) => m.role === "marketing"), "записано как маркетолог");
});

test("владельческий бот НЕ пускает чужой код (роль владельца изолирована)", async () => {
  const res = mockRes();
  await handler(webhook("owner", { chat: { id: 999 }, text: "/start ROPCODE", from: { first_name: "X" } }), res);
  assert.equal(res._j.bind, "bad_code", "код РОПа на бота владельца не привязывает");
  const ppl = kvGetJSON("taskagent:people") || {};
  assert.equal(ppl.rop, undefined);
  assert.equal(ppl.owner, undefined);
});

test("неизвестный код → не привязывает, просит корректный", async () => {
  const res = mockRes();
  await handler(webhook("rop", { chat: { id: 500 }, text: "/start WRONG", from: { first_name: "X" } }), res);
  assert.equal(res._j.bind, "bad_code");
  assert.equal(kvGetJSON("taskagent:people"), null);
});

test("reissue-codes: перевыпускает коды, не трогая привязки", async () => {
  kvSetJSON("session:S", { role: "admin" });
  kvSetJSON("taskagent:people", { owner: { chatId: 1 }, marketing: { chatId: 1 } }); // привязки на месте
  const res = mockRes();
  await handler({ method: "GET", query: { action: "reissue-codes", session: "S" }, headers: {}, body: {} }, res);
  assert.equal(res._j.ok, true);
  assert.ok(res._j.codes.rop && res._j.codes.marketing && res._j.codes.owner, "новые коды выданы");
  assert.notEqual(res._j.codes.rop, "ROPCODE", "код сменился");
  assert.deepEqual(kvGetJSON("taskagent:people").marketing, { chatId: 1 }, "привязки не тронуты");
});

test("combine-role: помечает и снимает осознанное совмещение", async () => {
  kvSetJSON("session:S", { role: "admin" });
  const r1 = mockRes();
  await handler({ method: "POST", query: {}, headers: {}, body: { action: "combine-role", role: "marketing", with: "owner", session: "S" } }, r1);
  assert.deepEqual(kvGetJSON("taskagent:rolecombine"), { marketing: "owner" });
  const r2 = mockRes();
  await handler({ method: "POST", query: {}, headers: {}, body: { action: "combine-role", role: "marketing", session: "S" } }, r2); // без with → снять
  assert.deepEqual(kvGetJSON("taskagent:rolecombine"), {});
});
