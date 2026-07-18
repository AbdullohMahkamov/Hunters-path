// /api/meta-brain.js — «ОБЩИЙ МОЗГ» (мета-наблюдатель).
// ДВЕ роли, обе — сверка сигналов между агентами, но с РАЗНЫМ адресатом:
//  1) ОБОГАЩЕНИЕ находок MOP (enrichFindings/crossCheckFinding): лёгкий ДЕТЕРМИНИРОВАННЫЙ просмотр
//     Dev-воронки + Growth-гипотез + DeepSales ПЕРЕД записью находки. Находка ОСТАЁТСЯ MOP-овской
//     (тот же taskId, тот же dispute-цикл) — просто честно показывает, насколько широко подтверждён сигнал.
//  2) ДНЕВНОЙ МОЗГ (runDailyBrain): раз в день LLM-синтез новых СВОДНЫХ наблюдений (которых не дал ни один
//     агент по отдельности) → ТЕБЕ в owner-бот КАК ПРЕДЛОЖЕНИЕ. Только после «Подтвердить» → задача РОПу
//     тем же путём Task Agent (source:"metabrain"), что и находки MOP. Никогда не пишет РОПу/агентам сам.
//
// ГРАНИЦЫ (жёсткие): sendTg только "owner"; пишет только в metabrain:*; в Task попадает ТОЛЬКО confirmed-
// предложение через существующий loadSalesTasks→runTick. Прямой поток MOP→Task→РОП не трогается.
//
// ПРОВЕНАНС (критично для честности): находки MOP типа call_* ПРОИСХОДЯТ из DeepSales — значит для них
// DeepSales НЕ независимый подтверждающий сигнал, а их же источник. Не складываем как две оси.

import { getVerifiedFunnel } from "./dev-agent.js";
import { getCallAnalysisBundle } from "./deepsales.js";
import { sendTg, getPeople } from "./tg-bot.js";
// growthagent:* и mopagent:* читаем СЫРЫМИ ключами — чтобы НЕ импортировать mop-agent (он импортирует нас → цикл).

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const AKEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ORG = "hunter";
const MODEL = "claude-sonnet-5";

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }

const K = { proposals: "metabrain:proposals", seen: "metabrain:seen", config: "metabrain:config", lastrun: "metabrain:lastrun", msgmap: "metabrain:msgmap" };
const DEFAULT_CONFIG = { enabled: true, maxPerDay: 3, cooldownDays: 7, silentOnZero: true, heartbeatDow: 1 }; // heartbeat: понедельник
const CAP = { proposals: 60 };

function tkDay() { return new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10); }
function tkDow() { return new Date(Date.now() + 5 * 3600000).getUTCDay(); }
function shortT(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
async function getConfig() { const c = await rgetJSON(K.config, null); return { ...DEFAULT_CONFIG, ...(c || {}) }; }
// детерминированный id без Date.now (для совместимости с песочницей воркфлоу тут не критично, но пусть будет стабилен по контенту)
function propId(fp) { let h = 0; for (let i = 0; i < fp.length; i++) { h = (h * 31 + fp.charCodeAt(i)) >>> 0; } return "mb" + h.toString(36) + Date.now().toString(36).slice(-4); }

// ─────────────────────────────────────────────────────────────────────────────
// ЧАСТЬ 1: КРОСС-ЧЕК находок MOP (лёгкий, детерминированный, БЕЗ LLM)
// ─────────────────────────────────────────────────────────────────────────────

// Контекст сверки загружается ОДИН раз за прогон MOP (не на каждую находку).
export async function loadCrossCheckContext(org = ORG) {
  const [funnel, ca, growthHyps] = await Promise.all([
    getVerifiedFunnel(org).catch(() => null),
    getCallAnalysisBundle(org).catch(() => null),
    rgetJSON("growthagent:hypotheses", []).then((x) => Array.isArray(x) ? x : []).catch(() => []),
  ]);
  return { funnel, ca, growthHyps };
}

// Ключевые слова темы → для сопоставления находки с гипотезами Growth и осью воронки.
const THEME_WORDS = {
  closing: ["закрыт", "закрыв", "следующ", "next", "сделк", "оплат", "дожим"],
  reach: ["дозвон", "звон", "недозвон", "не звонил", "контакт", "call"],
  objection: ["возражен", "дорого", "цена", "сомнен", "отказ"],
  speed: ["скорост", "медлен", "долго", "первый контакт", "быстро"],
  script: ["скрипт", "презентац", "spin", "fab", "выявлен потреб"],
};
function themeOf(text) {
  const t = String(text || "").toLowerCase();
  for (const [theme, words] of Object.entries(THEME_WORDS)) if (words.some((w) => t.includes(w))) return theme;
  return null;
}

// Сверяет ОДНУ находку MOP с другими источниками. Возвращает {signals, independentCount, strength, note}.
export function crossCheckFinding(finding, ctx) {
  const signals = [];
  const isCallDerived = String(finding.type || "").startsWith("call_"); // провенанс: source = DeepSales
  const mop = finding.mop || null;
  const theme = themeOf(`${finding.title || ""} ${finding.fact || ""} ${finding.type || ""}`);

  // ── Ось DeepSales — ТОЛЬКО если находка НЕ из DeepSales (иначе это её же источник, не подтверждение) ──
  if (!isCallDerived && ctx.ca && ctx.ca.coverage && mop) {
    const cov = ctx.ca.coverage.byMop && ctx.ca.coverage.byMop[mop];
    const mine = (ctx.ca.recent || []).filter((r) => r.mop === mop && r.score != null);
    if (cov && cov.analyzed > 0 && mine.length) {
      const avg = Math.round(mine.reduce((s, r) => s + r.score, 0) / mine.length);
      const share = cov.sharePctApprox != null ? `${cov.sharePctApprox}%` : "доля неизвестна";
      if (avg < 50) signals.push({ axis: "deepsales", direction: "support", detail: `разборами DeepSales: ${cov.analyzed} из ~${cov.monthCallsEstimate || "?"} звонков (${share}), средний балл ${avg}/100` });
      else if (avg >= 70) signals.push({ axis: "deepsales", direction: "contradict", detail: `по разборам DeepSales у ${mop} средний балл ${avg}/100 (${cov.analyzed} зв., ${share}) — на звонках картина скорее хорошая` });
    }
  }

  // ── Ось воронки Dev — trust на релевантном переходе ──
  if (ctx.funnel && Array.isArray(ctx.funnel.stages)) {
    const relevant = ctx.funnel.stages.find((s) => {
      const nm = (s.transitionFromPrev && s.transitionFromPrev.name || "").toLowerCase();
      if (theme === "reach") return nm.includes("дозвон");
      if (theme === "closing") return nm.includes("сделк");
      return false;
    });
    const tr = relevant && relevant.transitionFromPrev;
    if (tr && tr.trust && tr.trust !== "verified") {
      signals.push({ axis: "dev", direction: "caveat", detail: `данные Dev-воронки по этому этапу помечены «${tr.trust === "suspicious" ? "ненадёжно (телефония)" : "недостаточно данных"}» — вывод по нему держать осторожно` });
    }
  }

  // ── Ось Growth — гипотеза по той же теме ──
  if (theme && Array.isArray(ctx.growthHyps)) {
    const open = ctx.growthHyps.filter((h) => (h.status || "open") === "open");
    const hit = open.find((h) => themeOf(`${h.observation || ""} ${h.claim || ""}`) === theme);
    if (hit) signals.push({ axis: "growth", direction: "context", detail: `Growth Agent рассматривает смежную тему: «${shortT(hit.observation || hit.claim, 90)}» — стоит сверить` });
  }

  const supports = signals.filter((s) => s.direction === "support");
  const contradicts = signals.filter((s) => s.direction === "contradict");
  const independentCount = new Set(supports.map((s) => s.axis)).size; // MOP сам НЕ считается «подтверждением себя»

  let strength, note;
  if (contradicts.length) { strength = "contested"; note = `⚠️ Есть противоречащий сигнал: ${contradicts[0].detail} — перепроверить, прежде чем требовать.`; }
  else if (independentCount >= 1) { strength = "multi"; note = `Подтверждается также ${supports.map((s) => s.detail).join("; ")}.`; }
  else { strength = "single"; note = "Сигнал только от Супервайзера (MOP), другими источниками пока не подтверждён."; }
  const caveats = signals.filter((s) => s.direction === "caveat" || s.direction === "context");
  if (caveats.length && strength !== "contested") note += " " + caveats.map((s) => s.detail).join("; ") + ".";
  return { signals, independentCount, supports: supports.length, contradicts: contradicts.length, strength, note, at: Date.now() };
}

// Обогащает ОТКРЫТЫЕ находки крос-чеком (контекст грузится один раз). Вызывается MOP-агентом перед записью.
export async function enrichFindings(org, findings) {
  try {
    if (!Array.isArray(findings) || !findings.length) return findings;
    const ctx = await loadCrossCheckContext(org);
    return findings.map((f) => (f && f.status === "open") ? { ...f, crossCheck: crossCheckFinding(f, ctx) } : f);
  } catch (e) { return findings; } // сверка — обогащение, а не блокер: при сбое находки идут как есть
}

// ─────────────────────────────────────────────────────────────────────────────
// ЧАСТЬ 2: ДНЕВНОЙ МОЗГ — LLM-синтез сводных наблюдений → owner-бот как предложения
// ─────────────────────────────────────────────────────────────────────────────

async function callModel(system, user, maxTokens = 2200) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  const d = await r.json();
  return (d.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
}

const BRAIN_SYSTEM = `Ты — «общий мозг» бизнес-системы Hunter Academy: мета-наблюдатель НАД четырьмя агентами. Твоя ЕДИНСТВЕННАЯ задача — находить СВОДНЫЕ наблюдения, которых не дал НИ ОДИН агент по отдельности: пересечения (несколько независимых источников про одно) и противоречия (источники спорят).

ИСТОЧНИКИ (это РАЗНЫЕ системы, не сливай):
- Dev-воронка (getVerifiedFunnel): метрики с trust-метками (verified/suspicious/insufficient) + узкое место + что «не диагностируется».
- MOP-находки: проблемы по отделу / конкретным менеджерам (из amoCRM).
- Growth-гипотезы: идеи роста на verified-воронке + web-бенчмарки.
- DeepSales: разборы реальных звонков (баллы, ошибки, возражения) — выборка КРОШЕЧНАЯ (<2%), не случайная.

КАК АКТИВНО ИСКАТЬ (делай это ВСЕГДА, по шагам):
A. Возьми узкое место воронки (funnel.bottleneck) — это ГЛАВНЫЙ подозреваемый. Определи его тему (закрытие / дозвон / etc).
B. Сверь эту тему с DeepSales: сравни ошибки в ПРОИГРАННЫХ vs ВЫИГРАННЫХ разборах (lostMistakes vs wonMistakes). Тип ошибки, которого в LOST заметно БОЛЬШЕ, чем в WON, и который совпадает с темой узкого места — это ПОДТВЕРЖДЕНИЕ с независимой оси (звонки). Пример: bottleneck=закрытие И lostMistakes.closing=13 против wonMistakes.closing=6 → закрытие подтверждается звонками.
C. Сверь с MOP-находками и Growth-гипотезами: указывают ли они на ту же тему.
D. Так же ищи ПРОТИВОРЕЧИЯ (Growth предлагает одно, а звонки/воронка это опровергают).
Если после шагов A–D тема узкого места подтверждается ≥2 НЕЗАВИСИМЫМИ осями — ЭТО и есть твоё главное наблюдение, обязательно выдай его. Не молчи, когда сигналы сходятся.

ЖЁСТКИЕ ПРАВИЛА ЧЕСТНОСТИ:
1. ПРОВЕНАНС — не считай один сигнал дважды. MOP-находки типа call_* ПРОИСХОДЯТ из DeepSales → ОДНА ось. Growth строит гипотезы НА Dev-воронке → Growth и Dev-воронка = ОДНА ось (CRM), не две. Независимые оси: (CRM: Dev-воронка+Growth+MOP-CRM-находки) / (Звонки: DeepSales+MOP call_*).
2. CONFIDENCE: "high" = ≥2 НЕЗАВИСИМЫЕ оси согласны, обе на хороших данных; "med" = две оси, но одна под гейтом/малое покрытие (напр. звонки <2%) — ЭТО ЧАСТЫЙ И НОРМАЛЬНЫЙ СЛУЧАЙ, выдавай его; "low" = одна ось / suspicious-insufficient / неразрешённое противоречие.
3. TRUST-ГЕЙТ: если ЕДИНСТВЕННАЯ опора — данные suspicious/insufficient (телефония, покрытие <2%) — confidence "low" и действие = «проверить/прослушать вручную». НО если малопокрытые звонки лишь ПОДТВЕРЖДАЮТ верифицированную воронку — это "med", а не "low".
4. ЛЮДИ: никаких карательных формулировок. Действие всегда «разобрать/обучить/проверить», не «наказать/уволить».
5. Наблюдение = связь ≥2 НЕЗАВИСИМЫХ осей ИЛИ противоречие. Тема, которую видно и в воронке, и в звонках — это НЕ «дубль одиночной находки», а ГЛАВНАЯ ценность: связать их и дать честную уверенность. Не подавляй такое.

Верни СТРОГО валидный JSON-массив (без markdown), максимум 5 наблюдений, отсортируй по важности:
[{"title":"кратко суть","statement":"1-2 фразы что видно","sources":[{"agent":"MOP|Dev|Growth|DeepSales","signal":"конкретный сигнал с цифрой"}],"independentSignals":2,"confidence":"high|med|low","contradiction":false,"caveats":["выборка звонков 1.1%"],"proposedTask":{"title":"задача РОПу кратко","why":"зачем и что сделать","deadlineDays":3,"scope":"pointwise|department","mop":"имя или null"}}]
Если действие преждевременно (низкая уверенность/противоречие) — proposedTask всё равно дай, но как «проверить/не действовать» (напр. поручить аналитику проверить долю X). Язык — русский, простой, для владельца-непрограммиста, без кода/жаргона.`;

async function gatherForBrain(org) {
  const [funnel, ca, mopFindings, growthHyps, devFindings] = await Promise.all([
    getVerifiedFunnel(org).catch(() => null),
    getCallAnalysisBundle(org).catch(() => null),
    rgetJSON("mopagent:findings", []).then((x) => (Array.isArray(x) ? x.filter((f) => f.status === "open") : [])).catch(() => []),
    rgetJSON("growthagent:hypotheses", []).then((x) => (Array.isArray(x) ? x : [])).catch(() => []),
    rgetJSON("devagent:findings", []).then((x) => (Array.isArray(x) ? x.filter((f) => f.status === "open") : [])).catch(() => []),
  ]);
  const caSummary = ca && ca.coverage ? {
    analyzed: ca.coverage.analyzed, byMop: ca.coverage.byMop,
    team: ca.team ? { wonMistakes: ca.team.won && ca.team.won.mistakeTags, lostMistakes: ca.team.lost && ca.team.lost.mistakeTags } : null,
    recent: (ca.recent || []).slice(0, 8).map((r) => ({ mop: r.mop, status: r.status, score: r.score, headline: shortT(r.headline, 80) })),
  } : null;
  return {
    funnel: funnel ? { bottleneck: funnel.bottleneck, undiagnosable: funnel.undiagnosable, telephonySuspicious: funnel.telephonySuspicious, stages: (funnel.stages || []).map((s) => ({ stage: s.stage, value: s.value, trust: s.trust, transition: s.transitionFromPrev })) } : null,
    mop: mopFindings.map((f) => ({ scope: f.scope, type: f.type, mop: f.mop || null, title: shortT(f.title, 120), fact: shortT(f.fact, 160) })),
    growth: growthHyps.filter((h) => (h.status || "open") === "open").slice(0, 8).map((h) => ({ status: h.status, obs: shortT(h.observation || h.claim, 140) })),
    dev: devFindings.slice(0, 8).map((f) => ({ status: f.status, claim: shortT(f.claim, 140) })),
    deepsales: caSummary,
  };
}

function fingerprint(o) { return `${(o.proposedTask && o.proposedTask.mop) || "team"}|${themeOf(o.title + " " + o.statement) || (o.title || "").toLowerCase().slice(0, 24)}`; }

export async function runDailyBrain(org = ORG, force = false) {
  const cfg = await getConfig();
  if (!cfg.enabled && !force) return { ok: true, skipped: "disabled" };
  const bundle = await gatherForBrain(org);
  let observations = [];
  try {
    const raw = await callModel(BRAIN_SYSTEM, "Данные системы за сутки:\n" + JSON.stringify(bundle));
    const m = raw.replace(/```json|```/g, "").match(/\[[\s\S]*\]/);
    observations = m ? JSON.parse(m[0]) : [];
    if (!Array.isArray(observations)) observations = [];
  } catch (e) { observations = []; }

  // дедуп против seen (кулдаун) + против уже висящих pending
  const seen = await rgetJSON(K.seen, {});
  const proposals = await rgetJSON(K.proposals, []);
  const pendingFps = new Set(proposals.filter((p) => p.status === "pending").map((p) => p.fingerprint));
  const nowDay = tkDay(); const nowMs = Date.now();
  const fresh = [];
  for (const o of observations) {
    if (!o || !o.title || !o.proposedTask) continue;
    const fp = fingerprint(o);
    if (pendingFps.has(fp)) continue; // уже висит на решении
    const s = seen[fp];
    if (s && s.until && nowMs < s.until) continue; // в кулдауне (недавно отклонено/решено)
    fresh.push({ ...o, fingerprint: fp });
  }
  fresh.sort((a, b) => ({ high: 0, med: 1, low: 2 }[a.confidence] ?? 3) - ({ high: 0, med: 1, low: 2 }[b.confidence] ?? 3));
  const send = fresh.slice(0, cfg.maxPerDay);

  const created = [];
  for (const o of send) {
    const id = propId(o.fingerprint);
    const rec = { id, at: nowMs, day: nowDay, ...o, status: "pending" };
    proposals.push(rec); created.push(rec);
    await sendProposalToOwner(rec);
  }
  await rsetJSON(K.proposals, proposals.slice(-CAP.proposals));
  await rsetJSON(K.lastrun, { at: nowMs, day: nowDay, observed: observations.length, sent: created.length });

  // тихо при нуле; РАЗ В НЕДЕЛЮ (heartbeatDow) — короткий признак жизни, даже если наблюдений нет
  if (!created.length && tkDow() === cfg.heartbeatDow) {
    const ppl = await getPeople().catch(() => ({}));
    if (ppl.owner && ppl.owner.chatId) await sendTg("owner", ppl.owner.chatId, `🧠 Общий мозг: за неделю сводных наблюдений уровня «предложить действие» не набралось. Источники сверяю ежедневно — как появится подтверждённый с двух сторон сигнал, пришлю предложение.`);
  }
  return { ok: true, observed: observations.length, sent: created.length, ids: created.map((c) => c.id) };
}

const CONF_BADGE = { high: "🟢 высокая", med: "🟡 средняя", low: "🔴 низкая" };
function fmtProposal(p) {
  const t = p.proposedTask || {};
  const srcLine = (p.sources || []).map((s) => `• ${s.agent}: ${s.signal}`).join("\n");
  const nInd = p.independentSignals != null ? p.independentSignals : (p.sources || []).length;
  let s = `🧠 <b>Сводное наблюдение · ${p.day}</b>\n\n`;
  s += `${p.contradiction ? "⚠️" : "📌"} <b>${p.title}</b>\n`;
  if (p.statement) s += `${p.statement}\n`;
  s += `\nИсточники (${nInd} независимых):\n${srcLine}\n`;
  s += `Уверенность: ${CONF_BADGE[p.confidence] || p.confidence}`;
  if (p.caveats && p.caveats.length) s += ` — ${p.caveats.join("; ")}`;
  s += `\n\n`;
  s += p.contradiction
    ? `Предлагаю НЕ действовать сразу: ${t.why || t.title}\n`
    : `Предлагаю задачу РОПу:\n«${t.title}»${t.why ? ` — ${t.why}` : ""}${t.deadlineDays ? ` Срок: ${t.deadlineDays} дн.` : ""}\n`;
  return s;
}

async function rememberMsg(messageId, propId) {
  if (!messageId) return;
  const mm = await rgetJSON(K.msgmap, {}); mm[String(messageId)] = propId;
  const keys = Object.keys(mm); if (keys.length > 100) delete mm[keys[0]]; // лёгкий кап
  await rsetJSON(K.msgmap, mm);
}

async function sendProposalToOwner(p) {
  const ppl = await getPeople().catch(() => ({}));
  if (!ppl.owner || !ppl.owner.chatId) return false;
  const buttons = [[
    { text: "✅ Подтвердить и поставить", callback_data: `mb:confirm:${p.id}` },
    { text: "❌ Отклонить", callback_data: `mb:reject:${p.id}` },
  ], [
    { text: "📝 Поправить", callback_data: `mb:edit:${p.id}` },
  ]];
  const sent = await sendTg("owner", ppl.owner.chatId, fmtProposal(p), { reply_markup: { inline_keyboard: buttons } });
  if (sent && sent.messageId) await rememberMsg(sent.messageId, p.id); // reply-контекст для «Поправить»
  return sent;
}

// ─────────────────────────────────────────────────────────────────────────────
// ЧАСТЬ 3: РЕШЕНИЕ ВЛАДЕЛЬЦА (кнопки) + мост в Task Agent
// ─────────────────────────────────────────────────────────────────────────────

// self-fetch тика Task Agent — чтобы подтверждённая задача ушла РОПу СРАЗУ (без импорта task-agent → без цикла).
async function triggerTaskTick(host) {
  try {
    const base = host ? `https://${host}` : "https://hunters-path.vercel.app";
    await fetch(`${base}/api/task-agent?action=tick&cron=1`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${CRON_SECRET}` }, body: "{}" });
  } catch (e) {}
}

// Возвращает подтверждённые (ещё не закрытые) предложения В ФОРМЕ задач — для loadSalesTasks (source:"metabrain").
export async function getConfirmedMetaTasks() {
  const proposals = await rgetJSON(K.proposals, []);
  return proposals.filter((p) => p.status === "confirmed").map((p) => {
    const t = p.finalTask || p.proposedTask || {};
    const dl = t.deadlineDays ? new Date(Date.now() + t.deadlineDays * 86400000 + 5 * 3600000).toISOString().slice(0, 10) : "";
    return {
      id: `mb_${p.id}`, title: t.title || p.title, fact: t.why || p.statement || "", action: t.why || "",
      deadline: dl, scope: t.scope === "department" ? "department" : "pointwise", mop: t.mop || null,
      corroboration: `по сводному наблюдению общего мозга, подтверждено владельцем${p.confidence ? ` (уверенность ${p.confidence})` : ""}`,
      metaSource: true,
    };
  });
}

// Закрытие подтверждённой задачи (аналог closeMopFinding) — вызывается task-agent при dispute/выполнении.
export async function closeMetaProposal(taskId, reason) {
  const id = String(taskId || "").replace(/^mb_/, "");
  const proposals = await rgetJSON(K.proposals, []);
  const i = proposals.findIndex((p) => p.id === id);
  if (i < 0) return false;
  proposals[i] = { ...proposals[i], status: "closed", closeReason: reason || "", closedAt: Date.now() };
  await rsetJSON(K.proposals, proposals);
  return true;
}

async function setSeen(fp, days) {
  const seen = await rgetJSON(K.seen, {});
  seen[fp] = { until: Date.now() + (days || 7) * 86400000, at: Date.now() };
  await rsetJSON(K.seen, seen);
}

// Обработка кнопки владельца. edit → просит текст ответом (reply-контекст ведёт tg-bot по msgmap).
export async function handleMetaButton(act, id, host) {
  const cfg = await getConfig();
  const proposals = await rgetJSON(K.proposals, []);
  const i = proposals.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false, toast: "предложение не найдено" };
  const p = proposals[i];

  if (act === "confirm") {
    if (p.status !== "pending" && p.status !== "edited") return { ok: true, toast: "уже обработано" };
    proposals[i] = { ...p, status: "confirmed", confirmedAt: Date.now() };
    await rsetJSON(K.proposals, proposals);
    await triggerTaskTick(host); // задача уходит РОПу СРАЗУ существующим путём
    return { ok: true, toast: "Подтверждено — задача уходит РОПу", ownerMsg: `✅ <b>Подтверждено.</b> Поставил РОПу задачу по этому наблюдению (с пометкой «подтверждено владельцем»). Отслеживайте в Тренере.` };
  }
  if (act === "reject") {
    proposals[i] = { ...p, status: "rejected", rejectedAt: Date.now() };
    await rsetJSON(K.proposals, proposals);
    await setSeen(p.fingerprint, cfg.cooldownDays); // не всплывёт назавтра
    return { ok: true, toast: "Отклонено", ownerMsg: `❌ <b>Отклонено.</b> Наблюдение не всплывёт ${cfg.cooldownDays} дн.` };
  }
  if (act === "edit") {
    proposals[i] = { ...p, status: "awaiting_edit", editAskedAt: Date.now() };
    await rsetJSON(K.proposals, proposals);
    return { ok: true, toast: "Пришлите исправленную формулировку ответом на это сообщение", ownerMsg: `📝 Пришлите исправленную формулировку задачи <b>ответом (reply)</b> на сообщение с наблюдением — покажу финальную версию с кнопкой подтверждения.` };
  }
  return { ok: false, toast: "неизвестное действие" };
}

// Владелец ответил (reply) на сообщение-наблюдение → если оно ждёт правки, применяем. Иначе — не наше.
export async function handleOwnerMetaReply(replyToMsgId, text) {
  if (!replyToMsgId) return { handled: false };
  const mm = await rgetJSON(K.msgmap, {});
  const propId = mm[String(replyToMsgId)];
  if (!propId) return { handled: false };
  const proposals = await rgetJSON(K.proposals, []);
  const p = proposals.find((x) => x.id === propId);
  if (!p || p.status !== "awaiting_edit") return { handled: false };
  await applyMetaEdit(propId, text);
  return { handled: true };
}

// Владелец прислал исправленную формулировку (reply). Сохраняем и ПЕРЕ-предлагаем с финальным подтверждением.
export async function applyMetaEdit(id, text, host) {
  const proposals = await rgetJSON(K.proposals, []);
  const i = proposals.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false };
  const p = proposals[i];
  const finalTask = { ...(p.proposedTask || {}), title: String(text).slice(0, 400), why: (p.proposedTask && p.proposedTask.why) || "" };
  proposals[i] = { ...p, status: "edited", finalTask, editedAt: Date.now() };
  await rsetJSON(K.proposals, proposals);
  const ppl = await getPeople().catch(() => ({}));
  if (ppl.owner && ppl.owner.chatId) {
    const buttons = [[{ text: "✅ Поставить как есть", callback_data: `mb:confirm:${id}` }, { text: "❌ Отмена", callback_data: `mb:reject:${id}` }]];
    await sendTg("owner", ppl.owner.chatId, `📝 <b>Исправленная версия:</b>\n«${String(text).slice(0, 400)}»\n\nПоставить РОПу в этой формулировке?`, { reply_markup: { inline_keyboard: buttons } });
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP-хендлер (крон + админ)
// ─────────────────────────────────────────────────────────────────────────────
const CRON_OK = new Set(["daily"]);
async function isAuthed(req) {
  const auth = req.headers && (req.headers.authorization || req.headers.Authorization);
  if (auth && CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  if (!session) return false;
  const s = await rgetJSON(`session:${session}`, null);
  return !!(s && s.role === "admin");
}

export default async function handler(req, res) {
  const action = (req.query && req.query.action) || (req.body && req.body.action) || "";
  const cronOk = (req.query && req.query.cron === "1") && CRON_OK.has(action);
  if (!cronOk && !(await isAuthed(req))) { res.status(403).json({ error: "forbidden" }); return; }
  const host = req.headers && req.headers.host;
  try {
    if (action === "daily") { res.status(200).json(await runDailyBrain(ORG, req.query && req.query.force === "1")); return; }
    if (action === "state") { res.status(200).json({ proposals: await rgetJSON(K.proposals, []), lastrun: await rgetJSON(K.lastrun, null), config: await getConfig() }); return; }
    if (action === "synth") { // диагностика СИНТЕЗА: сырой ответ модели + статус парсинга (без отправки)
      const bundle = await gatherForBrain(ORG);
      let raw = "", err = null, parsed = null;
      try { raw = await callModel(BRAIN_SYSTEM, "Данные системы за сутки:\n" + JSON.stringify(bundle)); }
      catch (e) { err = "callModel: " + String(e && e.message || e); }
      if (raw) { try { const m = raw.replace(/```json|```/g, "").match(/\[[\s\S]*\]/); parsed = m ? JSON.parse(m[0]) : null; } catch (e) { err = (err || "") + " | parse: " + String(e && e.message || e); } }
      res.status(200).json({ ok: true, err, rawLen: raw.length, rawHead: raw.slice(0, 700), parsedCount: Array.isArray(parsed) ? parsed.length : null, parsed });
      return;
    }
    if (action === "peek") { // диагностика: ЧТО мозг видит на входе (чтобы отличить честный 0 от пустого входа)
      const b = await gatherForBrain(ORG);
      res.status(200).json({ ok: true, counts: {
        mopFindings: (b.mop || []).length, growthHyps: (b.growth || []).length, devFindings: (b.dev || []).length,
        deepsalesAnalyzed: b.deepsales ? b.deepsales.analyzed : 0,
        funnelBottleneck: b.funnel ? b.funnel.bottleneck : null, funnelUndiagnosable: b.funnel ? (b.funnel.undiagnosable || []).length : null,
      }, sample: b });
      return;
    }
    if (action === "button") { res.status(200).json(await handleMetaButton(req.body.act, req.body.id, host)); return; }
    if (action === "config") { const cur = await getConfig(); await rsetJSON(K.config, { ...cur, ...(req.body.config || {}) }); res.status(200).json({ ok: true, config: await getConfig() }); return; }
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
