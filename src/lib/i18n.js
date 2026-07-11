// i18n словарь МОПа — точная копия MOP_T и mt() из public/index.html.
// Ключ языка localStorage('mop_lang'), значения 'ru' | 'uz'.

export const MOP_T = {
  ru: {
    cabinet: 'Личный кабинет', logout: 'Выйти', mine: 'Мой заработок', stats: 'Моя статистика', team: 'Команда',
    earnings: 'Мой заработок', sumMonth: 'сум в этом месяце', fix: 'Фикса', kpi: 'KPI', ofRevenue: 'от выручки',
    tempoBonus: 'Бонусы за темп', ladder: 'Лестница заработка', plan: 'плана', rate: 'ставка',
    revenueW: 'выручка', salaryW: 'зарплата', toStep: 'До ступени', sellOn: 'осталось продать на',
    rateOpens: 'Откроется ставка', willGrow: 'заработок вырастет 🔥', maxStep: '🏆 Ты на максимальной ступени!',
    tempoTitle: 'Бонусы за темп ($15 каждый)', by10: '33% до 10 числа', by20: '66% до 20 числа', by30: '100% до конца месяца',
    whatToDo: 'Что тебе сделать', sellMore: 'Продать ещё на', willEarn: 'заработаешь',
    closePlan: 'Закрыть план на 100%', reachStep: 'Выйти на', planWord: 'плана', takeFirst: 'Забрать 1 место (обойти',
    forFirst: '+1 млн за 1 место', mySales: 'Мои продажи (месяц)', salesW: 'продаж', revW: 'выручка',
    myPlan: 'Мой план', goal: 'Цель', leftToPlan: 'Осталось', toPlan: 'до плана', planDone: 'План выполнен! 🎉',
    myFunnel: 'Моя воронка', leads: 'лидов', reach: 'дозвон', conv: 'конверсия',
    myDiscipline: 'Моя дисциплина', firstCall: 'скорость 1-го звонка', tasks: 'задачи выполнены',
    notFound: 'Ваши данные не найдены в CRM.', rankTitle: 'Рейтинг команды', you: '(вы)',
    toLeader: 'До', aboveYou: '(выше вас)', catchUp: 'Догоняй!', first: 'Вы №1 в команде! 🏆 Держите планку.',
    hour: 'час', min: 'мин', noData: 'Данные ещё не загружены. Обратитесь к руководителю.',
    daysLeft: 'Осталось рабочих дней', perDay: 'Продавай по', perDayEnd: 'в день до цели',
    nextBonus: 'До следующего бонуса', bonusProgress: 'выполни', by: 'до', dayShort: 'числа', daysWord: 'дн.',
    raffle: '🎁 Розыгрыш месяца', raffleDesc: 'Закрой план — участвуешь в розыгрыше:', raffleCTA: 'Закрой план на 100% — участвуй в розыгрыше!', rafflePrizeWord: 'Приз', specialPrize: 'Специальный приз 🎉',
    losing: 'Где ты теряешь клиентов', noReach: 'не дозвонился', potentialLost: 'это ~', lostSales: 'потерянных продаж', losingTip: 'Прозвони их — это твои деньги!',
    ewTitle: 'Как ты зарабатываешь и сколько можешь ещё', ewNow: 'Сейчас за месяц', ewCeiling: 'Потолок месяца', ewCeilingNote: 'при 100% плана и 1 месте',
    ewSources: 'Источники дохода', ewGuaranteed: 'платится всегда', ewKpiUpTo: 'ставка растёт до', ewAtPlan100: 'при 100% плана',
    ewTempoEach: 'по $15 каждый', ewCanMore: 'можно ещё', ewTop: 'Топ команды', ewTopGet: 'ты получаешь', ewTopBecome: 'поднимись в топ — заберёшь бонус',
    ewTopVals: '1 место +1 млн · 2 место +500к', ewRaffleNote: 'закрой план на 100% — участвуешь в розыгрыше',
    tmTotals: 'Итоги команды', tmConvAvg: 'ср. конверсия', tmBest: 'Кто в чём лучший', tmAvgCheck: 'ср. чек',
    tmYourPlaces: 'Ваши места по метрикам', tmTasks: 'задачи', tmNorms: 'Нормы',
    planTips: 'Топ-5 советов, чтобы закрыть план', pcs: 'шт',
    today: 'Сегодня', noSalesToday: 'сегодня продаж пока нет',
    changePass: 'Сменить пароль', curPass: 'Текущий пароль', newPass: 'Новый пароль', repeatPass: 'Повторите новый пароль',
    save: 'Сохранить', cancel: 'Отмена', passChanged: 'Пароль изменён', passMismatch: 'Пароли не совпадают', passTooShort: 'Минимум 4 символа',
    progress: 'Прогресс', gLevel: 'Уровень', gPts: 'балл.', gYourPts: 'Ваши баллы', gToNext: 'До уровня', gMonthProg: 'Прогресс месяца',
    gMap: 'Карта уровней', gNorm: 'норма', gCase: 'Кейс дня', gOpen: 'Открыть кейс', gNotEnough: 'Недостаточно баллов', gInv: 'Инвентарь',
    gPending: 'Ожидает выдачи', gDelivered: 'Выдано', gOff: 'Геймификация выключена', gWon: 'Вам выпало', gTake: 'Забрать',
    gLocked: 'Уровень в этом месяце уже взят — так держать!', gNewbie: 'Новичок', gEmptyInv: 'Пока ничего не выиграно', gPrize: 'Приз',
    gMet: 'нормативов выполнено', gReach: 'Дозвон', gConv: 'Конверсия', gTasks: 'Задачи', gCall: '1-й звонок', gPlan: 'План',
    gMax: 'Максимальный уровень!', gEarnedMonth: 'начислено за месяц', gHowEarn: 'Как копить баллы', gLevelUp: 'Новый уровень!',
    gRuleReach: 'за каждый дозвон', gRuleFast: 'за 1-й звонок < 15 мин', gRuleTask: 'за выполненную задачу', gRuleDay: 'за день без просрочек',
    gReward: 'Награда за уровень', gCasePool: 'Что внутри', gChance: 'шанс', gLiveDrops: 'Живые дропы', gOpenNow: 'Крутить кейс',
  },
  uz: {
    cabinet: 'Shaxsiy kabinet', logout: 'Chiqish', mine: 'Mening daromadim', stats: 'Mening statistikam', team: 'Jamoa',
    earnings: 'Mening daromadim', sumMonth: 'soʻm bu oyda', fix: 'Fiksa', kpi: 'KPI', ofRevenue: 'tushumdan',
    tempoBonus: 'Sur’at bonuslari', ladder: 'Daromad zinapoyasi', plan: 'reja', rate: 'stavka',
    revenueW: 'tushum', salaryW: 'oylik', toStep: 'Bosqichgacha', sellOn: 'yana sotishingiz kerak',
    rateOpens: 'Stavka ochiladi', willGrow: 'daromad oshadi 🔥', maxStep: '🏆 Siz eng yuqori bosqichdasiz!',
    tempoTitle: 'Sur’at bonuslari (har biri $15)', by10: '10-sanagacha 33%', by20: '20-sanagacha 66%', by30: 'Oy oxirigacha 100%',
    whatToDo: 'Sizga nima qilish kerak', sellMore: 'Yana soting', willEarn: 'daromad qilasiz',
    closePlan: 'Rejani 100% bajarish', reachStep: 'Chiqish', planWord: 'reja', takeFirst: '1-oʻrinni olish (oʻzib keting',
    forFirst: '+1 mln 1-o’rin uchun', mySales: 'Mening sotuvlarim (oy)', salesW: 'sotuv', revW: 'tushum',
    myPlan: 'Mening rejam', goal: 'Maqsad', leftToPlan: 'Qoldi', toPlan: 'rejagacha', planDone: 'Reja bajarildi! 🎉',
    myFunnel: 'Mening voronkam', leads: 'lid', reach: 'aloqa', conv: 'konversiya',
    myDiscipline: 'Mening intizomim', firstCall: '1-qo’ng’iroq tezligi', tasks: 'vazifalar bajarildi',
    notFound: 'Sizning maʼlumotlaringiz CRMda topilmadi.', rankTitle: 'Jamoa reytingi', you: '(Siz)',
    toLeader: 'Gacha', aboveYou: '(Sizdan yuqori)', catchUp: 'Quvib yeting!', first: 'Siz jamoada №1! 🏆 Shu darajani ushlab turing.',
    hour: 'soat', min: 'daq', noData: 'Maʼlumotlar hali yuklanmagan. Rahbaringizga murojaat qiling.',
    daysLeft: 'Qolgan ish kunlari', perDay: 'Har kuni soting', perDayEnd: 'maqsadgacha',
    nextBonus: 'Keyingi bonusgacha', bonusProgress: 'bajaring', by: 'gacha', dayShort: '-sana', daysWord: 'kun',
    raffle: '🎁 Oylik o’yin', raffleDesc: 'Rejani yoping — o’yinda qatnashasiz:', raffleCTA: 'Rejani 100% yoping — oʻyinda qatnashing!', rafflePrizeWord: 'Sovrin', specialPrize: 'Maxsus sovrin 🎉',
    losing: 'Mijozlarni qayerda yoʻqotyapsiz', noReach: 'aloqa boʻlmadi', potentialLost: 'bu ~', lostSales: 'yoʻqotilgan sotuv', losingTip: 'Ularga qoʻngʻiroq qiling — bu Sizning pulingiz!',
    ewTitle: 'Qanday va qancha koʻproq ishlab olishingiz mumkin', ewNow: 'Bu oyda hozir', ewCeiling: 'Oy shifti', ewCeilingNote: '100% reja va 1-oʻrinda',
    ewSources: 'Daromad manbalari', ewGuaranteed: 'har doim toʻlanadi', ewKpiUpTo: 'stavka oshadi:', ewAtPlan100: '100% rejada',
    ewTempoEach: 'har biri $15', ewCanMore: 'yana olish mumkin', ewTop: 'Jamoa topi', ewTopGet: 'Siz olasiz', ewTopBecome: 'topga koʻtariling — bonusni oling',
    ewTopVals: '1-oʻrin +1 mln · 2-oʻrin +500k', ewRaffleNote: 'rejani 100% yoping — oʻyinda qatnashing',
    tmTotals: 'Jamoa natijalari', tmConvAvg: 'oʻrt. konversiya', tmBest: 'Kim nimada zoʻr', tmAvgCheck: 'oʻrt. chek',
    tmYourPlaces: 'Metrikalar boʻyicha oʻringiz', tmTasks: 'vazifalar', tmNorms: 'Normalar',
    planTips: 'Rejani yopish uchun 5 ta maslahat', pcs: 'ta',
    today: 'Bugun', noSalesToday: 'bugun hali sotuv yoʻq',
    changePass: 'Parolni almashtirish', curPass: 'Joriy parol', newPass: 'Yangi parol', repeatPass: 'Yangi parolni takrorlang',
    save: 'Saqlash', cancel: 'Bekor qilish', passChanged: 'Parol oʻzgartirildi', passMismatch: 'Parollar mos kelmadi', passTooShort: 'Kamida 4 ta belgi',
    progress: 'Progress', gLevel: 'Daraja', gPts: 'ball', gYourPts: 'Ballaringiz', gToNext: 'Darajagacha', gMonthProg: 'Oy progressi',
    gMap: 'Darajalar xaritasi', gNorm: 'norma', gCase: 'Kun keysi', gOpen: 'Keysni ochish', gNotEnough: 'Ball yetarli emas', gInv: 'Inventar',
    gPending: 'Berish kutilmoqda', gDelivered: 'Berildi', gOff: 'Geymifikatsiya oʻchirilgan', gWon: 'Sizga tushdi', gTake: 'Olish',
    gLocked: 'Bu oy daraja allaqachon olindi — shunday davom eting!', gNewbie: 'Yangi', gEmptyInv: 'Hozircha hech narsa yutilmagan', gPrize: 'Sovrin',
    gMet: 'ta normativ bajarildi', gReach: 'Aloqa', gConv: 'Konversiya', gTasks: 'Vazifalar', gCall: '1-qoʻngʻiroq', gPlan: 'Reja',
    gMax: 'Eng yuqori daraja!', gEarnedMonth: 'shu oyda hisoblandi', gHowEarn: 'Ball qanday yigʻiladi', gLevelUp: 'Yangi daraja!',
    gRuleReach: 'har bir aloqa uchun', gRuleFast: '1-qoʻngʻiroq < 15 daq uchun', gRuleTask: 'bajarilgan vazifa uchun', gRuleDay: 'kechikishsiz kun uchun',
    gReward: 'Daraja sovrini', gCasePool: 'Ichida nima bor', gChance: 'ehtimol', gLiveDrops: 'Jonli droplar', gOpenNow: 'Keysni aylantirish',
  },
}

let _mopLang = localStorage.getItem('mop_lang') || 'uz'
const listeners = new Set()

export function getMopLang() { return _mopLang }
export function subscribeMopLang(fn) { listeners.add(fn); return () => listeners.delete(fn) }

export function mt(k) { return (MOP_T[_mopLang] && MOP_T[_mopLang][k]) || MOP_T.ru[k] || k }

export function toggleMopLang() {
  _mopLang = _mopLang === 'ru' ? 'uz' : 'ru'
  localStorage.setItem('mop_lang', _mopLang)
  listeners.forEach((fn) => fn(_mopLang))
  return _mopLang
}

export function setMopLang(lang) {
  _mopLang = lang === 'uz' ? 'uz' : 'ru'
  localStorage.setItem('mop_lang', _mopLang)
  listeners.forEach((fn) => fn(_mopLang))
}
