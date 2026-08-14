// /api/adbuilder.js — «мозг» рабочего стола ТАРГЕТ (Стадия 1: БЕЗ трат в Meta).
// Из данных (реальный ROAS по аудиториям из amoCRM + IG-посты как креативы) строит ПЛАН кампании:
// разбивку общего бюджета по адсетам/аудиториям + подбор креативов + тест-адсет Lookalike из покупателей amoCRM.
// Ничего в Meta НЕ создаёт — только предпросмотр того, что ALTRONE запустит после подтверждения (Стадия 2).
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function getSession(s) { if (!s) return null; try { const raw = await rget(`session:${s}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

const MKT_RATE = 12100; // $→сум, как в marketing.js
const GRAPH = "v21.0";
const META_TOKEN = process.env.META_TOKEN;
const AD_IG_ID = process.env.META_AD_IG_ID || "17841480222162829"; // @hunteracademy_uz — тестовый IG, откуда берём видео-креативы

// КРЕАТИВЫ — посты (видео/reels) из тестового Instagram напрямую через Graph API.
async function fetchIgMedia(igId) {
  if (!META_TOKEN || !igId) return [];
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH}/${igId}/media?fields=id,caption,media_type,permalink,like_count,comments_count,thumbnail_url,media_url&limit=25&access_token=${encodeURIComponent(META_TOKEN)}`);
    const d = await r.json();
    return ((d && d.data) || []).map((m) => ({ id: m.id, caption: (m.caption || "").replace(/\s+/g, " ").trim().slice(0, 80), type: m.media_type, permalink: m.permalink || null, engagement: (m.like_count || 0) + (m.comments_count || 0), thumb: m.thumbnail_url || m.media_url || null }));
  } catch (e) { return []; }
}
const fmt = (n) => (n == null || isNaN(n)) ? "—" : Math.round(n).toLocaleString("ru-RU");

// ЦЕЛИ ТАРГЕТА (objective) — для лид-бизнеса. sales/конверсии слабее без пикселя (у нас нет) → помечаем.
const OBJECTIVES = [
  { id: "leads", meta: "OUTCOME_LEADS", label: "Лиды (заявки / форма)", note: "заявки прямо в форму — синк в amoCRM", needsPixel: false, needsForm: true },
  { id: "messages", meta: "OUTCOME_ENGAGEMENT", label: "Сообщения (Direct / WhatsApp)", note: "пишут в переписку", needsPixel: false, needsForm: false },
  { id: "traffic", meta: "OUTCOME_TRAFFIC", label: "Трафик (на сайт / бота)", note: "переходы по ссылке", needsPixel: false, needsForm: false },
  { id: "engagement", meta: "OUTCOME_ENGAGEMENT", label: "Вовлечённость (просмотры / охват)", note: "узнаваемость, дешёвый охват", needsPixel: false, needsForm: false },
  { id: "sales", meta: "OUTCOME_SALES", label: "Продажи (конверсии)", note: "СЛАБО без пикселя — включим после Conversions API из amoCRM", needsPixel: true, needsForm: false },
];

// Лид-ФОРМЫ (Instant Forms) — лежат на СТРАНИЦАХ; тянем best-effort через страницы System User.
async function fetchLeadForms() {
  if (!META_TOKEN) return { forms: [], error: "META_TOKEN не задан" };
  try {
    const pr = await fetch(`https://graph.facebook.com/${GRAPH}/me/accounts?fields=id,name&limit=50&access_token=${encodeURIComponent(META_TOKEN)}`);
    const pd = await pr.json();
    const pages = (pd && pd.data) || [];
    const forms = [];
    for (const p of pages.slice(0, 10)) {
      try {
        const fr = await fetch(`https://graph.facebook.com/${GRAPH}/${p.id}/leadgen_forms?fields=id,name,status&limit=50&access_token=${encodeURIComponent(META_TOKEN)}`);
        const fd = await fr.json();
        for (const f of ((fd && fd.data) || [])) forms.push({ id: f.id, name: f.name || f.id, status: f.status || "", page: p.name || p.id });
      } catch (e) {}
    }
    return { forms, error: pd && pd.error ? (pd.error.message || "ошибка страниц") : null };
  } catch (e) { return { forms: [], error: String(e).slice(0, 150) }; }
}

export default async function handler(req, res) {
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const sess = await getSession(session);
  const cronOk = (req.query && (req.query.cron === "1")); // read-only планировщик/превью (трат нет — Стадия 1 ничего не создаёт в Meta)
  if (!cronOk && (!sess || !["admin", "marketing"].includes(sess.role))) { res.status(200).json({ ok: false, error: "нет доступа" }); return; }
  const org = (sess && sess.org) || "hunter";
  const action = (req.query && req.query.action) || "inputs";

  const dash = await rgetJSON(org === "hunter" ? "dashboard" : `dashboard:${org}`, null);
  const meta = await rgetJSON("meta_spend", null);
  const ig = await rgetJSON("marketingagent:instagram", null);

  // АУДИТОРИИ с реальным ROAS (из amoCRM: dashboard.adsets — лид помечен, какая аудитория; продажи из CRM).
  const adsets = (dash && Array.isArray(dash.adsets)) ? dash.adsets : [];
  const metaCur = ((meta && meta.currency) || "").toUpperCase();
  const toUZS = (x) => x == null ? null : (metaCur === "UZS" ? x : Math.round(x * MKT_RATE));
  const spendByName = {}; if (meta && Array.isArray(meta.adsets)) for (const a of meta.adsets) spendByName[a.name] = (spendByName[a.name] || 0) + (toUZS(a.spend) || 0);
  const auds = adsets.map((a) => {
    const spend = spendByName[a.name] != null ? spendByName[a.name] : 0;
    const revenue = a.revenueMonth || 0, leads = a.leadsMonth || 0, sold = a.soldMonth || 0;
    return {
      name: a.name, leads, sold, revenue, spend,
      roas: spend > 0 ? +(revenue / spend).toFixed(1) : null,
      cac: (sold > 0 && spend > 0) ? Math.round(spend / sold) : null,
      cpl: (leads > 0 && spend > 0) ? Math.round(spend / leads) : null,
      conv: leads > 0 ? +(sold / leads * 100).toFixed(1) : null,
    };
  }).filter((a) => a.leads > 0 || a.spend > 0);

  // КРЕАТИВЫ — посты из тестового Instagram напрямую (не из общего IG-кэша, тот на другой аккаунт).
  let posts = await fetchIgMedia(AD_IG_ID);
  if (!posts.length && ig && Array.isArray(ig.posts)) posts = ig.posts.map((p) => ({ caption: p.caption || "", engagement: p.engagement || 0, id: p.id || null, permalink: p.permalink || null })); // фолбэк на кэш

  // ДИСКАВЕРИ АССЕТОВ по бизнесу: страницы + их Instagram + лид-формы (чтобы найти Hunteracademy_uz и формы).
  if (action === "assets") {
    if (!META_TOKEN) { res.status(200).json({ ok: false, error: "META_TOKEN не задан" }); return; }
    const biz = String((req.query && req.query.business) || (req.body && req.body.business) || process.env.META_BUSINESS_ID || "");
    if (!biz) { res.status(200).json({ ok: false, error: "нужен business id (?business=...)" }); return; }
    const out = { business: biz, pages: [], igAccounts: [], forms: [], errors: [] };
    for (const edge of ["owned_pages", "client_pages"]) {
      try {
        const pr = await fetch(`https://graph.facebook.com/${GRAPH}/${biz}/${edge}?fields=id,name,instagram_business_account{id,username}&limit=100&access_token=${encodeURIComponent(META_TOKEN)}`);
        const pd = await pr.json();
        if (pd.error) { out.errors.push(`${edge}: ${pd.error.message}`); continue; }
        for (const p of ((pd && pd.data) || [])) {
          if (out.pages.find((x) => x.id === p.id)) continue;
          const iga = p.instagram_business_account;
          out.pages.push({ id: p.id, name: p.name, igUsername: iga ? iga.username : null, igId: iga ? iga.id : null });
          if (iga) out.igAccounts.push({ id: iga.id, username: iga.username, page: p.name });
          try {
            const fr = await fetch(`https://graph.facebook.com/${GRAPH}/${p.id}/leadgen_forms?fields=id,name,status&limit=50&access_token=${encodeURIComponent(META_TOKEN)}`);
            const fd = await fr.json();
            for (const f of ((fd && fd.data) || [])) out.forms.push({ id: f.id, name: f.name, status: f.status, page: p.name });
          } catch (e) {}
        }
      } catch (e) { out.errors.push(`${edge}: ${String(e).slice(0, 100)}`); }
    }
    res.status(200).json({ ok: true, ...out });
    return;
  }

  if (action === "inputs") {
    const lf = await fetchLeadForms();
    res.status(200).json({ ok: true, audiences: auds, creatives: posts, currency: "UZS", objectives: OBJECTIVES, forms: lf.forms, formsError: lf.error, hasPixel: false });
    return;
  }

  if (action === "plan") {
    const q = req.query || {}, bd = req.body || {};
    const budget = Math.max(0, Math.round(Number(q.budget || bd.budget || 0)));
    if (!budget) { res.status(400).json({ ok: false, error: "укажите общий бюджет (budget, в сумах)" }); return; }
    // ЦЕЛЬ, ДАТА ЗАПУСКА, ФОРМА
    const objId = String(q.objective || bd.objective || "leads");
    const objective = OBJECTIVES.find((o) => o.id === objId) || OBJECTIVES[0];
    const startDate = String(q.startDate || bd.startDate || "").slice(0, 10) || null; // YYYY-MM-DD; пусто = сразу
    const formId = (q.form || bd.form || q.formId || bd.formId || null);
    const campaign = {
      objective: objective.id, objectiveLabel: objective.label, objectiveMeta: objective.meta,
      startDate: startDate || "сразу после запуска",
      form: objective.needsForm ? (formId || null) : null,
      warnings: [
        ...(objective.needsPixel ? ["Цель «Продажи» без пикселя работает слабо — сначала подключим Conversions API из amoCRM."] : []),
        ...(objective.needsForm && !formId ? ["Для цели «Лиды» нужно выбрать лид-форму — иначе заявки некуда собирать."] : []),
      ],
    };
    // РАНЖИРОВАНИЕ по реальному ROAS (из amoCRM). Победители — с продажами и ROAS ≥ 1.
    const scored = auds.map((a) => ({ ...a, score: (a.roas || 0) })).sort((x, y) => y.score - x.score);
    const winners = scored.filter((a) => a.roas != null && a.roas >= 1 && a.sold > 0);
    const pool = winners.length ? winners : scored.slice(0, 3); // нет победителей → топ-3 по данным (тестовый режим)
    // РЕЗЕРВ на новую аудиторию (Lookalike из покупателей amoCRM) — тестируем малым.
    const testShare = 0.2, testBudget = Math.round(budget * testShare), coreBudget = budget - testBudget;
    const perAdsetCap = Math.round(budget * 0.5); // потолок на один адсет — не лить всё в одну аудиторию
    const sumScore = pool.reduce((s, a) => s + Math.max(0.1, a.score), 0) || 1;
    const split = pool.map((a) => {
      let b = Math.round(coreBudget * Math.max(0.1, a.score) / sumScore);
      b = Math.min(b, perAdsetCap);
      return { audience: a.name, budgetUZS: b, roas: a.roas, cac: a.cac, cpl: a.cpl, conv: a.conv, proven: a.roas >= 1 && a.sold > 0, creative: null };
    });
    if (split.length) split[0].budgetUZS += (coreBudget - split.reduce((s, a) => s + a.budgetUZS, 0)); // добор округления
    split.push({ audience: "Lookalike (покупатели amoCRM)", budgetUZS: testBudget, roas: null, cac: null, cpl: null, conv: null, isTest: true, creative: null, note: "новая аудитория из твоих покупателей — тест малым, масштаб при результате" });
    // КРЕАТИВЫ: топ IG-посты по вовлечённости, ротацией по адсетам.
    const topCre = [...posts].sort((a, b) => b.engagement - a.engagement).slice(0, Math.max(3, split.length));
    split.forEach((a, i) => { a.creative = topCre.length ? (topCre[i % topCre.length].caption || `IG-пост #${i + 1}`) : "— (нет постов в IG)"; });
    // прогноз лидов — по средней цене лида известных аудиторий
    const knownCpl = auds.filter((a) => a.cpl); const avgCpl = knownCpl.length ? Math.round(knownCpl.reduce((s, a) => s + a.cpl, 0) / knownCpl.length) : null;
    const expectedLeads = avgCpl ? split.reduce((s, a) => s + Math.round(a.budgetUZS / (a.cpl || avgCpl)), 0) : null;
    res.status(200).json({
      ok: true, budgetUZS: budget, campaign, split, expectedLeads, avgCpl, creativesAvailable: posts.length,
      rationale: { basis: "реальный ROAS по аудиториям из amoCRM (не прокси Meta)", winners: winners.length, testShare, perAdsetCapPct: 50 },
      note: "ПЛАН (Стадия 1): в Meta НИЧЕГО не создано. Это предпросмотр того, что ALTRONE соберёт и запустит ПОСЛЕ твоего подтверждения (Стадия 2). Общий бюджет — жёсткий потолок.",
    });
    return;
  }
  res.status(200).json({ ok: false, error: "unknown action" });
}
