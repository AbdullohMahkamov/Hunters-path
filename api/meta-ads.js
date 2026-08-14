// /api/meta-ads.js — тянет расходы по рекламе (spend) из Meta Ads API по каждому adset.
// Кэшируется в Upstash, чтобы не дёргать Meta часто. Права токена: ads_read.
// ENV: META_TOKEN (system user token), META_AD_ACCOUNT_ID (act_...).

const GRAPH_VERSION = "v21.0";

async function redisGet(url, token, key) {
  const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json();
  return d && d.result != null ? JSON.parse(d.result) : null;
}
async function redisSet(url, token, key, val) {
  await fetch(`${url}/set/${key}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: val,
  });
}

export default async function handler(req, res) {
  try {
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    const metaToken = process.env.META_TOKEN;
    let adAccount = process.env.META_AD_ACCOUNT_ID || "";

    const action = (req.query && req.query.action) || "get";

    // GET из кэша (для дашборда) — не дёргает Meta
    if (action === "get") {
      const cached = await redisGet(redisUrl, redisToken, "meta_spend");
      res.status(200).json({ ok: true, ...(cached || { adsets: [], updatedAt: null }) });
      return;
    }

    // ДИАГНОСТИКА ПРАВ ТОКЕНА (read-only, не секретно — возвращает только список выданных scopes, НЕ сам токен).
    // Нужно, чтобы честно проверить: есть ли у токена ЗАПИСЬ (ads_management) для автономного управления рекламой.
    if (action === "perms") {
      if (!metaToken) { res.status(200).json({ ok: false, error: "META_TOKEN не задан" }); return; }
      try {
        const dbg = await (await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(metaToken)}&access_token=${encodeURIComponent(metaToken)}`)).json();
        const info = (dbg && dbg.data) || {};
        let scopes = Array.isArray(info.scopes) ? info.scopes : [];
        if (!scopes.length) { // фолбэк для user-токенов
          const pm = await (await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/me/permissions?access_token=${encodeURIComponent(metaToken)}`)).json();
          scopes = ((pm && pm.data) || []).filter((p) => p.status === "granted").map((p) => p.permission);
        }
        const want = ["ads_read", "ads_management", "business_management", "instagram_basic", "instagram_manage_insights", "pages_show_list"];
        const has = {}; want.forEach((s) => (has[s] = scopes.includes(s)));
        res.status(200).json({ ok: true, valid: info.is_valid !== false, type: info.type || null, appId: info.app_id || null, expiresAt: info.expires_at || null, scopes, has, canWriteAds: scopes.includes("ads_management"), rawError: dbg && dbg.error ? dbg.error : null });
      } catch (e) { res.status(200).json({ ok: false, error: String(e).slice(0, 200) }); }
      return;
    }

    // ЗАЩИТА ДОСТУПА: refresh дёргает ЖИВОЙ Meta API → закрыт cron-секретом (Vercel шлёт крону
    // Authorization: Bearer $CRON_SECRET). Ручной вызов из браузера без секрета → понятный 401.
    // action=get выше остаётся открытым — он читает только Redis-кэш и в Meta не ходит.
    const cronSecret = process.env.CRON_SECRET || "";
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
    if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
      res.status(401).json({ ok: false, error: "unauthorized: /api/meta-ads?action=refresh требует cron-секрет (эндпоинт вызывается по расписанию). Данные для дашборда берите через action=get." });
      return;
    }

    // refresh — тянем свежие расходы из Meta
    if (!metaToken || !adAccount) {
      res.status(200).json({ ok: false, error: "META_TOKEN или META_AD_ACCOUNT_ID не заданы в переменных окружения" });
      return;
    }
    // нормализуем account id (должен быть с префиксом act_)
    if (!adAccount.startsWith("act_")) adAccount = "act_" + adAccount;

    // период: текущий месяц (с 1-го числа по сегодня)
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth(), 1);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const timeRange = JSON.stringify({ since: fmt(since), until: fmt(now) });

    // запрос расходов по adset за месяц
    const base = `https://graph.facebook.com/${GRAPH_VERSION}/${adAccount}/insights`;
    const params = new URLSearchParams({
      level: "adset",
      fields: "adset_name,adset_id,spend,impressions,clicks",
      time_range: timeRange,
      limit: "500",
      access_token: metaToken,
    });

    const spendById = {};
    let url = `${base}?${params.toString()}`;
    let guard = 0, currency = "";
    while (url && guard < 20) {
      guard++;
      const r = await fetch(url);
      const d = await r.json();
      if (d.error) {
        res.status(200).json({ ok: false, error: d.error.message || "Meta API error", code: d.error.code });
        return;
      }
      for (const row of (d.data || [])) {
        const id = row.adset_id ? String(row.adset_id) : (row.adset_name || "").trim();
        const name = (row.adset_name || "").trim();
        if (!id) continue;
        const spend = parseFloat(row.spend || "0") || 0; // Meta отдаёт строкой!
        const e = spendById[id] || (spendById[id] = { id, name, spend: 0, impressions: 0, clicks: 0 });
        e.spend += spend;
        e.impressions += parseInt(row.impressions || "0", 10) || 0;
        e.clicks += parseInt(row.clicks || "0", 10) || 0;
      }
      url = (d.paging && d.paging.next) || null;
    }

    // СТАТУС АДСЕТА (таргета): активен или на паузе. effective_status учитывает паузу на уровне
    // адсета/кампании/аккаунта. Тянем отдельным запросом (insights статуса не отдаёт).
    const statusById = {};
    try {
      let aurl = `https://graph.facebook.com/${GRAPH_VERSION}/${adAccount}/adsets?fields=id,name,effective_status&limit=500&access_token=${metaToken}`;
      let ag = 0;
      while (aurl && ag < 20) {
        ag++;
        const ar = await fetch(aurl);
        const ad = await ar.json();
        if (ad.error) break;
        for (const a of (ad.data || [])) if (a.id) statusById[String(a.id)] = a.effective_status || null;
        aurl = (ad.paging && ad.paging.next) || null;
      }
    } catch (e) { /* статус не критичен — просто не покажем */ }

    const adsetsSpend = Object.values(spendById).map((e) => {
      const es = statusById[e.id] || null;
      return { name: e.name, spend: Math.round(e.spend), impressions: e.impressions, clicks: e.clicks,
        effectiveStatus: es, active: es === "ACTIVE" }; // active=true только при ACTIVE; пауза/архив → false
    });

    // ВАЛЮТА рекламного аккаунта — критично: spend Meta может быть в USD, а выручка в CRM — в UZS.
    // Без явной валюты ROAS = revenue(UZS)/spend(USD) молча неверен. Забираем currency прямо из Graph.
    try {
      const cr = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${adAccount}?fields=currency&access_token=${metaToken}`);
      const cd = await cr.json();
      if (cd && cd.currency) currency = cd.currency;
    } catch (e) {}

    const result = { updatedAt: new Date().toISOString(), period: `${fmt(since)}..${fmt(now)}`, currency: currency || null, adsets: adsetsSpend };
    await redisSet(redisUrl, redisToken, "meta_spend", JSON.stringify(result));
    res.status(200).json({ ok: true, ...result });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
}
