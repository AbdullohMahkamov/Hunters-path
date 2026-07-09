// /api/debug-doplata.js — находит сделки, где ЗАПОЛНЕНЫ поля доплат (Doplata-1, Doplata-2).
// Открой: /api/debug-doplata
// Показывает по каждой такой сделке: price, дату продажи, какие доплаты прикреплены (фото).
// Помогает понять масштаб доплат за месяц.

const HUNTER_CFG = {
  subdomain: "huntercademy",
  pipeline: "HunterAcademy",
  sold: "Sotildi",
  saleDateFieldId: 109880,     // Sotuv sanasi
  doplata1FieldId: 117858,     // Doplata-1 (файл)
  doplata2FieldId: 117860,     // Doplata-2 (файл)
  chekFieldId: 117856,         // To'lov cheki (основной чек)
};

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  const SUB = HUNTER_CFG.subdomain, PIPELINE = HUNTER_CFG.pipeline, SOLD = HUNTER_CFG.sold;
  const TZ = 5 * 3600;
  const base = `https://${SUB}.amocrm.ru/api/v4`;
  const H = { Authorization: `Bearer ${token}` };
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const nextMonth = Math.floor(new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000);

  const readDate = (L, fid) => {
    const cfv = L.custom_fields_values || (L._embedded && L._embedded.custom_fields_values);
    if (!Array.isArray(cfv)) return null;
    const f = cfv.find(x => x.field_id === fid);
    if (f && f.values && f.values[0] && f.values[0].value != null) {
      const v = f.values[0].value;
      return typeof v === "number" ? v : Math.floor(new Date(v).getTime() / 1000);
    }
    return null;
  };
  const hasField = (L, fid) => {
    const cfv = L.custom_fields_values || (L._embedded && L._embedded.custom_fields_values);
    if (!Array.isArray(cfv)) return false;
    const f = cfv.find(x => x.field_id === fid);
    return !!(f && f.values && f.values[0]);
  };
  const fmtD = (ts) => ts ? new Date((ts + TZ) * 1000).toISOString().slice(0, 10) : null;

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

    // сделки
    let all = [], page = 1, guard = 0;
    while (guard < 60) {
      guard++;
      let url = `${base}/leads?limit=250&page=${page}&with=custom_fields_values`;
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

    const withDoplata = [];
    for (const L of all) {
      const stName = statusName[L.status_id] || "";
      if (stName !== SOLD) continue;
      const saleTs = readDate(L, HUNTER_CFG.saleDateFieldId);
      const effectiveTs = saleTs || L.closed_at || 0;
      // продажи, чья РЕАЛЬНАЯ дата (Sotuv sanasi) в этом месяце
      if (effectiveTs < monthStart || effectiveTs >= nextMonth) continue;

      const d1 = hasField(L, HUNTER_CFG.doplata1FieldId);
      const d2 = hasField(L, HUNTER_CFG.doplata2FieldId);
      if (!d1 && !d2) continue; // нет доплат — пропускаем

      withDoplata.push({
        id: L.id,
        link: `https://${SUB}.amocrm.ru/leads/detail/${L.id}`,
        price: L.price || 0,
        price_fmt: (L.price || 0).toLocaleString("ru-RU"),
        sotuv_sanasi: fmtD(saleTs) || "(пусто, взят closed_at)",
        has_doplata_1: d1,
        has_doplata_2: d2,
        doplata_count: (d1 ? 1 : 0) + (d2 ? 1 : 0),
      });
    }

    withDoplata.sort((a, b) => a.id - b.id);
    const baseSum = withDoplata.reduce((s, x) => s + x.price, 0);

    res.status(200).json({
      ok: true,
      month: new Date(monthStart * 1000).toISOString().slice(0, 7),
      count_deals_with_doplata: withDoplata.length,
      note: "Это сделки июля (по Sotuv sanasi), у которых прикреплены фото доплат (Doplata-1/2). Суммы доплат в фото — их надо будет вписать числом. price здесь = только основной бюджет.",
      base_price_sum: baseSum.toLocaleString("ru-RU"),
      deals_with_doplata: withDoplata,
    });
  } catch (e) {
    res.status(500).json({ error: "debug failed", detail: String(e).slice(0, 300) });
  }
}
