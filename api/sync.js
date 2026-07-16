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
  saleDateFieldId: 109880, // "Sotuv sanasi:" — реальная дата продажи (вместо даты смены статуса)
  // доплаты: пары [сумма, дата] — каждая доплата учитывается в месяце по своей дате
  doplataFields: [
    { sum: 511439, date: 511441 }, // Doplata-1
    { sum: 511443, date: 511445 }, // Doplata-2
    { sum: 511447, date: 511449 }, // Doplata-3
  ],
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
  fakeNumReasons: ["Xato raqam", "Dubl"],   // брак данных (неверный номер, дубль) — ВОН из знаменателя дозвона
  contactedReasons: ["Ruxsat berishmadi"],  // контакт БЫЛ (не дали разрешение) — считать дозвоном, не недозвоном
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
    fakeNumReasons: stored.fakeNumReasons || [],
    contactedReasons: stored.contactedReasons || [],
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
  const SALE_DATE_FIELD = cfg.saleDateFieldId || null;   // реальная дата продажи
  const DOPLATA_FIELDS = cfg.doplataFields || [];         // [{sum, date}, ...]
  const ACTIVE_MOPS = cfg.mops || {};
  const NO_CONTACT_REASONS = new Set(cfg.noContactReasons || []);
  const NO_CONTACT_STAGES = new Set(cfg.noContactStages || []);
  const FAKE_NUM_REASONS = new Set(cfg.fakeNumReasons || []);    // Xato raqam, Dubl — исключаем из знаменателя дозвона
  const CONTACTED_REASONS = new Set(cfg.contactedReasons || []); // Ruxsat berishmadi — контакт был, это дозвон
  // ключи кэша с префиксом клиента (чтобы данные клиентов не смешивались)
  const K = (name) => org === "hunter" ? name : `${name}:${org}`;

  const now = new Date();
  // Границы месяца/дня — по КАЛЕНДАРЮ ТАШКЕНТА (UTC+5), а не по UTC сервера Vercel.
  // Иначе на стыке суток/месяца (00:00–05:00 по Ташкенту) продажи уезжали в прошлый период.
  const TZ_OFFSET = 5 * 3600; // Узбекистан UTC+5
  const nowLocal = new Date(Date.now() + TZ_OFFSET * 1000); // «сейчас» в календаре Ташкента (через UTC-геттеры)
  const monthStart = Math.floor(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), 1) / 1000) - TZ_OFFSET;
  const nextMonth = Math.floor(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth() + 1, 1) / 1000) - TZ_OFFSET;
  const dayStart = Math.floor(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()) / 1000) - TZ_OFFSET;
  // Тянем лиды, созданные за последние 120 дней, чтобы поймать старые лиды, закрывшиеся в этом месяце.
  // Продажи считаем по дате ЗАКРЫТИЯ (closed_at) в этом месяце. Объём лидов — по created_at в этом месяце.
  const lookbackStart = monthStart - 120 * 24 * 3600;

  // ===== ХЕЛПЕРЫ: реальная дата продажи и доплаты =====
  const cfvOf = (L) => L.custom_fields_values || (L._embedded && L._embedded.custom_fields_values) || [];
  const readNum = (L, fid) => {
    if (!fid) return 0;
    const cfv = cfvOf(L); const f = Array.isArray(cfv) ? cfv.find(x => x.field_id === fid) : null;
    if (f && f.values && f.values[0] && f.values[0].value != null) { const n = parseFloat(f.values[0].value); return isNaN(n) ? 0 : n; }
    return 0;
  };
  const readDate = (L, fid) => {
    if (!fid) return null;
    const cfv = cfvOf(L); const f = Array.isArray(cfv) ? cfv.find(x => x.field_id === fid) : null;
    if (f && f.values && f.values[0] && f.values[0].value != null) {
      const v = f.values[0].value;
      return typeof v === "number" ? v : Math.floor(new Date(v).getTime() / 1000);
    }
    return null;
  };
  // реальная дата продажи: Sotuv sanasi → иначе closed_at
  const realSaleTs = (L) => readDate(L, SALE_DATE_FIELD) || L.closed_at || 0;
  // список доплат сделки: [{sum, ts}] — только заполненные
  const doplatasOf = (L) => {
    const out = [];
    for (const df of DOPLATA_FIELDS) {
      const sum = readNum(L, df.sum);
      if (sum > 0) { const ts = readDate(L, df.date) || realSaleTs(L); out.push({ sum, ts }); }
    }
    return out;
  };
  // сумма доплат, попавших в диапазон [from, to)
  const doplataInRange = (L, from, to) => doplatasOf(L).reduce((s, d) => (d.ts >= from && d.ts < to ? s + d.sum : s), 0);


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
    // ЗАЩИТА КЭША: если воронку/статусы не получили (сбой или 429 на /pipelines, либо имя не совпало),
    // то statusName пуст → stName="" у всех → isSold=false → нули. НЕ перезаписываем корректный дашборд —
    // прерываем sync, чтобы разовый сбой amoCRM не обнулял витрину.
    if (!pipelineId || Object.keys(statusName).length === 0) {
      res.status(502).json({ error: "amoCRM: воронка/статусы не получены — синхронизация прервана, кэш не изменён" });
      return;
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
    let newSalesSum = 0; // выручка ТОЛЬКО новых продаж месяца (без доплат) — для среднего чека
    let soldToday = 0, revenueToday = 0, leadsToday = 0; // метрики за сегодня
    // === VELOCITY (скорость воронки) ===
    const saleDurations = [];      // длительности «создан → продан» в днях (для медианы/среднего)
    const stageDistribution = {};  // текущий статус (открытые лиды) -> количество
    // === КОММЕРЧЕСКАЯ ВОРОНКА (деньги/цикл) — аддитивно, для Dev-Agent/Growth Agent ===
    const checks = [];             // цены выигранных сделок месяца (для МЕДИАННОГО чека, устойчив к выбросам)
    const mopDurations = {};       // name -> [дни цикла сделки] (цикл по каждому МОПу)
    let paidReceiptCount = 0;      // сделок с приложенным чеком оплаты (To'lov cheki) — ИНФО-сигнал, не trust-«оплачено»
    const PAID_RECEIPT_FIELD_ID = 117856; // клиент-специфично (Hunter Academy). У других org поля нет → счётчик 0. При тираже → в конфиг.
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
      // ПРОДАЖА считается в месяце по РЕАЛЬНОЙ дате продажи (Sotuv sanasi), а не по смене статуса
      const saleTs = realSaleTs(L);
      const closedThisMonth = isSold && saleTs >= monthStart && saleTs < nextMonth;
      const inAudit = (L.created_at || 0) >= lookbackStart; // окно аудита
      const mop = ACTIVE_MOPS[L.responsible_user_id]; // null если не из пятёрки
      const respName = ACTIVE_MOPS[L.responsible_user_id] || String(L.responsible_user_id || "");

      // === СЕГОДНЯ: лиды обработанные (созданные сегодня), продажи и касса за сегодня ===
      if ((L.created_at || 0) >= dayStart) leadsToday++;
      // продажа сегодня — по реальной дате продажи; касса сегодня = price + доплаты по старым сделкам
      if (isSold && saleTs >= dayStart) { soldToday++; revenueToday += price; }
      // доплата сегодня прибавляется только если продажа была раньше (не сегодня)
      if (isSold && saleTs < dayStart) { revenueToday += doplataInRange(L, dayStart, dayStart + 24 * 3600); }

      // === VELOCITY ===
      // время «создан → продан» в днях (для проданных с корректными датами)
      if (isSold && L.created_at && L.closed_at && L.closed_at > L.created_at) {
        const days = (L.closed_at - L.created_at) / DAY;
        if (days >= 0 && days < 365) { saleDurations.push(days); if (mop) (mopDurations[mop] = mopDurations[mop] || []).push(days); }
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

      // === ВЫРУЧКА: ВСЕ аккаунты, проданные в этом месяце (по реальной дате) ===
      if (isSold && closedThisMonth) {
        sold++; soldSum += price; newSalesSum += price; // newSalesSum — только новые продажи, без доплат (для среднего чека)
        if (price > 0) checks.push(price); // для медианного чека
        // чек оплаты приложен? (To'lov cheki) — инфо-сигнал
        const cfvP = L.custom_fields_values || (L._embedded && L._embedded.custom_fields_values);
        if (Array.isArray(cfvP) && cfvP.some(x => x.field_id === PAID_RECEIPT_FIELD_ID && x.values && x.values[0] && x.values[0].value)) paidReceiptCount++;
      }
      // Доплаты в этом месяце учитываем ТОЛЬКО если сама продажа была в ПРОШЛЫЕ месяцы.
      // Если продажа этого месяца — доплата уже включена в price (полная сумма), не задваиваем.
      // Доплаты идут в общую кассу (soldSum), но НЕ в средний чек (newSalesSum).
      if (isSold && !closedThisMonth) {
        soldSum += doplataInRange(L, monthStart, nextMonth);
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
        if (!byMop[mop]) byMop[mop] = { leads: 0, sold: 0, revenue: 0, noContact: 0, soldToday: 0, revenueToday: 0, ncReasons: {}, ncStages: {}, denomStages: {}, fakeNums: 0, contacted: 0 };

        // ЗА МЕСЯЦ: объём лидов и дозвон — по созданным в этом месяце
        if (createdThisMonth) {
          // причина потери (нужна для классификации брака/контакта)
          let reason = "";
          if (stName === CLOSED_LOST) {
            const lossId = L.loss_reason_id || (L._embedded && L._embedded.loss_reason && L._embedded.loss_reason[0] && L._embedded.loss_reason[0].id);
            if (lossId && lossName[lossId]) reason = lossName[lossId];
          }
          if (stName === CLOSED_LOST && FAKE_NUM_REASONS.has(reason)) {
            // (1) БРАК ДАННЫХ (неверный номер / дубль) — НЕ реальный лид: исключён из объёма, конверсии И дозвона. Считаем отдельно для показа.
            byMop[mop].fakeNums++;
            byMop[mop].ncReasons[reason] = (byMop[mop].ncReasons[reason] || 0) + 1; // _diag: видно, что и сколько исключили
          } else {
            byMop[mop].leads++;                                                          // реальные лиды (без брака) — объём и конверсия
            byMop[mop].denomStages[stName] = (byMop[mop].denomStages[stName] || 0) + 1;  // _diag: состав знаменателя по этапу
            if (stName === CLOSED_LOST) {
              if (CONTACTED_REASONS.has(reason)) {
                // (2) КОНТАКТ БЫЛ (не дали разрешение) — это ДОЗВОН: в знаменателе, НЕ в недозвоне
                byMop[mop].contacted++;
              } else if (NO_CONTACT_REASONS.has(reason)) {
                // (3/4) прочие причины потери (в т.ч. Telefon o'chirilgan) — недозвон как есть
                noContact++; byMop[mop].noContact++; byMop[mop].ncReasons[reason] = (byMop[mop].ncReasons[reason] || 0) + 1;
              }
            } else if (NO_CONTACT_STAGES.has(stName)) {
              noContact++; byMop[mop].noContact++; byMop[mop].ncStages[stName] = (byMop[mop].ncStages[stName] || 0) + 1;
            }
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
        // доплаты МОПа в этом месяце по сделкам ПРОШЛЫХ месяцев (в price текущей продажи доплата уже включена — не задваиваем)
        if (isSold && !closedThisMonth) { byMop[mop].revenue += doplataInRange(L, monthStart, nextMonth); }
        // продажи пятёрки за СЕГОДНЯ (по реальной дате продажи, UTC+5)
        if (isSold && saleTs >= dayStart) { byMop[mop].soldToday++; byMop[mop].revenueToday += price; }
        // доплата МОПа сегодня по старой сделке (продажа была раньше сегодня) — тоже в личную кассу за сегодня
        else if (isSold && saleTs < dayStart) { byMop[mop].revenueToday += doplataInRange(L, dayStart, dayStart + DAY); }
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
    // Средний чек — по всей кассе (все аккаунты). СРЕДНЕЕ + МЕДИАНА (медиана устойчива к редким крупным сделкам).
    const avgCheck = sold > 0 ? Math.round(newSalesSum / sold) : 0;
    const medianOf = (arr) => { if (!arr || !arr.length) return null; const s = [...arr].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
    const avgCheckMedian = medianOf(checks);
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

    // индивидуальные планы МОПов (личный план в выручке, задаётся в кабинете/админке) — по имени
    const mopPlans = (await redisGetCfg(redisUrl, redisToken, `mops:plans:${org}`)) || {};
    // МОПы: конверсия + дозвон + топ по продажам
    const mops = Object.entries(byMop).map(([name, v]) => ({
      id: name,        // идентификатор МОПа = его имя (МОПы уникальны по имени в этой системе)
      name,
      leads: v.leads,
      sold: v.sold,
      revenue: v.revenue,
      plan: mopPlans[name] || 0,   // личный план МОПа (выручка)
      soldToday: v.soldToday || 0,
      revenueToday: v.revenueToday || 0,
      conv: v.leads > 0 ? +(v.sold / v.leads * 100).toFixed(2) : 0,
      // % дозвона: leads = уже реальные лиды (брак исключён из объёма/конверсии/дозвона), «не дали разрешение» = дозвон (не в noContact).
      reachPct: v.leads > 0 ? +(((v.leads - v.noContact) / v.leads) * 100).toFixed(0) : 0,
      reached: Math.max(0, v.leads - v.noContact), // сколько дозвонились (штук)
      reachDenom: v.leads,                          // знаменатель дозвона = реальные лиды (брак уже вне leads)
      fakeNums: v.fakeNums || 0, // нереальные номера (Xato raqam + Dubl), исключены везде — показываем отдельно
      dealCycleDays: medianOf(mopDurations[name]), // медианный цикл сделки «создан→продан» по МОПу (дни)
      _diag: { noContact: v.noContact, ncReasons: v.ncReasons, ncStages: v.ncStages, denomStages: v.denomStages, fakeNums: v.fakeNums || 0, contacted: v.contacted || 0 }, // ДИАГ (read-only)
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
        revenue: soldSum,           // выручка всего (все аккаунты) — касса месяца (с доплатами)
        newSalesRevenue: newSalesSum, // выручка ТОЛЬКО новых продаж (без доплат) — для среднего чека
        soldPeriod,                 // продаж за ~4 месяца (для аудита)
        revenuePeriod,              // выручка за ~4 месяца (для аудита)
        soldTeam,                   // продаж только пятёрки
        revenueTeam: soldSumTeam,   // выручка пятёрки
        conv, avgCheck, avgCheckMedian,        // средний чек: среднее + медиана (устойчива к выбросам)
        paidReceiptCount,                       // сделок с приложенным чеком оплаты (To'lov cheki) — инфо-сигнал, не «оплачено»
        dealCycleMedianDays: velocityMedian,    // медианный цикл сделки по компании (дни)
        noContactPct, ownExcluded,
        // цель НЕ хардкодим на сервере — она у каждого своя, задаётся клиентом (getGoal).
        // клиент считает goalPct/needPerMonth сам по своей цели.
        goal: null,
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
        // === коммерческая динамика (для «средний чек/конверсия по неделям») ===
        avgCheck: result.totals.avgCheck,
        avgCheckMedian: result.totals.avgCheckMedian,
        dealCycleMedianDays: result.totals.dealCycleMedianDays,
        reached: (result.mopsByConv || []).reduce((s, m) => s + (m.reached || 0), 0),
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
