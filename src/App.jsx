import React, { useEffect, useState, useSyncExternalStore, lazy, Suspense } from 'react'
import { subscribe, getSnapshot, getSession, setSession, setRoleOrg, clearSession } from './lib/session.js'
import { auth } from './lib/api.js'
import { applyTheme } from './lib/theme.js'
import Login from './screens/Login.jsx'
// Ленивые экраны по ролям: за сессию виден ровно один путь — грузим только нужный чанк.
// МОП не тянет админку/дашборд (~215KB), админ/РОП не тянет кабинет МОПа (~85KB).
const MopCabinet = lazy(() => import('./screens/MopCabinet.jsx'))
const AppShell = lazy(() => import('./screens/AppShell.jsx'))
const DevAgent = lazy(() => import('./screens/DevAgent.jsx'))

// Отдельный внутренний маршрут /dev-agent (только админ). nginx на VPS отдаёт index.html (SPA-fallback).
function isDevAgentRoute() {
  try { return window.location.pathname.replace(/\/+$/, '') === '/dev-agent' } catch (e) { return false }
}

// Хук на сессию (реактивный).
export function useSession() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export default function App() {
  const sess = useSession()
  // phase: 'loading' | 'login' | 'mop' | 'app'
  const [phase, setPhase] = useState('loading')

  useEffect(() => {
    applyTheme()
    let cancelled = false
    ;(async function initAuth() {
      const s = getSession()
      if (s) {
        try {
          const d = await auth.check(s)
          if (!cancelled && d && d.ok) {
            setRoleOrg(d.role || '', d.org || '', { mopId: d.mopId, mopName: d.mopName })
            setPhase(d.role === 'mop' ? 'mop' : 'app')
            return
          }
        } catch (e) { /* сессия невалидна */ }
        if (!cancelled) clearSession()
      }
      if (!cancelled) setPhase('login')
    })()
    return () => { cancelled = true }
  }, [])

  // Вход выполнен — маршрутизация по роли.
  function handleLoggedIn(info) {
    setPhase(info.role === 'mop' ? 'mop' : 'app')
  }

  async function handleLogout() {
    try { await auth.logout(getSession()) } catch (e) { /* ignore */ }
    clearSession()
    setPhase('login')
  }

  if (phase === 'loading') return null
  if (phase === 'login') {
    // на /dev-agent без входа — сначала логин, после входа останемся на этом маршруте
    return <Login onLoggedIn={handleLoggedIn} />
  }
  // Внутренний маршрут /dev-agent — только для админа. Иначе уводим на главную.
  if (isDevAgentRoute()) {
    if (sess.role === 'admin') {
      return (
        <Suspense fallback={null}>
          <DevAgent onLogout={handleLogout} />
        </Suspense>
      )
    }
    try { window.history.replaceState(null, '', '/') } catch (e) { /* ignore */ }
  }
  return (
    <Suspense fallback={null}>
      {phase === 'mop' ? <MopCabinet onLogout={handleLogout} /> : <AppShell onLogout={handleLogout} />}
    </Suspense>
  )
}
