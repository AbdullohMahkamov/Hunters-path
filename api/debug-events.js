// /api/debug-events.js — смотрит события ИЗМЕНЕНИЯ БЮДЖЕТА (price) сделок за месяц.
// Открой: /api/debug-events
// Показывает: менялся ли бюджет у проданных сделок, когда, с какой суммы на какую.
// Помогает понять, вносятся ли доплаты через изменение бюджета (тогда их видно в событиях).

const HUNTER_CFG = { subdomain: "huntercademy", pipeline: "HunterAcademy", sold: "Sotildi" };

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  const SUB = HUNTER_CFG.subdomain, PIPELINE = HUNTER_CFG.pipeline, SOLD = HUNTER_CFG.sold;
  const TZ = 5 * 3600;
  const base = `https://${SUB}.amocrm.ru/api/v4`;
  const H = { Authorization: `Bearer ${token}` };
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const fmt = (ts) => ts ? new Date((ts + TZ) * 1000).toISOString().slice(0, 16).replace("T", " ") : null;

  try {
    // статусы
    let statusName = {}, pipelineId = null;
    const pr = await fetch(`${base}/leads/pipelines`, { headers: H });
    if (pr.ok) {
      const pd = await pr.json();
      for (const p of ((pd._embedded && pd._embedded.pipelines) || [])) {
        if (p.name === PIPELINE) { pipelineId = p.id; for (const s of ((p._embedded && p._embedded.statuses) || [])) statusName[s.id] = s.name; }
      }
    }

    // проданные сделки этого месяца (по дате смены статуса — просто чтобы собрать id)
    let all = [], page = 1, guard = 0;
    while (guard < 60) {
      guard++;
      let url = `${base}/leads?limit=250&page=${page}`;
      if (pipelineId) url += `&filter[pipeline_id]=${pipelineId}`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (r.status === 429) { await new Promise(rs => setTimeout(rs, 800)); continue; }
      if (!r.ok) break;
      const data = await r.json();
      const leads = (data._embedded && data._embedded.leads) || [];
      all = all.concat(leads);
      if (leads.length < 250) break;
      page++; await new Promise(rs => setTimeout(rs, 40));
    }
    const soldLeads = all.filter(L => (statusName[L.status_id] || "") === SOLD && (L.closed_at || 0) >= monthStart);

    // тянем события изменения бюджета (type = lead_status... нет; для price это "sale_field_changed"? )
    // В amoCRM изменение бюджета = событие type "lead_changed" с изменением поля price,
    // но точнее — отдельного типа нет; читаем события по каждой сделке и фильтруем поле price.
    // Пробуем универсально: /events?filter[entity]=lead&filter[entity_id]=...
    const results = [];
    for (const L of soldLeads.slice(0, 20)) { // ограничим 20, чтобы не упереться в лимиты
      let priceEvents = [];
      try {
        const url = `${base}/events?filter[entity]=lead&filter[entity_id][]=${L.id}&limit=100`;
        const r = await fetch(url, { headers: H });
        if (r.ok) {
          const d = await r.json();
          const events = (d._embedded && d._embedded.events) || [];
          for (const e of events) {
            // ищем события, где менялось значение поля цены/бюджета
            const t = e.type || "";
            if (t.includes("price") || t.includes("sale") || t === "lead_status_changed") {
              // разбираем before/after если есть
              let before = null, after = null;
              try {
                if (e.value_before && e.value_before[0]) before = JSON.stringify(e.value_before[0]);
                if (e.value_after && e.value_after[0]) after = JSON.stringify(e.value_after[0]);
              } catch (x) {}
              priceEvents.push({ type: t, at: fmt(e.created_at), before, after });
            }
          }
        }
      } catch (x) {}
      results.push({
        id: L.id,
        link: `https://${SUB}.amocrm.ru/leads/detail/${L.id}`,
        current_price: L.price,
        created: fmt(L.created_at),
        status_changed_at: fmt(L.closed_at),
        price_events: priceEvents,      // события, связанные с ценой/статусом
        price_events_count: priceEvents.length,
      });
    }

    res.status(200).json({
      ok: true,
      note: "Смотрим, есть ли у сделок события изменения бюджета (price). Если price менялся — доплату видно тут (before→after). Если price_events пустые у всех — значит бюджет НЕ меняют при доплате (доплаты только в фото), и события не помогут.",
      sample: results,
    });
  } catch (e) {
    res.status(500).json({ error: "debug failed", detail: String(e).slice(0, 300) });
  }
}
