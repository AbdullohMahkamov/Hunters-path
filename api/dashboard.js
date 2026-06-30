// /api/dashboard.js — отдаёт кэш дашборда + кэш скорости/дисциплины из Upstash.
export default async function handler(req, res) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) { res.status(500).json({ error: "Upstash env not set" }); return; }

  async function getKey(key){
    try{
      const r=await fetch(`${url}/get/${key}`,{headers:{Authorization:`Bearer ${token}`}});
      const d=await r.json();
      if(!d||d.result==null) return null;
      return JSON.parse(d.result);
    }catch(e){ return null; }
  }

  try {
    const dash = await getKey("dashboard");
    const speed = await getKey("speed");
    if (!dash) { res.status(200).json({ empty: true, speed }); return; }
    res.status(200).json({ ...dash, speed });
  } catch (err) {
    res.status(500).json({ error: "Dashboard read failed", detail: String(err) });
  }
}
