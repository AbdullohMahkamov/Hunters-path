// src/components/AgentSprite.jsx — линейный flat-персонаж (Вариант A: Linear/Notion).
// Единый набор форм на всех четырёх: капсула-тело, круглая голова, тонкий контур акцентом.
// Различие только в атрибуте профессии (лупа/график/блокнот/наушники) и позе.
// Поза считывается без чтения подписи: working — лёгкое покачивание; waiting — стоп + «?».
import React from 'react'

// один предмет-атрибут на агента — рисуется в руке/рядом, тем же тонким контуром
function Attr({ kind, c }) {
  const s = { fill: 'none', stroke: c, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }
  switch (kind) {
    case 'magnifier': // Dev — лупа
      return <g {...s}><circle cx="0" cy="0" r="7" /><line x1="5" y1="5" x2="11" y2="11" /></g>
    case 'chart': // Growth — мини-график (три столбца)
      return <g {...s}><line x1="-8" y1="6" x2="-8" y2="-2" /><line x1="0" y1="6" x2="0" y2="-6" /><line x1="8" y1="6" x2="8" y2="-9" /></g>
    case 'notebook': // Task — блокнот
      return <g {...s}><rect x="-7" y="-9" width="14" height="18" rx="2" /><line x1="-4" y1="-4" x2="4" y2="-4" /><line x1="-4" y1="0" x2="4" y2="0" /><line x1="-4" y1="4" x2="1" y2="4" /></g>
    case 'headphones': // MOP — наушники
      return <g {...s}><path d="M-9 2 A9 9 0 0 1 9 2" /><rect x="-11" y="1" width="5" height="8" rx="2" /><rect x="6" y="1" width="5" height="8" rx="2" /></g>
    default:
      return null
  }
}

export default function AgentSprite({ agent, selected, onClick, walking, facing }) {
  const c = agent.accent
  const waiting = agent.waiting
  const cls = 'sc-sprite'
    + (waiting ? ' waiting' : ' working')
    + (walking ? ' walking' : '')
    + (facing === 'left' ? ' face-left' : '')
    + (selected ? ' selected' : '')
    + (agent.stale ? ' stale' : '')
  return (
    <button className={cls} style={{ '--sc-accent': c }} onClick={onClick} title={agent.name}>
      <div className="sc-figwrap">
        <svg viewBox="0 0 100 116" className="sc-fig" width="96" height="112" aria-hidden="true">
          {/* мягкая тень-подложка */}
          <ellipse cx="50" cy="108" rx="26" ry="5" className="sc-shadow" />
          {/* «?» над головой в состоянии ожидания */}
          {waiting && (
            <g className="sc-qmark">
              <circle cx="50" cy="10" r="9" fill="var(--bg)" stroke={c} strokeWidth="2" />
              <text x="50" y="14" textAnchor="middle" fontSize="12" fontWeight="700" fill={c}>?</text>
            </g>
          )}
          {/* тело-капсула + голова, тонкий контур акцентом, плоская заливка */}
          <g className="sc-body" fill="var(--card2)" stroke={c} strokeWidth="2.2" strokeLinejoin="round">
            <rect x="30" y="52" width="40" height="46" rx="18" />
            <circle cx="50" cy="34" r="15" />
            {/* два глаза-точки — нейтральная «мордочка», не по-детски */}
            <circle cx="45" cy="34" r="1.6" fill={c} stroke="none" />
            <circle cx="55" cy="34" r="1.6" fill={c} stroke="none" />
          </g>
          {/* атрибут профессии — «в руке» сбоку */}
          <g transform="translate(74,70)"><Attr kind={agent.attr} c={c} /></g>
        </svg>
      </div>
      <div className="sc-label">{agent.name}</div>
      <div className="sc-status">{agent.stale ? 'нет связи…' : agent.statusLine}</div>
      {/* счётчик ждущих решений — показываем ЯВНО, если их несколько (не только последнюю) */}
      {agent.count > 0 && <span className="sc-count" style={{ background: c }}>{agent.count}</span>}
    </button>
  )
}
