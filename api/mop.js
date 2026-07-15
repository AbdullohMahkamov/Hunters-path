// /api/mop.js — управление аккаунтами МОПов и их данными.
// АДМИН: создаёт/удаляет аккаунты МОПов (логин/пароль), ставит личные планы.
// МОП: получает свои метрики + рейтинг команды.
//
// Хранилище:
//   mops:accounts        → [{login,password,mopId,name,org}]
//   mops:plans:${org}    → {mopId: planSum}  (личный план в выручке)

const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${REDIS_TOKEN}` } });
  const d = await r.json(); return d && d.result != null ? d.result : null;
}
async function redisSet(key, value) {
  await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}`, { method: "POST", headers: { Authorization: `Bearer ${REDIS_TOKEN}` }, body: typeof value === "string" ? value : JSON.stringify(value) });
}
async function getSession(session) {
  if (!session) return null;
  try { const raw = await redisGet(`session:${session}`); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function readCache(org) {
  // дашборд-кэш (ключи как в chat.js: "dashboard", для др. org — "dashboard:${org}")
  const key = (org && org !== "hunter") ? `dashboard:${org}` : "dashboard";
  try { const raw = await redisGet(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
async function readSpeed(org) {
  const key = (org && org !== "hunter") ? `speed:${org}` : "speed";
  try { const raw = await redisGet(key); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}

export default async function handler(req, res) {
  if (!REDIS_URL || !REDIS_TOKEN) { res.status(500).json({ error: "no redis" }); return; }
  const session = (req.query && req.query.session) || (req.body && req.body.session);
  const sess = await getSession(session);
  if (!sess) { res.status(403).json({ error: "no session" }); return; }
  const org = sess.org || "hunter";

  try {
    // ============ АДМИН: управление аккаунтами МОПов ============
    if (sess.role === "admin") {
      // список аккаунтов + планов
      if (req.query && req.query.action === "list") {
        const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
        const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");
        // список МОПов из дашборда (чтобы админ видел, кому создавать)
        const cache = await readCache(org);
        const mopsFromCrm = (cache && cache.mopsBySales) ? cache.mopsBySales.map(m => ({ id: m.id, name: m.name })) : [];
        res.status(200).json({ ok: true, accounts: accounts.filter(a => (a.org || "hunter") === org).map(a => ({ login: a.login, password: a.password, mopId: a.mopId, name: a.name, mopRole: a.mopRole || "sales" })), plans, mopsFromCrm });
        return;
      }
      // создать аккаунт МОПу
      if (req.method === "POST" && req.body && req.body.action === "create") {
        const { login, password, mopId, name, mopRole } = req.body;
        if (!login || !password || !mopId) { res.status(400).json({ error: "login, password, mopId обязательны" }); return; }
        const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
        if (accounts.find(a => (a.login || "").toLowerCase() === String(login).toLowerCase())) {
          res.status(200).json({ ok: false, error: "Такой логин уже есть" }); return;
        }
        accounts.push({ login: String(login).trim(), password: String(password), mopId: String(mopId), name: name || "", org, mopRole: mopRole === "presales" ? "presales" : "sales" });
        await redisSet("mops:accounts", accounts);
        res.status(200).json({ ok: true, created: true });
        return;
      }
      // изменить роль/план существующего
      if (req.method === "POST" && req.body && req.body.action === "set_role") {
        const { login, mopRole } = req.body;
        const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
        const a = accounts.find(x => (x.login || "").toLowerCase() === String(login).toLowerCase());
        if (a) { a.mopRole = mopRole === "presales" ? "presales" : "sales"; await redisSet("mops:accounts", accounts); }
        res.status(200).json({ ok: true });
        return;
      }
      // удалить аккаунт
      if (req.method === "POST" && req.body && req.body.action === "delete") {
        const { login } = req.body;
        let accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
        accounts = accounts.filter(a => (a.login || "").toLowerCase() !== String(login).toLowerCase());
        await redisSet("mops:accounts", accounts);
        res.status(200).json({ ok: true, deleted: true });
        return;
      }
      // изменить логин/код/имя существующего аккаунта (без удаления и пересоздания)
      if (req.method === "POST" && req.body && req.body.action === "update_account") {
        const { login, newLogin, password, name } = req.body;
        const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
        const a = accounts.find(x => (x.login || "").toLowerCase() === String(login || "").toLowerCase());
        if (!a) { res.status(200).json({ ok: false, error: "Аккаунт не найден" }); return; }
        const nl = (newLogin != null ? String(newLogin) : "").trim();
        if (nl && nl.toLowerCase() !== (a.login || "").toLowerCase()) {
          if (accounts.find(x => (x.login || "").toLowerCase() === nl.toLowerCase())) { res.status(200).json({ ok: false, error: "Такой логин уже есть" }); return; }
          a.login = nl;
        }
        if (password != null && String(password) !== "") a.password = String(password);
        if (name != null && String(name).trim() !== "") a.name = String(name).trim();
        await redisSet("mops:accounts", accounts);
        res.status(200).json({ ok: true, saved: true });
        return;
      }
      // задать личный план МОПу
      if (req.method === "POST" && req.body && req.body.action === "set_plan") {
        const { mopId, plan } = req.body;
        const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");
        plans[String(mopId)] = parseInt(plan, 10) || 0;
        await redisSet(`mops:plans:${org}`, plans);
        res.status(200).json({ ok: true, saved: true });
        return;
      }
      // задать приз розыгрыша месяца
      if (req.method === "POST" && req.body && req.body.action === "set_raffle") {
        const { prize } = req.body;
        if (prize && String(prize).trim()) {
          await redisSet(`mops:raffle:${org}`, JSON.stringify({ prize: String(prize).trim(), setAt: Math.floor(Date.now() / 1000) }));
        } else {
          await redisSet(`mops:raffle:${org}`, JSON.stringify(null));
        }
        res.status(200).json({ ok: true });
        return;
      }
      // получить приз розыгрыша (для формы админа)
      if (req.query && req.query.action === "get_raffle") {
        const raffle = JSON.parse((await redisGet(`mops:raffle:${org}`)) || "null");
        res.status(200).json({ ok: true, raffle });
        return;
      }
    }

    // ============ МОП: смена собственного пароля ============
    if (req.method === "POST" && req.body && req.body.action === "change_password") {
      if (sess.role !== "mop") { res.status(403).json({ error: "only mop" }); return; }
      const oldPassword = String((req.body.oldPassword) || "");
      const newPassword = String((req.body.newPassword) || "");
      if (newPassword.length < 4) { res.status(200).json({ ok: false, error: "Новый пароль слишком короткий (минимум 4 символа)" }); return; }
      const accounts = JSON.parse((await redisGet("mops:accounts")) || "[]");
      // аккаунт МОПа: по login из сессии, иначе (старые сессии) по mopId+org
      const idx = accounts.findIndex(a => sess.login
        ? (a.login || "").toLowerCase() === String(sess.login).toLowerCase()
        : (String(a.mopId) === String(sess.mopId) && (a.org || "hunter") === org));
      if (idx === -1) { res.status(200).json({ ok: false, error: "Аккаунт не найден" }); return; }
      if (accounts[idx].password !== oldPassword) { res.status(200).json({ ok: false, error: "Текущий пароль неверный" }); return; }
      accounts[idx].password = newPassword;
      await redisSet("mops:accounts", accounts);
      res.status(200).json({ ok: true, changed: true });
      return;
    }

    // ============ МОП или АДМИН: данные кабинета МОПа ============
    if (req.query && req.query.action === "cabinet") {
      // какой МОП: сам МОП — свой mopId; админ может смотреть любого (?mopId=)
      const mopId = sess.role === "mop" ? sess.mopId : (req.query.mopId || sess.mopId);
      if (!mopId) { res.status(400).json({ error: "no mopId" }); return; }

      const cache = await readCache(org);
      const speed = await readSpeed(org);
      if (!cache || !cache.mopsBySales) { res.status(200).json({ ok: true, empty: true, message: "Данные ещё не загружены" }); return; }

      const plans = JSON.parse((await redisGet(`mops:plans:${org}`)) || "{}");

      // собираем метрики каждого МОПа: продажи из mopsBySales, дисциплина из speed
      const speedMops = (speed && speed.mops) ? speed.mops : [];
      const byId = {};
      (cache.mopsBySales || []).forEach(m => { byId[m.id] = { ...m }; });
      (cache.mopsByConv || []).forEach(m => { if (byId[m.id]) { byId[m.id].leads = m.leads; byId[m.id].conv = m.conv; byId[m.id].reachPct = m.reachPct; byId[m.id].fakeNums = m.fakeNums || 0; } });
      speedMops.forEach(m => {
        // speed-мопы имеют только name (без id) — матчим по имени, т.к. id мопа = имя
        const key = m.id != null ? m.id : m.name;
        if (byId[key]) {
          byId[key].medianFirstCallMin = m.medianFirstCallMin;
          byId[key].taskRate = m.taskRate;
          byId[key].reachRate = m.reachRate;
        }
      });

      // команда: массив всех, отсортирован по продажам
      const team = Object.values(byId).map(m => ({
        id: m.id, name: m.name,
        sold: m.sold || 0, revenue: m.revenue || 0,
        soldToday: m.soldToday || 0, revenueToday: m.revenueToday || 0,
        leads: m.leads || 0, conv: m.conv || 0,
        reachPct: m.reachPct != null ? m.reachPct : (m.reachRate || 0),
        fakeNums: m.fakeNums || 0, // нереальные номера (Xato raqam + Dubl), исключены из знаменателя дозвона
        firstCallMin: m.medianFirstCallMin != null ? m.medianFirstCallMin : null,
        taskRate: m.taskRate != null ? m.taskRate : null,
        plan: plans[m.id] || 0,
      })).sort((a, b) => b.sold - a.sold);

      // рейтинг: место каждого
      team.forEach((m, i) => { m.rank = i + 1; });

      const me = team.find(m => String(m.id) === String(mopId)) || null;
      // «до следующего места»
      let toNext = null;
      if (me && me.rank > 1) {
        const above = team[me.rank - 2];
        toNext = { name: above.name, soldDiff: (above.sold - me.sold) };
      }

      // === РАСЧЁТ ЗАРАБОТКА (лестница KPI) ===
      const USD = 12000; // курс доллара
      // ступени: [% плана, ставка KPI]
      const LADDERS = {
        presales: { fix: 1000000, steps: [[20, 4.0], [40, 5.0], [60, 6.0], [80, 7.0], [100, 8.0]] },
        sales:    { fix: 2000000, steps: [[20, 4.0], [40, 6.0], [60, 7.0], [80, 8.0], [100, 9.0]] },
      };
      // роль текущего аккаунта
      const myAccount = (JSON.parse((await redisGet("mops:accounts")) || "[]")).find(a => String(a.mopId) === String(mopId));
      const role = (myAccount && myAccount.mopRole) || "sales";
      const ladder = LADDERS[role] || LADDERS.sales;

      let earnings = null;
      if (me) {
        const plan = me.plan || 0;
        const revenue = me.revenue || 0;
        const planPct = plan > 0 ? (revenue / plan * 100) : 0;
        // достигнутая ступень (нижняя): самая высокая ступень, чей порог <= planPct; если ниже 20% — самая низкая ставка
        let rate = ladder.steps[0][1];
        let curStepIdx = -1;
        for (let i = 0; i < ladder.steps.length; i++) {
          if (planPct >= ladder.steps[i][0]) { rate = ladder.steps[i][1]; curStepIdx = i; }
        }
        const kpiSum = Math.round(revenue * rate / 100);
        const fix = ladder.fix;

        // бонусы за темп ($15 каждый по датам)
        const now = new Date(Date.now() + 5 * 3600 * 1000);
        const day = now.getUTCDate();
        const bonus15 = 15 * USD;
        // Исключение: ТОЛЬКО в июле 2026 первый бонус за темп даётся до 12 числа (обычно до 10).
        // Остальные пороги (20 / конец месяца) и другие месяцы — без изменений.
        const firstTempoDay = (now.getUTCFullYear() === 2026 && now.getUTCMonth() === 6) ? 12 : 10;
        // Правило: достиг порога % — бонус зачтён НАВСЕГДА (дата — мягкий ориентир для темпа, а не дедлайн).
        const tempoBonuses = [
          { label: `33% до ${firstTempoDay} числа`, need: 33, byDay: firstTempoDay, got: planPct >= 33, possible: day <= firstTempoDay },
          { label: "66% до 20 числа", need: 66, byDay: 20, got: planPct >= 66, possible: day <= 20 },
          { label: "100% до конца месяца", need: 100, byDay: 31, got: planPct >= 100, possible: true },
        ];
        const tempoBonusSum = tempoBonuses.filter(b => b.got).length * bonus15;

        // топ-2 бонус
        let topBonus = 0, topLabel = "";
        if (me.rank === 1) { topBonus = 1000000; topLabel = "🥇 1 место"; }
        else if (me.rank === 2) { topBonus = 500000; topLabel = "🥈 2 место"; }

        // ступени для лестницы (что откроется дальше)
        const ladderView = ladder.steps.map((s, i) => {
          const [pct, r] = s;
          const targetRevenue = Math.round(plan * pct / 100);
          const reached = planPct >= pct;
          const isCurrent = i === curStepIdx;
          const earnAtStep = Math.round(targetRevenue * r / 100) + fix;
          return { pct, rate: r, targetRevenue, reached, isCurrent, earnAtStep };
        });
        // следующая ступень
        const nextStep = ladderView.find(s => !s.reached) || null;
        let toNextStep = null;
        if (nextStep) {
          // заработок при достижении следующей ступени (на её целевой выручке)
          const targetRev = nextStep.targetRevenue;
          const kpiAtNext = Math.round(targetRev * nextStep.rate / 100);
          const earnAtNext = fix + kpiAtNext;
          toNextStep = {
            pct: nextStep.pct,
            revenueNeeded: Math.max(0, nextStep.targetRevenue - revenue),
            newRate: nextStep.rate,
            newEarn: earnAtNext,
            extraPerMonth: Math.round((revenue) * (nextStep.rate - rate) / 100),
          };
        }

        earnings = {
          role, fix, rate, planPct: Math.round(planPct),
          kpiSum, tempoBonusSum, tempoBonuses, topBonus, topLabel,
          total: fix + kpiSum + tempoBonusSum + topBonus,
          ladder: ladderView, nextStep: toNextStep, usd: USD,
        };

        // === СЦЕНАРИИ «ЧТО ЕСЛИ» (действие → сколько продать → сколько заработаешь) ===
        const currentTotal = fix + kpiSum + tempoBonusSum + topBonus;
        // функция: заработок при заданной выручке
        const earnAt = (rev) => {
          let r = ladder.steps[0][1];
          const pp = plan > 0 ? (rev / plan * 100) : 0;
          for (let i = 0; i < ladder.steps.length; i++) if (pp >= ladder.steps[i][0]) r = ladder.steps[i][1];
          const kpi = Math.round(rev * r / 100);
          // бонусы за темп при этой выручке (по факту достигнутого % — дата не влияет)
          let tb = 0;
          if (pp >= 33) tb += bonus15;
          if (pp >= 66) tb += bonus15;
          if (pp >= 100) tb += bonus15;
          return { total: fix + kpi + tb, rate: r, kpi };
        };
        const scenarios = [];
        // сценарий: закрыть план на 100%
        if (planPct < 100 && plan > 0) {
          const need = plan - revenue;
          const at = earnAt(plan);
          scenarios.push({
            kind: "plan100", title: "Закрыть план на 100%", icon: "🎯",
            sellMore: need, willEarn: at.total + topBonus, delta: (at.total + topBonus) - currentTotal, rate: at.rate,
          });
        }
        // сценарий: следующая ступень (если не 100%)
        if (nextStep && nextStep.pct < 100) {
          const targetRev = Math.round(plan * nextStep.pct / 100);
          const at = earnAt(targetRev);
          scenarios.push({
            kind: "step", pct: nextStep.pct, title: `Выйти на ${nextStep.pct}% плана`, icon: "📈",
            sellMore: Math.max(0, targetRev - revenue), willEarn: at.total + topBonus, delta: (at.total + topBonus) - currentTotal, rate: at.rate,
          });
        }
        // сценарий: забрать 1 место (если не первый)
        if (me.rank > 1) {
          const leader = team[0];
          const needRev = Math.max(0, (leader.revenue || 0) - revenue + 1);
          const targetRev = revenue + needRev;
          const at = earnAt(targetRev);
          scenarios.push({
            kind: "first", leaderName: leader.name, title: `Забрать 1 место (обойти ${leader.name})`, icon: "🥇",
            sellMore: needRev, willEarn: at.total + 1000000, delta: (at.total + 1000000) - currentTotal, rate: at.rate, topBonusNote: "+1 млн за 1 место",
          });
        }
        earnings.scenarios = scenarios;
        earnings.currentTotal = currentTotal;

        // === ДНИ ДО КОНЦА МЕСЯЦА + ТЕМП В ДЕНЬ ===
        const y = now.getUTCFullYear(), mo = now.getUTCMonth();
        const daysInMonth = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        // рабочие дни (пн-сб по умолчанию), оставшиеся
        let workLeft = 0;
        for (let dd = day + 1; dd <= daysInMonth; dd++) {
          const dow = new Date(Date.UTC(y, mo, dd)).getUTCDay(); // 0=вс
          if (dow !== 0) workLeft++;
        }
        const gapToPlan = Math.max(0, plan - revenue);
        earnings.daysInfo = {
          workLeft,
          perDayNeeded: workLeft > 0 ? Math.round(gapToPlan / workLeft) : gapToPlan,
          gapToPlan,
        };

        // === ПРОГРЕСС ДО СЛЕДУЮЩЕГО БОНУСА ЗА ТЕМП ===
        // ближайший невыполненный бонус
        let nextTempoBonus = null;
        const tempoTargets = [
          { pct: 33, byDay: firstTempoDay, got: planPct >= 33 },
          { pct: 66, byDay: 20, got: planPct >= 66 },
          { pct: 100, byDay: daysInMonth, got: planPct >= 100 },
        ];
        for (const tt of tempoTargets) {
          if (!tt.got) { // следующий непокрытый порог (дата — мягкий ориентир, дедлайна нет)
            const targetRev = Math.round(plan * tt.pct / 100);
            nextTempoBonus = {
              pct: tt.pct, byDay: tt.byDay,
              revenueNeeded: Math.max(0, targetRev - revenue),
              progress: targetRev > 0 ? Math.min(100, Math.round(revenue / targetRev * 100)) : 0,
              daysLeft: Math.max(0, tt.byDay - day),
            };
            break;
          }
        }
        earnings.nextTempoBonus = nextTempoBonus;

        // === ГДЕ ТЕРЯЕШЬ КЛИЕНТОВ (зависшие/недозвон) ===
        const mopRaw = (cache.mopsByConv || []).find(m => String(m.id) === String(mopId)) || (cache.mopsBySales || []).find(m => String(m.id) === String(mopId));
        const noContactCount = (mopRaw && mopRaw.noContact != null) ? mopRaw.noContact : Math.max(0, (me.leads || 0) - Math.round((me.leads || 0) * (me.reachPct || 0) / 100));
        earnings.losing = {
          noContact: noContactCount,
          // прикидка потерянных продаж: недозвон × конверсия
          potentialSales: me.conv > 0 ? Math.round(noContactCount * me.conv / 100) : 0,
        };
      }

      // === РОЗЫГРЫШ ПОДАРКА (задаёт админ) ===
      const raffle = JSON.parse((await redisGet(`mops:raffle:${org}`)) || "null");

      res.status(200).json({
        ok: true,
        me, team, toNext, earnings, raffle,
        period: cache.period,
        updatedAt: cache.updatedAt,
        mopName: (me && me.name) || sess.mopName || "",
        mopId,
      });
      return;
    }

    res.status(400).json({ error: "unknown action or no access" });
  } catch (e) {
    res.status(200).json({ ok: false, empty: true, message: "Ошибка сервера: " + String(e).slice(0, 200) });
  }
}
