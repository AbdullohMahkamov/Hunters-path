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

  // === PICK: исторический отбор звонков по СТАТУСУ лида (won/lost) за месяц ===
  // Нужен для контрастного анализа: debug=calls умеет только «сегодня», а нам нужны записи любой давности.
  // Только amoCRM — секреты DeepSales тут не требуются (поэтому до их проверки).
  if (action === "pick") {
    const AMO = process.env.AMOCRM_TOKEN;
    if (!AMO) { res.status(500).json({ error: "нет AMOCRM_TOKEN" }); return; }
    const SUB = "huntercademy", SOLD = 142, LOST = 143;
    const MOPS = { 13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda", 13833590: "Begoyim", 13681582: "Abulbositxon" };
    const minSec = parseInt(q.minSec || b.minSec || 120, 10);
    const maxSec = parseInt(q.maxSec || b.maxSec || 240, 10);
    const need = Math.min(parseInt(q.need || b.need || 15, 10), 25);
    const SCAN_CAP = Math.min(parseInt(q.scanCap || b.scanCap || 200, 10), 300);
    const sinceDays = parseInt(q.sinceDays || b.sinceDays || 60, 10); // свежесть звонка: старые записи Utel могут быть вычищены
    const sinceTs = Math.floor(Date.now() / 1000) - sinceDays * 86400;
    const BYTES_PER_SEC = 16000; // 8кГц 16-бит моно — проверено: 1402284Б / 88с ≈ 15935
    const base = `https://${SUB}.amocrm.ru/api/v4`;
    const H = { Authorization: `Bearer ${AMO}` };
    const TZ = 5 * 3600;
    const nl = new Date(Date.now() + TZ * 1000);
    const monthStart = Math.floor(Date.UTC(nl.getUTCFullYear(), nl.getUTCMonth(), 1) / 1000) - TZ;

    // 1) лиды, тронутые в этом месяце → делим на won/lost (только наши МОПы)
    const wonLeads = [], lostLeads = [];
    for (let page = 1; page <= 6; page++) {
      const r = await fetch(`${base}/leads?limit=250&page=${page}&filter[updated_at][from]=${monthStart}`, { headers: H });
      if (r.status === 204 || !r.ok) break;
      const d = await r.json();
      const leads = (d._embedded && d._embedded.leads) || [];
      for (const L of leads) {
        if (!MOPS[L.responsible_user_id]) continue;
        if (L.status_id === SOLD) wonLeads.push(L); else if (L.status_id === LOST) lostLeads.push(L);
      }
      if (leads.length < 250) break;
      await sleep(180);
    }

    // 2) по каждому лиду — ноты, берём САМЫЙ ДЛИННЫЙ звонок в диапазоне [minSec..maxSec]
    const pickFrom = async (leads, status) => {
      const out = [];
      for (const L of leads.slice(0, SCAN_CAP)) {
        if (out.length >= need) break;
        const r = await fetch(`${base}/leads/${L.id}/notes?limit=250`, { headers: H });
        await sleep(170); // ~6/с — под лимит amoCRM (~7/с)
        if (!r.ok || r.status === 204) continue;
        const d = await r.json();
        let best = null;
        for (const n of ((d._embedded && d._embedded.notes) || [])) {
          if (n.note_type !== "call_in" && n.note_type !== "call_out") continue;
          const p = n.params || {};
          const dur = parseInt(p.duration || 0, 10) || 0;
          if (dur < minSec || dur > maxSec || !p.link) continue;
          if (n.created_at < sinceTs) continue; // только свежие — старые записи Utel могут быть удалены
          if (!best || dur > best.dur) best = { dur, link: p.link, ts: n.created_at };
        }
        if (!best) continue;
        // HEAD: (1) жива ли ссылка, (2) РЕАЛЬНАЯ длительность файла — DeepSales считает бюджет по файлу
        // (с гудками), а не по времени разговора из amoCRM. Проверено: 55с разговора = 88с файла.
        let fileSec = null;
        try {
          const h = await fetch(best.link, { method: "HEAD", signal: AbortSignal.timeout(12000) });
          if (h.ok) { const len = parseInt(h.headers.get("content-length") || "0", 10); if (len > 0) fileSec = Math.round(len / BYTES_PER_SEC); }
        } catch (e) { /* мёртвая ссылка */ }
        await sleep(100);
        if (fileSec == null) continue; // ссылка недоступна — пропускаем, чтобы не слать битое
        out.push({ leadId: L.id, status, mop: MOPS[L.responsible_user_id], talkSec: best.dur, fileSec, link: best.link, callDate: new Date(best.ts * 1000).toISOString().slice(0, 10) });
      }
      return out;
    };
    const won = await pickFrom(wonLeads, "won");
    const lost = await pickFrom(lostLeads, "lost");
    const sumFile = (a) => a.reduce((s, x) => s + (x.fileSec || 0), 0);
    const sumTalk = (a) => a.reduce((s, x) => s + (x.talkSec || 0), 0);
    res.status(200).json({
      ok: true, action: "pick", filter: { minSec, maxSec, need, scanCap: SCAN_CAP, sinceDays },
      scanned: { wonLeadsThisMonth: wonLeads.length, lostLeadsThisMonth: lostLeads.length },
      won, lost,
      // БЮДЖЕТ считаем по fileSec (весь файл с гудками) — именно его тарифицирует DeepSales.
      totals: {
        wonCount: won.length, lostCount: lost.length,
        wonFileMin: +(sumFile(won) / 60).toFixed(1), lostFileMin: +(sumFile(lost) / 60).toFixed(1),
        totalFileMin: +((sumFile(won) + sumFile(lost)) / 60).toFixed(1),
        totalTalkMin: +((sumTalk(won) + sumTalk(lost)) / 60).toFixed(1),
      },
    });
    return;
  }

  const EMAIL = process.env.DEEPSALES_EMAIL, PASSWORD = process.env.DEEPSALES_PASSWORD, BEARER = process.env.DEEPSALES_BEARER_TOKEN;
  if (!EMAIL || !PASSWORD || !BEARER) { res.status(500).json({ error: "не заданы env: DEEPSALES_EMAIL / DEEPSALES_PASSWORD / DEEPSALES_BEARER_TOKEN" }); return; }
  const basic = "Basic " + Buffer.from(`${EMAIL}:${PASSWORD}`).toString("base64");

  // === ANALYZE: скачать запись из amoCRM (server-side) и отправить в DeepSales ===
  if (action === "analyze") {
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length) { res.status(400).json({ error: "нужен items: [{link, crm_manager_id, leadId}]" }); return; }
    if (items.length > 40) { res.status(400).json({ error: "не более 40 записей за вызов (бюджет/таймаут) — дробите на партии" }); return; }
    // DeepSales используется как чистый транскрибатор/анализатор: все записи шлём на ОДНОГО
    // технического менеджера (DEEPSALES_MANAGER_ID). Привязка «чей это звонок» (МОП/лид/статус)
    // живёт ЦЕЛИКОМ у нас — мы знаем её из amoCRM до отправки и храним в ответе ниже.
    const MANAGER_ID = process.env.DEEPSALES_MANAGER_ID;
    if (!MANAGER_ID) { res.status(500).json({ error: "не задан env DEEPSALES_MANAGER_ID (технический менеджер DeepSales)" }); return; }
    const out = [];
    for (const it of items) {
      try {
        if (!it.link) { out.push({ leadId: it.leadId || null, ok: false, error: "нужен link" }); continue; }
        // audio_url — DeepSales сам скачивает запись (Utel публичен, CORS *).
        const fd = new FormData();
        fd.append("audio_url", it.link);
        fd.append("manager_id", String(MANAGER_ID));
        const r = await fetch(`${DS}/api/crm/audio-analyze`, { method: "POST", headers: { Authorization: basic, Accept: "application/json" }, body: fd, signal: AbortSignal.timeout(90000) });
        let body; try { body = await r.json(); } catch (e) { body = { _text: (await r.text().catch(() => "")).slice(0, 200) }; }
        // DeepSales отдаёт id в data.audio_file_id (не audio_id). data.duration — длительность ВСЕГО файла
        // (включая гудки): именно она тратит бюджет минут, а не duration разговора из amoCRM.
        const D = body.data || {};
        const aid = D.audio_file_id || D.audio_id || D.id || body.audio_id || body.id || null;
        // mop/leadStatus возвращаем обратно — это НАША привязка результата к менеджеру и исходу сделки
        out.push({ leadId: it.leadId, mop: it.mop || null, leadStatus: it.status || null, ok: r.status < 300, status: r.status, audio_id: aid, amoSeconds: it.duration || null, fileSeconds: D.duration || null, resp: body });
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

  res.status(400).json({ error: "action: pick | analyze | result" });
}
