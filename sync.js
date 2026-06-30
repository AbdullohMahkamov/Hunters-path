// /api/sync.js — тянет сделки из amoCRM, считает KPI, кладёт в кэш (Upstash Redis).
// Запускается: ночью по расписанию (Vercel Cron) ИЛИ вручную кнопкой "обновить".
// amoCRM дёргается ТОЛЬКО здесь, раз в сутки. Дашборд читает готовый кэш из /api/dashboard.

const SUBDOMAIN = "huntercademy";
const OWN_THRESHOLD = 1600000; // сделки <= 1.6М = "свои", исключаем из коммерции
const SOLD_STAGE = "SOTILDI";

// Имена этапов, которые считаем "контакт состоялся НЕ был" (потеря на дозвоне)
const NO_CONTACT = [
  "BOG'LANIB BO'LMADI", "BOG'LANIB BO'LMADI 2",
];

async function redisSet(url, token, key, value) {
  // Upstash REST: POST /set/{key} with body = value
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  return r.ok;
}

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "Upstash env not set" }); return; }

  // Период: текущий месяц (с 1 числа 00:00 по локальному времени)
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  try {
    let page = 1;
    let all = [];
    let guard = 0;
    // Тянем сделки постранично (250 за раз). Фильтр по дате создания >= начало месяца.
    while (guard < 60) {
      guard++;
      const url = `https://${SUBDOMAIN}.amocrm.ru/api/v4/leads?limit=250&page=${page}` +
        `&with=loss_reason&filter[created_at][from]=${monthStart}`;
      const r = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 204) break; // нет больше данных
      if (!r.ok) {
        const t = await r.text();
        res.status(r.status).json({ error: "amoCRM error", detail: t.slice(0, 500) });
        return;
      }
      const data = await r.json();
      const leads = (data._embedded && data._embedded.leads) || [];
      all = all.concat(leads);
      if (leads.length < 250) break; // последняя страница
      page++;
      await new Promise((rs) => setTimeout(rs, 180)); // пауза ~5 req/sec, бережём лимит amoCRM
    }

    // Карта статусов: id -> name (тянем воронки/статусы)
    let statusName = {};
    try {
      const pr = await fetch(`https://${SUBDOMAIN}.amocrm.ru/api/v4/leads/pipelines`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (pr.ok) {
        const pd = await pr.json();
        const pipes = (pd._embedded && pd._embedded.pipelines) || [];
        for (const p of pipes) {
          const sts = (p._embedded && p._embedded.statuses) || [];
          for (const s of sts) statusName[s.id] = (s.name || "").toUpperCase();
        }
      }
    } catch (e) {}

    // Карта пользователей: id -> name
    let userName = {};
    try {
      const ur = await fetch(`https://${SUBDOMAIN}.amocrm.ru/api/v4/users?limit=250`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (ur.ok) {
        const ud = await ur.json();
        const users = (ud._embedded && ud._embedded.users) || [];
        for (const u of users) userName[u.id] = u.name || ("user" + u.id);
      }
    } catch (e) {}

    // Считаем
    const total = all.length;
    let sold = 0, soldSum = 0, noContact = 0, ownExcluded = 0;
    const byMop = {}; // name -> {leads, sold}

    for (const L of all) {
      const stName = statusName[L.status_id] || "";
      const price = L.price || 0;
      const isSold = stName === SOLD_STAGE;
      const isOwn = isSold && price <= OWN_THRESHOLD;
      if (isOwn) { ownExcluded++; continue; } // "свои" вообще вне расчётов

      const mop = userName[L.responsible_user_id] || "—";
      if (!byMop[mop]) byMop[mop] = { leads: 0, sold: 0, revenue: 0 };
      byMop[mop].leads++;

      if (isSold) { sold++; soldSum += price; byMop[mop].sold++; byMop[mop].revenue += price; }
      if (NO_CONTACT.includes(stName)) noContact++;
    }

    const denom = total - ownExcluded;
    const conv = denom > 0 ? (sold / denom * 100) : 0;
    const avgCheck = sold > 0 ? Math.round(soldSum / sold) : 0;

    const mopArr = Object.entries(byMop)
      .map(([name, v]) => ({
        name, leads: v.leads, sold: v.sold,
        conv: v.leads > 0 ? +(v.sold / v.leads * 100).toFixed(2) : 0,
        revenue: v.revenue,
      }))
      .sort((a, b) => b.conv - a.conv);

    const result = {
      updatedAt: new Date().toISOString(),
      period: "Текущий месяц",
      totals: {
        leads: denom,
        sold,
        revenue: soldSum,
        conv: +conv.toFixed(2),
        avgCheck,
        noContactPct: denom > 0 ? +(noContact / denom * 100).toFixed(0) : 0,
        ownExcluded,
        goal: 500000000,
        goalPct: +(soldSum / 500000000 * 100).toFixed(0),
      },
      mops: mopArr,
    };

    await redisSet(redisUrl, redisToken, "dashboard", JSON.stringify(result));

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "Sync failed", detail: String(err) });
  }
}
