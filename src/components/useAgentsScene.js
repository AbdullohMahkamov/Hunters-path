// src/components/useAgentsScene.js — единый источник данных сцены.
// Поллит все четыре state() раз в ~5с при открытой вкладке, приводит к общей форме через адаптеры.
// Ошибка одного агента не роняет остальных — у него просто остаётся прошлое состояние + флаг stale.
import { useEffect, useRef, useState, useCallback } from 'react'
import { SCENE_AGENTS } from '../lib/sceneAdapters.js'

const POLL_MS = 5000

export function useAgentsScene(active) {
  const [agents, setAgents] = useState(() => SCENE_AGENTS.map((a) => ({
    id: a.id, name: a.name, role: a.role, accent: a.accent, attr: a.attr,
    statusLine: a.role, waiting: false, count: 0, pending: [], stale: false, loaded: false,
  })))
  const [firstLoad, setFirstLoad] = useState(true)
  const timer = useRef(null)
  const busyRef = useRef(false)

  const refresh = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    try {
      const results = await Promise.all(SCENE_AGENTS.map(async (a) => {
        try { const n = await a.load(); return { id: a.id, ok: true, ...n } }
        catch (e) { return { id: a.id, ok: false } }
      }))
      setAgents((prev) => prev.map((p) => {
        const r = results.find((x) => x.id === p.id)
        if (!r || !r.ok) return { ...p, stale: true } // связь потеряна — держим прошлое, помечаем
        return { ...p, statusLine: r.statusLine, waiting: r.waiting, count: r.count, pending: r.pending, stale: false, loaded: true }
      }))
    } finally { busyRef.current = false; setFirstLoad(false) }
  }, [])

  useEffect(() => {
    if (!active) { if (timer.current) clearInterval(timer.current); timer.current = null; return }
    refresh()
    timer.current = setInterval(refresh, POLL_MS)
    return () => { if (timer.current) clearInterval(timer.current); timer.current = null }
  }, [active, refresh])

  return { agents, firstLoad, refresh }
}
