// api/digest.js — «Altrone Digest»: человекочитаемые сводки агентов Dev/Growth/MOP владельцу лично.
// ЭТО НЕ Task Agent (у того свой бот и свой диалоговый режим). Отдельный бот (TELEGRAM_DIGEST_BOT_TOKEN),
// получатель — digest:cfg.chatId (владелец, привязывается через tg-bot ?action=digest-bind).
//
// Идея: cron-sweep читает НАХОДКИ трёх агентов из их Redis-ключей, берёт только НОВЫЕ (dedup по id),
// переводит сухие внутренние поля (confidence/status/trust/п.п./snapshots) в короткий бизнес-текст
// с ЧЕСТНОЙ фразой уверенности (никогда не завышаем) и шлёт. Логику находок агентов НЕ трогаем —
// меняется только ФОРМА подачи. Пороги/confidence/trust-гейты остаются в самих агентах.

import { sleep } from "./tg-bot.js"; // общий хелпер паузы (без дубликатов)

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DIGEST_TOKEN = process.env.TELEGRAM_DIGEST_BOT_TOKEN || "";
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-haiku-4-5-20251001"; // routine reformatting → лёгкая модель (крон ежечасно, дёшево)

const DIGEST_KEY = "digest:cfg";  // { chatId, name, boundAt } — кому слать
const SENT_KEY = "digest:sent";   // { [findingId]: ts } — что уже отправляли (dedup, чтобы не спамить)
const SENT_CAP = 800;
const SECTION = { growth: "Рост", mop: "МОПы / Задачи РОПа", dev: "Разработка" };
const APP_URL = "https://test.hunterai.uz"; // главный домен — куда ведёт кнопка «Обсудить с помощником»
const HANDOFF_KEY = "digest:handoffs";      // { [token]: { kind, item, seed, title, at } } — контекст находки для советника
const HANDOFF_CAP = 300;

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

async function callModel(system, user, maxTokens = 700) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

const SYSTEM_DIGEST = `Ты — «Altrone Digest». Превращаешь техническую находку внутреннего агента (Dev/Growth/MOP) в КОРОТКОЕ сообщение владельцу бизнеса, который НЕ разработчик.

ЦЕЛЬ: человек понимает с первого взгляда, БЕЗ похода в код — что нашли, почему это важно и насколько это надёжно.

ЯЗЫК: простой деловой русский. ЗАПРЕЩЁН жаргон и внутренние термины: «confidence», «verified», «trust», «snapshot/снимок», «п.п.», «funnel», «needs_data», «delta», названия полей/функций/файлов, хэши коммитов, английские слова, а также внутренние коды клиентов («client_1», «client_N», «org=…») — клиент один, не упоминай его как код (говори просто про отдел/менеджеров/показатели). Числа — только с понятным смыслом («упала почти вдвое — с 5,6% до 3%»), а не сырьём.

ЧЕСТНОСТЬ УВЕРЕННОСТИ — ГЛАВНОЕ ПРАВИЛО, НИКОГДА НЕ ЗАВЫШАТЬ:
- confidence high / status confirmed / trust verified / «подтверждено» → «проверено на достаточных данных», «уверенно».
- confidence medium / status open / это гипотеза → «похоже на закономерность, но стоит перепроверить».
- confidence low (<~0.35) / needs_data / trust insufficient / данных мало → «пока недостаточно данных для уверенного вывода — это гипотеза, не факт».
Гипотезу НИКОГДА не выдавай за факт. Если агент о чём-то молчит из-за неполных данных — так и скажи, что вывод преждевременный. Если находка касается конкретных людей, но помечена как вопрос ПРОЦЕССА/ОТДЕЛА (scope department) — подавай как вопрос процесса, без обвинения человека.

РАЗДЕЛЯЙ ИЗМЕРЕННЫЙ ФАКТ И ПРЕДПОЛАГАЕМУЮ ПРИЧИНУ — это критично для честности:
- Наблюдение/тренд/цифра (поля observation, fact, evidence) — это то, что уже ИЗМЕРЕНО; у него СВОЯ надёжность, и если она помечена как подтверждённая (verified / «подтверждено» / «худший verified-переход» / «verified-динамика») — значит сам факт НАДЁЖЕН, так и скажи: «сам спад/факт подтверждён на достаточных данных — это не случайность».
- Предполагаемая причина (поле cause, «вероятно…») — это ВСЕГДА гипотеза, даже если факт подтверждён.
- НЕ занижай надёжность измеренного факта только потому, что причина не доказана. Поле confidence у гипотезы роста обычно относится к ПРИЧИНЕ, а не к самому факту.
- Поэтому в «Уверенность:» сначала честно оцени сам ФАКТ (часто «подтверждён, не случайность»), а затем ОТДЕЛЬНО пометь, что причина — предположение и требует проверки.
Не используй слова «период», «снимок», «замер», «точек» — говори «за последние недели» / «в последнее время».

ФОРМАТ (коротко, максимум ~6 строк):
- строка 1: эмодзи + <b>жирный короткий заголовок сути</b>;
- 1–2 предложения простыми словами: что нашли;
- «Почему важно:» — одно предложение о влиянии на бизнес;
- «Уверенность:» — честная фраза по правилам выше;
- если уместно — «👉 Подробнее — раздел …» (без деталей в самом сообщении).

Разметка — только Telegram HTML (<b>). Верни ТОЛЬКО текст сообщения: без пояснений, без JSON, без кавычек вокруг.`;

async function formatOne(kind, item) {
  const user = `АГЕНТ: ${kind}. Раздел для ссылки «Подробнее»: ${SECTION[kind] || ""}.

НАХОДКА (сырые внутренние поля — переведи в человеческий текст, сохрани честную уверенность):
${JSON.stringify(item).slice(0, 2600)}

Верни только готовое сообщение по правилам системного промпта.`;
  return (await callModel(SYSTEM_DIGEST, user, 700)).trim();
}

// ── HANDOFF: контекст находки для советника (кнопка «Обсудить с помощником») ──
function genToken() { return "hf" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function handoffTitle(item) { return String(item.title || item.observation || item.fact || item.claim || "Находка").slice(0, 40); }
// Засев — первое сообщение, которое увидит советник (полный контекст находки + просьба разобрать).
function buildSeed(kind, item) {
  const label = { growth: "Рост (гипотеза роста)", mop: "Отдел продаж / МОПы", dev: "Разработка" }[kind] || kind;
  const it = item || {};
  const L = ["Разбери эту находку агента и подскажи, что мне делать — коротко и по шагам. Если стоит поручить РОПу, скажи прямо (я смогу отправить это ему).", "", `Находка (${label}):`];
  const add = (k, lbl) => { if (it[k]) L.push(`• ${lbl}: ${String(it[k]).slice(0, 600)}`); };
  add("title", "Суть"); add("observation", "Наблюдение"); add("fact", "Факт"); add("claim", "Вывод");
  add("cause", "Возможная причина"); add("action", "Предлагаемое действие"); add("howToVerify", "Как проверить");
  if (Array.isArray(it.evidence) && it.evidence.length) L.push(`• Основания: ${it.evidence.slice(0, 3).join("; ").slice(0, 600)}`);
  if (Array.isArray(it.mops) && it.mops.length) L.push(`• Кого касается: ${it.mops.join(", ")}`);
  const conf = it.confidence != null ? String(it.confidence) : "";
  if (conf || it.status) L.push(`• Внутренняя пометка надёжности: ${conf}${it.status ? ` / ${it.status}` : ""} (переведи для меня в честную уверенность, не завышай).`);
  if (kind === "growth" && it.id) L.push(`• (служебный id гипотезы для кнопки «закрыть гипотезу как ложную»: ${it.id})`);
  return L.join("\n");
}
async function saveHandoff(token, kind, item) {
  const m = await rgetJSON(HANDOFF_KEY, {});
  m[token] = { kind, seed: buildSeed(kind, item), title: handoffTitle(item), at: Date.now() };
  const ks = Object.keys(m);
  if (ks.length > HANDOFF_CAP) { ks.sort((a, b) => m[a].at - m[b].at); for (const k of ks.slice(0, ks.length - HANDOFF_CAP)) delete m[k]; }
  await rsetJSON(HANDOFF_KEY, m);
}
async function getHandoff(token) { const m = await rgetJSON(HANDOFF_KEY, {}); return m[token] || null; }
// inline-кнопка под сообщением дайджеста: ведёт в приложение, открывает советника с этой находкой
function handoffKb(token) { return { reply_markup: { inline_keyboard: [[{ text: "🧠 Обсудить с помощником", url: `${APP_URL}/?advisor=${token}` }]] } }; }

async function sendDigest(text, extra) {
  if (!DIGEST_TOKEN) return { ok: false, error: "нет TELEGRAM_DIGEST_BOT_TOKEN" };
  const cfg = await rgetJSON(DIGEST_KEY, null);
  if (!cfg || !cfg.chatId) return { ok: false, error: "digest не привязан (нет chatId)" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${DIGEST_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text: String(text).slice(0, 4000), parse_mode: "HTML", disable_web_page_preview: true, ...(extra || {}) }),
    });
    const d = await r.json();
    return d && d.ok ? { ok: true, messageId: d.result && d.result.message_id } : { ok: false, error: (d && d.description) || "send failed" };
  } catch (e) { return { ok: false, error: String(e).slice(0, 120) }; }
}

// Что считаем «отправляемым» (высокий сигнал для владельца). Пороги НЕ меняем — берём то, что агент сам
// уже вынес как открытую находку/подтверждённый результат.
async function collectSendable() {
  const items = [];
  for (const f of await rgetJSON("mopagent:findings", [])) if (f && f.status === "open") items.push({ kind: "mop", id: f.id, item: f });
  for (const h of await rgetJSON("growthagent:hypotheses", [])) if (h && h.status === "open") items.push({ kind: "growth", id: h.id, item: h });
  for (const f of await rgetJSON("devagent:findings", [])) if (f && f.status === "confirmed") items.push({ kind: "dev", id: f.id, item: f });
  for (const h of await rgetJSON("devagent:hypotheses", [])) if (h && h.status === "likely") items.push({ kind: "dev", id: h.id, item: h });
  return items;
}

function capSent(sent) {
  const ids = Object.keys(sent);
  if (ids.length > SENT_CAP) { ids.sort((a, b) => sent[a] - sent[b]); for (const k of ids.slice(0, ids.length - SENT_CAP)) delete sent[k]; }
  return sent;
}

async function digestSweep(opts = {}) {
  const cfg = await rgetJSON(DIGEST_KEY, null);
  if (!cfg || !cfg.chatId) return { ok: false, skipped: "не привязан" };
  if (!DIGEST_TOKEN || !AKEY) return { ok: false, skipped: "нет токена/ключа" };
  const sent = await rgetJSON(SENT_KEY, {});
  const all = await collectSendable();
  const fresh = all.filter((x) => !(x.id in sent));
  const cap = opts.cap || 4; // не флудим за один проход — остальное уйдёт следующим свипом
  const batch = fresh.slice(0, cap);
  const sentNow = [];
  for (const x of batch) {
    let text;
    try { text = await formatOne(x.kind, x.item); } catch (e) { continue; } // не отформатировали — попробуем позже
    if (!text) continue;
    const token = genToken();
    await saveHandoff(token, x.kind, x.item); // контекст для кнопки «Обсудить с помощником»
    const r = await sendDigest(text, handoffKb(token));
    if (r.ok) { sent[x.id] = Date.now(); sentNow.push({ kind: x.kind, id: x.id }); await sleep(400); } // пауза между отправками в один чат владельца
  }
  await rsetJSON(SENT_KEY, capSent(sent));
  return { ok: true, considered: all.length, fresh: fresh.length, sent: sentNow.length, sentNow, remaining: fresh.length - sentNow.length };
}

// baseline: пометить ВСЕ текущие находки как «уже известные» БЕЗ отправки — чтобы при запуске не завалить
// владельца всем накопленным бэклогом. Дальше дайджест шлёт только НОВОЕ.
async function seedBaseline() {
  const sent = await rgetJSON(SENT_KEY, {});
  const all = await collectSendable();
  let n = 0;
  for (const x of all) if (!(x.id in sent)) { sent[x.id] = Date.now(); n++; }
  await rsetJSON(SENT_KEY, capSent(sent));
  return { seeded: n, total: all.length };
}

export { digestSweep, sendDigest };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "status";
  const isProd = process.env.NODE_ENV === "production";
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const isCron = cronSecret ? (authHeader === `Bearer ${cronSecret}`) : (!isProd && (q.cron === "1" || b.cron === true));
  const sess = await getSession(q.session || b.session);
  const isAdmin = !!sess && sess.role === "admin";
  if (!isAdmin && !(action === "cron-sweep" && isCron)) { res.status(403).json({ error: "admin only (или cron с секретом)" }); return; }

  try {
    if (action === "cron-sweep" || action === "sweep") {
      const cap = (b.cap || q.cap) ? Number(b.cap || q.cap) : 4;
      res.status(200).json(await digestSweep({ cap })); return;
    }
    if (action === "seed") { res.status(200).json({ ok: true, ...(await seedBaseline()) }); return; }
    if (action === "status") {
      const cfg = await rgetJSON(DIGEST_KEY, null);
      const sent = await rgetJSON(SENT_KEY, {});
      const all = await collectSendable();
      res.status(200).json({ ok: true, token: !!DIGEST_TOKEN, bound: !!(cfg && cfg.chatId), chatId: (cfg && cfg.chatId) || null, sentCount: Object.keys(sent).length, sendableNow: all.length, byKind: all.reduce((a, x) => ((a[x.kind] = (a[x.kind] || 0) + 1), a), {}) });
      return;
    }
    if (action === "test") {
      // разовый предпросмотр: отформатировать и отправить один item (по id или первый sendable). Помечаем sent, чтобы свип не продублировал.
      const all = await collectSendable();
      const pick = (b.id || q.id) ? all.find((x) => x.id === (b.id || q.id)) : all[0];
      if (!pick) { res.status(400).json({ error: "нет находок для теста" }); return; }
      const text = await formatOne(pick.kind, pick.item);
      const token = genToken();
      await saveHandoff(token, pick.kind, pick.item);
      const withBtn = (b.button === false || q.button === "0") ? undefined : handoffKb(token);
      const r = await sendDigest(text, withBtn);
      if (r.ok) { const sent = await rgetJSON(SENT_KEY, {}); sent[pick.id] = Date.now(); await rsetJSON(SENT_KEY, capSent(sent)); }
      res.status(200).json({ ok: r.ok, kind: pick.kind, id: pick.id, token, preview: text, error: r.error || null });
      return;
    }
    if (action === "handoff") {
      // контекст находки для советника (фронт вызывает при заходе с ?advisor=<token>). Гейт — админ-сессия владельца.
      const token = q.token || b.token;
      if (!token) { res.status(400).json({ error: "нужен token" }); return; }
      const h = await getHandoff(token);
      if (!h) { res.status(404).json({ error: "находка не найдена или устарела" }); return; }
      res.status(200).json({ ok: true, kind: h.kind, title: h.title, seed: h.seed });
      return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(200).json({ ok: false, error: String(e).slice(0, 200) }); }
}
