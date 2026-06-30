// /api/debug.js — диагностика amoCRM. Показывает воронку, причины, юзеров + СОБЫТИЯ и ЗВОНКИ (для скорости касания).
const SUBDOMAIN = "huntercademy";

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const out = { ok: true };

  async function safe(label, url) {
    try {
      const r = await fetch(url, { headers: H });
      const status = r.status;
      let body = null;
      try { body = await r.json(); } catch (e) { body = { _parse_error: true }; }
      return { status, body };
    } catch (e) { return { error: String(e) }; }
  }

  try {
    // 1) Берём 1 свежую сделку из HunterAcademy, чтобы знать её id
    const leads = await safe("leads", `${base}/leads?limit=1&order[created_at]=desc`);
    let sampleLeadId = null;
    try { sampleLeadId = leads.body._embedded.leads[0].id; } catch (e) {}
    out.sample_lead_id = sampleLeadId;

    // 2) СОБЫТИЯ — общий список (типы событий, что вообще логируется)
    const events = await safe("events", `${base}/events?limit=20&order[created_at]=desc`);
    // Соберём уникальные типы событий
    let eventTypes = {};
    try {
      for (const e of events.body._embedded.events) {
        eventTypes[e.type] = (eventTypes[e.type] || 0) + 1;
      }
    } catch (e) {}
    out.events_status = events.status;
    out.event_types_sample = eventTypes;
    // Покажем 3 примера событий целиком (структура)
    try {
      out.events_examples = events.body._embedded.events.slice(0, 3);
    } catch (e) { out.events_raw = events.body; }

    // 3) События по конкретной сделке (смена этапов — для скорости касания)
    if (sampleLeadId) {
      const le = await safe("lead_events",
        `${base}/events?filter[entity]=lead&filter[entity_id]=${sampleLeadId}&limit=30&order[created_at]=asc`);
      out.lead_events_status = le.status;
      try { out.lead_events_count = le.body._embedded.events.length; } catch (e) {}
      try { out.lead_events_examples = le.body._embedded.events.slice(0, 6); } catch (e) {}
    }

    // 4) ЗВОНКИ — есть ли в API телефонии (call события)
    const calls = await safe("calls", `${base}/events?filter[type]=incoming_call,outgoing_call&limit=10`);
    out.calls_status = calls.status;
    try { out.calls_count = calls.body._embedded.events.length; } catch (e) {}
    try { out.calls_examples = calls.body._embedded.events.slice(0, 3); } catch (e) {}

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: "debug failed", detail: String(err) });
  }
}
