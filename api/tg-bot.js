// /api/tg-bot.js — ДВА служебных Telegram-бота Hunter AI (НЕ бизнес-бот для клиентов!).
//   ?bot=rop    — бот для РОПа  (Task Agent ведёт с ним диалог по задачам)
//   ?bot=owner  — бот для владельца (эскалации Task Agent'а)
//
// Существующий api/telegram.js (бизнес-бот, переписка с КЛИЕНТАМИ) не трогаем — там другой режим
// (business_connection, отправка ОТ ИМЕНИ владельца). Здесь — обычные боты: пишут ОТ СЕБЯ и честно
// представляются как система Hunter AI (требование ТЗ: не маскироваться под человека).
//
// ENV: TELEGRAM_ROP_BOT_TOKEN, TELEGRAM_OWNER_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET (общий).
//
// ВАЖНО (ограничение Telegram): бот не может написать первым. Человек обязан один раз отправить боту
// `/start <код>` — тогда мы получаем его chat_id и связываем с ролью.
//
// Actions:
//   POST (webhook от Telegram) ?bot=rop|owner  — приём сообщений
//   GET  ?action=setup&session=...   (admin) — прописать webhook'и обоим ботам
//   GET  ?action=status&session=...  (admin) — статус привязки + коды + webhook-инфо
//   POST {action:'unbind', who}      (admin) — отвязать человека

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

export const BOT_TOKENS = {
  rop: process.env.TELEGRAM_ROP_BOT_TOKEN || "",
  owner: process.env.TELEGRAM_OWNER_BOT_TOKEN || "",
};
const K = { people: "taskagent:people", codes: "taskagent:bindcode", chat: "taskagent:chat" };

async function rget(key) {
  try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; }
}
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

// ── ОТПРАВКА от имени бота (экспортируется для task-agent.js) ──
export async function sendTg(botKind, chatId, text) {
  const token = BOT_TOKENS[botKind];
  if (!token || !chatId) return { ok: false, error: "no token or chatId" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const d = await r.json();
    return d && d.ok ? { ok: true, messageId: d.result && d.result.message_id } : { ok: false, error: (d && d.description) || "send failed" };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}
export async function getPeople() { return await rgetJSON(K.people, {}); }
// добавить сообщение в общий тред с РОПом (taskId — к какой задаче относится, может быть пустым)
export async function pushChat(entry) {
  const chat = await rgetJSON(K.chat, []);
  chat.push({ id: "m" + Date.now() + "_" + chat.length, at: Date.now(), ...entry });
  await rsetJSON(K.chat, chat.slice(-400));
  return chat;
}
export async function getChat() { return await rgetJSON(K.chat, []); }

// коды привязки: генерим один раз, показываем админу в UI, он передаёт РОПу
async function getCodes() {
  let c = await rgetJSON(K.codes, null);
  if (!c || !c.rop || !c.owner) {
    const gen = () => Math.random().toString(36).slice(2, 8).toUpperCase();
    c = { rop: (c && c.rop) || gen(), owner: (c && c.owner) || gen() };
    await rsetJSON(K.codes, c);
  }
  return c;
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "";

  // ── АДМИНСКИЕ ДЕЙСТВИЯ ──
  if (action) {
    const sess = await getSession(q.session || b.session);
    if (!sess || sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }

    if (action === "status") {
      const [people, codes] = await Promise.all([getPeople(), getCodes()]);
      const hooks = {};
      for (const kind of ["rop", "owner"]) {
        if (!BOT_TOKENS[kind]) { hooks[kind] = { token: false }; continue; }
        try {
          const r = await fetch(`https://api.telegram.org/bot${BOT_TOKENS[kind]}/getWebhookInfo`);
          const d = await r.json();
          const me = await (await fetch(`https://api.telegram.org/bot${BOT_TOKENS[kind]}/getMe`)).json();
          hooks[kind] = { token: true, username: me.ok ? me.result.username : null, url: d.ok ? d.result.url : null, pending: d.ok ? d.result.pending_update_count : null };
        } catch (e) { hooks[kind] = { token: true, error: String(e).slice(0, 80) }; }
      }
      res.status(200).json({ ok: true, people, codes, bots: hooks });
      return;
    }

    if (action === "setup") {
      // Прописываем webhook ВСЕМ трём ботам с одним секретом.
      // ВАЖНО: бизнес-бот (api/telegram.js, переписка с КЛИЕНТАМИ) тоже проверяет TELEGRAM_WEBHOOK_SECRET —
      // если задать секрет и не перепрописать ему webhook, он начнёт отбивать апдейты 401 и переписка сломается.
      const host = (req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "hunters-path.vercel.app";
      const out = {};
      const targets = [
        { key: "rop", token: BOT_TOKENS.rop, url: `https://${host}/api/tg-bot?bot=rop`, updates: ["message"] },
        { key: "owner", token: BOT_TOKENS.owner, url: `https://${host}/api/tg-bot?bot=owner`, updates: ["message"] },
        // бизнес-бот для клиентов — НЕ трогаем его логику, только синхронизируем секрет webhook'а
        { key: "business", token: process.env.TELEGRAM_BOT_TOKEN || "", url: `https://${host}/api/telegram`, updates: ["business_connection", "business_message", "edited_business_message"] },
      ];
      for (const t of targets) {
        if (!t.token) { out[t.key] = { ok: false, error: "нет токена в env" }; continue; }
        try {
          const r = await fetch(`https://api.telegram.org/bot${t.token}/setWebhook`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ url: t.url, secret_token: WEBHOOK_SECRET || undefined, allowed_updates: t.updates }),
          });
          const d = await r.json();
          out[t.key] = { ok: !!d.ok, url: t.url, secured: !!WEBHOOK_SECRET, description: d.description };
        } catch (e) { out[t.key] = { ok: false, error: String(e).slice(0, 100) }; }
      }
      res.status(200).json({ ok: true, setup: out, codes: await getCodes() });
      return;
    }

    if (action === "unbind") {
      const people = await getPeople();
      delete people[b.who];
      await rsetJSON(K.people, people);
      res.status(200).json({ ok: true, people });
      return;
    }

    if (action === "test") { // разовая проверка отправки
      const people = await getPeople();
      const who = b.who || q.who || "rop";
      const p = people[who];
      if (!p || !p.chatId) { res.status(200).json({ ok: false, error: `${who} не привязан` }); return; }
      const r = await sendTg(who, p.chatId, "🤖 <b>Hunter AI</b> — проверка связи. Если вы это видите, бот настроен верно.");
      res.status(200).json({ ok: r.ok, result: r });
      return;
    }

    res.status(400).json({ error: "unknown action" });
    return;
  }

  // ── WEBHOOK ОТ TELEGRAM ──
  if (req.method !== "POST") { res.status(200).json({ ok: true, note: "tg-bot webhook alive" }); return; }
  if (WEBHOOK_SECRET && req.headers["x-telegram-bot-api-secret-token"] !== WEBHOOK_SECRET) { res.status(401).json({ error: "bad secret" }); return; }
  const kind = q.bot === "owner" ? "owner" : (q.bot === "rop" ? "rop" : null);
  if (!kind) { res.status(200).json({ ok: true, ignored: "no bot kind" }); return; }

  try {
    const msg = (req.body && req.body.message) || null;
    if (!msg || !msg.chat) { res.status(200).json({ ok: true, ignored: true }); return; }
    const chatId = msg.chat.id;
    const text = String(msg.text || "").trim();
    const name = [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(" ");
    const username = (msg.from && msg.from.username) || "";

    // 1) ПРИВЯЗКА: /start <код>
    if (/^\/start\b/i.test(text)) {
      const code = text.split(/\s+/)[1] || "";
      const codes = await getCodes();
      if (!code || code.toUpperCase() !== String(codes[kind]).toUpperCase()) {
        await sendTg(kind, chatId, "🤖 <b>Hunter AI</b>\n\nЭто служебный бот системы Hunter AI. Чтобы подключиться, отправьте:\n<code>/start КОД</code>\n\nКод вам выдаст владелец в панели Hunter AI.");
        res.status(200).json({ ok: true, bind: "bad_code" }); return;
      }
      const people = await getPeople();
      people[kind] = { chatId, name, username, boundAt: Date.now() };
      await rsetJSON(K.people, people);
      const hello = kind === "rop"
        ? `🤖 <b>Hunter AI</b> — подключено.\n\nЯ система Hunter AI (не человек). Буду писать вам по задачам отдела продаж: напоминать о сроках, спрашивать статус и фиксировать результат по каждой задаче.\n\nОтвечайте мне прямо здесь — я всё зафиксирую.`
        : `🤖 <b>Hunter AI</b> — подключено.\n\nСюда буду присылать эскалации Task-агента: задача, дословная переписка с РОПом и текущий статус. Решение остаётся за вами.`;
      await sendTg(kind, chatId, hello);
      res.status(200).json({ ok: true, bound: kind }); return;
    }

    // 2) ОБЫЧНОЕ СООБЩЕНИЕ
    const people = await getPeople();
    const bound = people[kind];
    if (!bound || bound.chatId !== chatId) {
      await sendTg(kind, chatId, "🤖 <b>Hunter AI</b>\n\nВы не подключены. Отправьте <code>/start КОД</code> (код выдаёт владелец).");
      res.status(200).json({ ok: true, ignored: "not bound" }); return;
    }

    if (kind === "rop") {
      // ответ РОПа → в общий тред; Task Agent обработает и ответит
      await pushChat({ role: "rop", text: text.slice(0, 2000), name });
      try {
        const mod = await import("./task-agent.js");
        await mod.handleRopReply(text.slice(0, 2000));
      } catch (e) { /* агент недоступен — сообщение всё равно сохранено */ }
      res.status(200).json({ ok: true, stored: true }); return;
    }

    // владелец что-то написал боту эскалаций — просто фиксируем
    await pushChat({ role: "owner", text: text.slice(0, 2000), name });
    await sendTg("owner", chatId, "Принято. Решения по эскалациям делайте в панели Hunter AI (вкладка Task Agent).");
    res.status(200).json({ ok: true, stored: true });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e).slice(0, 200) }); // 200 — чтобы Telegram не ретраил
  }
}
