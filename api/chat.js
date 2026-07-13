// /api/chat.js — Крестодатель. Перед ответом читает ЖИВОЙ кэш из Upstash (те же данные, что в дашборде)
// и подкладывает их в контекст, чтобы отвечать по реальным цифрам amoCRM за текущий месяц.

export const config = { api: { bodyParser: { sizeLimit: "12mb" } } };

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

function liveBlock(d, fin, realGoal, workdays) {
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

  s += `\n(Данные на ${new Date(d.updatedAt).toLocaleDateString("ru")}, кэш обновляется по кнопке/раз в час.)`;
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
    const live = liveBlock(cache, fin, GOAL, workdays);

    // === УМНЫЕ ВОПРОСЫ: AI находит проблемы и предлагает, что спросить ===
    if (action === "smart-questions") {
      if (!cache || !cache.totals) { res.status(200).json({ ok: true, questions: [] }); return; }
      const qSystem = `Ты — директор по продажам. Смотришь данные бизнеса и находишь 3-4 ПРОБЛЕМЫ или зоны внимания, которые владелец сам не заметил бы.
Для каждой сформулируй КОРОТКИЙ вопрос (3-6 слов) от лица владельца ("Почему...", "Кто...", "Куда...", "Успеваем ли..."), который он захочет нажать.
Срочность: "hot" (горит, теряем деньги) или "warn" (внимание).
Отвечай ТОЛЬКО валидным JSON-массивом, без markdown, без пояснений:
[{"q":"Почему Komiljon не дозванивается?","level":"hot"},{"q":"Успеваем на план месяца?","level":"warn"}]
Язык: ${lang === "uz" ? "узбекский латиницей" : "русский"}. Максимум 4. Если всё хорошо — 1-2 общих вопроса.`;
      const qReq = {
        model: "claude-sonnet-4-6", max_tokens: 500,
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
      res.status(200).json({ ok: true, questions: questions.slice(0, 4) });
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

КАК ОТВЕЧАТЬ (это важнее всего):
1. СНАЧАЛА — прямой ответ на вопрос, по делу, цифрами.
2. Если есть проблема — назови её конкретно: что не так, у кого, насколько (в цифрах).
3. ВСЕГДА давай «что делать» — конкретный шаг, а не общие слова. Не «улучшите дозвон», а «у Комиля дозвон 29% — поставьте задачу перезвонить 10 вчерашним лидам сегодня до обеда».
4. Связывай с целью: чего не хватает, чтобы дойти до ${goalShort}.
5. ВАЖНО про темп и прогноз: план ставится по ОБЩЕЙ ВЫРУЧКЕ (вся касса за месяц: новые продажи + доплаты), а НЕ только по новым продажам. Темп в день считай ТОЛЬКО по рабочим дням (выходные не работают) — бери цифры «рабочих дней» и «темп за рабочий день» из блока данных, не пересчитывай по календарным дням. Если делишь на календарные дни — это ошибка, темп будет занижен.

ТВОЙ ХАРАКТЕР: прямой, конкретный, деловой. Говоришь цифрами, не водой. Хвалишь за результат, критикуешь по делу — но всегда с решением. Не грузишь философией.

ФОРМАТ: коротко и по делу. Если проблем несколько — списком по приоритету (сначала то, что сильнее всего бьёт по деньгам). Не пиши простыни — владелец занят.

У ТЕБЯ ЕСТЬ ЖИВЫЕ ДАННЫЕ (см. блок ниже): продажи, менеджеры, дисциплина, дозвон, скорость воронки, причины потерь, источники рекламы, финансы. Используй ВСЁ это, чтобы находить связи и корень проблемы. Например: продажи упали → смотри дозвон, смотри у кого из МОПов просадка, смотри источники — и покажи причинно-следственную цепочку.

ДИАГНОСТИКА (когда спрашивают «что не так» / «почему просели» / «чего не хватает»):
- Прогони все метрики, найди 2-3 главные дыры (те, что сильнее всего мешают цели).
- По каждой: в чём проблема (цифра) → почему (корень) → что сделать (конкретный шаг сегодня).
- Свяжи с целью ${goalShort}: «вот эти дыры стоят вам примерно X продаж/месяц».

КОНТЕКСТ (база, если живых данных мало): 2 главные исторические дыры воронки — первый контакт (много лидов гибнет без разговора) и закрытие сделки (большой разрыв между сильными и слабыми МОПами). «Дорого» — редкая причина отказа, цена не проблема.

ОБРАЩЕНИЕ: всегда обращайся к владельцу на «Вы» (вежливо, уважительно), никогда на «ты». Язык — грамотный и чистый, уровня C1, но простой и понятный (без жаргона). В узбекском — форма «Siz» и вежливые формы глаголов (не «qil/yoz», а «qiling/yozing»).

СТРОГАЯ ГРАНИЦА: отвечаешь ТОЛЬКО про бизнес, продажи, маркетинг, команду, воронку, рекламу, деньги бизнеса, рост. Если вопрос не про это — вежливо откажись одной фразой и верни к делу.

ЯЗЫК: ${lang === "uz" ? "Отвечай на ЖИВОМ, грамотном узбекском языке (латиница), как образованный НОСИТЕЛЬ языка — это НЕ дословный перевод с русского. Строй естественные узбекские фразы, подбирай правильные узбекские слова, НЕ мешай с русским и убирай лишние русизмы. Пиши просто и понятно, для обычного человека. Плохой, кривой или машинный узбекский недопустим." : "Отвечай ПО-РУССКИ."} Клиентский контент (реклама/скрипты) всегда на узбекском.

ВИЗУАЛЬНЫЕ КАРТОЧКИ: когда твой ответ касается конкретных данных, вставь В КОНЦЕ ответа специальную метку — приложение покажет живую карточку с реальными цифрами. Метки (пиши ровно так, на отдельной строке):
[[CARD:today]] — когда речь про сегодняшний день (лиды/продажи/дозвон сегодня)
[[CARD:mops]] — когда речь про менеджеров (кто как работает)
[[CARD:month]] — когда речь про итоги месяца (продажи, выручка, конверсия, цель)
[[CARD:adsets]] — когда речь про рекламу/источники/ROI
[[CARD:problems]] — когда речь про причины потерь лидов
[[CARD:forecast]] — когда речь про план/прогноз/отставание от цели
Вставляй 1, максимум 2 метки — только самые релевантные вопросу. Не описывай карточку словами повторно, приложение само нарисует цифры. Твой текст — это объяснение и совет, карточка — данные.`;

    let progressNote = "";

    const anthropicReq = {
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      system: SYSTEM + progressNote + live,
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
          if (evt.type === "content_block_delta" && evt.delta && evt.delta.type === "text_delta") {
            res.write(evt.delta.text);
          }
        } catch (e) { /* пропускаем неполные */ }
      }
    }
    res.end();
  } catch (err) {
    try { res.status(500).json({ error: "Server error", detail: String(err) }); } catch (e) { res.end(); }
  }
}
