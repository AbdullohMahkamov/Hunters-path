// /api/mop-debug.js — диагностика привязки МОПов. Admin only.
// Открой: /api/mop-debug?session=ТВОЯ_СЕССИЯ

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json(); return d && d.result != null ? d.result : null;
}

export default async function handler(req, res) {
  const session = req.query && req.query.session;
  let sess = null;
  try { const raw = await redisGet(`session:${session}`); sess = raw ? JSON.parse(raw) : null; } catch (e) {}
  if (!sess || sess.role !== "admin" || sess.org !== "hunter") { res.status(403).json({ error: "superadmin only" }); return; }

  const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
  const dash = JSON.parse((await redisGet("dashboard")) || "null");
  const mopsBySales = (dash && dash.mopsBySales) ? dash.mopsBySales.map(m => ({ id: m.id, name: m.name, sold: m.sold })) : "НЕТ ДАННЫХ (нужно Обновить из amoCRM)";

  // диагностика: что видит кабинет
  const cacheHasMops = !!(dash && dash.mopsBySales);
  const cacheCheck = {
    dashboard_exists: !!dash,
    has_mopsBySales: cacheHasMops,
    mopsBySales_count: (dash && dash.mopsBySales) ? dash.mopsBySales.length : 0,
    accounts_orgs: accounts.map(a => ({ login: a.login, org: a.org || "hunter" })),
  };

  // для каждого аккаунта — что найдётся в дашборде по его mopId
  const matching = accounts.map(a => {
    let found = null;
    if (dash && dash.mopsBySales) {
      found = dash.mopsBySales.find(m => String(m.id) === String(a.mopId));
    }
    return {
      login: a.login,
      saved_mopId: a.mopId,
      saved_name: a.name,
      cabinet_will_show: found ? found.name : "НЕ НАЙДЕН (id не совпал)",
    };
  });

  res.status(200).json({
    ok: true,
    accounts_count: accounts.length,
    cache_check: cacheCheck,
    accounts_raw: accounts.map(a => ({ login: a.login, mopId: a.mopId, name: a.name, org: a.org || "hunter", mopRole: a.mopRole || "sales" })),
    mops_in_dashboard: mopsBySales,
    matching_check: matching,
    hint: "cache_check.has_mopsBySales должно быть true. Если false — нажми «Обновить из amoCRM». accounts_orgs должны быть 'hunter'.",
  });
}
