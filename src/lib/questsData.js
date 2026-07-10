// Данные квестов (ICONS, STAGES, RANKS, ALL_QUESTS) — дословно из public/index.html.
import { state } from './appState.js'

const ICONS={
  chat:'<path d="M8 10h8M8 14h5"/><path d="M21 12a9 9 0 0 1-9 9 8.7 8.7 0 0 1-4-1l-4 1 1-4a8.7 8.7 0 0 1-1-4 9 9 0 0 1 18 0z"/>',
  tasks:'<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  dash:'<path d="M3 3v18h18"/><rect x="7" y="10" width="3" height="8"/><rect x="12" y="6" width="3" height="12"/><rect x="17" y="13" width="3" height="5"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  folder:'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  pin:'<path d="M9 4h6l-1 6 3 3H7l3-3-1-6zM12 16v4"/>',
  dots:'<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  check:'<path d="M20 6L9 17l-5-5"/>',
  edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash:'<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
  back:'<path d="M19 12H5M11 6l-6 6 6 6"/>',
  refresh:'<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  bolt:'<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  rocket:'<path d="M5 15c-1 1-2 4-2 4s3-1 4-2M9 12a11 11 0 0 1 8-8c1 4-1 8-4 10M9 12l3 3M9 12l-3-1M15 15l1 3"/>',
  drop:'<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
  trophy:'<path d="M8 4h8v5a4 4 0 0 1-8 0zM8 6H5v1a3 3 0 0 0 3 3M16 6h3v1a3 3 0 0 1-3 3M9 20h6M12 13v4"/>',
  bag:'<path d="M6 8h12l1 12H5zM9 8V6a3 3 0 0 1 6 0v2"/>',
  mega:'<path d="M4 10v4h3l7 4V6l-7 4zM18 9a3 3 0 0 1 0 6"/>',
  crown:'<path d="M4 8l3 3 5-6 5 6 3-3-2 11H6z"/>',
  users:'<circle cx="9" cy="8" r="3"/><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6"/>',
  mask:'<path d="M4 6h16v6a8 8 0 0 1-16 0zM9 11h.01M15 11h.01"/>',
  clip:'<path d="M21 12l-8.5 8.5a4 4 0 0 1-6-6L14 6a2.7 2.7 0 0 1 4 4l-8 8a1.3 1.3 0 0 1-2-2l7.5-7.5"/>',
  logout:'<path d="M9 4H5v16h4M16 12H9M13 8l4 4-4 4"/>',
  eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 4.5 1.5c0 1.5-2 2-2 3.5M12 17h.01"/>',
  bow:'<path d="M4 20L20 4M7 4H4v3M17 20h3v-3M12 12l4-1-1 4z"/>',
  sparkle:'<path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/>',
  lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  send:'<path d="M4 12l16-8-6 16-2-6z"/>',
};
function svg(name,size){const s=size||18;return `<svg class="ic" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]||''}</svg>`;}

const STAGES = [
  { id:1, section:'marketing', name:'Привлечение лидов', nameUz:'Mijozlarni jalb qilish', sub:'Трафик → Лид · откуда приходят клиенты', subUz:'Trafik → Lid · mijozlar qayerdan keladi', iconName:'mega',
    boss:'Ключевая цель этапа', bossUz:'Bosqichning asosiy maqsadi', bossDesc:'49% лидов идут из одной рекламной связки. Задача — не зависеть от одного источника.', bossDescUz:'Lidlarning 49% bitta reklama manbaidan keladi. Vazifa — bitta manbaga bog‘liq bo‘lmaslik.',
    reward:'✅ Результат: не зависите от одного источника лидов', rewardUz:'✅ Natija: bitta lid manbaiga bog‘liq emassiz',
    quests:[
      {id:'1a',t:'Разбить таргет на 3–4 параллельные связки',tUz:'Targetni 3–4 parallel manbaga bo‘lish',d:'Перелить часть бюджета из BOLLA OGANI в KARYERA (конвертит лучше) + тест 2 новых аудиторий.',dUz:'Byudjetning bir qismini BOLLA OGANI’dan KARYERA’ga o‘tkazing (u yaxshiroq konversiya beradi) + 2 ta yangi auditoriyani sinang.'},
      {id:'1b',t:'Завести лист учёта связок',tUz:'Manbalar hisobini yuritish jadvali',d:'Связка / CPL / лиды / продажи / конверсия / статус. Живёт, пока CPL ≤6000 и конверсия ≥1,8%.',dUz:'Manba / CPL / lidlar / sotuvlar / konversiya / holat. CPL ≤6000 va konversiya ≥1,8% bo‘lsa ishlaydi.'},
      {id:'1c',t:'5 новых селфи-крео в неделю',tUz:'Haftasiga 5 ta yangi selfi-kreativ',d:'Телефон, лайв, без студии. Офис, цифры заработка, профессия. Конкретные суммы, без понтов.',dUz:'Telefon, jonli, studiyasiz. Ofis, daromad raqamlari, kasb. Aniq summalar, maqtanchoqliksiz.'},
      {id:'1d',t:'Запустить органику: 1 Reels в день',tUz:'Organikani ishga tushirish: kuniga 1 Reels',d:'Social Proof + Big Brother + Luxe Life. Греет аудиторию ДО звонка.',dUz:'Social Proof + Big Brother + Luxe Life. Auditoriyani qo‘ng‘iroqdan OLDIN qizdiradi.'},
      {id:'1e',t:'Нанять SMM-специалиста',tUz:'SMM-mutaxassis yollash',d:'Критический bottleneck. Без выделенного человека контент-движок не поедет.',dUz:'Asosiy to‘siq. Alohida odamsiz kontent mashinasi yurmaydi.'},
    ]},
  { id:2, section:'sales', name:'Первый контакт', nameUz:'Birinchi aloqa', sub:'Лид → Дозвон · почему клиенты не отвечают', subUz:'Lid → Qo‘ng‘iroq · mijozlar nega javob bermaydi', iconName:'bolt', main:true,
    boss:'Ключевая цель этапа', bossUz:'Bosqichning asosiy maqsadi', bossDesc:'57% оплаченных лидов теряются без единого разговора. В среднем до первого звонка проходит 64 часа. Это главная точка потери денег.', bossDescUz:'To‘langan lidlarning 57% bironta suhbatsiz yo‘qoladi. Birinchi qo‘ng‘iroqqacha o‘rtacha 64 soat o‘tadi. Bu — pul yo‘qotishning asosiy nuqtasi.',
    reward:'✅ Результат: дозвон растёт с 43% до 75% (в 1,7 раза больше контактов)', rewardUz:'✅ Natija: aloqa 43%dan 75%gacha oshadi (1,7 barobar ko‘p kontakt)',
    quests:[
      {id:'2a',t:'Salesbot: авто-ответ за 30 секунд',tUz:'Salesbot: 30 soniyada avto-javob',d:'Готовый текст (Mutaxassis, 150+ трудоустроены) → подключить к боту. Триггер «Сделка создана».',dUz:'Tayyor matn (Mutaxassis, 150+ ishga joylashgan) → botga ulash. Trigger: «Bitim yaratildi».'},
      {id:'2b',t:'Регламент дозвона «5×48»',tUz:'Qo‘ng‘iroq reglamenti «5×48»',d:'1-й звонок ≤5 мин. Не взял — 5 попыток за 48ч в разное время суток, а не 3 подряд.',dUz:'1-qo‘ng‘iroq ≤5 daqiqa. Javob bermasa — 48 soatda kunning turli vaqtlarida 5 urinish, ketma-ket 3 emas.'},
      {id:'2c',t:'Закрывать «не дозвонились» только после 5 попыток',tUz:'«Bog‘lanib bo‘lmadi»ni faqat 5 urinishdan keyin yopish',d:'РОП проверяет выборочно. Статус не ставится раньше.',dUz:'ROP tanlab tekshiradi. Status oldinroq qo‘yilmaydi.'},
      {id:'2d',t:'Скорость касания → KPI каждого МОПа',tUz:'Aloqa tezligi → har bir menejer KPIsi',d:'Метрика «время до 1-го касания» в дашборд. Норматив: медиана ≤5 мин.',dUz:'«Birinchi aloqagacha vaqt» ko‘rsatkichi dashboardga. Norma: mediana ≤5 daqiqa.'},
    ]},
  { id:3, section:'sales', name:'Квалификация клиента', nameUz:'Mijozni saralash', sub:'Контакт → Отбор · выявить потребность', subUz:'Aloqa → Saralash · ehtiyojni aniqlash', iconName:'target',
    boss:'Ключевая цель этапа', bossUz:'Bosqichning asosiy maqsadi', bossDesc:'Данные о клиенте заполняются как попало, потребность не фиксируется. Задача — навести порядок в карточках.', bossDescUz:'Mijoz ma’lumotlari tartibsiz to‘ldiriladi, ehtiyoj qayd etilmaydi. Vazifa — kartochkalarda tartib o‘rnatish.',
    reward:'✅ Результат: каждый разговор даёт чистые данные о клиенте', rewardUz:'✅ Natija: har bir suhbat mijoz haqida toza ma’lumot beradi',
    quests:[
      {id:'3a',t:'Скрипт квалификации: 4 обязательных вопроса',tUz:'Saralash skripti: 4 ta majburiy savol',d:'Доход сейчас / цель / чем занят / срочность + формат-бюджет. Разрыв доход→цель = сила боли.',dUz:'Hozirgi daromad / maqsad / nima bilan shug‘ullanadi / shoshilinchlik + format-byudjet. Daromad→maqsad farqi = og‘riq kuchi.'},
      {id:'3b',t:'Перевести поля amoCRM в списки',tUz:'amoCRM maydonlarini ro‘yxatga aylantirish',d:'Доход, цель, срочность, целевой/нет — выпадающие списки вместо свободного текста.',dUz:'Daromad, maqsad, shoshilinchlik, maqsadli/yo‘q — erkin matn o‘rniga ochiluvchi ro‘yxatlar.'},
      {id:'3c',t:'Сделать поля обязательными для перехода этапа',tUz:'Maydonlarni bosqich o‘tishi uchun majburiy qilish',d:'Лид не идёт дальше, пока менеджер не заполнил квалификацию.',dUz:'Menejer saralashni to‘ldirmaguncha lid keyingi bosqichga o‘tmaydi.'},
      {id:'3d',t:'Критерий «нецелевой» + тег причины',tUz:'«Maqsadsiz» mezoni + sabab tegi',d:'Обратная связь уходит в аналитику связок — какая аудитория даёт мусор.',dUz:'Fikr manbalar tahliliga boradi — qaysi auditoriya sifatsiz lid beradi.'},
    ]},
  { id:4, section:'sales', name:'Закрытие сделки', nameUz:'Bitimni yopish', sub:'Квалификация → Продажа · как доводить до оплаты', subUz:'Saralash → Sotuv · to‘lovga qanday yetkazish', iconName:'bag', main:true,
    boss:'Ключевая цель этапа', bossUz:'Bosqichning asosiy maqsadi', bossDesc:'Разрыв между сильными и слабыми менеджерами — 2,8 раза. Метод лучших не записан. «Дорого» — лишь 4% отказов, значит дело в навыке продаж.', bossDescUz:'Kuchli va kuchsiz menejerlar orasidagi farq — 2,8 barobar. Eng yaxshilarning usuli yozilmagan. «Qimmat» — atigi 4% rad, demak gap sotuv mahoratida.',
    reward:'✅ Результат: команда выходит на ~3% конверсии (+47% выручки)', rewardUz:'✅ Natija: jamoa ~3% konversiyaga chiqadi (+47% daromad)',
    quests:[
      {id:'4a',t:'Оцифровать метод Комильона в скрипт',tUz:'Komiljon usulini skriptga aylantirish',d:'Прослушать 15–20 его звонков. Как открывает, работает с ценой, закрывает, продаёт допы (чек 4,18М).',dUz:'Uning 15–20 qo‘ng‘irog‘ini tinglang. Qanday ochadi, narx bilan ishlaydi, yopadi, qo‘shimcha sotadi (chek 4,18M).'},
      {id:'4b',t:'Комильон — наставник: 2 разбора в неделю',tUz:'Komiljon — murabbiy: haftasiga 2 tahlil',d:'С нижней тройкой. Доплатить за роль — дешевле тренера.',dUz:'Quyi uchlik bilan. Rol uchun ustama to‘lang — bu murabbiydan arzon.'},
      {id:'4c',t:'Перебалансировать раздачу лидов по конверсии',tUz:'Lid taqsimotini konversiya bo‘yicha qayta muvozanatlash',d:'Abulbositxon (1107 лидов / 1,08%) — снизить поток, отдать ядру.',dUz:'Abulbositxon (1107 lid / 1,08%) — oqimni kamaytiring, kuchli menejerlarga bering.'},
      {id:'4d',t:'План в продажах каждому МОПу + утренняя планёрка',tUz:'Har bir menejerga sotuv reja + ertalabki yig‘ilish',d:'«25 лидов × 2,5% = 6 продаж/неделю». 15 мин утром: цифры, задачи, разбор 1 сделки.',dUz:'«25 lid × 2,5% = haftasiga 6 sotuv». Ertalab 15 daqiqa: raqamlar, vazifalar, 1 bitim tahlili.'},
      {id:'4e',t:'Привязать зарплату к конверсии и чеку',tUz:'Maoshni konversiya va chekka bog‘lash',d:'Не только к объёму — чтобы не сливали лиды и не давали лишних скидок.',dUz:'Faqat hajmga emas — lidlarni behuda sarflamasin va ortiqcha chegirma bermasin.'},
    ]},
  { id:5, section:'sales', name:'Работа с отложенными', nameUz:'Kechiktirilganlar bilan ishlash', sub:'Догрев · вернуть тех, кто думает', subUz:'Qizdirish · o‘ylayotganlarni qaytarish', iconName:'drop',
    boss:'Ключевая цель этапа', bossUz:'Bosqichning asosiy maqsadi', bossDesc:'433 почти готовых клиента застряли в «подумаю позже» и теряются. Системы возврата нет. Задача — вернуть их.', bossDescUz:'433 ta deyarli tayyor mijoz «keyin o‘ylayman»da qolib yo‘qolyapti. Qaytarish tizimi yo‘q. Vazifa — ularni qaytarish.',
    reward:'✅ Результат: 15% отложенных клиентов превращаются в продажи', rewardUz:'✅ Natija: kechiktirilgan mijozlarning 15% sotuvga aylanadi',
    quests:[
      {id:'5a',t:'Отдельная воронка «Догрев» в amoCRM',tUz:'amoCRMda alohida «Qizdirish» voronkasi',d:'«Keyinroq» не закрывает сделку, а переводит в догрев с задачей «перезвонить через 7 дней».',dUz:'«Keyinroq» bitimni yopmaydi, balki «7 kundan keyin qo‘ng‘iroq qilish» vazifasi bilan qizdirishga o‘tkazadi.'},
      {id:'5b',t:'Цепочка касаний по дням',tUz:'Kunlar bo‘yicha aloqalar zanjiri',d:'День 1 — видео выпускника · день 3 — кусок обучения · день 7 — звонок · день 14 — дедлайн группы.',dUz:'1-kun — bitiruvchi videosi · 3-kun — o‘quv parchasi · 7-kun — qo‘ng‘iroq · 14-kun — guruh muddati.'},
      {id:'5c',t:'Ежемесячная реактивация старой базы',tUz:'Eski bazani oylik qayta faollashtirish',d:'Рассылка по закрытым лидам с новым оффером. Бесплатный трафик.',dUz:'Yopilgan lidlarga yangi taklif bilan xabar. Bepul trafik.'},
    ]},
  { id:6, section:'sales', name:'Оплата и прибыль', nameUz:'To‘lov va foyda', sub:'Маржа · чистые деньги и рост чека', subUz:'Marja · toza pul va chek o‘sishi', iconName:'trophy',
    boss:'Ключевая цель этапа', bossUz:'Bosqichning asosiy maqsadi', bossDesc:'21% «продаж» — это свои/бартер, они искажают отчётность и мотивацию. Задача — очистить цифры и растить средний чек.', bossDescUz:'«Sotuvlar»ning 21% — o‘zimizniki/barter, ular hisobot va motivatsiyani buzadi. Vazifa — raqamlarni tozalash va o‘rtacha chekni oshirish.',
    reward:'✅ Результат: чистая отчётность и рост среднего чека', rewardUz:'✅ Natija: toza hisobot va o‘rtacha chek o‘sishi',
    quests:[
      {id:'6a',t:'Тег «свои/бартер» — убрать из отчётности',tUz:'«O‘zimizniki/barter» tegi — hisobotdan chiqarish',d:'Внутренние сделки не в конверсию и мотивацию. Дашборды — только по коммерции.',dUz:'Ichki bitimlar konversiya va motivatsiyaga kirmaydi. Dashboardlar — faqat tijorat bo‘yicha.'},
      {id:'6b',t:'Дисциплина скидок через РОПа',tUz:'Chegirma intizomi ROP orqali',d:'Поле «Скидка» + обязательное «Кто одобрил». «Дорого» лишь 4% — скидка это исключение.',dUz:'«Chegirma» maydoni + majburiy «Kim tasdiqladi». «Qimmat» atigi 4% — chegirma bu istisno.'},
      {id:'6c',t:'Рост чека: апсейл Комильона + рассрочка',tUz:'Chek o‘sishi: Komiljon apseli + bo‘lib to‘lash',d:'Его +1млн к чеку разобрать и раздать всем. Halol nasiya закрывает «нет денег сейчас».',dUz:'Uning chekka +1mln qo‘shishini tahlil qilib hammaga tarqating. Halol nasiya «hozir pul yo‘q»ni yopadi.'},
    ]},
];
const RANKS=[[0,'Старт'],[10,'Разгон'],[25,'Движение'],[45,'Ускорение'],[65,'Уверенный рост'],[85,'Почти у цели'],[100,'Цель достигнута']];
const ALL_QUESTS = STAGES.flatMap(s=>s.quests.map(q=>q.id));

function stageDone(s){return s.quests.every(q=>state.done[q.id])}
function stageUnlocked(idx){return true}

export { ICONS, STAGES, RANKS, ALL_QUESTS, svg, stageDone, stageUnlocked }
