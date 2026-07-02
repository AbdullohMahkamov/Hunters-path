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

async function fetchSheetCSV(sheetName) {
  // экспорт конкретного листа в CSV
  const base = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
  const url = sheetName ? `${base}&sheet=${encodeURIComponent(sheetName)}` : base;
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error("Sheet fetch failed: " + r.status);
  const text = await r.text();
  // если Google вернул HTML (нет доступа) — это не CSV
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

// читает один лист и возвращает {revenue,expenses,profit,tax,margin,found} или {error}
async function readMonth(tab) {
  let csv;
  try {
    csv = await fetchSheetCSV(tab);
  } catch (e) {
    if (String(e).includes("NO_ACCESS")) return { error: "no_access" };
    return { error: "fetch_failed" };
  }
  const rows = parseCSV(csv);
  const revenue = findByKeys(rows, KEYS.revenue);
  const expenses = findByKeys(rows, KEYS.expenses);
  let profit = findByKeys(rows, KEYS.profit);
  const tax = findByKeys(rows, KEYS.tax);
  if (profit == null && revenue != null && expenses != null) profit = revenue - expenses;
  const margin = (revenue && profit != null) ? +(profit / revenue * 100).toFixed(1) : null;
  return { revenue, expenses, profit, tax, margin, found: { revenue: revenue != null, expenses: expenses != null, profit: profit != null } };
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const action = (req.body && req.body.action) || (req.query && req.query.action) || "";
    const curMonth = new Date().getMonth() + 1;

    // список месяцев (для дропдауна) — известные листы + пометка текущего
    if (action === "list") {
      const months = MONTHS.map(mo => ({ tab: mo.tab, label: mo.label, labelUz: mo.labelUz, m: mo.m, current: mo.m === curMonth }));
      res.status(200).json({ ok: true, months, currentMonth: curMonth });
      return;
    }

    // годовая динамика — читаем все месяцы до текущего включительно
    if (action === "year") {
      const list = MONTHS.filter(mo => mo.m <= curMonth);
      const results = [];
      for (const mo of list) {
        const r = await readMonth(mo.tab);
        if (r.error === "no_access") { res.status(200).json({ ok: false, error: "no_access" }); return; }
        // включаем месяц только если нашли хоть выручку или прибыль
        if (r.revenue != null || r.profit != null) {
          results.push({ month: mo.label, monthUz: mo.labelUz, m: mo.m, revenue: r.revenue, expenses: r.expenses, profit: r.profit, margin: r.margin });
        }
      }
      res.status(200).json({ ok: true, year: results });
      return;
    }

    // один месяц: указанный tab, или текущий по умолчанию
    let tab = (req.body && req.body.month) || (req.query && req.query.month) || "";
    if (!tab) {
      const cur = MONTHS.find(mo => mo.m === curMonth);
      tab = cur ? cur.tab : (MONTHS[MONTHS.length - 1] ? MONTHS[MONTHS.length - 1].tab : "");
    }
    const r = await readMonth(tab);
    if (r.error === "no_access") { res.status(200).json({ ok: false, error: "no_access" }); return; }
    if (r.error) { res.status(200).json({ ok: false, error: r.error }); return; }
    const moInfo = MONTHS.find(mo => mo.tab === tab);
    res.status(200).json({
      ok: true,
      month: moInfo ? moInfo.label : tab,
      monthUz: moInfo ? moInfo.labelUz : tab,
      tab,
      revenue: r.revenue, expenses: r.expenses, profit: r.profit, tax: r.tax, margin: r.margin,
      found: r.found,
    });
  } catch (err) {
    res.status(500).json({ error: "finance failed", detail: String(err) });
  }
}
