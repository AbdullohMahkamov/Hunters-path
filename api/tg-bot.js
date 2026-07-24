// /api/tg-bot.js — ДВА служебных Telegram-бота Altrone (НЕ бизнес-бот для клиентов!).
//   ?bot=rop    — бот для РОПа  (Task Agent ведёт с ним диалог по задачам)
//   ?bot=owner  — бот для владельца (эскалации Task Agent'а)
//
// Существующий api/telegram.js (бизнес-бот, переписка с КЛИЕНТАМИ) не трогаем — там другой режим
// (business_connection, отправка ОТ ИМЕНИ владельца). Здесь — обычные боты: пишут ОТ СЕБЯ и честно
// представляются как система Altrone (требование ТЗ: не маскироваться под человека).
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

// ВНИМАНИЕ при ротации токенов: env применяется только к НОВЫМ деплоям, а Vercel пропускает
// коммиты без изменений файлов — пустой коммит деплой НЕ запустит. Нужно реальное изменение.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";

export const BOT_TOKENS = {
  rop: process.env.TELEGRAM_ROP_BOT_TOKEN || "",
  owner: process.env.TELEGRAM_OWNER_BOT_TOKEN || "",
};
const K = { people: "taskagent:people", codes: "taskagent:bindcode", chat: "taskagent:chat" };
// «Altrone Digest» — отдельный бот для человекочитаемых сводок Dev/Growth/MOP агентов (НЕ Task Agent).
const DIGEST_TOKEN = process.env.TELEGRAM_DIGEST_BOT_TOKEN || "";
const DIGEST_KEY = "digest:cfg"; // { chatId, name, boundAt } — кому слать сводки (владелец лично)

async function rget(key) {
  try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; }
}
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

// ── ОТВЕТ НА callback_query (кнопка) — гасит «часики» на кнопке; text показывается тостом ──
async function answerCallback(botKind, cbId, text) {
  const token = BOT_TOKENS[botKind];
  if (!token || !cbId) return;
  try { await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callback_query_id: cbId, text: String(text || "").slice(0, 200) }) }); } catch (e) {}
}
// убрать кнопки у сообщения (чтобы не нажали повторно после «снять с контроля»)
async function clearReplyMarkup(botKind, chatId, messageId) {
  const token = BOT_TOKENS[botKind];
  if (!token || !chatId || !messageId) return;
  try { await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }) }); } catch (e) {}
}

// ── ОТПРАВКА от имени бота (экспортируется для task-agent.js) ──
export async function sendTg(botKind, chatId, text, extra) {
  const token = BOT_TOKENS[botKind];
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

// ── ЯЗЫК ОБЩЕНИЯ ──
// Спрашиваем у человека, на каком языке ему удобно, и дальше агент пишет ТОЛЬКО на нём.
// Хранится в people[kind].lang ('ru' | 'uz').
const LANG_KB = { reply_markup: { keyboard: [[{ text: "🇷🇺 Русский" }, { text: "🇺🇿 O'zbekcha" }]], resize_keyboard: true, one_time_keyboard: true } };
const LANG_ASK = "🌐 На каком языке вам удобнее общаться?\n<i>Qaysi tilda muloqot qilish siz uchun qulay?</i>\n\nВыберите вариант ниже — дальше я всегда буду писать на нём.";
export async function askLang(kind, chatId) { return await sendTg(kind, chatId, LANG_ASK, LANG_KB); }
// распознаём выбор (кнопка или просто слово)
function detectLangChoice(text) {
  const t = String(text || "").toLowerCase();
  if (/o'zbek|ozbek|oʻzbek|узбек|uz\b|🇺🇿/.test(t)) return "uz";
  if (/рус|russ|ru\b|🇷🇺/.test(t)) return "ru";
  return null;
}
export async function setPersonLang(kind, lang) {
  const people = await rgetJSON(K.people, {});
  if (people[kind]) { people[kind].lang = lang; await rsetJSON(K.people, people); }
  return people;
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

    // ── ALTRONE DIGEST: разовое получение chat_id (у digest-бота вебхука нет → getUpdates работает) ──
    if (action === "digest-updates") {
      if (!DIGEST_TOKEN) { res.status(400).json({ error: "нет TELEGRAM_DIGEST_BOT_TOKEN в env" }); return; }
      try {
        const r = await fetch(`https://api.telegram.org/bot${DIGEST_TOKEN}/getUpdates`);
        const d = await r.json();
        const chats = [];
        for (const u of (d.result || [])) {
          const m = u.message || u.edited_message || null;
          if (!m || !m.chat) continue;
          chats.push({ chatId: m.chat.id, name: [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") || m.chat.title || "", username: m.chat.username || "", text: String(m.text || "").slice(0, 60) });
        }
        res.status(200).json({ ok: !!d.ok, chats, current: await rgetJSON(DIGEST_KEY, null), error: d.description || null });
      } catch (e) { res.status(200).json({ ok: false, error: String(e).slice(0, 120) }); }
      return;
    }
    if (action === "digest-bind") {
      const chatId = b.chatId || q.chatId;
      if (!chatId) { res.status(400).json({ error: "нужен chatId" }); return; }
      await rsetJSON(DIGEST_KEY, { chatId: String(chatId), name: b.name || q.name || "", boundAt: Date.now() });
      res.status(200).json({ ok: true, chatId: String(chatId) });
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
        { key: "owner", token: BOT_TOKENS.owner, url: `https://${host}/api/tg-bot?bot=owner`, updates: ["message", "callback_query"] },
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

    if (action === "ask_lang") {
      // спросить язык у УЖЕ подключённых (они привязались до появления этого шага)
      const people = await getPeople();
      const out = {};
      for (const kind of ["rop", "owner"]) {
        const p = people[kind];
        if (!p || !p.chatId) { out[kind] = "не привязан"; continue; }
        if (p.lang && !(b.force || q.force)) { out[kind] = `уже выбран: ${p.lang}`; continue; }
        const r = await askLang(kind, p.chatId);
        out[kind] = r.ok ? "вопрос отправлен" : ("ошибка: " + r.error);
      }
      res.status(200).json({ ok: true, asked: out });
      return;
    }

    if (action === "test") { // разовая проверка отправки
      const people = await getPeople();
      const who = b.who || q.who || "rop";
      const p = people[who];
      if (!p || !p.chatId) { res.status(200).json({ ok: false, error: `${who} не привязан` }); return; }
      const r = await sendTg(who, p.chatId, "🤖 <b>Altrone</b> — проверка связи. Если вы это видите, бот настроен верно.");
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
    // ── КНОПКИ ЭСКАЛАЦИИ (callback_query) — обрабатываем раньше обычных сообщений ──
    const cq = (req.body && req.body.callback_query) || null;
    if (cq) {
      const cqChatId = cq.message && cq.message.chat && cq.message.chat.id;
      const people = await getPeople();
      const bound = people[kind];
      if (!bound || bound.chatId !== cqChatId) { await answerCallback(kind, cq.id, ""); res.status(200).json({ ok: true, ignored: "cq not bound" }); return; }
      const data = String(cq.data || "");
      const mEsc = data.match(/^esc:(remind|close|self):(.+)$/);
      const mDisp = data.match(/^disp:(agent|rop|noted):(.+)$/); // решение владельца по оспариванию
      const mTpl = data.match(/^tplan:(run|review|decline|spend|cancel)$/);   // решение по недельному плану транскрибации
      const mMb = data.match(/^mb:(confirm|reject|edit):(.+)$/); // решение владельца по сводному наблюдению общего мозга
      if (!mEsc && !mDisp && !mTpl && !mMb) { await answerCallback(kind, cq.id, ""); res.status(200).json({ ok: true, ignored: "cq no match" }); return; }
      const act = mMb ? mMb[1] : (mTpl ? mTpl[1] : (mDisp ? mDisp[1] : mEsc[1]));
      try {
        let r;
        if (mMb) { const bm = await import("./meta-brain.js"); r = await bm.handleMetaButton(mMb[1], mMb[2], req.headers && req.headers.host); }
        else if (mTpl) { const dm = await import("./deepsales.js"); r = await dm.handlePlanButton(mTpl[1]); }
        else { const mod = await import("./task-agent.js"); r = mDisp ? await mod.handleDisputeResolve(mDisp[1], mDisp[2]) : await mod.handleOwnerButton(mEsc[1], mEsc[2]); }
        await answerCallback(kind, cq.id, (r && r.toast) || "Готово");
        if (r && r.ownerMsg && cqChatId) await sendTg(kind, cqChatId, r.ownerMsg);
        // убираем кнопки после РЕШЕНИЯ (спор / снять с контроля / запуск|отказ плана / подтв.|откл. наблюдения); на «пересмотр»/«поправить» — нет (ждём ответ)
        if (cq.message && (mDisp || (mMb && ["confirm", "reject"].includes(act)) || ["close", "run", "decline", "spend", "cancel"].includes(act))) await clearReplyMarkup(kind, cqChatId, cq.message.message_id);
      } catch (e) { await answerCallback(kind, cq.id, "Ошибка обработки"); }
      res.status(200).json({ ok: true, cq: act }); return;
    }

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
        await sendTg(kind, chatId, "🤖 <b>Altrone</b>\n\nЭто служебный бот системы Altrone. Чтобы подключиться, отправьте:\n<code>/start КОД</code>\n\nКод вам выдаст владелец в панели Altrone.");
        res.status(200).json({ ok: true, bind: "bad_code" }); return;
      }
      const people = await getPeople();
      people[kind] = { chatId, name, username, boundAt: Date.now() };
      await rsetJSON(K.people, people);
      const hello = kind === "rop"
        ? `🤖 <b>Altrone</b> — подключено.\n\nЯ система Altrone (не человек). Буду писать вам по задачам отдела продаж: напоминать о сроках, спрашивать статус и фиксировать результат по каждой задаче.\n\nОтвечайте мне прямо здесь — я всё зафиксирую.`
        : `🤖 <b>Altrone</b> — подключено.\n\nСюда буду присылать эскалации Task-агента: задача, дословная переписка с РОПом и текущий статус. Решение остаётся за вами.`;
      await sendTg(kind, chatId, hello);
      await askLang(kind, chatId); // сразу спрашиваем язык общения
      res.status(200).json({ ok: true, bound: kind }); return;
    }

    // 2) ОБЫЧНОЕ СООБЩЕНИЕ
    const people = await getPeople();
    const bound = people[kind];
    if (!bound || bound.chatId !== chatId) {
      await sendTg(kind, chatId, "🤖 <b>Altrone</b>\n\nВы не подключены. Отправьте <code>/start КОД</code> (код выдаёт владелец).");
      res.status(200).json({ ok: true, ignored: "not bound" }); return;
    }

    // ЯЗЫК ещё не выбран → это сообщение считаем ответом на вопрос о языке
    if (!bound.lang) {
      const choice = detectLangChoice(text);
      if (choice) {
        await setPersonLang(kind, choice);
        const ok = choice === "uz"
          ? "✅ Yaxshi, endi siz bilan <b>o'zbek tilida</b> muloqot qilaman."
          : "✅ Хорошо, дальше буду писать вам <b>по-русски</b>.";
        await sendTg(kind, chatId, ok, { reply_markup: { remove_keyboard: true } });
        res.status(200).json({ ok: true, lang: choice }); return;
      }
      // не выбрал кнопкой — определяем по его тексту и не задерживаем диалог
      const auto = /[а-яё]/i.test(text) ? "ru" : "uz";
      await setPersonLang(kind, auto);
      // и продолжаем обычную обработку сообщения ниже
      bound.lang = auto;
    }

    if (kind === "rop") {
      // ответ РОПа → в общий тред; Task Agent обработает и ответит
      // reply_to_message.message_id — если РОП ответил Reply'ем на конкретный пинг (нужно для привязки к задаче)
      const replyToId = (msg.reply_to_message && msg.reply_to_message.message_id) || null;
      await pushChat({ role: "rop", text: text.slice(0, 2000), name });
      try {
        const mod = await import("./task-agent.js");
        await mod.handleRopReply(text.slice(0, 2000), replyToId);
      } catch (e) { /* агент недоступен — сообщение всё равно сохранено */ }
      res.status(200).json({ ok: true, stored: true }); return;
    }

    // владелец ответил боту эскалаций → Task Agent превращает инструкцию в сообщение РОПу и подтверждает.
    // reply_to_message.message_id — привязка к конкретной эскалации (иначе берётся последняя незакрытая).
    const ownerReplyToId = (msg.reply_to_message && msg.reply_to_message.message_id) || null;
    await pushChat({ role: "owner", text: text.slice(0, 2000), name });
    // ПЕРЕХВАТ: ответ на сводное наблюдение общего мозга в статусе «ждёт правки» → применяем правку, не в Task Agent
    try {
      const bm = await import("./meta-brain.js");
      const mh = await bm.handleOwnerMetaReply(ownerReplyToId, text.slice(0, 2000));
      if (mh && mh.handled) { res.status(200).json({ ok: true, metaEdit: true }); return; }
    } catch (e) { /* мозг недоступен — падаем в обычную обработку владельца */ }
    try {
      const mod = await import("./task-agent.js");
      await mod.handleOwnerReply(text.slice(0, 2000), ownerReplyToId);
    } catch (e) { await sendTg("owner", chatId, "Принял, но обработать инструкцию не удалось — попробуйте ещё раз."); }
    res.status(200).json({ ok: true, stored: true });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e).slice(0, 200) }); // 200 — чтобы Telegram не ретраил
  }
}
