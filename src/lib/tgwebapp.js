// Telegram Mini App SDK: подгрузка скрипта, вьюпорт, safe-area, хром, кнопка «Назад».
// Загружаем telegram-web-app.js динамически ТОЛЬКО на маршруте /tg — основное веб-приложение не трогаем.
// Вне Telegram window.Telegram.WebApp.initData пустой → это ловим в TgApp и показываем понятное сообщение.

let _sdk = null

export function loadTgSdk() {
  if (typeof window !== 'undefined' && window.Telegram && window.Telegram.WebApp) return Promise.resolve(window.Telegram.WebApp)
  if (_sdk) return _sdk
  _sdk = new Promise((resolve) => {
    const s = document.createElement('script')
    s.src = 'https://telegram.org/js/telegram-web-app.js'
    s.async = true
    s.onload = () => resolve((window.Telegram && window.Telegram.WebApp) || null)
    s.onerror = () => resolve(null)
    document.head.appendChild(s)
  })
  return _sdk
}

const px = (n) => (Number(n) || 0) + 'px'
// FEATURE-DETECT по версии Bot API: старые клиенты не имеют новых методов. Проверяем явно (не полагаемся только
// на try/catch), чтобы не дёргать неподдержанное и не сорить ошибками. Нет метода/версии → просто не вызываем.
const supports = (wa, v) => { try { return !!(wa && wa.isVersionAtLeast && wa.isVersionAtLeast(v)) } catch (e) { return false } }

// Безопасные зоны + СТАБИЛЬНАЯ высота вьюпорта → CSS-переменные. Стабильную (не «прыгающую») высоту берём,
// чтобы поле ввода не скакало при жестах/клавиатуре (главная боль Mini App на iOS).
function applyInsets(wa) {
  const r = document.documentElement.style
  const sa = wa.safeAreaInset || {}
  const ca = wa.contentSafeAreaInset || {}
  r.setProperty('--tg-safe-top', px((sa.top || 0) + (ca.top || 0)))
  r.setProperty('--tg-safe-bottom', px((sa.bottom || 0) + (ca.bottom || 0)))
  r.setProperty('--tg-vh', px(wa.viewportStableHeight || wa.viewportHeight || (typeof window !== 'undefined' ? window.innerHeight : 0)))
}

export function initTgChrome(wa) {
  if (!wa) return
  try { wa.ready() } catch (e) { /* noop */ }        // 5.0 — базовое, есть везде
  try { wa.expand() } catch (e) { /* noop */ }        // 5.0 — на всю доступную высоту
  // Полноэкранный режим (8.0+) — иммерсивно на мобильных; на старых клиентах просто не вызываем (деградация).
  if (supports(wa, '8.0') && wa.requestFullscreen && !wa.isFullscreen) { try { wa.requestFullscreen() } catch (e) { /* noop */ } }
  if (supports(wa, '6.1')) { // цвет шапки/фона — приложение всегда светлое (theme-light)
    try { wa.setHeaderColor('#ffffff') } catch (e) { /* noop */ }
    try { wa.setBackgroundColor('#ffffff') } catch (e) { /* noop */ }
  }
  if (supports(wa, '7.7')) { try { wa.disableVerticalSwipes() } catch (e) { /* noop */ } } // меньше случайных закрытий при скролле
  applyInsets(wa)
  const reapply = () => applyInsets(wa)
  try { wa.onEvent('viewportChanged', reapply) } catch (e) { /* noop */ } // 6.0
  if (supports(wa, '8.0')) { // safe-area события — только новые клиенты; на старых insets = 0 (уже дефолт в applyInsets)
    try { wa.onEvent('safeAreaChanged', reapply) } catch (e) { /* noop */ }
    try { wa.onEvent('contentSafeAreaChanged', reapply) } catch (e) { /* noop */ }
  }
}

// Аппаратная кнопка «Назад» в шапке Telegram (6.1+). На старых клиентах её нет — своя вкладочная навигация остаётся.
export function tgBackButton(wa, show, onClick) {
  if (!wa || !wa.BackButton || !supports(wa, '6.1')) return
  try {
    if (show) { wa.BackButton.onClick(onClick); wa.BackButton.show() }
    else { wa.BackButton.hide(); if (wa.BackButton.offClick) wa.BackButton.offClick(onClick) }
  } catch (e) { /* noop */ }
}
