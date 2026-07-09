// /api/debug-assign.js — проверяет события смены ответственного за сегодня/месяц.
// Открой: /api/debug-assign
// Показывает несколько лидов с их: создание, все назначения, первый звонок — чтобы убедиться,
// что переназначения реально фиксируются и метрика "после назначения" считается верно.

const HUNTER_CFG = { subdomain: "huntercademy", pipeline: "HunterAcademy" };

// рабочие минуты (упрощённо — как в sync-speed, но для проверки берём календарные)
function calMin(a, b) { return Math.round((b - a) / 60); }

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  const SUB = HUNTER_CFG.subdomain;
  const base = `https://${SUB}.amocrm.ru/api/v4`;
  const H = { Authorization: `Bearer ${token}` };
  const TZ = 5 * 3600;
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const fmt = (ts) => ts ? new Date((ts + TZ) * 1000).toISOString().slice(5, 16).replace("T", " ") : null;

  try {
    // считаем события смены ответственного
    let assignEvents = {}; // leadId -> [ts...]
    let totalAssign = 0;
    let page = 1, guard = 0;
    while (guard < 40) {
      guard++;
      const url = `${base}/events?filter[type]=entity_responsible_changed&filter[created_at][from]=${monthStart}&limit=250&page=${page}&order[created_at]=asc`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) { res.status(200).json({ error: "events error " + r.status, note: "Возможно, тип события другой" }); return; }
      const d = await r.json();
      const events = (d._embedded && d._embedded.events) || [];
      for (const e of events) {
        if (e.entity_type !== "lead") continue;
        (assignEvents[e.entity_id] = assignEvents[e.entity_id] || []).push(e.created_at);
        totalAssign++;
      }
      if (events.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 100));
    }

    // тянем звонки (outgoing_call) чтобы показать первый звонок по лидам
    let firstCallOf = {}; // leadId -> ts первого звонка
    page = 1; guard = 0;
    while (guard < 40) {
      guard++;
      const url = `${base}/events?filter[type]=outgoing_call&filter[created_at][from]=${monthStart}&limit=250&page=${page}&order[created_at]=asc`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) break;
      const d = await r.json();
      const events = (d._embedded && d._embedded.events) || [];
      for (const e of events) {
        if (e.entity_type !== "lead") continue;
        if (firstCallOf[e.entity_id] === undefined || e.created_at < firstCallOf[e.entity_id]) firstCallOf[e.entity_id] = e.created_at;
      }
      if (events.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 100));
    }

    // берём 8 лидов, где ЕСТЬ и переназначения, и звонок — покажем полную картину
    const timeline = [];
    for (const id of Object.keys(assignEvents)) {
      const fc = firstCallOf[id];
      if (!fc) continue;
      const assigns = assignEvents[id].slice().sort((a, b) => a - b);
      const before = assigns.filter(ts => ts <= fc);
      const lastAssign = before.length ? Math.max(...before) : assigns[0];
      const created = assigns[0]; // приблизительно первое назначение ≈ создание
      timeline.push({
        leadId: +id,
        link: `https://${SUB}.amocrm.ru/leads/detail/${id}`,
        assignments_count: assigns.length,
        first_assign: fmt(assigns[0]),
        last_assign_before_call: fmt(lastAssign),
        first_call: fmt(fc),
        min_after_first_assign: calMin(assigns[0], fc),
        min_after_last_assign: calMin(lastAssign, fc),
      });
      if (timeline.length >= 8) break;
    }

    res.status(200).json({
      ok: true,
      total_assign_events_this_month: totalAssign,
      leads_with_assignments: Object.keys(assignEvents).length,
      leads_with_MULTIPLE_assignments: Object.values(assignEvents).filter(a => a.length > 1).length,
      note: "TIMELINE: сравни min_after_first_assign (после создания) и min_after_last_assign (после последнего назначения). Второе должно быть меньше — это метрика 'после назначения'.",
      TIMELINE_verify: timeline,
    });
  } catch (e) {
    res.status(500).json({ error: "debug failed", detail: String(e).slice(0, 300) });
  }
}
