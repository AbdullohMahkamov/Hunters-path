// Регрессии на РЕАЛЬНЫЕ классы ошибок этого проекта. Каждый тест упал бы ДО фикса.
import "./helpers.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

// 1) ВАЛЮТНОЕ РАССОГЛАСОВАНИЕ: ROAS считался делением UZS на USD → 314000x как валидное число
test("REGRESSION currency: ROAS приводит spend USD→UZS, не делит UZS на USD", async () => {
  const M = await import("../api/marketing-agent.js");
  const ads = M.deriveAds({ currency: "USD", period: "2026-07-01..2026-07-26", adsets: [{ name: "A", spend: 367, impressions: 431000, clicks: 4364 }], updatedAt: new Date().toISOString() });
  const cur = M.assessCurrencyAlignment(ads);
  assert.equal(cur.aligned, true);
  assert.equal(cur.adCurrency, "USD");
  assert.equal(cur.spendUZS, 367 * 12100); // приведено к сумам
  const unit = M.computeUnitEconomics(ads, { revenue: 120_000_000, customers: 36, trust: "verified" }, { aligned: true, month: "2026-07" }, cur);
  assert.ok(unit.roas.value != null && unit.roas.value > 1 && unit.roas.value < 100, `ROAS=${unit.roas.value} должен быть ~27x, а не 300000x`);
});

test("REGRESSION currency: неизвестная валюта → ROAS не диагностируется (не число)", async () => {
  const M = await import("../api/marketing-agent.js");
  const ads = M.deriveAds({ currency: null, period: "2026-07-01..2026-07-26", adsets: [{ name: "A", spend: 100, impressions: 1000, clicks: 10 }], updatedAt: new Date().toISOString() });
  const cur = M.assessCurrencyAlignment(ads);
  assert.equal(cur.aligned, false);
  const unit = M.computeUnitEconomics(ads, { revenue: 1e8, customers: 10, trust: "verified" }, { aligned: true }, cur);
  assert.ok(unit.roas.undiagnosable, "ROAS должен быть undiagnosable при неизвестной валюте");
  assert.equal(unit.roas.value, undefined);
});

// 2) РАССОГЛАСОВАНИЕ ПЕРИОДОВ: adspend за один месяц vs воронка за другое окно
test("REGRESSION period: adspend прошлого месяца vs текущий → не диагностируется", async () => {
  const M = await import("../api/marketing-agent.js");
  const ads = M.deriveAds({ currency: "USD", period: "2026-06-01..2026-06-30", adsets: [{ name: "A", spend: 100, impressions: 1000, clicks: 10 }], updatedAt: new Date().toISOString() });
  const ff = { revenue: 1e8, customers: 10, trust: "verified", dataFresh: true };
  const period = M.assessPeriodAlignment(ads, ff);
  assert.equal(period.aligned, false, "июньский adspend не должен совпасть с текущим месяцем");
  const cur = M.assessCurrencyAlignment(ads);
  const unit = M.computeUnitEconomics(ads, ff, period, cur);
  assert.ok(unit.roas.undiagnosable && unit.cac.undiagnosable, "обе метрики undiagnosable при рассогласовании периодов");
});

// 3) ДЕДУП ПО НЕСТАБИЛЬНОМУ КЛЮЧУ: growth слал одну тему как новую каждый прогон
test("REGRESSION growth-dedup: та же topicKey с другим текстом cause НЕ создаёт новый id", async () => {
  const G = await import("../api/growth-agent.js");
  const open = [{ id: "gh_1", topicKey: "leads_dont_understand", cause: "лиды холодные", status: "open", kind: "problem" }];
  const incoming = [{ topicKey: "leads_dont_understand", cause: "клиенты не понимают продукт при первом контакте", observation: "50% холодных" }];
  const merged = G.mergeGrowthHypotheses(open, incoming, []);
  assert.equal(merged.length, 1, "не должно появиться дубля при той же topicKey");
  assert.equal(merged[0].id, "gh_1", "id сохранён, тема не пересоздана");
});

test("REGRESSION growth-dedup: НОВАЯ тема добавляется, эксперимент помечается kind", async () => {
  const G = await import("../api/growth-agent.js");
  const open = [{ id: "gh_1", topicKey: "leads_dont_understand", cause: "x", status: "open" }];
  const merged = G.mergeGrowthHypotheses(open, [{ topicKey: "untested_telegram", cause: "не пробовали телеграм", kind: "experiment" }], []);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].kind, "experiment");
  assert.ok(merged[1].id && merged[1].id !== "gh_1");
});

test("REGRESSION growth-dedup: проверенная тема не переоткрывается", async () => {
  const G = await import("../api/growth-agent.js");
  const merged = G.mergeGrowthHypotheses([], [{ topicKey: "closed_topic", cause: "y" }], [{ topicKey: "closed_topic", result: "false_positive" }]);
  assert.equal(merged.length, 0, "тема из tested не должна вернуться");
});
