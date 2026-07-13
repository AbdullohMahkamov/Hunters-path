// /api/growth-agent.js — GROWTH AGENT («Агент Б»). Только для админа (основателя).
// Ищет ГИПОТЕЗЫ РОСТА для одного клиента, используя ТОЛЬКО verified-метрики от Dev-Agent
// (Агент А) + внешние источники (web_search). НЕ клиентская фича.
//
// ══════════════ АРХИТЕКТУРНОЕ ПРАВИЛО (жёстко) ══════════════
//  Growth Agent НЕ читает сырые данные напрямую. Он получает воронку через getVerifiedFunnel()
//  из dev-agent.js с trust-статусами. Гипотезу можно строить ТОЛЬКО на 'verified' переходе.
//  Если переход suspicious/insufficient — агент обязан явно написать «не диагностируется,
//  данные ненадёжны», а НЕ строить гипотезу.
//
//  Права: читать verified-метрики (через Dev-Agent), web_search, писать в growthagent:*.
//  НЕ может: читать suspicious/insufficient как основание, запускать что-либо на живых данных,
//  менять код/конфиг клиента, деплоить. Решение о запуске эксперимента принимает человек.
//
// ФАЗА (тестовая, 1 клиент Hunter Academy): ежедневный прогон. Частота — через config.cadence
// (или env GROWTH_CADENCE): 'daily' сейчас, 'weekly' на MVP. Telegram-отправки НЕТ на этой фазе
// (только UI /dev-agent, вкладка Growth Agent). Смена частоты/Telegram — следующая итерация,
// логику переписывать не нужно: меняется расписание cron + cadence, добавляется отправка.

import { getVerifiedFunnel } from "./dev-agent.js";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";

const K = { hypotheses: "growthagent:hypotheses", tested: "growthagent:tested", sources: "growthagent:sources", lastRun: "growthagent:lastRun", config: "growthagent:config" };
const CAP = { hypotheses: 40, tested: 120, sources: 120 };

// Дефолт-конфиг. Пороги/частота — не хардкод, через админку (growthagent:config).
const DEFAULT_CONFIG = {
  clientOrg: "hunter",                                  // полигон: Hunter Academy (org=hunter). Расширяемо client_id позже.
  niche: "онлайн-образование, продажа онлайн-курсов (edtech), B2C",
  cadence: process.env.GROWTH_CADENCE || "daily",       // 'daily' (тест-фаза) | 'weekly' (MVP) — легко переключить
  cronDay: 1,                                           // для weekly: 1=Пн (МСК)
  webMaxSearches: 4,                                    // 3-4 запроса за прогон
  searchDedupDays: 3,                                   // не повторять тему поиска, если искалась за N дней
};

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function rdel(key) { try { await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); } catch (e) {} }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }

let _idc = 0;
function newId(p) { _idc++; return `${p}_${Date.now().toString(36)}_${_idc}`; }
function mskNow() { return new Date(Date.now() + 3 * 3600000); }
function dayKey() { return mskNow().toISOString().slice(0, 10); }
function weekKey() { const d = mskNow(); const oneJan = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); const days = Math.floor((d - oneJan) / 86400000); const w = Math.ceil((days + oneJan.getUTCDay() + 1) / 7); return `${d.getUTCFullYear()}-W${w}`; }
async function getConfig() { const c = await rgetJSON(K.config, null); return { ...DEFAULT_CONFIG, ...(c || {}) }; }

const SYSTEM = `Ты — Growth-аналитик (Агент Б) для SaaS Hunter AI. Твоя задача — находить ГИПОТЕЗЫ РОСТА продаж для ОДНОГО клиента, сопоставляя его воронку с внешними бенчмарками.

ЖЁСТКИЕ ПРАВИЛА (нарушать нельзя):
1. Ты строишь гипотезу ТОЛЬКО на переходе воронки со статусом trust="verified". Если переход "suspicious" или "insufficient" — НЕ выдвигай гипотезу по нему, а явно добавь в "undiagnosable" строку вида «этап X не диагностируется — данные ненадёжны/недостаточны».
2. Ты НЕ предлагаешь запускать эксперимент на живых менеджерах. Только формулируешь гипотезу и способ её проверить НА ДАННЫХ клиента. Решение о запуске принимает человек.
3. web_search: 3-4 КОНКРЕТНЫХ запроса про бенчмарки/причины для НИШИ клиента (не общие «как поднять продажи»). НИКОГДА не упоминай в запросах реальное название компании — только нишу и метрику. Не повторяй темы, которые уже искались недавно (список дам) — используй уже найденное или бери новый угол.
4. Каждая гипотеза строго в формате полей: observation (verified-факт клиента с цифрой), benchmark (внешний ориентир с диапазоном), source (что за источник), cause (гипотеза причины: вероятно X, потому что Y), howToVerify (конкретный измеримый способ проверки на данных клиента), confidence (low|medium|high — тем выше, чем больше внешних источников совпадают).

Пиши по-русски, коротко, честно. Если данных на verified-гипотезу нет вообще — так и скажи, не выдумывай.

ФОРМАТ ОТВЕТА — строго JSON, без markdown и текста вокруг:
{
  "hypotheses":[{"observation":"...","benchmark":"...","source":"...","cause":"...","howToVerify":"...","confidence":"low|medium|high"}],
  "undiagnosable":["этап ... не диагностируется — ..."],
  "report":"краткий вывод для основателя (3-8 строк)"
}
1-3 гипотезы максимум. Источники цитируй через web_search — их соберёт система.`;

function buildUser({ funnel, niche, recentQueries, tested, openHyps }) {
  return `КЛИЕНТ (ниша, обезличенно): ${niche}

ВОРОНКА С TRUST-СТАТУСАМИ (от Dev-Agent, Агент А). Строй гипотезы ТОЛЬКО на trust="verified":
${JSON.stringify(funnel)}

Узкое место (худший verified-переход): ${funnel.bottleneck ? JSON.stringify(funnel.bottleneck) : "не определено на verified-данных"}
Переходы, которые НЕЛЬЗЯ диагностировать (suspicious/insufficient): ${JSON.stringify(funnel.undiagnosable)}

УЖЕ ПРОВЕРЕНО РАНЕЕ (не переоткрывай, учись на результатах): ${JSON.stringify((tested || []).slice(-15).map((x) => ({ cause: x.cause, result: x.result })))}
ОТКРЫТЫЕ ГИПОТЕЗЫ (не дублируй, можешь уточнить): ${JSON.stringify((openHyps || []).map((h) => h.cause))}
ТЕМЫ, УЖЕ ИСКАННЫЕ ЗА ПОСЛЕДНИЕ ДНИ (НЕ повторяй эти запросы): ${JSON.stringify(recentQueries || [])}

ЗАДАЧА:
1. Возьми verified-узкое место воронки.
2. Сделай 3-4 web_search по бенчмаркам/причинам для ниши (обезличенно, новые углы).
3. Сопоставь: разрыв клиента vs типичные причины в нише.
4. Верни 1-3 гипотезы в строгом формате + undiagnosable для ненадёжных этапов.
Строго JSON.`;
}

// извлечение текста, источников и запросов из ответа с server-tool web_search
function extractWeb(content) {
  const texts = [], searchLog = [];
  let pendingQuery = null;
  for (const bl of (content || [])) {
    if (bl.type === "text") texts.push(bl.text || "");
    else if (bl.type === "server_tool_use" && bl.name === "web_search") pendingQuery = (bl.input && bl.input.query) || null;
    else if (bl.type === "web_search_tool_result") {
      const urls = (Array.isArray(bl.content) ? bl.content : []).filter((r) => r && r.url).map((r) => ({ url: r.url, title: r.title || "" }));
      searchLog.push({ query: pendingQuery, urls, at: Date.now() });
      pendingQuery = null;
    }
  }
  return { text: texts.join("").trim(), searchLog };
}
function parseJSON(text) { let t = String(text).replace(/```json/gi, "").replace(/```/g, "").trim(); const s = t.indexOf("{"), e = t.lastIndexOf("}"); if (s >= 0 && e > s) t = t.slice(s, e + 1); return JSON.parse(t); }

async function callModelWithSearch(system, user, webMax) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 6000, system, tools: [{ type: "web_search_20250305", name: "web_search", max_uses: Math.max(1, Math.min(6, webMax || 4)) }], messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Anthropic ${r.status}: ${t.slice(0, 400)}`); }
  const d = await r.json(); const u = d.usage || {};
  return { content: d.content || [], tokens: (u.input_tokens || 0) + (u.output_tokens || 0) };
}

async function runGrowth() {
  const cfg = await getConfig();
  const org = cfg.clientOrg || "hunter";
  const funnel = await getVerifiedFunnel(org);
  // темы, уже искавшиеся за последние searchDedupDays дней — не повторять
  const sources = await rgetJSON(K.sources, []);
  const cutoff = Date.now() - (cfg.searchDedupDays || 3) * 86400000;
  const recentQueries = sources.filter((s) => (s.at || 0) >= cutoff && s.query).map((s) => s.query);
  const tested = await rgetJSON(K.tested, []);
  const openHyps = await rgetJSON(K.hypotheses, []);
  const user = buildUser({ funnel, niche: cfg.niche, recentQueries, tested, openHyps });
  const { content, tokens } = await callModelWithSearch(SYSTEM, user, cfg.webMaxSearches);
  const { text, searchLog } = extractWeb(content);
  let out; try { out = parseJSON(text); } catch (e) { return { ok: false, error: "parse_failed", raw: text.slice(0, 500) }; }

  // сохраняем источники (дедуп по url) + журнал запросов
  const srcMap = {}; for (const s of sources) if (s.url) srcMap[s.url] = s;
  const newSourceEntries = [];
  for (const log of searchLog) {
    for (const u of (log.urls || [])) { if (!srcMap[u.url]) { const e = { url: u.url, title: u.title, query: log.query || "", at: Date.now() }; srcMap[u.url] = e; newSourceEntries.push(e); } }
    // храним и «пустые» запросы (тема искалась), чтобы работал дедуп даже без сохранённых url
    if (log.query && !(log.urls || []).length) newSourceEntries.push({ url: "", title: "", query: log.query, at: Date.now() });
  }
  const allSources = [...sources, ...newSourceEntries].slice(-CAP.sources);
  await rsetJSON(K.sources, allSources);

  // новые гипотезы → в память (дедуп по cause), сохраняем существующие открытые
  const openByCause = {}; for (const h of openHyps) openByCause[String(h.cause || "").toLowerCase().slice(0, 80)] = h;
  const testedCauses = new Set(tested.map((x) => String(x.cause || "").toLowerCase().slice(0, 80)));
  const merged = [...openHyps];
  for (const h of (Array.isArray(out.hypotheses) ? out.hypotheses : [])) {
    if (!h || !h.cause) continue;
    const key = String(h.cause).toLowerCase().slice(0, 80);
    if (testedCauses.has(key)) continue;          // не переоткрываем проверенное
    if (openByCause[key]) {                         // обновляем существующую
      const ex = openByCause[key];
      Object.assign(ex, { observation: h.observation || ex.observation, benchmark: h.benchmark || ex.benchmark, source: h.source || ex.source, howToVerify: h.howToVerify || ex.howToVerify, confidence: h.confidence || ex.confidence, updated: Date.now() });
      continue;
    }
    merged.push({ id: newId("gh"), observation: h.observation || "", benchmark: h.benchmark || "", source: h.source || "", cause: h.cause, howToVerify: h.howToVerify || "", confidence: h.confidence || "low", status: "open", created: Date.now(), updated: Date.now() });
  }
  const hypotheses = merged.slice(-CAP.hypotheses);
  await rsetJSON(K.hypotheses, hypotheses);

  const report = (out.report || "Прогон завершён.").trim();
  const undiagnosable = Array.isArray(out.undiagnosable) ? out.undiagnosable : [];
  await rsetJSON(K.lastRun, { day: dayKey(), week: weekKey(), at: Date.now(), report, undiagnosable, tokens, searches: searchLog.length, hypCount: hypotheses.length });
  return { ok: true, report, undiagnosable, hypotheses: hypotheses.length, newSources: newSourceEntries.length, searches: searchLog.length, tokens };
}

// cron-tick: частота через cadence (daily сейчас, weekly позже) — дедуп по дню/неделе
async function cronTick() {
  const cfg = await getConfig();
  const last = await rgetJSON(K.lastRun, {});
  if ((cfg.cadence || "daily") === "weekly") {
    const weekday = mskNow().getUTCDay();
    if (weekday !== (cfg.cronDay ?? 1)) return { ok: true, skipped: true, reason: "не запланированный день (weekly)" };
    if (last.week === weekKey()) return { ok: true, skipped: true, reason: "уже запускался на этой неделе" };
  } else {
    if (last.day === dayKey()) return { ok: true, skipped: true, reason: "уже запускался сегодня" };
  }
  return await runGrowth();
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  if (!AKEY) { res.status(500).json({ error: "no ANTHROPIC_API_KEY" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "state";
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const isCron = cronSecret ? (authHeader === `Bearer ${cronSecret}`) : (q.cron === "1" || b.cron === true);
  const sess = await getSession(q.session || b.session);
  const isAdmin = !!sess && sess.role === "admin";
  const cronActions = new Set(["cron_tick", "run"]);
  if (!isAdmin && !(cronActions.has(action) && isCron)) { res.status(403).json({ error: "admin only (или cron с секретом)" }); return; }

  try {
    if (action === "state") {
      const cfg = await getConfig();
      const [hyps, tested, sources, lastRun] = await Promise.all([rgetJSON(K.hypotheses, []), rgetJSON(K.tested, []), rgetJSON(K.sources, []), rgetJSON(K.lastRun, null)]);
      let funnel = null; try { funnel = await getVerifiedFunnel(cfg.clientOrg || "hunter"); } catch (e) {}
      res.status(200).json({ ok: true, hypotheses: hyps, tested, sources: sources.filter((s) => s.url).slice(-40), lastRun, config: cfg, funnel });
      return;
    }
    if (action === "get_config") { res.status(200).json({ ok: true, config: await getConfig() }); return; }
    if (action === "set_config") {
      const cur = await getConfig(); const inc = b.config || {}; const next = { ...cur };
      if (typeof inc.clientOrg === "string" && inc.clientOrg.trim()) next.clientOrg = inc.clientOrg.trim();
      if (typeof inc.niche === "string" && inc.niche.trim()) next.niche = inc.niche.trim();
      if (inc.cadence === "daily" || inc.cadence === "weekly") next.cadence = inc.cadence;
      for (const k of ["cronDay", "webMaxSearches", "searchDedupDays"]) if (typeof inc[k] === "number" && isFinite(inc[k]) && inc[k] >= 0) next[k] = inc[k];
      await rsetJSON(K.config, next);
      res.status(200).json({ ok: true, config: next }); return;
    }
    // прогон: cron-триггер (не админ) НЕ отдаёт отчёт в ответе — только факт; полный результат только админу
    if (action === "run" || action === "cron_tick") {
      const r = action === "cron_tick" ? await cronTick() : await runGrowth();
      res.status(200).json(isAdmin ? r : { ok: !!r.ok, ran: !!(r.ok && !r.skipped) });
      return;
    }
    if (action === "mark_result") {
      // {hypId, result:'worked'|'failed'|'partial', note} — ТОЛЬКО человек переводит гипотезу в tested
      const result = String(b.result || "");
      if (!["worked", "failed", "partial"].includes(result)) { res.status(400).json({ error: "bad result" }); return; }
      const hyps = await rgetJSON(K.hypotheses, []);
      const item = hyps.find((h) => h.id === b.hypId);
      if (!item) { res.status(404).json({ error: "hypothesis not found" }); return; }
      const tested = await rgetJSON(K.tested, []);
      tested.push({ ...item, status: "tested", result, resultNote: b.note || "", testedAt: Date.now() });
      await rsetJSON(K.tested, tested.slice(-CAP.tested));
      await rsetJSON(K.hypotheses, hyps.filter((h) => h.id !== b.hypId));
      res.status(200).json({ ok: true }); return;
    }
    if (action === "reset") {
      await Promise.all([rdel(K.hypotheses), rdel(K.lastRun)]);
      if (b.full === true || q.full === "1") { await Promise.all([rdel(K.tested), rdel(K.sources)]); }
      res.status(200).json({ ok: true, reset: true, full: b.full === true || q.full === "1" }); return;
    }
    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
}
