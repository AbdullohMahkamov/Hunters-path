// test/helpers.mjs — мок-окружение для тестов: Redis(KV)/Anthropic/Telegram/Meta через global.fetch.
// БЕЗ реальных вызовов Meta/amoCRM/Telegram/Anthropic. Env задаётся ДО импорта модулей (они читают его на загрузке).
process.env.UPSTASH_REDIS_REST_URL = "http://redis.mock";
process.env.UPSTASH_REDIS_REST_TOKEN = "tok";
process.env.ANTHROPIC_API_KEY = "sk-test";
process.env.CRON_SECRET = "cronsecret";
process.env.TELEGRAM_ROP_BOT_TOKEN = "ROPTOK";
process.env.TELEGRAM_OWNER_BOT_TOKEN = "OWNTOK";
process.env.TELEGRAM_MARKETING_BOT_TOKEN = "MKTTOK";
process.env.TELEGRAM_DIGEST_BOT_TOKEN = "DIGTOK";
process.env.USD_UZS_RATE = "12100";
process.env.NODE_ENV = "test";
// панель саппорта (изолированный модуль) — своё окружение
process.env.TELEGRAM_SUPPORT_BOT_TOKEN = "SUPTOK";
process.env.SUPPORT_TEAM_CHAT_ID = "teamchat1";
process.env.SUPPORT_STORAGE_CHAT_ID = "storechat1";
process.env.SUPPORT_SHEET_WEBHOOK_URL = "https://script.google.mock/exec";
process.env.TELEGRAM_WEBHOOK_SECRET = "whsecret";

export const kv = new Map();
export const tgCalls = [];
export const httpCalls = []; // прочие внешние POST (напр. Google Apps Script webhook архива)
let anthropicResponder = () => ({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: {} });
export function setAnthropic(fn) { anthropicResponder = fn; }
export function resetMocks() { kv.clear(); tgCalls.length = 0; httpCalls.length = 0; anthropicResponder = () => ({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: {} }); }
export function kvSetJSON(key, obj) { kv.set(key, JSON.stringify(obj)); }
export function kvGetJSON(key) { const v = kv.get(key); return v == null ? null : JSON.parse(v); }

function pathKey(u, seg) { const i = u.indexOf(seg); if (i < 0) return null; let rest = u.slice(i + seg.length); const q = rest.indexOf("?"); if (q >= 0) rest = rest.slice(0, q); return decodeURIComponent(rest); }

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("redis.mock")) {
    if (u.includes("/get/")) { const k = pathKey(u, "/get/"); return { ok: true, status: 200, json: async () => ({ result: kv.has(k) ? kv.get(k) : null }) }; }
    if (u.includes("/set/")) { const k = pathKey(u, "/set/"); kv.set(k, opts.body != null ? String(opts.body) : ""); return { ok: true, status: 200, json: async () => ({ result: "OK" }) }; }
    if (u.includes("/del/")) { const k = pathKey(u, "/del/"); kv.delete(k); return { ok: true, status: 200, json: async () => ({ result: 1 }) }; }
    if (u.includes("/expire/")) { return { ok: true, status: 200, json: async () => ({ result: 1 }) }; }
    return { ok: true, status: 200, json: async () => ({ result: null }) };
  }
  if (u.includes("api.anthropic.com")) { let body = {}; try { body = JSON.parse(opts.body || "{}"); } catch (e) {} const r = anthropicResponder(body); return { ok: true, status: 200, json: async () => r }; }
  if (u.includes("api.telegram.org")) {
    let b = null; try { b = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : null; } catch (e) {} // FormData (загрузка файла) не парсим
    tgCalls.push({ url: u, body: b });
    if (u.includes("/getMe")) return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: "SupportStudentBot" } }) };
    if (u.includes("/sendDocument")) return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: Math.floor(Math.random() * 1e9), document: { file_id: "fileid_" + Math.random().toString(36).slice(2, 10) } } }) };
    if (u.includes("/getWebhookInfo")) return { ok: true, status: 200, json: async () => ({ ok: true, result: { url: "" } }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: Math.floor(Math.random() * 1e9) } }) };
  }
  if (u.includes("graph.facebook.com")) return { ok: true, status: 200, json: async () => ({ data: [] }) };
  // прочие внешние POST (напр. Sheets Apps Script webhook) — записываем для ассертов
  if (opts && opts.method === "POST") { let b = null; try { b = opts.body ? JSON.parse(opts.body) : null; } catch (e) {} httpCalls.push({ url: u, body: b }); }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};

// Telegram-хелперы для ассертов
export function tgTo(tokenFragment) { return tgCalls.filter((c) => c.url.includes(`/bot${tokenFragment}/`)); }
export function tgSendCount(tokenFragment) { return tgCalls.filter((c) => c.url.includes(`/bot${tokenFragment}/sendMessage`)).length; }
