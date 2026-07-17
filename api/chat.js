// /api/chat.js — Крестодатель. Перед ответом читает ЖИВОЙ кэш из Upstash (те же данные, что в дашборде)
// и подкладывает их в контекст, чтобы отвечать по реальным цифрам amoCRM за текущий месяц.

export const config = { api: { bodyParser: { sizeLimit: "12mb" } } };

// Связка с 4 агентами (ТОЛЬКО ЧТЕНИЕ, шаг 1): переиспользуем их существующие state()-бандлы, не дублируя сбор.
import { getDevStateBundle } from "./dev-agent.js";
import { getGrowthStateBundle } from "./growth-agent.js";
import { getTaskStateBundle } from "./task-agent.js";
import { getOpenMopFindings, getFreshAutoClosed, getMopLastRun, getMopConfig } from "./mop-agent.js";
import { getBalancesSummary } from "./gamification.js";
import { getCallAnalysisBundle } from "./deepsales.js";

async function readDashboardCache() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    const r = await fetch(`${url}/get/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (!data || data.result == null) return null;
    return JSON.parse(data.result);
  } catch (e) { return null; }
}

async function readCache(key, org) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const realKey = (org && org !== "hunter") ? `${key}:${org}` : key;
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(realKey)}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await r.json();
    if (!data || data.result == null) return null;
    return JSON.parse(data.result);
  } catch (e) { return null; }
}

async function resolveSessionOrg(session) {
  const info = await resolveSessionInfo(session);
  return info ? (info.org || "hunter") : "hunter";
}
async function resolveSessionInfo(session) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token || !session) return null;
  try {
    const r = await fetch(`${url}/get/session:${session}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (d && d.result) return JSON.parse(d.result);
  } catch (e) {}
  return null;
}

function num(n){ return (n==null?0:n).toLocaleString("ru"); }

function liveBlock(d, fin, realGoal, workdays, tg) {
  if (!d || !d.totals) {
    return "\n\nЖИВЫЕ ДАННЫЕ amoCRM: пока не загружены (кэш пуст). Попроси нажать «Обновить из amoCRM» в дашборде.";
  }
  const t = d.totals;
  const sp = d.speed || {};
  // единая цель: реальная (из запроса клиента), а не серверный дефолт
  const GOAL = (realGoal && realGoal > 0) ? realGoal : (t.goal || 250000000);
  const earnedNow = t.revenue || 0;
  const goalPctReal = GOAL > 0 ? Math.round(earnedNow / GOAL * 100) : 0;
  let s = `\n\n=== ЖИВЫЕ ДАННЫЕ ИЗ amoCRM (${d.period}, обновлено ${new Date(d.updatedAt).toLocaleString("ru")}) ===\n`;
  s += `Это РЕАЛЬНЫЕ цифры бизнеса — опирайся на них.\n\n`;

  // --- ГЛАВНОЕ ---
  s += `ГЛАВНЫЕ ПОКАЗАТЕЛИ (текущий месяц):\n`;
  s += `• Продаж: ${t.sold} · Выручка: ${num(t.revenue)} сум · Средний чек: ${num(t.avgCheck)} сум\n`;
  s += `• Конверсия команды: ${t.conv}% (лид→продажа)\n`;
  s += `• Цель: ${num(GOAL)} сум · достигнуто ${goalPctReal}%\n`;
  s += `• Потеряно без контакта: ${t.noContactPct}% лидов (не дозвонились/не ответили)\n`;
  s += `• Сегодня: ${t.leadsToday} новых лидов, ${t.soldToday} продаж, ${num(t.revenueToday)} сум\n`;

  // --- ПРОГНОЗ / ОТСТАВАНИЕ (по РАБОЧИМ дням, без выходных) ---
  if (GOAL > 0) {
    const earned = t.revenue || 0;
    const gapToGoal = GOAL - earned;
    s += `\nПРОГНОЗ И ОТСТАВАНИЕ:\n`;
    s += `• Заработано ${num(earned)} из ${num(GOAL)} — не хватает ещё ${num(gapToGoal)} сум до цели\n`;
    if (workdays && workdays.passed > 0) {
      // ВАЖНО: темп считаем по РАБОЧИМ дням (выходные не в счёт), по ОБЩЕЙ выручке (касса)
      const perWorkday = Math.round(earned / workdays.passed);
      const forecast = Math.round(perWorkday * workdays.total);
      const needPerRemaining = workdays.remaining > 0 ? Math.round(gapToGoal / workdays.remaining) : 0;
      s += `• Рабочих дней: прошло ${workdays.passed}, осталось ${workdays.remaining} (выходные НЕ считаются)\n`;
      s += `• Текущий темп: ${num(perWorkday)} сум за РАБОЧИЙ день (общая выручка ÷ рабочие дни, НЕ календарные)\n`;
      s += `• Прогноз при этом темпе: ~${num(forecast)} сум к концу месяца\n`;
      s += `• Чтобы дойти до цели: нужно ${num(needPerRemaining)} сум/рабочий день в оставшиеся ${workdays.remaining} дней\n`;
      s += `ВАЖНО: когда считаешь темп — дели выручку на РАБОЧИЕ дни (${workdays.passed}), НЕ на календарные. Выходные не работают.\n`;
    }
  }

  // --- МОПы: продажи + дисциплина вместе ---
  if (d.mopsByConv && d.mopsByConv.length) {
    s += `\nМЕНЕДЖЕРЫ (продажи + дисциплина):\n`;
    const discMap = {};
    if (sp.mops) for (const m of sp.mops) discMap[m.name] = m;
    for (const m of d.mopsByConv) {
      const disc = discMap[m.name] || {};
      s += `• ${m.name}: ${m.leads} лидов → ${m.sold} продаж (конв ${m.conv}%), дозвон ${m.reachPct}%`;
      if (disc.medianFirstCallMin != null) s += `, 1-й звонок ~${disc.medianFirstCallMin} мин`;
      if (disc.tasksDonePct != null) s += `, задач выполнено ${disc.tasksDonePct}%`;
      s += `\n`;
    }
  }

  // --- СКОРОСТЬ ВОРОНКИ ---
  if (d.velocity && d.velocity.median != null) {
    s += `\nСКОРОСТЬ ВОРОНКИ: сделка идёт в среднем ${d.velocity.median} дн (медиана) от лида до продажи.\n`;
    if (d.velocity.stages && d.velocity.stages.length) {
      const top = d.velocity.stages.slice(0, 3).map(x => `${x.name} (${x.count})`).join(", ");
      s += `Больше всего открытых лидов застряло на этапах: ${top}.\n`;
    }
  }

  // --- ПРИЧИНЫ ПОТЕРЬ ---
  if (d.problems && d.problems.length) {
    s += `\nПОЧЕМУ ТЕРЯЕМ ЛИДЫ (топ причин за месяц):\n`;
    for (const p of d.problems.slice(0, 5)) s += `• ${p.name}: ${p.count}\n`;
  }

  // --- ИСТОЧНИКИ РЕКЛАМЫ / ROI ---
  if (d.adsets && d.adsets.length) {
    const withRev = d.adsets.filter(a => (a.revenueMonth || 0) > 0).slice(0, 6);
    if (withRev.length) {
      s += `\nИСТОЧНИКИ РЕКЛАМЫ (аудитории, за месяц — выручка · лиды · продажи · конверсия):\n`;
      for (const a of withRev) {
        s += `• ${a.name}: ${num(a.revenueMonth)} сум · ${a.leadsMonth} лидов · ${a.soldMonth} продаж · ${a.convMonth}%\n`;
      }
    }
  }

  // --- ФИНАНСЫ (если есть) ---
  if (fin && fin.ok && fin.revenue != null) {
    s += `\nФИНАНСЫ (из таблицы, текущий месяц):\n`;
    s += `• Выручка: ${num(fin.revenue)} · Расходы: ${num(fin.expenses)} · Прибыль: ${num(fin.profit)}`;
    if (fin.margin != null) s += ` · Маржа: ${fin.margin}%`;
    s += `\n`;
    if (Array.isArray(fin.breakdown) && fin.breakdown.length) {
      const top = fin.breakdown.filter(x=>x&&x.amount).sort((a,b)=>Math.abs(b.amount)-Math.abs(a.amount)).slice(0,5);
      s += `Крупные статьи расходов: ${top.map(x=>`${x.name} (${num(Math.abs(x.amount))})`).join(", ")}\n`;
    }
  }

  // --- TELEGRAM (переписка с клиентами) ---
  if (tg && (tg.digest || tg.seg || tg.hist)) {
    s += `\nTELEGRAM (переписка с клиентами):\n`;
    // ВСЯ БАЗА ПЕРЕПИСКИ (анализ истории) — большой срез, а не только вчера
    const h = tg.hist;
    if (h && h.total != null) {
      const pc = (n) => h.total ? Math.round((n || 0) / h.total * 100) : 0;
      s += `• Всего диалогов в истории: ${h.total}`;
      if (h.noReply != null) s += ` · без ответа: ${h.noReply} (${pc(h.noReply)}%)`;
      if (h.priceQ != null) s += ` · спрашивали цену: ${h.priceQ} (${pc(h.priceQ)}%)`;
      if (h.leftAfterPrice != null) s += ` · спросили цену и ушли: ${h.leftAfterPrice}`;
      if (h.objQ != null) s += ` · возражения: ${h.objQ} (${pc(h.objQ)}%)`;
      if (h.installQ != null) s += ` · про рассрочку: ${h.installQ}`;
      s += `\n`;
    }
    const g = tg.digest;
    if (g) {
      if (g.totalChats != null) {
        s += `• Диалогов (вчера): ${g.totalChats}`;
        if (g.priceCount != null) s += ` · спрашивали цену: ${g.priceCount}`;
        if (g.objectionCount != null) s += ` · возражений: ${g.objectionCount}`;
        if (g.installmentCount != null) s += ` · про рассрочку: ${g.installmentCount}`;
        if (g.noReplyChats != null) s += ` · остались без ответа: ${g.noReplyChats}`;
        s += `\n`;
      }
      if (g.summary) s += `Сводка по переписке: ${g.summary}\n`;
      if (Array.isArray(g.tips) && g.tips.length) s += `Что улучшить в переписке: ${g.tips.join("; ")}\n`;
    }
    const stats = tg.seg && tg.seg.stats;
    if (stats && stats.segments && Object.keys(stats.segments).length) {
      const parts = Object.entries(stats.segments).map(([k, v]) => `${k}: ${v}`);
      s += `Сегменты клиентов в Telegram: ${parts.join(", ")}${stats.total ? ` (всего ${stats.total})` : ""}\n`;
    }
  }

  s += `\n(Данные на ${new Date(d.updatedAt).toLocaleDateString("ru")}, кэш обновляется по кнопке/раз в час.)`;
  return s;
}

async function setCache(key, value, ttlSec) {
  const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return;
  try { await fetch(`${url}/set/${encodeURIComponent(key)}?EX=${ttlSec}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(value) }); } catch (e) {}
}
// Тривиальное сообщение (приветствие/благодарность/подтверждение) целиком — без бизнес-сути.
// Такие идут на Haiku и БЕЗ тяжёлого контекста (agentsBlock+live). Консервативно: только сплошной ack ≤40 симв.
function isTrivial(msg) {
  const m = String(msg || "").trim().toLowerCase();
  if (!m) return true;
  if (m.length > 40) return false;
  return /^(привет\w*|здравствуй\w*|assalom\w*|salom|салом|хай|hi|hello|спасибо|спс|благодар\w*|рахмат|raxmat|rahmat|ок(ей)?|ok(ay)?|хорошо|понятно|ясно|принято|отлично|супер|давай|👍|🙏|❤️|\s|[.!?,)])+$/.test(m);
}
function shortT(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n) + "…" : s; }
function statusCounts(arr, field) { const m = {}; for (const x of arr || []) { const k = x[field] || "?"; m[k] = (m[k] || 0) + 1; } const e = Object.entries(m); return e.length ? e.map(([k, v]) => k + ":" + v).join(", ") : "—"; }

// ЧТЕНИЕ агентов (шаг 1): компактный, источник-подписанный, trust-флагнутый дайджест 4 агентов + геймификации.
// Переиспользует их state()-бандлы. Источники ОСТАЮТСЯ РАЗЛИЧИМЫ (не сливаются). Гейты передаются явно.
async function agentsBlock(org, speed) {
  let dev, growth, task, mopOpen, mopClosed, mopRun, mopCfg, bal, ca;
  try {
    [dev, growth, task, mopOpen, mopClosed, mopRun, mopCfg, bal, ca] = await Promise.all([
      getDevStateBundle().catch(() => null), getGrowthStateBundle({ skipFunnel: true }).catch(() => null), getTaskStateBundle().catch(() => null),
      getOpenMopFindings().catch(() => []), getFreshAutoClosed().catch(() => []), getMopLastRun().catch(() => null),
      getMopConfig().catch(() => null), getBalancesSummary(org).catch(() => []),
      getCallAnalysisBundle(org).catch(() => null),
    ]);
  } catch (e) { return ""; }

  let s = `\n\n=== СИСТЕМА АГЕНТОВ (это ОТДЕЛЬНЫЕ системы-источники, НЕ твоё мнение; при ответе называй источник и НЕ сливай их в одну выжимку) ===\n`;

  // ── АНАЛИЗ ЗВОНКОВ (DeepSales) — выборка КРОШЕЧНАЯ и НЕ случайная ──
  if (ca && ca.coverage && ca.coverage.analyzed > 0) {
    const cov = ca.coverage;
    s += `\n[Анализ звонков / DeepSales] — разборы РЕАЛЬНЫХ разговоров (транскрипт, оценки, возражения, ошибки).\n`;
    s += `• Всего разобрано: ${cov.analyzed} звонков за период ${cov.window.from}–${cov.window.to} (последний прогон ${String(cov.lastAnalyzedAt || "").slice(0, 10)}).\n`;
    s += `\n‼️ ЖЁСТКОЕ ПРАВИЛО, НАРУШАТЬ НЕЛЬЗЯ НИ РАЗУ:\n`;
    s += `Выборка КРОШЕЧНАЯ (доли процента) и НЕ случайная. При ЛЮБОМ упоминании данных КОНКРЕТНОГО МОПа ты ОБЯЗАН в ТОЙ ЖЕ фразе назвать его покрытие: сколько его звонков разобрано, из скольких примерно, и какой это %.\n`;
    s += `Покрытие по каждому: ${Object.entries(cov.byMop).map(([k, v]) => `${k} — ${v.analyzed} из ~${v.monthCallsEstimate || "?"} (${v.sharePctApprox != null ? v.sharePctApprox + "%" : "доля неизвестна"})`).join("; ")}.\n`;
    s += `${cov.sampling}\n`;
    s += `ЗАПРЕЩЕНО: «Абдулла плохо закрывает». ОБЯЗАТЕЛЬНО так: «по 7 разобранным звонкам из ~775 (0.9%) у Абдуллы в N из 7 не назначен следующий шаг — это выборка меньше процента, повод проверить вручную, а НЕ вывод о человеке».\n`;
    s += `Если пользователь просит судить о МОПе по этим данным — прямо скажи, что выборки не хватает для суждения, и предложи посмотреть разборы в разделе «Анализ звонков» (вкладка Продажи).\n`;
    if (ca.team && ca.team.won && ca.team.lost) {
      s += `• Контраст команды (won ${ca.team.won.n} vs lost ${ca.team.lost.n} разборов): talk_ratio менеджера ${ca.team.won.talkRatio}% / ${ca.team.lost.talkRatio}%; ошибок на звонок ${ca.team.won.mistakesPerCall} / ${ca.team.lost.mistakesPerCall}.\n`;
      s += `  Ошибки won: ${JSON.stringify(ca.team.won.mistakeTags)}; lost: ${JSON.stringify(ca.team.lost.mistakeTags)}.\n`;
      s += `  Возражения won: ${JSON.stringify(ca.team.won.objectionTags)}; lost: ${JSON.stringify(ca.team.lost.objectionTags)}.\n`;
    }
    for (const r of (ca.recent || []).slice(0, 5)) s += `   — ${r.callDate} ${r.mop} [${r.status}] балл ${r.score}, talk ${r.talkRatio}%: ${shortT(r.headline, 90)}\n`;
    s += `(Разборы приходят от DeepSales на узбекском — цитируй как есть, не выдумывай перевод.)\n`;
    s += `DeepSales САМ оценил каждый звонок по настроенным критериям продукта Hunter Academy (Salomlashuv, SPIN, FAB, Narx/USP, достоверность инфо о продукте и др.) — это ГОТОВЫЙ вердикт. Твоя роль: читать и агрегировать его оценки (criteria_scores/mistakes/objections), НЕ делать собственный разбор текста разговора.\n`;
  }

  if (dev) {
    s += `\n[Менеджер по аналитике / Dev-Agent] — техно-аналитик: следит за корректностью метрик и системы.\n`;
    s += `• Находки: ${(dev.findings || []).length} (${statusCounts(dev.findings, "status")}). Гипотезы: ${(dev.hypotheses || []).length} (${statusCounts(dev.hypotheses, "status")}).\n`;
    for (const f of (dev.findings || []).slice(0, 4)) s += `   — [${f.status}] ${shortT(f.claim, 150)}\n`;
    const nd = (dev.hypotheses || []).filter(h => h.status === "needs_data").length;
    if (nd) s += `   ⚠ ${nd} гипотез(ы) в статусе needs_data — это НЕДОСТАТОК ДАННЫХ, НЕ вывод; не выдавай за факт.\n`;
  } else s += `\n[Менеджер по аналитике] состояние сейчас недоступно.\n`;

  if (growth) {
    const lr = growth.lastRun;
    s += `\n[Агент по развитию / Growth Agent] — гипотезы роста на verified-воронке + внешние бенчмарки через web_search.\n`;
    if (lr) s += `• Последний прогон: ${lr.day || "?"} (web-поисков: ${lr.searches ?? "?"}). Кратко: ${shortT(lr.report, 220)}\n`;
    s += `• Гипотез: ${(growth.hypotheses || []).length}; с отметкой результата: ${(growth.tested || []).length} (0 = ждут твоего решения).\n`;
    for (const h of (growth.hypotheses || []).slice(0, 4)) s += `   — [${h.status || "open"}] ${shortT(h.observation || h.claim, 150)}\n`;
    for (const u of ((lr && lr.undiagnosable) || []).slice(0, 2)) s += `   ⛔ не диагностируется (данных нет): ${shortT(u, 150)}\n`;
  } else s += `\n[Агент по развитию] состояние сейчас недоступно.\n`;

  if (task) {
    const st = task.status || {};
    s += `\n[Тренер / Task Agent] — доводит находки до РОПа задачами, эскалирует владельцу при молчании РОПа.\n`;
    s += `• Задач РОПу: ${(task.tasks || []).length}. Эскалаций владельцу: ${(task.escalations || []).length}.\n`;
    for (const t of (task.tasks || []).slice(0, 5)) { const ts = st[t.id] || {}; s += `   — «${shortT(t.title, 70)}»: ${ts.state || "—"}${ts.ropRepliedDay ? ` (РОП ответил ${ts.ropRepliedDay})` : ""}${ts.escalatedDay ? ` [ЭСКАЛИРОВАНО ${ts.escalatedDay}]` : ""}\n`; }
  } else s += `\n[Тренер] состояние сейчас недоступно.\n`;

  s += `\n[Супервайзер / MOP Agent] — находки по отделу/конкретным МОПам → вливаются в задачи Тренера.\n`;
  s += `• Открытых находок: ${(mopOpen || []).length}, автозакрытых недавно: ${(mopClosed || []).length}.\n`;
  for (const f of (mopOpen || []).slice(0, 4)) s += `   — [${f.scope}/${f.type}] ${shortT(f.title, 90)}\n`;
  if (mopCfg && mopCfg.noCallEnabled === false) s += `   ⚠ ГЕЙТ: детектор «не звонил» (no_call) ВЫКЛЮЧЕН — ${shortT(mopCfg.noCallDisabledReason, 150)} → вывод «МОП не звонил» ДЕЛАТЬ НЕЛЬЗЯ.\n`;

  if (bal && bal.length) s += `\n[Геймификация] баллы/уровни: ${bal.map(b => `${b.name} (ур.${b.level}, ${b.balance} б.)`).join(", ")}.\n`;

  const mm = (speed && speed.mopMeta) || {};
  s += `\n=== TRUST / ДИСЦИПЛИНА ДАННЫХ (соблюдай как агенты) ===\n`;
  if (mm.callsBypassSuspected) s += `• callsBypassSuspected = TRUE: звонки с личных телефонов МОПов НЕ долетают до amoCRM (доля «активен без звонка» ${mm.telephonyPct ?? "?"}%). Любой вывод про дозвон/«кто сколько звонил»/«кто не звонил» — ПОД ПОДОЗРЕНИЕМ. Оговори это явно, не давай уверенный вердикт по звонкам, НЕ обвиняй конкретных людей.\n`;
  const inc = []; if (mm.notesComplete === false) inc.push("заметки"); if (mm.eventsComplete === false) inc.push("события"); if (mm.leadsComplete === false) inc.push("лиды");
  if (inc.length) s += `• Данные выгружены НЕ полностью (${inc.join(", ")}) — часть метрик неполна, оговаривай это при выводах.\n`;
  return s;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server" }); return; }

  try {
    const { messages, progress, lang, session, action, goal, workdays } = req.body || {};
    // МОП НЕ имеет доступа к чату-советнику (только свой кабинет)
    const _sinfo = await resolveSessionInfo(session);
    if (_sinfo && _sinfo.role === "mop") { res.status(403).json({ error: "Недоступно для этой роли" }); return; }
    // единая цель: из запроса клиента (меняется, когда владелец меняет цель), дефолт 250М
    const GOAL = (goal && goal > 0) ? goal : 250000000;
    const goalFmt = GOAL.toLocaleString("ru") + " сум/мес";
    const goalShort = GOAL >= 1000000 ? Math.round(GOAL / 1000000) + "М" : String(GOAL);

    const org = await resolveSessionOrg(session);

    // ЖИВЫЕ ДАННЫЕ из кэша (org-aware): дашборд (со speed) + финансы — нужны и чату, и умным вопросам
    const cache = await readCache("dashboard", org);
    const speed = await readCache("speed", org);
    if (cache && speed) cache.speed = speed;
    const fin = await readCache(org === "hunter" ? "fin:v2:current" : `${org}:fin:v2:current`, null);
    // ДАННЫЕ TELEGRAM: ночной дайджест (общий) + сегменты клиентов (ключ уже org-scoped)
    const tgDigest = await readCache("tg:digest", null);
    const tgSeg = await readCache(`tgseg:${org}`, null);
    const tgHist = await readCache(`tghist:${org}`, null); // анализ истории (вся база переписки)
    const live = liveBlock(cache, fin, GOAL, workdays, { digest: tgDigest, seg: tgSeg, hist: tgHist });

    // === УМНЫЕ ВОПРОСЫ: AI находит проблемы и предлагает, что спросить ===
    if (action === "smart-questions") {
      if (!cache || !cache.totals) { res.status(200).json({ ok: true, questions: [] }); return; }
      // КЭШ: пересчитываем Sonnet только когда сменился снимок дашборда (обновляется раз в час), а не на каждый рендер
      const sqKey = `chatsmartq:${org}:${lang === "uz" ? "uz" : "ru"}`;
      const upd = cache.updatedAt || 0;
      const prevSq = await readCache(sqKey, null);
      if (prevSq && prevSq.forUpdatedAt === upd && Array.isArray(prevSq.questions)) { res.status(200).json({ ok: true, questions: prevSq.questions, cached: true }); return; }
      const qSystem = `Ты — директор по продажам. Смотришь данные бизнеса и находишь 3-4 ПРОБЛЕМЫ или зоны внимания, которые владелец сам не заметил бы.
Для каждой сформулируй КОРОТКИЙ вопрос (3-6 слов) от лица владельца ("Почему...", "Кто...", "Куда...", "Успеваем ли..."), который он захочет нажать.
Срочность: "hot" (горит, теряем деньги) или "warn" (внимание).
Отвечай ТОЛЬКО валидным JSON-массивом, без markdown, без пояснений:
[{"q":"Почему Komiljon не дозванивается?","level":"hot"},{"q":"Успеваем на план месяца?","level":"warn"}]
Формулируй грамотно и естественно (${lang === "uz" ? "живой узбекский латиницей, без русизмов" : "русский"}). Максимум 4. Если всё хорошо — 1-2 общих вопроса.`;
      const qReq = {
        model: "claude-sonnet-5", max_tokens: 500,
        system: qSystem + live,
        messages: [{ role: "user", content: "Проанализируй данные и предложи вопросы." }],
      };
      const qr = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify(qReq),
      });
      if (!qr.ok) { res.status(200).json({ ok: true, questions: [] }); return; }
      const qd = await qr.json();
      let txt = "";
      for (const b of (qd.content || [])) if (b.type === "text") txt += b.text;
      txt = txt.replace(/```json|```/g, "").trim();
      let questions = [];
      try { questions = JSON.parse(txt); } catch (e) { questions = []; }
      if (!Array.isArray(questions)) questions = [];
      const out = questions.slice(0, 4);
      await setCache(sqKey, { questions: out, forUpdatedAt: upd }, 7200); // держим до смены снимка (backstop 2ч)
      res.status(200).json({ ok: true, questions: out });
      return;
    }

    // сегодняшняя дата в Ташкенте (UTC+5) — чтобы советник был привязан ко времени и не повторял старые ответы
    const nowTk = new Date(Date.now() + 5 * 3600 * 1000);
    const M_RU = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
    const W_RU = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
    const M_UZ = ["yanvar", "fevral", "mart", "aprel", "may", "iyun", "iyul", "avgust", "sentabr", "oktabr", "noyabr", "dekabr"];
    const W_UZ = ["yakshanba", "dushanba", "seshanba", "chorshanba", "payshanba", "juma", "shanba"];
    const dateStr = lang === "uz"
      ? `${nowTk.getUTCDate()}-${M_UZ[nowTk.getUTCMonth()]} ${nowTk.getUTCFullYear()}, ${W_UZ[nowTk.getUTCDay()]}`
      : `${nowTk.getUTCDate()} ${M_RU[nowTk.getUTCMonth()]} ${nowTk.getUTCFullYear()} г., ${W_RU[nowTk.getUTCDay()]}`;

    const SYSTEM = `Ты — личный директор по продажам (РОП) для владельца бизнеса. Твоя работа — смотреть на все данные бизнеса и отвечать простым языком: ЧТО НЕ ТАК, КАК ИСПРАВИТЬ, ЧЕГО НЕ ХВАТАЕТ ДО ЦЕЛИ.

СЕГОДНЯ: ${dateStr}. Все ЖИВЫЕ ДАННЫЕ ниже — актуальный срез на этот момент.
АКТУАЛЬНОСТЬ (ОЧЕНЬ ВАЖНО): переписка может тянуться много дней. На КАЖДЫЙ вопрос делай анализ ЗАНОВО по сегодняшним живым данным. Если похожий вопрос уже был в истории переписки и ты отвечал раньше — НЕ повторяй тот ответ и НЕ отсылай к нему («как я уже говорил», «как выше»): с того сообщения прошло время и цифры изменились. Всегда давай СВЕЖИЙ ответ по текущим данным на сегодня, даже если вопрос похож на прошлый.

КТО ПЕРЕД ТОБОЙ: Абдуллох — основатель Hunter Academy (школа подготовки менеджеров по продажам, Ташкент). Цель — стабильно ${goalFmt}.

ГЛАВНЫЙ ПРИНЦИП: владелец не хочет копаться в цифрах. Он спрашивает по-человечески — ты отвечаешь как опытный РОП, который видит всю картину. Трудное делаешь простым.

ДИСЦИПЛИНА ДАННЫХ (ПРИОРИТЕТ НАД СТИЛЕМ: если правило ниже спорит с «всегда давай шаг / назови у кого / почему корень» — побеждает правило отсюда. Ты — удобная точка входа ко всей системе, но НЕ «более мягкая», менее строгая версия агентов):
1. ИСТОЧНИКИ. Ниже может быть блок «СИСТЕМА АГЕНТОВ» — это ОТДЕЛЬНЫЕ системы (Менеджер по аналитике, Агент по развитию, Тренер, Супервайзер) со своими находками. Отвечая их данными — ЯВНО называй источник («по данным Агента по развитию…», «Супервайзер сообщает…»), не выдавай за своё мнение и НЕ сливай источники в одну обезличенную выжимку. Если вопрос охватывает несколько — дай сводку, но каждый источник различим.
2. TRUST. Если данные помечены suspicious / insufficient / gated (см. блок «TRUST / ДИСЦИПЛИНА ДАННЫХ»: callsBypassSuspected, выключенный детектор no_call, needs_data, «не диагностируется», неполная выгрузка) — ОБЯЗАТЕЛЬНО оговори это и НЕ давай уверенный вывод на непроверенных данных. Не сглаживай оговорку при пересказе.
3. ПРИЧИНЫ. Спрашивают «почему X», а точной причины в данных НЕТ — скажи прямо: «точная причина в данных не видна, вот что можно проверить: …». НЕ выдавай правдоподобную догадку за установленную причину.
4. ЛЮДИ. НЕ выноси суждений о конкретных сотрудниках без прямой опоры на verified-факты (та же граница, что у Супервайзера и Тренера). Особенно про звонки/дозвон при callsBypassSuspected — данные ненадёжны, поимённо не обвиняй.
5. БЕНЧМАРКИ. Если вопрос требует гипотезы с ВНЕШНИМ бенчмарком (как делает Агент по развитию через web_search) — сошлись на его существующие гипотезы ИЛИ скажи, что нужен отдельный анализ. НЕ выдумывай «отраслевой ориентир» на лету — у тебя нет web_search.

КАК ОТВЕЧАТЬ (это важнее всего):
1. СНАЧАЛА — прямой ответ на вопрос, по делу, цифрами.
2. Если есть проблема — назови её конкретно: что не так, у кого, насколько (в цифрах).
3. ВСЕГДА давай «что делать» — конкретный шаг на VERIFIED-данных, а не общие слова (не «улучшите дозвон», а «вчера N лидов не получили ни одного звонка — распределите их с утра»). НО если метрика под гейтом (например дозвон при callsBypassSuspected) — сначала оговорка о ненадёжности данных, потом «что можно проверить», БЕЗ обвинения конкретного человека по имени.
4. Связывай с целью: чего не хватает, чтобы дойти до ${goalShort}.
5. ВАЖНО про темп и прогноз: план ставится по ОБЩЕЙ ВЫРУЧКЕ (вся касса за месяц: новые продажи + доплаты), а НЕ только по новым продажам. Темп в день считай ТОЛЬКО по рабочим дням (выходные не работают) — бери цифры «рабочих дней» и «темп за рабочий день» из блока данных, не пересчитывай по календарным дням. Если делишь на календарные дни — это ошибка, темп будет занижен.

ТВОЙ ХАРАКТЕР: прямой, конкретный, деловой. Говоришь цифрами, не водой. Хвалишь за результат, критикуешь по делу — но всегда с решением. Не грузишь философией.

ФОРМАТ: коротко и по делу. Если проблем несколько — списком по приоритету (сначала то, что сильнее всего бьёт по деньгам). Не пиши простыни — владелец занят.

У ТЕБЯ ЕСТЬ ЖИВЫЕ ДАННЫЕ (см. блок ниже): продажи, менеджеры, дисциплина, дозвон, скорость воронки, причины потерь, источники рекламы, финансы, а также ПЕРЕПИСКА С КЛИЕНТАМИ В TELEGRAM: АНАЛИЗ ВСЕЙ ИСТОРИИ переписки (общая база — всего диалогов, сколько без ответа, спрашивали цену, ушли после цены, возражения, рассрочка) + срез за вчера (дайджест) + сегменты клиентов + сводка и советы по переписке. Когда спрашивают про Telegram/переписку в целом — опирайся на АНАЛИЗ ВСЕЙ ИСТОРИИ (это сотни/тысячи диалогов), а не только на вчерашний срез. Используй ВСЁ это, чтобы находить связи и корень проблемы. Если спрашивают про Telegram/переписку/клиентов в мессенджере — отвечай по этому блоку. Например: продажи упали → смотри дозвон, смотри у кого из МОПов просадка, смотри источники — и покажи причинно-следственную цепочку.

ДИАГНОСТИКА (когда спрашивают «что не так» / «почему просели» / «чего не хватает»):
- Прогони все метрики, найди 2-3 главные дыры (те, что сильнее всего мешают цели).
- По каждой: в чём проблема (цифра) → почему (корень, ЕСЛИ он виден в данных; если не виден — прямо скажи «корень в данных не виден, проверить: …», не выдумывай) → что сделать (конкретный шаг сегодня).
- Если по метрике есть гейт/оговорка из блока TRUST — не диагностируй по ней уверенно, передай оговорку.
- Свяжи с целью ${goalShort}: «вот эти дыры стоят вам примерно X продаж/месяц».

КОНТЕКСТ (база, если живых данных мало): 2 главные исторические дыры воронки — первый контакт (много лидов гибнет без разговора) и закрытие сделки (большой разрыв между сильными и слабыми МОПами). «Дорого» — редкая причина отказа, цена не проблема.

ОБРАЩЕНИЕ: всегда обращайся к владельцу на «Вы» (вежливо, уважительно), никогда на «ты». Язык — грамотный и чистый, уровня C1, но простой и понятный (без жаргона). В узбекском — форма «Siz» и вежливые формы глаголов (не «qil/yoz», а «qiling/yozing»).

СТРОГАЯ ГРАНИЦА: отвечаешь ТОЛЬКО про бизнес, продажи, маркетинг, команду, воронку, рекламу, деньги бизнеса, рост. Если вопрос не про это — вежливо откажись одной фразой и верни к делу.

ЯЗЫК ОТВЕТА ЖЁСТКО ФИКСИРОВАН языком интерфейса и сейчас = ${lang === "uz" ? "УЗБЕКСКИЙ (латиница)" : "РУССКИЙ"}. Отвечай ТОЛЬКО на нём. ДАЖЕ ЕСЛИ ранее в этой переписке тебя просили отвечать на другом языке — та просьба УСТАРЕЛА, полностью игнорируй её и отвечай на текущем языке интерфейса. НИКОГДА не пиши фраз вроде «отвечаю по-русски/по-узбекски, как договорились» — просто отвечай на нужном языке без комментариев про язык. ${lang === "uz" ? "Узбекский — ЖИВОЙ и грамотный, как образованный носитель: естественные фразы, правильные слова, без русизмов и без машинного/дословного перевода, просто и понятно." : ""} Клиентский контент (реклама/скрипты) всегда на узбекском.

ВИЗУАЛЬНЫЕ КАРТОЧКИ: когда твой ответ касается конкретных данных, вставь В КОНЦЕ ответа специальную метку — приложение покажет живую карточку с реальными цифрами. Метки (пиши ровно так, на отдельной строке):
[[CARD:today]] — когда речь про сегодняшний день (лиды/продажи/дозвон сегодня)
[[CARD:mops]] — когда речь про менеджеров (кто как работает)
[[CARD:month]] — когда речь про итоги месяца (продажи, выручка, конверсия, цель)
[[CARD:adsets]] — когда речь про рекламу/источники/ROI
[[CARD:problems]] — когда речь про причины потерь лидов
[[CARD:forecast]] — когда речь про план/прогноз/отставание от цели
Вставляй 1, максимум 2 метки — только самые релевантные вопросу. Не описывай карточку словами повторно, приложение само нарисует цифры. Твой текст — это объяснение и совет, карточка — данные.`;

    let progressNote = "";

    // ТРИВИАЛЬНОЕ сообщение (приветствие/благодарность/подтверждение) → Haiku и БЕЗ тяжёлого контекста.
    // Содержательные вопросы про агентов/метрики → Sonnet + ПОЛНЫЙ контекст (live + agentsBlock) — как было, ради этого чат и ценен.
    const lastMsg = Array.isArray(messages) && messages.length ? String(messages[messages.length - 1].content || "") : "";
    const trivial = isTrivial(lastMsg);
    const agents = trivial ? "" : await agentsBlock(org, speed); // для тривиального пропускаем сбор состояния агентов (и ~40 чтений Redis)
    // Тривиальному — свой МАЛЕНЬКИЙ промпт без данных (полный SYSTEM обещает «живые данные ниже» → без них модель путается/выдумывает).
    const TRIVIAL_SYSTEM = `Ты — вежливый ассистент-директор по продажам для владельца бизнеса Hunter Academy. Обращение на «Вы». Язык ответа ЖЁСТКО: ${lang === "uz" ? "узбекский (латиница)" : "русский"}.
Пользователь написал короткое приветствие / благодарность / подтверждение. Ответь ОДНОЙ короткой дружелюбной фразой и мягко предложи задать вопрос по бизнесу (продажи, менеджеры, воронка, план). НЕ выдумывай НИКАКИХ цифр и данных — их сейчас в контексте нет.`;

    const anthropicReq = {
      model: trivial ? "claude-haiku-4-5-20251001" : "claude-sonnet-5",
      max_tokens: trivial ? 300 : 2500,
      system: trivial ? TRIVIAL_SYSTEM : (SYSTEM + progressNote + live + agents),
      messages: messages,
      stream: true,
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(anthropicReq),
    });

    if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "Anthropic API error", detail: t }); return; }

    // Стримим текст клиенту по мере генерации (SSE от Anthropic → plain text chunks клиенту)
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("X-Accel-Buffering", "no");

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let inTok = 0, outTok = 0; // расход токенов за этот ответ
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const evt = JSON.parse(payload);
          if (evt.type === "message_start" && evt.message && evt.message.usage) inTok = evt.message.usage.input_tokens || 0;
          if (evt.type === "message_delta" && evt.usage && evt.usage.output_tokens != null) outTok = evt.usage.output_tokens;
          if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
            res.write(evt.delta.text);
          }
        } catch (e) { /* пропускаем неполные */ }
      }
    }
    res.write(`\n[[TOK:${inTok},${outTok}]]`); // маркер расхода токенов — фронт покажет мелко под ответом
    res.end();
  } catch (err) {
    try { res.status(500).json({ error: "Server error", detail: String(err) }); } catch (e) { res.end(); }
  }
}
