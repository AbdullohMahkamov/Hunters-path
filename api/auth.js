// /api/auth.js — вход по ролям. Админ: один пароль (дефолт 12345678). РОП: без пароля.
// Витринная версия для одного клиента. Данные общие (org=hunter).
import crypto from "crypto";

// Пароль админа берётся ТОЛЬКО из env ADMIN_PASSWORD (задан в Vercel prod).
// Дефолт "12345678" оставлен исключительно как аварийный fallback для локальной разработки:
// в проде без заданного ADMIN_PASSWORD вход админа блокируется, чтобы дефолт не стал дырой.
function adminPassword() {
  const pw = process.env.ADMIN_PASSWORD;
  if (pw) return pw;
  if (process.env.NODE_ENV === "production") return null; // в проде без env — входа нет
  return "12345678"; // только вне прода
}

async function redisSet(url, token, key, value, ttlSec) {
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  if (ttlSec) {
    await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSec}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}` },
    });
  }
  return r.ok;
}
async function redisGetJSON(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return d && d.result != null ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}

// ── ВАЛИДАЦИЯ Telegram initData (HMAC-SHA256 по токену бота) ──
// Доказывает: данные подписаны Telegram → это НАСТОЯЩИЙ пользователь Telegram. НЕ доказывает «это владелец» —
// роль решает allow-list по user.id ниже. Секрет = HMAC_SHA256(bot_token, "WebAppData"); hash = HMAC(data_check_string, секрет).
// Из строки проверки исключаем hash; на всякий случай (формат менялся: добавили поле signature) принимаем ЛЮБОЙ из двух
// вариантов — с signature в строке и без него. Плюс проверка свежести auth_date (по умолчанию 24 часа).
export function validateInitData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || !botToken) return { ok: false, error: "no_initdata" };
  let params;
  try { params = new URLSearchParams(initData); } catch (e) { return { ok: false, error: "bad_initdata" }; }
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "no_hash" };
  const entries = [];
  for (const [k, v] of params.entries()) { if (k === "hash") continue; entries.push([k, v]); } // значения уже URL-декодированы
  const build = (excludeSignature) => entries
    .filter(([k]) => !(excludeSignature && k === "signature"))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = (dcs) => crypto.createHmac("sha256", secret).update(dcs).digest("hex");
  const eq = (a, b) => { try { const ba = Buffer.from(a, "hex"), bb = Buffer.from(b, "hex"); return ba.length === bb.length && crypto.timingSafeEqual(ba, bb); } catch (e) { return false; } };
  const okHash = eq(calc(build(false)), hash) || eq(calc(build(true)), hash);
  if (!okHash) return { ok: false, error: "bad_hash" };
  const authDate = Number(params.get("auth_date") || 0);
  if (!authDate || (Date.now() / 1000 - authDate) > maxAgeSec) return { ok: false, error: "expired" };
  let user = null;
  try { user = JSON.parse(params.get("user") || "null"); } catch (e) { /* нет user */ }
  if (!user || user.id == null) return { ok: false, error: "no_user" };
  return { ok: true, user, authDate };
}

export default async function handler(req, res) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "Upstash env not set" }); return; }

  try {
    const { action, password, session } = req.body || {};

    // Проверка существующей сессии
    if (action === "check") {
      if (!session) { res.status(200).json({ ok: false }); return; }
      const r = await fetch(`${redisUrl}/get/session:${encodeURIComponent(session)}`, {
        headers: { Authorization: `Bearer ${redisToken}` },
      });
      const d = await r.json();
      if (!d || d.result == null) { res.status(200).json({ ok: false }); return; }
      const info = JSON.parse(d.result);
      res.status(200).json({ ok: true, ...info });
      return;
    }

    // Вход в демо-аккаунт по коду (6 цифр). Роль demo, своя org.
    if (action === "demo") {
      const code = String((req.body && req.body.code) || "").trim();
      const demos = (await (async () => {
        try {
          const r = await fetch(`${redisUrl}/get/demos:list`, { headers: { Authorization: `Bearer ${redisToken}` } });
          const d = await r.json();
          if (!d || d.result == null) return [];
          return JSON.parse(d.result);
        } catch (e) { return []; }
      })());
      const demo = demos.find(x => x.code === code);
      if (!demo) { res.status(200).json({ ok: false, error: "Неверный код демо-доступа" }); return; }
      const sessToken = crypto.randomBytes(24).toString("hex");
      const info = { role: "demo", org: demo.org, demoName: demo.name };
      await redisSet(redisUrl, redisToken, `session:${sessToken}`, JSON.stringify(info), 30 * 24 * 3600);
      res.status(200).json({ ok: true, session: sessToken, ...info });
      return;
    }

    // Вход из Telegram Mini App по initData. Валидный initData = «настоящий юзер Telegram», НЕ «владелец».
    // ALLOW-LIST — обязателен и ПЕРВЫМ: роль admin выдаём ТОЛЬКО если user.id совпадает с owner chatId из
    // taskagent:people. Иначе любой, открывший приложение, получил бы доступ к выручке/целям/задачам команды.
    if (action === "tg") {
      const initData = String((req.body && req.body.initData) || "");
      const botToken = process.env.TELEGRAM_OWNER_BOT_TOKEN;
      if (!botToken) { res.status(200).json({ ok: false, error: "Mini App не настроен (нет токена бота владельца)" }); return; }
      const v = validateInitData(initData, botToken);
      if (!v.ok) { res.status(200).json({ ok: false, error: "Telegram-авторизация не прошла" }); return; }
      const people = await redisGetJSON(redisUrl, redisToken, "taskagent:people");
      const ownerId = people && people.owner && people.owner.chatId;
      if (ownerId == null || String(v.user.id) !== String(ownerId)) {
        // валидный Telegram-юзер, но НЕ владелец → отказ (allow-list)
        res.status(200).json({ ok: false, error: "Доступ в приложение — только для владельца" });
        return;
      }
      const sessToken = crypto.randomBytes(24).toString("hex");
      const info = { role: "admin", org: "hunter", via: "telegram", tgUserId: v.user.id };
      await redisSet(redisUrl, redisToken, `session:${sessToken}`, JSON.stringify(info), 30 * 24 * 3600);
      res.status(200).json({ ok: true, session: sessToken, ...info });
      return;
    }

    // Вход админа по паролю (витрина hunter — как было)
    if (action === "admin") {
      const expected = adminPassword();
      if (!expected) { // прод без ADMIN_PASSWORD — вход закрыт, дефолт не работает
        res.status(200).json({ ok: false, error: "Вход админа не настроен (нет ADMIN_PASSWORD)" });
        return;
      }
      if ((password || "") !== expected) {
        res.status(200).json({ ok: false, error: "Неверный пароль" });
        return;
      }
      const sessToken = crypto.randomBytes(24).toString("hex");
      const info = { role: "admin", org: "hunter" };
      await redisSet(redisUrl, redisToken, `session:${sessToken}`, JSON.stringify(info), 30 * 24 * 3600);
      res.status(200).json({ ok: true, session: sessToken, ...info });
      return;
    }

    // Вход КЛИЕНТА (мультитенант): по логину org + паролю из реестра clients:list.
    // Каждый клиент — своя org, свои данные. Роль admin (владелец своего кабинета) или rop.
    if (action === "client") {
      const login = String((req.body && req.body.login) || "").trim().toLowerCase();
      const pass = String((req.body && req.body.password) || "");
      const clients = (await (async () => {
        try {
          const r = await fetch(`${redisUrl}/get/clients:list`, { headers: { Authorization: `Bearer ${redisToken}` } });
          const d = await r.json();
          return d && d.result != null ? JSON.parse(d.result) : [];
        } catch (e) { return []; }
      })());
      const c = clients.find(x => (x.login || "").toLowerCase() === login);
      if (!c || c.password !== pass) {
        res.status(200).json({ ok: false, error: "Неверный логин или пароль" });
        return;
      }
      const sessToken = crypto.randomBytes(24).toString("hex");
      const info = { role: c.role || "admin", org: c.org, clientName: c.name || c.org };
      await redisSet(redisUrl, redisToken, `session:${sessToken}`, JSON.stringify(info), 30 * 24 * 3600);
      res.status(200).json({ ok: true, session: sessToken, ...info });
      return;
    }

    // Вход МОПа: логин/пароль из реестра mops:accounts (создаёт админ).
    // Роль "mop", привязан к своему amoCRM mopId. Видит только свой кабинет.
    if (action === "mop") {
      const login = String((req.body && req.body.login) || "").trim().toLowerCase();
      const pass = String((req.body && req.body.password) || "");
      const accounts = (await (async () => {
        try {
          const r = await fetch(`${redisUrl}/get/mops:accounts`, { headers: { Authorization: `Bearer ${redisToken}` } });
          const d = await r.json();
          return d && d.result != null ? JSON.parse(d.result) : [];
        } catch (e) { return []; }
      })());
      const m = accounts.find(x => (x.login || "").toLowerCase() === login);
      if (!m || m.password !== pass) {
        res.status(200).json({ ok: false, error: "Неверный логин или пароль" });
        return;
      }
      const sessToken = crypto.randomBytes(24).toString("hex");
      const info = { role: "mop", org: m.org || "hunter", mopId: m.mopId, mopName: m.name, login: m.login };
      await redisSet(redisUrl, redisToken, `session:${sessToken}`, JSON.stringify(info), 30 * 24 * 3600);
      res.status(200).json({ ok: true, session: sessToken, ...info });
      return;
    }

    // Вход САППОРТА: логин/пароль из реестра support:accounts (создаёт админ в панели /support).
    // Роль "support" — доступ ТОЛЬКО к маршруту /support, не к дашборду/продажам/целям.
    if (action === "support") {
      const login = String((req.body && req.body.login) || "").trim().toLowerCase();
      const pass = String((req.body && req.body.password) || "");
      const accounts = (await (async () => {
        try {
          const r = await fetch(`${redisUrl}/get/support:accounts`, { headers: { Authorization: `Bearer ${redisToken}` } });
          const d = await r.json();
          return d && d.result != null ? JSON.parse(d.result) : [];
        } catch (e) { return []; }
      })());
      const a = accounts.find(x => (x.login || "").toLowerCase() === login);
      if (!a || a.password !== pass) {
        res.status(200).json({ ok: false, error: "Неверный логин или пароль" });
        return;
      }
      const sessToken = crypto.randomBytes(24).toString("hex");
      const info = { role: "support", org: "hunter", supportName: a.name || a.login, login: a.login };
      await redisSet(redisUrl, redisToken, `session:${sessToken}`, JSON.stringify(info), 30 * 24 * 3600);
      res.status(200).json({ ok: true, session: sessToken, ...info });
      return;
    }

    // Вход РОПа — по коду (защита от чужих)
    if (action === "rop") {
      const code = String((req.body && req.body.code) || "").trim();
      const ropCode = process.env.ROP_CODE || "1234567890";
      if (code !== ropCode) {
        res.status(200).json({ ok: false, error: "Неверный код" });
        return;
      }
      const sessToken = crypto.randomBytes(24).toString("hex");
      const info = { role: "rop", org: "hunter" };
      await redisSet(redisUrl, redisToken, `session:${sessToken}`, JSON.stringify(info), 30 * 24 * 3600);
      res.status(200).json({ ok: true, session: sessToken, ...info });
      return;
    }

    // Выход
    if (action === "logout") {
      if (session) {
        await fetch(`${redisUrl}/del/session:${encodeURIComponent(session)}`, {
          method: "POST", headers: { Authorization: `Bearer ${redisToken}` },
        });
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    res.status(500).json({ error: "auth failed", detail: String(err) });
  }
}
