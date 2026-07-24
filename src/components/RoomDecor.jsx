// src/components/RoomDecor.jsx — плоская линейная «мебель» зон: стол, архив данных, окно с
// графиком, стол задач, пульт мониторинга. Та же тонкая манера, что и персонажи — не пиксель-арт.
// Каждая деталь стоит «ногами» в своей точке (translate(-50%,-100%)), позади персонажей.
import React from 'react'
import { DECOR } from '../lib/sceneRoom.js'

const stroke = (c) => ({ fill: 'none', stroke: c, strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', opacity: 0.55 })

// маленькие SVG деталей (свой натуральный аспект, без искажения)
function Desk({ c }) {
  return <svg width="86" height="44" viewBox="0 0 86 44"><g {...stroke(c)}><line x1="6" y1="14" x2="80" y2="14" /><line x1="12" y1="14" x2="12" y2="40" /><line x1="74" y1="14" x2="74" y2="40" /><rect x="30" y="4" width="20" height="10" rx="1.5" /></g></svg>
}
function Archive({ c }) { // полка с «данными» (папки-вертикали)
  return <svg width="72" height="70" viewBox="0 0 72 70"><g {...stroke(c)}><rect x="8" y="6" width="56" height="58" rx="2" /><line x1="8" y1="25" x2="64" y2="25" /><line x1="8" y1="44" x2="64" y2="44" /><line x1="16" y1="10" x2="16" y2="21" /><line x1="22" y1="10" x2="22" y2="21" /><line x1="28" y1="12" x2="28" y2="21" /><line x1="16" y1="29" x2="16" y2="40" /><line x1="22" y1="29" x2="22" y2="40" /></g></svg>
}
function Window({ c }) { // окно с растущим графиком
  return <svg width="76" height="64" viewBox="0 0 76 64"><g {...stroke(c)}><rect x="8" y="6" width="60" height="46" rx="2" /><polyline points="16,42 30,34 42,38 60,16" /><circle cx="60" cy="16" r="2.4" style={{ fill: c, opacity: 0.7, stroke: 'none' }} /></g></svg>
}
function TaskBoard({ c }) { // стол с доской задач (чек-строки)
  return <svg width="86" height="60" viewBox="0 0 86 60"><g {...stroke(c)}><line x1="8" y1="52" x2="78" y2="52" /><line x1="16" y1="52" x2="16" y2="34" /><line x1="70" y1="52" x2="70" y2="34" /><rect x="24" y="4" width="38" height="30" rx="2" /><line x1="30" y1="14" x2="56" y2="14" /><line x1="30" y1="21" x2="56" y2="21" /><line x1="30" y1="28" x2="48" y2="28" /></g></svg>
}
function Console({ c }) { // пульт мониторинга — монитор с волной
  return <svg width="84" height="64" viewBox="0 0 84 64"><g {...stroke(c)}><rect x="12" y="6" width="60" height="38" rx="2" /><polyline points="18,30 26,30 30,20 36,36 42,26 48,30 66,30" /><line x1="42" y1="44" x2="42" y2="52" /><line x1="30" y1="54" x2="54" y2="54" /></g></svg>
}

function Piece({ at, children }) {
  return <div className="sc-decor" style={{ left: at.x + '%', top: at.y + '%' }}>{children}</div>
}
function Label({ at, c }) {
  return <div className="sc-zone-label" style={{ left: at.x + '%', top: at.y + '%', color: c }}>{at.t}</div>
}

export default function RoomDecor() {
  const A = 'var(--accent)', G = 'var(--green)', T = 'var(--gold)', M = 'var(--purple)'
  return (
    <div className="sc-decor-layer" aria-hidden="true">
      {/* линия пола — общая опора, чтобы фигуры «стояли», а не висели */}
      <div className="sc-floor" />
      <Piece at={DECOR.dev.desk}><Desk c={A} /></Piece>
      <Piece at={DECOR.dev.archive}><Archive c={A} /></Piece>
      <Label at={DECOR.dev.label} c={A} />
      <Piece at={DECOR.growth.desk}><Desk c={G} /></Piece>
      <Piece at={DECOR.growth.window}><Window c={G} /></Piece>
      <Label at={DECOR.growth.label} c={G} />
      <Piece at={DECOR.task.desk}><TaskBoard c={T} /></Piece>
      <Label at={DECOR.task.label} c={T} />
      <Piece at={DECOR.mop.console}><Console c={M} /></Piece>
      <Label at={DECOR.mop.label} c={M} />
    </div>
  )
}
