// /api/sync.js — тянет сделки из воронки HunterAcademy, считает живые KPI, кладёт в кэш Upstash.
// Запуск: ночью (Vercel Cron) или вручную кнопкой. amoCRM дёргается только тут, раз в сутки.

const SUBDOMAIN = "huntercademy";
const PIPELINE = "HunterAcademy";   // считаем ТОЛЬКО эту воронку
const OWN_THRESHOLD = 1600000;      // <=1.6М = "свои", исключаем
const SOLD = "Sotildi";
const CLOSED_LOST = "Yopildi";

// Действующая пятёрка МОПов (ID из amoCRM)
const ACTIVE_MOPS = {
  13660834: "Komiljon",
  13703650: "Samandar",
  13904266: "Abdulla-Legenda",
  13833590: "Begoyim",
  13681582: "Abulbositxon",
};

// Причины потери контакта (дозвон не состоялся / мусор)
const NO_CONTACT_REASONS = new Set([
  "3 marta bog'lanib bo'lmadi", "Ignor", "Telefon raqami o'chirilgan",
  "Javobsiz hamma chatlarni o'chirib tashlagan", "Xato raqam",
  "Ruxsat berishmadi", "Dubl",
]);
// Этапы "в процессе дозвона" тоже считаем непробитым контактом, если сделка закрылась там
const NO_CONTACT_STAGES = new Set(["Bog'lanib bo'lmadi", "Bog'lanib bo'lmadi 2"]);

async function redisSet(url, token, key, value) {
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

  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
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
    const suspicious = []; // список подозрительных продаж

    for (const L of all) {
      const stName = statusName[L.status_id] || "";
      const price = L.price || 0;
      const isSold = stName === SOLD;

      const createdThisMonth = (L.created_at || 0) >= monthStart;
      const closedThisMonth = (L.closed_at || 0) >= monthStart;
      const inAudit = (L.created_at || 0) >= lookbackStart; // окно аудита
      const mop = ACTIVE_MOPS[L.responsible_user_id]; // null если не из пятёрки

      // === ПОДОЗРИТЕЛЬНЫЕ: проданные сделки с пустым или маленьким (<1М) бюджетом ===
      if (isSold && (!price || price < SUSPICIOUS_THRESHOLD)) {
        suspicious.push({
          id: L.id,
          name: L.name || "",
          price: price,
          responsible: ACTIVE_MOPS[L.responsible_user_id] || String(L.responsible_user_id || ""),
          closed_at: L.closed_at || 0,
          created_at: L.created_at || 0,
        });
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

    const totalLeads = Object.values(byMop).reduce((a, m) => a + m.leads, 0);
    const conv = totalLeads > 0 ? +(soldTeam / totalLeads * 100).toFixed(2) : 0;
    // Средний чек — по всей кассе (все аккаунты)
    const avgCheck = sold > 0 ? Math.round(soldSum / sold) : 0;
    const noContactPct = totalLeads > 0 ? +(noContact / totalLeads * 100).toFixed(0) : 0;

    // === ВСЁ ВРЕМЯ = ВСЯ БАЗА (для дашборда) ===
    const convAll = leadsBase > 0 ? +(soldTeamBase / leadsBase * 100).toFixed(2) : 0;
    const noContactPctAll = leadsBase > 0 ? +(noContactBase / leadsBase * 100).toFixed(0) : 0;

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
        revenueAll: revenueBase,      // вся выручка базы
        convAll,                      // конверсия по всей базе
        noContactPctAll,              // недозвон по всей базе
        // === ОКНО АУДИТА (~4 мес) — отдельно ===
        convAudit, noContactPctAudit, leadsAudit,
        suspiciousCount: suspicious.length,
      },
      mopsByConv, mopsBySales, problems, problemsAll,
      suspicious: suspicious.sort((a, b) => (b.closed_at || b.created_at || 0) - (a.closed_at || a.created_at || 0)).slice(0, 200),
    };

    await redisSet(redisUrl, redisToken, "dashboard", JSON.stringify(result));

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
      await redisSet(redisUrl, redisToken, `snap:${today}`, JSON.stringify(snap));
      // ведём список дат снимков (последние 90)
      let dates = (await (async () => {
        try {
          const r = await fetch(`${redisUrl}/get/snap:list`, { headers: { Authorization: `Bearer ${redisToken}` } });
          const d = await r.json();
          return d && d.result ? JSON.parse(d.result) : [];
        } catch (e) { return []; }
      })());
      if (!dates.includes(today)) dates.push(today);
      dates = dates.slice(-90); // храним максимум 90 дней
      await redisSet(redisUrl, redisToken, "snap:list", JSON.stringify(dates));
    } catch (e) { /* снимок не критичен, не роняем sync */ }

    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "Sync failed", detail: String(err) });
  }
}
