// /api/finance.js — читает финансы из Google Sheets по ключевым словам.
// Умный парсинг: ищет строки TUSHUM (выручка), Umumiy xarajatlar (расходы), Sof foyda (прибыль)
// независимо от их позиции — структура месяцев может отличаться.

const SHEET_ID = process.env.FINANCE_SHEET_ID || "1BaL64eyjfPSE36VY49jP5--Sn4lFQmdx1-zYm_Sarr8";

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

async function fetchSheetList() {
  // gviz возвращает JSON с названиями листов через отдельный запрос
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`;
    const r = await fetch(url, { redirect: "follow" });
    const text = await r.text();
    // ответ обёрнут в google.visualization.Query.setResponse(...)
    const m = text.match(/setResponse\(([\s\S]*)\)/);
    if (!m) return [];
    const json = JSON.parse(m[1]);
    // список листов тут не приходит напрямую; вернём пусто, листы задаём на фронте
    return [];
  } catch (e) { return []; }
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    const sheetName = (req.query && req.query.month) || (req.body && req.body.month) || "";
    let csv;
    try {
      csv = await fetchSheetCSV(sheetName);
    } catch (e) {
      if (String(e).includes("NO_ACCESS")) {
        res.status(200).json({ ok: false, error: "no_access", msg: "Таблица закрыта. Откройте доступ «по ссылке — просмотр»." });
        return;
      }
      throw e;
    }

    const rows = parseCSV(csv);
    const revenue = findByKeys(rows, KEYS.revenue);
    const expenses = findByKeys(rows, KEYS.expenses);
    let profit = findByKeys(rows, KEYS.profit);
    const tax = findByKeys(rows, KEYS.tax);

    // если прибыль не нашли, но есть выручка и расходы — считаем сами
    if (profit == null && revenue != null && expenses != null) profit = revenue - expenses;

    const margin = (revenue && profit != null) ? +(profit / revenue * 100).toFixed(1) : null;

    // список листов (месяцев) — попробуем вытащить из первого запроса метаданных
    res.status(200).json({
      ok: true,
      month: sheetName || "текущий",
      revenue, expenses, profit, tax, margin,
      found: { revenue: revenue != null, expenses: expenses != null, profit: profit != null },
    });
  } catch (err) {
    res.status(500).json({ error: "finance failed", detail: String(err) });
  }
}
