// /api/finance.js — читает финансы из Google Sheets по ключевым словам.
// Умный парсинг: ищет строки TUSHUM (выручка), Umumiy xarajatlar (расходы), Sof foyda (прибыль)
// независимо от их позиции — структура месяцев может отличаться.

const SHEET_ID = process.env.FINANCE_SHEET_ID || "1BaL64eyjfPSE36VY49jP5--Sn4lFQmdx1-zYm_Sarr8";

// Известные листы-месяцы (точные названия из таблицы) + номер месяца для определения текущего.
// При добавлении нового месяца — добавить строку сюда.
const MONTHS = [
  { tab: "Xarajatlar(Mart)",  label: "Март",   labelUz: "Mart",   m: 3 },
  { tab: "Xarajatlar (Aprel)", label: "Апрель", labelUz: "Aprel",  m: 4 },
  { tab: "Xarajatlar (May)",   label: "Май",    labelUz: "May",    m: 5 },
  { tab: "Xarajatlar (Iyun)",  label: "Июнь",   labelUz: "Iyun",   m: 6 },
  { tab: "Xarajatlar (Iyul)",  label: "Июль",   labelUz: "Iyul",   m: 7 },
  { tab: "Xarajatlar (Avgust)", label: "Август", labelUz: "Avgust", m: 8 },
  { tab: "Xarajatlar (Sentabr)", label: "Сентябрь", labelUz: "Sentabr", m: 9 },
  { tab: "Xarajatlar (Oktabr)", label: "Октябрь", labelUz: "Oktabr", m: 10 },
  { tab: "Xarajatlar (Noyabr)", label: "Ноябрь", labelUz: "Noyabr", m: 11 },
  { tab: "Xarajatlar (Dekabr)", label: "Декабрь", labelUz: "Dekabr", m: 12 },
];

// Ключевые слова для поиска строк (регистронезависимо, разные варианты написания)
const KEYS = {
  revenue: ["tushum", "выручка", "доход", "revenue"],
  expenses: ["umumiy xarajat", "jami xarajat", "всего расход", "общие расход", "umumiy xarajatlar"],
  profit: ["sof foyda", "чистая прибыль", "sof daromad", "net profit"],
  tax: ["soliq", "налог", "tax"],
};

function parseCSV(text) {
  // простой CSV-парсер с учётом кавычек
  const rows = [];
  let row = [], cur = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQ = false;
      else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* skip */ }
      else cur += c;
    }
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// вытащить число из строки: "45 597 300" / "45,597,300" / "-44 691 430" -> число
function toNum(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/[^\d\-.,]/g, "").replace(/\s/g, "").replace(/,/g, "");
  if (!cleaned || cleaned === "-") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

// найти в строках значение по ключевым словам: берём первую строку, где ячейка содержит ключ,
// и первое осмысленное число в этой строке
function findByKeys(rows, keys) {
  for (const r of rows) {
    const rowText = r.join(" ").toLowerCase();
    if (keys.some(k => rowText.includes(k))) {
      // ищем число в строке (справа налево — итоговые суммы обычно в конце)
      for (let i = r.length - 1; i >= 0; i--) {
        const n = toNum(r[i]);
        if (n !== null && Math.abs(n) >= 1000) return n; // финансовые суммы крупные
      }
    }
  }
  return null;
}

// Кэш соответствия «название листа → gid» (числовой ID вкладки)
let _gidMapCache = null;
async function getGidMap() {
  if (_gidMapCache) return _gidMapCache;
  const map = {};
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview`;
    const r = await fetch(url, { redirect: "follow" });
    const html = await r.text();
    // ищем пары: id="sheet-button-<gid>" ... >Название<
    const re = /id="sheet-button-(\d+)"[^>]*>(?:<[^>]*>)*\s*([^<]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const gid = m[1];
      const name = m[2].trim();
      if (name) map[name] = gid;
    }
  } catch (e) { /* пусто */ }
  _gidMapCache = map;
  return map;
}

async function fetchSheetCSV(sheetName) {
  const gidMap = await getGidMap();
  let url;
  if (sheetName && gidMap[sheetName]) {
    // надёжный путь: экспорт по gid
    url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${gidMap[sheetName]}`;
  } else if (sheetName) {
    // запасной путь: по имени через gviz (может ошибаться)
    url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`;
  } else {
    url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  }
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error("Sheet fetch failed: " + r.status);
  const text = await r.text();
  if (text.trim().startsWith("<")) throw new Error("NO_ACCESS");
  return text;
}

async function fetchSheetTabs() {
  // Пытаемся получить названия листов через публичный экспорт.
  // Google не даёт список листов через gviz, но даёт через /pubhtml или через ошибку gid.
  // Надёжный способ: запросить страницу htmlview и вытащить названия вкладок.
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/htmlview`;
    const r = await fetch(url, { redirect: "follow" });
    const html = await r.text();
    // названия листов в htmlview лежат в элементах с id="sheet-button-..." — вытащим по тексту вкладок
    const tabs = [];
    const re = /<li[^>]*id="sheet-button-\d+"[^>]*>(?:<a[^>]*>)?([^<]+)/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = m[1].trim();
      if (name && !tabs.includes(name)) tabs.push(name);
    }
    return tabs;
  } catch (e) { return []; }
}

// ===== КЭШ (Upstash) =====
async function cacheGet(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return d && d.result != null ? JSON.parse(d.result) : null;
  } catch (e) { return null; }
}
async function cacheSet(key, val, ttlSec) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    const body = JSON.stringify(val);
    const path = ttlSec ? `${url}/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `${url}/set/${encodeURIComponent(key)}`;
    await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) { /* не критично */ }
}

// ===== ИИ-ЧТЕНИЕ ФИНАНСОВ =====
// Claude смотрит на CSV любой структуры и вытаскивает выручку/расходы/прибыль/налог.
async function aiReadFinance(csv) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "no_api_key" };
  // ограничим размер, чтобы не гнать лишние токены
  const clipped = csv.slice(0, 8000);
  const SYSTEM = `Ты финансовый аналитик. На вход — таблица финансов бизнеса за месяц в CSV (может быть на узбекском/русском, любой структуры).
Найди ключевые итоговые суммы и верни СТРОГО JSON без markdown, без пояснений:
{"revenue":число_или_null,"expenses":число_или_null,"profit":число_или_null,"tax":число_или_null}
- revenue = общая выручка/доход (tushum, daromad, выручка)
- expenses = общие расходы (umumiy xarajatlar, jami xarajat, всего расходов)
- profit = чистая прибыль (sof foyda, чистая прибыль); если её нет, посчитай revenue - expenses
- tax = налог (soliq), если есть
ВАЖНО: бери числа ТОЛЬКО из таблицы. НИКОГДА не выдумывай и не округляй. Если таблица пустая или значения нет — ставь null. Не подставляй примерные числа вроде 200000000. Числа — только цифры, без пробелов и валют. Отрицательные (убыток) сохраняй.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: SYSTEM,
        messages: [{ role: "user", content: "CSV финансов:\n" + clipped }],
      }),
    });
    if (!r.ok) return { error: "ai_error" };
    const data = await r.json();
    let text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(text);
    return {
      revenue: numOrNull(parsed.revenue),
      expenses: numOrNull(parsed.expenses),
      profit: numOrNull(parsed.profit),
      tax: numOrNull(parsed.tax),
    };
  } catch (e) { return { error: "ai_parse" }; }
}
function numOrNull(v) {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return isNaN(n) ? null : n;
}

// читает один лист: сначала кэш, потом ИИ (с кэшированием), парсер по словам — запасной вариант.
async function readMonth(tab, opts) {
  opts = opts || {};
  const cacheKey = `fin:v2:${tab}`;
  if (!opts.force) {
    const cached = await cacheGet(cacheKey);
    if (cached) return cached;
  }
  let csv;
  try {
    csv = await fetchSheetCSV(tab);
  } catch (e) {
    if (String(e).includes("NO_ACCESS")) return { error: "no_access" };
    return { error: "fetch_failed" };
  }
  let revenue = null, expenses = null, profit = null, tax = null, via = "ai";
  const ai = await aiReadFinance(csv);
  if (!ai.error) {
    revenue = ai.revenue; expenses = ai.expenses; profit = ai.profit; tax = ai.tax;
  } else {
    via = "keywords";
    const rows = parseCSV(csv);
    revenue = findByKeys(rows, KEYS.revenue);
    expenses = findByKeys(rows, KEYS.expenses);
    profit = findByKeys(rows, KEYS.profit);
    tax = findByKeys(rows, KEYS.tax);
  }
  if (profit == null && revenue != null && expenses != null) profit = revenue - expenses;
  const margin = (revenue && profit != null) ? +(profit / revenue * 100).toFixed(1) : null;
  const result = { revenue, expenses, profit, tax, margin, via, found: { revenue: revenue != null, expenses: expenses != null, profit: profit != null } };
  const ttl = opts.isCurrent ? 86400 : 2592000; // текущий — сутки, прошлые — 30 дней
  await cacheSet(cacheKey, result, ttl);
  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const action = (req.body && req.body.action) || (req.query && req.query.action) || "";
    const curMonth = new Date().getMonth() + 1;

    // ДИАГНОСТИКА: вернуть сырой CSV + карту gid, чтобы понять что реально читается
    if (action === "diag") {
      const tab = (req.body && req.body.month) || (MONTHS.find(m => m.m === curMonth) || {}).tab || "";
      const gidMap = await getGidMap();
      let csv = "", err = "";
      try { csv = await fetchSheetCSV(tab); } catch (e) { err = String(e); }
      res.status(200).json({
        ok: true, tab, gidMap, error: err,
        csvHead: csv.slice(0, 3000),
        rowCount: csv ? csv.split("\n").length : 0,
      });
      return;
    }

    // список месяцев (для дропдауна) — сопоставляем известные месяцы с реальными вкладками
    if (action === "list") {
      const gidMap = await getGidMap();
      const realTabs = Object.keys(gidMap);
      const months = [];
      for (const mo of MONTHS) {
        // ищем реальную вкладку, где встречается узбекское название месяца
        const real = realTabs.find(t => t.toLowerCase().includes(mo.labelUz.toLowerCase()));
        if (real) months.push({ tab: real, label: mo.label, labelUz: mo.labelUz, m: mo.m, current: mo.m === curMonth });
      }
      // если ничего не сопоставилось (нет gid-карты) — отдаём как есть
      if (!months.length) {
        MONTHS.forEach(mo => months.push({ tab: mo.tab, label: mo.label, labelUz: mo.labelUz, m: mo.m, current: mo.m === curMonth }));
      }
      res.status(200).json({ ok: true, months, currentMonth: curMonth });
      return;
    }

    // годовая динамика — читаем все месяцы до текущего включительно
    if (action === "year") {
      const gidMap = await getGidMap();
      const realTabs = Object.keys(gidMap);
      const list = MONTHS.filter(mo => mo.m <= curMonth);
      const results = [];
      for (const mo of list) {
        const real = realTabs.find(t => t.toLowerCase().includes(mo.labelUz.toLowerCase())) || mo.tab;
        const r = await readMonth(real, { isCurrent: mo.m === curMonth });
        if (r.error === "no_access") { res.status(200).json({ ok: false, error: "no_access" }); return; }
        if (r.revenue != null || r.profit != null) {
          results.push({ month: mo.label, monthUz: mo.labelUz, m: mo.m, revenue: r.revenue, expenses: r.expenses, profit: r.profit, margin: r.margin });
        }
      }
      res.status(200).json({ ok: true, year: results });
      return;
    }

    // один месяц: указанный tab, или текущий по умолчанию
    const gidMap2 = await getGidMap();
    const realTabs2 = Object.keys(gidMap2);
    let tab = (req.body && req.body.month) || (req.query && req.query.month) || "";
    if (!tab) {
      const cur = MONTHS.find(mo => mo.m === curMonth);
      const real = cur ? realTabs2.find(t => t.toLowerCase().includes(cur.labelUz.toLowerCase())) : null;
      tab = real || (cur ? cur.tab : (MONTHS[MONTHS.length - 1] ? MONTHS[MONTHS.length - 1].tab : ""));
    }
    // определить месяц по названию вкладки (для isCurrent и подписи)
    const moInfo0 = MONTHS.find(mo => tab.toLowerCase().includes(mo.labelUz.toLowerCase()));
    const force = !!(req.body && req.body.force);
    const r = await readMonth(tab, { isCurrent: moInfo0 && moInfo0.m === curMonth, force });
    if (r.error === "no_access") { res.status(200).json({ ok: false, error: "no_access" }); return; }
    if (r.error) { res.status(200).json({ ok: false, error: r.error }); return; }
    res.status(200).json({
      ok: true,
      month: moInfo0 ? moInfo0.label : tab,
      monthUz: moInfo0 ? moInfo0.labelUz : tab,
      tab,
      revenue: r.revenue, expenses: r.expenses, profit: r.profit, tax: r.tax, margin: r.margin,
      found: r.found,
    });
  } catch (err) {
    res.status(500).json({ error: "finance failed", detail: String(err) });
  }
}
