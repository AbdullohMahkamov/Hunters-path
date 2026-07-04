// /api/sync.js — тянет сделки из воронки клиента, считает живые KPI, кладёт в кэш Upstash.
// Мультитенант: настройки клиента берутся из конфига (org). Витрина hunter = дефолт.

// Дефолтный конфиг витрины (org=hunter) — ровно те значения, что были захардкожены.
const HUNTER_CFG = {
  subdomain: "huntercademy",
  pipeline: "HunterAcademy",
  ownThreshold: 1600000,
  sold: "Sotildi",
  lost: "Yopildi",
  adsetFieldId: 194405,
  mops: {
    13660834: "Komiljon",
    13703650: "Samandar",
    13904266: "Abdulla-Legenda",
    13833590: "Begoyim",
    13681582: "Abulbositxon",
  },
  noContactReasons: [
    "3 marta bog'lanib bo'lmadi", "Ignor", "Telefon raqami o'chirilgan",
    "Javobsiz hamma chatlarni o'chirib tashlagan", "Xato raqam",
    "Ruxsat berishmadi", "Dubl",
  ],
  noContactStages: ["Bog'lanib bo'lmadi", "Bog'lanib bo'lmadi 2"],
};

async function redisGetCfg(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return d && d.result != null ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}

// Возвращает конфиг клиента. Для hunter — дефолт (+ ENV токен). Для новых — из Upstash.
async function resolveConfig(org, redisUrl, redisToken) {
  org = org || "hunter";
  if (org === "hunter") {
    return { org, token: process.env.AMOCRM_TOKEN, ...HUNTER_CFG };
  }
  const stored = await redisGetCfg(redisUrl, redisToken, `clientcfg:${org}`);
  if (!stored || !stored.subdomain || !stored.token) return null;
  return {
    org,
    token: stored.token,
    subdomain: stored.subdomain,
    pipeline: stored.pipeline || "",
    ownThreshold: stored.ownThreshold != null ? stored.ownThreshold : 0,
    sold: stored.sold || "",
    lost: stored.lost || "",
    adsetFieldId: stored.adsetFieldId || null,
    mops: stored.mops || {},
    noContactReasons: stored.noContactReasons || [],
    noContactStages: stored.noContactStages || [],
  };
}

async function redisSet(url, token, key, value) {
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  return r.ok;
}

export default async function handler(req, res) {
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "Upstash env not set" }); return; }

  // какой клиент? по умолчанию hunter (витрина). Новый клиент передаёт ?org=...
  const org = (req.query && req.query.org) || "hunter";
  const cfg = await resolveConfig(org, redisUrl, redisToken);
  if (!cfg) { res.status(400).json({ error: `Клиент "${org}" не настроен` }); return; }

  const token = cfg.token;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }

  // локальные значения из конфига (заменяют прежние захардкоженные константы)
  const SUBDOMAIN = cfg.subdomain;
  const PIPELINE = cfg.pipeline;
  const OWN_THRESHOLD = cfg.ownThreshold;
  const SOLD = cfg.sold;
  const CLOSED_LOST = cfg.lost;
  const ADSET_FIELD_ID = cfg.adsetFieldId;
  const ACTIVE_MOPS = cfg.mops || {};
  const NO_CONTACT_REASONS = new Set(cfg.noContactReasons || []);
  const NO_CONTACT_STAGES = new Set(cfg.noContactStages || []);
  // ключи кэша с префиксом клиента (чтобы данные клиентов не смешивались)
  const K = (name) => org === "hunter" ? name : `${name}:${org}`;

  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  // начало сегодняшнего дня (по локальному времени сервера ~ UTC; для Ташкента UTC+5 сместим)
  const TZ_OFFSET = 5 * 3600; // Узбекистан UTC+5
  const nowLocal = new Date(Date.now() + TZ_OFFSET * 1000);
  const dayStart = Math.floor(new Date(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()) ).getTime() / 1000) - TZ_OFFSET;
  // Тянем лиды, созданные за последние 120 дней, чтобы поймать старые лиды, закрывшиеся в этом месяце.
  // Продажи считаем по дате ЗАКРЫТИЯ (closed_at) в этом месяце. Объём лидов — по created_at в этом месяце.
  const lookbackStart = monthStart - 120 * 24 * 3600;

  try {
    // 1) Статусы воронки HunterAcademy: id -> name, + id самой воронки
    let statusName = {};
    let pipelineId = null;
    const pr = await fetch(`https://${SUBDOMAIN}.amocrm.ru/api/v4/leads/pipelines`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (pr.ok) {
      const pd = await pr.json();
      const pipes = (pd._embedded && pd._embedded.pipelines) || [];
      for (const p of pipes) {
        if (p.name === PIPELINE) {
          pipelineId = p.id;
          const sts = (p._embedded && p._embedded.statuses) || [];
          for (const s of sts) statusName[s.id] = s.name;
        }
      }
    }

    // 2) Причины отказа: id -> name
    let lossName = {};
    const lr = await fetch(`https://${SUBDOMAIN}.amocrm.ru/api/v4/leads/loss_reasons?limit=250`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (lr.ok) {
      const ld = await lr.json();
      for (const x of ((ld._embedded && ld._embedded.loss_reasons) || [])) lossName[x.id] = x.name;
    }

    // 3) Тянем ВСЕ сделки воронки HunterAcademy (вся база — для фильтра «всё время»).
    //    Без фильтра по дате. Задержка минимальная, чтобы уложиться в лимит времени функции.
    let all = [], page = 1, guard = 0;
    while (guard < 100) {
      guard++;
      let url = `https://${SUBDOMAIN}.amocrm.ru/api/v4/leads?limit=250&page=${page}` +
        `&with=loss_reason`;
      if (pipelineId) url += `&filter[pipeline_id]=${pipelineId}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 204) break;
      if (r.status === 429) { await new Promise(rs => setTimeout(rs, 800)); continue; } // rate limit — подождать и повторить
      if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "amoCRM leads error", detail: t.slice(0,500) }); return; }
      const data = await r.json();
      const leads = (data._embedded && data._embedded.leads) || [];
      all = all.concat(leads);
      if (leads.length < 250) break;
      page++;
      await new Promise((rs) => setTimeout(rs, 40));
    }

    // 4) Считаем.
    // ВЫРУЧКА/КАССА — по ВСЕМ аккаунтам, продажи закрытые (closed_at) в этом месяце.
    // КОНВЕРСИЯ/ДИСЦИПЛИНА — по 5 действующим МОПам. Считаем ДВА периода: месяц и всё окно (~4 мес).
    let sold = 0, soldSum = 0, ownExcluded = 0, noContact = 0;
    let soldToday = 0, revenueToday = 0, leadsToday = 0; // метрики за сегодня
    // === VELOCITY (скорость воронки) ===
    const saleDurations = [];      // длительности «создан → продан» в днях (для медианы/среднего)
    const stageDistribution = {};  // текущий статус (открытые лиды) -> количество
    // === ИСТОЧНИКИ РЕКЛАМЫ (adset_name) ===
    const adsets = {};             // adset_name -> {leads, sold, revenue}
    let soldPeriod = 0, revenuePeriod = 0;  // продажи за окно аудита (~4 месяца)
    let soldTeam = 0, soldSumTeam = 0;     // продажи только пятёрки (для среднего чека команды)
    const lossCount = {};                  // причина -> кол-во ЗА МЕСЯЦ (пятёрка)
    const lossCountAll = {};               // причина -> кол-во за окно аудита (~4 мес)
    const byMop = {};                      // name -> {...} метрики за МЕСЯЦ
    // агрегаты за окно аудита (~4 мес) — для аудита
    let leadsAudit = 0, noContactAudit = 0, soldTeamAudit = 0;
    // === ВСЯ БАЗА (все данные, без фильтра дат) — для фильтра «всё время» на дашборде ===
    let leadsBase = 0, soldBase = 0, revenueBase = 0, noContactBase = 0, soldTeamBase = 0;
    const SUSPICIOUS_THRESHOLD = 1000000; // продажа с бюджетом пустым или < 1М — подозрительная
    const suspicious = []; // список подозрительных (с типом и категорией)
    const wrongNumByMopDay = {}; // "mop|day" -> count (для «массово неверный номер»)
    const DAY = 24 * 3600;

    for (const L of all) {
      const stName = statusName[L.status_id] || "";
      const price = L.price || 0;
      const isSold = stName === SOLD;
      const isLost = stName === CLOSED_LOST;

      const createdThisMonth = (L.created_at || 0) >= monthStart;
      const closedThisMonth = (L.closed_at || 0) >= monthStart;
      const inAudit = (L.created_at || 0) >= lookbackStart; // окно аудита
      const mop = ACTIVE_MOPS[L.responsible_user_id]; // null если не из пятёрки
      const respName = ACTIVE_MOPS[L.responsible_user_id] || String(L.responsible_user_id || "");

      // === СЕГОДНЯ: лиды обработанные (созданные сегодня), продажи и касса за сегодня ===
      if ((L.created_at || 0) >= dayStart) leadsToday++;
      if (isSold && (L.closed_at || 0) >= dayStart) { soldToday++; revenueToday += price; }

      // === VELOCITY ===
      // время «создан → продан» в днях (для проданных с корректными датами)
      if (isSold && L.created_at && L.closed_at && L.closed_at > L.created_at) {
        const days = (L.closed_at - L.created_at) / DAY;
        if (days >= 0 && days < 365) saleDurations.push(days);
      }
      // распределение открытых лидов по текущему этапу (не продано и не закрыто)
      if (!isSold && !isLost) {
        stageDistribution[stName] = (stageDistribution[stName] || 0) + 1;
      }

      // === ИСТОЧНИК РЕКЛАМЫ (adset_name) ===
      let adset = "";
      const cfv = L.custom_fields_values || (L._embedded && L._embedded.custom_fields_values);
      if (Array.isArray(cfv)) {
        const f = cfv.find(x => x.field_id === ADSET_FIELD_ID);
        if (f && f.values && f.values[0]) adset = String(f.values[0].value || "").trim();
      }
      if (adset) {
        // всё время
        const a = adsets[adset] || (adsets[adset] = { leads: 0, sold: 0, revenue: 0, leadsMonth: 0, soldMonth: 0, revenueMonth: 0 });
        a.leads++;
        if (isSold) { a.sold++; a.revenue += price; }
        // текущий месяц: лид создан в этом месяце ИЛИ продажа закрыта в этом месяце
        if (createdThisMonth) a.leadsMonth++;
        if (isSold && closedThisMonth) { a.soldMonth++; a.revenueMonth += price; }
      }

      // причина потери (по имени)
      let lossReason = "";
      {
        const lid = L.loss_reason_id || (L._embedded && L._embedded.loss_reason && L._embedded.loss_reason[0] && L._embedded.loss_reason[0].id);
        if (lid && lossName[lid]) lossReason = lossName[lid];
      }
      const base = { id: L.id, name: L.name || "", price, responsible: respName, closed_at: L.closed_at || 0, created_at: L.created_at || 0 };

      // [ДЕНЬГИ] продажа с пустым или маленьким (<1М) бюджетом
      if (isSold && (!price || price < SUSPICIOUS_THRESHOLD)) {
        suspicious.push({ ...base, cat: "money", type: "low_check", label: "Чек до 1 млн (аванс/предоплата?)" });
      }

      // [ВОРОНКА] продажа в день создания — лид создан и продан в тот же день
      if (isSold && L.created_at && L.closed_at && (L.closed_at - L.created_at) < DAY && (L.closed_at - L.created_at) >= 0) {
        suspicious.push({ ...base, cat: "funnel", type: "same_day_sale", label: "Продажа в день создания (проверить)" });
      }

      // [ЗВОНКИ] копим «неверный номер» по МОПу за день — потом отберём тех, у кого ≥5/день
      if (isLost && /xato raqam|неверн/i.test(lossReason) && mop && L.closed_at) {
        const dk = Math.floor((L.closed_at + 5 * 3600) / DAY); // день по UTC+5
        const key = mop + "|" + dk;
        (wrongNumByMopDay[key] = wrongNumByMopDay[key] || { count: 0, mop, day: L.closed_at, items: [] });
        wrongNumByMopDay[key].count++;
        wrongNumByMopDay[key].items.push(base);
      }

      // === ВСЯ БАЗА (все аккаунты воронки) — считаем ВСЕ продажи ===
      leadsBase++;
      if (isSold) { soldBase++; revenueBase += price; }

      // === ВЫРУЧКА: ВСЕ аккаунты, проданные в этом месяце ===
      if (isSold && closedThisMonth) {
        sold++; soldSum += price;
      }
      // === ПРОДАЖИ ЗА ПЕРИОД (~4 месяца): для аудита ===
      if (isSold && (L.closed_at || 0) >= lookbackStart) {
        soldPeriod++; revenuePeriod += price;
      }

      // === ПРОБЛЕМЫ: за месяц и за окно аудита отдельно ===
      if (stName === CLOSED_LOST) {
        let reason = "";
        const lossId = L.loss_reason_id || (L._embedded && L._embedded.loss_reason && L._embedded.loss_reason[0] && L._embedded.loss_reason[0].id);
        if (lossId && lossName[lossId]) reason = lossName[lossId];
        if (reason) {
          if (inAudit) lossCountAll[reason] = (lossCountAll[reason] || 0) + 1;
          if (closedThisMonth) lossCount[reason] = (lossCount[reason] || 0) + 1;
        }
      }

      // недозвон по ВСЕЙ БАЗЕ (для «всё время»)
      {
        let rb = "";
        const lid = L.loss_reason_id || (L._embedded && L._embedded.loss_reason && L._embedded.loss_reason[0] && L._embedded.loss_reason[0].id);
        if (lid && lossName[lid]) rb = lossName[lid];
        if (stName === CLOSED_LOST) { if (NO_CONTACT_REASONS.has(rb)) noContactBase++; }
        else if (NO_CONTACT_STAGES.has(stName)) noContactBase++;
      }

      // === МЕТРИКИ КОМАНДЫ: только пятёрка ===
      if (mop) {
        if (!byMop[mop]) byMop[mop] = { leads: 0, sold: 0, revenue: 0, noContact: 0 };

        // ЗА МЕСЯЦ: объём лидов и дозвон — по созданным в этом месяце
        if (createdThisMonth) {
          byMop[mop].leads++;
          if (stName === CLOSED_LOST) {
            let reason = "";
            const lossId = L.loss_reason_id || (L._embedded && L._embedded.loss_reason && L._embedded.loss_reason[0] && L._embedded.loss_reason[0].id);
            if (lossId && lossName[lossId]) reason = lossName[lossId];
            if (NO_CONTACT_REASONS.has(reason)) { noContact++; byMop[mop].noContact++; }
          } else if (NO_CONTACT_STAGES.has(stName)) {
            noContact++; byMop[mop].noContact++;
          }
        }
        // ЗА ОКНО АУДИТА: лиды и недозвон
        if (inAudit) {
          leadsAudit++;
          if (stName === CLOSED_LOST) {
            let reason2 = "";
            const lossId2 = L.loss_reason_id || (L._embedded && L._embedded.loss_reason && L._embedded.loss_reason[0] && L._embedded.loss_reason[0].id);
            if (lossId2 && lossName[lossId2]) reason2 = lossName[lossId2];
            if (NO_CONTACT_REASONS.has(reason2)) noContactAudit++;
          } else if (NO_CONTACT_STAGES.has(stName)) {
            noContactAudit++;
          }
          if (isSold && (L.closed_at || 0) >= lookbackStart) soldTeamAudit++;
        }

        // продажи пятёрки — по закрытым в этом месяце (для среднего чека)
        if (isSold && closedThisMonth) {
          soldTeam++; soldSumTeam += price;
          byMop[mop].sold++; byMop[mop].revenue += price;
        }
        // продажи пятёрки за всю базу
        if (isSold) soldTeamBase++;
      }
    }

    // [ЗВОНКИ] «массово неверный номер» — МОП поставил ≥5 «неверный номер» за один день
    for (const key in wrongNumByMopDay) {
      const w = wrongNumByMopDay[key];
      if (w.count >= 5) {
        suspicious.push({
          id: "wrongnum_" + key,
          name: `${w.mop}: ${w.count} «неверных номеров» за день`,
          price: null,
          responsible: w.mop,
          closed_at: w.day,
          created_at: w.day,
          cat: "calls",
          type: "wrong_number_abuse",
          label: "Массово «неверный номер» (≥5/день)",
          count: w.count,
        });
      }
    }

    // [ЗАДАЧИ] просроченные задачи активных МОПов (срок прошёл, не выполнена)
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      let tpage = 1, tguard = 0;
      while (tguard < 40) {
        tguard++;
        const turl = `https://${SUBDOMAIN}.amocrm.ru/api/v4/tasks?limit=250&page=${tpage}&filter[is_completed]=0`;
        const tr = await fetch(turl, { headers: { Authorization: `Bearer ${token}` } });
        if (tr.status === 204) break;
        if (!tr.ok) break;
        const td = await tr.json();
        const tasks = (td._embedded && td._embedded.tasks) || [];
        for (const T of tasks) {
          const mopName = ACTIVE_MOPS[T.responsible_user_id];
          if (!mopName) continue;
          // просрочена: срок (complete_till) прошёл (со следующего дня — т.е. строго меньше начала сегодня)
          if (T.complete_till && T.complete_till < nowSec) {
            suspicious.push({
              id: "task_" + T.id,
              name: (T.text || "Задача").slice(0, 80),
              price: null,
              responsible: mopName,
              closed_at: T.complete_till,
              created_at: T.created_at || 0,
              cat: "tasks",
              type: "overdue_task",
              label: "Просроченная задача",
              leadId: (T.entity_type === "leads" ? T.entity_id : null),
            });
          }
        }
        if (tasks.length < 250) break;
        tpage++;
        await new Promise(rs => setTimeout(rs, 60));
      }
    } catch (e) { /* задачи не критичны */ }

    const totalLeads = Object.values(byMop).reduce((a, m) => a + m.leads, 0);
    const conv = totalLeads > 0 ? +(soldTeam / totalLeads * 100).toFixed(2) : 0;
    // Средний чек — по всей кассе (все аккаунты)
    const avgCheck = sold > 0 ? Math.round(soldSum / sold) : 0;
    const noContactPct = totalLeads > 0 ? +(noContact / totalLeads * 100).toFixed(0) : 0;

    // === ВСЁ ВРЕМЯ = ВСЯ БАЗА (для дашборда) ===
    const convAll = leadsBase > 0 ? +(soldTeamBase / leadsBase * 100).toFixed(2) : 0;
    const noContactPctAll = leadsBase > 0 ? +(noContactBase / leadsBase * 100).toFixed(0) : 0;

    // === VELOCITY: медиана и среднее «создан → продан» + распределение по этапам ===
    let velocityMedian = null, velocityAvg = null;
    if (saleDurations.length) {
      const sorted = saleDurations.slice().sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      velocityMedian = +(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2).toFixed(1);
      velocityAvg = +(saleDurations.reduce((a, b) => a + b, 0) / saleDurations.length).toFixed(1);
    }
    // распределение по этапам -> отсортированный массив [{name, count}]
    const stagesArr = Object.entries(stageDistribution)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // === ИСТОЧНИКИ РЕКЛАМЫ: месяц + всё время, сортировка по выручке месяца ===
    const adsetsArr = Object.entries(adsets)
      .map(([name, a]) => ({
        name,
        // всё время
        leads: a.leads, sold: a.sold, revenue: a.revenue,
        conv: a.leads > 0 ? +(a.sold / a.leads * 100).toFixed(1) : 0,
        avgCheck: a.sold > 0 ? Math.round(a.revenue / a.sold) : 0,
        // текущий месяц
        leadsMonth: a.leadsMonth, soldMonth: a.soldMonth, revenueMonth: a.revenueMonth,
        convMonth: a.leadsMonth > 0 ? +(a.soldMonth / a.leadsMonth * 100).toFixed(1) : 0,
        avgCheckMonth: a.soldMonth > 0 ? Math.round(a.revenueMonth / a.soldMonth) : 0,
      }))
      .sort((x, y) => y.revenueMonth - x.revenueMonth);

    // === ОКНО АУДИТА (~4 мес) — отдельно, для аудита ===
    const convAudit = leadsAudit > 0 ? +(soldTeamAudit / leadsAudit * 100).toFixed(2) : 0;
    const noContactPctAudit = leadsAudit > 0 ? +(noContactAudit / leadsAudit * 100).toFixed(0) : 0;

    // МОПы: конверсия + дозвон + топ по продажам
    const mops = Object.entries(byMop).map(([name, v]) => ({
      name,
      leads: v.leads,
      sold: v.sold,
      revenue: v.revenue,
      conv: v.leads > 0 ? +(v.sold / v.leads * 100).toFixed(2) : 0,
      reachPct: v.leads > 0 ? +((v.leads - v.noContact) / v.leads * 100).toFixed(0) : 0, // % дозвона
    }));
    const mopsByConv = [...mops].sort((a, b) => b.conv - a.conv);
    const mopsBySales = [...mops].sort((a, b) => b.sold - a.sold);

    // Топ-5 проблем ЗА МЕСЯЦ
    const problems = Object.entries(lossCount)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    // Топ-5 проблем ЗА ВСЁ ОКНО
    const problemsAll = Object.entries(lossCountAll)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const result = {
      updatedAt: new Date().toISOString(),
      period: "Текущий месяц",
      totals: {
        leads: totalLeads,
        sold,                       // продаж всего (все аккаунты) — текущий месяц
        revenue: soldSum,           // выручка всего (все аккаунты) — касса месяца
        soldPeriod,                 // продаж за ~4 месяца (для аудита)
        revenuePeriod,              // выручка за ~4 месяца (для аудита)
        soldTeam,                   // продаж только пятёрки
        revenueTeam: soldSumTeam,   // выручка пятёрки
        conv, avgCheck,
        noContactPct, ownExcluded,
        goal: 500000000,
        goalPct: +(soldSum / 500000000 * 100).toFixed(0),
        needPerMonth: 141,
        // === ВСЁ ВРЕМЯ = ВСЯ БАЗА (для дашборда) ===
        leadsAll: leadsBase,          // все лиды в базе (~8000)
        soldAll: soldBase,            // все продажи в базе (140+)
        soldTeamAll: soldTeamBase,    // продажи пятёрки за всю базу (для конверсии)
        revenueAll: revenueBase,      // вся выручка базы
        convAll,                      // конверсия по всей базе
        noContactPctAll,              // недозвон по всей базе
        // === СЕГОДНЯ ===
        soldToday, revenueToday, leadsToday,
        // === ОКНО АУДИТА (~4 мес) — отдельно ===
        convAudit, noContactPctAudit, leadsAudit,
        suspiciousCount: suspicious.length,
      },
      mopsByConv, mopsBySales, problems, problemsAll,
      velocity: { median: velocityMedian, avg: velocityAvg, count: saleDurations.length, stages: stagesArr },
      adsets: adsetsArr.slice(0, 50),
      suspicious: suspicious.sort((a, b) => (b.closed_at || b.created_at || 0) - (a.closed_at || a.created_at || 0)).slice(0, 200),
    };

    await redisSet(redisUrl, redisToken, K("dashboard"), JSON.stringify(result));

    // === СНИМОК ДНЯ ДЛЯ ДИНАМИКИ ===
    // Ключ по дате (YYYY-MM-DD). Перезапись за тот же день — норм (последнее значение дня).
    try {
      const today = new Date().toISOString().slice(0, 10);
      const snap = {
        date: today,
        sold: result.totals.sold,
        revenue: result.totals.revenue,
        soldPeriod: result.totals.soldPeriod,
        conv: result.totals.conv,
        leads: result.totals.leads,
        noContactPct: result.totals.noContactPct,
      };
      await redisSet(redisUrl, redisToken, K(`snap:${today}`), JSON.stringify(snap));
      // ведём список дат снимков (последние 90)
      let dates = (await (async () => {
        try {
          const r = await fetch(`${redisUrl}/get/${encodeURIComponent(K("snap:list"))}`, { headers: { Authorization: `Bearer ${redisToken}` } });
          const d = await r.json();
          return d && d.result ? JSON.parse(d.result) : [];
        } catch (e) { return []; }
      })());
      if (!dates.includes(today)) dates.push(today);
      dates = dates.slice(-90); // храним максимум 90 дней
      await redisSet(redisUrl, redisToken, K("snap:list"), JSON.stringify(dates));
    } catch (e) { /* снимок не критичен, не роняем sync */ }

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "Sync failed", detail: String(err) });
  }
}
