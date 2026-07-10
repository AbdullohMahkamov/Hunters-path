import React, { useEffect, useState, useSyncExternalStore } from 'react'
import { subscribe, getSnapshot, getSession, setSession, setRoleOrg, clearSession } from './lib/session.js'
import { auth } from './lib/api.js'
import { applyTheme } from './lib/theme.js'
import Login from './screens/Login.jsx'
import MopCabinet from './screens/MopCabinet.jsx'
import AppShell from './screens/AppShell.jsx'

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
  if (phase === 'login') return <Login onLoggedIn={handleLoggedIn} />
  if (phase === 'mop') return <MopCabinet onLogout={handleLogout} />
  return <AppShell onLogout={handleLogout} />
}
