// /api/_calldiag.js — ВРЕМЕННЫЙ read-only диагностик записи звонков в amoCRM.
// Задача: понять, почему % дозвона занижен (15-20%). Возвращает ТОЛЬКО агрегаты, без PII
// (без телефонов/имён/сумм): где лежат call-notes (лид vs контакт), гистограмма note_type,
// ключи params у call-нот, распределение длительностей. Гейт — админ-сессия.
// После диагностики этот файл удаляем.

const HUNTER_CFG = {
  subdomain: "huntercademy",
  mops: { 13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda", 13833590: "Begoyim", 13681582: "Abulbositxon" },
};

async function rget(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return d && d.result != null ? d.result : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL, redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "no redis" }); return; }

  // гейт: только админ-сессия
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const rawSess = await rget(redisUrl, redisToken, `session:${session}`);
  let sess = null; try { sess = rawSess ? JSON.parse(rawSess) : null; } catch (e) {}
  if (!sess) { res.status(403).json({ error: "no session" }); return; }
  if (sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }

  const org = (req.query && req.query.org) || sess.org || "hunter";
  let token, SUBDOMAIN, MOPS;
  if (org === "hunter") { token = process.env.AMOCRM_TOKEN; SUBDOMAIN = HUNTER_CFG.subdomain; MOPS = HUNTER_CFG.mops; }
  else {
    const raw = await rget(redisUrl, redisToken, `clientcfg:${org}`);
    let c = null; try { c = raw ? JSON.parse(raw) : null; } catch (e) {}
    if (!c || !c.token || !c.subdomain) { res.status(400).json({ error: "org not configured" }); return; }
    token = c.token; SUBDOMAIN = c.subdomain; MOPS = c.mops || {};
  }
  if (!token) { res.status(500).json({ error: "no amocrm token" }); return; }

  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const REACHED_SEC = 40;
  const startedAt = Date.now();
  const monthStart = Math.floor(Date.now() / 1000) - 30 * 86400;
  const mopIds = new Set(Object.keys(MOPS).map((x) => parseInt(x, 10)));

  const isCall = (t) => t === "call_in" || t === "call_out";
  const durOf = (p) => { const v = p && (p.duration != null ? p.duration : p.DURATION); return parseInt(v != null ? v : 0, 10) || 0; };
  const bucket = (agg, dur, present) => {
    if (!present) { agg.missing++; return; }
    if (dur === 0) agg.zero++; else if (dur < 10) agg.s1_9++; else if (dur < REACHED_SEC) agg.s10_39++;
    else if (dur < 120) agg.s40_119++; else agg.s120plus++;
  };

  try {
    // 1) Тянем лиды за ~30 дней (только наши МОПы), собираем id лида + id первого контакта
    const leadRows = []; // {id, contactId}
    let page = 1;
    while (page <= 4 && Date.now() - startedAt < 6000) {
      const url = `${base}/leads?with=contacts&filter[created_at][from]=${monthStart}&limit=250&page=${page}`;
      const r = await fetch(url, { headers: H });
      if (!r.ok) break;
      const d = await r.json();
      const leads = (d._embedded && d._embedded.leads) || [];
      for (const L of leads) {
        if (mopIds.size && !mopIds.has(L.responsible_user_id)) continue;
        const contacts = (L._embedded && L._embedded.contacts) || [];
        leadRows.push({ id: L.id, contactId: contacts.length ? contacts[0].id : null });
      }
      if (leads.length < 250) break;
      page++;
    }

    // 2) Сэмплируем лиды и смотрим call-notes на ЛИДЕ и на КОНТАКТЕ
    const noteTypeHist = {};       // все note_type на лидах (топ)
    const callParamKeys = {};      // ключи params у call-нот (лид+контакт)
    const durLead = { missing: 0, zero: 0, s1_9: 0, s10_39: 0, s40_119: 0, s120plus: 0 };
    const durContact = { missing: 0, zero: 0, s1_9: 0, s10_39: 0, s40_119: 0, s120plus: 0 };
    let leadCallNotes = 0, contactCallNotes = 0;
    let leadsSampled = 0, leadsWithAnyLeadCall = 0, leadsWithAnyContactCall = 0;
    let reachedOnLead = 0, reachedOnContact = 0, reachedEither = 0;
    const seenContacts = new Set();

    for (const row of leadRows) {
      if (Date.now() - startedAt > 8500) break;
      if (leadsSampled >= 60) break;
      leadsSampled++;
      let hadLeadCall = false, hadContactCall = false, reachL = false, reachC = false;
      // ноты лида
      try {
        const r = await fetch(`${base}/leads/${row.id}/notes?limit=250`, { headers: H });
        if (r.ok) {
          const d = await r.json();
          const notes = (d._embedded && d._embedded.notes) || [];
          for (const n of notes) {
            noteTypeHist[n.note_type] = (noteTypeHist[n.note_type] || 0) + 1;
            if (!isCall(n.note_type)) continue;
            leadCallNotes++; hadLeadCall = true;
            const p = n.params || {};
            for (const k of Object.keys(p)) callParamKeys[k] = (callParamKeys[k] || 0) + 1;
            const present = p.duration != null || p.DURATION != null;
            const dur = durOf(p); bucket(durLead, dur, present);
            if (dur >= REACHED_SEC) reachL = true;
          }
        }
      } catch (e) {}
      // ноты контакта (звонки часто пишутся на контакт, а не на лид)
      if (row.contactId && !seenContacts.has(row.contactId)) {
        seenContacts.add(row.contactId);
        try {
          const r = await fetch(`${base}/contacts/${row.contactId}/notes?limit=250`, { headers: H });
          if (r.ok) {
            const d = await r.json();
            const notes = (d._embedded && d._embedded.notes) || [];
            for (const n of notes) {
              if (!isCall(n.note_type)) continue;
              contactCallNotes++; hadContactCall = true;
              const p = n.params || {};
              for (const k of Object.keys(p)) callParamKeys[k] = (callParamKeys[k] || 0) + 1;
              const present = p.duration != null || p.DURATION != null;
              const dur = durOf(p); bucket(durContact, dur, present);
              if (dur >= REACHED_SEC) reachC = true;
            }
          }
        } catch (e) {}
      }
      if (hadLeadCall) leadsWithAnyLeadCall++;
      if (hadContactCall) leadsWithAnyContactCall++;
      if (reachL) reachedOnLead++;
      if (reachC) reachedOnContact++;
      if (reachL || reachC) reachedEither++;
    }

    // топ note_type
    const noteTypeTop = Object.entries(noteTypeHist).sort((a, b) => b[1] - a[1]).slice(0, 12);

    res.status(200).json({
      ok: true, org, subdomain: SUBDOMAIN, reachedSecThreshold: REACHED_SEC,
      periodDays: 30, elapsedMs: Date.now() - startedAt,
      leadsFound: leadRows.length, leadsSampled,
      callNotes: { onLead: leadCallNotes, onContact: contactCallNotes },
      leadsWithCall: { onLead: leadsWithAnyLeadCall, onContact: leadsWithAnyContactCall },
      // ГЛАВНОЕ: сколько лидов «дозвонились» (нота ≥40 сек) по разным источникам
      reachedLeads: { onLeadOnly: reachedOnLead, onContact: reachedOnContact, either: reachedEither,
        pctEither: leadsSampled ? Math.round(reachedEither / leadsSampled * 100) : 0,
        pctLeadOnly: leadsSampled ? Math.round(reachedOnLead / leadsSampled * 100) : 0 },
      durationBuckets: { lead: durLead, contact: durContact },
      callParamKeys, noteTypeTop,
      hint: "Если callNotes.onContact >> onLead или reachedLeads.onContact заметно > onLeadOnly — звонки пишутся на контакт, а мы читаем только ноты лида. Если durationBuckets.*.missing/zero велики — поле duration не приходит. Если много s10_39 — порог 40с высоковат.",
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err) });
  }
}
