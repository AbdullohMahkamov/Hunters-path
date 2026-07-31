// Упрощение рассылок: 2 утренних отчёта + высокий порог эскалации. Проверяем порог и состав отчётов.
import { resetMocks, kvSetJSON } from "./helpers.mjs";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const ta = await import("../api/task-agent.js");
const reports = await import("../api/reports.js");

const tkDate = (off = 0) => new Date(Date.now() + 5 * 3600000 - off * 86400000).toISOString().slice(0, 10);

beforeEach(() => resetMocks());

// ── ПОРОГ ЭСКАЛАЦИИ ──
test("порог: задача про ДЕНЬГИ + просрочка ≥2 дней → будим владельца; первый пропуск — нет", () => {
  const money = { title: "Обзвонить 27 лидов без звонка", why: "деньги уходят" };
  assert.equal(ta.escalationPushGate({ ...money, hoursOverdue: 50 }), true, "деньги + 50ч → пуш");
  assert.equal(ta.escalationPushGate({ ...money, hoursOverdue: 20 }), false, "деньги, но <48ч → не будим (не устойчиво)");
});

test("порог: 27 лидов без звонка = деньги независимо от источника (не привязано к разрыву цели)", () => {
  // именно этот кейс промахивался у старого критерия «завязано на разрыв к цели»
  assert.equal(ta.escalationPushGate({ title: "27 клиентов без единой попытки звонка", why: "", hoursOverdue: 60 }), true);
  assert.equal(ta.escalationPushGate({ title: "Зависшие сделки в воронке", why: "", hoursOverdue: 72 }), true);
});

test("порог: НЕ денежная задача не будит даже при большой просрочке → уходит в отчёт", () => {
  assert.equal(ta.escalationPushGate({ title: "Провести планёрку в офисе", why: "организовать", hoursOverdue: 120 }), false);
});

// ── ОТЧЁТ ПО КОМАНДЕ ──
test("отчёт команды: счётчики задач, кто тормозит, из наблюдений, решения с кнопками", async () => {
  // план (customPlan.sales) — источник «plan»; done через app.done
  kvSetJSON("appdata:hunter", {
    customPlan: { sales: [
      { id: "t2", t: "Дожать тёплых", deadline: tkDate(-5) },  // срок в будущем — не просрочена
      { id: "t3", t: "Готовая", deadline: tkDate(2) },          // выполнена
    ] },
    done: { t3: true },
  });
  // задача ИЗ НАБЛЮДЕНИЙ — находка MOP-агента (просрочена на 2 дня)
  kvSetJSON("mopagent:findings", [
    { id: "m1", status: "open", title: "Обзвонить 27 лидов без звонка", fact: "деньги уходят", deadline: tkDate(2), scope: "department" },
  ]);
  kvSetJSON("marketingtasks", []);
  kvSetJSON("transcriptplan:pending:hunter", { totals: { plannedMinutes: 100, plannedCalls: 30 }, declined: false }); // без spend → ждёт решения
  kvSetJSON("planner:pending:hunter", { periodKey: "июль 2026", plan: { facts: { gap: 30000000 } } });

  const r = await reports.buildTeamReport("hunter");
  assert.match(r.text, /поставлено.*3/s, "план(2) + находка MOP(1)");
  assert.match(r.text, /сделано.*1/s);
  assert.match(r.text, /просрочено.*1/s);
  assert.match(r.text, /Обзвонить 27 лидов/, "просроченная попала в «тормозит»");
  assert.match(r.text, /наблюдений.*работе.*1/s, "1 задача из наблюдений (MOP-агент)");
  assert.match(r.text, /Трата на разбор звонков/, "решение DeepSales строкой");
  assert.match(r.text, /План под цель.*ждёт подтверждения/s);
  const cbs = JSON.stringify(r.decisionButtons);
  assert.match(cbs, /tplan:run/, "кнопка подтверждения траты DeepSales");
  assert.match(cbs, /pl:confirm/, "кнопка подтверждения плана");
});

test("отчёт команды: в очередь решений идут ТОЛЬКО предложения категории «владелец» (операционка ОП — нет), топ-3 + счётчик", async () => {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", []);
  const now = Date.now();
  // Owner-категория: config-CRM (tier2) + маркетинг (деньги/канал) + мелочь tier1. Операционка ОП (p_rop) в очередь НЕ должна попасть.
  kvSetJSON("metabrain:proposals", [
    { id: "p1", status: "pending", title: "В воронке нельзя отличить «выиграли» от «оплату получили»", confidence: "high", at: now - 10 * 86400000 }, // config → owner (tier2)
    { id: "p2", status: "pending", title: "Поднять бюджет на конверсионную аудиторию", confidence: "high", at: now - 8 * 86400000, proposedTask: { recipient: "marketing" } }, // маркетинг → owner
    { id: "p3", status: "pending", title: "Перераспределить бюджет между кампаниями", confidence: "med", at: now - 6 * 86400000, proposedTask: { recipient: "marketing" } }, // маркетинг → owner (tier1)
    { id: "p4", status: "pending", title: "Оформить доску объявлений в офисе", confidence: "low", at: now - 1 * 86400000 }, // tier1 → owner
    { id: "p_rop", status: "pending", title: "27 лидов без единой попытки звонка", confidence: "high", at: now - 12 * 86400000 }, // операционка ОП → РОПу, НЕ в очередь
  ]);
  const r = await reports.buildTeamReport("hunter");
  assert.match(r.text, /нельзя отличить/, "config-предложение (владелец) показано");
  assert.doesNotMatch(r.text, /27 лидов без единой попытки/, "операционка ОП в очередь владельца НЕ попадает");
  assert.match(r.text, /и ещё 1/, "4 owner-предложения → топ-3 + счётчик 1");
  const cbs = JSON.stringify(r.decisionButtons);
  assert.match(cbs, /mb:confirm:p1/, "кнопка подтвердить предложение");
  assert.match(cbs, /mb:reject:p1/, "кнопка отклонить предложение");
});

test("отчёт команды: получатель НЕ привязан → громкая строка о недоставке (не молчим)", async () => {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", [{ id: "mk1", title: "Поднять бюджет в TASHKENT", status: "open" }]); // маркетинг-задача есть
  kvSetJSON("taskagent:people", { owner: { chatId: 1 } }); // маркетолог НЕ привязан
  const r = await reports.buildTeamReport("hunter");
  assert.match(r.text, /Проверьте доставку/);
  assert.match(r.text, /маркетолог не привязан/);
});

test("отчёт команды: получатель привязан → строки о недоставке нет", async () => {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", [{ id: "mk1", title: "Поднять бюджет", status: "open" }]);
  kvSetJSON("taskagent:people", { owner: { chatId: 1 }, marketing: { chatId: 5 } }); // привязан
  const r = await reports.buildTeamReport("hunter");
  assert.doesNotMatch(r.text, /Проверьте доставку/);
});

test("совмещение ролей ПОМЕЧЕНО (marketing=owner) → предупреждения нет, а в «тормозит» просрочка помечена «(вы)»", async () => {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", [{ id: "mk1", title: "Поднять бюджет", status: "open", deadline: tkDate(2) }]); // маркетинг-задача просрочена
  kvSetJSON("taskagent:people", { owner: { chatId: 1 }, marketing: { chatId: 1 } }); // один аккаунт
  kvSetJSON("taskagent:rolecombine", { marketing: "owner" });                          // осознанно
  const r = await reports.buildTeamReport("hunter");
  assert.doesNotMatch(r.text, /Проверьте доставку/, "осознанное совмещение не предупреждаем");
  assert.match(r.text, /Маркетолог \(вы\)/, "своя просрочка помечена как ваша, не проблема дисциплины");
});

test("совмещение ролей НЕ помечено → подозрительная коллизия в отчёт", async () => {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", []);
  kvSetJSON("taskagent:people", { rop: { chatId: 7 }, marketing: { chatId: 7 } }); // один аккаунт, без пометки
  const r = await reports.buildTeamReport("hunter");
  assert.match(r.text, /совмещение НЕ помечено/);
});

test("отчёт команды: нет решений → секции «ждёт решения» нет", async () => {
  kvSetJSON("appdata:hunter", { customPlan: { sales: [] }, done: {} });
  kvSetJSON("marketingtasks", []);
  const r = await reports.buildTeamReport("hunter");
  assert.doesNotMatch(r.text, /Ждёт вашего решения/);
  assert.equal(r.decisionButtons.length, 0);
});

// ── БИЗНЕС-ОТЧЁТ ──
test("бизнес-отчёт: числа за вчера + цена лида + расход + прогресс к цели", async () => {
  kvSetJSON("dashboard", {
    updatedAt: new Date().toISOString(),
    totals: { leads: 200, sold: 20, revenue: 60000000, avgCheck: 5000000, avgCheckMedian: 5000000, newSalesRevenue: 60000000, soldToday: 0, revenueToday: 0, leadsToday: 0 },
    mopsByConv: [{ name: "A" }], velocity: { stages: [] },
  });
  kvSetJSON("goal:hunter", { amountUZS: 100000000, currency: "UZS", period: { label: "июль 2026", start: "2026-07-01", end: "2026-07-31" } });
  kvSetJSON(`bizday:${tkDate(1)}`, { sold: 3, revenue: 15000000, leads: 12 });
  kvSetJSON("marketingagent:snapshot", { currency: { aligned: true, spendUZS: 2000000 } });

  const r = await reports.buildBusinessReport("hunter");
  assert.match(r.text, /Продаж:.*3/s);
  assert.match(r.text, /выручка:.*15\s?000\s?000/s);
  assert.match(r.text, /лидов:.*12/s);
  assert.match(r.text, /Цена лида:.*10\s?000/s, "CPL = spendUZS/leads = 2М/200");
  assert.match(r.text, /расход на рекламу:.*2\s?000\s?000/s);
  assert.match(r.text, /закрыто.*60\s?000\s?000.*из.*100\s?000\s?000/s);
  assert.match(r.text, /\(60%\)/);
});

test("бизнес-отчёт на стыке месяцев: цель ПРОШЛОГО периода → «цель не задана», без бредового прогресса", async () => {
  kvSetJSON("dashboard", { updatedAt: new Date().toISOString(), totals: { leads: 200, sold: 20, revenue: 60000000, avgCheckMedian: 5000000 }, mopsByConv: [{ name: "A" }], velocity: { stages: [] } });
  kvSetJSON(`bizday:${tkDate(1)}`, { sold: 3, revenue: 15000000, leads: 12 });
  kvSetJSON("goal:hunter", { amountUZS: 100000000, currency: "UZS", period: { label: "январь 2020", start: "2020-01-01", end: "2020-01-31" } }); // заведомо не текущий месяц
  const r = await reports.buildBusinessReport("hunter");
  assert.match(r.text, /ещё не задана/, "старая цель не выдаётся за текущую");
  assert.doesNotMatch(r.text, /закрыто.*из/, "нет строки прогресса против устаревшей цели");
});
