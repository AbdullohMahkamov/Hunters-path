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
    hour: 'ч', min: 'мин', noData: 'Данные ещё не загружены. Обратитесь к руководителю.',
    daysLeft: 'Осталось рабочих дней', perDay: 'Продавай по', perDayEnd: 'в день до цели',
    nextBonus: 'До следующего бонуса', bonusProgress: 'выполни', by: 'до', dayShort: 'числа', daysWord: 'дн.',
    raffle: '🎁 Розыгрыш месяца', raffleDesc: 'Закрой план — участвуешь в розыгрыше:', raffleCTA: 'Закрой план на 100% — участвуй в розыгрыше!', rafflePrizeWord: 'Приз', specialPrize: 'Специальный приз 🎉',
    losing: 'Где ты теряешь клиентов', noReach: 'не дозвонился', potentialLost: 'это ~', lostSales: 'потерянных продаж', losingTip: 'Прозвони их — это твои деньги!',
  },
  uz: {
    cabinet: 'Shaxsiy kabinet', logout: 'Chiqish', mine: 'Mening daromadim', stats: 'Mening statistikam', team: 'Jamoa',
    earnings: 'Mening daromadim', sumMonth: 'soʻm bu oyda', fix: 'Fiksa', kpi: 'KPI', ofRevenue: 'tushumdan',
    tempoBonus: 'Sur’at bonuslari', ladder: 'Daromad zinapoyasi', plan: 'reja', rate: 'stavka',
    revenueW: 'tushum', salaryW: 'oylik', toStep: 'Bosqichgacha', sellOn: 'yana sotish kerak',
    rateOpens: 'Ochiladi stavka', willGrow: 'daromad oshadi 🔥', maxStep: '🏆 Siz eng yuqori bosqichdasiz!',
    tempoTitle: 'Sur’at bonuslari (har biri $15)', by10: '10-sanagacha 33%', by20: '20-sanagacha 66%', by30: 'Oy oxirigacha 100%',
    whatToDo: 'Nima qilishing kerak', sellMore: 'Yana sotish', willEarn: 'daromad qilasan',
    closePlan: 'Rejani 100% bajarish', reachStep: 'Chiqish', planWord: 'reja', takeFirst: '1-o’rinni olish (o’tib ket',
    forFirst: '+1 mln 1-o’rin uchun', mySales: 'Mening sotuvlarim (oy)', salesW: 'sotuv', revW: 'tushum',
    myPlan: 'Mening rejam', goal: 'Maqsad', leftToPlan: 'Qoldi', toPlan: 'rejagacha', planDone: 'Reja bajarildi! 🎉',
    myFunnel: 'Mening voronkam', leads: 'lid', reach: 'aloqa', conv: 'konversiya',
    myDiscipline: 'Mening intizomim', firstCall: '1-qo’ng’iroq tezligi', tasks: 'vazifalar bajarildi',
    notFound: 'Sizning maʼlumotlaringiz CRMda topilmadi.', rankTitle: 'Jamoa reytingi', you: '(siz)',
    toLeader: 'Gacha', aboveYou: '(sizdan yuqori)', catchUp: 'Quvib yet!', first: 'Siz jamoada №1! 🏆 Ushlab turing.',
    hour: 's', min: 'daq', noData: 'Maʼlumotlar hali yuklanmagan. Rahbaringizga murojaat qiling.',
    daysLeft: 'Qolgan ish kunlari', perDay: 'Har kuni soting', perDayEnd: 'maqsadgacha',
    nextBonus: 'Keyingi bonusgacha', bonusProgress: 'bajaring', by: 'gacha', dayShort: '-sana', daysWord: 'kun',
    raffle: '🎁 Oylik o’yin', raffleDesc: 'Rejani yoping — o’yinda qatnashasiz:', raffleCTA: 'Rejani 100% yop — o’yinda qatnash!', rafflePrizeWord: 'Sovrin', specialPrize: 'Maxsus sovrin 🎉',
    losing: 'Mijozlarni qayerda yoʻqotyapsan', noReach: 'aloqa boʻlmadi', potentialLost: 'bu ~', lostSales: 'yoʻqotilgan sotuv', losingTip: 'Ularga qoʻngʻiroq qil — bu sening puling!',
  },
}

let _mopLang = localStorage.getItem('mop_lang') || 'ru'
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
