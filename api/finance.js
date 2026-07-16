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
    if (!d || d.result == null) return null;
    // result — это строка (наш JSON). Парсим один раз.
    return typeof d.result === "string" ? JSON.parse(d.result) : d.result;
  } catch (e) { return null; }
}
async function cacheSet(key, val, ttlSec) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    // Upstash REST: значение передаём как СЫРОЕ тело запроса (не оборачиваем повторно)
    const body = JSON.stringify(val);
    const path = ttlSec
      ? `${url}/set/${encodeURIComponent(key)}?EX=${ttlSec}`
      : `${url}/set/${encodeURIComponent(key)}`;
    const resp = await fetch(path, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: body,
    });
    return resp.ok;
  } catch (e) { return false; }
}
// сырые (строковые) варианты — для текста анализа, без JSON-обёртки
async function cacheGetRaw(key) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    return d && typeof d.result === "string" ? d.result : null;
  } catch (e) { return null; }
}
async function cacheSetRaw(key, val, ttlSec) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try {
    const path = ttlSec ? `${url}/set/${encodeURIComponent(key)}?EX=${ttlSec}` : `${url}/set/${encodeURIComponent(key)}`;
    await fetch(path, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: val });
  } catch (e) { /* не критично */ }
}

// ===== ИИ-ЧТЕНИЕ ФИНАНСОВ =====
// Claude смотрит на CSV любой структуры и вытаскивает выручку/расходы/прибыль/налог.
async function aiReadFinance(csv) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { error: "no_api_key" };
  // ограничим размер, чтобы не гнать лишние токены
  const clipped = csv.slice(0, 8000);
  const SYSTEM = `Ты финансовый аналитик. На вход — таблица финансов бизнеса за месяц в CSV (узбекский/русский, любая структура).
Верни СТРОГО JSON без markdown, без пояснений:
{
 "revenue": число_или_null,
 "expenses": число_или_null,
 "profit": число_или_null,
 "tax": число_или_null,
 "profitAfterShares": число_или_null,
 "breakdown": [{"name":"статья","amount":число}]
}
Правила:
- revenue = общая выручка/доход (tushum, daromad, выручка)
- expenses = ОБЩИЕ расходы (umumiy xarajatlar, jami xarajat, всего расходов)
- profit = чистая прибыль ДО распределения долей (sof foyda, чистая прибыль)
- profitAfterShares = остаток ПОСЛЕ вычета долей учредителей, если в таблице есть такая строка (например «qoldiq», «остаток», распределение по учредителям). Если такой строки нет — null
- tax = налог (soliq)
- breakdown = список ОТДЕЛЬНЫХ статей расходов с суммами (маркетинг, зарплаты, аренда, реклама, таргет, AMOCRM и т.д.) — каждая строка расхода отдельно, БЕЗ итоговой суммы. Максимум 20 статей. Только реальные строки из таблицы.
ВАЖНО: бери числа ТОЛЬКО из таблицы. НИКОГДА не выдумывай и не округляй. Нет значения — null (или [] для breakdown). Не подставляй примерные числа. Числа — только цифры без пробелов/валют. Отрицательные (убыток) сохраняй.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: SYSTEM,
        messages: [{ role: "user", content: "CSV финансов:\n" + clipped }],
      }),
    });
    if (!r.ok) return { error: "ai_error" };
    const data = await r.json();
    let text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(text);
    let breakdown = [];
    if (Array.isArray(parsed.breakdown)) {
      breakdown = parsed.breakdown
        .map(it => ({ name: String(it.name || "").slice(0, 60), amount: numOrNull(it.amount) }))
        .filter(it => it.name && it.amount != null)
        .slice(0, 20);
    }
    return {
      revenue: numOrNull(parsed.revenue),
      expenses: numOrNull(parsed.expenses),
      profit: numOrNull(parsed.profit),
      tax: numOrNull(parsed.tax),
      profitAfterShares: numOrNull(parsed.profitAfterShares),
      breakdown,
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
  let profitAfterShares = null, breakdown = [];
  const ai = await aiReadFinance(csv);
  if (!ai.error) {
    revenue = ai.revenue; expenses = ai.expenses; profit = ai.profit; tax = ai.tax;
    profitAfterShares = ai.profitAfterShares != null ? ai.profitAfterShares : null;
    breakdown = ai.breakdown || [];
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
  const result = { revenue, expenses, profit, tax, margin, profitAfterShares, breakdown, via, found: { revenue: revenue != null, expenses: expenses != null, profit: profit != null } };
  const ttl = opts.isCurrent ? 86400 : 2592000; // текущий — сутки, прошлые — 30 дней
  await cacheSet(cacheKey, result, ttl);
  return result;
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  try {
    // ЗАЩИТА: РОП не имеет доступа к финансам (чувствительные данные владельца)
    const session = (req.body && req.body.session) || (req.query && req.query.session) || "";
    const rurl = process.env.UPSTASH_REDIS_REST_URL, rtok = process.env.UPSTASH_REDIS_REST_TOKEN;
    let sessOrg = "hunter";
    if (session && rurl) {
      try {
        const sr = await fetch(`${rurl}/get/session:${encodeURIComponent(session)}`, { headers: { Authorization: `Bearer ${rtok}` } });
        const sd = await sr.json();
        if (sd && sd.result) {
          const info = JSON.parse(sd.result);
          if (info && info.role === "rop") { res.status(403).json({ error: "forbidden", msg: "Финансы недоступны для этой роли" }); return; }
          if (info && info.org) sessOrg = info.org;
        }
      } catch (e) { /* если проверка не удалась — продолжаем, фронт всё равно скрывает */ }
    }
    // Финансы читаются из ОДНОЙ зашитой таблицы Hunter Academy. Для любой другой org отдаём пусто,
    // иначе клиент увидел бы финансы Hunter Academy (кросс-теннант утечка). Per-org финансы — отдельно.
    if (sessOrg !== "hunter") { res.status(200).json({ ok: true, notConfigured: true, org: sessOrg }); return; }

    const action = (req.body && req.body.action) || (req.query && req.query.action) || "";
    const curMonth = new Date().getMonth() + 1;

    // ИИ-АНАЛИЗ финансов (перенесён из finance-analyze для экономии функций на Hobby-плане)
    if (action === "analyze") {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set" }); return; }
      const fin = (req.body && req.body.fin) || null;
      const lang = (req.body && req.body.lang) || "ru";
      const force = !!(req.body && req.body.force);
      if (!fin) { res.status(400).json({ error: "no finance data" }); return; }
      const sig = `${fin.month || "?"}_${fin.revenue || 0}_${fin.expenses || 0}_${fin.profit || 0}`;
      const aiKey = `finai:v2:${lang}:${sig}`;
      if (!force) {
        const cachedRaw = await cacheGetRaw(aiKey);
        if (cachedRaw) { res.status(200).json({ ok: true, analysis: cachedRaw, cached: true }); return; }
      }
      const fmt = n => n == null ? "нет данных" : new Intl.NumberFormat("ru-RU").format(Math.round(n));
      let finText = `Месяц: ${fin.month || "?"}\nВыручка: ${fmt(fin.revenue)}\nОбщие расходы: ${fmt(fin.expenses)}\nЧистая прибыль (до долей): ${fmt(fin.profit)}\n`;
      if (fin.margin != null) finText += `Рентабельность: ${fin.margin}%\n`;
      if (fin.tax != null) finText += `Налог: ${fmt(fin.tax)}\n`;
      if (fin.profitAfterShares != null) finText += `Остаток после долей: ${fmt(fin.profitAfterShares)}\n`;
      if (Array.isArray(fin.breakdown) && fin.breakdown.length) {
        finText += "\nРасходы по статьям:\n" + fin.breakdown.map(b => `- ${b.name}: ${fmt(b.amount)}`).join("\n");
      }
      // Продажи из CRM подмешиваем ТОЛЬКО для текущего месяца — иначе периоды не совпадают
      // (финансы за прошлый месяц + CRM за текущий = ложные выводы).
      const curNameForSales = new Date().toLocaleString("ru-RU", { month: "long" });
      const isCurrentMonth = (fin.month || "").toLowerCase().includes(curNameForSales.toLowerCase());
      let salesText = "";
      if (isCurrentMonth) {
        const dash = await cacheGet("dashboard");
        if (dash && dash.totals) {
          const t = dash.totals;
          salesText = `\n\nДанные продаж из CRM (текущий месяц, совпадает с финансами):\n- Продаж: ${t.sold}, выручка ${fmt(t.revenue)}\n- Конверсия: ${t.conv}%, средний чек ${fmt(t.avgCheck)}\n- Потеря лидов до контакта: ${t.noContactPct}%`;
        }
      }
      const SYSTEM = `Ты — финансовый директор школы продаж. Проанализируй финансы месяца и дай ЧЁТКИЙ практичный разбор для владельца.

ВАЖНО про данные: анализируй ТОЛЬКО цифры за указанный месяц. Выручка в финансовой таблице = это и есть продажи месяца в деньгах. Оценивай окупаемость рекламы по выручке ЭТОГО ЖЕ месяца из таблицы (реклама X против выручки месяца). ${isCurrentMonth ? "Данные CRM ниже относятся к тому же (текущему) месяцу — можно использовать." : "Данных CRM по продажам за этот месяц НЕТ — не выдумывай число продаж, конверсию или потерю лидов. Анализируй только по финансовой таблице (выручка, расходы, прибыль)."}

Структура ответа (markdown, коротко и по делу):
## Общая оценка
1-2 предложения: прибыльный/убыточный месяц, здоровая ли ситуация.
## Куда уходят деньги
2-3 самые крупные статьи расходов и их доля. Что раздуто.
## Где оптимизировать
2-3 КОНКРЕТНЫХ действия: что урезать, где неэффективно. Окупаемость рекламы считай по выручке ЭТОГО месяца из таблицы.
## Вывод
1 главная рекомендация на следующий месяц.

Пиши прямо, цифрами, без воды. Не притягивай данные из других месяцев. ${lang === "uz" ? "Отвечай ПО-УЗБЕКСКИ (латиница)." : "Отвечай ПО-РУССКИ."}`;
      const USER = `ФИНАНСЫ ЗА МЕСЯЦ «${fin.month || "?"}»:\n${finText}${salesText}\n\nСделай разбор строго по этим данным.`;
      const ar = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 1200, system: SYSTEM, messages: [{ role: "user", content: USER }] }),
      });
      if (!ar.ok) { const t = await ar.text(); res.status(ar.status).json({ error: "Anthropic error", detail: t }); return; }
      const adata = await ar.json();
      const atext = (adata.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      const curName = new Date().toLocaleString("ru-RU", { month: "long" });
      const isCur = (fin.month || "").toLowerCase().includes(curName.toLowerCase());
      await cacheSetRaw(aiKey, atext, isCur ? 86400 : 2592000);
      res.status(200).json({ ok: true, analysis: atext });
      return;
    }


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
      // ОПТИМИЗАЦИЯ: читаем месяцы ПАРАЛЛЕЛЬНО пулами по 4 (было строго последовательно →
      // на холодном кэше N AI-вызовов подряд). Кэш защищает от повторов; порядок сохраняем.
      const settled = [];
      const POOL = 4;
      for (let i = 0; i < list.length; i += POOL) {
        const chunk = await Promise.all(list.slice(i, i + POOL).map(async (mo) => {
          const real = realTabs.find(t => t.toLowerCase().includes(mo.labelUz.toLowerCase())) || mo.tab;
          const r = await readMonth(real, { isCurrent: mo.m === curMonth });
          return { mo, r };
        }));
        settled.push(...chunk);
      }
      if (settled.some(({ r }) => r.error === "no_access")) { res.status(200).json({ ok: false, error: "no_access" }); return; }
      const results = settled
        .filter(({ r }) => r.revenue != null || r.profit != null)
        .map(({ mo, r }) => ({ month: mo.label, monthUz: mo.labelUz, m: mo.m, revenue: r.revenue, expenses: r.expenses, profit: r.profit, margin: r.margin }));
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
      profitAfterShares: r.profitAfterShares, breakdown: r.breakdown || [],
      found: r.found,
    });
  } catch (err) {
    res.status(500).json({ error: "finance failed", detail: String(err) });
  }
}
