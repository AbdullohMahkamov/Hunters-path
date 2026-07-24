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
      fields: "adset_name,spend,impressions,clicks",
      time_range: timeRange,
      limit: "500",
      access_token: metaToken,
    });

    const spendByAdset = {};
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
        const name = (row.adset_name || "").trim();
        if (!name) continue;
        const spend = parseFloat(row.spend || "0") || 0; // Meta отдаёт строкой!
        const e = spendByAdset[name] || (spendByAdset[name] = { spend: 0, impressions: 0, clicks: 0 });
        e.spend += spend;
        e.impressions += parseInt(row.impressions || "0", 10) || 0;
        e.clicks += parseInt(row.clicks || "0", 10) || 0;
      }
      url = (d.paging && d.paging.next) || null;
    }

    const adsetsSpend = Object.entries(spendByAdset).map(([name, e]) => ({
      name, spend: Math.round(e.spend), impressions: e.impressions, clicks: e.clicks,
    }));

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
