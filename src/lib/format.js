// Утилиты форматирования — точный перенос из public/index.html.

// escapeHtml — экранирует и кавычки (для атрибутов/inline-onclick), приводит вход к строке.
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '/': '&#47;', '`': '&#96;' }
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"'/`]/g, (c) => ESC_MAP[c])
}

// jsAttr — безопасная вставка строки как JS-аргумента внутри HTML-атрибута onclick="fn('...')".
// Браузер декодирует атрибут ДО JS-парсинга, поэтому одного HTML-эскейпа мало: сперва
// JS-экранирование (\ и '), затем HTML-экранирование (& < > "). Иначе ' в данных ломает строку/XSS.
export function jsAttr(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// fmtSumM — 1:1 (используется в кабинете МОПа)
export function fmtSumM(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'М'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return String(n || 0)
}
