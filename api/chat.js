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

function liveBlock(d) {
  if (!d || !d.totals) {
    return "\n\nЖИВЫЕ ДАННЫЕ amoCRM: пока не загружены (кэш пуст). Если спросят про текущие цифры — скажи, что нужно нажать «Обновить из amoCRM» в дашборде, и опирайся на данные аудита.";
  }
  const t = d.totals;
  let s = `\n\n=== ЖИВЫЕ ДАННЫЕ ИЗ amoCRM (воронка HunterAcademy, ${d.period}, обновлено ${d.updatedAt}) ===\n`;
  s += `Это РЕАЛЬНЫЕ актуальные цифры — опирайся на них, когда спрашивают про "сейчас", "этот месяц", "сегодня".\n`;
  s += `Продаж за месяц: ${t.sold} (план ~${t.needPerMonth || 141}/мес)\n`;
  s += `Выручка: ${t.revenue.toLocaleString("ru")} сум · до цели 500М: ${t.goalPct}%\n`;
  s += `Конверсия команды: ${t.conv}% (лид→продажа)\n`;
  s += `Средний чек: ${t.avgCheck.toLocaleString("ru")} сум (без «своих», исключено ${t.ownExcluded})\n`;
  if (d.mopsBySales && d.mopsBySales.length) {
    s += `\nПо МОПам (имя · лиды · продажи · конверсия · дозвон):\n`;
    for (const m of d.mopsByConv) {
      s += `  ${m.name}: ${m.leads} лидов, ${m.sold} продаж, ${m.conv}%, дозвон ${m.reachPct}%\n`;
    }
  }
  if (d.problems && d.problems.length) {
    s += `\n5 главных причин потерь за месяц:\n`;
    for (const p of d.problems) s += `  ${p.name}: ${p.count}\n`;
  }
  s += `\nКогда отвечаешь по этим цифрам — уточняй "по данным на ${new Date(d.updatedAt).toLocaleDateString("ru")}", т.к. кэш обновляется раз в сутки.`;
  return s;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: "ANTHROPIC_API_KEY not set on server" }); return; }

  try {
    const { messages, progress, lang } = req.body || {};

    const SYSTEM = `Ты — «Крестодатель» (Quest-giver), коммерческий директор и наставник Абдуллоха в игре «Hunter's Path».
Абдуллох — «авантюрист», основатель Hunter Academy (школа подготовки менеджеров по продажам / МОП, Ташкент, Узбекистан).
Главная цель: построить коммерческую машину, дающую стабильно 500 000 000 сум/мес.

ТВОЙ ХАРАКТЕР: прямой, коммерчески жёсткий, говоришь цифрами а не водой. Вайб охотника. Обращаешься «авантюрист». Без воды и философии. Хвалишь за результат.

ВАЖНО ПРО ДАННЫЕ: у тебя ЕСТЬ доступ к живым данным из amoCRM (см. блок ниже). Когда Абдуллох спрашивает про текущие цифры — НЕ проси выгрузку, а бери их из живого блока. Выгрузку проси только если живых данных нет.

КОНТЕКСТ АУДИТА (база, если живых данных нет):
- Две главные дыры: этап 2 (Лид→Контакт, 57% лидов гибнут без разговора, медиана касания 64ч) и этап 4 (Квалиф→Продажа, разрыв топ/низ 2,8x).
- Действующая пятёрка: Komiljon, Samandar (топы ~3%), Abdulla-Legenda, Begoyim, Abulbositxon (нижняя тройка 1-1,5%).
- «Дорого» — лишь 4% отказов, цена не проблема. «Свои» ≤1,6М не считаем.

6 ЭТАПОВ КОНВЕЙЕРА: 1.Логово трафика 2.Ущелье молчания(дыра) 3.Застава отбора 4.Арена закрытия(дыра) 5.Сад терпения 6.Сокровищница.

ЯЗЫК: ${lang === "uz" ? "Отвечай ПО-УЗБЕКСКИ (латиница, literary uzbek)." : "Отвечай ПО-РУССКИ."} Клиентский контент (реклама/скрипты) всегда на узбекском.

КАК РАБОТАЕШЬ: конкретные квесты с готовыми материалами, чтобы закрывались сегодня. Приоритет — этапы 2 и 4.`;

    let progressNote = "";
    if (progress && typeof progress === "object") {
      progressNote = `\n\nПРОГРЕСС ОХОТЫ: ${progress.doneCount || 0}/${progress.total || 0} квестов, боссов повержено ${progress.bossesDown || 0}.`;
    }

    // ЖИВЫЕ ДАННЫЕ из кэша
    const cache = await readDashboardCache();
    const live = liveBlock(cache);

    const anthropicReq = {
      model: "claude-sonnet-4-6",
      max_tokens: 2500,
      system: SYSTEM + progressNote + live,
      messages: messages,
    };

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(anthropicReq),
    });

    if (!r.ok) { const t = await r.text(); res.status(r.status).json({ error: "Anthropic API error", detail: t }); return; }
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: "Server error", detail: String(err) });
  }
}
