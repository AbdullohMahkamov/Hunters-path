// /api/debug.js — диагностика: показывает структуру воронки amoCRM (этапы + кол-во сделок).
// Открыть один раз, чтобы понять реальные статусы, потом переписать sync.js под них.
const SUBDOMAIN = "huntercademy";

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }

  try {
    // 1) Воронки и их статусы
    const pr = await fetch(`https://${SUBDOMAIN}.amocrm.ru/api/v4/leads/pipelines`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!pr.ok) {
      const t = await pr.text();
      res.status(pr.status).json({ error: "pipelines error", detail: t.slice(0, 800) });
      return;
    }
    const pd = await pr.json();
    const pipelines = (pd._embedded && pd._embedded.pipelines) || [];
    const stages = [];
    for (const p of pipelines) {
      const sts = (p._embedded && p._embedded.statuses) || [];
      for (const s of sts) {
        stages.push({ pipeline: p.name, status_id: s.id, name: s.name });
      }
    }

    // 2) Причины отказа (loss reasons)
    let lossReasons = [];
    try {
      const lr = await fetch(`https://${SUBDOMAIN}.amocrm.ru/api/v4/leads/loss_reasons?limit=250`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (lr.ok) {
        const ld = await lr.json();
        lossReasons = ((ld._embedded && ld._embedded.loss_reasons) || []).map(x => ({ id: x.id, name: x.name }));
      }
    } catch (e) {}

    // 3) Пользователи (МОПы)
    let users = [];
    try {
      const ur = await fetch(`https://${SUBDOMAIN}.amocrm.ru/api/v4/users?limit=250`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (ur.ok) {
        const ud = await ur.json();
        users = ((ud._embedded && ud._embedded.users) || []).map(u => ({ id: u.id, name: u.name }));
      }
    } catch (e) {}

    res.status(200).json({
      ok: true,
      stages_count: stages.length,
      stages,
      loss_reasons: lossReasons,
      users,
    });
  } catch (err) {
    res.status(500).json({ error: "debug failed", detail: String(err) });
  }
}
