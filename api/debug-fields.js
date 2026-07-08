// /api/debug-fields.js — показывает ВСЕ кастомные поля сделок,
// чтобы найти поле "Дата продажи / оплаты" (если оно есть в amoCRM).
// Открой: /api/debug-fields
// Берёт несколько последних проданных сделок и выводит все их поля с названиями и значениями.

const HUNTER_CFG = { subdomain: "huntercademy", pipeline: "HunterAcademy", sold: "Sotildi" };

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  const SUB = HUNTER_CFG.subdomain, PIPELINE = HUNTER_CFG.pipeline, SOLD = HUNTER_CFG.sold;
  const TZ = 5 * 3600;

  try {
    // 1) справочник кастомных полей сделок: field_id -> {name, type}
    let fieldDict = {};
    let fpage = 1, fg = 0;
    while (fg < 20) {
      fg++;
      const fr = await fetch(`https://${SUB}.amocrm.ru/api/v4/leads/custom_fields?limit=250&page=${fpage}`, { headers: { Authorization: `Bearer ${token}` } });
      if (!fr.ok) break;
      const fd = await fr.json();
      const fields = (fd._embedded && fd._embedded.custom_fields) || [];
      for (const f of fields) fieldDict[f.id] = { name: f.name, type: f.type };
      if (fields.length < 250) break;
      fpage++;
    }

    // 2) статусы
    let statusName = {}, pipelineId = null;
    const pr = await fetch(`https://${SUB}.amocrm.ru/api/v4/leads/pipelines`, { headers: { Authorization: `Bearer ${token}` } });
    if (pr.ok) {
      const pd = await pr.json();
      for (const p of ((pd._embedded && pd._embedded.pipelines) || [])) {
        if (p.name === PIPELINE) { pipelineId = p.id; for (const s of ((p._embedded && p._embedded.statuses) || [])) statusName[s.id] = s.name; }
      }
    }

    // 3) берём последние проданные сделки (по closed_at) — покажем их поля
    let all = [], page = 1, guard = 0;
    while (guard < 100) {
      guard++;
      let url = `https://${SUB}.amocrm.ru/api/v4/leads?limit=250&page=${page}`;
      if (pipelineId) url += `&filter[pipeline_id]=${pipelineId}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 204) break;
      if (r.status === 429) { await new Promise(rs => setTimeout(rs, 800)); continue; }
      if (!r.ok) break;
      const data = await r.json();
      const leads = (data._embedded && data._embedded.leads) || [];
      all = all.concat(leads);
      if (leads.length < 250) break;
      page++; await new Promise(rs => setTimeout(rs, 40));
    }

    const sold = all.filter(L => (statusName[L.status_id] || "") === SOLD && L.closed_at)
      .sort((a, b) => b.closed_at - a.closed_at)
      .slice(0, 6);

    const fmt = (ts) => ts ? new Date((ts + TZ) * 1000).toISOString().slice(0, 16).replace("T", " ") : null;

    const samples = sold.map(L => {
      const cfv = L.custom_fields_values || (L._embedded && L._embedded.custom_fields_values) || [];
      const fields = (cfv || []).map(f => {
        const meta = fieldDict[f.field_id] || {};
        let vals = (f.values || []).map(v => v.value);
        // если это дата (unix) — покажем читаемо
        if (meta.type === "date" || meta.type === "date_time") {
          vals = vals.map(v => (typeof v === "number" ? new Date((v + TZ) * 1000).toISOString().slice(0, 16).replace("T", " ") : v));
        }
        return { field_id: f.field_id, name: meta.name || "(без имени)", type: meta.type || "?", values: vals };
      });
      return {
        id: L.id,
        link: `https://${SUB}.amocrm.ru/leads/detail/${L.id}`,
        price: L.price,
        created: fmt(L.created_at),
        closed_at_status_change: fmt(L.closed_at), // это дата СМЕНЫ статуса на "Продано"
        custom_fields: fields,
      };
    });

    // отдельно: список всех полей типа "дата" — кандидаты на "дату продажи"
    const dateFields = Object.entries(fieldDict)
      .filter(([id, m]) => m.type === "date" || m.type === "date_time")
      .map(([id, m]) => ({ field_id: +id, name: m.name, type: m.type }));

    res.status(200).json({
      ok: true,
      DATE_FIELDS_FOUND: dateFields, // ← поля-даты (среди них может быть "Дата продажи")
      note: "Ищи в DATE_FIELDS_FOUND поле вроде 'Дата продажи' / 'Дата оплаты'. Его field_id используем для правильного учёта. closed_at_status_change — это когда нажали 'Продано' (может отличаться от реальной даты).",
      sample_sales: samples,
    });
  } catch (e) {
    res.status(500).json({ error: "debug failed", detail: String(e).slice(0, 300) });
  }
}
