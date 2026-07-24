// src/components/useRoomMotion.js — «живой офис»: каждый агент ходит между своими точками,
// а когда ему нужно решение человека — выходит к переднему краю (к «двери»), и само перемещение
// сигналит «нужно внимание», не только смена позы.
// Движение — CSS-transition по left/top (в ScenePanel), здесь только РЕШЕНИЕ «куда идти дальше».
import { useEffect, useRef, useState, useCallback } from 'react'
import { ZONES, MOVE_MS } from '../lib/sceneRoom.js'

const ids = Object.keys(ZONES)
const first = () => Object.fromEntries(ids.map((id) => [id, ZONES[id].points[0]]))
const same = (a, b) => a && b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5

export function useRoomMotion(agents) {
  const [pos, setPos] = useState(first)          // текущая цель (CSS анимирует переход к ней)
  const [walking, setWalking] = useState({})     // идёт ли сейчас (для bounce-анимации)
  const [facing, setFacing] = useState({})       // 'left' | 'right' — разворот по направлению
  const curRef = useRef(first())                 // где стоит/идёт (без ре-рендера)
  const waitRef = useRef({})                     // последние waiting-флаги
  const prevWait = useRef({})
  const timers = useRef({})
  const walkTimers = useRef({})
  const reduce = useRef(false)

  // единая функция перемещения — стабильна (только refs + setState), поэтому её можно звать
  // и из планировщика, и из реакции на смену статуса.
  const move = useCallback((id, target) => {
    const cur = curRef.current[id]
    if (same(cur, target)) return
    setFacing((f) => ({ ...f, [id]: target.x < cur.x ? 'left' : 'right' }))
    curRef.current[id] = target
    setPos((p) => ({ ...p, [id]: target }))
    if (reduce.current) return                   // без анимации — просто перескок
    setWalking((w) => ({ ...w, [id]: true }))
    clearTimeout(walkTimers.current[id])
    walkTimers.current[id] = setTimeout(() => setWalking((w) => ({ ...w, [id]: false })), MOVE_MS)
  }, [])

  // держим waiting-флаги свежими; на СМЕНУ статуса реагируем сразу (не ждём таймер планировщика):
  // стал waiting → идёт к attention; перестал → возвращается в рабочую зону.
  useEffect(() => {
    agents.forEach((a) => {
      waitRef.current[a.id] = a.waiting
      if (prevWait.current[a.id] !== a.waiting) {
        prevWait.current[a.id] = a.waiting
        move(a.id, a.waiting ? ZONES[a.id].attention : ZONES[a.id].points[0])
      }
    })
  }, [agents, move])

  // планировщик: каждые 8-15с новая случайная точка в рабочей зоне (если не ждёт решения).
  useEffect(() => {
    reduce.current = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
    function step(id) {
      if (waitRef.current[id]) {
        move(id, ZONES[id].attention)            // ждёт — стоит у переднего края
      } else {
        const pts = ZONES[id].points
        const cur = curRef.current[id]
        const rest = pts.filter((p) => !same(p, cur))
        // разброс без Date/Math в воркфлоу тут не нужен — это обычный рантайм браузера
        move(id, rest.length ? rest[Math.floor(Math.random() * rest.length)] : pts[0])
      }
      const pause = waitRef.current[id] ? 4000 : (8000 + Math.random() * 7000)
      timers.current[id] = setTimeout(() => step(id), (reduce.current ? 0 : MOVE_MS) + pause)
    }
    ids.forEach((id) => { timers.current[id] = setTimeout(() => step(id), 500 + Math.random() * 1800) })
    return () => {
      Object.values(timers.current).forEach(clearTimeout)
      Object.values(walkTimers.current).forEach(clearTimeout)
    }
  }, [move])

  return { pos, walking, facing }
}
