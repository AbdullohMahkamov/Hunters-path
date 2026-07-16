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
      if (sess.role !== "admin") { delete s.margin; delete s.adSpend; delete s.adSpendMonth; delete s.adSpendAll; }
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
      if (incoming.workStart != null) cur.workStart = incoming.workStart; // "HH:MM" начало рабочего дня
      if (incoming.workEnd != null) cur.workEnd = incoming.workEnd;       // "HH:MM" конец рабочего дня
      // маржа и расход на рекламу — только админ
      if (sess.role === "admin") {
        if (incoming.margin != null) cur.margin = incoming.margin;
        if (incoming.adSpend != null) cur.adSpend = incoming.adSpend;             // legacy (общий)
        if (incoming.adSpendMonth != null) cur.adSpendMonth = incoming.adSpendMonth; // за месяц
        if (incoming.adSpendAll != null) cur.adSpendAll = incoming.adSpendAll;       // за всё время
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
      const source = (c.source === "unified") ? "unified" : "amocrm"; // источник данных: amoCRM или unified-мостик по нашей спеке
      const baseMissing = !c.org || !c.login || !c.password;
      if (source === "amocrm" ? (baseMissing || !c.subdomain || !c.token) : (baseMissing || !c.bridgeUrl || !c.apiKey)) {
        res.status(400).json({ error: source === "amocrm" ? "org, subdomain, token, login, password обязательны" : "org, bridgeUrl, apiKey, login, password обязательны (unified)" }); return;
      }
      if (c.org === "hunter") { res.status(400).json({ error: "org 'hunter' зарезервирован" }); return; }
      // 1) реестр логинов (для auth)
      const list = await getClients();
      const idx = list.findIndex(x => x.org === c.org);
      const entry = { org: c.org, name: c.name || c.org, login: c.login, password: c.password, role: c.role || "admin", source, subdomain: c.subdomain || "", token: c.token || "" };
      if (idx >= 0) list[idx] = entry; else list.push(entry);
      await saveClients(list);
      // 2) конфиг клиента (для sync/sync-speed/activity ИЛИ ingest)
      const cfg = {
        source,                                                   // "amocrm" | "unified" — resolveConfig/диспетчер разводит sync vs ingest
        subdomain: c.subdomain || "", token: c.token || "",        // amocrm: доступ к amoCRM
        bridgeUrl: c.bridgeUrl || "", apiKey: c.apiKey || "",      // unified: мостик клиента по docs/hunter-ai-integration-spec.md
        pipeline: c.pipeline || "", sold: c.sold || "", lost: c.lost || "",
        ownThreshold: c.ownThreshold != null ? c.ownThreshold : 0,
        adsetFieldId: c.adsetFieldId || null,
        financeSheetId: c.financeSheetId || "",
        mops: c.mops || {},
        soldStatus: c.soldStatus != null ? c.soldStatus : null,
        lostStatus: c.lostStatus != null ? c.lostStatus : null,
        noReachReasonId: c.noReachReasonId != null ? c.noReachReasonId : null,
        noContactReasons: c.noContactReasons || [],
        noContactStages: c.noContactStages || [],
        fakeNumReasons: Array.isArray(c.fakeNumReasons) ? c.fakeNumReasons : [],   // брак (неверный номер/дубль) — вон из знаменателя дозвона
        contactedReasons: Array.isArray(c.contactedReasons) ? c.contactedReasons : [], // контакт был (не дали разрешение) — считать дозвоном
        // этапы «входа» для % дозвона — отмечаются чекбоксами при онбординге, правятся в «Метрики».
        // amoCRM: id статусов числовые → Number. unified: id — строки ("new","closed") → храним как строки.
        dozvonStages: Array.isArray(c.dozvonStages)
          ? (source === "unified" ? c.dozvonStages.map(String).filter(Boolean) : c.dozvonStages.map(Number).filter(Boolean))
          : [],
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
      // Чистим ВСЁ, что привязано к org: конфиг, сырьё ingest, курсор Pull и кэши.
      // Иначе удаление+пересоздание того же org слило бы старое сырьё с новым (merge по id).
      const del = (k) => fetch(`${url}/del/${encodeURIComponent(k)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      await Promise.all([
        del(`clientcfg:${org}`),
        del(`ingest:${org}:leads`), del(`ingest:${org}:calls`), del(`ingest:${org}:employees`), del(`ingest:${org}:lastPull`),
        del(`dashboard:${org}`), del(`speed:${org}`),
      ]);
      res.status(200).json({ ok: true });
      return;
    }

    // === НАСТРОЙКА МЕТРИК (этапы дозвона, порог разговора) ===
    // Ключевое: выбор этапов — НАСТРОЙКА, а не задача разработчика. У каждого клиента своя
    // структура воронки, и менять этот выбор нужно в два клика из панели, а не коммитом.
    // hunter: дефолты живут в коде (HUNTER_CFG), а оверрайды — в metricscfg:hunter.
    // остальные клиенты: поля лежат прямо в clientcfg:<org>.
    if (action === "metrics-save") {
      if (sess.role !== "admin") { res.status(403).json({ error: "admin only" }); return; }
      const org = (isSuperAdmin && req.body && req.body.org) ? req.body.org : (sess.org || "hunter"); // клиент — ТОЛЬКО своя org (раньше принимал любой body.org — дыра); суперадмин может указать чужую
      const inc = (req.body && req.body.metrics) || {};
      const key = org === "hunter" ? "metricscfg:hunter" : `clientcfg:${org}`;
      const cr = await fetch(`${url}/get/${key}`, { headers: { Authorization: `Bearer ${token}` } });
      const cd = await cr.json();
      const cur = (cd && cd.result) ? JSON.parse(cd.result) : {};
      const patch = {};
      // unified: id статусов — строки; amoCRM: числа (см. client-save)
      if (Array.isArray(inc.dozvonStages)) patch.dozvonStages = (cur.source === "unified") ? inc.dozvonStages.map(String).filter(Boolean) : inc.dozvonStages.map(Number).filter(Boolean);
      if (inc.reachedSec != null) {
        const rs = parseInt(inc.reachedSec, 10);
        if (!(rs > 0 && rs <= 600)) { res.status(400).json({ error: "reachedSec: 1..600 секунд" }); return; }
        patch.reachedSec = rs;
      }
      if (!Object.keys(patch).length) { res.status(400).json({ error: "нечего сохранять" }); return; }
      const next = { ...cur, ...patch };
      await fetch(`${url}/set/${key}`, {
        method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(next),
      });
      res.status(200).json({ ok: true, saved: patch });
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
        // причины потери — для «не дозвонились» / брак (неверный номер, дубль) / «контакт был»
        let lossReasons = [];
        try { const lr = await fetch(`${base}/leads/loss_reasons?limit=250`, { headers: H }); if (lr.ok) { const ld = await lr.json(); lossReasons = ((ld._embedded && ld._embedded.loss_reasons) || []).map(x => ({ id: x.id, name: x.name })); } } catch (e) {}
        res.status(200).json({ ok: true, pipelines, users, lossReasons });
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
