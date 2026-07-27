// /api/support.js — ПАНЕЛЬ САППОРТА (изолированный модуль, НЕ часть ALTRONE).
// Отправка оферты/правил ученикам через отдельного Telegram-бота, учёт подтверждений.
// НИЧЕГО не пишет в amoCRM. Свой префикс ключей Redis: support:*. Ботов владельца/РОПа не трогает.
//
// Источник правды — Redis (support:send:<id>). При подтверждении факт уходит в 3 адреса:
//   1) Redis (статус записи)  2) отдельная Telegram-группа команды  3) Google-таблица (Apps Script webhook).
//
// ENV (всё ОТДЕЛЬНОЕ, ничего не переиспользуем):
//   TELEGRAM_SUPPORT_BOT_TOKEN — бот для учеников (свой, не владельца/РОПа)
//   SUPPORT_TEAM_CHAT_ID       — НОВАЯ группа команды: туда падают ТОЛЬКО уведомления о подтверждениях
//   SUPPORT_STORAGE_CHAT_ID    — служебный чат (приватный канал с ботом): туда заливаем файлы ради file_id
//   SUPPORT_SHEET_WEBHOOK_URL  — Apps Script Web App (архив в таблицу)
//   TELEGRAM_WEBHOOK_SECRET    — общий секрет вебхука (уже есть)
import crypto from "crypto";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BOT_TOKEN = () => process.env.TELEGRAM_SUPPORT_BOT_TOKEN || "";
const TEAM_CHAT = () => process.env.SUPPORT_TEAM_CHAT_ID || "";
const STORAGE_CHAT = () => process.env.SUPPORT_STORAGE_CHAT_ID || "";
const SHEET_URL = () => process.env.SUPPORT_SHEET_WEBHOOK_URL || "";

export const K = {
  accounts: "support:accounts",
  templates: "support:templates",
  send: (id) => `support:send:${id}`,
  token: (t) => `support:token:${t}`,
  index: "support:sends:index",
  botUser: "support:botusername",
};

// ── Redis (REST) ──
async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function rset(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: String(v) }); return true; } catch (e) { return false; } }
async function rdel(key) { try { await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); } catch (e) {} }

async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function normPhone(s) { return String(s || "").replace(/\D/g, ""); }

// ── Telegram (бот учеников) ──
export async function tgSend(chatId, text, extra) {
  const token = BOT_TOKEN();
  if (!token || !chatId) return { ok: false, error: "no token or chatId" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true, ...(extra || {}) }),
    });
    const d = await r.json();
    return d && d.ok ? { ok: true, messageId: d.result && d.result.message_id } : { ok: false, error: (d && d.description) || "send failed" };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}
// отправка документа ученику по готовому file_id (без повторной заливки)
export async function tgSendDocumentById(chatId, fileId, caption) {
  const token = BOT_TOKEN();
  if (!token || !chatId || !fileId) return { ok: false, error: "no token/chatId/fileId" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, document: fileId, ...(caption ? { caption: String(caption).slice(0, 900) } : {}) }),
    });
    const d = await r.json();
    return d && d.ok ? { ok: true } : { ok: false, error: (d && d.description) || "send failed" };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}
// ЗАЛИВКА файла (base64) в СЛУЖЕБНЫЙ чат ради постоянного file_id. multipart через глобальные FormData/Blob (Node 18+).
export async function tgUploadToStorage(base64, filename) {
  const token = BOT_TOKEN();
  const chat = STORAGE_CHAT();
  if (!token || !chat) return { ok: false, error: "no token or storage chat" };
  try {
    const buf = Buffer.from(String(base64 || ""), "base64");
    const fd = new FormData();
    fd.append("chat_id", String(chat));
    fd.append("document", new Blob([buf]), filename || "file");
    const r = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: fd });
    const d = await r.json();
    const fileId = d && d.ok && d.result && d.result.document && d.result.document.file_id;
    return fileId ? { ok: true, fileId } : { ok: false, error: (d && d.description) || "upload failed" };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}
// username бота для deep-link (кэшируем, чтобы не дёргать getMe каждый раз)
export async function getBotUsername() {
  const cached = await rget(K.botUser);
  if (cached) return cached;
  const token = BOT_TOKEN();
  if (!token) return "";
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const d = await r.json();
    const u = d && d.ok && d.result && d.result.username;
    if (u) { await rset(K.botUser, u); return u; }
  } catch (e) {}
  return "";
}

// ── ШАБЛОНЫ ──
export async function getTemplates() {
  const t = await rgetJSON(K.templates, {});
  return { defaultText: t.defaultText || "", offer: t.offer || null, rules: t.rules || null };
}
// заменить файл шаблона (offer|rules) и/или дефолтный текст. Файл заливаем в служебный чат → file_id, версия +1.
export async function setTemplate({ key, base64, fileName, defaultText }) {
  const t = await rgetJSON(K.templates, {});
  if (defaultText != null) t.defaultText = String(defaultText).slice(0, 4000);
  if (key && (key === "offer" || key === "rules") && base64) {
    const up = await tgUploadToStorage(base64, fileName);
    if (!up.ok) return { ok: false, error: up.error || "не удалось загрузить файл" };
    const prevVer = (t[key] && t[key].version) || 0;
    t[key] = { fileId: up.fileId, name: fileName || key, version: prevVer + 1, updatedAt: Date.now() };
  }
  await rsetJSON(K.templates, t);
  return { ok: true, templates: { defaultText: t.defaultText || "", offer: t.offer || null, rules: t.rules || null } };
}

// ── ОТПРАВКИ ──
export async function createSend({ firstName, lastName, phone, docKeys, customFile, message, supportName }) {
  const id = "s_" + crypto.randomBytes(6).toString("hex");
  const token = crypto.randomBytes(16).toString("hex");
  const templates = await rgetJSON(K.templates, {});
  const docs = [];
  for (const key of (Array.isArray(docKeys) ? docKeys : [])) {
    const tpl = templates[key];
    if (tpl && tpl.fileId) docs.push({ key, name: tpl.name, version: tpl.version, fileId: tpl.fileId });
  }
  if (customFile && customFile.base64) {
    const up = await tgUploadToStorage(customFile.base64, customFile.name);
    if (!up.ok) return { ok: false, error: "не удалось приложить файл-исключение: " + (up.error || "") };
    docs.push({ key: "custom", name: customFile.name || "файл", version: null, fileId: up.fileId });
  }
  if (!docs.length) return { ok: false, error: "не выбран ни один документ" };
  const rec = {
    id, token,
    firstName: String(firstName || "").trim(), lastName: String(lastName || "").trim(), phone: String(phone || "").trim(),
    docs, message: String(message || "").slice(0, 4000), supportName: supportName || "",
    createdAt: Date.now(), status: "created", openedAt: null, confirmedAt: null, tg: null,
  };
  await rsetJSON(K.send(id), rec);
  await rset(K.token(token), id);
  const idx = await rgetJSON(K.index, []);
  idx.unshift(id);
  await rsetJSON(K.index, idx.slice(0, 5000));
  const botUser = await getBotUsername();
  const link = botUser ? `https://t.me/${botUser}?start=${token}` : `?start=${token}`;
  return { ok: true, id, token, link, docsCount: docs.length };
}

export async function findByToken(token) {
  const id = await rget(K.token(token));
  if (!id) return null;
  return await rgetJSON(K.send(id), null);
}

// ученик открыл бота — фиксируем «opened» (не понижаем статус, если уже confirmed)
export async function markOpened(token) {
  const rec = await findByToken(token);
  if (!rec) return null;
  if (rec.status === "created") { rec.status = "opened"; rec.openedAt = Date.now(); await rsetJSON(K.send(rec.id), rec); }
  return rec;
}

// ПОДТВЕРЖДЕНИЕ (идемпотентно): источник правды — ключ записи. Повтор не создаёт вторую запись и не шлёт второе уведомление.
export async function confirmSend(token, tgUser) {
  const rec = await findByToken(token);
  if (!rec) return { ok: false, error: "not_found" };
  if (rec.status === "confirmed") return { ok: true, already: true, rec };
  rec.status = "confirmed";
  rec.confirmedAt = Date.now();
  if (tgUser) rec.tg = { id: tgUser.id != null ? tgUser.id : null, username: tgUser.username || null };
  await rsetJSON(K.send(rec.id), rec);
  // 2) отдельная группа команды  3) архив в таблицу — только на ПЕРВОМ подтверждении
  await notifyTeam(rec);
  await archiveToSheet(rec);
  return { ok: true, already: false, rec };
}

async function notifyTeam(rec) {
  const chat = TEAM_CHAT();
  if (!chat) return;
  const who = `${esc(rec.firstName)} ${esc(rec.lastName)}`.trim();
  const files = rec.docs.map((d) => `${esc(d.name)}${d.version ? ` (v.${d.version})` : ""}`).join(", ");
  const when = new Date(rec.confirmedAt + 5 * 3600000).toISOString().replace("T", " ").slice(0, 16);
  const uname = rec.tg && rec.tg.username ? ` @${esc(rec.tg.username)}` : "";
  const text = `✅ <b>O'quvchi hujjatlarni tasdiqladi</b>\n\n👤 ${who}\n📞 ${esc(rec.phone)}\n🕒 ${when} (Toshkent)\n📄 ${files}${uname}\n🧑‍💼 Yuborgan: ${esc(rec.supportName || "—")}`;
  await tgSend(chat, text);
}

async function archiveToSheet(rec) {
  const url = SHEET_URL();
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        firstName: rec.firstName, lastName: rec.lastName, phone: rec.phone,
        tgId: rec.tg && rec.tg.id, tgUsername: rec.tg && rec.tg.username,
        confirmedAt: new Date(rec.confirmedAt + 5 * 3600000).toISOString(),
        files: rec.docs.map((d) => ({ name: d.name, version: d.version })),
        support: rec.supportName || "", sendId: rec.id,
      }),
    });
  } catch (e) { /* архив не критичен для подтверждения — Redis уже зафиксировал */ }
}

// экран «Отправки»: новые сверху + фильтр по статусу + поиск по телефону
export async function listSends({ status, phone, limit } = {}) {
  const idx = await rgetJSON(K.index, []);
  const ids = idx.slice(0, limit || 500);
  const recs = await Promise.all(ids.map((id) => rgetJSON(K.send(id), null)));
  let items = recs.filter(Boolean);
  if (status && status !== "all") items = items.filter((r) => r.status === status);
  if (phone) { const q = normPhone(phone); if (q) items = items.filter((r) => normPhone(r.phone).includes(q)); }
  return items.map((r) => ({
    id: r.id, firstName: r.firstName, lastName: r.lastName, phone: r.phone,
    status: r.status, createdAt: r.createdAt, openedAt: r.openedAt, confirmedAt: r.confirmedAt,
    supportName: r.supportName, docs: r.docs.map((d) => ({ name: d.name, version: d.version })),
    link: r.token ? "?start=" + r.token : null,
  }));
}

// ── АККАУНТЫ САППОРТОВ (только админ) ──
export async function listAccounts() { const a = await rgetJSON(K.accounts, []); return a.map((x) => ({ login: x.login, name: x.name })); }
export async function addAccount({ login, password, name }) {
  login = String(login || "").trim().toLowerCase();
  if (!login || !password) return { ok: false, error: "нужны логин и пароль" };
  const a = await rgetJSON(K.accounts, []);
  if (a.find((x) => (x.login || "").toLowerCase() === login)) return { ok: false, error: "такой логин уже есть" };
  a.push({ login, password: String(password), name: String(name || login) });
  await rsetJSON(K.accounts, a);
  return { ok: true };
}
export async function delAccount(login) {
  login = String(login || "").trim().toLowerCase();
  const a = await rgetJSON(K.accounts, []);
  await rsetJSON(K.accounts, a.filter((x) => (x.login || "").toLowerCase() !== login));
  return { ok: true };
}

// ── PANEL API (гейт по сессии: роль support или admin; аккаунты — только admin) ──
export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "Upstash env not set" }); return; }
  const body = req.body || {};
  const q = req.query || {};
  const action = body.action || q.action || "";
  const session = body.session || q.session || "";
  const sess = await getSession(session);
  if (!sess || (sess.role !== "support" && sess.role !== "admin")) { res.status(200).json({ ok: false, error: "нет доступа" }); return; }
  const isAdmin = sess.role === "admin";

  try {
    if (action === "templates-get") { res.status(200).json({ ok: true, templates: await getTemplates() }); return; }
    if (action === "templates-set") { res.status(200).json(await setTemplate(body)); return; }
    if (action === "create") {
      const r = await createSend({ ...body, supportName: sess.supportName || sess.login || "саппорт" });
      res.status(200).json(r); return;
    }
    if (action === "list") { res.status(200).json({ ok: true, items: await listSends({ status: body.status || q.status, phone: body.phone || q.phone }) }); return; }
    // аккаунты — только админ
    if (action === "accounts-list") { if (!isAdmin) { res.status(200).json({ ok: false, error: "только админ" }); return; } res.status(200).json({ ok: true, accounts: await listAccounts() }); return; }
    if (action === "account-add") { if (!isAdmin) { res.status(200).json({ ok: false, error: "только админ" }); return; } res.status(200).json(await addAccount(body)); return; }
    if (action === "account-del") { if (!isAdmin) { res.status(200).json({ ok: false, error: "только админ" }); return; } res.status(200).json(await delAccount(body.login)); return; }
    res.status(400).json({ ok: false, error: "unknown action" });
  } catch (err) {
    res.status(500).json({ ok: false, error: "support failed", detail: String(err).slice(0, 200) });
  }
}
