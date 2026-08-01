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
import { sendTg, getPeople, sleep } from "./tg-bot.js";
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

const K = { proposals: "metabrain:proposals", seen: "metabrain:seen", config: "metabrain:config", lastrun: "metabrain:lastrun", msgmap: "metabrain:msgmap", lastdelivery: "metabrain:lastdelivery" };
const DEFAULT_CONFIG = { enabled: true, maxPerDay: 3, cooldownDays: 7, silentOnZero: true, heartbeatDow: 1, // heartbeat: понедельник
  digest: true, escalateAfterDays: 3, expireAfterDays: 10 }; // сводка вместо потока; важное эскалирует после 3д, мелочь протухает после 10д
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
      if (avg < 50) signals.push({ axis: "deepsales", direction: "support", detail: `разбором реальных звонков (${cov.analyzed} из ~${cov.monthCallsEstimate || "?"}, ${share}) — средняя оценка ${avg} из 100, низкая` });
      else if (avg >= 70) signals.push({ axis: "deepsales", direction: "contradict", detail: `разбор звонков у ${mop} даёт оценку ${avg} из 100 (${cov.analyzed} зв.) — на звонках скорее хорошо` });
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
      signals.push({ axis: "dev", direction: "caveat", detail: `по воронке продаж этот этап пока ${tr.trust === "suspicious" ? "считается ненадёжным (звонки идут мимо CRM)" : "без достаточных данных"} — вывод держать осторожно` });
    }
  }

  // ── Ось Growth — гипотеза по той же теме ──
  if (theme && Array.isArray(ctx.growthHyps)) {
    const open = ctx.growthHyps.filter((h) => (h.status || "open") === "open");
    const hit = open.find((h) => themeOf(`${h.observation || ""} ${h.claim || ""}`) === theme);
    if (hit) signals.push({ axis: "growth", direction: "context", detail: `анализ точек роста смотрит смежную тему: «${shortT(hit.observation || hit.claim, 90)}» — стоит сверить` });
  }

  const supports = signals.filter((s) => s.direction === "support");
  const contradicts = signals.filter((s) => s.direction === "contradict");
  const independentCount = new Set(supports.map((s) => s.axis)).size; // MOP сам НЕ считается «подтверждением себя»

  let strength, note;
  if (contradicts.length) { strength = "contested"; note = `⚠️ Внимание, есть обратное: ${contradicts[0].detail} — стоит перепроверить, прежде чем требовать.`; }
  else if (independentCount >= 1) { strength = "multi"; note = `Подтверждается также ${supports.map((s) => s.detail).join("; ")}.`; }
  else { strength = "single"; note = "Пока подтверждено только этим наблюдением по менеджерам, другими данными не перепроверено."; }
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
- Маркетинг (marketing-agent): окупаемость рекламы (ROAS), цена клиента (CAC), эффективность аудиторий (CTR/CPC/расход по adset), рост Instagram. Метрики с той же честностью: если написано «не диагностируется» — НЕ выдавай по ним вывод, это отдельное наблюдение о нехватке данных, а не о рекламе.

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
[{"topicKey":"stable_english_slug","title":"кратко суть","statement":"1-2 фразы что видно","sources":[{"agent":"MOP|Dev|Growth|DeepSales|Marketing","signal":"конкретный сигнал с цифрой"}],"independentSignals":2,"confidence":"high|med|low","contradiction":false,"caveats":["выборка звонков 1.1%"],"proposedTask":{"title":"задача кратко","why":"зачем и что сделать","deadlineDays":3,"scope":"pointwise|department","mop":"имя или null","recipient":"rop|marketing"}}]
‼️ recipient — КОМУ поручить исполнение: "marketing" — если наблюдение и действие про РЕКЛАМУ / окупаемость (ROAS) / цену лида (CPL/CAC) / аудитории-креативы / подписчиков-бренд / Instagram; "rop" — про отдел продаж / менеджеров / дозвон / скрипты / закрытие сделок. По умолчанию "rop". ВАЖНО про противоречия: если лидов много (реклама льёт), но конверсия в продажу низкая — проблема в ОТДЕЛЕ ПРОДАЖ (recipient="rop"), а не в маркетинге; и наоборот, если продажи закрывают хорошо, но лид дорогой/ROAS падает — это маркетинг (recipient="marketing"). Не путай, кто виноват.
‼️ topicKey — СТАБИЛЬНЫЙ короткий английский слаг ТЕМЫ проблемы (напр. false_guarantees, premature_pricing, uncalled_leads, closing_dropoff, misclassified_no_answer). Для ОДНОЙ И ТОЙ ЖЕ проблемы всегда один и тот же слаг, даже если формулировка меняется день ко дню. ЕСЛИ в конце данных есть список «УЖЕ ОТКРЫТЫЕ ТЕМЫ» — и твоё наблюдение про ту же проблему, то БЕРИ topicKey ТОЧНО оттуда (буква в букву) И НЕ включай это наблюдение в ответ вовсе (оно уже показано/принято). Новый topicKey — только для действительно НОВОЙ проблемы, которой в списке нет. По topicKey система гасит повторы — поэтому стабильность слага критична.
Если действие преждевременно (низкая уверенность/противоречие) — proposedTask всё равно дай, но как «проверить/не действовать» (напр. поручить проверить это на большем числе звонков).

‼️ КОНКРЕТИКА — ГЛАВНОЕ ТРЕБОВАНИЕ (без неё наблюдение БЕСПОЛЕЗНО):
В данных есть массив "examples" — реальные случаи из разборов: кто (mop), когда (date), что ИМЕННО сказано не так (whatWasSaid), как исправить (howToFix).
- Если наблюдение про качество разговоров — ты ОБЯЗАН опереться на examples и назвать в statement: ИМЯ менеджера, ДАТУ и СУТЬ сказанного своими словами («Komiljon 18 июля обещал гарантированное трудоустройство после курса»).
- Обобщённые формулировки БЕЗ примера — ЗАПРЕЩЕНЫ. Нельзя писать «неточная информация о продукте», «проблемы с гарантиями», «ошибки в презентации» и т.п., не сказав ЧТО именно прозвучало.
- Если по теме в examples примеров НЕТ — не выдумывай их и не выдавай размытое наблюдение вовсе: пропусти эту тему.
- proposedTask тоже конкретный: не «проверить формулировки», а «разобрать с Komiljon: он обещает гарантированное трудоустройство — заменить на честную формулировку».
- Имена менеджеров называть МОЖНО (это факт из разбора). Нельзя — вешать ярлыки на человека («слабый», «плохо работает») и делать вывод о его квалификации по паре звонков.

ЯЗЫК (КРИТИЧНО — читает ВЛАДЕЛЕЦ бизнеса, не программист; во ВСЕХ полях, включая title/statement/sources.signal/caveats/proposedTask):
- СТРОГО ЗАПРЕЩЕНЫ технические слова и коды: call_greeting, greeting, won, lost, closing, no_call, названия полей, английские термины, слова «находка», «сигнал», «ось», «выборка», «покрытие», «trust». Дроби вида «13/76» и «(~17%)» — тоже нельзя.
- Пиши как живому человеку, простыми словами, объясняя суть.
  Плохо: «ошибка greeting: won 13/76 (~17%) vs lost 8/86 (~9%)».
  Хорошо: «на приветствии менеджеры одинаково слабы и в удачных, и в проваленных сделках — значит проваливают продажи не из-за него».
- Источники называй по-человечески: DeepSales → «разбор реальных звонков»; воронка/Dev → «путь клиента по этапам продаж»; MOP → «наблюдение по работе менеджеров»; Growth → «анализ точек роста». В поле sources.agent оставляй короткий код (MOP/Dev/Growth/DeepSales) — его подменит приложение, а вот sources.signal пиши ПОЛНОСТЬЮ человеческим языком без цифр-дробей.
- Цифры — ориентирами словами: не «каждый 13-й из 76», а «примерно каждый шестой звонок»; проценты можно («около 17%»), дроби нельзя.
- Про малое число разобранных звонков говори по-человечески: «звонков разобрано пока мало — это повод проверить, а не вывод».`;

// КОНКРЕТНЫЕ ПРИМЕРЫ ошибок из разборов: кто, когда, что ИМЕННО сказал не так.
// Без этого мозг говорит обобщённо («неточная информация о продукте»), и владельцу нечего поручить.
// В записи разбора: mistakes[] = { tag, timestamp, mistake (описание), recommendation }.
async function callExamples(org, tags, perTag = 2) {
  const idx = await rgetJSON(`callanalysis:list:${org}`, []);
  if (!Array.isArray(idx) || !idx.length) return [];
  const out = [];
  for (const tag of tags) {
    const rows = idx.filter((r) => r && Array.isArray(r.mistakeTags) && r.mistakeTags.includes(tag)).slice(0, perTag);
    for (const r of rows) {
      try {
        const recs = await rgetJSON(`callanalysis:${org}:${r.leadId}`, []);
        const arr = Array.isArray(recs) ? recs : [recs].filter(Boolean);
        const rec = arr.find((x) => x && String(x.audioFileId) === String(r.audioFileId)) || arr[0];
        const m = rec && (rec.mistakes || []).find((x) => x && x.tag === tag);
        if (!m) continue;
        out.push({ tag, mop: r.mop || rec.mop || null, date: r.callDate || rec.callDate || null,
          status: r.status || rec.status || null, whatWasSaid: shortT(m.mistake, 240), howToFix: shortT(m.recommendation, 140) });
      } catch (e) { /* пример не достался — не блокирует остальные */ }
    }
  }
  return out;
}

async function gatherForBrain(org) {
  const [funnel, ca, mopFindings, growthHyps, devFindings, mkSnap] = await Promise.all([
    getVerifiedFunnel(org).catch(() => null),
    getCallAnalysisBundle(org).catch(() => null),
    rgetJSON("mopagent:findings", []).then((x) => (Array.isArray(x) ? x.filter((f) => f.status === "open") : [])).catch(() => []),
    rgetJSON("growthagent:hypotheses", []).then((x) => (Array.isArray(x) ? x : [])).catch(() => []),
    rgetJSON("devagent:findings", []).then((x) => (Array.isArray(x) ? x.filter((f) => f.status === "open") : [])).catch(() => []),
    rgetJSON("marketingagent:snapshot", null).catch(() => null),
  ]);
  // МАРКЕТИНГ-срез (marketing-agent): та же дисциплина «не диагностируется» — если метрика не посчиталась, так и пишем
  const um = (u) => u ? (u.value != null ? u.value : (u.undiagnosable ? "не диагностируется: " + u.undiagnosable : null)) : null;
  // ВАЛЮТА: total расход в сумах, а по аудиториям Meta отдаёт в валюте аккаунта (USD). Раньше в бандле
  // оба лежали рядом без пометки → LLM читал 452(USD) и 5.5М(сум) как несходящиеся и выдавал ЛОЖНУЮ
  // находку «расхождение в выгрузке». Приводим расход по аудиториям к сумам тем же курсом → всё в одной валюте.
  const mkRate = (mkSnap && mkSnap.currency && mkSnap.currency.rate) || 1;
  const marketing = mkSnap ? {
    roas: um(mkSnap.unit && mkSnap.unit.roas),
    cac: um(mkSnap.unit && mkSnap.unit.cac),
    adCurrency: (mkSnap.currency && mkSnap.currency.adCurrency) || null, // валюта cpc/cpm ниже (расходы уже приведены к сумам)
    adAccount: (mkSnap.ads && mkSnap.ads.total) ? { ctr: mkSnap.ads.total.ctr, cpc: mkSnap.ads.total.cpc, spendUZS: mkSnap.currency && mkSnap.currency.spendUZS } : null,
    adsets: (mkSnap.ads && Array.isArray(mkSnap.ads.adsets)) ? mkSnap.ads.adsets.slice(0, 6).map((a) => ({ name: a.name, ctr: a.ctr, cpc: a.cpc, spendUZS: a.spend != null ? Math.round(a.spend * mkRate) : null })) : [],
    instagram: (mkSnap.instagram && mkSnap.instagram.ok) ? { followers: mkSnap.instagram.followers_count, reach: mkSnap.instagram.reach } : null,
    dynamicsWoW: mkSnap.dynamics ? { followers: mkSnap.dynamics.followers, roas: mkSnap.dynamics.roas, cac: mkSnap.dynamics.cac, adsets: mkSnap.dynamics.adsets } : null,
  } : null;
  const caSummary = ca && ca.coverage ? {
    analyzed: ca.coverage.analyzed, byMop: ca.coverage.byMop,
    team: ca.team ? { wonMistakes: ca.team.won && ca.team.won.mistakeTags, lostMistakes: ca.team.lost && ca.team.lost.mistakeTags } : null,
    recent: (ca.recent || []).slice(0, 8).map((r) => ({ mop: r.mop, status: r.status, score: r.score, headline: shortT(r.headline, 80) })),
  } : null;
  // примеры берём по самым частым ошибкам в ПРОИГРАННЫХ разговорах — там, где потери
  const lostTags = (ca && ca.team && ca.team.lost && ca.team.lost.mistakeTags) || {};
  const topTags = Object.entries(lostTags).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
  const examples = topTags.length ? await callExamples(org, topTags, 2).catch(() => []) : [];
  return {
    funnel: funnel ? { bottleneck: funnel.bottleneck, undiagnosable: funnel.undiagnosable, telephonySuspicious: funnel.telephonySuspicious, stages: (funnel.stages || []).map((s) => ({ stage: s.stage, value: s.value, trust: s.trust, transition: s.transitionFromPrev })) } : null,
    mop: mopFindings.map((f) => ({ scope: f.scope, type: f.type, mop: f.mop || null, title: shortT(f.title, 120), fact: shortT(f.fact, 160) })),
    growth: growthHyps.filter((h) => (h.status || "open") === "open").slice(0, 8).map((h) => ({ status: h.status, obs: shortT(h.observation || h.claim, 140) })),
    dev: devFindings.slice(0, 8).map((f) => ({ status: f.status, claim: shortT(f.claim, 140) })),
    deepsales: caSummary,
    marketing, // окупаемость рекламы (ROAS), цена клиента (CAC), эффективность аудиторий, Instagram — с той же честностью
    examples, // КТО / КОГДА / ЧТО ИМЕННО сказано не так — обязательны для конкретики наблюдения
  };
}

// Отпечаток для дедупа — по СТАБИЛЬНОМУ topicKey (модель даёт один и тот же слаг для одной проблемы),
// а не по тексту: формулировка каждый день чуть другая, и текстовый отпечаток не совпадал → дубли.
function fingerprint(o) { const k = String(o.topicKey || "").toLowerCase().trim(); return k || themeOf((o.title || "") + " " + (o.statement || "")) || String(o.title || "").toLowerCase().slice(0, 24); }

// ─────────────────────────────────────────────────────────────────────────────
// ЧАСТЬ 2б: РАЗГРУЗКА ОЧЕРЕДИ РЕШЕНИЙ — сводка вместо потока, приоритет по ВЛИЯНИЮ,
// эскалация проигнорированного важного (громче, а не тише), протухание неважного.
// ВСЁ детерминированно (в коде), LLM «что важнее» не решает.
// ─────────────────────────────────────────────────────────────────────────────
export const OPEN_STATUSES = ["pending", "awaiting_edit", "edited"];
// ЮР. РИСК (tier 3) — только ГЕНУИННАЯ юридическая/регуляторная угроза. «Гарантия трудоустройства»
// в Hunter Academy сюда НЕ входит: работа реально гарантируется (при условии), это вопрос ТОЧНОСТИ
// формулировки (tier 2), а не liability (см. [[call-analysis-deepsales]] — было ложное срабатывание DeepSales).
// ЮР.РИСК (tier 3) — реальная liability: претензии/штрафы/суд/налоги/перс.данные/регулятор/жалобы + ОБЕЩАНИЯ,
// КОТОРЫХ КОМПАНИЯ НЕ ДАЁТ (гарантированное трудоустройство/результат, «запрещено правилами»). НЕ по слову
// «договор» — оно живёт в обычной технике продаж («называют договор до диагностики» = коучинг, не liability).
// РЕАЛЬНЫЙ ЮР.РИСК → РЕШЕНИЕ владельца (претензии/штрафы/суд/налоги/перс.данные/регулятор/жалобы).
const HARD_LEGAL_RX = /штраф|\bсуд\b|суде[бн]|налог|\bзакон\b|персональн\w+\s+данн|регулятор|жалоб/i;
// ЗАПРЕЩЁННОЕ ОБЕЩАНИЕ (гарантия трудоустройства/результата, «запрещено правилами») → это разбор конкретного
// менеджера (работа РОПа) С compliance-оттенком → категория "rop_notify": задача РОПу + ИНФО владельцу (без кнопки).
const COMPLIANCE_RX = /трудоустройств|гарантированн|100\s*%\s*гарант|гаранти\w*\s+результат|запрещ\w+\s+правил/i;
// НАСТРОЙКА CRM / ИЗМЕРЕНИЙ (нельзя отличить/увидеть, нет поля/статуса, конфигурация) → меняет УСЛОВИЯ измерения
// бизнеса, а не работа с клиентами → решение владельца, НЕ операционка РОПа.
const CONFIG_RX = /нельзя\s+(отличить|увидеть|понять|разделить|различить)|в систем\w+\s+нельзя|нет\s+(поля|статуса)\s+оплат|настро\w*[\s\wа-яё]*?(amocrm|\bcrm\b|воронк|статус)|отдельн\w+\s+статус|конфигурац/i;
// ОПЕРАЦИОНКА ОП (tier 2) — деньги + точность продаж (звонки/лиды/статусы/конверсия/закрытие).
const REVENUE_RX = /звон|дозвон|недозвон|не звонил|\bлид|стату[сн]|ложн|конверси|закрыт|оплат|сделк|выручк|касс|no_call|скрипт|возражен|дожим/i;
function ptext(p) { return `${p.title || ""} ${p.statement || ""} ${(p.proposedTask && p.proposedTask.title) || ""} ${(p.proposedTask && p.proposedTask.why) || ""}`; }
// ВЛИЯНИЕ (детерминированно): 3=юр.риск/compliance, 2=выручка, 1=прочее. (Compliance тоже высокое влияние.)
export function impactTier(p) {
  const t = ptext(p);
  if (HARD_LEGAL_RX.test(t) || COMPLIANCE_RX.test(t)) return 3;
  if (REVENUE_RX.test(t)) return 2;
  return 1;
}
const CONF_W = { high: 3, med: 2, low: 1 };
export function daysPending(p, nowMs) { return Math.max(0, Math.floor((nowMs - (p.at || nowMs)) / 86400000)); }
// приоритет: влияние доминирует, затем уверенность, затем возраст (эскалация проигнорированного).
export function priorityScore(p, nowMs) {
  return impactTier(p) * 1000 + (CONF_W[p.confidence] || 1) * 100 + Math.min(daysPending(p, nowMs), 30) * 3;
}

// РАЗДЕЛЕНИЕ ПРЕДЛОЖЕНИЙ ПО ЦЕНЕ ОШИБКИ (не по источнику). Готовый impactTier — БЕЗ третьего классификатора.
//  → РОПу АВТОМАТОМ (ошибка дешёвая — РОП не согласится, потерь нет; как находки MOP-агента): операционка ОП =
//    revenue-тема (tier 2) + адресат РОП + данные надёжны.
//  → ВЛАДЕЛЬЦУ (дорого/меняет условия): юр.риск (tier 3); не-РОП адресат (маркетинг = деньги/канал); ненадёжные
//    данные (confidence "low" — по TRUST-ГЕЙТу это «единственная опора suspicious/неполное окно»); «пока не
//    действовать» (contradiction); либо неясно (tier 1) → по умолчанию к владельцу, консервативно.
// ТРАТА ДЕНЕГ / НОВЫЙ КАНАЛ в маркетинге → решение владельца. Разбор/проверка/мониторинг креатива/качества — НЕТ.
const MKT_MONEY_RX = /(увеличи|подня|повыси|добав|нарасти|влож)[а-яё]*\s+(бюджет|ставк|расход|вложен|трат|денег|деньг)|(запус|потрат|выдел)[а-яё]*\s+[а-яё\s«»]*?(бюджет|кампан|канал|денег|деньг)|масштабир|нов[а-яё]*\s+канал/i;
// Категории: "rop"/"marketing" (операционка → авто исполнителю) | "rop_notify" (РОП разбирает + инфо владельцу) |
// "owner" (решение владельца) | "none" (наблюдение «не действовать» — вообще НЕ в очередь, живёт как контекст в чате).
export function classifyProposal(p) {
  const t = ptext(p);
  const recipient = (p.proposedTask && p.proposedTask.recipient) === "marketing" ? "marketing" : "rop";
  if (p.contradiction) return { to: "none", reason: "наблюдение «не действовать» — не решение, из очереди убрано" };
  if (HARD_LEGAL_RX.test(t)) return { to: "owner", reason: "реальный юр.риск / претензии — решение владельца" };
  if (CONFIG_RX.test(t)) return { to: "owner", reason: "настройка CRM / измерений — меняет условия, решение владельца" };
  if (recipient !== "rop") { // МАРКЕТИНГ: смотрим на РЕКОМЕНДУЕМОЕ ДЕЙСТВИЕ (proposedTask), а не на всё наблюдение —
    // «проверить крео» = разбор маркетолога, даже если само наблюдение про рост/масштаб аудитории.
    const pt = p.proposedTask || {};
    const actionText = `${pt.title || ""} ${pt.why || ""}`.trim() || p.title || ""; // судим по РЕКОМЕНДУЕМОМУ действию (не по наблюдению с «рост/масштаб»)
    if (MKT_MONEY_RX.test(actionText)) return { to: "owner", reason: "маркетинг — трата денег/новый канал, решение владельца" };
    return { to: "marketing", reason: "маркетинг-операционка (проверить/разобрать/следить/креатив/качество) — сразу маркетологу" };
  }
  if (COMPLIANCE_RX.test(t)) return { to: "rop_notify", reason: "разбор менеджера + информировать владельца (запрещённое обещание)" };
  if (impactTier(p) < 2) return { to: "owner", reason: "не операционка ОП — по умолчанию к владельцу" };
  // Операционка ОП → РОПу. confidence "low" ≈ ОДИН источник (independentSignals:1), НЕ дырявые данные → слабое
  // основание держать у владельца. При low задача формулируется как «проверить/разобрать» (не вслепую).
  return { to: "rop", reason: "операционка отдела продаж", verify: p.confidence === "low" };
}
// важное (выручка/юр.риск), провисевшее >= N дней → эскалируем (флаг «висит N дней»), НЕ глушим.
export function isEscalated(p, nowMs, escalateAfterDays) { return impactTier(p) >= 2 && daysPending(p, nowMs) >= (escalateAfterDays || 3); }
// вердикт: важное старое → escalate (никогда не протухает молча); мелочь старая → expire (с уведомлением); иначе keep.
export function expiryVerdict(p, nowMs, cfg) {
  const d = daysPending(p, nowMs), tier = impactTier(p);
  const escN = (cfg && cfg.escalateAfterDays) || 3, expN = (cfg && cfg.expireAfterDays) || 10;
  if (tier >= 2 && d >= escN) return "escalate";
  if (tier === 1 && d >= expN) return "expire";
  return "keep";
}
export function groupKeyOf(p) { return String(p.topicKey || "").toLowerCase().trim() || themeOf((p.title || "") + " " + (p.statement || "")) || String(p.title || "").toLowerCase().slice(0, 24); }

// buildDigest: чистая функция над ВСЕМИ предложениями → приоритезированные группы + что протухло.
export function buildDigest(allProposals, nowMs, cfg) {
  const open = (allProposals || []).filter((p) => p && OPEN_STATUSES.includes(p.status));
  const expired = [], kept = [];
  for (const p of open) (expiryVerdict(p, nowMs, cfg) === "expire" ? expired : kept).push(p);
  const gmap = new Map();
  for (const p of kept) {
    const k = groupKeyOf(p);
    const g = gmap.get(k) || { key: k, items: [], score: -1, top: null, escalated: false, maxDays: 0 };
    g.items.push(p);
    const sc = priorityScore(p, nowMs);
    if (sc > g.score) { g.score = sc; g.top = p; }
    if (isEscalated(p, nowMs, cfg && cfg.escalateAfterDays)) g.escalated = true;
    g.maxDays = Math.max(g.maxDays, daysPending(p, nowMs));
    gmap.set(k, g);
  }
  const groups = [...gmap.values()].map((g) => ({ ...g, count: g.items.length })).sort((a, b) => b.score - a.score);
  return { totalOpen: kept.length, groups, top: groups.slice(0, 3), expired };
}

const IMPACT_LABEL = { 3: "юр. риск", 2: "выручка", 1: "прочее" };
export function formatDigest(dg, cfg) {
  if (!dg || (!dg.totalOpen && !dg.expired.length)) return null;
  let s = `🧠 <b>Решения, ждущие вас: ${dg.totalOpen}</b>\n`;
  if (dg.top.length) {
    s += `Самое важное — можно решить прямо здесь:\n`;
    dg.top.forEach((g, i) => {
      const p = g.top;
      s += `\n<b>${i + 1}. ${p.title}</b> · ${IMPACT_LABEL[impactTier(p)]}`;
      if (g.count > 1) s += ` · ${g.count} сигнала`;
      if (g.escalated) s += ` · ⏳ висит ${g.maxDays} дн`;
      if (p.proposedTask && p.proposedTask.title) s += `\n${p.contradiction ? "⚠️ пока НЕ действовать: " : "Предлагаю: "}${shortT(p.proposedTask.title, 90)}`;
      s += `\n`;
    });
    const shown = dg.top.reduce((n, g) => n + g.count, 0);
    const rest = dg.totalOpen - shown;
    if (rest > 0) s += `\nОстальные ${rest} — кнопка «Показать все» ниже.`;
  }
  if (dg.expired.length) s += `\n\n♻️ Закрыл за давностью (неважные, >${(cfg && cfg.expireAfterDays) || 10} дн, не требуют решения): ${dg.expired.map((p) => shortT(p.title, 40)).join("; ")}`;
  return s;
}

// ЛОЖНАЯ находка «расхождение расходов по аудиториям» — была артефактом валют (сумы vs USD) в бандле,
// исправлено. Детектор, чтобы само-отозвать её (и pending-предложение, и реальную задачу маркетологу),
// пока живой человек не потратил на неё время.
export function isFalseAdsetSpendMismatch(p) {
  const t = `${(p && p.topicKey) || ""} ${(p && p.title) || ""} ${(p && p.statement) || ""} ${(p && p.proposedTask && p.proposedTask.title) || ""}`.toLowerCase();
  const aboutAdsetSpend = /(adset|аудитор)/.test(t) && /(spend|расход|трат|выгруз)/.test(t);
  const aboutMismatch = /(mismatch|не сход|расхожд|не совпад|разн\w*\s*валют|разошл)/.test(t);
  return aboutAdsetSpend && aboutMismatch;
}

export async function runDailyBrain(org = ORG, force = false) {
  const cfg = await getConfig();
  if (!cfg.enabled && !force) return { ok: true, skipped: "disabled" };
  const bundle = await gatherForBrain(org);
  const nowMs = Date.now();
  const coolMs = (cfg.cooldownDays || 7) * 86400000;
  const proposals = await rgetJSON(K.proposals, []);
  // УЖЕ ОТКРЫТЫЕ/НЕДАВНИЕ темы → отдаём модели, чтобы она ПЕРЕИСПОЛЬЗОВАЛА topicKey (а не выдумывала новый слаг для той же проблемы).
  const existingTopics = proposals
    .filter((p) => p && p.topicKey && (["pending", "awaiting_edit", "edited", "confirmed", "delivered"].includes(p.status) || (p.status === "closed" && p.closedAt && (nowMs - p.closedAt) < coolMs)))
    .map((p) => ({ topicKey: p.topicKey, about: shortT(p.title, 60) }));
  // 16000: Sonnet-5 тратит часть бюджета на рассуждения, а с требованием конкретики ответ длиннее.
  // ДИАГНОСТИКА обязательна: при обрыве вывода observed=0 выглядит как «нечего сказать» — это уже
  // дважды маскировало реальный сбой. Пишем причину в lastrun и в ответ.
  let observations = [], diag = {};
  try {
    const userMsg = "Данные системы за сутки:\n" + JSON.stringify(bundle)
      + (existingTopics.length ? "\n\nУЖЕ ОТКРЫТЫЕ ТЕМЫ (эти проблемы уже в работе). Правило по КАЖДОЙ: если проблема ВСЁ ЕЩЁ видна в сегодняшних данных — ОБЯЗАТЕЛЬНО верни её в ответе с ТЕМ ЖЕ topicKey (повторную задачу мы не создадим — по этому мы лишь понимаем, что проблема ещё жива). Если в данных её больше НЕТ — просто НЕ возвращай её: это сигнал, что она ушла, и задачу снимут:\n" + JSON.stringify(existingTopics) : "");
    const raw = await callModel(BRAIN_SYSTEM, userMsg, 16000);
    diag.rawLen = raw.length;
    const m = raw.replace(/```json|```/g, "").match(/\[[\s\S]*\]/);
    if (!m) diag.err = "JSON-массив не найден — похоже, вывод оборвался";
    observations = m ? JSON.parse(m[0]) : [];
    if (!Array.isArray(observations)) observations = [];
  } catch (e) { observations = []; diag.err = String((e && e.message) || e).slice(0, 200); }

  // ДЕДУП. Блокируем повтор наблюдения, если его отпечаток уже:
  //  • у АКТИВНОГО предложения (ждёт решения / подтверждено / доставлено РОПу) — оно в работе;
  //  • у НЕДАВНО ЗАКРЫТОГО (РОП принял/выполнил) — в пределах кулдауна;
  //  • в seen-кулдауне (ранее отклонено или подтверждено).
  // Без этого подтверждённая или принятая РОПом задача возвращалась заново каждый день.
  const seen = await rgetJSON(K.seen, {});
  const nowDay = tkDay();
  const blockedFps = new Set();
  const activeIdxByFp = new Map(); // fp → индекс активного предложения (для штампа «ещё видно в данных»)
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    if (!p || !p.fingerprint) continue;
    const active = ["pending", "awaiting_edit", "edited", "confirmed", "delivered"].includes(p.status);
    const recentClosed = p.status === "closed" && p.closedAt && (nowMs - p.closedAt) < coolMs;
    if (active || recentClosed) blockedFps.add(p.fingerprint);
    if (active && !activeIdxByFp.has(p.fingerprint)) activeIdxByFp.set(p.fingerprint, i);
  }
  const fresh = [];
  for (const o of observations) {
    if (!o || !o.title || !o.proposedTask) continue;
    const fp = fingerprint(o);
    // ПЕРЕПОДТВЕРЖДЕНИЕ СВЕЖЕСТИ: модель вернула тему, значит проблема ещё видна в данных → штампуем активное
    // предложение «ещё актуально». Дедуп ниже не даст создать дубль, но факт «жив» мы теперь фиксируем.
    const ai = activeIdxByFp.get(fp);
    if (ai != null) proposals[ai] = { ...proposals[ai], lastSeenAt: nowMs, lastSeenDay: nowDay };
    if (blockedFps.has(fp)) continue; // активное или недавно закрытое — не повторяем
    const s = seen[fp];
    if (s && s.until && nowMs < s.until) continue; // в кулдауне
    fresh.push({ ...o, fingerprint: fp });
  }
  fresh.sort((a, b) => ({ high: 0, med: 1, low: 2 }[a.confidence] ?? 3) - ({ high: 0, med: 1, low: 2 }[b.confidence] ?? 3));
  const send = fresh.slice(0, cfg.maxPerDay);

  const created = [];
  for (const o of send) {
    const id = propId(o.fingerprint);
    const rec = { id, at: nowMs, day: nowDay, lastSeenAt: nowMs, lastSeenDay: nowDay, ...o, status: "pending" };
    proposals.push(rec); created.push(rec);
    // СРОЧНОЕ (юр. риск) — отдельным сообщением сразу; всё остальное уходит в дневную сводку.
    if (cfg.digest !== false && impactTier(rec) === 3) { await sendProposalToOwner(rec); await sleep(400); }
  }

  if (cfg.digest === false) {
    // legacy-режим (поток по одному) — на случай отката
    for (const rec of created) { await sendProposalToOwner(rec); await sleep(400); }
    await rsetJSON(K.proposals, proposals.slice(-CAP.proposals));
    await rsetJSON(K.lastrun, { at: nowMs, day: nowDay, observed: observations.length, sent: created.length, diag });
    return { ok: true, observed: observations.length, sent: created.length, ids: created.map((c) => c.id), diag };
  }

  // САМО-ОТЗЫВ ложной adset-spend-находки (артефакт валют, исправлен): закрываем и предложение,
  // и — если успела превратиться — реальную задачу маркетологу, чтобы человек не тратил время.
  const FALSE_CLOSABLE = ["pending", "awaiting_edit", "edited", "confirmed"];
  for (let k = 0; k < proposals.length; k++) {
    const p = proposals[k];
    if (p && FALSE_CLOSABLE.includes(p.status) && isFalseAdsetSpendMismatch(p)) {
      proposals[k] = { ...p, status: "closed", closedAt: nowMs, closeReason: "ложная тревога: расхождение было в отображении валют (сумы vs USD), в выгрузке всё верно — снято" };
    }
  }
  try {
    const mtasks = await rgetJSON("marketingtasks", []);
    let changed = false;
    for (const mt of mtasks) {
      if (mt && mt.status !== "done" && isFalseAdsetSpendMismatch({ title: mt.title, statement: mt.desc || mt.why || mt.text || "" })) { mt.status = "done"; mt.doneAt = nowMs; mt.doneBy = "system:false-positive"; changed = true; }
    }
    if (changed) await rsetJSON("marketingtasks", mtasks);
  } catch (e) {}

  // ГЕЙТ СВЕЖЕСТИ: операционную задачу нельзя ставить/держать РОПу, если её факт не подтверждается данными
  // staleAfterDays дней подряд (то же правило, что снятие неактуального у MOP). Инвалидируем ДО раздачи —
  // тогда устаревшее вообще не станет задачей; уже поставленное снимется с честным уведомлением РОПу (не «решено»,
  // а «в данных больше не видно»). Ставить задачу по решённой проблеме — хуже, чем не ставить.
  const staleMs = (cfg.staleAfterDays || 3) * 86400000;
  for (let k = 0; k < proposals.length; k++) {
    const p = proposals[k];
    if (!p) continue;
    const activeMeta = ["pending", "confirmed", "delivered"].includes(p.status);
    const ropTask = (p.proposedTask && p.proposedTask.recipient) !== "marketing"; // гейт — для операционки РОПа
    if (!activeMeta || !ropTask) continue;
    const lastSeen = p.lastSeenAt || p.at || nowMs;
    if (nowMs - lastSeen >= staleMs) {
      proposals[k] = { ...p, status: "closed", invalidated: true, ropNotified: false, closedAt: nowMs, closeReason: "not_reproduced" };
      try { await setSeen(p.fingerprint, 3); } catch (e) {} // короткий кулдаун: вернётся заново, если факт снова появится в данных
    }
  }
  // СВОДКА над ВСЕМИ открытыми (включая старые pending — они НЕ теряются) + протухание неважного.
  const dg = buildDigest(proposals, nowMs, cfg);
  for (const e of dg.expired) { const j = proposals.findIndex((x) => x.id === e.id); if (j >= 0) proposals[j] = { ...proposals[j], status: "expired", expiredAt: nowMs }; }
  await rsetJSON(K.proposals, proposals.slice(-CAP.proposals));
  // АВТО-РАЗДАЧА: операционку ОП сразу ставим РОПу (classifyProposal), владелец не согласует коучинг/дисциплину.
  // Дорогое/условное/юр.риск остаётся pending → в очереди решений владельца. Владелец видит счётчик в отчёте.
  const auto = await autoDispatchProposals(org).catch(() => ({ ropCount: 0, ownerCount: 0 }));
  // СВОДКА ВЛАДЕЛЬЦУ БОЛЬШЕ НЕ ШЛЁТСЯ (убрали слой «система рассказывает о наблюдениях»). Предложения работают
  // ВНУТРИ: накапливаются здесь, советник видит их в чате (pendingBlock), а результат — новые задачи — в отчёте.
  await rsetJSON(K.lastrun, { at: nowMs, day: nowDay, observed: observations.length, sent: created.length, created: created.length, totalOpen: dg.totalOpen, expired: dg.expired.length, delivered: false, autoRop: auto.ropCount, autoOwner: auto.ownerCount, diag });
  return { ok: true, observed: observations.length, created: created.length, totalOpen: dg.totalOpen, autoRop: auto.ropCount, autoOwner: auto.ownerCount, expired: dg.expired.length, delivered: false, ids: created.map((c) => c.id), diag };
}

// ОТПРАВКА СВОДКИ владельцу + ФИКСАЦИЯ ФАКТА ДОСТАВКИ (чтобы сбой Telegram не был молчаливым).
async function sendDigest(dg, cfg) {
  const text = formatDigest(dg, cfg);
  if (!text) return { ok: false, skipped: "nothing" };
  const ppl = await getPeople().catch(() => ({}));
  if (!ppl.owner || !ppl.owner.chatId) { await rsetJSON(K.lastdelivery, { at: Date.now(), ok: false, error: "owner не привязан", totalOpen: dg.totalOpen }); return { ok: false, error: "owner not bound" }; }
  const rows = dg.top.map((g) => ([
    { text: `✅ ${shortT(g.top.title, 18)}`, callback_data: `mb:confirm:${g.top.id}` },
    { text: "❌", callback_data: `mb:reject:${g.top.id}` },
  ]));
  if (dg.totalOpen > dg.top.reduce((n, g) => n + g.count, 0)) rows.push([{ text: `📋 Показать все (${dg.totalOpen})`, callback_data: "mb:list" }]);
  const sent = await sendTg("owner", ppl.owner.chatId, text, { reply_markup: { inline_keyboard: rows } });
  await rsetJSON(K.lastdelivery, { at: Date.now(), ok: !!(sent && sent.ok), messageId: (sent && sent.messageId) || null, error: (sent && sent.error) || null, totalOpen: dg.totalOpen });
  return sent;
}

const CONF_BADGE = { high: "🟢 высокая", med: "🟡 средняя", low: "🔴 низкая" };
// коды источников → человеческие имена (владелец не должен видеть DeepSales/MOP/Dev)
const SRC_NAME = { DeepSales: "Разбор реальных звонков", MOP: "Наблюдение по менеджерам", Dev: "Путь клиента по воронке", Growth: "Анализ точек роста" };
function fmtProposal(p) {
  const t = p.proposedTask || {};
  const srcLine = (p.sources || []).map((s) => `• ${SRC_NAME[s.agent] || s.agent}: ${s.signal}`).join("\n");
  let s = `🧠 <b>Сводное наблюдение · ${p.day}</b>\n\n`;
  s += `${p.contradiction ? "⚠️" : "📌"} <b>${p.title}</b>\n`;
  if (p.statement) s += `${p.statement}\n`;
  s += `\nНа чём основано:\n${srcLine}\n`;
  s += `Насколько уверен: ${CONF_BADGE[p.confidence] || p.confidence}`;
  if (p.caveats && p.caveats.length) s += ` — ${p.caveats.join("; ")}`;
  s += `\n\n`;
  const whoTo = t.recipient === "marketing" ? "маркетологу" : "руководителю продаж";
  s += p.contradiction
    ? `Предлагаю пока НЕ действовать: ${t.why || t.title}\n`
    : `Предлагаю поручить ${whoTo}:\n«${t.title}»${t.why ? ` — ${t.why}` : ""}${t.deadlineDays ? ` Срок: ${t.deadlineDays} дн.` : ""}\n`;
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
    const recipient = t.recipient === "marketing" ? "marketing" : "rop";
    // АВТО-РАЗДАЧА при низкой уверенности (один источник) → формулируем как «проверить/разобрать», НЕ «сделай вслепую».
    const baseTitle = t.title || p.title || "";
    const title = (p.auto && p.confidence === "low" && !/^\s*(провер|разобра)/i.test(baseTitle)) ? `Проверить/разобрать: ${baseTitle}` : baseTitle;
    return {
      id: `mb_${p.id}`, title, fact: t.why || p.statement || "", action: t.why || "",
      // маркетинг-задача → scope "marketing" (не показываем сейлз-пометки 🏢/👤), получатель — Маркетолог
      deadline: dl, scope: recipient === "marketing" ? "marketing" : (t.scope === "department" ? "department" : "pointwise"),
      mop: recipient === "marketing" ? null : (t.mop || null), recipient,
      corroboration: `по сводному наблюдению общего мозга, ${p.auto ? "поставлено системой автоматически (операционка ОП)" : "подтверждено владельцем"}${p.confidence ? ` (уверенность ${p.confidence})` : ""}`,
      metaSource: true,
    };
  });
}

// АВТО-РАЗДАЧА предложений: операционку ОП (classifyProposal → "rop") подтверждаем САМИ (status "confirmed",
// auto:true) → дальше getConfirmedMetaTasks отдаёт их task-agent'у как задачи РОПу. Дорогие/условные (→ "owner")
// остаются pending и всплывают в очереди решений владельца. dryRun=true — только разбивка, без изменений.
// Идемпотентно + РЕКОНСИЛ: обрабатываем pending И ранее авто-подтверждённые (auto:true). Операционку/compliance
// (rop, rop_notify) подтверждаем (→ задача РОПу); если что-то авто-раздали РАНЬШЕ, а по новым правилам оно →
// владельцу/none — откатываем в pending (не держим у РОПа лишнее). rop_notify пишем в notify-лог (инфо владельцу).
export async function autoDispatchProposals(org = ORG, opts = {}) {
  const dryRun = !!opts.dryRun;
  const proposals = (await rgetJSON(K.proposals, [])) || [];
  const rop = [], owner = [], none = [], notify = [];
  const isActive = (p) => OPEN_STATUSES.includes(p.status) || (p.status === "confirmed" && p.auto);
  for (const p of proposals) {
    if (!p || !isActive(p)) continue;
    const c = classifyProposal(p);
    const row = { id: p.id, title: p.title, tier: impactTier(p), recipient: (p.proposedTask && p.proposedTask.recipient) || "rop", confidence: p.confidence || null, reason: c.reason, to: c.to };
    if (c.to === "rop" || c.to === "rop_notify" || c.to === "marketing") { rop.push(row); if (c.to === "rop_notify") notify.push({ id: p.id, title: p.title }); } // rop[] = «авто-раздано исполнителю» (РОП ИЛИ маркетолог)
    else if (c.to === "owner") owner.push(row);
    else none.push(row);
  }
  if (!dryRun) {
    const nowMs = Date.now();
    const dispatchIds = new Set(rop.map((r) => r.id));
    const notifyIds = new Set(notify.map((n) => n.id));
    let changed = false;
    for (let i = 0; i < proposals.length; i++) {
      const p = proposals[i];
      if (!p || !isActive(p)) continue;
      if (dispatchIds.has(p.id) && OPEN_STATUSES.includes(p.status)) { proposals[i] = { ...p, status: "confirmed", auto: true, notify: notifyIds.has(p.id), confirmedAt: nowMs }; changed = true; }
      else if (!dispatchIds.has(p.id) && p.status === "confirmed" && p.auto) { proposals[i] = { ...p, status: "pending", auto: false }; changed = true; } // реконсил: раньше авто, теперь → владельцу/none
    }
    if (changed) await rsetJSON(K.proposals, proposals);
    const day = tkDay();
    const append = async (key, items) => { const log = (await rgetJSON(key, [])) || []; for (const it of items) if (!log.some((x) => x.id === it.id)) log.push({ id: it.id, title: it.title, at: nowMs }); await rsetJSON(key, log.slice(-100)); };
    if (rop.length) await append(`metabrain:autodispatch:${org}:${day}`, rop);
    if (notify.length) await append(`metabrain:notify:${org}:${day}`, notify);
  }
  return { ropCount: rop.length, ownerCount: owner.length, noneCount: none.length, rop, owner, none, notify };
}

// Для строк в отчёте по команде (автономно ≠ втайне): сколько система поставила РОПу сегодня + что «замечено» (compliance).
export async function getAutoDispatchedToday(org = ORG) { return (await rgetJSON(`metabrain:autodispatch:${org}:${tkDay()}`, [])) || []; }
export async function getComplianceNotifiedToday(org = ORG) { return (await rgetJSON(`metabrain:notify:${org}:${tkDay()}`, [])) || []; }

// Свежеинвалидированные (факт больше не подтверждается данными) metabrain-задачи для уведомления РОПа — аналог
// getFreshAutoClosed у MOP. task-agent сам НЕ пишет про задачи, которые РОП НИКОГДА не видел (гейт по pingDay),
// поэтому pending-инвалидации (в задачу так и не превратившиеся) до РОПа не дойдут — это правильно.
export async function getFreshInvalidatedMeta() {
  const proposals = await rgetJSON(K.proposals, []);
  const fresh = proposals.filter((p) => p && p.invalidated && p.status === "closed" && !p.ropNotified);
  if (fresh.length) {
    const ids = new Set(fresh.map((p) => p.id));
    await rsetJSON(K.proposals, proposals.map((p) => ids.has(p.id) ? { ...p, ropNotified: true } : p));
  }
  return fresh.map((p) => ({ id: `mb_${p.id}`, title: (p.finalTask && p.finalTask.title) || (p.proposedTask && p.proposedTask.title) || p.title || "", closeReason: p.closeReason || "not_reproduced" }));
}

// РАЗОВАЯ ПЕРЕГЕЙТИРОВКА: сбросить уже авто-розданные РОПу операционные предложения обратно в pending, чтобы
// ближайший дневной прогон пропустил их через ГЕЙТ СВЕЖЕСТИ (переподтверждение в данных) и заново раздал ТОЛЬКО
// те, чей факт ещё жив. Раздачи по расписанию нет — вызывается вручную. Идемпотентно: нет confirmed+auto → 0.
export async function regateConfirmedMeta(org = ORG) {
  const proposals = await rgetJSON(K.proposals, []);
  let n = 0;
  for (let i = 0; i < proposals.length; i++) {
    const p = proposals[i];
    if (p && p.status === "confirmed" && p.auto) { proposals[i] = { ...p, status: "pending", auto: false, regatedAt: Date.now() }; n++; }
  }
  if (n) await rsetJSON(K.proposals, proposals);
  return { ok: true, regated: n };
}

// Закрытие подтверждённой задачи (аналог closeMopFinding) — вызывается task-agent при dispute/выполнении.
export async function closeMetaProposal(taskId, reason) {
  const id = String(taskId || "").replace(/^mb_/, "");
  const proposals = await rgetJSON(K.proposals, []);
  const i = proposals.findIndex((p) => p.id === id);
  if (i < 0) return false;
  proposals[i] = { ...proposals[i], status: "closed", closeReason: reason || "", closedAt: Date.now() };
  await rsetJSON(K.proposals, proposals);
  try { await setSeen(proposals[i].fingerprint, 14); } catch (e) {} // принято/выполнено РОПом → не всплывать 2 недели
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
  // «Показать все» — полный список открытых, приоритезированный (без id).
  if (act === "list") {
    const now = Date.now();
    const dg = buildDigest(proposals, now, cfg);
    if (!dg.groups.length) return { ok: true, toast: "Пусто", ownerMsg: "Открытых предложений нет." };
    let s = `🧠 <b>Все открытые решения (${dg.totalOpen}):</b>\n`;
    dg.groups.forEach((g, i2) => { const p = g.top; s += `\n${i2 + 1}. <b>${shortT(p.title, 70)}</b> · ${IMPACT_LABEL[impactTier(p)]}${g.count > 1 ? ` · ${g.count} сигнала` : ""}${isEscalated(p, now, cfg.escalateAfterDays) ? ` · ⏳ ${g.maxDays} дн` : ""}`; });
    s += `\n\nРешить самые важные — кнопками в дневной сводке или в разделе «Тренер».`;
    return { ok: true, toast: `Открытых: ${dg.totalOpen}`, ownerMsg: s };
  }
  const i = proposals.findIndex((p) => p.id === id);
  if (i < 0) return { ok: false, toast: "предложение не найдено" };
  const p = proposals[i];

  if (act === "confirm") {
    if (p.status !== "pending" && p.status !== "edited") return { ok: true, toast: "уже обработано" };
    proposals[i] = { ...p, status: "confirmed", confirmedAt: Date.now() };
    await rsetJSON(K.proposals, proposals);
    await setSeen(p.fingerprint, cfg.cooldownDays); // подтверждённое не всплывёт заново, пока в работе
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
const CRON_OK = new Set(["daily", "classify-preview", "auto-dispatch", "regate-meta"]); // classify-preview READ-ONLY; auto-dispatch — раздача операционки РОПу (идёт и в runDailyBrain); regate-meta — разовый сброс в pending под гейт свежести
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
    if (action === "classify-preview") { res.status(200).json(await autoDispatchProposals(ORG, { dryRun: true })); return; } // READ-ONLY разбивка РОП/владелец
    if (action === "auto-dispatch") { res.status(200).json(await autoDispatchProposals(ORG)); return; } // ЖИВОЙ: раздать операционку РОПу (admin или cron)
    if (action === "regate-meta") { res.status(200).json(await regateConfirmedMeta(ORG)); return; } // РАЗОВО: сброс confirmed+auto → pending под гейт свежести
    if (action === "synth") { // диагностика СИНТЕЗА: сырой ответ + stop_reason/usage + статус парсинга (без отправки)
      const bundle = await gatherForBrain(ORG);
      const rr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST", headers: { "content-type": "application/json", "x-api-key": AKEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 8000, system: BRAIN_SYSTEM, messages: [{ role: "user", content: "Данные системы за сутки:\n" + JSON.stringify(bundle) }] }),
      });
      const dd = await rr.json();
      const text = (dd.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
      let parsed = null, perr = null;
      try { const m = text.replace(/```json|```/g, "").match(/\[[\s\S]*\]/); parsed = m ? JSON.parse(m[0]) : null; } catch (e) { perr = String(e && e.message || e); }
      res.status(200).json({ ok: true, httpOk: rr.ok, stop: dd.stop_reason, usage: dd.usage, apiErr: dd.error || null, textLen: text.length, parsedCount: Array.isArray(parsed) ? parsed.length : null, parseErr: perr, textHead: text.slice(0, 300) });
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
    if (action === "clear") { await Promise.all([rsetJSON(K.proposals, []), rsetJSON(K.seen, {}), rsetJSON(K.msgmap, {})]); res.status(200).json({ ok: true, cleared: true }); return; } // сброс накопленных предложений (для теста формата)
    res.status(400).json({ error: "unknown action" });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e) }); }
}
