// /api/telegram-send.js — БЕЗОПАСНАЯ отправка сообщений сегменту (реактивация базы).
// Жёсткий лимит: максимум DAILY_LIMIT сообщений в сутки, чтобы аккаунт НЕ забанили за спам.
// POST { session, action:"send", segment, template, count } — отправить count сообщений (<=лимит).
// GET  ?action=quota&session=... — сколько ещё можно отправить сегодня.
// Admin only.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DAILY_LIMIT = 25;        // максимум в сутки (защита от бана)
const DELAY_MS = 3000;         // пауза между сообщениями (3 сек — по-человечески)

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json(); return d && d.result ? d.result : null;
}
async function redisSet(key, value, ttl) {
  let url = `${REDIS_URL}/set/${encodeURIComponent(key)}`;
  if (ttl) url += `?EX=${ttl}`;
  await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: value });
}
async function getSession(session) {
  if (!session) return null;
  try { const raw = await redisGet(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function todayKey(org) {
  const d = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10);
  return `tgsent:${org}:${d}`;
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const sess = await getSession(session);
  if (!sess || sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }
  const org = sess.org || "hunter";

  try {
    // сколько уже отправлено сегодня
    const sentToday = parseInt((await redisGet(todayKey(org))) || "0", 10) || 0;
    const remaining = Math.max(0, DAILY_LIMIT - sentToday);

    if (req.query && req.query.action === "quota") {
      res.status(200).json({ ok: true, daily_limit: DAILY_LIMIT, sent_today: sentToday, remaining });
      return;
    }

    if (req.method === "POST" && req.body && req.body.action === "send") {
      if (!BOT_TOKEN) { res.status(500).json({ error: "no bot token" }); return; }
      const { recipients, template } = req.body; // recipients:[{id,name}], template с {name}
      if (!Array.isArray(recipients) || !recipients.length) { res.status(400).json({ error: "no recipients" }); return; }
      if (!template) { res.status(400).json({ error: "no template" }); return; }

      // не даём превысить дневной лимит
      const toSend = recipients.slice(0, remaining);
      if (!toSend.length) {
        res.status(200).json({ ok: true, sent: 0, blocked: true, reason: `Дневной лимит ${DAILY_LIMIT} исчерпан. Продолжите завтра — так безопасно для аккаунта.` });
        return;
      }

      // получаем business_connection_id (нужен для отправки от имени бизнес-аккаунта)
      const conn = JSON.parse((await redisGet("tg:connection")) || "{}");
      const connId = conn.connection_id;
      // проверяем разрешение на отправку
      if (!connId) {
        res.status(200).json({ ok: false, sent: 0, error: "no_connection",
          message: "Бот не подключён к бизнес-аккаунту. Подключите: Telegram → Настройки → Telegram для бизнеса → Чат-боты → добавьте бота." });
        return;
      }
      if (conn.can_reply === false) {
        res.status(200).json({ ok: false, sent: 0, error: "no_permission",
          message: "У бота НЕТ разрешения отправлять сообщения. Включите: Telegram → Настройки → Telegram для бизнеса → Чат-боты → ваш бот → разрешите «Отвечать на сообщения» (Reply to messages)." });
        return;
      }

      let sent = 0, errors = [];
      let permissionError = false;
      for (const r of toSend) {
        const text = template.replace(/\{name\}/g, (r.name || "").split(" ")[0] || "");
        try {
          const body = { chat_id: r.id, text, business_connection_id: connId };
          const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
          });
          const jd = await resp.json();
          if (jd.ok) sent++;
          else {
            const desc = (jd.description || "").toLowerCase();
            if (desc.includes("not enough rights") || desc.includes("no rights") || desc.includes("not allowed") || desc.includes("can't") || desc.includes("forbidden")) permissionError = true;
            errors.push({ id: r.id, err: (jd.description || "").slice(0, 100) });
          }
        } catch (e) { errors.push({ id: r.id, err: String(e).slice(0, 60) }); }
        await new Promise(rs => setTimeout(rs, DELAY_MS));
      }

      // обновляем счётчик за день (TTL 48ч на всякий случай)
      await redisSet(todayKey(org), String(sentToday + sent), 48 * 3600);

      let note = "";
      if (permissionError) note = "⚠️ Похоже, у бота нет разрешения отправлять. Проверьте: Telegram → Настройки → Telegram для бизнеса → Чат-боты → разрешите «Отвечать на сообщения».";
      else if (errors.length) note = "Часть не отправилась (клиент давно не писал боту или заблокировал).";

      res.status(200).json({
        ok: true, sent, requested: toSend.length,
        remaining_after: Math.max(0, remaining - sent),
        errors: errors.slice(0, 5),
        permission_error: permissionError,
        note,
      });
      return;
    }

    res.status(400).json({ error: "unknown action" });
  } catch (e) {
    res.status(500).json({ error: "failed", detail: String(e).slice(0, 300) });
  }
}
