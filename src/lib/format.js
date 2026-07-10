// Утилиты форматирования — точный перенос из public/index.html.

// escapeHtml — 1:1
export function escapeHtml(s) {
  return (s || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

// fmtSumM — 1:1 (используется в кабинете МОПа)
export function fmtSumM(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1).replace('.0', '') + 'М'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return String(n || 0)
}
