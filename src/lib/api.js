// Все обёртки над fetch('/api/...') в одном месте. Форматы запросов/ответов — 1:1
// с монолитом public/index.html. Backend (папка api/) НЕ менялся.
import { getSession, getOrg } from './session.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

async function postJSON(url, body, opts = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
    ...opts,
  })
  return r
}

async function getJSON(url) {
  const r = await fetch(url)
  return r.json()
}

// ===== AUTH =====
export const auth = {
  // Админ по паролю
  admin: (password) => postJSON('/api/auth', { action: 'admin', password }).then((r) => r.json()),
  // РОП по коду
  rop: (code) => postJSON('/api/auth', { action: 'rop', code }).then((r) => r.json()),
  // МОП: логин+пароль
  mop: (login, password) => postJSON('/api/auth', { action: 'mop', login, password }).then((r) => r.json()),
  // Демо по коду
  demo: (code) => postJSON('/api/auth', { action: 'demo', code }).then((r) => r.json()),
  // Клиент (мультитенант): логин+пароль
  client: (login, password) => postJSON('/api/auth', { action: 'client', login, password }).then((r) => r.json()),
  // Проверка существующей сессии
  check: (session) => postJSON('/api/auth', { action: 'check', session }).then((r) => r.json()),
  // Выход
  logout: (session) => postJSON('/api/auth', { action: 'logout', session }).then((r) => r.json()),
}

// ===== MOP CABINET =====
export const mop = {
  // Данные кабинета МОПа
  cabinet: () => getJSON('/api/mop?action=cabinet&session=' + encodeURIComponent(getSession())),
  // Список МОП-аккаунтов (для админа)
  list: () => getJSON('/api/mop?action=list&session=' + encodeURIComponent(getSession())),
  getRaffle: () => getJSON('/api/mop?action=get_raffle&session=' + encodeURIComponent(getSession())),
  create: ({ login, password, mopId, name, mopRole }) =>
    postJSON('/api/mop', { session: getSession(), action: 'create', login, password, mopId, name, mopRole }).then((r) => r.json()),
  delete: (login) =>
    postJSON('/api/mop', { session: getSession(), action: 'delete', login }).then((r) => r.json()),
  setRole: (login, mopRole) =>
    postJSON('/api/mop', { session: getSession(), action: 'set_role', login, mopRole }).then((r) => r.json()),
  setPlan: (mopId, plan) =>
    postJSON('/api/mop', { session: getSession(), action: 'set_plan', mopId, plan }).then((r) => r.json()),
  setRaffle: (prize) =>
    postJSON('/api/mop', { session: getSession(), action: 'set_raffle', prize }).then((r) => r.json()),
  changePassword: (oldPassword, newPassword) =>
    postJSON('/api/mop', { session: getSession(), action: 'change_password', oldPassword, newPassword }).then((r) => r.json()),
}

// ===== GAMIFICATION =====
export const gami = {
  // МОП
  state: () => getJSON('/api/gamification?action=state&session=' + encodeURIComponent(getSession())),
  openCase: () => postJSON('/api/gamification', { session: getSession(), action: 'open_case' }).then((r) => r.json()),
  // АДМИН
  getConfig: () => getJSON('/api/gamification?action=get_config&session=' + encodeURIComponent(getSession())),
  setConfig: (config) => postJSON('/api/gamification', { session: getSession(), action: 'set_config', config }).then((r) => r.json()),
  listInventory: () => getJSON('/api/gamification?action=list_inventory&session=' + encodeURIComponent(getSession())),
  markDelivered: (mopId, itemId) => postJSON('/api/gamification', { session: getSession(), action: 'mark_delivered', mopId, itemId }).then((r) => r.json()),
}

// ===== DEMO ACCOUNTS (admin panel) =====
export const demo = {
  list: () => postJSON('/api/demo', { action: 'list', session: getSession() }).then((r) => r.json()),
  create: () => postJSON('/api/demo', { action: 'create', session: getSession() }).then((r) => r.json()),
  delete: (demoId) => postJSON('/api/demo', { action: 'delete', session: getSession(), demoId }).then((r) => r.json()),
}

// ===== DASHBOARD =====
export const dashboard = {
  get: (body = {}) => postJSON('/api/dashboard', { session: getSession(), ...body }).then((r) => r.json()),
}

// ===== USER-DATA (settings, clients, suspicious deals) =====
export const userData = {
  load: () => postJSON('/api/user-data', { action: 'load', session: getSession() }).then((r) => r.json()),
  save: (data) => postJSON('/api/user-data', { action: 'save', session: getSession(), data }).then((r) => r.json()),
  settingsGet: () => postJSON('/api/user-data', { action: 'settings-get', session: getSession() }).then((r) => r.json()),
  settingsSet: (partial) => postJSON('/api/user-data', { action: 'settings-set', session: getSession(), settings: partial }).then((r) => r.json()),
  clientsList: () => postJSON('/api/user-data', { action: 'clients-list', session: getSession() }).then((r) => r.json()),
  clientDelete: (org) => postJSON('/api/user-data', { action: 'client-delete', session: getSession(), org }).then((r) => r.json()),
  clientProbe: (subdomain, token) => postJSON('/api/user-data', { action: 'client-probe', session: getSession(), subdomain, token }).then((r) => r.json()),
  clientSave: (client) => postJSON('/api/user-data', { action: 'client-save', session: getSession(), client }).then((r) => r.json()),
  suspStatus: () => postJSON('/api/user-data', { action: 'susp-status', session: getSession() }).then((r) => r.json()),
  suspReview: ({ dealId, status, note, deal }) => postJSON('/api/user-data', { action: 'susp-review', session: getSession(), dealId, status, note, deal }).then((r) => r.json()),
}

// ===== FINANCE =====
export const finance = {
  month: (force) => postJSON('/api/finance', { session: getSession(), force: !!force }).then((r) => r.json()),
  list: () => postJSON('/api/finance', { action: 'list', session: getSession() }).then((r) => r.json()),
  year: () => postJSON('/api/finance', { action: 'year', session: getSession() }).then((r) => r.json()),
  compute: (month, force) => postJSON('/api/finance', { month, force: !!force, session: getSession() }).then((r) => r.json()),
  analyze: ({ fin, lang, force }) => postJSON('/api/finance', { action: 'analyze', fin, lang, force: !!force, session: getSession() }).then((r) => r.json()),
}

// ===== TRENDS / ACTIVITY / SYNC / META-ADS =====
export const trends = {
  get: () => getJSON('/api/trends'),
}
export const activity = {
  get: (force) => postJSON('/api/activity', { action: force ? 'refresh' : 'get', org: getOrg() || 'hunter' }).then((r) => r.json()),
}

// ===== AUDIT PLAN =====
export const auditPlan = {
  run: (body) => postJSON('/api/audit-plan', { session: getSession(), ...body }).then((r) => r.json()),
}

// ===== QUESTS =====
export const quests = {
  generate: (body) => postJSON('/api/generate-quests', { session: getSession(), ...body }).then((r) => r.json()),
}

// ===== DEV-AGENT (внутренний ревизор, только админ) =====
export const devAgent = {
  state: () => getJSON('/api/dev-agent?action=state&session=' + encodeURIComponent(getSession())),
  chat: (text) => postJSON('/api/dev-agent', { action: 'chat', session: getSession(), text }).then((r) => r.json()),
  nightly: () => postJSON('/api/dev-agent', { action: 'nightly', session: getSession() }).then((r) => r.json()),
  weeklyReview: () => postJSON('/api/dev-agent', { action: 'weekly_review', session: getSession() }).then((r) => r.json()),
  decision: ({ refId, kind, claim, verdict, note }) => postJSON('/api/dev-agent', { action: 'decision', session: getSession(), refId, kind, claim, verdict, note }).then((r) => r.json()),
  reset: (full) => postJSON('/api/dev-agent', { action: 'reset', session: getSession(), full: !!full }).then((r) => r.json()),
  setConfig: (config) => postJSON('/api/dev-agent', { action: 'set_config', session: getSession(), config }).then((r) => r.json()),
}

// ===== GROWTH AGENT (Агент Б — гипотезы роста, только админ) =====
export const growthAgent = {
  state: () => getJSON('/api/growth-agent?action=state&session=' + encodeURIComponent(getSession())),
  run: () => postJSON('/api/growth-agent', { action: 'run', session: getSession() }).then((r) => r.json()),
  markResult: ({ hypId, result, note }) => postJSON('/api/growth-agent', { action: 'mark_result', session: getSession(), hypId, result, note }).then((r) => r.json()),
  setConfig: (config) => postJSON('/api/growth-agent', { action: 'set_config', session: getSession(), config }).then((r) => r.json()),
  reset: (full) => postJSON('/api/growth-agent', { action: 'reset', session: getSession(), full: !!full }).then((r) => r.json()),
}

// ===== TASK AGENT (Агент В — дисциплина задач ОП, диалог с РОПом в Telegram) =====
export const taskAgent = {
  state: () => getJSON('/api/task-agent?action=state&session=' + encodeURIComponent(getSession())),
  tick: (force) => postJSON('/api/task-agent', { action: 'tick', session: getSession(), force: !!force }).then((r) => r.json()),
  setConfig: (config) => postJSON('/api/task-agent', { action: 'set_config', session: getSession(), config }).then((r) => r.json()),
  reset: () => postJSON('/api/task-agent', { action: 'reset', session: getSession() }).then((r) => r.json()),
  // боты
  botStatus: () => getJSON('/api/tg-bot?action=status&session=' + encodeURIComponent(getSession())),
  botSetup: () => getJSON('/api/tg-bot?action=setup&session=' + encodeURIComponent(getSession())),
  botTest: (who) => postJSON('/api/tg-bot', { action: 'test', session: getSession(), who }).then((r) => r.json()),
}

export { postJSON, getJSON }
