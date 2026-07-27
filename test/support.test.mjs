// Панель саппорта: токен привязан к своей записи, идемпотентность подтверждения,
// доставка подтверждения во все 3 места, понятная ошибка на битом токене.
import { resetMocks, tgCalls, httpCalls, kvGetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const S = await import("../api/support.js");
const bot = (await import("../api/support-bot.js")).default;

// мок req/res для хендлера вебхука
function makeRes() {
  const res = { statusCode: 0, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.write = () => {}; res.end = () => {};
  return res;
}

async function seedTemplates() {
  await S.setTemplate({ key: "offer", base64: Buffer.from("OFERTA-PDF").toString("base64"), fileName: "oferta.pdf" });
  await S.setTemplate({ key: "rules", base64: Buffer.from("RULES-PDF").toString("base64"), fileName: "qoidalar.pdf", defaultText: "Ассалому алайкум! Танишиб чиқинг." });
}

beforeEach(() => resetMocks());

test("токен привязан к СВОЕЙ записи; чужой/битый токен её не открывает", async () => {
  await seedTemplates();
  const a = await S.createSend({ firstName: "Али", lastName: "Валиев", phone: "+998901112233", docKeys: ["offer", "rules"], message: "текст A", supportName: "s1" });
  const b = await S.createSend({ firstName: "Бек", lastName: "Каримов", phone: "+998907778899", docKeys: ["offer"], message: "текст B", supportName: "s1" });
  assert.ok(a.ok && b.ok);
  assert.notEqual(a.token, b.token);

  const recA = await S.findByToken(a.token);
  const recB = await S.findByToken(b.token);
  assert.equal(recA.id, a.id);
  assert.equal(recB.id, b.id);
  assert.equal(recA.firstName, "Али");
  assert.notEqual(recA.id, recB.id, "токен A не открывает запись B");
  // битый токен → null, не падение
  assert.equal(await S.findByToken("garbage-token"), null);
});

test("подтверждение уходит во ВСЕ ТРИ места: Redis + группа команды + Google-таблица", async () => {
  await seedTemplates();
  const a = await S.createSend({ firstName: "Али", lastName: "Валиев", phone: "+998901112233", docKeys: ["offer", "rules"], message: "t", supportName: "Диля" });
  tgCalls.length = 0; httpCalls.length = 0;

  const r = await S.confirmSend(a.token, { id: 55501, username: "ali_v" });
  assert.equal(r.ok, true);
  assert.equal(r.already, false);

  // 1) Redis — статус записи обновлён
  const rec = await S.findByToken(a.token);
  assert.equal(rec.status, "confirmed");
  assert.ok(rec.confirmedAt > 0);
  assert.equal(rec.tg.id, 55501);
  assert.equal(rec.tg.username, "ali_v");

  // 2) отдельная группа команды (бот саппорта, chat_id = SUPPORT_TEAM_CHAT_ID)
  const teamMsgs = tgCalls.filter((c) => c.url.includes("/botSUPTOK/sendMessage") && c.body && String(c.body.chat_id) === "teamchat1");
  assert.equal(teamMsgs.length, 1, "ровно одно уведомление в группу команды");

  // 3) Google-таблица (Apps Script webhook)
  const sheet = httpCalls.filter((c) => c.url.includes("script.google.mock"));
  assert.equal(sheet.length, 1, "ровно одна запись в таблицу-архив");
  assert.equal(sheet[0].body.sendId, a.id);
  assert.equal(sheet[0].body.phone, "+998901112233");
});

test("повторное подтверждение НЕ создаёт вторую запись и НЕ шлёт второе уведомление", async () => {
  await seedTemplates();
  const a = await S.createSend({ firstName: "Али", lastName: "Валиев", phone: "+998901112233", docKeys: ["offer"], message: "t", supportName: "s1" });
  const idxBefore = kvGetJSON("support:sends:index").length;

  await S.confirmSend(a.token, { id: 1, username: "u" });
  tgCalls.length = 0; httpCalls.length = 0;

  const r2 = await S.confirmSend(a.token, { id: 1, username: "u" });
  assert.equal(r2.ok, true);
  assert.equal(r2.already, true, "повтор помечен как already");

  // индекс не вырос (нет второй записи)
  assert.equal(kvGetJSON("support:sends:index").length, idxBefore);
  // второго уведомления/архива не было
  assert.equal(tgCalls.filter((c) => c.url.includes("/botSUPTOK/sendMessage")).length, 0);
  assert.equal(httpCalls.filter((c) => c.url.includes("script.google.mock")).length, 0);
});

test("битый/чужой токен → понятная ошибка (not_found), а не падение", async () => {
  const r = await S.confirmSend("nope-nope", { id: 1 });
  assert.equal(r.ok, false);
  assert.equal(r.error, "not_found");
  assert.equal(await S.markOpened("nope-nope"), null);
});

test("вебхук бота: /start с чужим токеном отвечает понятным сообщением, не падает", async () => {
  const res = makeRes();
  const req = { method: "POST", query: {}, headers: { "x-telegram-bot-api-secret-token": "whsecret" }, body: { message: { chat: { id: 900 }, text: "/start bad-token" } } };
  await bot(req, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.notFound, true);
  // ученику ушёл узбекский текст об ошибке
  const toStudent = tgCalls.filter((c) => c.url.includes("/botSUPTOK/sendMessage") && c.body && String(c.body.chat_id) === "900");
  assert.ok(toStudent.length >= 1);
});

test("вебхук бота: кнопка подтверждения идемпотентна (второй тап = already)", async () => {
  await seedTemplates();
  const a = await S.createSend({ firstName: "Али", lastName: "В", phone: "+998900000000", docKeys: ["offer"], message: "t", supportName: "s1" });
  const mkCb = () => ({ method: "POST", query: {}, headers: { "x-telegram-bot-api-secret-token": "whsecret" }, body: { callback_query: { id: "cb1", data: `sup:ok:${a.token}`, from: { id: 77, username: "ali" }, message: { message_id: 5, chat: { id: 900 } } } } });

  const res1 = makeRes(); await bot(mkCb(), res1);
  assert.equal(res1.body.confirmed, true);
  const res2 = makeRes(); await bot(mkCb(), res2);
  assert.equal(res2.body.confirmed, false, "второй тап не подтверждает заново");

  // ровно одно уведомление команде за оба тапа
  assert.equal(tgCalls.filter((c) => c.url.includes("/botSUPTOK/sendMessage") && c.body && String(c.body.chat_id) === "teamchat1").length, 1);
});
