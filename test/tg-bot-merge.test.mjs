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
