// /api/probefields.js — ВРЕМЕННЫЙ read-only диагностик: список custom-полей сделок и этапов
// пайплайна amoCRM клиента. Нужен, чтобы выбрать поле «оплачено» (отделить от «выиграно») и
// сопоставить этапы воронки. Возвращает ТОЛЬКО СХЕМУ полей (без данных сделок/PII). Admin-гейт.
// После выбора поля — файл удаляем.

const HUNTER = { subdomain: "huntercademy" };

async function rget(url, token, key) {
  try { const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL, redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "no redis" }); return; }
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const raw = await rget(redisUrl, redisToken, `session:${session}`);
  let sess = null; try { sess = raw ? JSON.parse(raw) : null; } catch (e) {}
  if (!sess || sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }

  const org = (req.query && req.query.org) || "hunter";
  let token, subdomain;
  if (org === "hunter") { token = process.env.AMOCRM_TOKEN; subdomain = HUNTER.subdomain; }
  else {
    const c = await (async () => { const r = await rget(redisUrl, redisToken, `clientcfg:${org}`); try { return r ? JSON.parse(r) : null; } catch (e) { return null; } })();
    if (!c || !c.token || !c.subdomain) { res.status(400).json({ error: "org not configured" }); return; }
    token = c.token; subdomain = c.subdomain;
  }
  if (!token) { res.status(500).json({ error: "no amocrm token" }); return; }

  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${subdomain}.amocrm.ru/api/v4`;
  try {
    // 1) custom-поля сделок
    const fields = [];
    let page = 1;
    while (page <= 6) {
      const r = await fetch(`${base}/leads/custom_fields?limit=250&page=${page}`, { headers: H });
      if (!r.ok) break;
      const d = await r.json();
      const arr = (d._embedded && d._embedded.custom_fields) || [];
      for (const f of arr) fields.push({ id: f.id, name: f.name, type: f.type, code: f.code || null, enums: Array.isArray(f.enums) ? f.enums.map((e) => ({ id: e.id, value: e.value })) : undefined });
      if (arr.length < 250) break; page++;
    }
    // 2) этапы пайплайнов (для воронки: создана/квалифицирован/выиграна)
    const pipelines = [];
    const rp = await fetch(`${base}/leads/pipelines`, { headers: H });
    if (rp.ok) {
      const d = await rp.json();
      for (const p of ((d._embedded && d._embedded.pipelines) || [])) {
        pipelines.push({ id: p.id, name: p.name, is_main: p.is_main, statuses: ((p._embedded && p._embedded.statuses) || []).map((s) => ({ id: s.id, name: s.name, type: s.type, sort: s.sort })) });
      }
    }
    // подсказка: поля, похожие на оплату
    const payHints = fields.filter((f) => /оплат|оплач|paid|payment|касса|факт.*опл|получен|поступл|чек/i.test(f.name || ""));
    res.status(200).json({ ok: true, org, subdomain, fieldCount: fields.length, fields, pipelines, likelyPaymentFields: payHints.map((f) => ({ id: f.id, name: f.name, type: f.type })) });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
}
