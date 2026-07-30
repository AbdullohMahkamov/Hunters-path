// Telegram Mini App вход: валидный initData доказывает «настоящий юзер Telegram», НЕ «владелец».
// Роль admin — ТОЛЬКО при совпадении user.id с owner chatId (allow-list). Плюс подпись и свежесть auth_date.
import { resetMocks, kvSetJSON, kvGetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const authMod = await import("../api/auth.js");
const handler = authMod.default;
const { validateInitData } = authMod;

const TOKEN = "OWNTOK"; // helpers.mjs выставляет TELEGRAM_OWNER_BOT_TOKEN=OWNTOK

// Подписываем initData как это делает Telegram: секрет=HMAC(token,"WebAppData"), hash=HMAC(dcs,секрет).
function signInitData(token, fields) {
  const entries = Object.entries(fields);
  const dcs = entries.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
  const hash = crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  const p = new URLSearchParams();
  for (const [k, v] of entries) p.set(k, v);
  p.set("hash", hash);
  return p.toString();
}
const nowSec = () => Math.floor(Date.now() / 1000);
function mockRes() { return { _c: 0, _j: null, status(c) { this._c = c; return this; }, json(o) { this._j = o; return this; } }; }

beforeEach(() => resetMocks());

test("validateInitData: корректная подпись → ok + user; подделка → bad_hash", () => {
  const initData = signInitData(TOKEN, { user: JSON.stringify({ id: 555, first_name: "Egasi" }), auth_date: String(nowSec()) });
  const v = validateInitData(initData, TOKEN);
  assert.equal(v.ok, true);
  assert.equal(v.user.id, 555);

  const tampered = initData.replace(/hash=[a-f0-9]+/, "hash=" + "0".repeat(64));
  assert.equal(validateInitData(tampered, TOKEN).ok, false);
  // чужой токен тоже не проходит
  assert.equal(validateInitData(initData, "WRONGTOKEN").ok, false);
});

test("validateInitData: устаревший auth_date → expired", () => {
  const initData = signInitData(TOKEN, { user: JSON.stringify({ id: 555 }), auth_date: String(nowSec() - 2 * 86400) });
  const v = validateInitData(initData, TOKEN);
  assert.equal(v.ok, false);
  assert.equal(v.error, "expired");
});

test("validateInitData: подпись валидна даже когда присутствует поле signature", () => {
  const initData = signInitData(TOKEN, { user: JSON.stringify({ id: 555 }), auth_date: String(nowSec()), signature: "abc123" });
  assert.equal(validateInitData(initData, TOKEN).ok, true);
});

test("ALLOW-LIST: user.id == owner chatId → сессия admin", async () => {
  kvSetJSON("taskagent:people", { owner: { chatId: 555 }, rop: { chatId: 42 } });
  const initData = signInitData(TOKEN, { user: JSON.stringify({ id: 555, first_name: "Egasi" }), auth_date: String(nowSec()) });
  const res = mockRes();
  await handler({ method: "POST", body: { action: "tg", initData } }, res);
  assert.equal(res._j.ok, true);
  assert.equal(res._j.role, "admin");
  assert.equal(res._j.via, "telegram");
  assert.ok(res._j.session, "выдан токен сессии");
  assert.ok(kvGetJSON(`session:${res._j.session}`), "сессия записана в Redis");
});

test("ALLOW-LIST: валидный Telegram-юзер, но НЕ владелец → отказ, сессии нет", async () => {
  kvSetJSON("taskagent:people", { owner: { chatId: 555 } });
  const initData = signInitData(TOKEN, { user: JSON.stringify({ id: 999, first_name: "Chujoy" }), auth_date: String(nowSec()) });
  const res = mockRes();
  await handler({ method: "POST", body: { action: "tg", initData } }, res);
  assert.equal(res._j.ok, false);
  assert.match(res._j.error, /только для владельца/i);
  assert.equal(res._j.session, undefined, "никакой сессии постороннему");
});

test("ALLOW-LIST: подделанный initData не пускает даже с правильным id", async () => {
  kvSetJSON("taskagent:people", { owner: { chatId: 555 } });
  const good = signInitData(TOKEN, { user: JSON.stringify({ id: 555 }), auth_date: String(nowSec()) });
  const forged = good.replace(/hash=[a-f0-9]+/, "hash=" + "0".repeat(64));
  const res = mockRes();
  await handler({ method: "POST", body: { action: "tg", initData: forged } }, res);
  assert.equal(res._j.ok, false);
  assert.match(res._j.error, /авторизация не прошла/i);
});
