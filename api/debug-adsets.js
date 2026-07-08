// /api/debug-adsets.js — ДИАГНОСТИКА источников (adset).
// Открой в браузере: /api/debug-adsets  (для витрины hunter)
// Показывает по КАЖДОЙ продаже этого месяца: название, даты, и СЫРОЕ значение поля источника
// (все значения, если их несколько), + как система группирует. Помогает найти, почему
// продажи приписываются не тому источнику.

const HUNTER_CFG = {
  subdomain: "huntercademy",
  pipeline: "HunterAcademy",
  sold: "Sotildi",
  lost: "Yopildi",
  adsetFieldId: 194405,
};

export default async function handler(req, res) {
  const org = (req.query && req.query.org) || "hunter";
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  const SUB = HUNTER_CFG.subdomain, PIPELINE = HUNTER_CFG.pipeline;
  const SOLD = HUNTER_CFG.sold, ADSET_FIELD_ID = HUNTER_CFG.adsetFieldId;

  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

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

    // тянем все сделки воронки
    let all = [], page = 1, guard = 0;
    while (guard < 100) {
      guard++;
      let url = `https://${SUB}.amocrm.ru/api/v4/leads?limit=250&page=${page}`;
      if (pipelineId) url += `&filter[pipeline_id]=${pipelineId}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 204) break;
      if (r.status === 429) { await new Promise(rs => setTimeout(rs, 800)); continue; }
      if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "amoCRM leads error", detail: t.slice(0, 400) }); return; }
      const data = await r.json();
      const leads = (data._embedded && data._embedded.leads) || [];
      all = all.concat(leads);
      if (leads.length < 250) break;
      page++; await new Promise(rs => setTimeout(rs, 40));
    }

    // читает ВСЕ значения поля источника (не только первое)
    const readAdsetAll = (L) => {
      const cfv = L.custom_fields_values || (L._embedded && L._embedded.custom_fields_values);
      if (!Array.isArray(cfv)) return { first: "", all: [], found: false };
      const f = cfv.find(x => x.field_id === ADSET_FIELD_ID);
      if (!f || !f.values) return { first: "", all: [], found: false };
      const vals = f.values.map(v => String(v.value || "").trim()).filter(Boolean);
      return { first: vals[0] || "", all: vals, found: true, multi: vals.length > 1 };
    };

    // === собираем ПРОДАЖИ этого месяца (closed_at в этом месяце) ===
    const soldThisMonth = [];
    const groupCount = {};        // как СЕЙЧАС группирует система (по первому значению)
    let soldTotal = 0, soldNoAdset = 0, soldMulti = 0;

    for (const L of all) {
      const stName = statusName[L.status_id] || "";
      if (stName !== SOLD) continue;
      const closedThisMonth = (L.closed_at || 0) >= monthStart;
      if (!closedThisMonth) continue;
      soldTotal++;
      const a = readAdsetAll(L);
      const key = a.first || "(без источника)";
      groupCount[key] = (groupCount[key] || 0) + 1;
      if (!a.first) soldNoAdset++;
      if (a.multi) soldMulti++;
      soldThisMonth.push({
        id: L.id,
        name: L.name || "",
        price: L.price || 0,
        created: L.created_at ? new Date(L.created_at * 1000).toISOString().slice(0, 10) : null,
        closed: L.closed_at ? new Date(L.closed_at * 1000).toISOString().slice(0, 10) : null,
        source_first: a.first || "(пусто)",
        source_all: a.all,                 // ВСЕ значения (если мультиселект)
        source_multi: a.multi || false,    // несколько значений?
        source_found: a.found,             // поле вообще заполнено?
        amo_link: `https://${SUB}.amocrm.ru/leads/detail/${L.id}`,
      });
    }

    // сортируем по источнику для наглядности
    soldThisMonth.sort((x, y) => (x.source_first > y.source_first ? 1 : -1));

    res.status(200).json({
      ok: true,
      month: new Date(monthStart * 1000).toISOString().slice(0, 7),
      adsetFieldId: ADSET_FIELD_ID,
      totals: {
        sold_this_month: soldTotal,
        sold_without_source: soldNoAdset,
        sold_with_multiple_sources: soldMulti,   // ← если >0, это причина путаницы!
      },
      grouped_as_system_sees_it: groupCount,     // ← как система сейчас распределяет
      sales: soldThisMonth,                       // ← каждая продажа с сырым источником
      hint: "Смотри поле source_all у каждой продажи: если там несколько значений (source_multi=true), система берёт только первое (source_first) — отсюда путаница. Сравни grouped_as_system_sees_it с реальностью (Bola ogani 4, Jaloliddin 2, Organika 2).",
    });
  } catch (e) {
    res.status(500).json({ error: "debug failed", detail: String(e).slice(0, 300) });
  }
}
