// src/components/GrowthPanel.jsx — вкладка «Growth Agent» (Агент Б) внутри /dev-agent.
// Воронка с trust-статусами (verified/suspicious/insufficient), гипотезы роста со ссылками
// на источники, кнопка «Отметить результат» (сработало/нет/частично). Только админ.
import React, { useEffect, useState } from 'react'
import { growthAgent } from '../lib/api.js'

const TRUST = {
  verified: { c: 'var(--green)', bg: 'var(--green-bg)', ru: 'verified' },
  suspicious: { c: 'var(--gold)', bg: 'var(--gold-bg)', ru: 'suspicious' },
  insufficient: { c: 'var(--txt3)', bg: 'var(--card2)', ru: 'insufficient' },
  info: { c: 'var(--txt2)', bg: 'var(--card2)', ru: 'инфо' },
}
function TrustBadge({ t }) { const x = TRUST[t] || TRUST.insufficient; return <span className="ga-trust" style={{ color: x.c, background: x.bg }}>{x.ru}</span> }
const fmtMoney = (n) => n == null ? '—' : new Intl.NumberFormat('de-DE').format(n)
const CONF = { high: { c: 'var(--green)', ru: 'высокий' }, medium: { c: 'var(--gold)', ru: 'средний' }, low: { c: 'var(--txt3)', ru: 'низкий' } }

export default function GrowthPanel() {
  const [st, setSt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState('')
  const [showCfg, setShowCfg] = useState(false)
  const [cfg, setCfg] = useState(null)

  async function load() {
    const d = await growthAgent.state()
    if (d && d.ok) { setSt(d); setCfg(d.config) }
    setLoading(false)
  }
  useEffect(() => { load() }, [])
  function flash(m) { setToast(m); setTimeout(() => setToast(''), 1900) }

  async function run() { if (busy) return; setBusy('run'); try { const d = await growthAgent.run(); if (d && d.ok) { await load(); flash('Прогон готов') } else flash((d && d.error) || 'Ошибка') } catch (e) { flash('Нет связи') } setBusy('') }
  async function mark(h, result) {
    if (busy) return
    const note = window.prompt(`Результат «${result === 'worked' ? 'сработало' : result === 'failed' ? 'не сработало' : 'частично'}» — комментарий (необязательно):`) || ''
    setBusy('mark'); try { await growthAgent.markResult({ hypId: h.id, result, note }); await load(); flash('Отмечено') } catch (e) { flash('Нет связи') } setBusy('')
  }
  async function saveCfg() { setBusy('cfg'); try { const d = await growthAgent.setConfig(cfg); if (d && d.ok) { setCfg(d.config); flash('Сохранено'); setShowCfg(false) } else flash('Ошибка') } catch (e) { flash('Нет связи') } setBusy('') }
  async function reset() { if (!window.confirm('Сбросить открытые гипотезы и последний прогон? (проверенные и источники сохранятся)')) return; setBusy('reset'); try { await growthAgent.reset(false); await load(); flash('Сброшено') } catch (e) {} setBusy('') }
  function copy(t) { navigator.clipboard.writeText(t); flash('Скопировано') }

  if (loading) return <div className="ga-empty">Загрузка…</div>
  const funnel = st && st.funnel
  const hyps = (st && st.hypotheses) || []
  const tested = (st && st.tested) || []
  const sources = (st && st.sources) || []
  const lastRun = st && st.lastRun

  return (
    <div className="ga-root">
      <div className="ga-head">
        <div>
          <div className="ga-title">Growth Agent <span className="ga-sub">гипотезы роста · только verified-данные + web search</span></div>
          {lastRun && <div className="ga-lastrun">последний прогон: {new Date(lastRun.at).toLocaleString('ru')} · поисков {lastRun.searches ?? 0} · {lastRun.tokens ? (lastRun.tokens >= 1000 ? (lastRun.tokens / 1000).toFixed(1) + 'k' : lastRun.tokens) + ' token' : ''}</div>}
        </div>
        <div className="ga-actions">
          <button className="da-btn" disabled={!!busy} onClick={run}>{busy === 'run' ? 'Ищу бенчмарки…' : 'Запустить сейчас'}</button>
          <button className="da-btn ghost" disabled={!!busy} onClick={() => setShowCfg((v) => !v)}>Настройки</button>
          <button className="da-btn ghost" disabled={!!busy} onClick={reset}>Сбросить</button>
        </div>
      </div>

      {showCfg && cfg && (
        <div className="ga-cfg">
          <label className="ga-cf"><span>Клиент (org_id)</span><input value={cfg.clientOrg} onChange={(e) => setCfg({ ...cfg, clientOrg: e.target.value })} /></label>
          <label className="ga-cf wide"><span>Ниша (обезличенно, для web search)</span><input value={cfg.niche} onChange={(e) => setCfg({ ...cfg, niche: e.target.value })} /></label>
          <label className="ga-cf"><span>Частота</span>
            <select value={cfg.cadence} onChange={(e) => setCfg({ ...cfg, cadence: e.target.value })}><option value="daily">ежедневно (тест)</option><option value="weekly">еженедельно (MVP)</option></select>
          </label>
          <label className="ga-cf"><span>Поисков за прогон</span><input type="number" min="1" max="6" value={cfg.webMaxSearches} onChange={(e) => setCfg({ ...cfg, webMaxSearches: Number(e.target.value) })} /></label>
          <div className="ga-cf-btns"><button className="da-btn" disabled={busy === 'cfg'} onClick={saveCfg}>Сохранить</button><button className="da-btn ghost" onClick={() => setShowCfg(false)}>Закрыть</button></div>
        </div>
      )}

      <div className="ga-body">
        {/* ВОРОНКА С TRUST */}
        {funnel && (
          <div className="ga-funnel">
            <div className="ga-sec-h">Коммерческая воронка (от Dev-Agent) {funnel.telephonySuspicious && <span className="ga-warn">⚠ данные звонков помечены suspicious</span>}</div>
            <div className="ga-stages">
              {(funnel.stages || []).map((s, i) => (
                <div key={i} className="ga-stage">
                  {s.transitionFromPrev && <div className="ga-trans"><span className="ga-trans-pct" style={{ color: (TRUST[s.transitionFromPrev.trust] || {}).c }}>{s.transitionFromPrev.pct != null ? s.transitionFromPrev.pct + '%' : '—'}</span> <TrustBadge t={s.transitionFromPrev.trust} /></div>}
                  <div className="ga-stage-box">
                    <div className="ga-stage-name">{s.stage}</div>
                    <div className="ga-stage-val">{s.value != null ? s.value : '—'}{s.money != null ? ` · ${fmtMoney(s.money)} so'm` : ''}</div>
                    <TrustBadge t={s.trust} />
                  </div>
                </div>
              ))}
            </div>
            <div className="ga-metrics">
              {funnel.maxDropOff && <div className="ga-metric"><b>Макс. отток:</b> {funnel.maxDropOff.transition} → <span style={{ color: 'var(--red)' }}>−{funnel.maxDropOff.dropPct}%</span> (конверсия {funnel.maxDropOff.convPct}%)</div>}
              {funnel.avgCheck && <div className="ga-metric"><b>Средний чек:</b> среднее {fmtMoney(funnel.avgCheck.mean)} · медиана {fmtMoney(funnel.avgCheck.median)} <TrustBadge t={funnel.avgCheck.trust} /></div>}
              {funnel.dealCycle && funnel.dealCycle.companyMedianDays != null && <div className="ga-metric"><b>Цикл сделки:</b> медиана {funnel.dealCycle.companyMedianDays} дн <TrustBadge t={funnel.dealCycle.trust} /></div>}
              {funnel.dynamics && funnel.dynamics.conv && <div className="ga-metric"><b>Динамика конверсии:</b> {funnel.dynamics.conv.from}% → {funnel.dynamics.conv.to}% ({funnel.dynamics.conv.delta > 0 ? '+' : ''}{funnel.dynamics.conv.delta}) <TrustBadge t={funnel.dynamics.trust} /></div>}
              {funnel.ltv && <div className="ga-metric ga-dim"><b>LTV/повторные:</b> {funnel.ltv.note} <TrustBadge t="insufficient" /></div>}
              {funnel.paymentInfo && <div className="ga-metric ga-dim"><b>Оплата:</b> {funnel.paymentInfo.note}. Чеков: {funnel.paymentInfo.paidReceiptCount != null ? funnel.paymentInfo.paidReceiptCount : '—'}</div>}
            </div>
            {(funnel.undiagnosable || []).length > 0 && (
              <div className="ga-undiag">Не диагностируется (данные ненадёжны/недостаточны): {funnel.undiagnosable.map((u) => `${u.transition} (${u.trust})`).join('; ')}</div>
            )}
          </div>
        )}

        {lastRun && lastRun.report && <div className="ga-report">{lastRun.report}</div>}

        {/* ГИПОТЕЗЫ */}
        <div className="ga-sec-h">Гипотезы роста <span className="da-count">{hyps.length}</span></div>
        {!hyps.length && <div className="ga-empty">Пока нет гипотез. Нажми «Запустить сейчас» — агент возьмёт verified-воронку, поищет бенчмарки и предложит гипотезы.</div>}
        {hyps.map((h) => (
          <div key={h.id} className="ga-hyp">
            <div className="ga-hyp-top">
              <span className="ga-conf" style={{ color: (CONF[h.confidence] || CONF.low).c }}>confidence: {(CONF[h.confidence] || CONF.low).ru}</span>
            </div>
            <div className="ga-hyp-row"><span className="ga-lbl">Наблюдение</span><span>{h.observation}</span></div>
            <div className="ga-hyp-row"><span className="ga-lbl">Внешний ориентир</span><span>{h.benchmark} {h.source && <em className="ga-src">({h.source})</em>}</span></div>
            <div className="ga-hyp-row"><span className="ga-lbl">Гипотеза причины</span><span>{h.cause}</span></div>
            <div className="ga-hyp-row"><span className="ga-lbl">Как проверить</span><span>{h.howToVerify}</span></div>
            <div className="ga-hyp-btns">
              <span className="ga-mark-lbl">Отметить результат (после ручной проверки):</span>
              <button className="da-mini ok" disabled={!!busy} onClick={() => mark(h, 'worked')}>Сработало</button>
              <button className="da-mini fix" disabled={!!busy} onClick={() => mark(h, 'partial')}>Частично</button>
              <button className="da-mini no" disabled={!!busy} onClick={() => mark(h, 'failed')}>Не сработало</button>
            </div>
          </div>
        ))}

        {/* ПРОВЕРЕННЫЕ */}
        {tested.length > 0 && (
          <>
            <div className="ga-sec-h">Проверено <span className="da-count">{tested.length}</span></div>
            {tested.slice(-10).reverse().map((h) => (
              <div key={h.id} className="ga-tested">
                <span className={'ga-res ' + h.result}>{h.result === 'worked' ? '✓ сработало' : h.result === 'failed' ? '✗ не сработало' : '~ частично'}</span>
                <span className="ga-tested-cause">{h.cause}</span>
                {h.resultNote && <span className="ga-tested-note"> — {h.resultNote}</span>}
              </div>
            ))}
          </>
        )}

        {/* ИСТОЧНИКИ */}
        {sources.length > 0 && (
          <>
            <div className="ga-sec-h">Использованные источники <span className="da-count">{sources.length}</span></div>
            <div className="ga-sources">
              {sources.slice(-16).reverse().map((s, i) => (
                <a key={i} className="ga-source" href={s.url} target="_blank" rel="noopener noreferrer" title={s.query || ''}>{s.title || s.url}</a>
              ))}
            </div>
          </>
        )}
      </div>
      {toast && <div className="da-toast">{toast}</div>}
    </div>
  )
}
