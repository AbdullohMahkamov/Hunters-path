// Темы оформления — точный перенос из public/index.html.
// В текущей версии монолита выбор темы убран: всегда светлая (theme-light).
// Классы тем и палитра сохранены в CSS (global.css) на случай возврата выбора.

export const THEMES = [
  { id: '', c: '#0b1622' },
  { id: 'theme-cream', c: '#f7f4ee' },
  { id: 'theme-light', c: '#ffffff' },
  { id: 'theme-slate', c: '#272c37' },
  { id: 'theme-forest', c: '#1a2f28' },
]

const THEME_CLASSES = ['theme-cream', 'theme-light', 'theme-slate', 'theme-forest']

// applyThemeClass — 1:1: снять все классы тем и всегда поставить theme-light.
export function applyThemeClass() {
  THEME_CLASSES.forEach((t) => document.body.classList.remove(t))
  document.body.classList.add('theme-light')
}

export function applyTheme() { applyThemeClass() }

// setTheme — в оригинале тема принудительно theme-light независимо от выбора.
export function setTheme(/* id */) {
  applyThemeClass()
}
