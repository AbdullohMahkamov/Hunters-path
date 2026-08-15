// /api/adbuilder.js — «мозг» рабочего стола ТАРГЕТ (Стадия 1: БЕЗ трат в Meta).
// Из данных (реальный ROAS по аудиториям из amoCRM + IG-посты как креативы) строит ПЛАН кампании:
// разбивку общего бюджета по адсетам/аудиториям + подбор креативов + тест-адсет Lookalike из покупателей amoCRM.
// Ничего в Meta НЕ создаёт — только предпросмотр того, что ALTRONE запустит после подтверждения (Стадия 2).
import crypto from "node:crypto";
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rset(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: typeof v === "string" ? v : JSON.stringify(v) }); } catch (e) {} }
// нормализация UZ-телефона в 12 цифр (998XXXXXXXXX); хеш SHA-256 для Meta Custom Audience (обезличенно)
function normUzPhone(raw) { let d = String(raw || "").replace(/\D/g, ""); if (d.length === 9) d = "998" + d; if (d.length === 12 && d.startsWith("998")) return d; if (d.startsWith("998")) return d.slice(0, 12); return null; }
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
// резолв названий интересов в ID Meta (Targeting Search) — для узкого теста
async function resolveInterests(names) {
  if (!META_TOKEN) return [];
  const out = [];
  for (const q of names) {
    try {
      const d = await (await fetch(`https://graph.facebook.com/${GRAPH}/search?type=adinterest&q=${encodeURIComponent(q)}&limit=1&locale=en_US&access_token=${encodeURIComponent(META_TOKEN)}`)).json();
      const it = d && d.data && d.data[0];
      if (it && it.id) out.push({ id: it.id, name: it.name });
    } catch (e) {}
  }
  return out;
}
async function getSession(s) { if (!s) return null; try { const raw = await rget(`session:${s}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

const MKT_RATE = 12100; // $→сум, как в marketing.js
const GRAPH = "v21.0";
const META_TOKEN = process.env.META_TOKEN;
const AD_IG_ID = process.env.META_AD_IG_ID || "17841480222162829"; // @hunteracademy_uz — тестовый IG, откуда берём видео-креативы
const BUSINESS_ID = process.env.META_BUSINESS_ID || "895505843209419"; // Hunter — бизнес (для страниц/форм)
const AD_ACCOUNT = (process.env.META_AD_ACCOUNT_ID || "825927740501149").replace(/^act_/, ""); // рекламный кабинет

// ИЗУЧИТЬ ИЗНУТРИ работающие адсеты: реальный таргетинг (возраст/гео/интересы/плейсменты/цель) — чтобы строить тесты на данных, не вслепую.
async function fetchExistingAdsets() {
  if (!META_TOKEN) return { adsets: [], error: "META_TOKEN не задан" };
  try {
    const fields = "id,name,effective_status,daily_budget,lifetime_budget,optimization_goal,billing_event,bid_strategy,targeting,promoted_object";
    const d = await (await fetch(`https://graph.facebook.com/${GRAPH}/act_${AD_ACCOUNT}/adsets?fields=${fields}&limit=200&access_token=${encodeURIComponent(META_TOKEN)}`)).json();
    if (d && d.error) return { adsets: [], error: d.error.message };
    const adsets = ((d && d.data) || []).map((a) => {
      const t = a.targeting || {}, geo = t.geo_locations || {};
      const interests = [];
      for (const spec of (t.flexible_spec || [])) for (const k of ["interests", "behaviors"]) for (const it of (spec[k] || [])) interests.push(it.name);
      return {
        id: a.id, name: a.name, status: a.effective_status,
        dailyBudgetUSD: a.daily_budget ? Math.round(a.daily_budget) / 100 : null, // minor units → $
        optimizationGoal: a.optimization_goal || null, billing: a.billing_event || null, bid: a.bid_strategy || null,
        ageMin: t.age_min || null, ageMax: t.age_max || null, genders: t.genders || null,
        countries: geo.countries || null, cities: (geo.cities || []).map((c) => c.name || c.key), regions: (geo.regions || []).map((r) => r.name),
        interests: interests.slice(0, 20),
        customAudiences: (t.custom_audiences || []).map((c) => c.name || c.id),
        placements: { publisher: t.publisher_platforms || null, ig: t.instagram_positions || null, fb: t.facebook_positions || null, auto: !t.publisher_platforms },
      };
    });
    return { adsets };
  } catch (e) { return { adsets: [], error: String(e).slice(0, 150) }; }
}

// КРЕАТИВЫ — посты (видео/reels) из тестового Instagram напрямую через Graph API.
async function fetchIgMedia(igId) {
  if (!META_TOKEN || !igId) return [];
  const out = [];
  try {
    let url = `https://graph.facebook.com/${GRAPH}/${igId}/media?fields=id,caption,media_type,permalink,like_count,comments_count,thumbnail_url,media_url&limit=50&access_token=${encodeURIComponent(META_TOKEN)}`;
    let guard = 0;
    while (url && guard < 5) { // до ~250 постов (5 страниц)
      guard++;
      const d = await (await fetch(url)).json();
      for (const m of ((d && d.data) || [])) out.push({ id: m.id, caption: (m.caption || "").replace(/\s+/g, " ").trim().slice(0, 80), type: m.media_type, permalink: m.permalink || null, engagement: (m.like_count || 0) + (m.comments_count || 0), thumb: m.thumbnail_url || m.media_url || null, videoUrl: m.media_type === "VIDEO" ? (m.media_url || null) : null });
      url = (d && d.paging && d.paging.next) || null;
    }
  } catch (e) {}
  return out;
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

// Лид-ФОРМЫ (Instant Forms) — на СТРАНИЦАХ бизнеса. Тянем через owned_pages/client_pages (у System User /me/accounts пуст).
async function fetchLeadForms() {
  if (!META_TOKEN) return { forms: [], error: "META_TOKEN не задан" };
  const forms = [], errors = [], seenPage = new Set();
  for (const edge of ["owned_pages", "client_pages"]) {
    try {
      const pd = await (await fetch(`https://graph.facebook.com/${GRAPH}/${BUSINESS_ID}/${edge}?fields=id,name&limit=100&access_token=${encodeURIComponent(META_TOKEN)}`)).json();
      if (pd && pd.error) { errors.push(`${edge}: ${pd.error.message}`); continue; }
      for (const p of ((pd && pd.data) || [])) {
        if (seenPage.has(p.id)) continue; seenPage.add(p.id);
        try {
          // лид-формы читаются ТОЛЬКО page-токеном (ошибка #190) — сперва берём page access token
          const ptj = await (await fetch(`https://graph.facebook.com/${GRAPH}/${p.id}?fields=access_token&access_token=${encodeURIComponent(META_TOKEN)}`)).json();
          const pageToken = (ptj && ptj.access_token) || META_TOKEN;
          const fd = await (await fetch(`https://graph.facebook.com/${GRAPH}/${p.id}/leadgen_forms?fields=id,name,status&limit=100&access_token=${encodeURIComponent(pageToken)}`)).json();
          if (fd && fd.error) { errors.push(`forms(${p.name}): ${fd.error.message}`); continue; }
          for (const f of ((fd && fd.data) || [])) if (!forms.find((x) => x.id === f.id)) forms.push({ id: f.id, name: f.name || f.id, status: f.status || "", page: p.name });
        } catch (e) {}
      }
    } catch (e) { errors.push(`${edge}: ${String(e).slice(0, 80)}`); }
  }
  return { forms, error: errors.length ? errors.join(" | ") : null };
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
  }).filter((a) => (a.leads > 0 || a.spend > 0) && a.name && a.name.length < 70 && !/permission|https?:\/\//i.test(a.name)); // отсеиваем мусорные имена (просочившиеся ошибки Meta)

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

  // ИЗУЧИТЬ РАБОТАЮЩИЕ ТАРГЕТЫ ИЗНУТРИ: таргетинг адсетов из Meta + сопоставление с реальным ROAS (amoCRM).
  if (action === "study") {
    const ex = await fetchExistingAdsets();
    const roasByName = {}; for (const a of auds) roasByName[a.name] = { roas: a.roas, cpl: a.cpl, sold: a.sold, leads: a.leads };
    const studied = (ex.adsets || []).map((a) => ({ ...a, result: roasByName[a.name] || null }))
      .sort((x, y) => ((y.result && y.result.roas) || -1) - ((x.result && x.result.roas) || -1));
    res.status(200).json({ ok: true, adsets: studied, error: ex.error || null, account: AD_ACCOUNT });
    return;
  }

  if (action === "inputs") {
    const lf = await fetchLeadForms();
    res.status(200).json({ ok: true, audiences: auds, creatives: posts, currency: "UZS", objectives: OBJECTIVES, forms: lf.forms, formsError: lf.error, hasPixel: false });
    return;
  }

  // ═══ СТАДИЯ 2.2: LOOKALIKE ИЗ ПОКУПАТЕЛЕЙ amoCRM ═══
  // dryRun: тянем покупателей (выигранные сделки) → телефоны, считаем. confirm: создаём Custom Audience + Lookalike в Meta.
  if (action === "audience") {
    const confirm = (req.body && (req.body.confirm === true || req.body.confirm === 1)) || false;
    const dryRunA = !confirm;
    if (!dryRunA && !(sess && ["admin", "marketing"].includes(sess.role))) { res.status(403).json({ ok: false, error: "создание аудитории — только по сессии admin/marketing" }); return; }
    const AMO = process.env.AMOCRM_TOKEN, SUB = "huntercademy";
    if (!AMO) { res.status(200).json({ ok: false, error: "AMOCRM_TOKEN не задан" }); return; }
    const amoBase = `https://${SUB}.amocrm.ru/api/v4`, AH = { Authorization: `Bearer ${AMO}` };
    try {
      const aj = async (u) => { const r = await fetch(u, { headers: AH }); if (r.status === 204 || !r.ok) return null; try { return await r.json(); } catch (e) { return null; } };
      // 1) статус "Sotildi" (продано) + воронка
      const pj = await aj(`${amoBase}/leads/pipelines`);
      if (!pj) { res.status(200).json({ ok: false, error: "amoCRM /pipelines не ответил (токен/сеть)" }); return; }
      const soldStatuses = [];
      for (const p of ((pj._embedded && pj._embedded.pipelines) || [])) for (const s of ((p._embedded && p._embedded.statuses) || [])) if ((s.name || "").toLowerCase().includes("sotildi") || s.type === 1) soldStatuses.push({ pid: p.id, sid: s.id, name: s.name });
      if (!soldStatuses.length) { res.status(200).json({ ok: false, error: "статус «Sotildi»/успех не найден в amoCRM" }); return; }
      const statusFilter = soldStatuses.map((x, i) => `filter[statuses][${i}][pipeline_id]=${x.pid}&filter[statuses][${i}][status_id]=${x.sid}`).join("&");
      // 2) выигранные сделки → id контактов
      const contactIds = new Set(); let page = 1, guard = 0, leadsFound = 0;
      while (guard < 60) { guard++;
        const d = await aj(`${amoBase}/leads?${statusFilter}&with=contacts&limit=250&page=${page}`);
        if (!d) break;
        const leads = (d._embedded && d._embedded.leads) || [];
        leadsFound += leads.length;
        for (const l of leads) for (const c of ((l._embedded && l._embedded.contacts) || [])) contactIds.add(c.id);
        if (leads.length < 250) break; page++;
      }
      // 3) телефоны контактов
      const ids = [...contactIds], phones = new Set();
      for (let i = 0; i < ids.length; i += 250) {
        const q = ids.slice(i, i + 250).map((id) => `filter[id][]=${id}`).join("&");
        const d = await aj(`${amoBase}/contacts?${q}&limit=250`);
        if (!d) continue;
        for (const c of ((d._embedded && d._embedded.contacts) || [])) for (const f of (c.custom_fields_values || [])) if (f.field_code === "PHONE" || f.field_type === "phone") for (const v of (f.values || [])) { const n = normUzPhone(v.value); if (n) phones.add(n); }
      }
      const phoneArr = [...phones];
      if (dryRunA) { res.status(200).json({ ok: true, dryRun: true, buyers: contactIds.size, phones: phoneArr.length, leadsFound, soldStatuses: soldStatuses.length, sample: phoneArr.slice(0, 3).map((p) => p.slice(0, 5) + "•••" + p.slice(-2)), note: "СУХОЙ ПРОГОН: в Meta ничего не создано. Столько телефонов покупателей соберётся в Lookalike. Подтверди — загружу (хешированно) и построю Lookalike 1% (UZ)." }); return; }
      if (phoneArr.length < 100) { res.status(200).json({ ok: false, error: `телефонов покупателей ${phoneArr.length} — для Lookalike Meta нужно ≥100. Пока мало.` }); return; }
      // 4) Meta: Custom Audience → загрузка хешей → Lookalike
      const acct = `act_${AD_ACCOUNT}`;
      const mpost = async (path, body) => (await (await fetch(`https://graph.facebook.com/${GRAPH}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, access_token: META_TOKEN }) })).json());
      const ca = await mpost(`${acct}/customaudiences`, { name: "ALTRONE · Покупатели amoCRM", subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY", description: "покупатели из amoCRM (хеш телефонов)" });
      if (!ca.id) {
        const cerr = ca.error || {};
        const isTos = cerr.error_subcode === 1870090 || /terms|услови/i.test(String(cerr.error_user_title || cerr.message || ""));
        const tosUrl = `https://www.facebook.com/ads/manage/customaudiences/tos.php?act=${AD_ACCOUNT}`;
        res.status(200).json({ ok: false, tosUrl: isTos ? tosUrl : null, error: isTos ? `Нужно ОДИН РАЗ принять «Условия использования Custom Audiences» в Meta. Открой: ${tosUrl} → нажми Accept/Принять, затем снова «Собрать Lookalike». Это разовое требование Meta для загрузки списков клиентов.` : "Custom Audience не создана: " + JSON.stringify(cerr).slice(0, 160) });
        return;
      }
      // загрузка партиями по 5000
      let uploaded = 0;
      for (let i = 0; i < phoneArr.length; i += 5000) {
        const data = phoneArr.slice(i, i + 5000).map((p) => [sha256(p)]);
        const up = await mpost(`${ca.id}/users`, { payload: { schema: ["PHONE"], data } });
        if (up.error) { res.status(200).json({ ok: false, error: "загрузка контактов не удалась: " + JSON.stringify(up.error).slice(0, 160), customAudienceId: ca.id }); return; }
        uploaded += data.length;
      }
      const la = await mpost(`${acct}/customaudiences`, { name: "ALTRONE · Lookalike 1% покупатели (UZ)", subtype: "LOOKALIKE", origin_audience_id: ca.id, lookalike_spec: JSON.stringify({ type: "similarity", country: "UZ", ratio: 0.01 }) });
      if (!la.id) { res.status(200).json({ ok: false, error: "Lookalike не создан: " + JSON.stringify(la.error || la).slice(0, 160), customAudienceId: ca.id, uploaded }); return; }
      await rset("mkt:lookalike:hunter", { customAudienceId: ca.id, lookalikeId: la.id, phones: uploaded, at: Date.now() });
      res.status(200).json({ ok: true, dryRun: false, customAudienceId: ca.id, lookalikeId: la.id, uploaded, note: `Готово: загружено ${uploaded} покупателей, создан Lookalike 1% (UZ). Теперь тесты «Lookalike из amoCRM» будут таргетироваться на эту аудиторию (Meta её «прогреет» за несколько часов).` });
    } catch (e) { res.status(200).json({ ok: false, error: String(e).slice(0, 200) }); }
    return;
  }

  // ═══ СТАДИЯ 2: СОЗДАНИЕ В META ═══ деньги/запись → ТОЛЬКО сессия admin/marketing (без cron). Всегда PAUSED. Потолок бюджета.
  // По умолчанию dryRun (показать payload'ы, ничего не создавать). Реальное создание — только confirm:true.
  if (action === "create") {
    if (!(sess && ["admin", "marketing"].includes(sess.role))) { res.status(403).json({ ok: false, error: "создание в Meta — только по сессии admin/marketing" }); return; }
    if (!META_TOKEN) { res.status(200).json({ ok: false, error: "META_TOKEN не задан" }); return; }
    const plan = (req.body && req.body.plan) || {};
    const campaign = plan.campaign || {}, splitIn = Array.isArray(plan.split) ? plan.split : [];
    const currency = plan.currency || "USD";
    const confirm = (req.body && (req.body.confirm === true || req.body.confirm === 1)) || false;
    const dryRun = !confirm;
    // ПОТОЛОК безопасности — задаёт владелец в мастере (по умолчанию 500 в валюте плана)
    const CAP = Number(req.body && req.body.cap) > 0 ? Number(req.body.cap) : 500;
    const total = splitIn.reduce((s, t) => s + (Number(t.budget) || 0), 0);
    const cur = currency === "USD" ? "$" : "сум";
    if (total > CAP) { res.status(400).json({ ok: false, error: `суммарный бюджет ${cur}${total}/дн выше твоего потолка ${cur}${CAP} — снизь бюджет или подними потолок` }); return; }
    if (!splitIn.length) { res.status(400).json({ ok: false, error: "пустой план — сначала собери план (Стадия 1)" }); return; }
    const objMap = { leads: "OUTCOME_LEADS", messages: "OUTCOME_ENGAGEMENT", traffic: "OUTCOME_TRAFFIC", engagement: "OUTCOME_ENGAGEMENT", sales: "OUTCOME_SALES" };
    const objective = objMap[campaign.objective] || "OUTCOME_LEADS";
    const PAGE_ID = "981935968332820", IG_ID = AD_IG_ID;
    const acct = `act_${AD_ACCOUNT}`;
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const post = async (path, body) => { const r = await fetch(`https://graph.facebook.com/${GRAPH}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, access_token: META_TOKEN }) }); return r.json(); };
    const centsUSD = (v) => Math.max(100, Math.round(Number(v || 0) * 100)); // $ → центы, минимум $1
    const log = [];
    const formId = campaign.form || null;
    const lk = await rgetJSON("mkt:lookalike:hunter", null); const lookalikeId = lk && lk.lookalikeId; // Lookalike из amoCRM (Стадия 2.2), если собран
    // 1) КАМПАНИЯ — создаём на ПАУЗЕ (шлюз: пока кампания на паузе, ничего не откручивается). Включим в конце, если крео легли.
    const campBody = { name: `ALTRONE тест · ${campaign.objectiveLabel || "Лиды"} · ${stamp}`, objective, status: "PAUSED", special_ad_categories: [], is_adset_budget_sharing_enabled: false };
    let campaignId = null;
    if (dryRun) { log.push({ step: "campaign", willCreate: campBody }); }
    else { const r = await post(`${acct}/campaigns`, campBody); if (r.id) { campaignId = r.id; log.push({ step: "campaign", ok: true, id: r.id }); } else { res.status(200).json({ ok: false, error: "кампания не создана: " + JSON.stringify(r.error || r), log }); return; } }
    // 2) для каждого теста: АДСЕТ (ACTIVE) + ОБЪЯВЛЕНИЕ (видео из IG → advideo → креатив с формой → ad). Кампания-шлюз держит паузу.
    const adsets = []; let adsMade = 0;
    for (const t of splitIn) {
      const targeting = { age_min: 18, age_max: 65, geo_locations: { countries: ["UZ"] } };
      const notes = [];
      if (t.type === "interest") { const ints = await resolveInterests(t.interestQueries || ["Sales", "Business", "Entrepreneurship"]); if (ints.length) { targeting.flexible_spec = [{ interests: ints }]; notes.push(`✓ интересы: ${ints.map((x) => x.name).join(", ")}`); } else notes.push("⚠️ интересы не нашлись в Meta — пока широкая по стране"); }
      if (t.type === "lookalike") { if (lookalikeId) { targeting.custom_audiences = [{ id: lookalikeId }]; notes.push("✓ Lookalike из покупателей amoCRM"); } else { notes.push("⚠️ Lookalike из amoCRM ещё не собран — нажми «Собрать Lookalike» (пока широкая)"); } }
      const adsetBody = { name: `ALTRONE · ${t.audience}`.slice(0, 100), campaign_id: campaignId || "<campaign_id>", daily_budget: currency === "USD" ? centsUSD(t.budget) : Math.round(t.budget), billing_event: "IMPRESSIONS", optimization_goal: objective === "OUTCOME_LEADS" ? "LEAD_GENERATION" : "REACH", bid_strategy: "LOWEST_COST_WITHOUT_CAP", targeting, promoted_object: { page_id: PAGE_ID }, status: "ACTIVE", ...(campaign.startDate && campaign.startDate !== "сразу после запуска" ? { start_time: campaign.startDate } : {}) };
      const adPlan = { video: t.creativeVideoUrl || null, caption: t.creativeCaption || "", thumb: t.creativeThumb || null, form: formId };
      if (dryRun) { log.push({ step: "adset+ad", audience: t.audience, willAdset: adsetBody, willAd: { video: adPlan.video ? "IG-видео" : "нет видео", form: formId ? "форма " + formId : "без формы", caption: (adPlan.caption || "").slice(0, 40) }, notes }); adsets.push({ audience: t.audience, notes }); continue; }
      const ar = await post(`${acct}/adsets`, adsetBody);
      if (!ar.id) { log.push({ step: "adset", ok: false, audience: t.audience, error: ar.error || ar }); adsets.push({ audience: t.audience, adError: "адсет не создан" }); continue; }
      const rec = { audience: t.audience, adsetId: ar.id, notes };
      if (!adPlan.video) { rec.adError = "у выбранного крео нет видео-URL (IG отдаёт media_url только для VIDEO) — объявление не создано"; log.push({ step: "ad", ok: false, audience: t.audience, error: rec.adError }); adsets.push(rec); continue; }
      try {
        const vid = await post(`${acct}/advideos`, { file_url: adPlan.video });
        if (!vid.id) { rec.adError = "видео не загрузилось: " + JSON.stringify(vid.error || vid).slice(0, 120); log.push({ step: "ad", ok: false, audience: t.audience, error: rec.adError }); adsets.push(rec); continue; }
        const cta = (objective === "OUTCOME_LEADS" && adPlan.form) ? { type: "SIGN_UP", value: { lead_gen_form_id: adPlan.form } } : { type: "LEARN_MORE", value: { link: "https://instagram.com/hunteracademy_uz" } };
        const storySpec = { page_id: PAGE_ID, instagram_actor_id: IG_ID, video_data: { video_id: vid.id, message: (adPlan.caption || "Hunter Academy").slice(0, 500), call_to_action: cta, ...(adPlan.thumb ? { image_url: adPlan.thumb } : {}) } };
        const cr = await post(`${acct}/adcreatives`, { name: `ALTRONE crea · ${t.audience}`.slice(0, 100), object_story_spec: storySpec });
        if (!cr.id) { rec.adError = "креатив не создан: " + JSON.stringify(cr.error || cr).slice(0, 150); log.push({ step: "ad", ok: false, audience: t.audience, error: rec.adError }); adsets.push(rec); continue; }
        const ad = await post(`${acct}/ads`, { name: `ALTRONE ad · ${t.audience}`.slice(0, 100), adset_id: ar.id, creative: { creative_id: cr.id }, status: "ACTIVE" });
        if (ad.id) { rec.adId = ad.id; adsMade++; log.push({ step: "ad", ok: true, audience: t.audience, id: ad.id }); }
        else { rec.adError = "объявление не создано: " + JSON.stringify(ad.error || ad).slice(0, 150); log.push({ step: "ad", ok: false, audience: t.audience, error: rec.adError }); }
      } catch (e) { rec.adError = String(e).slice(0, 150); log.push({ step: "ad", ok: false, audience: t.audience, error: rec.adError }); }
      adsets.push(rec);
    }
    // 3) ЗАПУСК: включаем кампанию (ACTIVE) ТОЛЬКО если хотя бы одно объявление реально легло. Иначе оставляем паузу (защита от слива).
    let launched = false;
    if (!dryRun && adsMade > 0 && campaignId) { const up = await post(`${campaignId}`, { status: "ACTIVE" }); launched = !up.error; log.push({ step: "launch", ok: launched, error: up.error || null }); }
    const managerLink = `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${AD_ACCOUNT}${campaignId ? `&selected_campaign_ids=${campaignId}` : ""}`;
    res.status(200).json({
      ok: true, dryRun, campaignId, adsets, adsMade, launched, log, managerLink,
      note: dryRun
        ? "СУХОЙ ПРОГОН: в Meta ничего не создано. Выше — что создам: кампания + адсеты + объявления (твоё IG-видео + форма). Подтверди — создам и запущу. Первый прогон нового кода — проверь результат и сразу глянь в Ads Manager."
        : (launched
          ? `🚀 ЗАПУЩЕНО В META. Объявлений создано: ${adsMade}. Открой Ads Manager и проверь бюджет/крео/аудиторию/форму. Если что-то не так — ставь на паузу прямо там.`
          : `Создано, но НЕ запущено (объявлений легло: ${adsMade}). Кампания на ПАУЗЕ — в логе выше ошибки Meta, пришли их мне, поправлю. Ничего не тратится.`),
    });
    return;
  }

  if (action === "plan") {
    const q = req.query || {}, bd = req.body || {};
    const currency = (String(q.currency || bd.currency || "UZS").toUpperCase() === "USD") ? "USD" : "UZS";
    const rateUZS = currency === "USD" ? 12100 : 1; // в сумы (прогноз лидов считается в сумах, CPL — в сумах)
    const budget = Math.max(0, Number(q.budget || bd.budget || 0)); // в выбранной валюте
    if (!budget) { res.status(400).json({ ok: false, error: "укажите бюджет" }); return; }
    // ЦЕЛЬ, ДАТА ЗАПУСКА, ФОРМА
    const objId = String(q.objective || bd.objective || "leads");
    const objective = OBJECTIVES.find((o) => o.id === objId) || OBJECTIVES[0];
    const startDate = String(q.startDate || bd.startDate || "").slice(0, 10) || null; // YYYY-MM-DD; пусто = сразу
    const endDate = String(q.endDate || bd.endDate || "").slice(0, 10) || null;
    const formId = (q.form || bd.form || q.formId || bd.formId || null);
    const budgetType = (String(q.budgetType || bd.budgetType || "daily") === "lifetime") ? "lifetime" : "daily";
    const perDay = budgetType === "daily";
    const campaign = {
      objective: objective.id, objectiveLabel: objective.label, objectiveMeta: objective.meta,
      startDate: startDate || "сразу после запуска",
      endDate: budgetType === "lifetime" ? (endDate || null) : null,
      budgetType, budgetLabel: perDay ? "в день" : "на весь период",
      form: objective.needsForm ? (formId || null) : null,
      perDay,
      warnings: [
        ...(objective.needsPixel ? ["Цель «Продажи» без пикселя работает слабо — сначала подключим Conversions API из amoCRM."] : []),
        ...(objective.needsForm && !formId ? ["Для цели «Лиды» нужно выбрать лид-форму — иначе заявки некуда собирать."] : []),
        ...(budgetType === "lifetime" && !endDate ? ["Для общего бюджета на период укажи дату окончания — иначе Meta не знает, на сколько дней растянуть."] : []),
      ],
    };
    // ⚠️ СТАРАЯ КАМПАНИЯ УЖЕ РАБОТАЕТ + лиды дорожают (усталость связок: было $0.2 → $0.4 → $0.6).
    // Задача ALTRONE — ТЕСТИРОВАТЬ НОВОЕ, НЕ дублировать работающие аудитории (иначе конкуренция сам с собой).
    // Понятия «дорого» нет — сравниваем и ищем СЛЕДУЮЩИЙ дешёвый источник, пока текущие связки выдыхаются.
    const rnd = (x) => currency === "USD" ? Math.round(x * 100) / 100 : Math.round(x);
    const knownCpl = auds.filter((a) => a.cpl);
    const avgCpl = knownCpl.length ? Math.round(knownCpl.reduce((s, a) => s + a.cpl, 0) / knownCpl.length) : null;
    // «уже крутится» — текущая кампания; её аудитории НЕ дублируем
    const running = auds.filter((a) => a.spend > 0 || a.leads > 0).map((a) => ({ name: a.name, roas: a.roas, cpl: a.cpl, sold: a.sold })).sort((x, y) => (y.roas || 0) - (x.roas || 0));
    const best = running.find((a) => a.roas != null && a.sold > 0) || running[0] || null;
    const bestCpl = (best && best.cpl) || avgCpl;
    // НОВЫЕ тест-связки на основе АУДИТА ИЗНУТРИ: победители — ШИРОКИЕ (18-65, без интересов, авто-плейсменты) →
    // работает КРЕО, а не узкий таргет. Тестируем: свежее крео на широкой (рычаг) + новые сигналы (lookalike из amoCRM) + узкий контроль.
    const geoDefault = "Узбекистан";
    const tests = [
      { audience: "Широкая + свежий креатив", type: "broad", isTest: true,
        hypothesis: "у тебя побеждают ШИРОКИЕ связки — рычаг это крео. Тест НОВОГО видео на выигрышной широкой.",
        targeting: { "возраст": "18-65", "пол": "все", "гео": geoDefault, "интересы": "нет (широкая)", "плейсменты": "авто (Advantage+)" } },
      { audience: "Lookalike 1% · покупатели amoCRM", type: "lookalike", isTest: true,
        hypothesis: "новый сигнал, которого у тебя ещё НЕТ: похожие на реальных покупателей из CRM.",
        targeting: { "возраст": "18-65", "пол": "все", "гео": geoDefault, "аудитория": "Lookalike 1% (покупатели amoCRM)", "плейсменты": "авто" } },
      ...(best ? [{ audience: "Lookalike · лиды победителя", type: "lookalike", isTest: true,
        hypothesis: `похожие на лиды лучшей связки (${best.name}${best.roas != null ? `, ROAS ${best.roas}x` : ""}).`,
        targeting: { "возраст": "18-65", "пол": "все", "гео": geoDefault, "аудитория": `Lookalike (лиды ${best.name})`, "плейсменты": "авто" } }] : []),
      { audience: "Узкий · интересы (контроль)", type: "interest", isTest: true, interestQueries: ["Sales", "Business", "Entrepreneurship"],
        hypothesis: "проверка: бьёт ли узкий таргет по интересам твою широкую? (сейчас таких у тебя нет).",
        targeting: { "возраст": "18-35", "пол": "все", "гео": "Ташкент", "интересы": "Продажи, Бизнес, Предпринимательство", "плейсменты": "авто" } },
    ];
    // бюджет РАВНОМЕРНО по тестам (тест малым, масштаб победителя потом)
    const per = rnd(budget / tests.length);
    tests.forEach((t) => { t.budget = per; t.cpl = bestCpl; });
    if (tests.length) tests[0].budget = rnd(tests[0].budget + (budget - tests.reduce((s, t) => s + t.budget, 0)));
    // КРЕАТИВЫ: выбранные владельцем (иначе свежие — против усталости крео), своё видео на каждый тест
    let selIds = bd.creatives || q.creatives || null;
    if (typeof selIds === "string") selIds = selIds.split(",").map((x) => x.trim()).filter(Boolean);
    const selected = (Array.isArray(selIds) && selIds.length) ? posts.filter((p) => selIds.includes(p.id)) : [];
    const creaPool = selected.length ? selected : [...posts].sort((a, b) => b.engagement - a.engagement);
    const topCre = creaPool.slice(0, Math.max(tests.length, 1));
    tests.forEach((t, i) => { const c = topCre.length ? topCre[i % topCre.length] : null; t.creative = c ? (c.caption || `IG-пост #${i + 1}`) : "— (нет постов)"; t.creativeId = c ? c.id : null; t.creativeVideoUrl = c ? c.videoUrl : null; t.creativeThumb = c ? c.thumb : null; t.creativeCaption = c ? (c.caption || "") : ""; t.creativeType = c ? c.type : null; });
    // прогноз — гипотеза по текущей средней цене лида (новые связки могут дать дешевле ИЛИ дороже — на то и тест)
    const expectedLeads = bestCpl ? tests.reduce((s, t) => s + Math.round((t.budget * rateUZS) / bestCpl), 0) : null;
    res.status(200).json({
      ok: true, budget, currency, campaign, split: tests, running, expectedLeads, avgCpl, creativesAvailable: posts.length,
      rationale: { basis: "ТЕСТ новых связок аудитория×крео на данных amoCRM; работающая кампания не дублируется", running: running.length },
      note: "ПЛАН ТЕСТА (Стадия 1): в Meta ничего не создано. ALTRONE предлагает НОВЫЕ аудитории (lookalike из покупателей + расширения + широкая) со свежими крео — чтобы найти следующий дешёвый источник, пока текущие связки дорожают. Работающую кампанию не дублирует. Бюджет — потолок; тест малым → масштаб победителя.",
    });
    return;
  }
  res.status(200).json({ ok: false, error: "unknown action" });
}
