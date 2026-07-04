// /api/user-data.js — хранит всё состояние пользователя (чаты, прогресс, настройки) в облаке.
// Ключ данных = org (организация), чтобы потом легко разделить по клиентам.
// Требует валидную сессию.

async function getSession(url, token, session) {
  if (!session) return null;
  try {
    const r = await fetch(`${url}/get/session:${encodeURIComponent(session)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d = await r.json();
    if (!d || d.result == null) return null;
    return JSON.parse(d.result);
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).json({ error: "Upstash env not set" }); return; }

  try {
    const { action, session, data } = req.body || {};
    const sess = await getSession(url, token, session);
    if (!sess) { res.status(401).json({ error: "no session" }); return; }

    // Данные храним по организации (org). Роль внутри — из сессии.
    const key = `appdata:${sess.org}`;

    if (action === "load") {
      const r = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!d || d.result == null) { res.status(200).json({ ok: true, data: null, role: sess.role, org: sess.org }); return; }
      res.status(200).json({ ok: true, data: JSON.parse(d.result), role: sess.role, org: sess.org });
      return;
    }

    if (action === "save") {
      await fetch(`${url}/set/${key}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(data || {}),
      });
      res.status(200).json({ ok: true });
      return;
    }

    // === НАСТРОЙКИ ОРГАНИЗАЦИИ (цель, рабочие дни) — общие для всех пользователей орг ===
    const settingsKey = `settings:${sess.org}`;
    if (action === "settings-get") {
      const r = await fetch(`${url}/get/${settingsKey}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      const s = (d && d.result) ? JSON.parse(d.result) : {};
      // маржа и расход на рекламу — только админу (чувствительно: раскрывает прибыль)
      if (sess.role !== "admin") { delete s.margin; delete s.adSpend; }
      res.status(200).json({ ok: true, settings: s });
      return;
    }
    if (action === "settings-set") {
      // сохраняем только известные поля (цель, рабочие дни, маржа, расход на рекламу)
      // маржа и расход — чувствительные (прибыль), меняет только админ
      const r = await fetch(`${url}/get/${settingsKey}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      const cur = (d && d.result) ? JSON.parse(d.result) : {};
      const incoming = (req.body && req.body.settings) || {};
      if (incoming.goal != null) cur.goal = incoming.goal;
      if (incoming.workdays != null) cur.workdays = incoming.workdays; // массив 0..6 (0=Вс)
      // маржа и расход на рекламу — только админ
      if (sess.role === "admin") {
        if (incoming.margin != null) cur.margin = incoming.margin;         // % прибыли (0..100)
        if (incoming.adSpend != null) cur.adSpend = incoming.adSpend;      // расход на таргет за месяц
      }
      await fetch(`${url}/set/${settingsKey}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(cur),
      });
      res.status(200).json({ ok: true, settings: cur });
      return;
    }

    // === УПРАВЛЕНИЕ КЛИЕНТАМИ (мультитенант) — только супер-админ (org hunter, role admin) ===
    const isSuperAdmin = (sess.org === "hunter" && sess.role === "admin");
    async function getClients() {
      const r = await fetch(`${url}/get/clients:list`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      return (d && d.result) ? JSON.parse(d.result) : [];
    }
    async function saveClients(list) {
      await fetch(`${url}/set/clients:list`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(list),
      });
    }

    if (action === "clients-list") {
      if (!isSuperAdmin) { res.status(403).json({ error: "forbidden" }); return; }
      const list = await getClients();
      // не отдаём токены/пароли наружу (только мета)
      const safe = list.map(c => ({ org: c.org, name: c.name, login: c.login, subdomain: c.subdomain, role: c.role, hasToken: !!c.token }));
      res.status(200).json({ ok: true, clients: safe });
      return;
    }

    if (action === "client-save") {
      if (!isSuperAdmin) { res.status(403).json({ error: "forbidden" }); return; }
      const c = (req.body && req.body.client) || {};
      if (!c.org || !c.subdomain || !c.token || !c.login || !c.password) {
        res.status(400).json({ error: "org, subdomain, token, login, password обязательны" }); return;
      }
      if (c.org === "hunter") { res.status(400).json({ error: "org 'hunter' зарезервирован" }); return; }
      // 1) реестр логинов (для auth)
      const list = await getClients();
      const idx = list.findIndex(x => x.org === c.org);
      const entry = { org: c.org, name: c.name || c.org, login: c.login, password: c.password, role: c.role || "admin", subdomain: c.subdomain, token: c.token };
      if (idx >= 0) list[idx] = entry; else list.push(entry);
      await saveClients(list);
      // 2) конфиг клиента (для sync/sync-speed/activity)
      const cfg = {
        subdomain: c.subdomain, token: c.token,
        pipeline: c.pipeline || "", sold: c.sold || "", lost: c.lost || "",
        ownThreshold: c.ownThreshold != null ? c.ownThreshold : 0,
        adsetFieldId: c.adsetFieldId || null,
        mops: c.mops || {},
        soldStatus: c.soldStatus != null ? c.soldStatus : null,
        lostStatus: c.lostStatus != null ? c.lostStatus : null,
        noReachReasonId: c.noReachReasonId != null ? c.noReachReasonId : null,
        noContactReasons: c.noContactReasons || [],
        noContactStages: c.noContactStages || [],
      };
      await fetch(`${url}/set/clientcfg:${c.org}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(cfg),
      });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === "client-delete") {
      if (!isSuperAdmin) { res.status(403).json({ error: "forbidden" }); return; }
      const org = (req.body && req.body.org) || "";
      if (!org || org === "hunter") { res.status(400).json({ error: "нельзя удалить" }); return; }
      let list = await getClients();
      list = list.filter(x => x.org !== org);
      await saveClients(list);
      await fetch(`${url}/del/clientcfg:${org}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      res.status(200).json({ ok: true });
      return;
    }

    if (action === "client-probe") {
      if (!isSuperAdmin) { res.status(403).json({ error: "forbidden" }); return; }
      const sub = (req.body && req.body.subdomain || "").trim();
      const tok = (req.body && req.body.token || "").trim();
      if (!sub || !tok) { res.status(400).json({ error: "subdomain и token обязательны" }); return; }
      const base = `https://${sub}.amocrm.ru/api/v4`;
      const H = { Authorization: `Bearer ${tok}` };
      try {
        // воронки + статусы
        const pr = await fetch(`${base}/leads/pipelines`, { headers: H });
        if (!pr.ok) { res.status(200).json({ ok: false, error: `amoCRM ответил ${pr.status}. Проверьте субдомен и токен.` }); return; }
        const pd = await pr.json();
        const pipelines = ((pd._embedded && pd._embedded.pipelines) || []).map(p => ({
          id: p.id, name: p.name,
          statuses: ((p._embedded && p._embedded.statuses) || []).map(s => ({ id: s.id, name: s.name })),
        }));
        // пользователи (менеджеры)
        const ur = await fetch(`${base}/users?limit=250`, { headers: H });
        const ud = ur.ok ? await ur.json() : {};
        const users = ((ud._embedded && ud._embedded.users) || []).map(u => ({ id: u.id, name: u.name }));
        res.status(200).json({ ok: true, pipelines, users });
      } catch (e) {
        res.status(200).json({ ok: false, error: String(e && e.message || e) });
      }
      return;
    }

    // === ПОДОЗРИТЕЛЬНЫЕ СДЕЛКИ: статусы проверки ===
    const suspKey = `suspicious:${sess.org}`;
    // получить все проверенные/отклонённые (карта id -> {status, note, at, by})
    if (action === "susp-status") {
      const r = await fetch(`${url}/get/${suspKey}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      const map = (d && d.result) ? JSON.parse(d.result) : {};
      res.status(200).json({ ok: true, reviewed: map });
      return;
    }
    // пометить сделку: status = "checked" | "rejected", note — примечание
    if (action === "susp-review") {
      const { dealId, status, note, deal } = req.body || {};
      if (!dealId || !status) { res.status(400).json({ error: "dealId and status required" }); return; }
      const r = await fetch(`${url}/get/${suspKey}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      const map = (d && d.result) ? JSON.parse(d.result) : {};
      map[dealId] = {
        status,
        note: note || "",
        at: Date.now(),
        by: sess.role || "",
        deal: deal || null, // снимок данных сделки для истории
      };
      await fetch(`${url}/set/${suspKey}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(map),
      });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    res.status(500).json({ error: "user-data failed", detail: String(err) });
  }
}
