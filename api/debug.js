// /api/debug.js — диагностика ЗАДАЧ: как amoCRM хранит задачи (через /tasks), привязка к лидам.
const SUBDOMAIN = "huntercademy";

export default async function handler(req, res) {
  const token = process.env.AMOCRM_TOKEN;
  if (!token) { res.status(500).json({ error: "AMOCRM_TOKEN not set" }); return; }
  const H = { Authorization: `Bearer ${token}` };
  const base = `https://${SUBDOMAIN}.amocrm.ru/api/v4`;
  const out = { ok: true };
  async function get(url){ try{const r=await fetch(url,{headers:H});return{status:r.status,body:await r.json()};}catch(e){return{error:String(e)};} }

  try {
    const now=new Date();
    const monthStart=Math.floor(new Date(now.getFullYear(),now.getMonth(),1).getTime()/1000);

    // 1) Задачи через /api/v4/tasks (правильный способ)
    const tasks = await get(`${base}/tasks?limit=10&order[created_at]=desc`);
    out.tasks_status = tasks.status;
    try {
      out.tasks_total_page = tasks.body._page_count || tasks.body._total_items || 'n/a';
      out.tasks_examples = (tasks.body._embedded.tasks||[]).slice(0,5).map(t=>({
        id:t.id, entity_type:t.entity_type, entity_id:t.entity_id,
        responsible_user_id:t.responsible_user_id, created_by:t.created_by,
        created_at:t.created_at, task_type_id:t.task_type_id, is_completed:t.is_completed,
        text:(t.text||'').slice(0,40)
      }));
    } catch(e){ out.tasks_raw = tasks.body; }

    // 2) Задачи за текущий месяц — сколько всего (для оценки объёма)
    const tasksMonth = await get(`${base}/tasks?limit=1&filter[created_at][from]=${monthStart}`);
    out.tasks_month_status = tasksMonth.status;
    try { out.tasks_month_total = tasksMonth.body._total_items || tasksMonth.body._page_count || 'n/a'; } catch(e){}

    // 3) Сколько задач привязано к lead vs contact
    let leadTasks=0, contactTasks=0, other=0;
    const sample = await get(`${base}/tasks?limit=50&order[created_at]=desc`);
    try {
      for(const t of (sample.body._embedded.tasks||[])){
        if(t.entity_type==='leads'||t.entity_type==='lead') leadTasks++;
        else if(t.entity_type==='contacts'||t.entity_type==='contact') contactTasks++;
        else other++;
      }
    } catch(e){}
    out.task_entity_breakdown = { leadTasks, contactTasks, other };

    res.status(200).json(out);
  } catch (err) {
    res.status(500).json({ error: "debug failed", detail: String(err) });
  }
}
