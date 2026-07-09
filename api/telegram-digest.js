// /api/telegram-digest.js — НОЧНОЙ разбор Telegram-чатов за вчера (cron 02:00).
// Экономно: rule-based фильтр (0 токенов) находит проблемные чаты → AI делает сводку простым языком.
// Если чатов мало (<5) — пропускаем AI, показываем простой счётчик.
// Сводка сохраняется в Upstash, утром показывается в разделе Telegram.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AI_KEY = process.env.ANTHROPIC_API_KEY;

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json();
  return d && d.result ? d.result : null;
}
async function redisSet(key, value) {
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: value });
}

// ключевые слова для rule-based фильтра
const PRICE_WORDS = ["цена", "стоит", "сколько", "narx", "qancha", "стоимость", "почём"];
const OBJECTION_WORDS = ["дорого", "подумаю", "qimmat", "o'ylab", "потом", "не могу", "нет денег"];
const INSTALLMENT_WORDS = ["рассрочк", "части", "bo'lib", "nasiya", "кредит"];

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }

  const TZ = 5 * 3600;
  const now = Math.floor(Date.now() / 1000);
  // границы "вчера" по Ташкенту
  const nowLocal = new Date((now + TZ) * 1000);
  const todayStartLocal = Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()) / 1000;
  const dayStart = todayStartLocal - TZ - 24 * 3600; // начало вчера (UTC)
  const dayEnd = todayStartLocal - TZ;               // конец вчера

  try {
    const idx = JSON.parse((await redisGet("tg:chats_index")) || "{}");
    const chatIds = Object.keys(idx);

    // собираем вчерашние сообщения по каждому чату
    let analyzed = [];       // чаты с активностью вчера
    let priceCount = 0, objectionCount = 0, installmentCount = 0;
    let leftAfterPrice = 0;  // клиент спросил цену и больше не писал
    let noReplyChats = 0;    // клиент писал, владелец не ответил

    for (const cid of chatIds) {
      const msgs = JSON.parse((await redisGet(`tgchat:${cid}`)) || "[]");
      const yMsgs = msgs.filter(m => m.ts >= dayStart && m.ts < dayEnd);
      if (!yMsgs.length) continue;

      const clientMsgs = yMsgs.filter(m => !m.isOwner);
      const ownerMsgs = yMsgs.filter(m => m.isOwner);
      const allText = yMsgs.map(m => (m.text || "").toLowerCase()).join(" ");

      const askedPrice = PRICE_WORDS.some(w => allText.includes(w));
      const objected = OBJECTION_WORDS.some(w => allText.includes(w));
      const askedInstallment = INSTALLMENT_WORDS.some(w => allText.includes(w));
      if (askedPrice) priceCount++;
      if (objected) objectionCount++;
      if (askedInstallment) installmentCount++;

      // клиент написал последним (владелец не ответил)
      const lastMsg = yMsgs[yMsgs.length - 1];
      if (lastMsg && !lastMsg.isOwner) noReplyChats++;
      // спросил цену и ушёл (последнее — вопрос клиента после цены)
      if (askedPrice && lastMsg && !lastMsg.isOwner) leftAfterPrice++;

      analyzed.push({
        name: idx[cid].name || String(cid),
        clientMsgs: clientMsgs.length,
        ownerMsgs: ownerMsgs.length,
        askedPrice, objected, askedInstallment,
        noReply: lastMsg && !lastMsg.isOwner,
        // короткая выжимка для AI (только если понадобится)
        snippet: yMsgs.slice(-6).map(m => `${m.isOwner ? "Вы" : "Клиент"}: ${(m.text || "").slice(0, 100)}`).join("\n"),
      });
    }

    const totalChats = analyzed.length;

    // === RULE-BASED СВОДКА (0 токенов) ===
    const ruleFacts = {
      date: new Date((dayStart + TZ) * 1000).toISOString().slice(0, 10),
      totalChats,
      priceCount, objectionCount, installmentCount,
      leftAfterPrice, noReplyChats,
    };

    // === ЕСЛИ ЧАТОВ МАЛО — без AI (экономим) ===
    if (totalChats < 5) {
      const digest = {
        ...ruleFacts,
        aiUsed: false,
        summary: totalChats === 0
          ? "Вчера в Telegram переписок не было."
          : `Вчера было ${totalChats} ${totalChats === 1 ? "диалог" : "диалога"} — спокойный день.`,
        tips: [],
      };
      await redisSet("tg:digest", JSON.stringify(digest));
      res.status(200).json({ ok: true, ...digest }); return;
    }

    // === AI-СВОДКА (только проблемные чаты, экономно) ===
    // берём максимум 8 самых показательных чатов
    const forAI = analyzed
      .filter(c => c.askedPrice || c.objected || c.noReply || c.askedInstallment)
      .slice(0, 8);
    const context = `Статистика за вчера (${ruleFacts.date}):
- Всего диалогов: ${totalChats}
- Спрашивали цену: ${priceCount}
- Возражения (дорого/подумаю): ${objectionCount}
- Спрашивали рассрочку: ${installmentCount}
- Клиент написал, но остался без ответа: ${noReplyChats}

Примеры диалогов:
${forAI.map((c, i) => `[Диалог ${i + 1}] ${c.name}:\n${c.snippet}`).join("\n\n")}`;

    let summary = "", tips = [];
    if (AI_KEY) {
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 500,
            system: "Ты — помощник владельца бизнеса (школа продаж). Анализируй переписку с клиентами и говори ПРОСТЫМ человеческим языком, без терминов маркетинга. Владелец — обычный бизнесмен, не аналитик. Дай короткую сводку: что было хорошо, на что обратить внимание, и 2-3 конкретных практичных совета. Пиши на русском, дружелюбно и по делу. Ответь СТРОГО в формате JSON: {\"summary\":\"...\",\"tips\":[\"...\",\"...\"]} без markdown.",
            messages: [{ role: "user", content: context }],
          }),
        });
        const d = await r.json();
        const txt = (d.content || []).filter(x => x.type === "text").map(x => x.text).join("").replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(txt);
        summary = parsed.summary || "";
        tips = Array.isArray(parsed.tips) ? parsed.tips : [];
      } catch (e) {
        summary = `Вчера ${totalChats} диалогов. ${priceCount} спрашивали цену, ${noReplyChats} остались без ответа.`;
        tips = [];
      }
    }

    const digest = { ...ruleFacts, aiUsed: true, summary, tips };
    await redisSet("tg:digest", JSON.stringify(digest));
    res.status(200).json({ ok: true, ...digest });
  } catch (e) {
    res.status(500).json({ error: "digest failed", detail: String(e).slice(0, 300) });
  }
}
