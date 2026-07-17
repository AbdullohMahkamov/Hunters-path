// src/components/TaskPanel.jsx — вкладка «Task Agent» (Агент В) внутри /dev-agent.
// Задачи ОП со сроками, переписка агента с РОПом (дословно), эскалации, подключение ботов.
import React, { useEffect, useState } from 'react'
import { taskAgent, mopAgent } from '../lib/api.js'

const fmtTime = (ts) => { try { return new Date(ts).toLocaleString('ru', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) } catch (e) { return '' } }

// Задачи РОПа приходят ДВУМЯ потоками в одном списке: план Hunter AI и находки MOP Agent (Агент Г).
// Бейдж отличает «наладить процесс в отделе» от «поговори с конкретным человеком».
function ScopeBadge({ t }) {
  if (t.source !== 'mop-agent') return null
  const dept = t.scope === 'department'
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 6, whiteSpace: 'nowrap',
      color: dept ? 'var(--gold)' : 'var(--accent)', background: dept ? 'var(--gold-bg)' : 'var(--card2)',
    }}>
      {dept ? '🏢 по отделу' : `👤 ${t.mop || 'по МОПу'}`}
    </span>
  )
}
// Срок находки может быть часовым («до конца дня») — показываем label, а не только дату.
function deadlineText(t) {
  if (t.done) return 'выполнена'
  if (t.hoursOverdue > 0) {
    const h = Math.round(t.hoursOverdue)
    return h < 48 ? `просрочена на ${h} ч` : `просрочена на ${Math.round(h / 24)} дн`
  }
  if (t.deadlineLabel) return `срок: ${t.deadlineLabel}`
  if (t.deadline) return `срок ${t.deadline} · осталось ${t.daysLeft} дн`
  return 'без срока'
}

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
  async function resolveDispute(taskId, decision) { setBusy('disp' + taskId); try { const r = await taskAgent.resolveDispute(taskId, decision); if (r && r.ok) { await load(); flash('Решение по спору принято') } else flash((r && r.error) || 'Ошибка') } catch (e) { flash('Нет связи') } setBusy('') }
  // Прогон Агента Г вручную: пересобрать находки по МОПам (в проде это делает cron каждый час в :30)
  async function scanMops() {
    if (busy) return; setBusy('mop')
    try {
      const d = await mopAgent.run()
      if (d && d.ok) { await load(); flash(`Находок: ${d.open} · новых ${d.added} · авто-закрыто ${d.autoClosed}`) }
      else flash((d && d.error) || 'Ошибка')
    } catch (e) { flash('Нет связи') }
    setBusy('')
  }
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
  const mop = st && st.mopAgent
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
          <button className="da-btn ghost" disabled={!!busy} onClick={scanMops}>{busy === 'mop' ? '…' : 'Проверить МОПов'}</button>
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

        {/* НАХОДКИ MOP AGENT — что агент проверил и по чему промолчал */}
        {mop && (
          <div className="ga-metric" style={{ marginBottom: 14 }}>
            <b>MOP Agent (Агент Г)</b> <span style={{ color: 'var(--txt3)', fontSize: 12 }}>· прогон {fmtTime(mop.at)}</span>
            <div style={{ fontSize: 12, color: 'var(--txt3)', marginTop: 4, lineHeight: 1.6 }}>
              находок открыто: {mop.open} (по отделу {mop.department} · по МОПам {mop.mop})
              {mop.autoClosed > 0 ? ` · авто-закрыто в этот прогон: ${mop.autoClosed}` : ''}
              {(mop.skipped || []).map((s, i) => (
                <div key={i} style={{ color: 'var(--gold)', marginTop: 3 }}>🔇 молчит — {s}</div>
              ))}
            </div>
          </div>
        )}

        {/* ЗАДАЧИ ОП — единый поток: план + находки MOP Agent */}
        <div className="ga-sec-h">Задачи отдела продаж <span className="da-count">{tasks.length}</span></div>
        {!tasks.length && <div className="ga-empty">План ещё не создан — задач ОП нет. Создай план в разделе «Советник».</div>}
        {tasks.map((t) => {
          const s = status[t.id] || {}
          const overdue = t.hoursOverdue > 0 && !t.done
          const conv = taskChat(t.id)
          const isMop = t.source === 'mop-agent'
          return (
            <div key={t.id} className="ga-hyp" style={isMop ? { borderLeft: `3px solid ${t.scope === 'department' ? 'var(--gold)' : 'var(--accent)'}` } : undefined}>
              <div className="ga-hyp-top" style={{ justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <ScopeBadge t={t} />
                  {t.repeatCount > 1 && (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 6, color: 'var(--red)', background: 'var(--card2)' }}
                      title="РОП отчитывался, что закрыл — но проблема вернулась в данные">
                      ↻ снова, {t.repeatCount}-й раз
                    </span>
                  )}
                  {t.done ? '✓ ' : ''}{t.title}
                </span>
                <span style={{ fontSize: 12, whiteSpace: 'nowrap', color: t.done ? 'var(--green)' : (overdue ? 'var(--red)' : 'var(--txt3)') }}>
                  {deadlineText(t)}
                </span>
              </div>
              {isMop && t.why && <div className="ga-hyp-row"><span className="ga-lbl">Факт</span><span>{t.why}</span></div>}
              {isMop && (t.steps || [])[0] && <div className="ga-hyp-row"><span className="ga-lbl">Предлагаемое действие</span><span>{t.steps[0]}</span></div>}
              <div className="ga-hyp-row"><span className="ga-lbl">Статус у агента</span><span>
                {s.state === 'in_progress' ? 'РОП: в процессе' : s.state === 'blocked' ? 'РОП: что-то мешает' : s.state === 'claims_done' ? 'РОП говорит, что сделал' : s.pingDay ? 'написали, ответа нет' : 'ещё не трогали'}
                {s.note ? ` — ${s.note}` : ''}
                {s.escalatedDay ? <b style={{ color: 'var(--red)' }}> · эскалировано</b> : null}
              </span></div>
              {s.dispute && (
                <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'var(--card2)', borderLeft: '3px solid var(--gold)' }}>
                  <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
                    ⚖️ Оспорено РОПом
                    {s.dispute.resolvedByOwner ? ` · решение: ${s.dispute.resolvedByOwner === 'agent' ? 'прав агент' : s.dispute.resolvedByOwner === 'rop' ? 'прав РОП' : 'учтено, оставлено'}` : ''}
                  </div>
                  <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 5 }}><b style={{ color: 'var(--txt3)' }}>🤖 Агент:</b> {s.dispute.agentClaim}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.5 }}><b style={{ color: 'var(--accent)' }}>👤 РОП:</b> {s.dispute.ropClaim}</div>
                  {s.dispute.ownerVerdict && <div style={{ fontSize: 13, lineHeight: 1.5, marginTop: 5 }}><b style={{ color: 'var(--gold)' }}>👑 Ваш вердикт:</b> {s.dispute.ownerVerdict}</div>}
                  {!s.dispute.resolvedByOwner && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                      <button className="da-mini" disabled={busy === 'disp' + t.id} onClick={() => resolveDispute(t.id, 'agent')}>✅ Прав агент</button>
                      <button className="da-mini" disabled={busy === 'disp' + t.id} onClick={() => resolveDispute(t.id, 'rop')}>👤 Прав РОП</button>
                      <button className="da-mini" disabled={busy === 'disp' + t.id} onClick={() => resolveDispute(t.id, 'noted')}>📝 Учту, оставить</button>
                    </div>
                  )}
                </div>
              )}
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
