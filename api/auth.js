// /api/auth.js — вход по ролям. Админ: один пароль (дефолт 12345678). РОП: без пароля.
// Витринная версия для одного клиента. Данные общие (org=hunter).
import crypto from "crypto";

// Дефолтный пароль админа. Можно переопределить переменной ADMIN_PASSWORD в Vercel.
function adminPassword() {
  return process.env.ADMIN_PASSWORD || "12345678";
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

    // Вход админа по паролю (витрина hunter — как было)
    if (action === "admin") {
      if ((password || "") !== adminPassword()) {
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
