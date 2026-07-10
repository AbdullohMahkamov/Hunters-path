import React from 'react'

// Заглушка — полная реализация в Этапе 3.
export default function MopCabinet({ onLogout }) {
  return (
    <div style={{ padding: 24 }}>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 12 }}>Кабинет МОПа</div>
      <div style={{ color: 'var(--txt2)' }}>Загрузка кабинета… (Этап 3)</div>
      <button onClick={onLogout} style={{ marginTop: 16 }}>Выйти</button>
    </div>
  )
}
