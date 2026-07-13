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

  const FETCH_BUDGET = 8000, TOTAL_BUDGET = 48000, MAX_SAMPLE = 120;
  try {
    // 1) Тянем лиды за ~30 дней (только наши МОПы), собираем id лида + id первого контакта.
    //    Берём широкую выборку ВСЕХ лидов (знаменатель дозвона), не только со звонками.
    const leadRows = []; // {id, contactId}
    let page = 1;
    while (page <= 6 && Date.now() - startedAt < FETCH_BUDGET) {
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
    // равномерная выборка по всему пулу (не только первые страницы)
    const pool = leadRows.slice();
    const step = Math.max(1, Math.floor(pool.length / MAX_SAMPLE));
    const sample = [];
    for (let i = 0; i < pool.length && sample.length < MAX_SAMPLE; i += step) sample.push(pool[i]);

    // 2) Сэмплируем лиды: call-notes на ЛИДЕ и (если на лиде дозвона нет) на КОНТАКТЕ
    const durLead = { missing: 0, zero: 0, s1_9: 0, s10_39: 0, s40_119: 0, s120plus: 0 };
    const callStatusHist = {};   // call_status → {count, dur0, durPos, sumDur}
    const callResultHist = {};   // call_result → count
    let leadCallNotes = 0;
    let leadsSampled = 0, leadsWithAnyLeadCall = 0;
    // дозвон при разных порогах длительности (по лидам, за 30 дней)
    let reach_pos = 0, reach_10 = 0, reach_15 = 0, reach_40 = 0; // dur>0, ≥10, ≥15, ≥40

    for (const row of sample) {
      if (Date.now() - startedAt > TOTAL_BUDGET) break;
      leadsSampled++;
      let had = false, mx = -1; // mx — макс длительность разговора по лиду
      try {
        const r = await fetch(`${base}/leads/${row.id}/notes?limit=250`, { headers: H });
        if (r.ok) {
          const d = await r.json();
          const notes = (d._embedded && d._embedded.notes) || [];
          for (const n of notes) {
            if (!isCall(n.note_type)) continue;
            leadCallNotes++; had = true;
            const p = n.params || {};
            const present = p.duration != null || p.DURATION != null;
            const dur = durOf(p); bucket(durLead, dur, present);
            if (dur > mx) mx = dur;
            // call_status: связь с длительностью (какой статус = реальный разговор)
            const cs = String(p.call_status != null ? p.call_status : "—");
            if (!callStatusHist[cs]) callStatusHist[cs] = { count: 0, dur0: 0, durPos: 0, sumDur: 0, maxDur: 0 };
            const S = callStatusHist[cs]; S.count++; S.sumDur += dur; if (dur === 0) S.dur0++; else S.durPos++; if (dur > S.maxDur) S.maxDur = dur;
            const cr = String(p.call_result != null && p.call_result !== "" ? p.call_result : "—");
            callResultHist[cr] = (callResultHist[cr] || 0) + 1;
          }
        }
      } catch (e) {}
      if (had) leadsWithAnyLeadCall++;
      if (mx > 0) reach_pos++;
      if (mx >= 10) reach_10++;
      if (mx >= 15) reach_15++;
      if (mx >= 40) reach_40++;
    }

    const pct = (n) => leadsSampled ? Math.round(n / leadsSampled * 100) : 0;
    const pctCalled = (n) => leadsWithAnyLeadCall ? Math.round(n / leadsWithAnyLeadCall * 100) : 0;
    // средняя длительность по каждому call_status
    for (const k of Object.keys(callStatusHist)) { const S = callStatusHist[k]; S.avgDur = S.count ? Math.round(S.sumDur / S.count) : 0; delete S.sumDur; }

    res.status(200).json({
      ok: true, org, subdomain: SUBDOMAIN, periodDays: 30, elapsedMs: Date.now() - startedAt,
      leadsFound: leadRows.length, leadsSampled, leadCallNotes,
      leadsWithAnyLeadCall, pctCalledOfSampled: pct(leadsWithAnyLeadCall),
      // дозвон (по лидам) при РАЗНЫХ порогах — % от всех и % от реально званых
      reachByThreshold: {
        connected_dur_gt0: { leads: reach_pos, pctOfAll: pct(reach_pos), pctOfCalled: pctCalled(reach_pos) },
        ge10s:             { leads: reach_10,  pctOfAll: pct(reach_10),  pctOfCalled: pctCalled(reach_10) },
        ge15s:             { leads: reach_15,  pctOfAll: pct(reach_15),  pctOfCalled: pctCalled(reach_15) },
        ge40s_current:     { leads: reach_40,  pctOfAll: pct(reach_40),  pctOfCalled: pctCalled(reach_40) },
      },
      durationBucketsLead: durLead,
      callStatusHist, callResultHist,
      hint: "call_status с avgDur≈0 и dur0>>durPos = недозвон/сброс; статус с durPos = реальный разговор. reachByThreshold показывает, как порог влияет на % дозвона. Текущий порог 40с, вероятно, режет короткие реальные разговоры.",
    });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err) });
  }
}
