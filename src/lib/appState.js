// Состояние основного приложения (админ/РОП/демо) — перенос state/save/loadCloud
// из public/index.html. localStorage-ключ и форматы 1:1. Небольшой subscribe-стор для React.
import { getSession, setRoleOrg } from './session.js'

export const SKEY = 'hunters_path_app_v1'

export function defaultState() {
  return { done: {}, bosses: {}, open: {}, filter: 'all', chats: [{ id: 'c0', title: 'Новый чат', messages: [] }], activeChatId: 'c0', lang: 'ru', dopQuests: [], goal: 250000000, theme: 'theme-light', projects: [] }
}

function loadStateLocal() {
  try { const s = JSON.parse(localStorage.getItem(SKEY)); if (s && s.done) return s } catch (e) { /* ignore */ }
  return defaultState()
}

export let state = loadStateLocal()

const listeners = new Set()
export function subscribeState(fn) { listeners.add(fn); return () => listeners.delete(fn) }
function emit() { listeners.forEach((fn) => fn(state)) }

// сохранение: локально сразу + в облако с задержкой (чтобы не спамить) — 1:1
let saveTimer = null
export function save() {
  try { localStorage.setItem(SKEY, JSON.stringify(state)) } catch (e) { /* ignore */ }
  if (getSession()) {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveCloud, 800)
  }
  emit()
}

export async function saveCloud() {
  if (!getSession()) return
  try {
    await fetch('/api/user-data', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', session: getSession(), data: state }),
    })
  } catch (e) { /* ignore */ }
}

// loadCloud — 1:1: тянет облачное состояние, сохраняет свежую вкладку из localStorage.
export async function loadCloud() {
  if (!getSession()) return false
  try {
    const r = await fetch('/api/user-data', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'load', session: getSession() }),
    })
    const d = await r.json()
    if (d && d.ok) {
      setRoleOrg(d.role || '', d.org || '')
      if (d.data && d.data.done) {
        let localTab = null, localDashTab = null
        try { const ls = JSON.parse(localStorage.getItem(SKEY)); if (ls) { localTab = ls.tab; localDashTab = ls.dashTab } } catch (e) { /* ignore */ }
        state = d.data
        if (localTab) state.tab = localTab
        if (localDashTab) state.dashTab = localDashTab
        save(); return true
      } else {
        state = defaultState()
        if (d.role === 'demo') state.demoFresh = true
        save(); return true
      }
    }
  } catch (e) { /* ignore */ }
  return false
}

// ensureChats — 1:1
export function ensureChats() {
  if (!Array.isArray(state.chats)) {
    state.chats = []
    const old = Array.isArray(state.chat) ? state.chat : []
    state.chats.push({ id: 'c' + Date.now(), title: 'Чат 1', messages: old })
    state.activeChatId = state.chats[0].id
    delete state.chat
    save()
  }
  if (!state.activeChatId || !state.chats.find((c) => c.id === state.activeChatId)) {
    state.activeChatId = state.chats[0] ? state.chats[0].id : null
  }
  if (!state.chats.length) {
    state.chats.push({ id: 'c' + Date.now(), title: 'Чат 1', messages: [] })
    state.activeChatId = state.chats[0].id
  }
}

export function ensureProjects() { if (!Array.isArray(state.projects)) state.projects = [] }
export function activeChat() { ensureChats(); return state.chats.find((c) => c.id === state.activeChatId) }

// getGoal — 1:1 (orgSettings пока не загружаем в backbone → локальная цель/дефолт)
export function getGoal() {
  if (typeof window.orgSettings !== 'undefined' && window.orgSettings && window.orgSettings.goal > 0) return window.orgSettings.goal
  if (state.goal && state.goal > 0) return state.goal
  return 250000000
}

// setLang — переключение языка основного приложения (state.lang)
export function setLang(l) {
  state.lang = l === 'uz' ? 'uz' : 'ru'
  save()
}
