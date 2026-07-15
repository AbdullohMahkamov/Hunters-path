import React from 'react'
import { createRoot } from 'react-dom/client'
import './styles/global.css'
import App from './App.jsx'
import { setSession } from './lib/session.js'

// DEV-ONLY: сессия из ?session=… для локальной сверки (headless-скриншот). В прод-сборке вырезается
// (import.meta.env.DEV === false → мёртвый код). НЕ влияет на прод.
if (import.meta.env.DEV) { try { const p = new URLSearchParams(location.search).get('session'); if (p) setSession(p) } catch (e) { /* ignore */ } }

createRoot(document.getElementById('root')).render(<App />)
