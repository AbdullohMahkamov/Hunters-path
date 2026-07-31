// runTick: пинг уходит ПРАВИЛЬНОМУ получателю (rop vs marketing) и НЕ уходит непривязанному.
import { resetMocks, kvSetJSON, setAnthropic, tgCalls } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

function pingJSON() { return { content: [{ type: "text", text: JSON.stringify({ question: "Какой статус?", needsDetail: false, hintHeader: "", checklist: [] }) }], stop_reason: "end_turn" }; }

beforeEach(() => {
  resetMocks();
  setAnthropic(() => pingJSON()); // composePing → валидный JSON пинга
  kvSetJSON("taskagent:config", { enabled: true, pingFromHour: 0, escalationHour: 23, remindBeforeDays: 99, escalationGraceMin: 90 });
  kvSetJSON("taskagent:status", {});
  kvSetJSON("taskagent:chat", []);
  kvSetJSON("appdata:hunter", { customPlan: { sales: [{ id: "s1", t: "Продажная задача", d: "w", deadline: "" }] }, done: {} });
  kvSetJSON("marketingtasks", [{ id: "mk1", title: "Маркетинг-задача", status: "open" }]);
});

test("runTick: продажная задача → РОП-бот, маркетинг-задача → маркетинг-бот", async () => {
  const T = await import("../api/task-agent.js");
  kvSetJSON("taskagent:people", { rop: { chatId: 111, lang: "ru" }, marketing: { chatId: 222, lang: "ru" }, owner: { chatId: 333, lang: "ru" } });
  await T.runTick(true); // force → пингуем независимо от часа
  const ropSends = tgCalls.filter((c) => c.url.includes("/botROPTOK/sendMessage"));
  const mktSends = tgCalls.filter((c) => c.url.includes("/botMKTTOK/sendMessage"));
  assert.ok(ropSends.length >= 1, "продажная задача ушла в РОП-бот");
  assert.ok(mktSends.length >= 1, "маркетинг-задача ушла в маркетинг-бот");
  // маркетинг-пинг ушёл именно в чат маркетолога
  assert.equal(mktSends[0].body.chat_id, 222);
  assert.equal(ropSends[0].body.chat_id, 111);
});

test("runTick: КАП metabrain — из 6 подтверждённых наблюдений РОПу за день пингуется только 3", async () => {
  const T = await import("../api/task-agent.js");
  kvSetJSON("taskagent:people", { rop: { chatId: 111, lang: "ru" }, owner: { chatId: 333, lang: "ru" } });
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} }); // без плановых задач — считаем только metabrain
  kvSetJSON("marketingtasks", []);
  kvSetJSON("taskagent:config", { enabled: true, pingFromHour: 0, escalationHour: 23, remindBeforeDays: 99, escalationGraceMin: 90, metaPingsPerDay: 3 });
  const props = [];
  for (let i = 0; i < 6; i++) props.push({ id: "m" + i, status: "confirmed", auto: true, confidence: "high",
    title: "Лиды без звонка " + i, proposedTask: { title: "Обзвонить " + i, recipient: "rop", why: "факт" } });
  kvSetJSON("metabrain:proposals", props);
  await T.runTick(true);
  const ropSends = tgCalls.filter((c) => c.url.includes("/botROPTOK/sendMessage"));
  assert.equal(ropSends.length, 3, "кап metaPingsPerDay=3: не заваливаем РОПа десятком задач разом");
});

test("runTick: маркетолог НЕ привязан → маркетинг-задача НЕ уходит (нет получателя)", async () => {
  const T = await import("../api/task-agent.js");
  kvSetJSON("taskagent:people", { rop: { chatId: 111, lang: "ru" }, owner: { chatId: 333, lang: "ru" } }); // marketing НЕ привязан
  await T.runTick(true);
  const mktSends = tgCalls.filter((c) => c.url.includes("/botMKTTOK/sendMessage"));
  assert.equal(mktSends.length, 0, "без привязки маркетолога задача физически не отправляется");
});
