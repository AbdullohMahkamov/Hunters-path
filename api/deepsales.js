// /api/deepsales.js — интеграция с DeepSales (анализ звонков).
// Секреты ТОЛЬКО из переменных окружения (никогда не из тела/чата):
//   DEEPSALES_EMAIL / DEEPSALES_PASSWORD — Basic-авторизация на audio-analyze
//   DEEPSALES_BEARER_TOKEN — Bearer на dashboard-эндпоинты (call-analysis, transcription)
// Отправка аудио идёт СО СТОРОНЫ СЕРВЕРА (Vercel скачивает запись из amoCRM и шлёт в DeepSales) —
// клиентские записи не проходят через локальную машину/переписку.
//
// action=analyze  body:{ items:[{link, crm_manager_id, leadId}] } → скачать .wav → POST audio-analyze → audio_id
// action=result   body:{ ids:[audio_id] } | ?audio_id=  → GET call-analysis + transcription (Bearer)
// Лимиты DeepSales: 60/мин dashboard (audio-analyze), 600/мин analysis (call-analysis/transcription) — заложены паузами.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DS = "https://dashboard.deepsales.uz";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSession(session) {
  if (!session || !REDIS_URL) return null;
  try {
    const r = await fetch(`${REDIS_URL}/get/session:${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const d = await r.json();
    return d && d.result ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "";

  // гейт — только суперадмин (hunter). Анализ звонков — чувствительная операция.
  const sess = await getSession(q.session || b.session);
  if (!(sess && sess.role === "admin" && sess.org === "hunter")) { res.status(403).json({ error: "superadmin only" }); return; }

  const EMAIL = process.env.DEEPSALES_EMAIL, PASSWORD = process.env.DEEPSALES_PASSWORD, BEARER = process.env.DEEPSALES_BEARER_TOKEN;
  if (!EMAIL || !PASSWORD || !BEARER) { res.status(500).json({ error: "не заданы env: DEEPSALES_EMAIL / DEEPSALES_PASSWORD / DEEPSALES_BEARER_TOKEN" }); return; }
  const basic = "Basic " + Buffer.from(`${EMAIL}:${PASSWORD}`).toString("base64");

  // === ANALYZE: скачать запись из amoCRM (server-side) и отправить в DeepSales ===
  if (action === "analyze") {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) { res.status(400).json({ error: "нужен items: [{link, crm_manager_id, leadId}]" }); return; }
    if (items.length > 40) { res.status(400).json({ error: "не более 40 записей за вызов (бюджет/таймаут) — дробите на партии" }); return; }
    const out = [];
    for (const it of items) {
      try {
        if (!it.link || !it.crm_manager_id) { out.push({ leadId: it.leadId || null, ok: false, error: "нужны link и crm_manager_id" }); continue; }
        const ar = await fetch(it.link, { signal: AbortSignal.timeout(30000) });
        if (!ar.ok) { out.push({ leadId: it.leadId, ok: false, error: `скачивание аудио: HTTP ${ar.status}` }); continue; }
        const buf = Buffer.from(await ar.arrayBuffer());
        const fd = new FormData();
        fd.append("file", new Blob([buf], { type: "audio/wav" }), `call_${it.leadId || "x"}.wav`);
        fd.append("crm_manager_id", String(it.crm_manager_id));
        const r = await fetch(`${DS}/api/crm/audio-analyze`, { method: "POST", headers: { Authorization: basic, Accept: "application/json" }, body: fd, signal: AbortSignal.timeout(90000) });
        let body; try { body = await r.json(); } catch (e) { body = { _text: (await r.text().catch(() => "")).slice(0, 200) }; }
        const aid = body.audio_id || body.id || (body.data && (body.data.audio_id || body.data.id)) || null;
        out.push({ leadId: it.leadId, ok: r.status < 300, status: r.status, audio_id: aid, bytes: buf.length, seconds: it.duration || null, resp: body });
      } catch (e) { out.push({ leadId: it.leadId, ok: false, error: String(e).slice(0, 140) }); }
      await sleep(1200); // 60/мин dashboard — с запасом
    }
    res.status(200).json({ ok: true, action: "analyze", count: out.length, results: out });
    return;
  }

  // === RESULT: опрос результата по audio_id (Bearer) ===
  if (action === "result") {
    const ids = Array.isArray(b.ids) ? b.ids : (q.audio_id ? [q.audio_id] : []);
    if (!ids.length) { res.status(400).json({ error: "нужен ids: [audio_id] или ?audio_id=" }); return; }
    if (ids.length > 60) { res.status(400).json({ error: "не более 60 id за вызов" }); return; }
    const bget = async (path) => {
      const r = await fetch(`${DS}${path}`, { headers: { Authorization: `Bearer ${BEARER}`, Accept: "application/json" }, signal: AbortSignal.timeout(30000) });
      let body; try { body = await r.json(); } catch (e) { body = { _s: r.status }; }
      return { status: r.status, body };
    };
    const out = [];
    for (const aid of ids) {
      const ca = await bget(`/api/call-analysis?audio_id=${encodeURIComponent(aid)}`);
      await sleep(120); // 600/мин analysis
      const tr = await bget(`/api/transcription?audio_id=${encodeURIComponent(aid)}`);
      await sleep(120);
      out.push({ audio_id: aid, call_analysis: ca, transcription: tr });
    }
    res.status(200).json({ ok: true, action: "result", results: out });
    return;
  }

  res.status(400).json({ error: "action: analyze | result" });
}
