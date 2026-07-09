// /api/debug-sales.js — ДИАГНОСТИКА продаж месяца.
// Открой в браузере: /api/debug-sales
// Даёт по КАЖДОЙ продаже месяца: прямую ссылку, бюджет, точное время закрытия (UTC и Ташкент),
// и помечает продажи "сегодня". Помогает сверить с чеками и поймать проблему часового пояса.

const HUNTER_CFG = {
  subdomain: "huntercademy",
  pipeline: "HunterAcademy",
  sold: "Sotildi",
  ownThreshold: 1600000,
  saleDateFieldId: 109880, // "Sotuv sanasi:" — реальная дата продажи
};

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  const SUB = HUNTER_CFG.subdomain, PIPELINE = HUNTER_CFG.pipeline, SOLD = HUNTER_CFG.sold;

  const TZ = 5 * 3600; // Ташкент UTC+5
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  // начало сегодняшнего дня по Ташкенту (как в sync.js)
  const nowLocal = new Date(Date.now() + TZ * 1000);
  const dayStart = Math.floor(Date.UTC(nowLocal.getUTCFullYear(), nowLocal.getUTCMonth(), nowLocal.getUTCDate()) / 1000) - TZ;

  const fmtT = (ts) => {
    if (!ts) return null;
    const utc = new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const tash = new Date((ts + TZ) * 1000).toISOString().replace("T", " ").slice(0, 16) + " (Тошкент)";
    return { utc, tash };
  };

  try {
    // статусы воронки
    let statusName = {}, pipelineId = null;
    const pr = await fetch(`https://${SUB}.amocrm.ru/api/v4/leads/pipelines`, { headers: { Authorization: `Bearer ${token}` } });
    if (pr.ok) {
      const pd = await pr.json();
      for (const p of ((pd._embedded && pd._embedded.pipelines) || [])) {
        if (p.name === PIPELINE) { pipelineId = p.id; for (const s of ((p._embedded && p._embedded.statuses) || [])) statusName[s.id] = s.name; }
      }
    }

    // тянем сделки
    let all = [], page = 1, guard = 0;
    while (guard < 100) {
      guard++;
      let url = `https://${SUB}.amocrm.ru/api/v4/leads?limit=250&page=${page}`;
      if (pipelineId) url += `&filter[pipeline_id]=${pipelineId}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 204) break;
      if (r.status === 429) { await new Promise(rs => setTimeout(rs, 800)); continue; }
      if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "amoCRM error", detail: t.slice(0, 400) }); return; }
      const data = await r.json();
      const leads = (data._embedded && data._embedded.leads) || [];
      all = all.concat(leads);
      if (leads.length < 250) break;
      page++; await new Promise(rs => setTimeout(rs, 40));
    }

    const monthSales = [];
    const todaySales = [];
    let monthTotal = 0, todayTotal = 0;

    // helper: читаем "Sotuv sanasi" (реальная дата продажи) из кастомных полей
    const readSaleDate = (L) => {
      const cfv = L.custom_fields_values || (L._embedded && L._embedded.custom_fields_values);
      if (!Array.isArray(cfv)) return null;
      const f = cfv.find(x => x.field_id === HUNTER_CFG.saleDateFieldId);
      if (f && f.values && f.values[0] && f.values[0].value) {
        const v = f.values[0].value;
        return typeof v === "number" ? v : Math.floor(new Date(v).getTime() / 1000);
      }
      return null;
    };

    // === НОВЫЙ РАСЧЁТ: по реальной дате продажи (Sotuv sanasi), fallback closed_at ===
    const byRealDate = [];
    let realMonthTotal = 0, realMonthCount = 0;

    for (const L of all) {
      const stName = statusName[L.status_id] || "";
      if (stName !== SOLD) continue;
      const price = L.price || 0;
      const saleTs = readSaleDate(L);          // реальная дата продажи
      const effectiveTs = saleTs || L.closed_at || 0; // fallback

      // старый способ (по смене статуса)
      const closedThisMonth = (L.closed_at || 0) >= monthStart;
      // новый способ (по реальной дате)
      const realThisMonth = effectiveTs >= monthStart &&
        effectiveTs < Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000);

      if (closedThisMonth) {
        const isToday = (L.closed_at || 0) >= dayStart;
        const row = {
          id: L.id, price, price_fmt: price.toLocaleString("ru-RU"),
          status_date: fmtT(L.closed_at) ? fmtT(L.closed_at).tash : null,
          sotuv_sanasi: saleTs ? new Date((saleTs + TZ) * 1000).toISOString().slice(0, 10) : "(пусто)",
          effective_month: new Date((effectiveTs + TZ) * 1000).toISOString().slice(0, 7),
          stays_in_july_by_real_date: realThisMonth,
          is_today: isToday,
          link: `https://${SUB}.amocrm.ru/leads/detail/${L.id}`,
        };
        monthSales.push(row);
        monthTotal += price;
        if (isToday) { todaySales.push(row); todayTotal += price; }
      }

      // новый расчёт: считаем в июле по реальной дате
      if (realThisMonth) { realMonthTotal += price; realMonthCount++; byRealDate.push({ id: L.id, price, sotuv: saleTs ? new Date((saleTs + TZ) * 1000).toISOString().slice(0, 10) : "(fallback)" }); }
    }

    monthSales.sort((a, b) => (b.closed_time && a.closed_time) ? (b.id - a.id) : 0);

    res.status(200).json({
      ok: true,
      month: new Date(monthStart * 1000).toISOString().slice(0, 7),
      COMPARISON: {
        OLD_by_status_change: {
          count: monthSales.length,
          total: monthTotal.toLocaleString("ru-RU"),
          total_mln: (monthTotal / 1e6).toFixed(2),
        },
        NEW_by_real_sale_date: {
          count: realMonthCount,
          total: realMonthTotal.toLocaleString("ru-RU"),
          total_mln: (realMonthTotal / 1e6).toFixed(2),
        },
        your_target: "42 810 240",
      },
      TODAY: {
        count: todaySales.length,
        total: todayTotal.toLocaleString("ru-RU"),
      },
      NEW_july_sales: byRealDate,   // сделки, что попадают в июль по реальной дате
      ALL_month_sales_detail: monthSales, // все + видно sotuv_sanasi и уйдёт ли из июля
      hint: "Сравни OLD vs NEW. NEW считает по Sotuv sanasi. Если NEW.total = твой target 42 810 240 — решение точное. Смотри stays_in_july_by_real_date: false = сделка уходит в другой месяц.",
    });
  } catch (e) {
    res.status(500).json({ error: "debug failed", detail: String(e).slice(0, 300) });
  }
}
