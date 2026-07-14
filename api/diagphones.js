// /api/diagphones.js — РАЗОВАЯ ДИАГНОСТИКА (только админ), read-only.
// Вопрос: попадают ли в amoCRM звонки, сделанные с ЛИЧНЫХ телефонов МОПов через «Мои Звонки»
// (а не через основную АТС/Utel)? Если не попадают — они невидимы для sync-speed, значит дозвон
// занижен, а MOP Agent может обвинить человека в «не звонил», хотя тот звонил с личного мобильного.
//
// Для каждого номера+времени из отчёта «Мои Звонки»:
//   1) ищем контакт/лид в amoCRM по последним 9 цифрам номера,
//   2) читаем ноты найденных лидов и ищем call-ноту в окне ±10 минут,
//   3) показываем ВСЕ params ноты — по ним видно, через какую интеграцию она пришла,
//   4) отдельно проверяем, есть ли СОБЫТИЕ outgoing_call (именно оно кормит счётчик calls).
//
// Ничего не чинит и не пишет. После разбора — удалить.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const SUBDOMAIN = "huntercademy";

async function sessionRole(session) {
  if (!session) return null;
  try {
    const r = await fetch(`${REDIS_URL}/get/session:${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const d = await r.json();
    if (!d || d.result == null) return null;
    const s = JSON.parse(d.result);
    return s && s.role;
  } catch (e) { return null; }
}
const last9 = (p) => String(p || "").replace(/\D/g, "").slice(-9);

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const b = req.body || {};
  const role = await sessionRole(b.session || (req.query && req.query.session));
  if (role !== "admin") { res.status(403).json({ error: "admin only" }); return; }

  const token = process.env.AMOCRM_TOKEN;
  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const WINDOW = 10 * 60; // ±10 минут
  const calls = Array.isArray(b.calls) ? b.calls : [];

  const notesCache = {};   // leadId -> [ноты]
  const out = [];

  for (const c of calls) {
    const digits = last9(c.phone);
    const wantTs = Math.floor(Date.parse(c.at + "+05:00") / 1000); // время из «Мои Звонки» = Ташкент
    const row = { phone: c.phone, digits, at: c.at, who: c.who || "", answered: !!c.dur, dur: c.dur || "",
                  foundEntity: null, leadIds: [], callNoteFound: false, note: null, eventFound: false, allCallNotesNearby: [] };
    try {
      // 1) ищем сущность по номеру (amoCRM ищет по телефону через query)
      const cr = await fetch(`${base}/contacts?query=${digits}&with=leads&limit=10`, { headers: H });
      if (cr.ok) {
        const cd = await cr.json();
        const contacts = (cd._embedded && cd._embedded.contacts) || [];
        if (contacts.length) {
          row.foundEntity = { type: "contact", id: contacts[0].id, name: contacts[0].name || "" };
          for (const ct of contacts) for (const l of ((ct._embedded && ct._embedded.leads) || [])) row.leadIds.push(l.id);
        }
      }
      // если контакта нет — пробуем найти лид напрямую
      if (!row.leadIds.length) {
        const lr = await fetch(`${base}/leads?query=${digits}&limit=10`, { headers: H });
        if (lr.ok) {
          const ld = await lr.json();
          const leads = (ld._embedded && ld._embedded.leads) || [];
          for (const l of leads) row.leadIds.push(l.id);
          if (leads.length && !row.foundEntity) row.foundEntity = { type: "lead", id: leads[0].id, name: leads[0].name || "" };
        }
      }
      row.leadIds = [...new Set(row.leadIds)].slice(0, 5);

      // 2) call-ноты найденных лидов в окне ±10 минут
      for (const lid of row.leadIds) {
        if (!notesCache[lid]) {
          const nr = await fetch(`${base}/leads/${lid}/notes?limit=250`, { headers: H });
          notesCache[lid] = nr.ok ? (((await nr.json())._embedded || {}).notes || []) : [];
          await new Promise((rs) => setTimeout(rs, 160)); // бережём рейт-лимит amoCRM
        }
        for (const n of notesCache[lid]) {
          if (n.note_type !== "call_in" && n.note_type !== "call_out") continue;
          const dt = Math.abs((n.created_at || 0) - wantTs);
          const info = { leadId: lid, noteId: n.id, created_at: n.created_at,
            timeTashkent: new Date(((n.created_at || 0) + 5 * 3600) * 1000).toISOString().slice(11, 19),
            deltaSec: (n.created_at || 0) - wantTs, note_type: n.note_type,
            params: n.params || {}, created_by: n.created_by, responsible_user_id: n.responsible_user_id };
          if (dt <= WINDOW) {
            if (!row.callNoteFound) { row.callNoteFound = true; row.note = info; }
          } else if (Math.abs(dt) <= 3 * 3600) {
            row.allCallNotesNearby.push({ t: info.timeTashkent, dur: (n.params || {}).duration, type: n.note_type });
          }
        }
      }

      // 3) СОБЫТИЕ outgoing_call — именно оно кормит счётчик calls в sync-speed
      if (row.leadIds.length) {
        const ids = row.leadIds.map((id) => `filter[entity_id][]=${id}`).join("&");
        const er = await fetch(`${base}/events?filter[type][]=outgoing_call&filter[type][]=incoming_call&filter[entity]=lead&${ids}&filter[created_at][from]=${wantTs - WINDOW}&filter[created_at][to]=${wantTs + WINDOW}&limit=50`, { headers: H });
        if (er.ok && er.status !== 204) {
          const ed = await er.json();
          row.eventFound = (((ed._embedded || {}).events) || []).length > 0;
        }
      }
    } catch (e) { row.error = String(e && e.message || e); }
    out.push(row);
    await new Promise((rs) => setTimeout(rs, 120));
  }

  res.status(200).json({ ok: true, window: "±10 мин", checked: out.length, rows: out });
}
