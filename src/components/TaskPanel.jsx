// src/components/TaskPanel.jsx — вкладка «Task Agent» (Агент В) внутри /dev-agent.
// Задачи ОП со сроками, переписка агента с РОПом (дословно), эскалации, подключение ботов.
import React, { useEffect, useState } from 'react'
import { taskAgent } from '../lib/api.js'

const fmtTime = (ts) => { try { return new Date(ts).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch (e) { return '' } }

export default function TaskPanel() {
  const [st, setSt] = useState(null)
  const [bots, setBots] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [openTask, setOpenTask] = useState('')

  async function load() {
    const [d, bs] = await Promise.all([taskAgent.state(), taskAgent.botStatus().catch(() => null)])
    if (d && d.ok) setSt(d)
    if (bs && bs.ok) setBots(bs)
    setLoading(false)
  }
  useEffect(() => { load() }, [])
  function flash(m) { setToast(m); setTimeout(() => setToast(''), 2000) }

  async function tick() { if (busy) return; setBusy('tick'); try { const d = await taskAgent.tick(true); if (d && d.ok) { await load(); flash(`Пингов: ${(d.pinged || []).length} · эскалаций: ${(d.escalated || []).length}`) } else flash((d && d.error) || 'Ошибка') } catch (e) { flash('Нет связи') } setBusy('') }
  async function setupBots() { if (busy) return; setBusy('setup'); try { const d = await taskAgent.botSetup(); await load(); flash(d && d.ok ? 'Webhook’и прописаны' : 'Ошибка настройки') } catch (e) { flash('Нет связи') } setBusy('') }
  async function testBot(who) { setBusy('test'); try { const d = await taskAgent.botTest(who); flash(d && d.ok ? 'Сообщение отправлено' : ((d && d.result && d.result.error) || 'Не отправилось')) } catch (e) { flash('Нет связи') } setBusy('') }
  async function reset() { if (!window.confirm('Сбросить переписку, статусы и эскалации Task-агента?')) return; setBusy('reset'); try { await taskAgent.reset(); await load(); flash('Сброшено') } catch (e) {} setBusy('') }
  function copy(t) { navigator.clipboard.writeText(t); flash('Скопировано') }

  if (loading) return <div className="ga-empty">Загрузка…</div>
  const tasks = (st && st.tasks) || []
  const status = (st && st.status) || {}
  const escalations = (st && st.escalations) || []
  const chat = (st && st.chat) || []
  const people = (st && st.people) || {}
  const cfg = (st && st.config) || {}
  const codes = (bots && bots.codes) || {}
  const botInfo = (bots && bots.bots) || {}

  const openTasks = tasks.filter((t) => !t.done)
  const taskChat = (id) => chat.filter((m) => m.taskId === id)

  return (
    <div className="ga-root">
      <div className="ga-head">
        <div>
          <div className="ga-title">Task Agent <span className="ga-sub">дисциплина задач ОП · диалог с РОПом в Telegram</span></div>
          <div className="ga-lastrun">
            сейчас в Ташкенте {st && st.now ? st.now.tashkentHour : '—'}:00 · порог эскалации {cfg.escalationHour}:00 · открытых задач {openTasks.length}
          </div>
        </div>
        <div className="ga-actions">
          <button className="da-btn" disabled={!!busy} onClick={tick}>{busy === 'tick' ? '…' : 'Прогнать сейчас'}</button>
          <button className="da-btn ghost" disabled={!!busy} onClick={setupBots}>{busy === 'setup' ? '…' : 'Настроить ботов'}</button>
          <button className="da-btn ghost" disabled={!!busy} onClick={reset}>Сбросить</button>
        </div>
      </div>

      <div className="ga-body">
        {/* ПОДКЛЮЧЕНИЕ БОТОВ */}
        <div className="ga-sec-h">Подключение Telegram</div>
        <div className="ga-metrics">
          {['rop', 'owner'].map((who) => {
            const p = people[who]; const bi = botInfo[who] || {}
            return (
              <div key={who} className="ga-metric">
                <b>{who === 'rop' ? 'Бот для РОПа' : 'Бот для владельца'}</b>{' '}
                {!bi.token ? <span style={{ color: 'var(--red)' }}>— нет токена в env</span>
                  : p ? <span style={{ color: 'var(--green)' }}>— подключён: {p.name || p.username || p.chatId}</span>
                    : <span style={{ color: 'var(--gold)' }}>— ждёт привязки</span>}
                <div style={{ fontSize: 12, color: 'var(--txt3)', marginTop: 4, lineHeight: 1.5 }}>
                  {bi.username ? <>бот: <b>@{bi.username}</b><br /></> : null}
                  {bi.url ? <>webhook: ок<br /></> : (bi.token ? <>webhook: не прописан — нажми «Настроить ботов»<br /></> : null)}
                  {!p && codes[who] ? <>код привязки: <code onClick={() => copy(`/start ${codes[who]}`)} style={{ cursor: 'pointer' }}>/start {codes[who]}</code> (кликни — скопируется)</> : null}
                </div>
                {p && <button className="da-mini ok" style={{ marginTop: 8, maxWidth: 160 }} disabled={!!busy} onClick={() => testBot(who)}>Проверить связь</button>}
              </div>
            )
          })}
        </div>

        {/* ЗАДАЧИ ОП */}
        <div className="ga-sec-h">Задачи отдела продаж <span className="da-count">{tasks.length}</span></div>
        {!tasks.length && <div className="ga-empty">План ещё не создан — задач ОП нет. Создай план в разделе «Советник».</div>}
        {tasks.map((t) => {
          const s = status[t.id] || {}
          const overdue = t.hoursOverdue > 0 && !t.done
          const conv = taskChat(t.id)
          return (
            <div key={t.id} className="ga-hyp">
              <div className="ga-hyp-top" style={{ justifyContent: 'space-between' }}>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{t.done ? '✓ ' : ''}{t.title}</span>
                <span style={{ fontSize: 12, color: t.done ? 'var(--green)' : (overdue ? 'var(--red)' : 'var(--txt3)') }}>
                  {t.done ? 'выполнена' : (t.deadline ? (overdue ? `просрочена на ${Math.round(t.hoursOverdue / 24)} дн` : `срок ${t.deadline} · осталось ${t.daysLeft} дн`) : 'без срока')}
                </span>
              </div>
              <div className="ga-hyp-row"><span className="ga-lbl">Статус у агента</span><span>
                {s.state === 'in_progress' ? 'РОП: в процессе' : s.state === 'blocked' ? 'РОП: что-то мешает' : s.state === 'claims_done' ? 'РОП говорит, что сделал' : s.pingDay ? 'написали, ответа нет' : 'ещё не трогали'}
                {s.note ? ` — ${s.note}` : ''}
                {s.escalatedDay ? <b style={{ color: 'var(--red)' }}> · эскалировано</b> : null}
              </span></div>
              {conv.length > 0 && (
                <>
                  <button className="da-mini" style={{ maxWidth: 220, marginTop: 8 }} onClick={() => setOpenTask(openTask === t.id ? '' : t.id)}>
                    {openTask === t.id ? 'Скрыть переписку' : `Переписка с РОПом (${conv.length})`}
                  </button>
                  {openTask === t.id && (
                    <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
                      {conv.map((m) => (
                        <div key={m.id} style={{ marginBottom: 8, fontSize: 13, lineHeight: 1.5 }}>
                          <b style={{ color: m.role === 'rop' ? 'var(--accent)' : 'var(--txt3)' }}>{m.role === 'rop' ? 'РОП' : 'Агент'}</b>
                          <span style={{ color: 'var(--txt3)', fontSize: 11 }}> · {fmtTime(m.at)}</span>
                          <div>{m.text}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}

        {/* ЭСКАЛАЦИИ */}
        <div className="ga-sec-h">Эскалации владельцу <span className="da-count">{escalations.length}</span></div>
        {!escalations.length && <div className="ga-empty">Эскалаций нет — агент справляется сам.</div>}
        {escalations.map((e) => (
          <div key={e.id} className="ga-hyp" style={{ borderLeft: '3px solid var(--red)' }}>
            <div className="ga-hyp-row"><span className="ga-lbl">Задача</span><span><b>{e.title}</b> · срок {e.deadline}</span></div>
            <div className="ga-hyp-row"><span className="ga-lbl">Статус</span><span style={{ color: 'var(--red)' }}>{e.status}</span></div>
            <div className="ga-hyp-row"><span className="ga-lbl">Переписка (дословно)</span><span>
              {(e.conversation || []).length
                ? (e.conversation || []).map((m, i) => <div key={i} style={{ marginBottom: 6 }}><b>{m.role === 'rop' ? 'РОП' : 'Агент'}:</b> {m.text}</div>)
                : <i style={{ color: 'var(--txt3)' }}>переписки не было — РОП не отвечал</i>}
            </span></div>
            <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 6 }}>эскалировано {fmtTime(e.at)}</div>
          </div>
        ))}
      </div>
      {toast && <div className="da-toast">{toast}</div>}
    </div>
  )
}
