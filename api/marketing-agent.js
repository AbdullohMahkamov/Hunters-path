// /api/marketing-agent.js — «АГЕНТ-МАРКЕТОЛОГ».
// Непрерывно сводит ВСЕ маркетинговые цифры проекта в одну всегда-актуальную картину и раз в сутки
// шлёт владельцу короткий срез. Это НЕ growth-agent (тот ищет ГИПОТЕЗЫ роста по воронке продаж) —
// здесь отдельная зона ответственности: маркетинговые юнит-метрики (CAC/ROAS), динамика реклам и
// органический Instagram. Свою картину (marketingagent:snapshot) агент отдаёт как ДОП. срез, которым
// потом смогут питаться growth-agent и meta-brain (они читают ключ Redis — цикла импортов не создаём).
//
// ГРАНИЦЫ (жёсткие, по образцу growth-agent.js / meta-brain.js):
//  МОЖЕТ: читать кэш meta-ads (ключ meta_spend, read-only), Instagram Insights (read-only через Graph API),
//         verified-воронку Dev-Agent (getVerifiedFunnel — с уважением к trust: verified/suspicious/insufficient).
//  НЕ МОЖЕТ: менять бюджеты, запускать/останавливать кампании, писать что-либо в CRM, отправлять
//         сообщения кому-либо КРОМЕ одноразового ежедневного дайджеста ВЛАДЕЛЬЦУ (sendTg("owner", ...)
//         тем же путём, что meta-brain: только owner, только по расписанию, НИКОГДА не РОПу/агентам).
//
// ЧЕСТНОСТЬ (та же дисциплина, что в growth-agent для verified-переходов): если выручка или adspend
// отсутствует / не verified — метрику НЕ считаем, а явно пишем «не диагностируется: <какой кусок недостаёт>».
//
// ИМПОРТЫ: getVerifiedFunnel из dev-agent (готовая verified-функция) и sendTg/getPeople из tg-bot.
// meta-ads.js НЕ импортируем — у него default-хендлер, а не именованные функции; его результат читаем
// СЫРЫМ ключом Redis `meta_spend` (кэш, который meta-ads.js кладёт по своему cron/ручному прогону).

import { getVerifiedFunnel } from "./dev-agent.js";
import { sendTg, getPeople } from "./tg-bot.js";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;
const META_TOKEN = process.env.META_TOKEN;              // System User token (тот же, что у meta-ads.js)
const IG_USER_ID = process.env.META_IG_USER_ID;         // НОВОЕ: id бизнес-аккаунта Instagram (IG User id)
const ORG = "hunter";
const GRAPH_VERSION = "v21.0";
const IG_TTL_HOURS = 3;                                 // не дёргаем Instagram чаще раза в 3 часа (Insights обновляются небыстро)
const IG_CACHE_EX = 6 * 3600;                           // сам кэш живёт до 6 часов
const REVENUE_CCY = "UZS";                              // валюта выручки из CRM (по контракту docs/hunter-ai-integration-spec.md)
const USD_UZS_RATE = Number(process.env.USD_UZS_RATE) || 12100; // явный проверяемый курс (в проекте mop.js использует 12000; здесь по указанию владельца — 12100)

// helper-функции Redis — 1:1 из meta-brain.js (не изобретаем заново)
async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function rsetJSONex(key, v, ttlSec) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}?EX=${ttlSec}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }

const K = { snapshot: "marketingagent:snapshot", instagram: "marketingagent:instagram", history: "marketingagent:history", lastrun: "marketingagent:lastrun" };

// день по ташкентскому времени (UTC+5) — как tkDay в meta-brain
function tkDay() { return new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10); }
function ageHours(iso) { if (!iso) return Infinity; const t = Date.parse(iso); return isFinite(t) ? (Date.now() - t) / 3600000 : Infinity; }
function r2(x) { return x == null ? null : +Number(x).toFixed(2); }
function shortT(s, n) { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }
function daysBetween(a, b) { return Math.round((Date.parse(a) - Date.parse(b)) / 86400000); }
function fmtMoney(v) { return v == null ? "н/д" : Number(v).toLocaleString("ru-RU"); }
function fmtPct(v) { return v == null ? "н/д" : (v > 0 ? "+" : "") + v + "%"; }

// ─────────────────────────────────────────────────────────────────────────────
// БЛОК 1. META ADS — производные метрики поверх кэша meta_spend
// meta-ads.js кладёт { updatedAt, period, adsets:[{ name, spend, impressions, clicks }] }.
// Добавляем то, чего в кэше нет: CTR = clicks/impressions, CPC = spend/clicks, CPM = spend/impressions*1000.
// ─────────────────────────────────────────────────────────────────────────────
function deriveAds(cache) {
  if (!cache || !Array.isArray(cache.adsets) || cache.adsets.length === 0) {
    return { available: false, reason: "кэш meta_spend пуст — запусти /api/meta-ads?action=get (или дождись его cron)", adsets: [], total: null, currency: cache && cache.currency || null, updatedAt: cache && cache.updatedAt || null };
  }
  const adsets = cache.adsets.map((a) => {
    const spend = a.spend || 0, impr = a.impressions || 0, clicks = a.clicks || 0;
    return {
      name: a.name, spend, impressions: impr, clicks,
      ctr: impr > 0 ? r2(clicks / impr * 100) : null,   // %
      cpc: clicks > 0 ? r2(spend / clicks) : null,       // валюта за клик
      cpm: impr > 0 ? r2(spend / impr * 1000) : null,    // валюта за 1000 показов
    };
  });
  const tSpend = adsets.reduce((s, a) => s + (a.spend || 0), 0);
  const tImpr = adsets.reduce((s, a) => s + (a.impressions || 0), 0);
  const tClicks = adsets.reduce((s, a) => s + (a.clicks || 0), 0);
  const total = {
    spend: tSpend, impressions: tImpr, clicks: tClicks,
    ctr: tImpr > 0 ? r2(tClicks / tImpr * 100) : null,
    cpc: tClicks > 0 ? r2(tSpend / tClicks) : null,
    cpm: tImpr > 0 ? r2(tSpend / tImpr * 1000) : null,
  };
  return { available: true, period: cache.period || null, currency: cache.currency || null, updatedAt: cache.updatedAt || null, adsets, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// БЛОК 2. INSTAGRAM organic — через тот же META_TOKEN (System User) и Graph API v21.0.
// ВНИМАНИЕ: этот блок работает ТОЛЬКО если у токена есть права instagram_basic + instagram_manage_insights.
// Сейчас их НЕТ — поэтому блок аккуратно возвращает понятную ошибку, а НЕ падает (см. runMarketingDaily).
// ─────────────────────────────────────────────────────────────────────────────
async function graph(path, params) {
  const qs = new URLSearchParams({ ...params, access_token: META_TOKEN }).toString();
  try {
    const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}?${qs}`);
    const d = await r.json();
    if (!r.ok || (d && d.error)) return { ok: false, error: (d && d.error && d.error.message) || `HTTP ${r.status}` };
    return { ok: true, data: d };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Тянет свежий срез Instagram. Каждый под-запрос обёрнут: сбой одного не рушит остальные,
// все ошибки собираем в errors[] — чтобы по action=peek было видно, чего именно не хватает токену.
async function fetchInstagramFresh() {
  if (!META_TOKEN) return { ok: false, error: "META_TOKEN не задан", errors: [] };
  if (!IG_USER_ID) return { ok: false, error: "META_IG_USER_ID не задан (id бизнес-аккаунта Instagram)", errors: [] };

  const out = { ok: true, updatedAt: new Date().toISOString(), followers_count: null, media_count: null, reach: null, profile_views: null, media: [], rawInsights: null, errors: [] };

  // 2.1 followers_count / media_count — это ПОЛЯ узла IG User (не insights-метрики)
  const uf = await graph(`${IG_USER_ID}`, { fields: "followers_count,media_count" });
  if (uf.ok) { out.followers_count = uf.data.followers_count != null ? uf.data.followers_count : null; out.media_count = uf.data.media_count != null ? uf.data.media_count : null; }
  else out.errors.push("user_fields: " + uf.error);

  // 2.2 reach / profile_views — insights-метрики аккаунта. В Graph v21+ им нужны ЯВНЫЕ параметры:
  // period=day + окно since/until + metric_type=total_value (иначе Meta часто отдаёт пустой data[] или ошибку).
  const until = Math.floor(Date.now() / 1000), since = until - 7 * 86400; // последние 7 дней
  let ins = await graph(`${IG_USER_ID}/insights`, { metric: "reach,profile_views", period: "day", metric_type: "total_value", since: String(since), until: String(until) });
  if (!ins.ok) {
    // fallback: старая форма без metric_type (некоторые метрики отдаются рядом values[])
    const alt = await graph(`${IG_USER_ID}/insights`, { metric: "reach,profile_views", period: "day", since: String(since), until: String(until) });
    out.rawInsights = { primaryError: ins.error, fallback: alt.ok ? alt.data : { error: alt.error } };
    ins = alt;
  } else {
    out.rawInsights = ins.data;
  }
  if (ins.ok && Array.isArray(ins.data.data)) {
    for (const m of ins.data.data) {
      // v21+ отдаёт агрегат в total_value.value; старая форма — в values[последний].value
      let v = null;
      if (m.total_value && m.total_value.value != null) v = m.total_value.value;
      else if (Array.isArray(m.values) && m.values.length) v = m.values[m.values.length - 1].value;
      if (m.name === "reach") out.reach = v;
      if (m.name === "profile_views") out.profile_views = v;
    }
  } else out.errors.push("insights: " + (ins.error || "нет data"));

  // 2.3 последние посты + их engagement (likes + comments)
  const md = await graph(`${IG_USER_ID}/media`, { fields: "id,caption,like_count,comments_count,timestamp", limit: "10" });
  if (md.ok && Array.isArray(md.data.data)) {
    out.media = md.data.data.map((p) => ({
      id: p.id, caption: shortT(p.caption, 60), timestamp: p.timestamp || null,
      likes: p.like_count != null ? p.like_count : null, comments: p.comments_count != null ? p.comments_count : null,
      engagement: (p.like_count || 0) + (p.comments_count || 0),
    }));
  } else out.errors.push("media: " + (md.error || "нет data"));

  // если даже followers не пришли — считаем блок недоступным и даём понятную причину (обычно = нет прав у токена)
  if (out.followers_count == null && out.errors.length) {
    out.ok = false;
    out.error = "Instagram недоступен — вероятно у META_TOKEN нет прав instagram_basic + instagram_manage_insights, либо IG-аккаунт не привязан к System User. Детали: " + out.errors.join(" | ");
  }
  return out;
}

// Кэш-обёртка: не дёргаем Graph чаще раза в IG_TTL_HOURS. force=1 — принудительно свежий.
async function getInstagram(force) {
  const cached = await rgetJSON(K.instagram, null);
  if (!force && cached && cached.updatedAt && ageHours(cached.updatedAt) < IG_TTL_HOURS) return { ...cached, fromCache: true };
  const fresh = await fetchInstagramFresh();
  await rsetJSONex(K.instagram, fresh, IG_CACHE_EX); // кэшируем и успех, и ошибку — чтобы не долбить API
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────────────
// БЛОК 3. Продажи/CRM — ТОЛЬКО через getVerifiedFunnel (не считаем сами из сырых данных).
// Клиентом-«оплатившим» считаем ВЫИГРАННУЮ сделку (Sotildi): в amoCRM клиента нет отдельного статуса
// «оплачено» (это прямо отмечено в самой воронке Dev-Agent), поэтому берём verified-этап сделки.
// ─────────────────────────────────────────────────────────────────────────────
function funnelFacts(funnel) {
  if (!funnel) return { revenue: null, customers: null, trust: "insufficient", period: null, telephonySuspicious: null, dataFresh: null };
  const deal = (funnel.stages || []).find((s) => /Сделка выиграна/.test(s.stage)) || null;
  return {
    revenue: deal ? deal.money : null,
    customers: deal ? deal.value : null,      // выигранные сделки (= прокси оплативших клиентов)
    trust: deal ? deal.trust : "insufficient",
    period: funnel.period || null,
    telephonySuspicious: funnel.telephonySuspicious,
    dataFresh: funnel.dataFresh,
  };
}

// ── СОГЛАСОВАННОСТЬ ПЕРИОДОВ (критично для CAC/ROAS) ─────────────────────────
// Числитель (adspend из meta_spend) и знаменатель (sold/revenue из воронки) ДОЛЖНЫ быть за ОДНО окно.
// Оба модуля считают «текущий календарный месяц (с 1-го по сегодня)»: meta-ads — по своему time_range,
// dash.totals — sold/revenue за месяц (проверено в sync.js). Но окна могут ТИХО разъехаться, если:
//   • кэш meta_spend устарел и лежит за ПРОШЛЫЙ месяц (period='YYYY-06-01..YYYY-06-30', а сейчас июль);
//   • дашборд воронки не свежий (dataFresh=false) → его «текущий месяц» = когда в последний раз шёл sync;
//   • граница TZ: meta-ads считает месяц по UTC, воронка — по Ташкенту (UTC+5).
// Поэтому целевое окно фиксируем явно и СВЕРЯЕМ; если не сходится — обе метрики в «не диагностируется».
function monthKeyTZ() { return new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 7); } // YYYY-MM (Ташкент)
function adsMonthOf(cache) {
  // строка period кэша meta-ads: "YYYY-MM-DD..YYYY-MM-DD". Окно валидно только если оба конца в одном месяце.
  const m = cache && cache.period && String(cache.period).match(/^(\d{4})-(\d{2})-\d{2}\.\.(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const sinceM = `${m[1]}-${m[2]}`, untilM = `${m[3]}-${m[4]}`;
  return sinceM === untilM ? sinceM : null;
}
function assessPeriodAlignment(ads, ff) {
  const target = monthKeyTZ();
  if (!ads.available) return { aligned: false, target, reason: "нет кэша расходов (meta_spend пуст)" };
  const adsMonth = adsMonthOf(ads);
  if (!adsMonth) return { aligned: false, target, reason: `не распознаю период кэша meta_spend (${ads.period || "нет"})` };
  if (adsMonth !== target) return { aligned: false, target, adsMonth, reason: `реклама за ${adsMonth}, а продажи — за текущий месяц ${target}: разные периоды (устаревший кэш meta_spend?)` };
  if (ads.updatedAt && ageHours(ads.updatedAt) > 48) return { aligned: false, target, adsMonth, reason: `кэш meta_spend устарел (${Math.round(ageHours(ads.updatedAt))} ч) — adspend за месяц неполон/несопоставим` };
  if (ff.dataFresh === false) return { aligned: false, target, adsMonth, reason: "дашборд воронки устарел (>48 ч) — «текущий месяц» продаж может относиться к другому окну" };
  return { aligned: true, target, adsMonth, month: target };
}

// ── СОГЛАСОВАННОСТЬ ВАЛЮТ (критично для CAC/ROAS — та же ловушка, что и с периодами) ─────────────
// revenue приходит из CRM в UZS (контракт docs/hunter-ai-integration-spec.md). spend приходит из Meta
// в валюте рекламного аккаунта (её кладёт meta-ads.js в кэш meta_spend.currency). ROAS = revenue/spend
// без конверсии = деление РАЗНЫХ валют → молча неверное число (то самое 300 000x вместо ~25x).
// Правило: считаем ТОЛЬКО если обе стороны приведены к UZS по явному проверяемому курсу; иначе —
// «не диагностируется». Возвращаем spend, приведённый к UZS (spendUZS), которым и считаются метрики.
function assessCurrencyAlignment(ads) {
  const raw = ads.available && ads.total ? ads.total.spend : null;
  if (raw == null) return { aligned: false, adCurrency: null, reason: "нет расходов (кэш meta_spend пуст)" };
  const cur = (ads.currency || "").toUpperCase();
  if (!cur) return { aligned: false, adCurrency: null, spendRaw: raw, reason: "валюта рекламного аккаунта неизвестна (в кэше meta_spend нет currency — обнови /api/meta-ads?action=refresh)" };
  if (cur === REVENUE_CCY) return { aligned: true, adCurrency: cur, rate: 1, spendRaw: raw, spendUZS: raw, note: `валюта аккаунта = ${REVENUE_CCY}, конверсия не нужна` };
  if (cur === "USD") return { aligned: true, adCurrency: "USD", rate: USD_UZS_RATE, spendRaw: raw, spendUZS: Math.round(raw * USD_UZS_RATE), note: `USD→UZS по курсу ${USD_UZS_RATE}` };
  // другая валюта, курса нет — НЕ считаем числом
  return { aligned: false, adCurrency: cur, spendRaw: raw, reason: `revenue в ${REVENUE_CCY}, adspend в ${cur}, курс конвертации не задан` };
}

// CAC и ROAS с дисциплиной «не диагностируется» (то же правило, что growth-agent применяет к переходам).
// ВАЖНО: сначала два гейта — период (окна сошлись?) и валюта (приведены к одной?), потом наличие/trust.
// Если окна ИЛИ валюты разъехались — метрика НЕ выдаётся числом, даже когда оба куска формально есть.
// Считаем на spendUZS (adspend, приведённый к UZS), чтобы обе метрики были в одной валюте с выручкой.
function computeUnitEconomics(ads, ff, period, currency) {
  const rawSpend = ads.available && ads.total ? ads.total.spend : null;
  const spendUZS = currency.aligned ? currency.spendUZS : null;
  const gate = (dataOk, dataReason, compute) => {
    if (!rawSpend) return { undiagnosable: "нет расходов на рекламу (кэш meta_spend пуст или spend=0)" };
    if (!period.aligned) return { undiagnosable: `adspend и данные продаж за разные периоды — ${period.reason}` };
    if (!currency.aligned) return { undiagnosable: `adspend и выручка в разных валютах — ${currency.reason}` };
    if (!dataOk) return { undiagnosable: dataReason };
    return compute();
  };
  const cac = gate(
    ff.customers != null && ff.trust === "verified",
    `число клиентов не verified (trust=${ff.trust}) — считаем по выигранным сделкам, они сейчас недоступны/ненадёжны`,
    () => ({ value: Math.round(spendUZS / ff.customers), currency: REVENUE_CCY, spendUZS, spendRaw: currency.spendRaw, adCurrency: currency.adCurrency, rate: currency.rate, customers: ff.customers, period: period.month, note: "клиент = выигранная сделка (Sotildi); adspend приведён к UZS, окно — текущий месяц" })
  );
  const roas = gate(
    ff.revenue != null && ff.trust === "verified",
    `выручка не verified (trust=${ff.trust})`,
    () => ({ value: r2(ff.revenue / spendUZS), revenue: ff.revenue, spendUZS, spendRaw: currency.spendRaw, adCurrency: currency.adCurrency, rate: currency.rate, period: period.month })
  );
  return { cac, roas };
}

// ─────────────────────────────────────────────────────────────────────────────
// БЛОК 4. Динамика неделя-к-неделе — сравнение с точкой истории ~7 дней назад.
// ─────────────────────────────────────────────────────────────────────────────
function historyPoint(snap) {
  const adsetsMap = {};
  if (snap.ads.available) for (const a of snap.ads.adsets) adsetsMap[a.name] = { spend: a.spend, ctr: a.ctr };
  return {
    day: snap.day, generatedAt: snap.generatedAt,
    followers: snap.instagram && snap.instagram.ok ? snap.instagram.followers_count : null,
    totalSpend: snap.ads.available ? snap.ads.total.spend : null,
    accountCtr: snap.ads.available ? snap.ads.total.ctr : null,
    cac: (snap.unit.cac && snap.unit.cac.value != null) ? snap.unit.cac.value : null,
    roas: (snap.unit.roas && snap.unit.roas.value != null) ? snap.unit.roas.value : null,
    adsets: adsetsMap,
  };
}
// точка «неделю назад»: ближайшая запись, которой 6..9 дней (окно, чтобы не промахнуться на пропущенном дне)
function find7dAgo(history, today) {
  const cand = (history || []).filter((h) => { const d = daysBetween(today, h.day); return d >= 6 && d <= 9; });
  if (!cand.length) return null;
  cand.sort((a, b) => Math.abs(daysBetween(today, a.day) - 7) - Math.abs(daysBetween(today, b.day) - 7));
  return cand[0];
}
function pctChange(now, then) { if (now == null || then == null || then === 0) return null; return r2((now - then) / Math.abs(then) * 100); }

function computeDynamics(snap, prev) {
  const dyn = { comparedTo: prev ? prev.day : null, adsets: [], followers: null, cac: null, roas: null };
  if (!prev) return dyn;
  // по каждому adset: изменение spend и CTR (неделя к неделе)
  if (snap.ads.available) {
    for (const a of snap.ads.adsets) {
      const p = prev.adsets && prev.adsets[a.name];
      if (!p) { dyn.adsets.push({ name: a.name, isNew: true }); continue; }
      dyn.adsets.push({ name: a.name, spendDelta: a.spend - (p.spend || 0), spendPct: pctChange(a.spend, p.spend), ctrDelta: (a.ctr != null && p.ctr != null) ? r2(a.ctr - p.ctr) : null });
    }
  }
  const fNow = snap.instagram && snap.instagram.ok ? snap.instagram.followers_count : null;
  if (fNow != null && prev.followers != null) dyn.followers = { abs: fNow - prev.followers, pct: pctChange(fNow, prev.followers) };
  if (snap.unit.cac.value != null && prev.cac != null) dyn.cac = { abs: snap.unit.cac.value - prev.cac, pct: pctChange(snap.unit.cac.value, prev.cac) };
  if (snap.unit.roas.value != null && prev.roas != null) dyn.roas = { abs: r2(snap.unit.roas.value - prev.roas), pct: pctChange(snap.unit.roas.value, prev.roas) };
  return dyn;
}

// ─────────────────────────────────────────────────────────────────────────────
// БЛОК 5. Ежедневный дайджест владельцу — короткий, на русском, без сырого JSON (4-6 строк).
// Детерминированный (без LLM): точнее держит правило «не диагностируется» и не выдумывает трендов.
// ─────────────────────────────────────────────────────────────────────────────
function buildDigest(snap) {
  const L = ["📈 <b>Altrone — маркетинговый срез за сутки</b>"];
  const undiag = []; // сюда собираем явные «не диагностируется»
  const dyn = snap.dynamics || {};

  // (0) Реальная трата на рекламу по цифрам Meta: raw в валюте аккаунта + приведение к UZS
  const cy = snap.currency || {};
  if (snap.ads.available && cy.spendRaw != null) {
    if (cy.adCurrency === "USD" && cy.spendUZS != null) L.push(`• Реклама по Meta: $${fmtMoney(cy.spendRaw)} ≈ <b>${fmtMoney(cy.spendUZS)} сум</b> (курс ${cy.rate}).`);
    else if (cy.adCurrency === REVENUE_CCY) L.push(`• Реклама по Meta: <b>${fmtMoney(cy.spendRaw)} сум</b>.`);
    else L.push(`• Реклама по Meta: ${fmtMoney(cy.spendRaw)} ${cy.adCurrency || "?"} (в сум не привёл — ${cy.reason || "нет курса"}).`);
  }

  // (1) Главная метрика недели: CAC или ROAS — что сильнее изменилось WoW
  const cac = snap.unit.cac, roas = snap.unit.roas;
  const cacMove = dyn.cac && dyn.cac.pct != null ? Math.abs(dyn.cac.pct) : -1;
  const roasMove = dyn.roas && dyn.roas.pct != null ? Math.abs(dyn.roas.pct) : -1;
  if (cacMove < 0 && roasMove < 0) {
    // нет WoW-сравнения — показываем абсолютные, если посчитались
    if (cac.value != null) L.push(`• CAC: <b>${fmtMoney(cac.value)} сум</b> за клиента (${cac.customers} сделок / реклама ${fmtMoney(cac.spendUZS)} сум). Динамики нет — нужна неделя истории.`);
    else undiag.push(`CAC — ${cac.undiagnosable}`);
    if (roas.value != null) L.push(`• ROAS: <b>${roas.value}×</b> (выручка ${fmtMoney(roas.revenue)} / реклама ${fmtMoney(roas.spendUZS)} сум).`);
    else undiag.push(`ROAS — ${roas.undiagnosable}`);
  } else if (cacMove >= roasMove) {
    const dir = dyn.cac.abs > 0 ? "вырос (хуже)" : "снизился (лучше)";
    L.push(`• Главное за неделю — <b>CAC ${dir}</b>: ${fmtMoney(cac.value)} за клиента, ${fmtPct(dyn.cac.pct)} к прошлой неделе.`);
    if (roas.value != null && dyn.roas) L.push(`• ROAS: ${roas.value}× (${fmtPct(dyn.roas.pct)} WoW).`);
    else if (roas.value != null) L.push(`• ROAS: ${roas.value}×.`);
    else undiag.push(`ROAS — ${roas.undiagnosable}`);
  } else {
    const dir = dyn.roas.abs > 0 ? "вырос (лучше)" : "снизился (хуже)";
    L.push(`• Главное за неделю — <b>ROAS ${dir}</b>: ${roas.value}×, ${fmtPct(dyn.roas.pct)} к прошлой неделе.`);
    if (cac.value != null && dyn.cac) L.push(`• CAC: ${fmtMoney(cac.value)} за клиента (${fmtPct(dyn.cac.pct)} WoW).`);
    else if (cac.value != null) L.push(`• CAC: ${fmtMoney(cac.value)} за клиента.`);
    else undiag.push(`CAC — ${cac.undiagnosable}`);
  }

  // (2) Просадка по CTR / всплеск спенда: худший adset по падению CTR (или, если нет WoW, самый дорогой по CPC)
  if (snap.ads.available) {
    const withWow = (dyn.adsets || []).filter((a) => a.ctrDelta != null);
    if (withWow.length) {
      const worst = withWow.slice().sort((a, b) => a.ctrDelta - b.ctrDelta)[0];
      if (worst && worst.ctrDelta < 0) L.push(`• Просадка CTR: «${worst.name}» ${worst.ctrDelta}п.п. к неделе назад${worst.spendPct != null ? `, спенд ${fmtPct(worst.spendPct)}` : ""}.`);
      else L.push(`• Реклама: заметных просадок CTR по аудиториям неделя-к-неделе нет.`);
    } else {
      // нет истории — показываем текущий худший по CPC как ориентир
      const byCpc = snap.ads.adsets.filter((a) => a.cpc != null).sort((a, b) => b.cpc - a.cpc)[0];
      if (byCpc) L.push(`• Реклама (без WoW пока): дороже всех клик у «${byCpc.name}» — CPC ${fmtMoney(byCpc.cpc)}, CTR ${byCpc.ctr != null ? byCpc.ctr + "%" : "н/д"}.`);
    }
  } else {
    undiag.push(`реклама — ${snap.ads.reason}`);
  }

  // (3) Instagram: рост/падение подписчиков WoW
  if (snap.instagram && snap.instagram.ok) {
    if (dyn.followers) L.push(`• Instagram: подписчиков ${fmtMoney(snap.instagram.followers_count)} (${dyn.followers.abs > 0 ? "+" : ""}${dyn.followers.abs} за неделю, ${fmtPct(dyn.followers.pct)}).`);
    else L.push(`• Instagram: подписчиков ${fmtMoney(snap.instagram.followers_count)} (динамика — со следующей недели).`);
  } else {
    undiag.push(`Instagram — ${(snap.instagram && snap.instagram.error) || "недоступен"}`);
  }

  // (4) Явные «не диагностируется»
  if (undiag.length) { L.push("⚠️ <b>Не диагностируется:</b>"); for (const u of undiag) L.push(`  – ${u}`); }
  return L.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// ГЛАВНЫЙ ПРОГОН (cron раз в сутки утром, после свежего sync/sync-speed → воронка актуальна)
// ─────────────────────────────────────────────────────────────────────────────
export async function runMarketingDaily(org = ORG, force = false) {
  const [adsCache, ig, funnel] = await Promise.all([
    rgetJSON("meta_spend", null),
    getInstagram(force),
    getVerifiedFunnel(org).catch(() => null),
  ]);
  const ads = deriveAds(adsCache);
  const ff = funnelFacts(funnel);
  const period = assessPeriodAlignment(ads, ff);      // окна adspend и продаж сходятся?
  const currency = assessCurrencyAlignment(ads);      // валюты приведены к одной (UZS)?
  const unit = computeUnitEconomics(ads, ff, period, currency);

  const day = tkDay();
  const snap = { org, day, generatedAt: new Date().toISOString(), ads, instagram: ig, funnel: ff, period, currency, unit };

  // WoW: подтягиваем историю, находим точку ~7 дней назад, считаем динамику
  const history = await rgetJSON(K.history, []);
  snap.dynamics = computeDynamics(snap, find7dAgo(history, day));

  // сохраняем полный снапшот + компактную точку в историю (кап 30)
  await rsetJSON(K.snapshot, snap);
  const newHist = [...(Array.isArray(history) ? history.filter((h) => h.day !== day) : []), historyPoint(snap)].slice(-30);
  await rsetJSON(K.history, newHist);

  // дайджест владельцу — раз в сутки (адресат ТОЛЬКО owner)
  const text = buildDigest(snap);
  let sent = false;
  const ppl = await getPeople().catch(() => null);
  if (ppl && ppl.owner && ppl.owner.chatId) { await sendTg("owner", ppl.owner.chatId, text); sent = true; }

  await rsetJSON(K.lastrun, { at: new Date().toISOString(), day, sent, adsAvailable: ads.available, igOk: !!(ig && ig.ok), cac: unit.cac.value != null ? unit.cac.value : null, roas: unit.roas.value != null ? unit.roas.value : null });
  return { ok: true, day, sent, adsAvailable: ads.available, igOk: !!(ig && ig.ok), cac: unit.cac, roas: unit.roas, digestPreview: text };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-хендлер: daily (cron+секрет), state (админ, для UI), peek (админ, диагностика без побочных эффектов)
// ─────────────────────────────────────────────────────────────────────────────
const CRON_OK = new Set(["daily"]);
async function isAuthed(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (auth && CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  if (!session) return false;
  const s = await rgetJSON(`session:${session}`, null);
  return !!(s && s.role === "admin");
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || (req.body && req.body.action) || "";
  const cronOk = (req.query && req.query.cron === "1") && CRON_OK.has(action);
  if (!cronOk && !(await isAuthed(req))) { res.status(403).json({ error: "forbidden" }); return; }
  try {
    if (action === "daily") { res.status(200).json(await runMarketingDaily(ORG, req.query && req.query.force === "1")); return; }
    if (action === "state") { res.status(200).json({ snapshot: await rgetJSON(K.snapshot, null), lastrun: await rgetJSON(K.lastrun, null) }); return; }
    if (action === "ui") {
      // ЖИВОЙ расчёт для панели дашборда: без записи снапшота и без телеграма owner (IG — из кэша).
      const [adsCache, ig, funnel] = await Promise.all([rgetJSON("meta_spend", null), getInstagram(false), getVerifiedFunnel(ORG).catch(() => null)]);
      const ads = deriveAds(adsCache);
      const ff = funnelFacts(funnel);
      const period = assessPeriodAlignment(ads, ff);
      const currency = assessCurrencyAlignment(ads);
      const unit = computeUnitEconomics(ads, ff, period, currency);
      res.status(200).json({
        ok: true, day: tkDay(),
        ads: { available: ads.available, reason: ads.reason || null, currency: ads.currency || null, period: ads.period || null, updatedAt: ads.updatedAt || null, total: ads.total, adsets: ads.adsets },
        instagram: ig.ok ? { ok: true, followers_count: ig.followers_count, media_count: ig.media_count, reach: ig.reach, profile_views: ig.profile_views, media: ig.media } : { ok: false, error: ig.error },
        funnel: ff, period, currency, unit,
      });
      return;
    }
    if (action === "peek") {
      // ЧТО агент видит на входе — БЕЗ записи в Redis (Instagram тянем свежим, но не кэшируем).
      const [adsCache, ig, funnel] = await Promise.all([
        rgetJSON("meta_spend", null),
        fetchInstagramFresh(),
        getVerifiedFunnel(ORG).catch(() => null),
      ]);
      const ads = deriveAds(adsCache);
      const ff = funnelFacts(funnel);
      const period = assessPeriodAlignment(ads, ff);
      const currency = assessCurrencyAlignment(ads);
      const unit = computeUnitEconomics(ads, ff, period, currency);
      const debug = req.query && req.query.debug === "1";
      res.status(200).json({
        ok: true,
        ads: { available: ads.available, reason: ads.reason || null, period: ads.period || null, currency: ads.currency || null, adsetCount: ads.adsets.length, total: ads.total },
        instagram: ig.ok
          ? { ok: true, followers_count: ig.followers_count, media_count: ig.media_count, reach: ig.reach, profile_views: ig.profile_views, mediaCount: ig.media.length, errors: ig.errors, ...(debug ? { rawInsights: ig.rawInsights || null } : {}) }
          : { ok: false, error: ig.error, errors: ig.errors, ...(debug ? { rawInsights: ig.rawInsights || null } : {}) },
        funnel: ff,
        period,          // {aligned, target, adsMonth, reason} — видно, за одно ли окно считаются CAC/ROAS
        currency,        // {aligned, adCurrency, rate, spendRaw, spendUZS, reason} — валютная сверка ROAS
        unit,
      });
      return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
