import React, { useEffect, useState } from 'react'
import { marketing as mktApi } from '../lib/api.js'

// Кабинет маркетолога: метрики (Meta/CPL/ROAS/CAC + Instagram + качество трафика) и его задачи (выполнено + отчёт).
// Двуязычный (uz/ru), переключатель. Роль marketing — свой кабинет, без доступа к продажам/целям/админке.
const DICT = {
  ru: {
    title: 'Маркетинг', logout: 'Выйти', spend: 'Расход на рекламу (Meta)', cpl: 'Цена лида (CPL)', norm: 'норма',
    leads: 'Лиды за месяц', today: 'сегодня', roas: 'Окупаемость (ROAS)', cac: 'Цена клиента (CAC)',
    quality: 'Качество трафика (лид→продажа)', ig: 'Instagram', followers: 'подписчиков', reach: 'охват',
    audiences: 'Аудитории по расходу', ctr: 'CTR', tasks: 'Мои задачи', noTasks: 'Открытых задач нет — всё под контролем.',
    done: 'Выполнено', doneList: 'Выполненные', reportPh: 'Что сделано (коротко) — по желанию',
    submit: 'Отметить выполненной', cancel: 'Отмена', loading: 'Загрузка…', spendOff: 'Расходы Meta не загружены — CPL/ROAS/CAC не считаются.',
    igOff: 'Instagram не подключён.', perMonth: '/мес', sum: 'сум', perLead: 'сум/лид', perClient: 'сум/клиент', updated: 'Данные на',
  },
  uz: {
    title: 'Marketing', logout: 'Chiqish', spend: 'Reklama xarajati (Meta)', cpl: 'Lid narxi (CPL)', norm: 'norma',
    leads: 'Oylik lidlar', today: 'bugun', roas: 'Qoplanish (ROAS)', cac: 'Mijoz narxi (CAC)',
    quality: 'Trafik sifati (lid→sotuv)', ig: 'Instagram', followers: 'obunachi', reach: 'qamrov',
    audiences: 'Auditoriyalar (xarajat bo‘yicha)', ctr: 'CTR', tasks: 'Mening vazifalarim', noTasks: 'Ochiq vazifa yo‘q — hammasi nazoratda.',
    done: 'Bajarildi', doneList: 'Bajarilganlar', reportPh: 'Nima qilindi (qisqa) — ixtiyoriy',
    submit: 'Bajarildi deb belgilash', cancel: 'Bekor', loading: 'Yuklanmoqda…', spendOff: 'Meta xarajatlari yuklanmagan — CPL/ROAS/CAC hisoblanmaydi.',
    igOff: 'Instagram ulanmagan.', perMonth: '/oy', sum: 'so‘m', perLead: 'so‘m/lid', perClient: 'so‘m/mijoz', updated: 'Ma‘lumot',
  },
}
const numf = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('ru-RU')

export default function MarketerCabinet({ onLogout }) {
  const [lang, setLang] = useState(() => { try { return localStorage.getItem('mkt_lang') || 'uz' } catch (e) { return 'uz' } })
  const t = DICT[lang] || DICT.uz
  const setLangP = (l) => { try { localStorage.setItem('mkt_lang', l) } catch (e) {}; setLang(l) }
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [openReport, setOpenReport] = useState(null) // id задачи, для которой открыт отчёт
  const [reportText, setReportText] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() {
    setLoading(true)
    try { const d = await mktApi.cabinet(); if (d && d.ok) setData(d) } catch (e) {}
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function markDone(id) {
    setBusy(true)
    try { const d = await mktApi.taskDone(id, reportText.trim()); if (d && d.ok) { setOpenReport(null); setReportText(''); await load() } } catch (e) {}
    setBusy(false)
  }

  const m = (data && data.metrics) || {}
  const tasks = (data && data.tasks) || { open: [], done: [] }
  const cplBad = m.cpl != null && m.cplNorm != null && m.cpl > m.cplNorm

  const card = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '14px 16px' }
  const Stat = ({ label, value, sub, color }) => (
    <div style={card}>
      <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: color || 'var(--txt)' }}>{value}</div>
      {sub ? <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 3 }}>{sub}</div> : null}
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--txt)' }}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '18px 16px 60px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{t.title}</div>
            <div style={{ fontSize: 12.5, color: 'var(--txt3)' }}>{data && data.name ? data.name : ''}</div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', border: '1px solid var(--line2)', borderRadius: 8, overflow: 'hidden' }}>
              {['uz', 'ru'].map((l) => <button key={l} onClick={() => setLangP(l)} style={{ padding: '6px 11px', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, background: lang === l ? 'var(--accent)' : 'transparent', color: lang === l ? '#fff' : 'var(--txt2)' }}>{l.toUpperCase()}</button>)}
            </div>
            <button onClick={onLogout} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer', fontSize: 13 }}>{t.logout}</button>
          </div>
        </div>

        {loading ? <div style={{ color: 'var(--txt3)', fontSize: 14 }}>{t.loading}</div> : (
          <>
            {/* МЕТРИКИ */}
            {!m.spendLoaded ? <div style={{ ...card, marginBottom: 12, color: 'var(--gold)', background: 'var(--gold-bg)', border: '1px solid var(--gold)' }}>{t.spendOff}</div> : null}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10, marginBottom: 12 }}>
              <Stat label={`${t.spend} · ${m.period || ''}`} value={`${numf(m.spendUZS)} ${t.sum}`} sub={m.rate ? `${m.currency}, ×${m.rate}` : null} />
              <Stat label={t.cpl} value={m.cpl != null ? `${numf(m.cpl)} ${t.perLead}` : '—'} sub={m.cplNorm != null ? `${t.norm}: ${numf(m.cplNorm)}` : null} color={cplBad ? 'var(--red)' : (m.cpl != null && m.cplNorm != null ? 'var(--green)' : null)} />
              <Stat label={t.leads} value={numf(m.leads)} sub={m.leadsToday != null ? `${t.today}: ${numf(m.leadsToday)}` : null} />
              <Stat label={t.roas} value={m.roas != null ? `${m.roas}x` : '—'} />
              <Stat label={t.cac} value={m.cac != null ? `${numf(m.cac)} ${t.perClient}` : '—'} />
              <Stat label={t.quality} value={m.conv != null ? `${m.conv}%` : '—'} />
            </div>

            {/* INSTAGRAM */}
            <div style={{ ...card, marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t.ig}</div>
              {m.instagram ? (
                <div style={{ fontSize: 13, color: 'var(--txt2)' }}>
                  {numf(m.instagram.followers)} {t.followers}{m.instagram.reach != null ? ` · ${t.reach} ${numf(m.instagram.reach)}` : ''}
                  {(m.instagram.posts || []).length ? <div style={{ marginTop: 6, fontSize: 12, color: 'var(--txt3)' }}>{m.instagram.posts.map((p, i) => <div key={i}>· «{p.caption || '—'}» — {p.engagement}</div>)}</div> : null}
                </div>
              ) : <div style={{ fontSize: 12.5, color: 'var(--txt3)' }}>{t.igOff}</div>}
            </div>

            {/* АУДИТОРИИ */}
            {(m.audiences || []).length ? (
              <div style={{ ...card, marginBottom: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{t.audiences}</div>
                {m.audiences.map((a, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, padding: '5px 0', borderBottom: i < m.audiences.length - 1 ? '1px solid var(--line)' : 'none' }}>
                    <span style={{ color: 'var(--txt2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 10 }}>{a.name}</span>
                    <span style={{ color: 'var(--txt3)', flex: '0 0 auto' }}>{numf(a.spendUZS)} {t.sum}{a.ctr != null ? ` · ${t.ctr} ${a.ctr}%` : ''}{a.leads != null ? ` · ${a.leads} lid` : ''}</span>
                  </div>
                ))}
              </div>
            ) : null}

            {/* ЗАДАЧИ */}
            <div style={{ fontSize: 15, fontWeight: 700, margin: '18px 0 10px' }}>{t.tasks}</div>
            {!tasks.open.length ? <div style={{ ...card, color: 'var(--green)', background: 'var(--green-bg)', border: '1px solid var(--green)' }}>{t.noTasks}</div> : tasks.open.map((task) => (
              <div key={task.id} style={{ ...card, marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 600, marginBottom: task.why ? 5 : 0 }}>{task.title}</div>
                {task.why ? <div style={{ fontSize: 12.5, color: 'var(--txt3)', marginBottom: 6 }}>{task.why}</div> : null}
                {(task.steps || []).length ? <ul style={{ margin: '4px 0 8px', paddingLeft: 18, fontSize: 12.5, color: 'var(--txt2)' }}>{task.steps.map((s, i) => <li key={i} style={{ marginBottom: 2 }}>{s}</li>)}</ul> : null}
                {openReport === task.id ? (
                  <div style={{ marginTop: 8 }}>
                    <textarea value={reportText} onChange={(e) => setReportText(e.target.value)} placeholder={t.reportPh} rows={2} style={{ width: '100%', padding: 9, borderRadius: 8, border: '1px solid var(--line2)', background: 'var(--bg2)', color: 'var(--txt)', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button disabled={busy} onClick={() => markDone(task.id)} style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--green)', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>{t.submit}</button>
                      <button onClick={() => { setOpenReport(null); setReportText('') }} style={{ padding: '9px 14px', borderRadius: 8, background: 'transparent', color: 'var(--txt2)', border: '1px solid var(--line2)', cursor: 'pointer', fontSize: 13 }}>{t.cancel}</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setOpenReport(task.id); setReportText('') }} style={{ padding: '8px 15px', borderRadius: 8, background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>{t.done}</button>
                )}
              </div>
            ))}

            {/* ВЫПОЛНЕННЫЕ */}
            {(tasks.done || []).length ? (
              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--txt3)', marginBottom: 8 }}>{t.doneList}</div>
                {tasks.done.map((task) => (
                  <div key={task.id} style={{ fontSize: 12.5, color: 'var(--txt3)', padding: '6px 0', borderBottom: '1px solid var(--line)' }}>
                    ✓ {task.title}{task.report ? <span style={{ color: 'var(--txt2)' }}> — {task.report}</span> : ''}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
