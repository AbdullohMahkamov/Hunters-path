// /api/sync-speed.js — оценка дисциплины МОПов из СОБЫТИЙ amoCRM (Вариант В: все события месяца).
// Считает: скорость 1-го звонка, настойчивость дозвона, "закрыл рано" (детектор халтуры), задачи.
// Тяжёлый модуль — тянет события пачками. Запуск: ночью (Cron) или вручную.

const SUBDOMAIN = "huntercademy";
const PIPELINE_ID_NAME = "HunterAcademy";
const SOLD_STATUS = 142;     // Sotildi
const LOST_STATUS = 143;     // Yopildi
const OWN_THRESHOLD = 1600000;

const ACTIVE_MOPS = {
  13660834: "Komiljon", 13703650: "Samandar", 13904266: "Abdulla-Legenda",
  13833590: "Begoyim", 13681582: "Abulbositxon",
};
// loss reason id "3 marta bog'lanib bo'lmadi"
const NO_REACH_REASON_ID = 22815982;

async function redisSet(url, token, key, value) {
  const r = await fetch(`${url}/set/${encodeURIComponent(key)}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}` },
    body: typeof value === "string" ? value : JSON.stringify(value),
  });
  return r.ok;
}

function median(arr){
  if(!arr.length) return null;
  const s=[...arr].sort((a,b)=>a-b);
  const m=Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  if (!redisUrl || !redisToken) { res.status(500).json({ error: "Upstash env not set" }); return; }

  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const now = new Date();
  const monthStart = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);

  try {
    // 1) Найдём pipeline_id воронки HunterAcademy
    let pipelineId = null;
    const pr = await fetch(`${base}/leads/pipelines`, { headers: H });
    if (pr.ok) {
      const pd = await pr.json();
      for (const p of ((pd._embedded && pd._embedded.pipelines) || []))
        if (p.name === PIPELINE_ID_NAME) pipelineId = p.id;
    }

    // 1б) Тянем названия причин потери, чтобы отличить «неверный номер» / «телефон отключён»
    const lossNameById = {};
    try {
      let lp = 1;
      while (lp < 10) {
        const lr = await fetch(`${base}/leads/loss_reasons?limit=250&page=${lp}`, { headers: H });
        if (!lr.ok) break;
        const ld = await lr.json();
        const arr = (ld._embedded && ld._embedded.loss_reasons) || [];
        for (const x of arr) lossNameById[x.id] = (x.name || "").toLowerCase();
        if (arr.length < 250) break;
        lp++;
      }
    } catch (e) { /* если не вышло — работаем по старой логике */ }
    // хелперы: распознать причину по названию
    const isWrongNumber = (id) => { const n = lossNameById[id] || ""; return n.includes("xato raqam") || n.includes("неверный номер") || n.includes("неправильн"); };
    const isPhoneOff = (id) => { const n = lossNameById[id] || ""; return n.includes("o'chirilgan") || n.includes("o‘chirilgan") || n.includes("отключ"); };

    // 2) Тянем ЛИДЫ месяца: id -> {created_at, responsible, status, price, lossId}
    const leadInfo = {};
    let page = 1, guard = 0;
    while (guard < 80) {
      guard++;
      let url = `${base}/leads?limit=250&page=${page}&filter[created_at][from]=${monthStart}`;
      if (pipelineId) url += `&filter[pipeline_id]=${pipelineId}`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) { res.status(r.status).json({ error: "leads error", detail: (await r.text()).slice(0,300) }); return; }
      const d = await r.json();
      const leads = (d._embedded && d._embedded.leads) || [];
      for (const L of leads) {
        leadInfo[L.id] = {
          id: L.id,
          name: L.name || "",
          created: L.created_at,
          closed: L.closed_at || 0,
          updated: L.updated_at || 0,
          resp: L.responsible_user_id,
          status: L.status_id,
          price: L.price || 0,
          lossId: L.loss_reason_id || null,
          firstCall: null,   // время первого исходящего звонка
          reachedReal: false,// реальный разговор >60 сек
          calls: 0,          // кол-во исходящих звонков
          tasks: 0,          // кол-во задач
          tasksDone: 0,      // выполненных задач (нажат «выполнено»)
        };
      }
      if (leads.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // 3) Тянем СОБЫТИЯ месяца пачками: только outgoing_call (звонки), привязка к лидам
    const evTypes2 = "outgoing_call";
    page = 1; guard = 0;
    while (guard < 120) {
      guard++;
      const url = `${base}/events?filter[type]=${evTypes2}` +
        `&filter[created_at][from]=${monthStart}&limit=250&page=${page}&order[created_at]=asc`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) break;
      const d = await r.json();
      const events = (d._embedded && d._embedded.events) || [];
      for (const e of events) {
        if (e.entity_type !== "lead") continue;
        const li = leadInfo[e.entity_id];
        if (!li) continue;
        if (e.type === "outgoing_call") {
          li.calls++;
          if (li.firstCall === null || e.created_at < li.firstCall) li.firstCall = e.created_at;
        }
      }
      if (events.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // 3a) ПРИМЕЧАНИЯ-ЗВОНКИ (Utel): реальный дозвон = разговор состоялся (call_status==4 или duration>=60).
    //     Считаем per-MOP по ОТВЕТСТВЕННОМУ примечания — не зависит от того, лид какого месяца.
    //     reachedLeadsByMop: mopName -> Set(lead_id, где был реальный разговор)
    //     callLeadsByMop:    mopName -> Set(lead_id, кому вообще звонили в этом месяце)
    const REACH_MIN_SEC = 60;
    const reachedLeadsByMop = {};
    const callLeadsByMop = {};
    let notesSeen = 0, notesAnswered = 0, notesMopMatched = 0, notesPages = 0;
    // собираем звонки по лидам: leadId -> {called:true, answered:bool}
    const callByLead = {};
    {
      page = 1; guard = 0;
      let stop = false;
      while (guard < 400 && !stop) {
        guard++;
        // без фильтра по дате (он обрывал выборку); сортируем свежие первыми, стоп когда ушли за месяц
        const url = `${base}/leads/notes?filter[note_type][0]=call_out&filter[note_type][1]=call_in` +
          `&order[created_at]=desc&limit=250&page=${page}`;
        const r = await fetch(url, { headers: H });
        if (r.status === 204) break;
        if (!r.ok) break;
        notesPages++;
        const d = await r.json();
        const notes = (d._embedded && d._embedded.notes) || [];
        for (const n of notes) {
          if (n.note_type !== "call_out" && n.note_type !== "call_in") continue;
          if ((n.created_at || 0) < monthStart) { stop = true; continue; } // старее месяца — дальше не нужно
          notesSeen++;
          const leadId = n.entity_id;
          if (!leadId) continue;
          const p = n.params || {};
          const dur = Number(p.duration) || 0;
          const status = Number(p.call_status);
          const answered = (status === 4) || (dur >= REACH_MIN_SEC);
          const rec = callByLead[leadId] || (callByLead[leadId] = { called: true, answered: false });
          if (answered) { rec.answered = true; notesAnswered++; }
        }
        if (notes.length < 250) break;
        page++;
        await new Promise(rs => setTimeout(rs, 100));
      }
    }

    // Привязываем звонки к МОПу через ОТВЕТСТВЕННОГО ЗА ЛИД (звонки Utel пишутся на служебный аккаунт).
    let leadsFetched = 0;
    {
      const respByLead = {}; // leadId -> responsible_user_id
      for (const id in leadInfo) if (leadInfo[id] && leadInfo[id].resp) respByLead[id] = leadInfo[id].resp;
      const missing = Object.keys(callByLead).filter(id => respByLead[id] == null);
      // amoCRM filter[id][]: безопасно ~50 id за запрос (иначе URL слишком длинный)
      for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        const qs = chunk.map(id => `filter[id][]=${id}`).join("&");
        try {
          const r = await fetch(`${base}/leads?${qs}&limit=50`, { headers: H });
          if (r.ok) {
            const d = await r.json();
            const arr = (d._embedded && d._embedded.leads) || [];
            leadsFetched += arr.length;
            for (const L of arr) respByLead[L.id] = L.responsible_user_id;
          }
        } catch (e) {}
        await new Promise(rs => setTimeout(rs, 90));
      }
      // раскидываем по МОПам
      for (const leadId in callByLead) {
        const mopName = ACTIVE_MOPS[respByLead[leadId]];
        if (!mopName) continue;
        notesMopMatched++;
        (callLeadsByMop[mopName] = callLeadsByMop[mopName] || new Set()).add(leadId);
        if (callByLead[leadId].answered) {
          (reachedLeadsByMop[mopName] = reachedLeadsByMop[mopName] || new Set()).add(leadId);
          const li = leadInfo[leadId];
          if (li) li.reachedReal = true;
        }
      }
    }

    // 3b) ЗАДАЧИ — через отдельный эндпоинт /tasks (привязаны к лиду через entity_id, entity_type=leads)
    page = 1; guard = 0;
    while (guard < 120) {
      guard++;
      const url = `${base}/tasks?limit=250&page=${page}&filter[created_at][from]=${monthStart}`;
      const r = await fetch(url, { headers: H });
      if (r.status === 204) break;
      if (!r.ok) break;
      const d = await r.json();
      const tasks = (d._embedded && d._embedded.tasks) || [];
      for (const t of tasks) {
        const et = t.entity_type;
        if (et !== "leads" && et !== "lead") continue;
        const li = leadInfo[t.entity_id];
        if (!li) continue;
        li.tasks++;
        if (t.is_completed) li.tasksDone = (li.tasksDone || 0) + 1;
      }
      if (tasks.length < 250) break;
      page++;
      await new Promise(rs => setTimeout(rs, 150));
    }

    // 4) Считаем дисциплину по каждому действующему МОПу
    const stat = {}; // mopName -> агрегаты
    for (const name of Object.values(ACTIVE_MOPS)) {
      stat[name] = { leads:0, firstCallTimes:[], reached:0, callsTotal:0, withTask:0,
                     closedEarly:0, noReachClosed:0, tasksTotal:0, tasksDone:0 };
    }

    const suspicious2 = []; // подозрительные по звонкам (этап 2)
    const nowSec2 = Math.floor(Date.now() / 1000);
    const STALL_DAYS = 7; // лид без движения дольше 7 дней = завис

    for (const id in leadInfo) {
      const L = leadInfo[id];
      const mop = ACTIVE_MOPS[L.resp];
      if (!mop) continue;
      // исключаем "своих"
      if (L.status === SOLD_STATUS && L.price <= OWN_THRESHOLD) continue;
      const S = stat[mop];
      S.leads++;
      S.callsTotal += L.calls;
      if (L.tasks > 0) S.withTask++;
      S.tasksTotal += (L.tasks || 0);
      S.tasksDone += (L.tasksDone || 0);
      if (L.firstCall) {
        const mins = (L.firstCall - L.created) / 60;
        if (mins >= 0 && mins < 60*24*14) S.firstCallTimes.push(mins);
      }
      // РЕАЛЬНЫЙ ДОЗВОН — только если был разговор дольше 60 сек
      if (L.reachedReal) S.reached++;
      // ДЕТЕКТОР ХАЛТУРЫ (с учётом «мёртвых» номеров):
      if (L.status === LOST_STATUS) {
        if (isWrongNumber(L.lossId)) {
          // неверный номер — не халтура
        }
        else if (L.lossId === NO_REACH_REASON_ID || isPhoneOff(L.lossId)) {
          S.noReachClosed++;
          if (L.calls < 3) {
            S.closedEarly++;
            // [ЗВОНКИ] закрыл «не дозвонился» с 0-1 звонком
            if (L.calls <= 1) {
              suspicious2.push({ id: L.id, name: L.name, price: null, responsible: mop,
                closed_at: L.closed || L.updated, created_at: L.created,
                cat: "calls", type: "early_close", label: `Закрыл «не дозвонился» (${L.calls} звонк.)` });
            }
          }
        }
      }
      // [ЗВОНКИ] дозвон, но мгновенное закрытие: позвонил и закрыл в течение 2 минут
      if (L.status === LOST_STATUS && L.firstCall && L.closed && (L.closed - L.firstCall) >= 0 && (L.closed - L.firstCall) < 120) {
        suspicious2.push({ id: L.id, name: L.name, price: null, responsible: mop,
          closed_at: L.closed, created_at: L.created,
          cat: "calls", type: "instant_close", label: "Дозвон и мгновенное закрытие (<2 мин)" });
      }
      // [ВОРОНКА] лид завис: открыт (не продан/не закрыт), без изменений дольше 7 дней
      if (L.status !== SOLD_STATUS && L.status !== LOST_STATUS && L.updated && (nowSec2 - L.updated) > STALL_DAYS * 24 * 3600) {
        const days = Math.floor((nowSec2 - L.updated) / (24 * 3600));
        suspicious2.push({ id: L.id, name: L.name, price: null, responsible: mop,
          closed_at: L.updated, created_at: L.created,
          cat: "funnel", type: "stalled", label: `Лид завис (${days} дн. без движения)` });
      }
    }

    // 5) Формируем результат
    const mops = Object.entries(stat).map(([name, S]) => {
      const medMin = median(S.firstCallTimes);
      return {
        name,
        leads: S.leads,
        medianFirstCallMin: medMin !== null ? Math.round(medMin) : null,
        avgCallsPerLead: S.leads ? +(S.callsTotal / S.leads).toFixed(1) : 0,
        taskRate: S.leads ? Math.round(S.withTask / S.leads * 100) : 0,
        // % закрытых "не дозвонился" при < 3 звонках (халтура) — оставлено для совместимости
        earlyClosePct: S.noReachClosed ? Math.round(S.closedEarly / S.noReachClosed * 100) : 0,
        noReachClosed: S.noReachClosed,
        closedEarly: S.closedEarly,
        // % дозвона — из данных Utel: сколько лидов с реальным разговором ÷ сколько лидов вообще звонили
        reachedPct: (function(){
          const reached = (reachedLeadsByMop[name] && reachedLeadsByMop[name].size) || 0;
          const called = (callLeadsByMop[name] && callLeadsByMop[name].size) || 0;
          return called ? Math.round(reached / called * 100) : 0;
        })(),
        reachedLeads: (reachedLeadsByMop[name] && reachedLeadsByMop[name].size) || 0,
        calledLeads: (callLeadsByMop[name] && callLeadsByMop[name].size) || 0,
        // задачи: всего и реально выполнено (нажат «выполнено»)
        tasksTotal: S.tasksTotal,
        tasksDone: S.tasksDone,
        tasksDonePct: S.tasksTotal ? Math.round(S.tasksDone / S.tasksTotal * 100) : 0,
      };
    }).sort((a,b)=> (a.medianFirstCallMin??9e9) - (b.medianFirstCallMin??9e9));

    const result = { updatedAt: new Date().toISOString(), period: "Текущий месяц", mops, suspicious2: suspicious2.slice(0, 300), _debug: { notesSeen, notesPages, callByLeadSize: Object.keys(callByLead).length, leadsFetched, notesMopMatched, notesAnswered } };
    await redisSet(redisUrl, redisToken, "speed", JSON.stringify(result));
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "speed sync failed", detail: String(err) });
  }
}
