// api/biz-settings.js — СТРУКТУРНЫЕ бизнес-настройки, задаваемые ЧЕРЕЗ ЧАТ (не ручным вводом в дашборде).
// Тот же паттерн, что goal.js: структура + Redis + NL-парсер + история. Три сущности:
//   • margin   — маржа прибыли, % (для ROI). Приоритет АВТО (из финансов); ручное — override (см. (б)).
//   • cplNorm  — ориентир цены лида по рынку, сум (для вердикта CPL). Переспрос раз в полгода.
//   • schedule — рабочий график (workdays/workStart/workEnd). Разово.
// Значения ЗЕРКАЛЯТСЯ в settings:<org> (это ключ, который читают дашборд/orgSettings и sync-speed —
// НЕ metricscfg, там конфиг amoCRM-полей). Числа тянем детерминированно (regex); LLM — только для графика/фолбэка.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const ORG = "hunter";
const MODEL = "claude-haiku-4-5-20251001";
const DAY = 86400000;
export const REASK = { marginDays: 92, cplDays: 183 }; // маржа ~квартал, CPL ~полгода

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
const K = { biz: `bizsettings:${ORG}`, hist: `bizsettings:history:${ORG}`, mcfg: `settings:${ORG}` };

export async function getBizSettings() { return (await rgetJSON(K.biz, {})) || {}; }

// зеркалим плоские значения в metricscfg — старые читатели (getMargin/sync-speed/планировщик) не трогаем
async function mirror(patch) {
  const cur = (await rgetJSON(K.mcfg, {})) || {};
  Object.assign(cur, patch);
  await rsetJSON(K.mcfg, cur);
}
async function pushHist(field, rec) { const h = await rgetJSON(K.hist, []); h.push({ field, at: Date.now(), ...rec }); await rsetJSON(K.hist, h.slice(-100)); }

// ── ПАРСЕРЫ (детерминированные) ──
function parseNumber(text) { // сумма с множителями: 20000, 20 тыс, 1.5 млн
  const t = String(text || "").toLowerCase();
  const m = t.match(/(\d[\d\s.,]*)\s*(млн|миллион|тыс|тысяч|k|к|ming)?/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
  if (!isFinite(n) || n <= 0) return null;
  if (/млн|миллион/.test(m[2] || "")) n *= 1e6; else if (/тыс|тысяч|k|к|ming/.test(m[2] || "")) n *= 1e3;
  return Math.round(n);
}
export function parseMargin(text) {
  const t = String(text || "").toLowerCase();
  const m = t.match(/(\d+(?:[.,]\d+)?)\s*%|(\d+(?:[.,]\d+)?)\s*процент/);
  const v = m ? parseFloat((m[1] || m[2]).replace(",", ".")) : null;
  if (v == null || !(v >= 0 && v <= 100)) return { ok: false, error: "маржа должна быть числом 0–100%" };
  return { ok: true, value: +v.toFixed(1), raw: String(text).slice(0, 160) };
}
export function parseCpl(text) {
  const v = parseNumber(text);
  if (v == null) return { ok: false, error: "укажите ориентир цены лида числом, напр. «20 000 сум»" };
  return { ok: true, value: v, raw: String(text).slice(0, 160) };
}
// график: LLM (редко, разово) + разумный дефолт-фолбэк
export async function parseSchedule(text) {
  const t = String(text || "").toLowerCase();
  // быстрый regex для частых форм
  const days = [];
  if (/пн\s*[-–]\s*сб|понедельник.*суббот/.test(t)) days.push(1, 2, 3, 4, 5, 6);
  else if (/пн\s*[-–]\s*пт|будни|рабочие дни/.test(t)) days.push(1, 2, 3, 4, 5);
  else if (/каждый день|без выходных|7 дней/.test(t)) days.push(0, 1, 2, 3, 4, 5, 6);
  const tm = t.match(/с?\s*(\d{1,2})[:.]?(\d{2})?\s*(?:до|[-–])\s*(\d{1,2})[:.]?(\d{2})?/);
  const pad = (h, mm) => `${String(h).padStart(2, "0")}:${mm || "00"}`;
  if (days.length && tm) return { ok: true, workdays: days, workStart: pad(tm[1], tm[2]), workEnd: pad(tm[3], tm[4]), raw: String(text).slice(0, 160) };
  if (!AKEY) return { ok: false, error: "не разобрал график — укажите дни и часы, напр. «пн-сб с 10 до 20»" };
  try {
    const sys = `Извлеки рабочий график. Верни СТРОГО JSON: {"workdays":[числа 0-6, 0=Вс],"workStart":"HH:MM","workEnd":"HH:MM"}. Если не смог — {"workdays":null}.`;
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: MODEL, max_tokens: 150, system: sys, messages: [{ role: "user", content: String(text).slice(0, 200) }] }) });
    const d = await r.json();
    const o = JSON.parse((d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim());
    if (!o || !Array.isArray(o.workdays) || !o.workdays.length) return { ok: false, error: "не разобрал график — укажите дни и часы" };
    return { ok: true, workdays: o.workdays, workStart: o.workStart || "10:00", workEnd: o.workEnd || "20:00", raw: String(text).slice(0, 160) };
  } catch (e) { return { ok: false, error: "не разобрал график" }; }
}

// ── SET ──
export async function setMargin(value, source = "manual", raw = "") {
  const biz = await getBizSettings();
  const prev = biz.margin || null;
  biz.margin = { value, source, setAt: Date.now(), raw };
  await rsetJSON(K.biz, biz);
  await mirror({ margin: value, marginSource: source, marginSetAt: Date.now() });
  await pushHist("margin", { value, source, prev: prev && prev.value });
  return biz.margin;
}
export async function setCpl(value, raw = "") {
  const biz = await getBizSettings();
  biz.cplNorm = { value, setAt: Date.now(), raw };
  await rsetJSON(K.biz, biz);
  await mirror({ cplNorm: value, cplNormSetAt: Date.now() });
  await pushHist("cplNorm", { value });
  return biz.cplNorm;
}
export async function setSchedule(s, raw = "") {
  const biz = await getBizSettings();
  biz.schedule = { workdays: s.workdays, workStart: s.workStart, workEnd: s.workEnd, setAt: Date.now(), raw };
  await rsetJSON(K.biz, biz);
  await mirror({ workdays: s.workdays, workStart: s.workStart, workEnd: s.workEnd, scheduleSetAt: Date.now() });
  await pushHist("schedule", { workdays: s.workdays });
  return biz.schedule;
}

// ── ЭФФЕКТИВНАЯ МАРЖА (вариант «б»): ручной override держится в силе; авто показываем рядом ──
// autoValue передаём снаружи (у дашборда/советника уже есть авто-маржа из финансов) — не дублируем финансы тут.
export function resolveMargin(biz, autoValue) {
  const man = biz && biz.margin && biz.margin.source === "manual" ? biz.margin : null;
  if (man) {
    const conflict = autoValue != null && Math.abs(autoValue - man.value) >= 3; // «заметное расхождение» ≥3 п.п.
    return { value: man.value, source: "manual", setAt: man.setAt, autoValue: autoValue != null ? autoValue : null, override: true, conflict, stale: (Date.now() - man.setAt) > REASK.marginDays * DAY };
  }
  if (autoValue != null) return { value: autoValue, source: "auto", override: false };
  return { value: null, source: "none", override: false };
}

// какие сущности НЕ заданы или УСТАРЕЛИ (для советника — что спросить)
export async function missingSettings(hasAutoMargin) {
  const biz = await getBizSettings();
  const out = [];
  const man = biz.margin && biz.margin.source === "manual" ? biz.margin : null;
  if (!hasAutoMargin && !man) out.push({ field: "margin", severity: "blocking", why: "нужна для расчёта ROI/прибыли рекламы" });
  else if (!hasAutoMargin && man && (Date.now() - man.setAt) > REASK.marginDays * DAY) out.push({ field: "margin", severity: "reask", why: "маржа задавалась более квартала назад — актуальна ли ещё?", current: man.value });
  if (!biz.cplNorm) out.push({ field: "cplNorm", severity: "optional", why: "ориентир цены лида для сравнения с рынком" });
  else if ((Date.now() - biz.cplNorm.setAt) > REASK.cplDays * DAY) out.push({ field: "cplNorm", severity: "reask", why: "ориентир CPL старше полугода", current: biz.cplNorm.value });
  if (!biz.schedule) out.push({ field: "schedule", severity: "optional", why: "рабочий график для расчёта темпа к цели" });
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "get";
  const sess = await getSession(q.session || b.session);
  const isAdmin = !!sess && sess.role === "admin";
  try {
    if (action === "get") { res.status(200).json({ ok: true, biz: await getBizSettings() }); return; }
    if (!isAdmin) { res.status(403).json({ error: "admin only" }); return; }
    if (action === "state") { res.status(200).json({ ok: true, biz: await getBizSettings(), history: await rgetJSON(K.hist, []) }); return; }
    // set через text (NL) или готовое значение
    if (action === "set-margin") { const p = b.value != null ? { ok: true, value: b.value } : parseMargin(b.text || ""); if (!p.ok) { res.status(400).json(p); return; } res.status(200).json({ ok: true, margin: await setMargin(p.value, "manual", p.raw || "") }); return; }
    if (action === "set-cpl") { const p = b.value != null ? { ok: true, value: b.value } : parseCpl(b.text || ""); if (!p.ok) { res.status(400).json(p); return; } res.status(200).json({ ok: true, cplNorm: await setCpl(p.value, p.raw || "") }); return; }
    if (action === "set-schedule") { const p = b.workdays ? { ok: true, workdays: b.workdays, workStart: b.workStart, workEnd: b.workEnd } : await parseSchedule(b.text || ""); if (!p.ok) { res.status(400).json(p); return; } res.status(200).json({ ok: true, schedule: await setSchedule(p) }); return; }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
