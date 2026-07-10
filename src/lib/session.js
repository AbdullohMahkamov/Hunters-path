// Управление сессией — точный перенос глобалей SESSION/USER_ROLE/USER_ORG из монолита.
// localStorage('hp_session') — как в оригинале. Небольшой subscribe-стор, чтобы React
// перерисовывался при входе/выходе, но формат данных и ключи не меняются.

const KEY = 'hp_session'

const store = {
  session: localStorage.getItem(KEY) || '',
  role: '',
  org: '',
  mopId: undefined,
  mopName: undefined,
  demoName: undefined,
  clientName: undefined,
}

const listeners = new Set()
function emit() { listeners.forEach((fn) => fn(getSnapshot())) }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
export function getSnapshot() { return { ...store } }

export function getSession() { return store.session }
export function getRole() { return store.role }
export function getOrg() { return store.org }

// orgQ(sep) — 1:1 из index.html: для org='hunter' пусто, иначе '?org=...' или sep+'org=...'
export function orgQ(sep) {
  const o = store.org || 'hunter'
  return o === 'hunter' ? '' : ((sep || '?') + 'org=' + encodeURIComponent(o))
}

// Записать успешный вход. info — тело ответа /api/auth (role, org, mopId, mopName, demoName, clientName).
export function setSession(session, info = {}) {
  store.session = session
  localStorage.setItem(KEY, session)
  store.role = info.role || ''
  store.org = info.org || ''
  store.mopId = info.mopId
  store.mopName = info.mopName
  store.demoName = info.demoName
  store.clientName = info.clientName
  emit()
}

// Обновить только роль/org (после /api/auth action=check или user-data load).
export function setRoleOrg(role, org, extra = {}) {
  store.role = role || ''
  store.org = org || ''
  if ('mopId' in extra) store.mopId = extra.mopId
  if ('mopName' in extra) store.mopName = extra.mopName
  emit()
}

export function clearSession() {
  store.session = ''
  store.role = ''
  store.org = ''
  store.mopId = undefined
  store.mopName = undefined
  store.demoName = undefined
  store.clientName = undefined
  localStorage.removeItem(KEY)
  emit()
}
