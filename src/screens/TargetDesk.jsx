import React, { useEffect, useState } from 'react'
import { adb } from '../lib/api.js'

// Рабочий стол «Таргет» — пошаговый мастер (Стадия 1: план без трат).
// Шаги: 1) Цель  2) Крео  3) Бюджет+Дата  4) Форма (если нужно)  5) Итог (план).
const num = (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString('ru-RU')
const TN = { fontVariantNumeric: 'tabular-nums' }

export default function TargetDesk({ onLogout }) {
  const SK = 'target_wiz'
  const saved0 = (() => { try { return JSON.parse(localStorage.getItem(SK) || '{}') } catch (e) { return {} } })()
  const [inp, setInp] = useState(null)
  const [loading, setLoading] = useState(true)
  const [idx, setIdx] = useState(saved0.idx || 0)
  const [objective, setObjective] = useState(saved0.objective || 'leads')
  const [sel, setSel] = useState(saved0.sel || {})
  const [budget, setBudget] = useState(saved0.budget || '')
  const [budgetType, setBudgetType] = useState(saved0.budgetType || 'daily') // daily | lifetime
  const [budgetCap, setBudgetCap] = useState(saved0.budgetCap || '50') // потолок ($) — защита от слива
  const [startDate, setStartDate] = useState(saved0.startDate || '')
  const [endDate, setEndDate] = useState(saved0.endDate || '')
  const [form, setForm] = useState(saved0.form || '')
  const [plan, setPlan] = useState(saved0.plan || null)
  const [building, setBuilding] = useState(false)
  const [err, setErr] = useState('')
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState(null)
  const [audRes, setAudRes] = useState(null)
  const [audBusy, setAudBusy] = useState(false)
  async function buildAudience(confirm) { setAudBusy(true); try { const d = await adb.audience(confirm); setAudRes(d) } catch (e) { setAudRes({ ok: false, error: 'Нет связи' }) } setAudBusy(false) }
  function resetWizard() { try { localStorage.removeItem(SK) } catch (e) {}; setIdx(0); setObjective('leads'); setSel({}); setBudget(''); setBudgetType('daily'); setBudgetCap('50'); setStartDate(''); setEndDate(''); setForm(''); setPlan(null); setCreated(null); setAudRes(null); setErr('') }

  // прогресс мастера НЕ сбрасывается на F5 — храним в localStorage
  useEffect(() => { try { localStorage.setItem(SK, JSON.stringify({ idx, objective, sel, budget, budgetType, budgetCap, startDate, endDate, form, plan })) } catch (e) {} }, [idx, objective, sel, budget, budgetType, budgetCap, startDate, endDate, form, plan])

  useEffect(() => { (async () => { try { const d = await adb.inputs(); if (d && d.ok) { setInp(d); const active = (d.forms || []).find(f => f.status === 'ACTIVE'); if (active) setForm(f => f || active.id) } } catch (e) {} setLoading(false) })() }, [])

  async function createInMeta(confirm) {
    if (!plan) return
    setCreating(true); setErr('')
    try { const d = await adb.create(plan, confirm, Math.round(Number(String(budgetCap).replace(/\D/g, '')) || 0)); if (d && d.ok) setCreated(d); else setErr((d && d.error) || 'Ошибка создания') } catch (e) { setErr('Нет связи с сервером') }
    setCreating(false)
  }

  const objs = (inp && inp.objectives) || []
  const curObj = objs.find(o => o.id === objective) || {}
  const forms = (inp && inp.forms) || []
  const creatives = (inp && inp.creatives) || []
  const selCount = Object.values(sel).filter(Boolean).length
  const needsForm = !!curObj.needsForm

  // динамический маршрут шагов (Форма — только если цель её требует)
  const flow = ['obj', 'creo', 'budget', ...(needsForm ? ['form'] : []), 'result']
  const step = flow[Math.min(idx, flow.length - 1)]
  const labels = [['obj', '1 · Цель'], ['creo', '2 · Крео'], ['budget', '3 · Бюджет'], ['form', '4 · Форма'], ['result', '5 · Итог']]

  async function build() {
    setErr(''); const b = Math.round(Number(String(budget).replace(/\D/g, '')))
    if (!b) { setErr('Введите бюджет'); return false }
    setBuilding(true); setPlan(null)
    try {
      const creativeIds = Object.keys(sel).filter(k => sel[k])
      const d = await adb.plan({ budget: b, currency: 'USD', budgetType, objective, startDate, endDate, form: form || undefined, creatives: creativeIds })
      if (d && d.ok) { setPlan(d); setBuilding(false); return true }
      setErr((d && d.error) || 'Не удалось собрать план')
    } catch (e) { setErr('Нет связи с сервером') }
    setBuilding(false); return false
  }
  async function next() {
    setErr('')
    if (step === 'budget' && !String(budget).replace(/\D/g, '')) { setErr('Введите бюджет'); return }
    const nextKey = flow[idx + 1]
    if (nextKey === 'result') { const ok = await build(); if (!ok) return }
    setIdx(i => Math.min(i + 1, flow.length - 1))
  }
  const back = () => { setErr(''); setIdx(i => Math.max(0, i - 1)) }

  const card = { background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 12, padding: '16px 18px' }
  const inputStyle = { width: '100%', padding: '12px 13px', borderRadius: 10, border: '1px solid var(--line2)', background: 'var(--bg2)', color: 'var(--txt)', fontSize: 15, boxSizing: 'border-box' }
  const btn = (primary) => ({ padding: '12px 24px', borderRadius: 11, border: primary ? 'none' : '1px solid var(--line2)', background: primary ? 'var(--accent)' : 'var(--card)', color: primary ? '#fff' : 'var(--txt2)', fontWeight: 600, fontSize: 14.5, cursor: 'pointer' })

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: 'var(--txt)' }}>
      <div style={{ maxWidth: 820, margin: '0 auto', padding: '20px 16px 60px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 11, background: 'var(--accent-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.7"><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></svg>
            </div>
            <div style={{ fontSize: 19, fontWeight: 700 }}>Таргет</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={resetWizard} style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--txt2)', fontSize: 13, cursor: 'pointer' }}>↻ Сбросить</button>
            <a href="/" style={{ padding: '8px 14px', borderRadius: 9, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--txt2)', fontSize: 13, textDecoration: 'none' }}>← Выход</a>
          </div>
        </div>

        {/* индикатор шагов */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 18, flexWrap: 'wrap' }}>
          {labels.map(([k, l]) => {
            const active = k === step, done = flow.indexOf(k) > -1 && flow.indexOf(k) < idx
            const dim = k === 'form' && !needsForm
            return <div key={k} style={{ flex: '1 1 auto', textAlign: 'center', padding: '7px 6px', borderRadius: 8, fontSize: 11.5, fontWeight: active ? 700 : 500, background: active ? 'var(--accent)' : (done ? 'var(--accent-bg)' : 'var(--card)'), color: active ? '#fff' : (dim ? 'var(--txt3)' : (done ? 'var(--accent)' : 'var(--txt2)')), border: '1px solid var(--line)', opacity: dim ? 0.5 : 1 }}>{l}</div>
          })}
        </div>

        {loading ? <div style={{ color: 'var(--txt3)' }}>Загрузка…</div> : (
          <div style={card}>
            {/* ШАГ 1 — ЦЕЛЬ */}
            {step === 'obj' && (<>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Цель кампании</div>
              <div style={{ fontSize: 12.5, color: 'var(--txt3)', marginBottom: 14 }}>Что должна принести реклама.</div>
              <div style={{ display: 'grid', gap: 9 }}>
                {objs.map(o => {
                  const on = objective === o.id
                  return <button key={o.id} onClick={() => setObjective(o.id)} style={{ textAlign: 'left', padding: '13px 15px', borderRadius: 11, border: `2px solid ${on ? 'var(--accent)' : 'var(--line2)'}`, background: on ? 'var(--accent-bg)' : 'var(--bg2)', cursor: 'pointer' }}>
                    <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--txt)' }}>{o.label}</div>
                    <div style={{ fontSize: 12, color: o.needsPixel ? 'var(--gold)' : 'var(--txt3)', marginTop: 3 }}>{o.note}</div>
                  </button>
                })}
              </div>
            </>)}

            {/* ШАГ 2 — КРЕО */}
            {step === 'creo' && (<>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Креативы (видео)</div>
              <div style={{ fontSize: 12.5, color: 'var(--txt3)', marginBottom: 14 }}>Из @hunteracademy_uz. Отметь, что запускать. Выбрано: <b style={{ color: 'var(--txt)' }}>{selCount}</b>{selCount === 0 ? ' — если 0, ALTRONE возьмёт лучшие по вовлечённости' : ''}</div>
              {!creatives.length ? <div style={{ color: 'var(--txt3)', fontSize: 13 }}>Постов не найдено.</div> : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 10 }}>
                  {creatives.map((c) => {
                    const on = !!sel[c.id]
                    return <button key={c.id} onClick={() => setSel(s => ({ ...s, [c.id]: !s[c.id] }))} style={{ textAlign: 'left', padding: 0, border: `2px solid ${on ? 'var(--accent)' : 'var(--line)'}`, borderRadius: 11, overflow: 'hidden', background: 'var(--bg2)', cursor: 'pointer', position: 'relative' }}>
                      {c.thumb ? <img src={c.thumb} alt="" style={{ width: '100%', height: 105, objectFit: 'cover', display: 'block' }} /> : <div style={{ height: 105, background: 'var(--card2)' }} />}
                      {on ? <div style={{ position: 'absolute', top: 6, right: 6, width: 22, height: 22, borderRadius: '50%', background: 'var(--accent)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 }}>✓</div> : null}
                      <div style={{ padding: '6px 8px' }}><div style={{ fontSize: 10.5, color: 'var(--txt2)', lineHeight: 1.3, height: 27, overflow: 'hidden' }}>{c.caption || '—'}</div><div style={{ fontSize: 10, color: 'var(--txt3)', marginTop: 2, ...TN }}>♥ {num(c.engagement)}</div></div>
                    </button>
                  })}
                </div>
              )}
            </>)}

            {/* ШАГ 3 — БЮДЖЕТ + ДАТА */}
            {step === 'budget' && (<>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Бюджет и дата</div>
              <div style={{ fontSize: 12.5, color: 'var(--txt3)', marginBottom: 14 }}>Бюджет — твой потолок. ALTRONE распределит внутри, больше не потратит.</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                {[['daily', 'В день'], ['lifetime', 'На весь период']].map(([k, l]) => (
                  <button key={k} onClick={() => setBudgetType(k)} style={{ flex: 1, padding: '11px', borderRadius: 10, border: `2px solid ${budgetType === k ? 'var(--accent)' : 'var(--line2)'}`, background: budgetType === k ? 'var(--accent-bg)' : 'var(--bg2)', color: budgetType === k ? 'var(--accent)' : 'var(--txt2)', fontWeight: 600, fontSize: 14, cursor: 'pointer' }}>{l}</button>
                ))}
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>{budgetType === 'daily' ? 'Бюджет в день ($)' : 'Общий бюджет на период ($)'}</div>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', fontSize: 18, fontWeight: 700, color: 'var(--txt3)' }}>$</span>
                  <input value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="напр. 20" style={{ ...inputStyle, ...TN, fontWeight: 700, fontSize: 18, paddingLeft: 28 }} />
                </div>
                {budgetType === 'daily' && budget ? <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 5, ...TN }}>≈ ${num(Number(budget) * 30)}/месяц при ежедневном откруте</div> : null}
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>🛡 Потолок бюджета ($) — защита от слива</div>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: 13, top: '50%', transform: 'translateY(-50%)', fontSize: 15, fontWeight: 700, color: 'var(--txt3)' }}>$</span>
                  <input value={budgetCap} onChange={(e) => setBudgetCap(e.target.value.replace(/[^\d]/g, ''))} inputMode="numeric" placeholder="напр. 50" style={{ ...inputStyle, ...TN, paddingLeft: 28 }} />
                </div>
                <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 5 }}>если суммарный бюджет выше потолка — ALTRONE не создаст и не запустит</div>
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 180px' }}>
                  <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>Дата запуска</div>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inputStyle} />
                  <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 5 }}>пусто = сразу</div>
                </div>
                {budgetType === 'lifetime' ? (
                  <div style={{ flex: '1 1 180px' }}>
                    <div style={{ fontSize: 12, color: 'var(--txt3)', marginBottom: 6 }}>Дата окончания</div>
                    <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inputStyle} />
                    <div style={{ fontSize: 11, color: 'var(--txt3)', marginTop: 5 }}>на сколько растянуть общий бюджет</div>
                  </div>
                ) : null}
              </div>
            </>)}

            {/* ШАГ 4 — ФОРМА */}
            {step === 'form' && (<>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Лид-форма</div>
              <div style={{ fontSize: 12.5, color: 'var(--txt3)', marginBottom: 14 }}>Для цели «Лиды» — куда падают заявки.</div>
              {forms.length ? (
                <select value={form} onChange={(e) => setForm(e.target.value)} style={inputStyle}>
                  <option value="">— выбери форму —</option>
                  {forms.map(f => <option key={f.id} value={f.id}>{f.name} · {f.status}</option>)}
                </select>
              ) : <div style={{ ...card, background: 'var(--gold-bg)', border: '1px solid var(--gold)', color: 'var(--txt2)', fontSize: 13 }}>Форм в Meta пока нет. Создай форму в Meta, или выбери цель «Сообщения»/«Трафик» — там форма не нужна.</div>}
            </>)}

            {/* ШАГ 5 — ИТОГ */}
            {step === 'result' && plan && (<>
              <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Итог — план кампании</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 20px', fontSize: 13, marginBottom: 12 }}>
                <span>Цель: <b>{plan.campaign.objectiveLabel}</b></span><span>Старт: <b>{plan.campaign.startDate}</b></span>{plan.campaign.endDate ? <span>До: <b>{plan.campaign.endDate}</b></span> : null}<span>Бюджет: <b style={TN}>{plan.currency === 'USD' ? '$' + num(plan.budget) : num(plan.budget) + ' сум'} {plan.campaign.budgetLabel}</b></span>{plan.expectedLeads != null ? <span>Прогноз: <b style={TN}>~{num(plan.expectedLeads)} лид{plan.campaign.perDay ? '/день' : ''}</b></span> : null}
              </div>
              {(plan.campaign.warnings || []).map((w, i) => <div key={i} style={{ background: 'var(--gold-bg)', border: '1px solid var(--gold)', borderRadius: 10, padding: '9px 12px', marginBottom: 9, color: 'var(--txt2)', fontSize: 12.5 }}>⚠️ {w}</div>)}
              {(plan.running || []).length ? (
                <div style={{ background: 'var(--card2)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 13px', marginBottom: 10, fontSize: 12, color: 'var(--txt2)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 4, color: 'var(--txt)' }}>Уже работает (старая кампания) — ALTRONE не дублирует:</div>
                  {plan.running.map((r, i) => <span key={i} style={{ color: 'var(--txt3)' }}>{r.name}{r.roas != null ? ` (${r.roas}x)` : ''}{i < plan.running.length - 1 ? ' · ' : ''}</span>)}
                </div>
              ) : null}
              <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--txt2)', margin: '4px 0 8px' }}>🧪 Новые тесты (ALTRONE ищет следующий дешёвый источник):</div>
              {plan.split.map((a, i) => (
                <div key={i} style={{ background: 'var(--bg2)', borderRadius: 10, padding: '11px 13px', marginBottom: 7, borderLeft: '3px solid var(--gold)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}><div style={{ fontSize: 13.5, fontWeight: 600 }}>🧪 {a.audience}</div><div style={{ fontSize: 14.5, fontWeight: 700, ...TN }}>{plan.currency === 'USD' ? '$' + num(a.budget) : num(a.budget)}{plan.campaign.perDay ? '/дн' : ''}</div></div>
                  {a.targeting ? <div style={{ fontSize: 11, color: 'var(--txt2)', marginTop: 4, background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 7, padding: '5px 8px' }}>🎯 {Object.entries(a.targeting).map(([k, v]) => k + ': ' + v).join(' · ')}</div> : null}
                  <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 4 }}>{a.hypothesis ? a.hypothesis + ' · ' : ''}видео: {a.creative}</div>
                </div>
              ))}
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--txt3)' }}>{plan.note}</div>
              <div style={{ ...card, marginTop: 14, marginBottom: 2, padding: '13px 15px', borderLeft: '3px solid var(--accent)' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>🎯 Lookalike из покупателей amoCRM</div>
                <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginBottom: 9 }}>Собери один раз — тесты «Lookalike» будут таргетиться на похожих на твоих реальных покупателей (заменяет пиксель).</div>
                {audRes ? <div style={{ fontSize: 12, color: audRes.ok ? 'var(--green)' : 'var(--red)', marginBottom: 9, lineHeight: 1.5 }}>{audRes.ok ? (audRes.dryRun ? `Покупателей: ${audRes.buyers} · телефонов: ${audRes.phones}. ${audRes.note || ''}` : `✓ ${audRes.note || 'готово'}`) : <span>{audRes.error} {audRes.tosUrl ? <a href={audRes.tosUrl} target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', fontWeight: 600 }}>Открыть страницу принятия →</a> : null}</span>}</div> : null}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button disabled={audBusy} onClick={() => buildAudience(false)} style={btn(false)}>{audBusy ? 'Считаю…' : 'Проверить (сухой прогон)'}</button>
                  {audRes && audRes.ok && audRes.dryRun && audRes.phones >= 100 ? <button disabled={audBusy} onClick={() => buildAudience(true)} style={btn(true)}>{audBusy ? 'Создаю…' : `Собрать Lookalike (${audRes.phones})`}</button> : null}
                </div>
              </div>
              {!created ? (
                <div style={{ marginTop: 14 }}>
                  <button disabled={creating} onClick={() => createInMeta(false)} style={btn(true)}>{creating ? 'Готовлю…' : '🔎 Показать, что создам (сухой прогон)'}</button>
                  <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 6 }}>Соберёт кампанию: адсеты + <b>объявления с твоим видео и формой</b>. Сначала покажу — в Meta ничего не пишется. Запуск — на следующем шаге.</div>
                </div>
              ) : (
                <div style={{ marginTop: 14, background: created.dryRun ? 'var(--gold-bg)' : 'var(--green-bg)', border: `1px solid ${created.dryRun ? 'var(--gold)' : 'var(--green)'}`, borderRadius: 11, padding: '13px 15px' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 7 }}>{created.dryRun ? '🔎 Сухой прогон — вот что создам в Meta:' : (created.launched ? '🚀 Запущено в Meta' : '⏸ Создано, но на паузе — смотри ошибки ниже')}</div>
                  {created.warning ? <div style={{ background: 'var(--red-bg)', border: '1px solid var(--red)', borderRadius: 8, padding: '9px 11px', marginBottom: 8, fontSize: 11.5, color: 'var(--txt)', lineHeight: 1.5 }}>⛔ {created.warning}</div> : null}
                  <div style={{ fontSize: 12, color: 'var(--txt2)', lineHeight: 1.7 }}>
                    {(created.log || []).map((l, i) => <div key={i}>{l.step === 'campaign' ? '📁 Кампания' : '📄 Адсет'}{l.audience ? ` · ${l.audience}` : ''}{l.willCreate ? ` — «${l.willCreate.name || ''}»${l.willCreate.daily_budget ? `, ${Math.round(l.willCreate.daily_budget / 100)}$/дн` : ''}` : ''}{l.id ? ` ✓ id ${l.id}` : ''}{l.error ? ` ✗ ${JSON.stringify(l.error).slice(0, 90)}` : ''}{(l.notes && l.notes.length) ? <span style={{ color: (l.notes.join(' ').includes('✓') && !l.notes.join(' ').includes('⚠️')) ? 'var(--green)' : 'var(--gold)' }}> · {l.notes.join('; ')}</span> : null}</div>)}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 9 }}>{created.note}</div>
                  {created.managerLink ? <div style={{ marginTop: 6 }}><a href={created.managerLink} target="_blank" rel="noreferrer" style={{ fontSize: 12.5, color: 'var(--accent)' }}>Открыть в Ads Manager →</a></div> : null}
                  {created.dryRun ? <div style={{ marginTop: 11 }}><button disabled={creating} onClick={() => createInMeta(true)} style={btn(true)}>{creating ? 'Создаю и запускаю…' : '🚀 Запустить в Meta'}</button></div> : null}
                  {!created.dryRun && !created.launched ? <div style={{ marginTop: 11 }}><button disabled={creating} onClick={() => setCreated(null)} style={btn(true)}>↻ Попробовать снова</button></div> : null}
                </div>
              )}
            </>)}
            {step === 'result' && building ? <div style={{ color: 'var(--txt3)' }}>Собираю план…</div> : null}
          </div>
        )}

        {/* навигация */}
        {!loading && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 }}>
            <button onClick={back} disabled={idx === 0} style={{ ...btn(false), opacity: idx === 0 ? 0.4 : 1 }}>← Назад</button>
            {err ? <span style={{ color: 'var(--red)', fontSize: 13 }}>{err}</span> : <span />}
            {step === 'result'
              ? <button onClick={() => { setIdx(0); setPlan(null); setCreated(null); try { localStorage.removeItem(SK) } catch (e) {} }} style={btn(false)}>↻ Заново</button>
              : <button onClick={next} disabled={building} style={btn(true)}>{flow[idx + 1] === 'result' ? (building ? 'Собираю…' : 'Собрать план →') : 'Далее →'}</button>}
          </div>
        )}
      </div>
    </div>
  )
}
