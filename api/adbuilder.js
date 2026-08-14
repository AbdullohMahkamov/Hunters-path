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
const fmt = (n) => (n == null || isNaN(n)) ? "—" : Math.round(n).toLocaleString("ru-RU");

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

  // КРЕАТИВЫ — посты из тестового Instagram (ALTRONE берёт их, отдельная загрузка не нужна).
  const posts = (ig && Array.isArray(ig.posts)) ? ig.posts.map((p) => ({ caption: p.caption || "", engagement: p.engagement || 0, id: p.id || null, permalink: p.permalink || null })) : [];

  if (action === "inputs") { res.status(200).json({ ok: true, audiences: auds, creatives: posts, currency: "UZS" }); return; }

  if (action === "plan") {
    const budget = Math.max(0, Math.round(Number((req.query && req.query.budget) || (req.body && req.body.budget) || 0)));
    if (!budget) { res.status(400).json({ ok: false, error: "укажите общий бюджет (budget, в сумах)" }); return; }
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
      ok: true, budgetUZS: budget, split, expectedLeads, avgCpl, creativesAvailable: posts.length,
      rationale: { basis: "реальный ROAS по аудиториям из amoCRM (не прокси Meta)", winners: winners.length, testShare, perAdsetCapPct: 50 },
      note: "ПЛАН (Стадия 1): в Meta НИЧЕГО не создано. Это предпросмотр того, что ALTRONE соберёт и запустит ПОСЛЕ твоего подтверждения (Стадия 2). Общий бюджет — жёсткий потолок.",
    });
    return;
  }
  res.status(200).json({ ok: false, error: "unknown action" });
}
