// Капасити по последним 3 месяцам С УЧЁТОМ ТЕНДЕНЦИИ: медиана всей истории слепа к росту
// (разгонные месяцы вечно тянут вниз). Окно + направление лечат это.
import "./helpers.mjs";
import { recentCapacity } from "../api/goal-realism.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const NOW = "2026-08"; // август текущий → июль и раньше завершены

test("растущий тренд → база = последний месяц (не заниженная медиана)", () => {
  const r = recentCapacity({ "2026-05": 258, "2026-06": 268, "2026-07": 360 }, NOW);
  assert.equal(r.trend, "up");
  assert.equal(r.base, 360, "монотонный рост → текущий уровень");
  assert.equal(r.monthsN, 3);
});

test("падающий тренд → база = последний месяц (ниже, честно)", () => {
  const r = recentCapacity({ "2026-05": 400, "2026-06": 300, "2026-07": 200 }, NOW);
  assert.equal(r.trend, "down");
  assert.equal(r.base, 200);
});

test("разнонаправленно (разгон→плато) → медиана окна, НЕ медиана всей истории", () => {
  // Abdulla-Legenda реальный: за всю историю [35,16,425,421] медиана=228; окно последних-3 [16,425,421] → 421
  const r = recentCapacity({ "2026-04": 35, "2026-05": 16, "2026-06": 425, "2026-07": 421 }, NOW);
  assert.equal(r.window.join(","), "16,425,421", "берём последние 3, апрельский разгон выпадает");
  assert.equal(r.base, 421, "медиана [16,421,425] = 421 — реальный текущий темп, а не 228");
  assert.equal(r.trend, "flat");
});

test("окно дропает старые разгонные месяцы", () => {
  const r = recentCapacity({ "2026-02": 36, "2026-03": 62, "2026-04": 393, "2026-05": 276, "2026-06": 198, "2026-07": 227 }, NOW);
  assert.equal(r.window.join(","), "276,198,227", "только последние 3 завершённых");
});

test("includeCurrent: последний день месяца → текущий месяц входит в окно", () => {
  const off = recentCapacity({ "2026-06": 268, "2026-07": 360 }, "2026-07", false); // июль текущий, не включаем
  assert.equal(off.window.join(","), "268", "июль исключён (только июнь завершён)");
  const on = recentCapacity({ "2026-06": 268, "2026-07": 360 }, "2026-07", true); // последний день → включаем
  assert.equal(on.window.join(","), "268,360", "июль вошёл");
  assert.equal(on.base, 360);
});

test("меньше данных / пусто", () => {
  assert.equal(recentCapacity({}, NOW).monthsN, 0);
  const one = recentCapacity({ "2026-07": 300 }, NOW);
  assert.equal(one.monthsN, 1);
  assert.equal(one.base, 300);
  assert.equal(one.trend, "flat");
});

// ── РАЗЛОЖЕНИЕ КОНВЕРСИИ на дозвон × закрытие: где резерв ──
import { funnelReserve } from "../api/goal-realism.js";

test("funnelReserve: conv = дозвон × закрытие; резерв там, где рычаг больше", () => {
  // conv 2.6% = дозвон 58% × закрытие 4.48%. Лучший дозвон 60% (мало), лучшее закрытие 8% (много) → резерв в закрытии
  const r = funnelReserve(0.026, 0.58, 0.60, 0.08);
  assert.equal(r.dozvonPct, 58);
  assert.equal(r.closingPct, 4.48);
  assert.equal(r.reserveStep, "closing", "закрытие 4.5→8% даёт больше, чем дозвон 58→60%");
});

test("funnelReserve: если дозвон низкий, а закрытие уже на потолке — резерв в дозвоне", () => {
  const r = funnelReserve(0.026, 0.40, 0.65, 0.065); // дозвон 40% при лучшем 65%, закрытие уже = лучшему
  assert.equal(r.reserveStep, "dozvon");
});

test("funnelReserve: нет базы → null", () => {
  assert.equal(funnelReserve(0, 0.5, 0.6, 0.08), null);
  assert.equal(funnelReserve(0.026, 0, 0.6, 0.08), null);
});

// ── РЫЧАГИ → ЗАДАЧИ ОДНИМ ПАКЕТОМ ──
import { deriveLeverTasks } from "../api/goal-realism.js";

test("deriveLeverTasks: закрытие-резерв → задача РОПу; отстающий по дозвону → точечная; деньги НЕ задачи", () => {
  const v = { computable: true, decomp: { reserveStep: "closing", closingPct: 3.81, bestClosingPct: 7.92,
    worstDozvonMop: { name: "Komiljon", pct: 45 }, bestDozvonPct: 69 } };
  const t = deriveLeverTasks(v);
  assert.equal(t.length, 2);
  assert.match(t[0].title, /закрыти/i);
  assert.equal(t[0].recipient, "rop");
  assert.match(t[1].title, /Komiljon/);
  assert.equal(t[1].scope, "pointwise");
});

test("deriveLeverTasks: дозвон отстающего в норме (разрыв <10пп) → только задача закрытия", () => {
  const v = { computable: true, decomp: { reserveStep: "closing", closingPct: 4, bestClosingPct: 8,
    worstDozvonMop: { name: "X", pct: 62 }, bestDozvonPct: 69 } };
  assert.equal(deriveLeverTasks(v).length, 1);
});

test("deriveLeverTasks: нет вердикта/decomp → пусто", () => {
  assert.equal(deriveLeverTasks(null).length, 0);
  assert.equal(deriveLeverTasks({ computable: true }).length, 0);
});

test("deriveLeverTasks: маркетинг-задача КОНКРЕТНА (лиды+бюджет из levers), не вопрос", () => {
  const v = { computable: true, decomp: { reserveStep: "closing", closingPct: 3.8, bestClosingPct: 7.9, worstDozvonMop: { name: "K", pct: 45 }, bestDozvonPct: 69 },
    levers: { budgetGain: 12000000, leadsToPeak: 97, budgetToPeak: 405000, cpl: 4176 } };
  const t = deriveLeverTasks(v);
  const mkt = t.find((x) => x.recipient === "marketing");
  assert.ok(mkt, "есть маркетинг-задача");
  assert.equal(mkt.leads, 97);
  assert.equal(mkt.budgetUZS, 405000);
  assert.match(mkt.title, /97 лидов/);
  assert.match(mkt.title, /405\D?000/); // бюджет в заголовке
});

test("deriveLeverTasks: нет запаса лидов до пика (leadsToPeak=0) → маркетинг-задачи НЕТ", () => {
  const v = { computable: true, decomp: { reserveStep: "closing", closingPct: 3.8, bestClosingPct: 7.9 },
    levers: { budgetGain: 5000000, leadsToPeak: 0, budgetToPeak: 0, cpl: 4176 } };
  assert.equal(deriveLeverTasks(v).some((x) => x.recipient === "marketing"), false);
});
