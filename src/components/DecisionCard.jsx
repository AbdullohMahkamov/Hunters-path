// src/components/DecisionCard.jsx — карточка «что нашёл / что предлагает» + кнопки решения.
// Кнопки вызывают exec() адаптера — а это ТЕ ЖЕ функции api.js, что и в текстовом интерфейсе.
// Никакой отдельной логики решения: карточка только исполняет и просит обновить сцену.
import React, { useState } from 'react'

export default function DecisionCard({ card, onDone }) {
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')

  async function run(a) {
    if (busy) return
    if (a.confirm && !window.confirm(a.confirm)) return
    setBusy(a.label); setErr('')
    try {
      const r = await a.exec()
      // api.js возвращает уже распарсенный json; если пришёл {ok:false} — покажем
      if (r && r.ok === false) { setErr(r.error || 'Не выполнено'); setBusy(''); return }
      await onDone() // перечитать сцену — карточка исчезнет, если решение принято
    } catch (e) { setErr('Нет связи') }
    setBusy('')
  }

  return (
    <div className="sc-card">
      <div className="sc-card-title">{card.title}</div>
      {card.body && <div className="sc-card-body">{card.body}</div>}
      {card.meta && <div className="sc-card-meta">{card.meta}</div>}
      <div className="sc-card-actions">
        {card.actions.map((a) => (
          <div key={a.label} className="sc-act-wrap">
            <button className={'sc-act ' + (a.tone || '')} disabled={!!busy} onClick={() => run(a)}>
              {busy === a.label ? '…' : a.label}
            </button>
            {a.sub && <span className="sc-act-sub">{a.sub}</span>}
          </div>
        ))}
      </div>
      {err && <div className="sc-card-err">{err}</div>}
    </div>
  )
}
