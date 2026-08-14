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
const BUSINESS_ID = process.env.META_BUSINESS_ID || "895505843209419"; // Hunter — бизнес (для страниц/форм)

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
      for (const m of ((d && d.data) || [])) out.push({ id: m.id, caption: (m.caption || "").replace(/\s+/g, " ").trim().slice(0, 80), type: m.media_type, permalink: m.permalink || null, engagement: (m.like_count || 0) + (m.comments_count || 0), thumb: m.thumbnail_url || m.media_url || null });
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

  if (action === "inputs") {
    const lf = await fetchLeadForms();
    res.status(200).json({ ok: true, audiences: auds, creatives: posts, currency: "UZS", objectives: OBJECTIVES, forms: lf.forms, formsError: lf.error, hasPixel: false });
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
    // НОВЫЕ тест-связки (гипотезы, ещё без ROAS) — на данных, НЕ повтор существующих
    const tests = [];
    tests.push({ audience: "Lookalike 1% · покупатели amoCRM", type: "lookalike", isTest: true, hypothesis: "похожие на твоих реальных покупателей из CRM — сильнейший сигнал без пикселя" });
    if (best) tests.push({ audience: `Lookalike · лиды «${best.name}»`, type: "lookalike", isTest: true, hypothesis: `похожие на лиды лучшей аудитории${best.roas != null ? ` (ROAS ${best.roas}x)` : ""}` });
    if (best) tests.push({ audience: `«${best.name}» — расширение`, type: "broaden", isTest: true, hypothesis: "шире гео/возраст от победителя — тянется ли результат" });
    tests.push({ audience: "Широкая · Advantage+ (алгоритм Meta)", type: "broad", isTest: true, hypothesis: "Meta сам ищет аудиторию — контрольная связка теста" });
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
    tests.forEach((t, i) => { t.creative = topCre.length ? (topCre[i % topCre.length].caption || `IG-пост #${i + 1}`) : "— (нет постов)"; });
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
