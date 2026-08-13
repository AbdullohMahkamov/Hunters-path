import React, { useEffect, useState } from 'react'
import { marketing as mktApi } from '../lib/api.js'

// Кабинет маркетолога — дашборд уровня админки, но данные только маркетинговые (Meta/CPL/ROAS/CAC + IG +
// общая воронка лид→продажа). Двуязычный. Задачи: выполнено + короткий отчёт.
const DICT = {
  ru: {
    title: 'Маркетинг', logout: 'Выйти', metrics: 'Метрики', spend: 'Расход (Meta)', cpl: 'Цена лида', norm: 'норма',
    leads: 'Лиды за месяц', today: 'сегодня', roas: 'ROAS', cac: 'Цена клиента', quality: 'Качество трафика', funnel: 'Воронка (лид → продажа)',
    reached: 'Дозвон', sale: 'Продажа', lost: 'Проиграно', ig: 'Instagram', followers: 'подписчиков', reach: 'охват',
    audiences: 'Аудитории по расходу', ctr: 'CTR', tasks: 'Мои задачи', noTasks: 'Открытых задач нет — всё под контролем.',
    done: 'Выполнено', doneList: 'Выполненные', reportPh: 'Что сделано (коротко) — по желанию',
    submit: 'Отметить выполненной', cancel: 'Отмена', loading: 'Загрузка…', spendOff: 'Расходы Meta не загружены — CPL/ROAS/CAC не считаются.',
    igOff: 'Instagram не подключён.', sum: 'сум', perLead: 'сум/лид', perClient: 'сум/клиент', updated: 'Данные на',
  },
  uz: {
    title: 'Marketing', logout: 'Chiqish', metrics: 'Metrikalar', spend: 'Xarajat (Meta)', cpl: 'Lid narxi', norm: 'norma',
    leads: 'Oylik lidlar', today: 'bugun', roas: 'ROAS', cac: 'Mijoz narxi', quality: 'Trafik sifati', funnel: 'Voronka (lid → sotuv)',
    reached: 'Dozvon', sale: 'Sotuv', lost: 'Yutqazildi', ig: 'Instagram', followers: 'obunachi', reach: 'qamrov',
    audiences: 'Auditoriyalar (xarajat)', ctr: 'CTR', tasks: 'Vazifalarim', noTasks: 'Ochiq vazifa yo‘q — hammasi nazoratda.',
    done: 'Bajarildi', doneList: 'Bajarilganlar', reportPh: 'Nima qilindi (qisqa) — ixtiyoriy',
    submit: 'Bajarildi deb belgilash', cancel: 'Bekor', loading: 'Yuklanmoqda…', spendOff: 'Meta xarajatlari yuklanmagan.',
    igOff: 'Instagram ulanmagan.', sum: 'so‘m', perLead: 'so‘m/lid', perClient: 'so‘m/mijoz', updated: 'Ma‘lumot',
  },
}
const numf = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('ru-RU')
const TN = { fontVariantNumeric: 'tabular-nums' }

export default function MarketerCabinet({ onLogout }) {
  const [lang, setLang] = useState(() => { try { return localStorage.getItem('mkt_lang') || 'uz' } catch (e) { return 'uz' } })
  const t = DICT[lang] || DICT.uz
  const setLangP = (l) => { try { localStorage.setItem('mkt_lang', l) } catch (e) {}; setLang(l) }
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [openReport, setOpenReport] = useState(null)
  const [reportText, setReportText] = useState('')
  const [busy, setBusy] = useState(false)

  async function load() { setLoading(true); try { const d = await mktApi.cabinet(); if (d && d.ok) setData(d) } catch (e) {}; setLoading(false) }
  useEffect(() => { load() }, [])
  async function markDone(id) { setBusy(true); try { const d = await mktApi.taskDone(id, reportText.trim()); if (d && d.ok) { setOpenReport(null); setReportText(''); await load() } } catch (e) {}; setBusy(false) }

  const m = (data && data.metrics) || {}
  const tasks = (data && data.tasks) || { open: [], done: [] }
  const cplBad = m.cpl != null && m.cplNorm != null && m.cpl > m.cplNorm

  const card = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '15px 16px' }
  const secLabel = { fontSize: 12, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', margin: '22px 2px 10px' }
  const Tile = ({ label, value, sub, color, big }) => (
    <div style={card}>
      <div style={{ fontSize: 11, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8, lineHeight: 1.3 }}>{label}</div>
      <div style={{ fontSize: big ? 26 : 22, fontWeight: 700, color: color || 'var(--txt)', ...TN, lineHeight: 1.1 }}>{value}</div>
      {sub ? <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 5, ...TN }}>{sub}</div> : null}
    </div>
  )

  // воронка: строки с баром (ширина ∝ доля от лидов)
  const fu = m.funnel
  const funnelRows = fu ? [
    { name: t.leads, v: fu.leads, hi: true },
    { name: `${t.reached} (≥${fu.reachedSec || 40}s)`, v: fu.reached },
    ...(fu.stages || []).map((s) => ({ name: s.name, v: s.reached, sold: s.isSold })),
  ].filter((r) => r.v != null) : []
  const fuMax = funnelRows.length ? Math.max(...funnelRows.map((r) => r.v || 0), 1) : 1

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--txt)' }}>
      <div style={{ maxWidth: 960, margin: '0 auto', padding: '20px 16px 70px' }}>
        {/* HEADER */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 11, background: 'var(--accent-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 auto' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4M7 4H4v3M17 20h3v-3M12 12l4-1-1 4z" /></svg>
            </div>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700 }}>{t.title}</div>
              <div style={{ fontSize: 12.5, color: 'var(--txt3)' }}>{data && data.name ? data.name : ''}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div style={{ display: 'flex', border: '1px solid var(--line2)', borderRadius: 9, overflow: 'hidden' }}>
              {['uz', 'ru'].map((l) => <button key={l} onClick={() => setLangP(l)} style={{ padding: '7px 12px', border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600, background: lang === l ? 'var(--accent)' : 'transparent', color: lang === l ? '#fff' : 'var(--txt2)' }}>{l.toUpperCase()}</button>)}
            </div>
            <button onClick={onLogout} style={{ padding: '8px 15px', borderRadius: 9, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer', fontSize: 13 }}>{t.logout}</button>
          </div>
        </div>

        {loading ? <div style={{ color: 'var(--txt3)', fontSize: 14, marginTop: 30 }}>{t.loading}</div> : (
          <>
            {/* МЕТРИКИ */}
            <div style={secLabel}>{t.metrics}{m.updatedAt ? <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--txt3)' }}> · {t.updated} {new Date(m.updatedAt).toLocaleDateString('ru-RU')}</span> : ''}</div>
            {!m.spendLoaded ? <div style={{ ...card, marginBottom: 12, color: 'var(--gold)', background: 'var(--gold-bg)', border: '1px solid var(--gold)', fontSize: 13 }}>{t.spendOff}</div> : null}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(148px,1fr))', gap: 11 }}>
              <Tile label={`${t.cpl}`} value={m.cpl != null ? numf(m.cpl) : '—'} sub={`${t.perLead}${m.cplNorm != null ? ` · ${t.norm} ${numf(m.cplNorm)}` : ''}`} color={cplBad ? 'var(--red)' : (m.cpl != null && m.cplNorm != null ? 'var(--green)' : 'var(--accent)')} big />
              <Tile label={t.leads} value={numf(m.leads)} sub={m.leadsToday != null ? `${t.today}: ${numf(m.leadsToday)}` : null} big />
              <Tile label={t.roas} value={m.roas != null ? `${m.roas}×` : '—'} big />
              <Tile label={t.spend} value={`${numf(m.spendUZS)}`} sub={`${t.sum}${m.rate ? ` · ${m.currency} ×${m.rate}` : ''}`} />
              <Tile label={t.cac} value={m.cac != null ? numf(m.cac) : '—'} sub={t.perClient} />
              <Tile label={t.quality} value={m.conv != null ? `${m.conv}%` : '—'} sub="лид→продажа" />
            </div>

            {/* ВОРОНКА */}
            {funnelRows.length ? (
              <>
                <div style={secLabel}>{t.funnel}</div>
                <div style={card}>
                  {funnelRows.map((r, i) => (
                    <div key={i} style={{ marginBottom: i < funnelRows.length - 1 ? 11 : 0 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 4 }}>
                        <span style={{ color: r.hi ? 'var(--txt)' : 'var(--txt2)', fontWeight: r.hi || r.sold ? 600 : 400 }}>{r.name}{r.sold ? ` ← ${t.sale}` : ''}</span>
                        <span style={{ color: 'var(--txt)', fontWeight: 600, ...TN }}>{numf(r.v)}{fu.leads ? <span style={{ color: 'var(--txt3)', fontWeight: 400 }}> · {Math.round((r.v || 0) / fu.leads * 100)}%</span> : null}</span>
                      </div>
                      <div style={{ height: 8, background: 'var(--card2)', borderRadius: 5, overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${Math.max(2, Math.round((r.v || 0) / fuMax * 100))}%`, background: r.sold ? 'var(--green)' : (r.hi ? 'var(--accent)' : 'var(--accent)'), opacity: r.sold ? 1 : (r.hi ? 1 : 0.72), borderRadius: 5, transition: 'width .4s' }} />
                      </div>
                    </div>
                  ))}
                  {fu.lost != null ? <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 10 }}>{t.lost}: {numf(fu.lost)}</div> : null}
                </div>
              </>
            ) : null}

            {/* INSTAGRAM + АУДИТОРИИ */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(280px,1fr))', gap: 11, marginTop: 4 }}>
              <div>
                <div style={secLabel}>{t.ig}</div>
                <div style={card}>
                  {m.instagram ? (
                    <div style={{ fontSize: 13, color: 'var(--txt2)' }}>
                      <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--txt)', ...TN }}>{numf(m.instagram.followers)}</span> {t.followers}{m.instagram.reach != null ? <span> · {t.reach} <b style={TN}>{numf(m.instagram.reach)}</b></span> : ''}
                      {(m.instagram.posts || []).length ? <div style={{ marginTop: 8, fontSize: 12, color: 'var(--txt3)', lineHeight: 1.6 }}>{m.instagram.posts.map((p, i) => <div key={i} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· «{p.caption || '—'}» — <b>{p.engagement}</b></div>)}</div> : null}
                    </div>
                  ) : <div style={{ fontSize: 12.5, color: 'var(--txt3)' }}>{t.igOff}</div>}
                </div>
              </div>
              <div>
                <div style={secLabel}>{t.audiences}</div>
                <div style={card}>
                  {(m.audiences || []).length ? m.audiences.map((a, i) => {
                    const max = Math.max(...m.audiences.map((x) => x.spendUZS || 0), 1)
                    return (
                      <div key={i} style={{ marginBottom: i < m.audiences.length - 1 ? 9 : 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 3 }}>
                          <span style={{ color: 'var(--txt2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 10 }}>{a.name}</span>
                          <span style={{ color: 'var(--txt3)', flex: '0 0 auto', ...TN }}>{numf(a.spendUZS)}{a.ctr != null ? ` · CTR ${a.ctr}%` : ''}</span>
                        </div>
                        <div style={{ height: 5, background: 'var(--card2)', borderRadius: 4, overflow: 'hidden' }}><div style={{ height: '100%', width: `${Math.max(3, Math.round((a.spendUZS || 0) / max * 100))}%`, background: 'var(--accent)', opacity: 0.75, borderRadius: 4 }} /></div>
                      </div>
                    )
                  }) : <div style={{ fontSize: 12.5, color: 'var(--txt3)' }}>—</div>}
                </div>
              </div>
            </div>

            {/* ЗАДАЧИ */}
            <div style={secLabel}>{t.tasks}</div>
            {!tasks.open.length ? <div style={{ ...card, color: 'var(--green)', background: 'var(--green-bg)', border: '1px solid var(--green)', fontSize: 13 }}>{t.noTasks}</div> : tasks.open.map((task) => (
              <div key={task.id} style={{ ...card, marginBottom: 10, borderLeft: '3px solid var(--accent)' }}>
                <div style={{ fontSize: 14.5, fontWeight: 600, marginBottom: task.why ? 5 : 0 }}>{task.title}</div>
                {task.why ? <div style={{ fontSize: 12.5, color: 'var(--txt3)', marginBottom: 6 }}>{task.why}</div> : null}
                {(task.steps || []).length ? <ul style={{ margin: '4px 0 10px', paddingLeft: 18, fontSize: 12.5, color: 'var(--txt2)', lineHeight: 1.6 }}>{task.steps.map((s, i) => <li key={i}>{s}</li>)}</ul> : null}
                {openReport === task.id ? (
                  <div style={{ marginTop: 8 }}>
                    <textarea value={reportText} onChange={(e) => setReportText(e.target.value)} placeholder={t.reportPh} rows={2} style={{ width: '100%', padding: 10, borderRadius: 9, border: '1px solid var(--line2)', background: 'var(--bg2)', color: 'var(--txt)', fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
                    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                      <button disabled={busy} onClick={() => markDone(task.id)} style={{ padding: '9px 16px', borderRadius: 9, background: 'var(--green)', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>{t.submit}</button>
                      <button onClick={() => { setOpenReport(null); setReportText('') }} style={{ padding: '9px 14px', borderRadius: 9, background: 'transparent', color: 'var(--txt2)', border: '1px solid var(--line2)', cursor: 'pointer', fontSize: 13 }}>{t.cancel}</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => { setOpenReport(task.id); setReportText('') }} style={{ padding: '9px 16px', borderRadius: 9, background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: 13 }}>{t.done}</button>
                )}
              </div>
            ))}
            {(tasks.done || []).length ? (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--txt3)', textTransform: 'uppercase', letterSpacing: '.4px', marginBottom: 8 }}>{t.doneList}</div>
                {tasks.done.map((task) => <div key={task.id} style={{ fontSize: 12.5, color: 'var(--txt3)', padding: '7px 0', borderBottom: '1px solid var(--line)' }}>✓ {task.title}{task.report ? <span style={{ color: 'var(--txt2)' }}> — {task.report}</span> : ''}</div>)}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
