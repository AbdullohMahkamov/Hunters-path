// /api/marketing.js — кабинет МАРКЕТОЛОГА: метрики (Meta/CPL/ROAS/CAC + Instagram + качество трафика) и его задачи.
// Роль "marketing" (вход marketing:accounts). Аккаунтами управляет админ. Не трогает продажи/цели/дашборд владельца.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const MKT_RATE = 12100; // курс приведения расхода Meta к суму (как в chat.js/marketing-agent)

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
const genId = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ── МЕТРИКИ маркетолога — из тех же кэшей, что видит советник (dashboard, meta_spend, instagram) ──
async function buildMetrics(org) {
  const dash = await rgetJSON(org === "hunter" ? "dashboard" : `dashboard:${org}`, null);
  const meta = await rgetJSON("meta_spend", null);
  const ig = await rgetJSON("marketingagent:instagram", null);
  const speed = await rgetJSON(org === "hunter" ? "speed" : `speed:${org}`, null);
  const mcfg = await rgetJSON(org === "hunter" ? "metricscfg:hunter" : `clientcfg:${org}`, {}) || {};
  const t = (dash && dash.totals) || {};
  const cur = (meta && meta.currency || "").toUpperCase();
  const toUZS = (x) => x == null ? null : (cur === "UZS" ? x : Math.round(x * MKT_RATE));
  const adsets = (meta && Array.isArray(meta.adsets)) ? meta.adsets : [];
  const spendUZS = adsets.reduce((a, x) => a + (toUZS(x.spend) || 0), 0);
  const revenue = t.newSalesRevenue != null ? t.newSalesRevenue : (t.revenue != null ? t.revenue : null);
  const sold = t.sold != null ? t.sold : null;
  const leads = t.leads != null ? t.leads : null;
  const cpl = (leads && spendUZS) ? Math.round(spendUZS / leads) : null;
  const audiences = adsets.map((x) => ({ name: x.name, spendUZS: toUZS(x.spend), ctr: x.impressions > 0 ? +(x.clicks / x.impressions * 100).toFixed(2) : null, leads: x.leads != null ? x.leads : null }))
    .sort((a, b) => (b.spendUZS || 0) - (a.spendUZS || 0)).slice(0, 8);
  const posts = (ig && Array.isArray(ig.media)) ? ig.media.filter((p) => p.engagement != null).sort((a, b) => (b.engagement || 0) - (a.engagement || 0)).slice(0, 3).map((p) => ({ caption: (p.caption || "").slice(0, 60), engagement: p.engagement })) : [];
  return {
    period: (meta && meta.period) || "Текущий месяц",
    spendLoaded: adsets.length > 0,
    spendUZS, currency: cur || null, rate: cur && cur !== "UZS" ? MKT_RATE : null,
    leads, leadsToday: t.leadsToday != null ? t.leadsToday : null, sold, revenue,
    cpl, cplNorm: mcfg.cplNorm != null ? mcfg.cplNorm : null,
    roas: (revenue && spendUZS) ? +(revenue / spendUZS).toFixed(1) : null,
    cac: (sold && spendUZS) ? Math.round(spendUZS / sold) : null,
    conv: (leads && sold) ? +(sold / leads * 100).toFixed(2) : (t.conv != null ? t.conv : null), // качество трафика: лид→продажа
    // ОБЩАЯ ВОРОНКА (лид→дозвон→стадии→продажа) — маркетинг-безопасно (штуки, без сумм/выручки/имён МОПов)
    funnel: (speed && speed.funnel) ? { leads: speed.funnel.leads, reached: speed.funnel.reached, reachedSec: speed.funnel.reachedSec, stages: (speed.funnel.stages || []).map((s) => ({ name: s.name, reached: s.reached, isSold: s.isSold })), lost: speed.funnel.lost } : null,
    audiences,
    instagram: (ig && ig.ok && ig.followers_count != null) ? { followers: ig.followers_count, reach: ig.reach != null ? ig.reach : null, posts } : null,
    updatedAt: (dash && dash.updatedAt) || null,
  };
}

// ── ЗАДАЧИ маркетолога — из marketingtasks (recipient marketing). Открытые + недавно закрытые. ──
async function buildTasks() {
  const all = (await rgetJSON("marketingtasks", [])) || [];
  const open = all.filter((t) => t && t.status !== "done").map((t) => ({ id: t.id, title: t.title, why: t.why || "", steps: (t.action || "").split(" | ").filter(Boolean), leverKey: t.leverKey || null, createdAt: t.createdAt || null }));
  const done = all.filter((t) => t && t.status === "done").sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0)).slice(0, 10)
    .map((t) => ({ id: t.id, title: t.title, doneAt: t.doneAt || null, report: t.report || "" }));
  return { open, done };
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ ok: false, error: "Upstash env not set" }); return; }
  const b = req.body || {};
  const action = (req.query && req.query.action) || b.action || "";
  const sess = await getSession((req.query && req.query.session) || b.session);
  if (!sess) { res.status(200).json({ ok: false, error: "нет доступа" }); return; }
  const isAdmin = sess.role === "admin";
  const isMarketer = sess.role === "marketing";
  const org = sess.org || "hunter";

  try {
    // ── АДМИН: управление аккаунтами маркетологов ──
    if (isAdmin) {
      if (action === "accounts-list") {
        const accs = (await rgetJSON("marketing:accounts", [])) || [];
        res.status(200).json({ ok: true, accounts: accs.map((a) => ({ login: a.login, name: a.name || a.login, org: a.org || "hunter" })) });
        return;
      }
      if (action === "account-add") {
        const login = String(b.login || "").trim().toLowerCase();
        const password = String(b.password || "");
        const name = String(b.name || "").trim();
        if (!login || !password) { res.status(400).json({ ok: false, error: "нужны логин и пароль" }); return; }
        const accs = (await rgetJSON("marketing:accounts", [])) || [];
        if (accs.some((a) => (a.login || "").toLowerCase() === login)) { res.status(400).json({ ok: false, error: "такой логин уже есть" }); return; }
        accs.push({ login, password, name: name || login, org: "hunter", createdAt: Date.now() });
        await rsetJSON("marketing:accounts", accs);
        res.status(200).json({ ok: true, accounts: accs.map((a) => ({ login: a.login, name: a.name, org: a.org })) });
        return;
      }
      if (action === "account-del") {
        const login = String(b.login || "").trim().toLowerCase();
        let accs = (await rgetJSON("marketing:accounts", [])) || [];
        accs = accs.filter((a) => (a.login || "").toLowerCase() !== login);
        await rsetJSON("marketing:accounts", accs);
        res.status(200).json({ ok: true, accounts: accs.map((a) => ({ login: a.login, name: a.name, org: a.org })) });
        return;
      }
    }

    // ── КАБИНЕТ: метрики + задачи (маркетолог видит свой; админ — для предпросмотра) ──
    if (action === "cabinet") {
      if (!isMarketer && !isAdmin) { res.status(403).json({ ok: false, error: "только маркетолог" }); return; }
      const metrics = await buildMetrics(org);
      const tasks = await buildTasks();
      res.status(200).json({ ok: true, name: sess.marketerName || (isAdmin ? "Просмотр" : "Маркетолог"), metrics, tasks });
      return;
    }

    // ── ОТМЕТИТЬ ЗАДАЧУ ВЫПОЛНЕННОЙ + короткий отчёт (что сделано) ──
    if (action === "task-done") {
      if (!isMarketer && !isAdmin) { res.status(403).json({ ok: false, error: "только маркетолог" }); return; }
      const id = String(b.id || "");
      const report = String(b.report || "").slice(0, 600);
      const all = (await rgetJSON("marketingtasks", [])) || [];
      const t = all.find((x) => x && x.id === id);
      if (!t) { res.status(404).json({ ok: false, error: "задача не найдена" }); return; }
      t.status = "done"; t.doneAt = Date.now(); t.doneBy = "marketing"; if (report) t.report = report;
      await rsetJSON("marketingtasks", all);
      res.status(200).json({ ok: true, tasks: await buildTasks() });
      return;
    }

    res.status(400).json({ ok: false, error: "unknown action" });
  } catch (err) {
    res.status(500).json({ ok: false, error: "marketing failed", detail: String(err).slice(0, 200) });
  }
}
