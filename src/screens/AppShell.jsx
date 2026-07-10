import React from 'react'
import { useSession } from '../App.jsx'

// Заглушка основного приложения (админ/РОП/демо) — наполняется в Этапах 4–6.
export default function AppShell({ onLogout }) {
  const sess = useSession()
  return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Hunter AI</div>
      <div style={{ color: 'var(--txt2)' }}>
        Роль: {sess.role || '—'} · org: {sess.org || '—'} (дашборд — Этап 4)
      </div>
      <button onClick={onLogout} style={{ marginTop: 16 }}>Выйти</button>
    </div>
  )
}
