// /api/mop.js — управление аккаунтами МОПов и их данными.
// АДМИН: создаёт/удаляет аккаунты МОПов (логин/пароль), ставит личные планы.
// МОП: получает свои метрики + рейтинг команды.
//
// Хранилище:
//   mops:accounts        → [{login,password,mopId,name,org}]
//   mops:plans:${org}    → {mopId: planSum}  (личный план в выручке)

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json(); return d && d.result != null ? d.result : null;
}
async function redisSet(key, value) {
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: typeof value === "string" ? value : JSON.stringify(value) });
}
async function getSession(session) {
  if (!session) return null;
  try { const raw = await redisGet(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function readCache(org) {
  // дашборд-кэш (ключи как в chat.js: "dashboard", для др. org — "dashboard:${org}")
  const key = (org && org !== "hunter") ? `dashboard:${org}` : "dashboard";
  try { const raw = await redisGet(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function readSpeed(org) {
  const key = (org && org !== "hunter") ? `speed:${org}` : "speed";
  try { const raw = await redisGet(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const sess = await getSession(session);
  if (!sess) { res.status(403).json({ error: "no session" }); return; }
  const org = sess.org || "hunter";

  try {
    // ============ АДМИН: управление аккаунтами МОПов ============
    if (sess.role === "admin") {
      // список аккаунтов + планов
      if (req.query && req.query.action === "list") {
        const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
        const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");
        // список МОПов из дашборда (чтобы админ видел, кому создавать)
        const cache = await readCache(org);
        const mopsFromCrm = (cache && cache.mopsBySales) ? cache.mopsBySales.map(m => ({ id: m.id, name: m.name })) : [];
        res.status(200).json({ ok: true, accounts: accounts.filter(a => (a.org || "hunter") === org), plans, mopsFromCrm });
        return;
      }
      // создать аккаунт МОПу
      if (req.method === "POST" && req.body && req.body.action === "create") {
        const { login, password, mopId, name } = req.body;
        if (!login || !password || !mopId) { res.status(400).json({ error: "login, password, mopId обязательны" }); return; }
        const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
        if (accounts.find(a => (a.login || "").toLowerCase() === String(login).toLowerCase())) {
          res.status(200).json({ ok: false, error: "Такой логин уже есть" }); return;
        }
        accounts.push({ login: String(login).trim(), password: String(password), mopId: String(mopId), name: name || "", org });
        await redisSet("mops:accounts", accounts);
        res.status(200).json({ ok: true, created: true });
        return;
      }
      // удалить аккаунт
      if (req.method === "POST" && req.body && req.body.action === "delete") {
        const { login } = req.body;
        let accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
        accounts = accounts.filter(a => (a.login || "").toLowerCase() !== String(login).toLowerCase());
        await redisSet("mops:accounts", accounts);
        res.status(200).json({ ok: true, deleted: true });
        return;
      }
      // задать личный план МОПу
      if (req.method === "POST" && req.body && req.body.action === "set_plan") {
        const { mopId, plan } = req.body;
        const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");
        plans[String(mopId)] = parseInt(plan, 10) || 0;
        await redisSet(`mops:plans:${org}`, plans);
        res.status(200).json({ ok: true, saved: true });
        return;
      }
    }

    // ============ МОП или АДМИН: данные кабинета МОПа ============
    if (req.query && req.query.action === "cabinet") {
      // какой МОП: сам МОП — свой mopId; админ может смотреть любого (?mopId=)
      const mopId = sess.role === "mop" ? sess.mopId : (req.query.mopId || sess.mopId);
      if (!mopId) { res.status(400).json({ error: "no mopId" }); return; }

      const cache = await readCache(org);
      const speed = await readSpeed(org);
      if (!cache || !cache.mopsBySales) { res.status(200).json({ ok: true, empty: true, message: "Данные ещё не загружены" }); return; }

      const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");

      // собираем метрики каждого МОПа: продажи из mopsBySales, дисциплина из speed
      const speedMops = (speed && speed.mops) ? speed.mops : [];
      const byId = {};
      (cache.mopsBySales || []).forEach(m => { byId[m.id] = { ...m }; });
      (cache.mopsByConv || []).forEach(m => { if (byId[m.id]) { byId[m.id].leads = m.leads; byId[m.id].conv = m.conv; byId[m.id].reachPct = m.reachPct; } });
      speedMops.forEach(m => {
        if (byId[m.id]) {
          byId[m.id].medianFirstCallMin = m.medianFirstCallMin;
          byId[m.id].taskRate = m.taskRate;
          byId[m.id].reachRate = m.reachRate;
        }
      });

      // команда: массив всех, отсортирован по продажам
      const team = Object.values(byId).map(m => ({
        id: m.id, name: m.name,
        sold: m.sold || 0, revenue: m.revenue || 0,
        leads: m.leads || 0, conv: m.conv || 0,
        reachPct: m.reachPct != null ? m.reachPct : (m.reachRate || 0),
        firstCallMin: m.medianFirstCallMin != null ? m.medianFirstCallMin : null,
        taskRate: m.taskRate != null ? m.taskRate : null,
        plan: plans[m.id] || 0,
      })).sort((a, b) => b.sold - a.sold);

      // рейтинг: место каждого
      team.forEach((m, i) => { m.rank = i + 1; });

      const me = team.find(m => String(m.id) === String(mopId)) || null;
      // «до следующего места»
      let toNext = null;
      if (me && me.rank > 1) {
        const above = team[me.rank - 2];
        toNext = { name: above.name, soldDiff: (above.sold - me.sold) };
      }

      res.status(200).json({
        ok: true,
        me, team, toNext,
        period: cache.period,
        updatedAt: cache.updatedAt,
        mopName: sess.mopName || (me && me.name) || "",
      });
      return;
    }

    res.status(400).json({ error: "unknown action or no access" });
  } catch (e) {
    res.status(500).json({ error: "mop failed", detail: String(e).slice(0, 300) });
  }
}
