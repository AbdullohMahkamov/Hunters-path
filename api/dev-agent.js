// /api/dev-agent.js — ВНУТРЕННИЙ агент-ревизор Hunter AI с постоянной памятью.
// Только для админа (основателя). НЕ клиентская фича. Он ПРЕДЛАГАЕТ — решает человек.
//
// Права (жёстко): читает всё (read-only), пишет ТОЛЬКО в devagent:*.
// Никогда не трогает продакшн-данные, код или конфиги. Выход по фиксам — готовый промпт
// для Claude Code, который человек вставляет сам.
//
// Компромиссы против исходного ТЗ (serverless-реальность):
//  • git log за сутки — не через git CLI (в функции нет репо), а через GitHub API (read-only).
//    Нужен env GITHUB_TOKEN (для приватного репо) + GITHUB_REPO (по умолчанию наш). Нет токена —
//    секция git пустая с пометкой.
//  • «агрегаты за сутки» — из уже существующих кэшей Redis (dashboard/speed/tg), а не отдельный ETL.
//  • cron-аутентификация — по заголовку Authorization: Bearer $CRON_SECRET (стандарт Vercel Cron);
//    если CRON_SECRET не задан — допускаем вызов с ?cron=1 (graceful).
//
// Actions:
//  GET  ?action=state            — вся память для UI (admin)
//  POST {action:'chat', text}    — дневная переписка (admin), пишет в devagent:chat
//  POST {action:'nightly'}       — ночной прогон (admin вручную ИЛИ cron)
//  POST {action:'weekly_review'} — недельная ревизия памяти (admin ИЛИ cron)
//  POST {action:'decision', ...} — решение человека по находке/гипотезе (admin)
//  POST {action:'reset', full?}  — сброс памяти агента (admin)

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const MODEL = "claude-sonnet-5";

const K = {
  findings: "devagent:findings",
  hypotheses: "devagent:hypotheses",
  decisions: "devagent:decisions",
  fixed: "devagent:fixed",
  chat: "devagent:chat",
  conflog: "devagent:conflog", // журнал изменений confidence (защита от дрейфа)
};
const CAP = { findings: 60, hypotheses: 60, decisions: 200, fixed: 120, chat: 240, conflog: 300 };

async function rget(key) {
  try {
    const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
    const d = await r.json();
    return d && d.result != null ? d.result : null;
  } catch (e) { return null; }
}
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, value) {
  try {
    await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(value) });
    return true;
  } catch (e) { return false; }
}
async function rdel(key) { try { await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); } catch (e) {} }

async function getSession(session) {
  if (!session) return null;
  try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

// стабильный id без Math.random (детерминируем от времени + счётчика)
let _idc = 0;
function newId(prefix) { _idc++; return `${prefix}_${Date.now().toString(36)}_${_idc}`; }

// ── ПАМЯТЬ ──
async function readMemory() {
  const [findings, hypotheses, decisions, fixed, chat] = await Promise.all([
    rgetJSON(K.findings, []), rgetJSON(K.hypotheses, []), rgetJSON(K.decisions, []), rgetJSON(K.fixed, []), rgetJSON(K.chat, []),
  ]);
  return { findings, hypotheses, decisions, fixed, chat };
}

// ── АГРЕГАТЫ СИСТЕМЫ (read-only) ──
function ageH(ts) { if (!ts) return null; const t = typeof ts === "string" ? Date.parse(ts) : (ts > 1e12 ? ts : ts * 1000); return t ? +(((Date.now() - t) / 3600000).toFixed(1)) : null; }

async function readAggregates() {
  const [dash, speed, tgDigest, tgHist] = await Promise.all([
    rgetJSON("dashboard", null), rgetJSON("speed", null), rgetJSON("tg:digest", null), rgetJSON("tghist:hunter", null),
  ]);
  const agg = {}, invariants = [];
  if (dash) {
    const t = dash.totals || {};
    agg.dashboard = {
      updatedAt: dash.updatedAt, ageHours: ageH(dash.updatedAt),
      sold: t.sold, revenue: t.revenue, conv: t.conv, avgCheck: t.avgCheck, noContactPct: t.noContactPct,
      mopsReach: (dash.mopsByConv || []).map((m) => ({ name: m.name, leads: m.leads, reachPct: m.reachPct, conv: m.conv, sold: m.sold })),
      problemsTop: (dash.problems || []).slice(0, 6),
    };
    const a = ageH(dash.updatedAt);
    if (a != null && a > 6) invariants.push({ name: "dashboard_freshness", ok: false, detail: `кэш dashboard устарел: ${a}ч (>6ч)` });
  }
  if (speed) {
    agg.speed = {
      updatedAt: speed.updatedAt, ageHours: ageH(speed.updatedAt), callDiag: speed._callDiag || null,
      today: (speed.mopsDay || []).map((m) => ({ name: m.name, leads: m.leads, reached: m.reached, reachedPct: m.reachedPct, called: m.calledLeads, tasksDonePct: m.tasksDonePct })),
    };
    // инвариант: дневной дозвон не должен рушиться в разы против месячного (был баг с лимитом нот)
    const monthReach = {}; (dash && dash.mopsByConv || []).forEach((m) => { monthReach[m.name] = m.reachPct; });
    for (const m of (speed.mopsDay || [])) {
      const mr = monthReach[m.name];
      if (mr != null && m.reachedPct != null && mr - m.reachedPct >= 30 && m.calledLeads >= 10)
        invariants.push({ name: "dozvon_today_vs_month", ok: false, detail: `${m.name}: дозвон сегодня ${m.reachedPct}% против месяца ${mr}% при ${m.calledLeads} званых — возможен недосчёт` });
    }
  }
  if (tgDigest) agg.tgDigest = { totalChats: tgDigest.totalChats, noReplyChats: tgDigest.noReplyChats, priceCount: tgDigest.priceCount, objectionCount: tgDigest.objectionCount };
  if (tgHist) agg.tgHistory = { total: tgHist.total, noReply: tgHist.noReply, priceQ: tgHist.priceQ, objQ: tgHist.objQ, leftAfterPrice: tgHist.leftAfterPrice };
  return { agg, invariants };
}

// ── GIT LOG за сутки через GitHub API (read-only) ──
async function readGitLog(hours = 24) {
  const repo = process.env.GITHUB_REPO || "AbdullohMahkamov/Hunters-path";
  const token = process.env.GITHUB_TOKEN || "";
  const since = new Date(Date.now() - hours * 3600000).toISOString();
  const headers = { "User-Agent": "hunter-devagent", Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/commits?since=${encodeURIComponent(since)}&per_page=50`, { headers });
    if (!r.ok) return { available: false, note: `GitHub API ${r.status}${token ? "" : " (нет GITHUB_TOKEN — приватный репо недоступен)"}`, commits: [] };
    const arr = await r.json();
    if (!Array.isArray(arr)) return { available: false, note: "unexpected response", commits: [] };
    return { available: true, commits: arr.map((c) => ({ sha: (c.sha || "").slice(0, 7), msg: (c.commit && c.commit.message || "").split("\n")[0], author: c.commit && c.commit.author && c.commit.author.name, date: c.commit && c.commit.author && c.commit.author.date })) };
  } catch (e) { return { available: false, note: String(e), commits: [] }; }
}

// ── СИСТЕМНЫЙ ПРОМПТ ──
const SYSTEM = `Ты — технический ревизор Hunter AI, SaaS для аналитики отделов продаж на базе amoCRM. Твоя работа — находить проблемы в системе раньше, чем их найдёт клиент.

Ты работаешь с одним человеком — основателем. Он ждёт от тебя прямоты, а не вежливости. Если он неправ — скажи. Если данные не позволяют сделать вывод — скажи, что не знаешь. Пиши по-русски, коротко и по делу, без воды и лести.

ПРАВИЛА ПАМЯТИ:
- Гипотеза не становится фактом (finding) без доказательств (evidence). Confidence растёт ТОЛЬКО с новыми evidence. Каждое изменение confidence сопровождай полем "reason".
- Не повторяй то, что уже в 'fixed' и не переоткрывай отклонённое в 'decisions'.
- Не выноси суждений о людях по данным, помеченным как ненадёжные.
- Если предлагаешь фикс — давай ГОТОВЫЙ промпт для Claude Code (самодостаточный: файл, что менять, как проверить).
- Ты НЕ можешь менять код/данные/конфиги. Только предлагать. Решает человек.

ФОРМАТ ОТВЕТА — строго JSON, без markdown и текста вокруг:
{
  "findings":[{"id","claim","confidence":0..1,"status":"confirmed","evidence":["..."],"source":"...","reason":"почему confidence такой"}],
  "hypotheses":[{"id","claim","confidence":0..1,"status":"testing|needs_data|likely|rejected","evidence":["..."],"source":"...","reason":"..."}],
  "questions_for_human":["..."],
  "report":"краткий отчёт человеку (5-12 строк, живым языком, самое важное сверху)",
  "suggested_prompts":[{"title":"...","prompt":"готовый промпт для Claude Code"}]
}
Сохраняй существующие id при обновлении элементов памяти; для новых — оставь id пустым, бэкенд проставит.`;

function buildUserContent({ memory, agg, invariants, git, extra }) {
  return `ТВОЯ ПАМЯТЬ:
findings (подтверждено): ${JSON.stringify(memory.findings)}
hypotheses (в проверке): ${JSON.stringify(memory.hypotheses)}
decisions (решения человека): ${JSON.stringify(memory.decisions.slice(-30))}
fixed (уже исправлено): ${JSON.stringify(memory.fixed.map((f) => f.claim || f))}

ДАННЫЕ СИСТЕМЫ (агрегаты, read-only):
${JSON.stringify(agg)}

АВТО-ИНВАРИАНТЫ (наши проверки; ok:false = аномалия):
${JSON.stringify(invariants)}

ИЗМЕНЕНИЯ В КОДЕ за 24ч (git):
${git.available ? JSON.stringify(git.commits) : "(git недоступен: " + git.note + ")"}
${extra || ""}
ЗАДАЧА:
1. Проверь висящие гипотезы — данные их подтверждают или опровергают? Двигай confidence только с evidence (+ reason).
2. Найди новое: аномалии, противоречия, метрики, которые не сходятся.
3. Проверь, не сломали ли вчерашние коммиты что-то работавшее.
4. Задай вопросы, если данных не хватает.
Верни строго JSON описанного формата.`;
}

async function callModel(system, userContent, maxTokens = 3200) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: userContent }] }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Anthropic ${r.status}: ${t.slice(0, 300)}`); }
  const d = await r.json();
  const usage = d.usage || {};
  const text = (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  return { text, tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0) };
}
function parseJSON(text) {
  let t = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// merge: сохраняем id, логируем изменения confidence, проставляем id новым, чистим fixed/rejected
function mergeMemoryList(prevList, newList, kind, conflog, fixedClaims, rejectedClaims) {
  const prevById = {}; for (const p of prevList) if (p && p.id) prevById[p.id] = p;
  const out = [];
  for (const it of (newList || [])) {
    if (!it || !it.claim) continue;
    const claimLc = String(it.claim).toLowerCase();
    if (fixedClaims.has(claimLc) || rejectedClaims.has(claimLc)) continue; // не переоткрываем
    let id = it.id && prevById[it.id] ? it.id : (it.id || newId(kind));
    const prev = prevById[id];
    const conf = typeof it.confidence === "number" ? Math.max(0, Math.min(1, it.confidence)) : (prev ? prev.confidence : 0.3);
    if (prev && typeof prev.confidence === "number" && Math.abs((prev.confidence || 0) - conf) >= 0.01) {
      conflog.push({ id, kind, from: prev.confidence, to: conf, reason: it.reason || "(без причины)", at: Date.now() });
    }
    out.push({
      id, claim: it.claim, confidence: conf, status: it.status || (prev && prev.status) || (kind === "finding" ? "confirmed" : "testing"),
      evidence: Array.isArray(it.evidence) ? it.evidence.slice(0, 12) : (prev ? prev.evidence : []),
      source: it.source || (prev && prev.source) || "nightly",
      reason: it.reason || (prev && prev.reason) || "",
      created: prev ? prev.created : Date.now(), updated: Date.now(),
    });
  }
  return out;
}

async function pushChat(role, text, meta) {
  const chat = await rgetJSON(K.chat, []);
  chat.push({ id: newId("m"), role, text: text || "", ...(meta || {}), at: Date.now() });
  await rsetJSON(K.chat, chat.slice(-CAP.chat));
  return chat;
}

// ── НОЧНОЙ ПРОГОН / НЕДЕЛЬНАЯ РЕВИЗИЯ ──
async function runNightly(mode) {
  const memory = await readMemory();
  const { agg, invariants } = await readAggregates();
  const git = await readGitLog(mode === "weekly" ? 24 * 7 : 24);
  const extra = mode === "weekly"
    ? `\nРЕЖИМ: НЕДЕЛЬНАЯ РЕВИЗИЯ ПАМЯТИ. Пройдись по СВОИМ findings/hypotheses и честно скажи: какие выводы устарели, оказались неверны или больше не подтверждаются данными? Понижай confidence отвергнутых (status:"rejected", reason). Не выдумывай нового без данных.\n`
    : "";
  const { text, tokens } = await callModel(SYSTEM, buildUserContent({ memory, agg, invariants, git, extra }), 3600);
  let out; try { out = parseJSON(text); } catch (e) {
    await pushChat("agent", `Ночной прогон: не смог разобрать ответ модели в JSON.\n\n${text.slice(0, 1200)}`, { kind: mode === "weekly" ? "weekly" : "nightly", tokens });
    return { ok: false, error: "parse_failed" };
  }
  const conflog = await rgetJSON(K.conflog, []);
  const fixedClaims = new Set((memory.fixed || []).map((f) => String(f.claim || f).toLowerCase()));
  const rejectedClaims = new Set((memory.decisions || []).filter((d) => d.verdict === "rejected").map((d) => String(d.claim || "").toLowerCase()));
  const findings = mergeMemoryList(memory.findings, out.findings, "finding", conflog, fixedClaims, rejectedClaims).slice(0, CAP.findings);
  const hypotheses = mergeMemoryList(memory.hypotheses, out.hypotheses, "hyp", conflog, fixedClaims, rejectedClaims).slice(0, CAP.hypotheses);
  await Promise.all([
    rsetJSON(K.findings, findings),
    rsetJSON(K.hypotheses, hypotheses),
    rsetJSON(K.conflog, conflog.slice(-CAP.conflog)),
  ]);
  const report = (out.report || "Прогон завершён.").trim();
  const questions = Array.isArray(out.questions_for_human) ? out.questions_for_human : [];
  const prompts = Array.isArray(out.suggested_prompts) ? out.suggested_prompts.slice(0, 8) : [];
  await pushChat("agent", report, {
    kind: mode === "weekly" ? "weekly" : "nightly", tokens,
    questions, suggested_prompts: prompts,
    stats: { findings: findings.length, hypotheses: hypotheses.length, invariants: invariants.filter((i) => !i.ok).length },
  });
  return { ok: true, report, findings: findings.length, hypotheses: hypotheses.length, questions, suggested_prompts: prompts, tokens };
}

// ── ДНЕВНАЯ ПЕРЕПИСКА ──
async function runChat(userText) {
  const memory = await readMemory();
  const { agg, invariants } = await readAggregates();
  await pushChat("human", userText);
  const history = (await rgetJSON(K.chat, [])).slice(-20)
    .map((m) => `${m.role === "human" ? "ОСНОВАТЕЛЬ" : "АГЕНТ"}: ${m.text}`).join("\n");
  const sys = SYSTEM + `\n\nСЕЙЧАС: живой диалог с основателем (не ночной прогон). Отвечай ТЕКСТОМ (не JSON), прямо и по делу. Опирайся на свою память и данные. Если основатель одобряет/отвергает находку — учти это. Если предлагаешь фикс — дай готовый промпт для Claude Code прямо в ответе (в блоке).`;
  const content = `ТВОЯ ПАМЯТЬ:
findings: ${JSON.stringify(memory.findings)}
hypotheses: ${JSON.stringify(memory.hypotheses)}
decisions: ${JSON.stringify(memory.decisions.slice(-20))}
fixed: ${JSON.stringify(memory.fixed.map((f) => f.claim || f))}

ДАННЫЕ СИСТЕМЫ: ${JSON.stringify(agg)}
АВТО-ИНВАРИАНТЫ: ${JSON.stringify(invariants)}

ПЕРЕПИСКА (последнее):
${history}

Ответь на последнюю реплику основателя.`;
  const { text, tokens } = await callModel(sys, content, 2200);
  await pushChat("agent", text, { kind: "reply", tokens });
  return { ok: true, reply: text, tokens };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  if (!AKEY) { res.status(500).json({ error: "no ANTHROPIC_API_KEY" }); return; }

  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "state";

  // cron-гейт: заголовок Vercel Cron (Authorization: Bearer $CRON_SECRET) или ?cron=1, если секрет не задан
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const isCron = cronSecret ? (authHeader === `Bearer ${cronSecret}`) : (q.cron === "1" || b.cron === true);

  // admin-гейт
  const session = q.session || b.session;
  const sess = await getSession(session);
  const isAdmin = !!sess && sess.role === "admin";

  const cronActions = new Set(["nightly", "weekly_review"]);
  if (!isAdmin && !(cronActions.has(action) && isCron)) {
    res.status(403).json({ error: "admin only (или cron с секретом)" }); return;
  }

  try {
    if (action === "state") {
      const [memory, conflog] = await Promise.all([readMemory(), rgetJSON(K.conflog, [])]);
      res.status(200).json({ ok: true, ...memory, conflog: conflog.slice(-60) });
      return;
    }
    if (action === "chat") {
      const text = String(b.text || "").trim();
      if (!text) { res.status(400).json({ error: "empty text" }); return; }
      const out = await runChat(text);
      res.status(200).json(out);
      return;
    }
    if (action === "nightly") { res.status(200).json(await runNightly("nightly")); return; }
    if (action === "weekly_review") { res.status(200).json(await runNightly("weekly")); return; }

    if (action === "decision") {
      // {refId, kind:'finding'|'hyp', claim, verdict:'approved'|'rejected'|'fixed', note}
      const verdict = String(b.verdict || "");
      if (!["approved", "rejected", "fixed"].includes(verdict)) { res.status(400).json({ error: "bad verdict" }); return; }
      const decisions = await rgetJSON(K.decisions, []);
      const entry = { id: newId("dec"), refId: b.refId || "", kind: b.kind || "", claim: b.claim || "", verdict, note: b.note || "", at: Date.now() };
      decisions.push(entry);
      await rsetJSON(K.decisions, decisions.slice(-CAP.decisions));
      // убираем элемент из активных списков; при 'fixed' переносим в fixed
      const listKey = b.kind === "finding" ? K.findings : K.hypotheses;
      const list = await rgetJSON(listKey, []);
      const item = list.find((x) => x.id === b.refId);
      const rest = list.filter((x) => x.id !== b.refId);
      await rsetJSON(listKey, rest);
      if (verdict === "fixed" && (item || b.claim)) {
        const fixed = await rgetJSON(K.fixed, []);
        fixed.push({ id: newId("fix"), claim: (item && item.claim) || b.claim, note: b.note || "", at: Date.now() });
        await rsetJSON(K.fixed, fixed.slice(-CAP.fixed));
      }
      await pushChat("human", `[решение: ${verdict}] ${(item && item.claim) || b.claim || ""}${b.note ? " — " + b.note : ""}`, { kind: "decision" });
      res.status(200).json({ ok: true, decision: entry });
      return;
    }

    if (action === "reset") {
      // по умолчанию чистим рабочую память (findings/hypotheses/chat/conflog), сохраняя историю решений и fixed.
      // full=true — полный сброс всего devagent:*.
      await Promise.all([rdel(K.findings), rdel(K.hypotheses), rdel(K.chat), rdel(K.conflog)]);
      if (b.full === true || q.full === "1") { await Promise.all([rdel(K.decisions), rdel(K.fixed)]); }
      res.status(200).json({ ok: true, reset: true, full: b.full === true || q.full === "1" });
      return;
    }

    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
}
