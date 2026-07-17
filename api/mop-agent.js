// /api/mop-agent.js — MOP AGENT («Агент Г»). Проверяет данные по каждому МОПу и передаёт
// находки РОПу как ГОТОВЫЕ ЗАДАЧИ. Тестово: только Hunter Academy (org="hunter").
//
// ══════════════ ГРАНИЦЫ (жёстко) ══════════════
//  НЕ пишет МОПам напрямую — вся коммуникация с продавцами идёт через живого РОПа.
//  НЕ переназначает лиды, НЕ меняет статусы в CRM.
//  НЕ эскалирует владельцу сам — если РОП не реагирует, срабатывает УЖЕ СУЩЕСТВУЮЩАЯ
//  эскалация Task Agent (РОП молчит → владельцу). Отдельного механизма не строим.
//  Формат находок: ТОЛЬКО ФАКТЫ — что произошло, у кого, когда. Без ярлыков «плохо работает».
//
// ДОСТАВКА: своего канала НЕТ. Находки пишутся в mopagent:findings, а Task Agent подхватывает
// их в loadRopTasks() и гонит РОПа по ним тем же ботом, тем же тредом, с той же подсказкой-шаблоном
// и той же эскалацией. Ноль параллельной инфраструктуры.
//
// TRUST: работает ТОЛЬКО на verified-данных. Если по клиенту звонковые данные suspicious
// (детектор телефонии) или insufficient — молчит по звонковым пунктам, а не выдумывает проблему.

import { getVerifiedFunnel } from "./dev-agent.js";

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ORG = "hunter"; // тест-фаза: один клиент. Архитектурно расширяемо (параметр org).

const K = { findings: "mopagent:findings", config: "mopagent:config", history: "mopagent:history", lastrun: "mopagent:lastrun" };
const CAP = { findings: 120, history: 400 };

const DEFAULT_CONFIG = {
  // ── КЛАССИФИКАЦИЯ: отдел vs конкретный МОП ──
  // ⚠️ МАСШТАБИРОВАНИЕ: deptMinMops=2 подобран под Hunter Academy (5 МОПов) — 2 человека это 40%
  // команды, совпадение не случайно. При тираже на отделы 20-50 человек порог станет
  // ЛОЖНОПОЛОЖИТЕЛЬНЫМ (2 из 50 — не системная проблема). Тогда привязать к ПРОЦЕНТУ команды
  // (напр. deptMinTeamPct: 30) или пересмотреть явно. Сейчас не критично — но не забыть.
  deptMinMops: 2,        // проблема одного типа у 2+ МОПов одновременно → задача ПО ОТДЕЛУ
  deptMinRepeats: 3,     // тот же тип у того же МОПа 3+ раза за неделю → тоже ПО ОТДЕЛУ (систематика, а не случай)
  repeatWindowDays: 7,   // окно, в котором считаем повторы
  // ── ПОРОГИ НАХОДОК ──
  minMismatchPerMop: 1,  // от скольки расхождений статус/факт заводить точечную задачу
  minNoCallPerMop: 2,    // от скольки лидов без звонка заводить точечную задачу

  // ═══════════════ ДЕТЕКТОР «ЛИД БЕЗ ЕДИНОГО ЗВОНКА» — ОТКЛЮЧЁН ═══════════════
  // ВЫКЛЮЧЕН 14.07.2026. Причина — НЕ баг кода, а ПОДТВЕРЖДЁННАЯ ДЫРА В ТЕЛЕФОНИИ:
  //   диагностика 14.07.2026 (26 звонков из отчёта «Мои Звонки», разобраны поштучно):
  //   звонки, сделанные с ЛИЧНЫХ телефонов МОПов через приложение «Мои Звонки», в amoCRM
  //   НЕ ПОПАДАЮТ ВООБЩЕ — 0 из 26. Все найденные в CRM ноты оказались от Utel и принадлежали
  //   ДРУГИМ звонкам (не совпадали ни длительность, ни менеджер).
  // Следствие: лид, которому реально звонили с личного телефона, для системы выглядит как
  // «ни одного звонка». Детектор обвинил бы человека в том, что он НЕ звонил, хотя он звонил.
  // Выключено для ВСЕХ МОПов, не только для тех, у кого это заметнее по объёму: дыра системная,
  // сработать может у любого.
  //
  // ПОЧЕМУ МОЛЧАНИЕ, А НЕ ПЕРЕФОРМУЛИРОВКА («нет звонка в amoCRM» вместо «не звонил»):
  // нейтральной такая фраза выглядит только для того, кто ЗНАЕТ про дыру. РОП и МОП контекста
  // не видят и прочтут её как «система не подтверждает, что ты звонил» — психологически это
  // неотличимо от обвинения. Формулировка не спасает от неверного вывода.
  //
  // КОГДА ВКЛЮЧАТЬ ОБРАТНО: только после проверки, что звонки с личных телефонов долетают до CRM.
  // Критерий: повторить диагностику (взять свежий отчёт «Мои Звонки», сверить с нотами amoCRM
  // по номеру и времени ±10 мин) и убедиться, что звонки НАХОДЯТСЯ. Дополнительно должен упасть
  // telephony.noCallButActivePct (сейчас 9% — 59 лидов с активностью в CRM, но без звонков).
  // Второй предохранитель ниже (telephonyGate) сработает сам, даже если этот флаг включат руками.
  noCallEnabled: false,
  noCallDisabledAt: "2026-07-14",
  noCallDisabledReason: "Подтверждённая дыра в телефонии: звонки с личных телефонов МОПов («Мои Звонки») не попадают в amoCRM (диагностика 14.07.2026: 0 из 26 долетело). Детектор обвинял бы людей в том, что они не звонили, хотя звонили. Включить обратно только после проверки, что звонки с личных долетают до CRM.",
  // Предохранитель на будущее: даже при noCallEnabled=true молчим, если данные говорят,
  // что звонки идут мимо CRM (speed.telephony.callsBypassSuspected).
  telephonyGate: true,
  // ── СРОКИ (ДЕТЕРМИНИРОВАННЫЕ ПРАВИЛА, не LLM — предсказуемость важнее гибкости) ──
  endOfDayHour: 18,      // «до конца рабочего дня» (Ташкент)
  nextDayHour: 12,       // «завтра до 12:00» (Ташкент)
  deptDeadlineDays: 7,   // задачи по отделу — недельный горизонт
  // РОП сказал «сделал», но данные ещё показывают проблему — не поднимаем её заново
  // в тот же день (иначе агент выглядит как спам). Через сутки поднимем, если факт не исчез.
  ropGraceHours: 18,
  enabled: true,
};

async function rget(key) { try { const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); const d = await r.json(); return d && d.result != null ? d.result : null; } catch (e) { return null; } }
async function rgetJSON(key, dflt) { const raw = await rget(key); if (raw == null) return dflt; try { return JSON.parse(raw); } catch (e) { return dflt; } }
async function rsetJSON(key, v) { try { await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: JSON.stringify(v) }); return true; } catch (e) { return false; } }
async function rdel(key) { try { await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` } }); } catch (e) {} }
async function getSession(session) { if (!session) return null; try { const raw = await rget(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; } }
export async function getMopConfig() { const c = await rgetJSON(K.config, null); return { ...DEFAULT_CONFIG, ...(c || {}) }; }

const tkNow = () => new Date(Date.now() + 5 * 3600000);         // Ташкент
const tkHour = () => tkNow().getUTCHours();
const tkDay = () => tkNow().toISOString().slice(0, 10);
let _idc = 0;
function newId(p) { _idc++; return `${p}_${Date.now().toString(36)}_${_idc}`; }

// ── СРОКИ ПО ПРАВИЛАМ (детерминированно, без модели) ──
// Возвращает {deadlineAt (ms), deadline (YYYY-MM-DD), deadlineLabel}
function deadlineEndOfDay(cfg) {
  const t = tkNow();
  const hour = t.getUTCHours();
  const base = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
  if (hour < cfg.endOfDayHour) {
    const at = base + cfg.endOfDayHour * 3600000 - 5 * 3600000; // обратно в UTC
    return { deadlineAt: at, deadline: new Date(base).toISOString().slice(0, 10), deadlineLabel: `сегодня до ${cfg.endOfDayHour}:00` };
  }
  return deadlineNextDay(cfg); // рабочий день уже кончился → переносим на завтра
}
function deadlineNextDay(cfg) {
  const t = tkNow();
  const base = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) + 86400000;
  const at = base + cfg.nextDayHour * 3600000 - 5 * 3600000;
  return { deadlineAt: at, deadline: new Date(base).toISOString().slice(0, 10), deadlineLabel: `завтра до ${cfg.nextDayHour}:00` };
}
function deadlineInDays(cfg, days) {
  const t = tkNow();
  const base = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) + days * 86400000;
  const at = base + cfg.endOfDayHour * 3600000 - 5 * 3600000;
  return { deadlineAt: at, deadline: new Date(base).toISOString().slice(0, 10), deadlineLabel: `${days} дн (до ${new Date(base).toISOString().slice(5, 10)})` };
}

// ── ПРОГОН: собрать находки, классифицировать, обновить память ──
// ── РАЗБОРЫ ЗВОНКОВ (DeepSales): ТОЛЬКО КОНТЕКСТ, НЕ ИСТОЧНИК НАХОДОК ──
// Решение владельца (вариант A). Причина — та же, по которой ниже стоят гейты полноты:
// разобрано 0.5–1.4% звонков МОПа, выборка НЕ случайная (руками отобраны 2-4 мин по won/lost).
// Находка/задача РОПу по такой выборке = суждение о живом человеке по долям процента, то есть
// ровно «находка из ничего», которую эти гейты и запрещают. Увеличение выборки проблему быстро
// не решит — при текущем темпе транскрибации она останется мизерной.
// ПОЭТОМУ: агент МОЖЕТ приложить разбор как справку к УЖЕ существующей находке (другой детектор
// её обосновал), но НЕ ИМЕЕТ ПРАВА заводить находку/задачу на основании самих разборов.
// Пересматривать только если доля станет реально значимой (десятки процентов у конкретного МОПа).
import { getCallAnalysisBundle } from "./deepsales.js";

// ── DeepSales-находки по разборам звонков ── КАЖДАЯ несёт обязательную оговорку покрытия («сигнал, не приговор»).
const CALL_TAG_RU = {
  company_info: "некорректная информация о продукте / необоснованные гарантии",
  closing: "слабое закрытие (не назначается следующий шаг)",
  greeting: "приветствие и установление контакта",
  questioning: "выявление потребности (мало вопросов, SPIN)",
  explanation: "объяснение ценности оффера",
  objection_handling: "работа с возражениями",
  script: "отклонение от скрипта",
  tone: "тон общения",
  introduction: "представление себя и академии",
  communication: "коммуникация с клиентом",
};
const CALL_TAG_ACTION = {
  company_info: "Ввести и проверить правило формулировок: трудоустройство — гарантия С УСЛОВИЕМ (завершил курс), доход — возможность, не гарантия. Разобрать на планёрке.",
  closing: "Добавить в скрипт обязательный следующий шаг в конце каждого звонка (дата/время следующего контакта). Проверить у команды.",
  questioning: "Усилить выявление потребности (SPIN, вопрос про последствие). Дать команде образец вопросов.",
};
function detectCallQualityFindings(ca, cfg, nowMs) {
  if (!ca || !ca.coverage || !(ca.coverage.analyzed > 0)) return [];
  const out = [];
  const analyzed = ca.coverage.analyzed;
  const tags = (ca.team && ca.team.all && ca.team.all.mistakeTags) || {};
  // командные: самые частые серьёзные нарушения (≥30% разобранных звонков), максимум 2
  const teamTags = Object.entries(tags).filter(([t, c]) => CALL_TAG_RU[t] && c / analyzed >= 0.30).sort((a, b) => b[1] - a[1]).slice(0, 2);
  for (const [tag, cnt] of teamTags) {
    const pct = Math.round(cnt / analyzed * 100);
    out.push({
      id: newId("cq"), scope: "department", type: "call_" + tag, source: "mop-agent", mops: [], count: cnt,
      title: `Отдел: улучшить «${CALL_TAG_RU[tag]}» по разборам звонков`,
      fact: `По ${analyzed} разобранным звонкам команды (это ДОЛИ ПРОЦЕНТА всех звонков — выборка крошечная и НЕ случайная, это СИГНАЛ, не приговор) проблема «${CALL_TAG_RU[tag]}» встречается в ${cnt} звонках (${pct}%). Видна у нескольких менеджеров — значит вопрос скрипта/процесса, а не одного человека.`,
      action: CALL_TAG_ACTION[tag] || `Разобрать «${CALL_TAG_RU[tag]}» на планёрке, дать образец в скрипте и проверить у команды.`,
      ...deadlineInDays(cfg, cfg.deptDeadlineDays), createdAt: nowMs, status: "open",
    });
  }
  // точечная: 1 МОП с явно слабейшими разборами (порог по числу разобранных + разрыв балла)
  const MIN_ANALYZED = cfg.callMinAnalyzed != null ? cfg.callMinAnalyzed : 8;
  const rating = (ca.rating || []).filter((r) => (r.analyzed || 0) >= MIN_ANALYZED && r.avgScore != null);
  if (rating.length >= 2) {
    const teamAvg = +(rating.reduce((s, r) => s + r.avgScore, 0) / rating.length).toFixed(1);
    const worst = [...rating].sort((a, b) => a.avgScore - b.avgScore)[0];
    const GAP = cfg.callScoreGap != null ? cfg.callScoreGap : 6;
    if (worst && (teamAvg - worst.avgScore) >= GAP) {
      const bm = (ca.coverage.byMop && ca.coverage.byMop[worst.mop]) || {};
      out.push({
        id: newId("cq"), scope: "mop", type: "call_lowscore", source: "mop-agent", mops: [worst.mop], mop: worst.mop, count: worst.analyzed,
        title: `Проверить звонки ${worst.mop}: по разборам слабее команды (сначала ручная проверка)`,
        fact: `По ${worst.analyzed} разобранным звонкам ${worst.mop} из ~${bm.monthCallsEstimate || "?"} (${bm.sharePctApprox != null ? bm.sharePctApprox + "%" : "доля мала"}) — это ВЫБОРКА МЕНЬШЕ ПРОЦЕНТА, СИГНАЛ, а НЕ приговор: средний балл ${worst.avgScore} против ${teamAvg} по команде, ошибок на звонок ${worst.mistakesPerCall}. Прежде чем делать вывод — послушать несколько его звонков вручную.`,
        action: `Послушать 2-3 звонка ${worst.mop} в разделе «Анализ звонков», сверить с эталонным скриптом, поработать над слабым местом. Это ПРОВЕРКА по крошечной выборке, не оценка человека — без выговора по цифрам.`,
        ...deadlineNextDay(cfg), createdAt: nowMs, status: "open",
      });
    }
  }
  return out;
}

export async function runMopAgent() {
  const cfg = await getMopConfig();
  if (!cfg.enabled) return { ok: true, skipped: "выключен" };

  const speed = await rgetJSON(ORG === "hunter" ? "speed" : `speed:${ORG}`, null);
  if (!speed) return { ok: false, error: "нет данных speed" };

  // контекст-справка: есть ли у МОПа разобранные звонки (для ссылки в тексте находки).
  // НЕ участвует в решении «заводить ли находку» — см. комментарий выше.
  const callCtx = await getCallAnalysisBundle(ORG).catch(() => null);
  const hasAnalysis = (name) => !!(callCtx && callCtx.byMop && callCtx.byMop[name] && callCtx.byMop[name].analyzed > 0);
  const caHadData = !!(callCtx && callCtx.coverage && callCtx.coverage.analyzed > 0); // были ли разборы в этот прогон (для авто-закрытия call_*)

  // ── ДВА НЕЗАВИСИМЫХ ГЕЙТА ПЕРЕД ЛЮБОЙ НАХОДКОЙ ──
  // Гейт 1 — TRUST LAYER: доверяем ли мы звонковым метрикам клиента в принципе.
  // Гейт 2 — ПОЛНОТА ЭТОГО ПРОГОНА: успела ли система дочитать данные, на которых стоит детектор.
  // Второй важнее по последствиям: неполные данные создают находку ИЗ НИЧЕГО.
  // Пример: amoCRM оборвал выдачу событий → у лида calls=0 → «менеджер не звонил» → обвинение
  // человека в том, чего система просто не прочитала. Такого быть не должно НИКОГДА.
  // Поэтому гейты раздельные, по детекторам: молчим ровно по той метрике, где данных не хватает,
  // а не глушим агента целиком.
  const funnel = await getVerifiedFunnel(ORG);
  const callStage = (funnel.stages || []).find((s) => /дозвон/i.test(s.stage));
  const callsVerified = callStage && callStage.trust === "verified";
  const skipped = [];
  if (!callsVerified) skipped.push(`звонковые метрики: ${callStage ? callStage.trust : "нет данных"} — по ним молчим (trust layer)`);

  const issues = Array.isArray(speed.mopIssues) ? speed.mopIssues : [];
  // пороги берём из тех же данных, по которым собраны факты (конфиг клиента в sync-speed),
  // чтобы формулировка задачи и реальный детектор не разъехались
  const meta = speed.mopMeta || {};
  const tel = speed.telephony || {}; // детектор «звонки идут мимо CRM» — теперь ГЕЙТ, а не справка
  const NO_CALL_H = meta.stalledNoCallHours != null ? meta.stalledNoCallHours : 4;

  // Старый кэш (записан до появления паспорта полноты) — полноту НЕ подтверждает.
  // Отсутствие доказательства полноты трактуем как неполноту: молчать безопаснее, чем обвинять.
  const notesComplete = meta.notesComplete === true;
  const eventsComplete = meta.eventsComplete === true;
  // status_mismatch стоит на reachedReal, а он читается ТОЛЬКО из нот
  const canMismatch = callsVerified && notesComplete;
  if (callsVerified && !notesComplete) {
    skipped.push(`расхождение статуса и факта: ноты дочитаны не полностью${meta.notesUnread ? ` (не прочитано ${meta.notesUnread} лид(ов))` : " (кэш без отметки о полноте)"} — молчим, чтобы не обвинить человека в непрочитанном`);
  }

  // ── no_call: ДВЕ ПРИЧИНЫ МОЛЧАТЬ, И ОНИ РАЗНЫЕ ──
  // (а) СТРУКТУРНАЯ: детектор отключён / звонки идут мимо CRM. Это не «данные не докачались»,
  //     а «мерить нечем в принципе». Уже заведённые находки такого типа надо АННУЛИРОВАТЬ —
  //     они построены на неверной посылке.
  // (б) ВРЕМЕННАЯ: события не докачались в этот прогон. Находки остаются открытыми, просто
  //     сейчас не проверяем.
  const telephonyBypass = cfg.telephonyGate !== false && (meta.callsBypassSuspected === true || tel.callsBypassSuspected === true);
  const noCallDisabled = !cfg.noCallEnabled || telephonyBypass; // структурно мерить нечем
  const canNoCall = !noCallDisabled && callsVerified && eventsComplete;

  if (!cfg.noCallEnabled) {
    skipped.push(`лиды без звонка: ДЕТЕКТОР ОТКЛЮЧЁН ${cfg.noCallDisabledAt || ""} — ${cfg.noCallDisabledReason || "причина не указана"}`);
  } else if (telephonyBypass) {
    skipped.push(`лиды без звонка: данные показывают, что звонки идут МИМО CRM (${meta.telephonyPct != null ? meta.telephonyPct + "% лидов с активностью, но без единого звонка" : "детектор телефонии"}) — молчим, иначе обвиним в «не звонил» того, кто звонил с личного телефона`);
  } else if (callsVerified && !eventsComplete) {
    skipped.push("лиды без звонка: события звонков выгружены не полностью — молчим, иначе можно обвинить в «не звонил» того, чьи звонки просто не догрузились");
  }
  const ALLOWED = { status_mismatch: canMismatch, no_call: canNoCall };
  // типы, по которым мерить нечем СТРУКТУРНО (не временно) — их находки аннулируем, а не держим
  const STRUCTURALLY_OFF = { no_call: noCallDisabled };

  const prev = await rgetJSON(K.findings, []);
  const history = await rgetJSON(K.history, []);
  const nowMs = Date.now();

  // 1) ГРУППИРУЕМ сырые факты по (тип, МОП) — только те типы, по которым данные полные
  const byTypeMop = {};
  for (const it of issues) {
    if (!it.mop || !it.type) continue;
    if (!ALLOWED[it.type]) continue; // данных не хватает → факт не превращаем в обвинение
    const k = it.type + "|" + it.mop;
    (byTypeMop[k] = byTypeMop[k] || { type: it.type, mop: it.mop, items: [] }).items.push(it);
  }

  // 2) КЛАССИФИКАЦИЯ: по отделу (2+ МОПа ИЛИ 3+ повтора за неделю) vs точечная
  const winStart = nowMs - cfg.repeatWindowDays * 86400000;
  const repeats = (type, mop) => history.filter((h) => h.type === type && h.mop === mop && h.at >= winStart).length;
  const mopsWithType = {};
  for (const g of Object.values(byTypeMop)) (mopsWithType[g.type] = mopsWithType[g.type] || new Set()).add(g.mop);

  const fresh = [];
  const seenDept = new Set();
  for (const g of Object.values(byTypeMop)) {
    const n = g.items.length;
    const threshold = g.type === "status_mismatch" ? cfg.minMismatchPerMop : cfg.minNoCallPerMop;
    if (n < threshold) continue;

    const mopsCount = (mopsWithType[g.type] || new Set()).size;
    const isSystemic = mopsCount >= cfg.deptMinMops || repeats(g.type, g.mop) + 1 >= cfg.deptMinRepeats;

    if (isSystemic) {
      if (seenDept.has(g.type)) continue; // одна задача по отделу на тип, не по одной на каждого МОПа
      seenDept.add(g.type);
      const allMops = [...(mopsWithType[g.type] || [])];
      const total = Object.values(byTypeMop).filter((x) => x.type === g.type).reduce((s, x) => s + x.items.length, 0);
      const dl = deadlineInDays(cfg, cfg.deptDeadlineDays);
      fresh.push({
        id: newId("mf"), scope: "department", type: g.type, source: "mop-agent",
        mops: allMops, count: total,
        title: g.type === "status_mismatch"
          ? `Наладить в отделе обновление статуса после разговора (${total} лид(ов) у ${allMops.length} менеджеров)`
          : `Наладить в отделе обзвон новых лидов в течение ${NO_CALL_H} ч (${total} лид(ов) без звонка у ${allMops.length} менеджеров)`,
        fact: g.type === "status_mismatch"
          ? `У ${allMops.length} менеджеров (${allMops.join(", ")}) суммарно ${total} лид(ов), где разговор состоялся, но лид всё ещё числится «не дозвонились». Это встречается не у одного человека — значит вопрос процесса, а не отдельного сотрудника.`
          : `У ${allMops.length} менеджеров (${allMops.join(", ")}) суммарно ${total} лид(ов) в работе без единого звонка. Повторяется у нескольких — значит вопрос процесса.`,
        action: g.type === "status_mismatch"
          ? "Договориться в отделе о правиле: после разговора статус обновляется сразу. Проверить, где это ломается — забывают или неудобно."
          : "Договориться о правиле: новый лид получает звонок в первые часы. Проверить, кто и как распределяет лиды.",
        ...dl, createdAt: nowMs, status: "open",
      });
    } else {
      const dl = g.type === "no_call" ? deadlineEndOfDay(cfg) : deadlineNextDay(cfg);
      const leadIds = g.items.slice(0, 10).map((x) => x.leadId);
      fresh.push({
        id: newId("mf"), scope: "mop", type: g.type, source: "mop-agent",
        mops: [g.mop], mop: g.mop, count: n, leadIds,
        title: g.type === "status_mismatch"
          ? `Поговорить с ${g.mop}: ${n} лид(ов) с разговором, но без обновлённого статуса`
          : `Поговорить с ${g.mop}: ${n} лид(ов) в работе без единого звонка`,
        fact: g.type === "status_mismatch"
          ? `У ${g.mop} ${n} лид(ов), где разговор длился дольше порога, но статус остался «не дозвонились». ID лидов: ${leadIds.join(", ")}.`
          : `У ${g.mop} ${n} лид(ов) в работе дольше ${NO_CALL_H} ч без единого звонка. ID лидов: ${leadIds.join(", ")}.`,
        action: g.type === "status_mismatch"
          ? "Попросить обновить статусы по этим лидам — они сейчас числятся потерянными и выпадают из работы."
          : "Попросить прозвонить эти лиды сегодня.",
        ...dl, createdAt: nowMs, status: "open",
      });
    }
  }

  // DeepSales-находки по разборам звонков (командные + точечные) — КАЖДАЯ с обязательной оговоркой покрытия.
  // Идут в тот же пайплайн (дедуп/мёрдж/задачи РОПу), но по своему гейту (покрытие), не по trust звонковых метрик.
  try { for (const f of detectCallQualityFindings(callCtx, cfg, nowMs)) fresh.push(f); } catch (e) {}

  // 3) СЛИЯНИЕ с уже открытыми: не плодим дубли.
  // ВАЖНО: у задачи ПО ОТДЕЛУ ключ — только (department|тип), БЕЗ списка МОПов. Состав МОПов
  // меняется день ко дню (сегодня Абдулла+Достон, завтра Абдулла+Сардор), и если зашить его в ключ,
  // каждое утро старая задача авто-закрывалась бы и заводилась почти такая же — РОПа бы затопило.
  // Проблема отдела — одна и та же, пока она воспроизводится хоть у кого-то.
  const key = (f) => f.scope === "department"
    ? `department|${f.type}`
    : `mop|${f.type}|${f.mop || (f.mops || [])[0] || ""}`;
  const prevOpen = prev.filter((f) => f.status === "open");
  const prevByKey = {}; for (const f of prevOpen) prevByKey[key(f)] = f;

  // Грейс: РОП недавно отчитался «сделал» — не поднимаем ту же находку заново в тот же день.
  const graceMs = (cfg.ropGraceHours != null ? cfg.ropGraceHours : 18) * 3600000;
  const graced = new Set(prev
    .filter((f) => f.status === "rop_reported" && f.closedAt && (nowMs - f.closedAt) < graceMs)
    .map(key));

  // Сколько раз РОП уже отчитывался «сделал» по этой же проблеме, а она возвращалась.
  // Нужно, чтобы повторный заход не выглядел как новая находка: «отмечали решённым — факт повторился».
  const reportedByKey = {};
  for (const f of prev) {
    if (f.status !== "rop_reported") continue;
    const k = key(f);
    const c = f.repeatCount || 1;
    if (!reportedByKey[k] || c >= (reportedByKey[k].repeatCount || 1)) reportedByKey[k] = f;
  }

  const merged = [];
  const added = [];
  const kept = [];
  for (const f of fresh) {
    const k = key(f);
    if (graced.has(k)) { kept.push(k); continue; } // РОП сказал, что закрыл — дадим данным обновиться
    const ex = prevByKey[k];
    // проблема ещё жива — обновляем факты (состав МОПов, счётчик, формулировку), но СРОК НЕ ДВИГАЕМ
    if (ex) { merged.push({ ...ex, count: f.count, mops: f.mops, fact: f.fact, title: f.title, action: f.action, updatedAt: nowMs }); continue; }

    // ПОВТОР: та же проблема уже закрывалась словом РОПа, грейс истёк, а факт снова в данных
    const wasReported = reportedByKey[k];
    if (wasReported) {
      const n = (wasReported.repeatCount || 1) + 1;
      const since = wasReported.closedAt ? new Date(wasReported.closedAt).toISOString().slice(0, 10) : "";
      f.repeatCount = n;
      f.repeatOf = wasReported.id;
      f.title = `СНОВА (${n}-й раз): ${f.title}`;
      f.fact = `${f.fact}\n\n⚠️ Это повтор. ${since ? `${since} ` : ""}РОП отметил эту проблему как решённую, но в данных она видна опять — значит договорённость не закрепилась.`;
      f.action = `${f.action} Проверить, почему прошлый раз не закрепилось: договорённость не дошла до людей / неудобно делать / никто не проверяет.`;
    } else {
      f.repeatCount = 1;
    }
    merged.push(f); added.push(f);
  }
  const freshKeys = new Set([...merged.map(key), ...kept]);

  // 4) АВТО-ЗАКРЫТИЕ: находка была, а сейчас не воспроизводится → закрываем.
  //    ⚠️ ОБЯЗАТЕЛЬНО уведомляем РОПа в треде, иначе задача «просто исчезнет» и он не поймёт куда.
  const autoClosed = [];
  const invalidated = [];
  for (const f of prevOpen) {
    // СТРУКТУРНО ОТКЛЮЧЁННЫЙ ТИП: находка построена на посылке, которая оказалась неверной
    // (звонки идут мимо CRM). Её нельзя ни держать открытой, ни «авто-закрыть как решённую» —
    // проблема не решена, она просто НИКОГДА НЕ БЫЛА ДОКАЗАНА. Аннулируем с честной причиной.
    if (STRUCTURALLY_OFF[f.type]) {
      invalidated.push({ ...f, status: "invalidated", closedAt: nowMs,
        closeReason: cfg.noCallDisabledReason || "детектор отключён: данные о звонках недостоверны" });
      continue;
    }
    if (freshKeys.has(key(f))) continue;
    // call_* (DeepSales): если разборы БЫЛИ в этот прогон и сигнал не воспроизвёлся → авто-закрываем (сигнал ушёл,
    // напр. новый недельный прогон улучшил картину); если разборов не было — держим (не «решено», просто не проверяли).
    if (String(f.type || "").startsWith("call_")) {
      if (caHadData) autoClosed.push({ ...f, status: "auto_closed", closedAt: nowMs, closeReason: "по свежим разборам звонков сигнал больше не подтверждается" });
      else merged.push(f);
      continue;
    }
    // НЕ ЗАКРЫВАЕМ то, чего в этот прогон не проверяли: если по типу стоял гейт (данные неполные
    // или trust не verified), отсутствие факта означает «не смотрели», а НЕ «проблема решена».
    // Иначе агент бы отрапортовал РОПу «✅ больше не подтвердилось», просто не заглянув в данные.
    if (!ALLOWED[f.type]) { merged.push(f); continue; }
    autoClosed.push({ ...f, status: "auto_closed", closedAt: nowMs, closeReason: "при проверке проблема больше не подтвердилась" });
  }

  const closedOld = prev.filter((f) => f.status !== "open");
  const all = [...merged, ...autoClosed, ...invalidated, ...closedOld].slice(-CAP.findings);
  await rsetJSON(K.findings, all);

  // история (для подсчёта повторов «3+ раза за неделю»)
  for (const f of added) history.push({ type: f.type, mop: f.mop || null, scope: f.scope, at: nowMs });
  await rsetJSON(K.history, history.slice(-CAP.history));

  const out = {
    ok: true, at: nowMs, tashkentDay: tkDay(),
    open: merged.length, added: added.length, autoClosed: autoClosed.length,
    invalidated: invalidated.length, // находки, снятые из-за отключённого детектора (не «решены»)
    invalidatedList: invalidated.map((f) => ({ scope: f.scope, title: f.title, why: f.closeReason })),
    telephony: { pct: tel.noCallButActivePct, bypassSuspected: !!tel.callsBypassSuspected, warning: tel.warning || null },
    department: merged.filter((f) => f.scope === "department").length,
    mop: merged.filter((f) => f.scope === "mop").length,
    skipped, // что не проверяли из-за trust — агент по этим метрикам МОЛЧИТ
    addedList: added.map((f) => ({ scope: f.scope, title: f.title, deadlineLabel: f.deadlineLabel })),
    autoClosedList: autoClosed.map((f) => ({ scope: f.scope, title: f.title })),
  };
  await rsetJSON(K.lastrun, out);
  return out;
}

// Для UI: последний прогон + по каким метрикам агент промолчал (trust layer)
export async function getMopLastRun() { return await rgetJSON(K.lastrun, null); }
// Task Agent читает это, чтобы влить находки в общий список задач РОПа
export async function getOpenMopFindings() {
  const all = await rgetJSON(K.findings, []);
  return all.filter((f) => f.status === "open");
}
// Task Agent вызывает после уведомления РОПа — чтобы не слать дважды.
// Два РАЗНЫХ повода снять задачу, и врать про них нельзя:
//   auto_closed  — проблема при проверке не подтвердилась (реально ушла)
//   invalidated  — детектор отключён, находка построена на неверной посылке (проблема НЕ решена,
//                  она просто никогда не была доказана). Сообщение обязано отличаться.
export async function getFreshAutoClosed() {
  const all = await rgetJSON(K.findings, []);
  const fresh = all.filter((f) => (f.status === "auto_closed" || f.status === "invalidated") && !f.ropNotified);
  if (fresh.length) {
    const ids = new Set(fresh.map((f) => f.id));
    await rsetJSON(K.findings, all.map((f) => ids.has(f.id) ? { ...f, ropNotified: true } : f));
  }
  return fresh;
}
// how: "rop_reported" (РОП сказал в Telegram, что сделал) | "closed" (закрыто вручную из UI)
// repeatCount сохраняем в закрытой записи — по нему следующий прогон поймёт, что это уже N-й круг.
export async function closeMopFinding(id, how, note, repeatCount) {
  const all = await rgetJSON(K.findings, []);
  await rsetJSON(K.findings, all.map((f) => f.id === id
    ? { ...f, status: how || "closed", closedAt: Date.now(), closeNote: note || f.closeNote || "",
        repeatCount: repeatCount || f.repeatCount || 1 }
    : f));
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const q = req.query || {}, b = req.body || {};
  const action = q.action || b.action || "state";
  const isProd = process.env.NODE_ENV === "production";
  const cronSecret = process.env.CRON_SECRET || "";
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const isCron = cronSecret ? (authHeader === `Bearer ${cronSecret}`) : (!isProd && (q.cron === "1" || b.cron === true));
  const sess = await getSession(q.session || b.session);
  const isAdmin = !!sess && sess.role === "admin";
  if (!isAdmin && !(action === "run" && isCron)) { res.status(403).json({ error: "admin only (или cron с секретом)" }); return; }

  try {
    if (action === "state") {
      const [all, cfg] = await Promise.all([rgetJSON(K.findings, []), getMopConfig()]);
      res.status(200).json({
        ok: true, config: cfg,
        open: all.filter((f) => f.status === "open"),
        closed: all.filter((f) => f.status !== "open").slice(-20).reverse(),
        now: { tashkentHour: tkHour(), tashkentDay: tkDay() },
      });
      return;
    }
    if (action === "run") { const r = await runMopAgent(); res.status(200).json(isAdmin ? r : { ok: !!r.ok, ran: true }); return; }
    if (action === "close") { await closeMopFinding(b.id, "closed"); res.status(200).json({ ok: true }); return; }
    if (action === "set_config") {
      const cur = await getMopConfig(); const inc = b.config || {}; const next = { ...cur };
      for (const k of ["deptMinMops", "deptMinRepeats", "repeatWindowDays", "minMismatchPerMop", "minNoCallPerMop", "endOfDayHour", "nextDayHour", "deptDeadlineDays"]) {
        if (typeof inc[k] === "number" && isFinite(inc[k]) && inc[k] >= 0) next[k] = inc[k];
      }
      if (typeof inc.enabled === "boolean") next.enabled = inc.enabled;
      await rsetJSON(K.config, next);
      res.status(200).json({ ok: true, config: next }); return;
    }
    if (action === "reset") { await Promise.all([rdel(K.findings), rdel(K.history)]); res.status(200).json({ ok: true, reset: true }); return; }
    res.status(400).json({ error: "unknown action" });
  } catch (err) {
    res.status(200).json({ ok: false, error: String(err && err.message || err) });
  }
}
