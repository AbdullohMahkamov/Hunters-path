// src/lib/sceneAdapters.js — четыре адаптера, по одному на агента.
// Каждый берёт СВОЙ существующий state() и приводит к общей форме для сцены.
// ВАЖНО: действия карточек ссылаются на ТЕ ЖЕ функции api.js, что и текстовые интерфейсы —
// никакой параллельной логики принятия решений. Сцена — второй способ нажать те же кнопки.
import { devAgent, growthAgent, taskAgent, mopAgent, metaBrain } from './api.js'

// Нормализованный агент:
// { id, name, role, accent, attr, statusLine, waiting, count, pending:[card] }
// card: { id, title, body, meta, actions:[{ label, tone, sub, confirm, exec }] }
//   exec: async () => <api call>   — карточка вызывает и затем обновляет сцену.

const short = (s, n = 220) => { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s }

// ─── DEV-AGENT (А): находки + гипотезы, решение = devAgent.decision ───
const devAdapter = {
  id: 'dev', name: 'Dev-Agent', role: 'проверяет данные', accent: 'var(--accent)', attr: 'magnifier',
  load: async () => {
    const d = await devAgent.state()
    const findings = (d && d.findings) || []
    const hyps = (d && d.hypotheses) || []
    const items = [
      ...findings.map((f) => ({ ...f, _kind: 'finding' })),
      ...hyps.map((h) => ({ ...h, _kind: 'hyp' })),
    ].sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    const pending = items.map((it) => ({
      id: it.id,
      title: (it._kind === 'finding' ? 'Находка' : 'Гипотеза') + ` · ${Math.round((it.confidence || 0) * 100)}%`,
      body: short(it.claim),
      meta: it.reason ? 'почему: ' + short(it.reason, 120) : '',
      actions: [
        // те же три вердикта, что в DevAgent.jsx (decide → devAgent.decision)
        { label: 'Одобрить', tone: 'ok', exec: () => devAgent.decision({ refId: it.id, kind: it._kind, claim: it.claim, verdict: 'approved', note: '' }) },
        { label: 'Исправлено', tone: 'fix', exec: () => devAgent.decision({ refId: it.id, kind: it._kind, claim: it.claim, verdict: 'fixed', note: '' }) },
        { label: 'Отклонить', tone: 'no', confirm: 'Отклонить эту находку?', exec: () => devAgent.decision({ refId: it.id, kind: it._kind, claim: it.claim, verdict: 'rejected', note: '' }) },
      ],
    }))
    return { statusLine: pending.length ? `${pending.length} на решении` : 'проверяет данные', waiting: pending.length > 0, count: pending.length, pending }
  },
}

// ─── GROWTH AGENT (Б): гипотезы роста, решение = growthAgent.markResult ───
const growthAdapter = {
  id: 'growth', name: 'Growth Agent', role: 'ищет гипотезы роста', accent: 'var(--green)', attr: 'chart',
  load: async () => {
    const d = await growthAgent.state()
    const hyps = (d && d.hypotheses) || []
    const pending = hyps.map((h) => ({
      id: h.id,
      title: 'Гипотеза роста' + (h.confidence ? ` · ${h.confidence}` : ''),
      body: short(h.cause || h.observation),
      meta: h.benchmark ? 'ориентир: ' + short(h.benchmark, 120) : (h.howToVerify ? 'проверка: ' + short(h.howToVerify, 120) : ''),
      actions: [
        // те же три исхода, что в GrowthPanel.jsx (mark → growthAgent.markResult)
        { label: 'Сработало', tone: 'ok', exec: () => growthAgent.markResult({ hypId: h.id, result: 'worked', note: '' }) },
        { label: 'Частично', tone: 'fix', exec: () => growthAgent.markResult({ hypId: h.id, result: 'partial', note: '' }) },
        { label: 'Не сработало', tone: 'no', exec: () => growthAgent.markResult({ hypId: h.id, result: 'failed', note: '' }) },
      ],
    }))
    return { statusLine: pending.length ? `${pending.length} гипотез(ы)` : 'ищет гипотезы роста', waiting: pending.length > 0, count: pending.length, pending }
  },
}

// ─── TASK AGENT (В): решение принимает РОП В TELEGRAM, не админ ───
// Поэтому статус на сцене — «ждёт РОПа», а единственное честное действие — «Напомнить РОПу сейчас»
// (taskAgent.tick(true) — тот же экшен, что кнопка «Прогнать сейчас»). Кнопки «подтвердить» здесь НЕТ:
// её не существует в реальности, и рисовать её было бы враньём.
const taskAdapter = {
  id: 'task', name: 'Task Agent', role: 'ждёт РОПа', accent: 'var(--gold)', attr: 'notebook',
  load: async () => {
    const d = await taskAgent.state()
    const tasks = ((d && d.tasks) || []).filter((t) => !t.done)
    const escalations = (d && d.escalations) || []
    const status = (d && d.status) || {}
    const awaiting = tasks.filter((t) => { const s = status[t.id] || {}; return s.pingDay && s.ropRepliedDay !== s.pingDay })
    const waiting = awaiting.length > 0 || escalations.length > 0
    const lines = tasks.slice(0, 6).map((t) => {
      const s = status[t.id] || {}
      const tag = t.source === 'mop-agent' ? (t.scope === 'department' ? '🏢 ' : `👤 `) : ''
      const st = s.escalatedDay ? 'эскалировано' : (s.state === 'in_progress' ? 'в процессе' : (s.pingDay ? 'написали, ответа нет' : 'ещё не трогали'))
      return `${tag}${short(t.title, 60)} — ${st}`
    })
    const pending = waiting ? [{
      id: 'task-summary',
      title: `Ждёт РОПа: ${awaiting.length}${escalations.length ? ` · эскалаций ${escalations.length}` : ''}`,
      body: lines.join('\n'),
      meta: 'Решение по этим задачам РОП принимает в Telegram. Со сцены можно только напомнить.',
      actions: [
        // тот же экшен, что «Прогнать сейчас» в TaskPanel: пингует все задачи, которым пора
        { label: 'Напомнить РОПу сейчас', tone: 'ok', sub: 'отправит пинг в Telegram', exec: () => taskAgent.tick(true) },
      ],
    }] : []
    // счётчик = задачи, реально ждущие ответа РОПа (+ эскалации)
    const count = awaiting.length + escalations.length
    return { statusLine: waiting ? `ждёт РОПа: ${count}` : 'РОП всё разобрал', waiting, count, pending }
  },
}

// ─── MOP AGENT (Г): открытые находки, закрытие = mopAgent.close ───
// Обычный путь закрытия — ответ РОПа в Telegram. Кнопка на сцене закрывает В ОБХОД РОПа,
// поэтому она явно об этом предупреждает и требует подтверждения — чтобы не стать привычкой.
const mopAdapter = {
  id: 'mop', name: 'MOP Agent', role: 'проверяет МОПов', accent: 'var(--purple)', attr: 'headphones',
  load: async () => {
    const d = await mopAgent.state()
    const open = (d && d.open) || []
    const pending = open.map((f) => ({
      id: f.id,
      title: (f.scope === 'department' ? '🏢 По отделу' : `👤 ${f.mop || 'По МОПу'}`) + (f.repeatCount > 1 ? ` · СНОВА ${f.repeatCount}×` : '') + (f.deadlineLabel ? ` · ${f.deadlineLabel}` : ''),
      body: short(f.fact || f.title),
      meta: f.action ? 'предложено: ' + short(f.action, 140) : '',
      actions: [
        // единственный реальный экшен закрытия. ЯВНО помечен как обход обычного пути (ответ РОПа).
        { label: 'Закрыть вручную', tone: 'no', sub: 'минуя РОПа', confirm: 'Закрыть находку В ОБХОД РОПа?\n\nОбычно находка закрывается, когда РОП отвечает в Telegram, что решил её. Ручное закрытие со сцены — исключение, не рутина. Продолжить?', exec: () => mopAgent.close(f.id) },
      ],
    }))
    return { statusLine: open.length ? `${open.length} находок` : 'проверяет МОПов', waiting: open.length > 0, count: open.length, pending }
  },
}

// ─── META-BRAIN (CEO / «общий мозг»): сводные наблюдения над всеми четырьмя.
// Роль — наблюдение и синтез, не операционка. Решение по наблюдениям владелец принимает
// в OWNER-БОТЕ (Telegram), не в вебе — поэтому карточка ИНФОРМАЦИОННАЯ, без кнопок-действий
// (та же честность, что у Task Agent: не рисуем на сцене кнопку, которой в вебе нет).
const ceoAdapter = {
  id: 'ceo', name: 'CEO', role: 'сверяет сигналы агентов', accent: '#e0667a', attr: 'folder',
  load: async () => {
    const d = await metaBrain.state()
    const props = (d && d.proposals) || []
    // «ждёт решения» = предложения в статусе ожидания (pending / поправка / переотправка)
    const pend = props.filter((p) => p && ['pending', 'awaiting_edit', 'edited'].includes(p.status))
    const pending = pend.length ? [{
      id: 'ceo-summary',
      title: `Ждёт вашего решения: ${pend.length}`,
      body: pend.slice(0, 5).map((p) => `${p.contradiction ? '⚠️' : '📌'} ${short(p.title, 70)}`).join('\n'),
      meta: 'Решение по сводным наблюдениям вы принимаете в owner-боте (Подтвердить / Отклонить / Поправить). Сцена — только обзор.',
      actions: [], // намеренно пусто: решение — в Telegram, фейковых кнопок на сцене нет
    }] : []
    return { statusLine: pend.length ? `${pend.length} ждут решения` : 'сверяет сигналы агентов', waiting: pend.length > 0, count: pend.length, pending }
  },
}

// Порядок: 4 операционных агента (2×2) + CEO пятым (центральный коридор, «над» всеми).
export const SCENE_AGENTS = [devAdapter, growthAdapter, taskAdapter, mopAdapter, ceoAdapter]
