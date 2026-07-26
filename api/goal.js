// api/goal.js — УПРАВЛЯЕМЫЙ ОБЪЕКТ ЦЕЛИ + NL-парсер. Фундамент планировщика (planner.js) и дневного отчёта.
// Раньше цель была числом (metricscfg.goal). Теперь — структура goal:<org> {amount,currency,period,metric,scope}.
// ОБРАТНАЯ СОВМЕСТИМОСТЬ: при set дублируем amountUZS в metricscfg.goal — существующие форекаст/дашборд/чат
// продолжают читать число как раньше, ничего не ломается.
//
// ДИСЦИПЛИНА: числа НЕ выдумываем LLM — сумму/период тянем детерминированно (regex), LLM лишь ИНТЕРПРЕТИРУЕТ
// нечёткую формулировку (метрика/подразделение) и как фолбэк, если regex не распознал сумму.

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const ORG = "hunter";
const USD_UZS = Number(process.env.USD_UZS_RATE) || 12100;
const MODEL = "claude-haiku-4-5-20251001"; // разбор цели — routine, лёгкая модель

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

const K = { goal: `goal:${ORG}` };

// ── ПЕРИОД ──
const MONTHS_RU = ["январ", "феврал", "март", "апрел", "ма", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
function tkNow() { return new Date(Date.now() + 5 * 3600000); }
function monthPeriod(year, monthIdx) {
  const start = new Date(Date.UTC(year, monthIdx, 1));
  const end = new Date(Date.UTC(year, monthIdx + 1, 0)); // последний день месяца
  const label = `${["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"][monthIdx]} ${year}`;
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10), label, kind: "month" };
}
function currentMonthPeriod() { const n = tkNow(); return monthPeriod(n.getUTCFullYear(), n.getUTCMonth()); }
// период из текста: «в июле» / «за этот месяц» / «в следующем месяце»; иначе — текущий месяц
function parsePeriod(text) {
  const t = String(text || "").toLowerCase();
  const n = tkNow();
  if (/следующ\w* месяц|keyingi oy/.test(t)) return monthPeriod(n.getUTCFullYear(), n.getUTCMonth() + 1);
  if (/этот месяц|текущ\w* месяц|shu oy|bu oy/.test(t)) return currentMonthPeriod();
  for (let i = 0; i < 12; i++) if (t.includes(MONTHS_RU[i])) { const y = (i < n.getUTCMonth() ? n.getUTCFullYear() + 1 : n.getUTCFullYear()); return monthPeriod(y, i); }
  return currentMonthPeriod();
}

// ── СУММА + ВАЛЮТА (детерминированно) ──
// поддержка: $100k, $100 000, 100000 сум, 1.5 млрд, 200 млн, 100к
function parseAmount(text) {
  const t = String(text || "").replace(/ /g, " ").toLowerCase();
  const isUsd = /\$|доллар|usd|dollar/.test(t);
  // ищем число с возможным множителем
  const m = t.match(/(\d[\d\s.,]*)\s*(млрд|миллиард|mlrd|млн|миллион|mln|тыс|тысяч|k|к|min|ming)?/i);
  if (!m) return null;
  let num = parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
  if (!isFinite(num) || num <= 0) return null;
  const mult = m[2] || "";
  if (/млрд|миллиард|mlrd/.test(mult)) num *= 1e9;
  else if (/млн|миллион|mln|min/.test(mult)) num *= 1e6;
  else if (/тыс|тысяч|k|к|ming/.test(mult)) num *= 1e3;
  const currency = isUsd ? "USD" : "UZS";
  const amountUZS = currency === "USD" ? Math.round(num * USD_UZS) : Math.round(num);
  return { amount: Math.round(num), currency, amountUZS, rate: currency === "USD" ? USD_UZS : 1 };
}

// метрика: по умолчанию revenue (выручка). «продаж»/«сделок» → sales_count.
function parseMetric(text) {
  const t = String(text || "").toLowerCase();
  if (/продаж|сделок|sotuv|клиент/.test(t) && !/выручк|оборот|доход|\$|сум|млн|млрд/.test(t)) return "sales_count";
  return "revenue";
}

// ── ПАРСЕР ЦЕЛИ (детерминированный, с LLM-фолбэком на нераспознанную сумму) ──
export async function parseGoalText(text) {
  const amt = parseAmount(text);
  const period = parsePeriod(text);
  const metric = parseMetric(text);
  if (amt) {
    return {
      ok: true, source: "regex",
      amount: amt.amount, currency: amt.currency, amountUZS: amt.amountUZS, rate: amt.rate,
      metric, period, scope: "company",
      raw: String(text || "").slice(0, 300),
    };
  }
  // сумма не распознана regex-ом → просим LLM ИНТЕРПРЕТИРОВАТЬ (не считать) — вернуть число+валюту+период
  if (!AKEY) return { ok: false, error: "не распознал сумму цели (укажите число, напр. «$100 000» или «1 200 000 000 сум»)" };
  try {
    const sys = `Ты извлекаешь ФИНАНСОВУЮ ЦЕЛЬ из фразы владельца. Верни СТРОГО JSON без markdown:
{"amount":число,"currency":"USD|UZS","metric":"revenue|sales_count","monthOffset":0}
amount — только число (без множителей словами: 100k→100000, 1.5 млрд→1500000000). monthOffset: 0=этот месяц,1=следующий, -1 и т.д. Если периода нет — 0. Если не смог — {"amount":null}.`;
    const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" }, body: JSON.stringify({ model: MODEL, max_tokens: 200, system: sys, messages: [{ role: "user", content: String(text || "").slice(0, 300) }] }) });
    const d = await r.json();
    const txt = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim();
    const o = JSON.parse(txt);
    if (!o || o.amount == null || !(o.amount > 0)) return { ok: false, error: "не распознал сумму цели — переформулируйте с числом" };
    const currency = o.currency === "USD" ? "USD" : "UZS";
    const amountUZS = currency === "USD" ? Math.round(o.amount * USD_UZS) : Math.round(o.amount);
    const n = tkNow(); const period = monthPeriod(n.getUTCFullYear(), n.getUTCMonth() + (Number(o.monthOffset) || 0));
    return { ok: true, source: "llm", amount: Math.round(o.amount), currency, amountUZS, rate: currency === "USD" ? USD_UZS : 1, metric: o.metric === "sales_count" ? "sales_count" : "revenue", period, scope: "company", raw: String(text || "").slice(0, 300) };
  } catch (e) { return { ok: false, error: "не распознал цель — укажите сумму и период" }; }
}

export async function getGoal(org = ORG) { return await rgetJSON(K.goal, null); }

// сохраняем структурный объект + дублируем amountUZS в metricscfg.goal (обратная совместимость)
export async function setGoal(g, org = ORG) {
  const rec = { ...g, org, createdAt: Date.now(), planBuiltFor: null };
  delete rec.ok; delete rec.error;
  await rsetJSON(K.goal, rec);
  try {
    const skey = `settings:${org}`; // дашборд (orgSettings) и sync-speed читают именно settings:<org>
    const cur = (await rgetJSON(skey, {})) || {};
    cur.goal = g.amountUZS; // существующие форекаст/дашборд/чат читают число в сумах
    await rsetJSON(skey, cur);
  } catch (e) { /* совместимость не критична для самого объекта */ }
  return rec;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "get";
  const sess = await getSession(q.session || b.session);
  const isAdmin = !!sess && sess.role === "admin";

  try {
    if (action === "get") { res.status(200).json({ ok: true, goal: await getGoal() }); return; }
    if (!isAdmin) { res.status(403).json({ error: "admin only" }); return; }
    // разобрать текст → предпросмотр (НЕ сохраняет), для подтверждения владельцем
    if (action === "parse") {
      const parsed = await parseGoalText(b.text || q.text || "");
      res.status(200).json(parsed);
      return;
    }
    // сохранить цель (принимает либо готовый объект b.goal, либо текст b.text → парсит и сохраняет)
    if (action === "set") {
      let g = b.goal;
      if (!g) { g = await parseGoalText(b.text || ""); if (!g.ok) { res.status(400).json(g); return; } }
      const saved = await setGoal(g);
      res.status(200).json({ ok: true, goal: saved });
      return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
