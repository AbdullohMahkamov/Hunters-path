import React, { useEffect, useState } from 'react'
import { adb } from '../lib/api.js'

// Рабочий стол «Таргет» (Стадия 1: план без трат). Ты задаёшь бюджет/цель/дату/видео —
// ALTRONE распределяет по аудиториям (реальный ROAS из amoCRM) и показывает план. В Meta пока ничего не создаётся.
const num = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('ru-RU')
const TN = { fontVariantNumeric: 'tabular-nums' }

export default function TargetDesk({ onLogout }) {
  const [inp, setInp] = useState(null)
  const [loading, setLoading] = useState(true)
  const [budget, setBudget] = useState('')
  const [objective, setObjective] = useState('leads')
  const [startDate, setStartDate] = useState('')
  const [form, setForm] = useState('')
  const [sel, setSel] = useState({})               // выбранные видео: {id:true}
  const [plan, setPlan] = useState(null)
  const [building, setBuilding] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { (async () => { try { const d = await adb.inputs(); if (d && d.ok) { setInp(d); const lead = (d.objectives || []).find(o => o.id === 'leads'); if (lead) setObjective('leads') } } catch (e) {} setLoading(false) })() }, [])

  const objs = (inp && inp.objectives) || []
  const curObj = objs.find(o => o.id === objective) || {}
  const forms = (inp && inp.forms) || []
  const creatives = (inp && inp.creatives) || []
  const selCount = Object.values(sel).filter(Boolean).length

  async function build() {
    setErr(''); const b = Math.round(Number(String(budget).replace(/\D/g, '')))
    if (!b) { setErr('Введите общий бюджет'); return }
    setBuilding(true); setPlan(null)
    try {
      const creativeIds = Object.keys(sel).filter(k => sel[k])
      const d = await adb.plan({ budget: b, objective, startDate, form: form || undefined, creatives: creativeIds })
      if (d && d.ok) setPlan(d); else setErr((d && d.error) || 'Не удалось собрать план')
    } catch (e) { setErr('Нет связи с сервером') }
    setBuilding(false)
  }

  const card = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '15px 16px' }
  const secLabel = { fontSize: 12, fontWeight: 700, color: 'var(--txt2)', textTransform: 'uppercase', letterSpacing: '.4px', margin: '22px 2px 10px' }
  const inputStyle = { width: '100%', padding: '11px 12px', borderRadius: 10, border: '1px solid var(--line2)', background: 'var(--bg2)', color: 'var(--txt)', fontSize: 14, boxSizing: 'border-box' }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--txt)' }}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '20px 16px 70px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 42, height: 42, borderRadius: 11, background: 'var(--accent-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></svg>
            </div>
            <div><div style={{ fontSize: 20, fontWeight: 700 }}>Таргет</div><div style={{ fontSize: 12.5, color: 'var(--txt3)' }}>ALTRONE соберёт кампанию из твоих данных</div></div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <a href="/" style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer', fontSize: 13, textDecoration: 'none' }}>← Назад</a>
            {onLogout ? <button onClick={onLogout} style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--txt2)', cursor: 'pointer', fontSize: 13 }}>Выйти</button> : null}
          </div>
        </div>

        {loading ? <div style={{ color: 'var(--txt3)', marginTop: 30 }}>Загрузка…</div> : (
          <>
            <div style={secLabel}>Настройки кампании</div>
            <div style={{ ...card, display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 14 }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>Общий бюджет (сум) — твой потолок</div>
                <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="напр. 5 000 000" style={{ ...inputStyle, ...TN, fontWeight: 700, fontSize: 16 }} />
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>Цель</div>
                <select value={objective} onChange={(e) => setObjective(e.target.value)} style={inputStyle}>
                  {objs.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                </select>
                {curObj.note ? <div style={{ fontSize: 11, color: curObj.needsPixel ? 'var(--gold)' : 'var(--txt3)', marginTop: 5 }}>{curObj.note}</div> : null}
              </div>
              <div>
                <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>Дата запуска</div>
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
                <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 5 }}>пусто = сразу после «Старт»</div>
              </div>
              {curObj.needsForm ? (
                <div>
                  <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>Лид-форма</div>
                  {forms.length ? (
                    <select value={form} onChange={(e) => setForm(e.target.value)} style={inputStyle}>
                      <option value="">— выбери форму —</option>
                      {forms.map(f => <option key={f.id} value={f.id}>{f.name} · {f.status}</option>)}
                    </select>
                  ) : <div style={{ ...inputStyle, color: 'var(--gold)', fontSize: 12.5 }}>Форм нет — создай в Meta или выбери цель «Сообщения»/«Трафик»</div>}
                </div>
              ) : null}
            </div>

            <div style={secLabel}>Видео <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--txt3)' }}>· из @hunteracademy_uz · выбрано {selCount}</span></div>
            {!creatives.length ? <div style={{ ...card, color: 'var(--txt3)', fontSize: 13 }}>Постов в Instagram не найдено.</div> : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>
                {creatives.map((c) => {
                  const on = !!sel[c.id]
                  return (
                    <button key={c.id} onClick={() => setSel(s => ({ ...s, [c.id]: !s[c.id] }))} style={{ textAlign: 'left', padding: 0, border: `2px solid ${on ? 'var(--accent)' : 'var(--line)'}`, borderRadius: 11, overflow: 'hidden', background: 'var(--card)', cursor: 'pointer', position: 'relative' }}>
                      {c.thumb ? <img src={c.thumb} alt="" style={{ width: '100%', height: 110, objectFit: 'cover', display: 'block' }} /> : <div style={{ height: 110, background: 'var(--card2)' }} />}
                      {on ? <div style={{ position: 'absolute', top: 7, right: 7, width: 22, height: 22, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>✓</div> : null}
                      <div style={{ padding: '7px 9px' }}>
                        <div style={{ fontSize: 11, color: 'var(--txt2)', lineHeight: 1.35, height: 30, overflow: 'hidden' }}>{c.caption || '—'}</div>
                        <div style={{ fontSize: 10.5, color: 'var(--txt3)', marginTop: 3, ...TN }}>♥ {num(c.engagement)}{c.type ? ` · ${c.type}` : ''}</div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}

            <div style={{ marginTop: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
              <button disabled={building} onClick={build} style={{ padding: '13px 26px', borderRadius: 11, background: 'var(--accent)', color: '#fff', border: 'none', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>{building ? 'Собираю…' : 'Собрать план'}</button>
              {err ? <span style={{ color: 'var(--red)', fontSize: 13 }}>{err}</span> : null}
            </div>

            {plan ? (
              <>
                <div style={secLabel}>План кампании</div>
                <div style={{ ...card, marginBottom: 12, display: 'flex', flexWrap: 'wrap', gap: '6px 22px', fontSize: 13 }}>
                  <span>Цель: <b>{plan.campaign.objectiveLabel}</b></span>
                  <span>Старт: <b>{plan.campaign.startDate}</b></span>
                  <span>Бюджет: <b style={TN}>{num(plan.budgetUZS)} сум</b></span>
                  {plan.expectedLeads != null ? <span>Прогноз: <b style={TN}>~{num(plan.expectedLeads)} лид</b></span> : null}
                </div>
                {(plan.campaign.warnings || []).map((w, i) => <div key={i} style={{ ...card, marginBottom: 10, background: 'var(--gold-bg)', border: '1px solid var(--gold)', color: 'var(--txt2)', fontSize: 12.5 }}>⚠️ {w}</div>)}
                {plan.split.map((a, i) => (
                  <div key={i} style={{ ...card, marginBottom: 8, borderLeft: `3px solid ${a.isTest ? 'var(--gold)' : 'var(--accent)'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 600 }}>{a.audience}{a.isTest ? ' 🧪' : a.proven ? ' ✅' : ''}</div>
                      <div style={{ fontSize: 15, fontWeight: 700, ...TN }}>{num(a.budgetUZS)} сум</div>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--txt3)', marginTop: 3, ...TN }}>{a.roas != null ? `ROAS ${a.roas}x · ` : ''}{a.cpl ? `CPL ${num(a.cpl)} · ` : ''}видео: {a.creative}</div>
                  </div>
                ))}
                <div style={{ ...card, marginTop: 12, background: 'var(--card2)', fontSize: 12.5, color: 'var(--txt2)' }}>{plan.note}</div>
                <div style={{ marginTop: 14 }}>
                  <button disabled title="Стадия 2 — скоро" style={{ padding: '12px 24px', borderRadius: 11, background: 'var(--card)', color: 'var(--txt3)', border: '1px dashed var(--line2)', fontWeight: 600, fontSize: 14, cursor: 'not-allowed' }}>🚀 Создать в Meta (на паузе) — Стадия 2, скоро</button>
                </div>
              </>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
