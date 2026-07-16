import React, { useEffect, useRef, useState } from 'react'
import { auth } from '../lib/api.js'
import { setSession } from '../lib/session.js'

// Экран входа — 1:1 перенос из public/index.html (#loginScreen).
// Шаги: roles → rop | mop | demo | admin. Роутинг по роли делает App через onLoggedIn.
export default function Login({ onLoggedIn }) {
  const [step, setStep] = useState('roles') // roles | rop | mop | admin | demo | client
  const [loginError, setLoginError] = useState('') // общий (демо/админ)
  const [ropErr, setRopErr] = useState('')
  const [mopErr, setMopErr] = useState('')
  const [clientErr, setClientErr] = useState('')
  const [passType, setPassType] = useState('password')
  const [remember, setRemember] = useState(false)
  const [loginBtnText, setLoginBtnText] = useState('Войти')
  const [loginBtnDisabled, setLoginBtnDisabled] = useState(false)

  const ropCodeRef = useRef(null)
  const mopLoginRef = useRef(null)
  const mopPassRef = useRef(null)
  const demoCodeRef = useRef(null)
  const passRef = useRef(null)
  const clientLoginRef = useRef(null)
  const clientPassRef = useRef(null)

  const isMopDirect = (() => {
    try { return new URLSearchParams(location.search).get('mop') === '1' } catch (e) { return false }
  })()

  // ?mop=1 — сразу форма входа МОПа, без выбора роли
  useEffect(() => {
    if (isMopDirect) setStep('mop')
  }, [isMopDirect])

  // фокус на активном инпуте (как setTimeout(...,100) в оригинале)
  useEffect(() => {
    const t = setTimeout(() => {
      if (step === 'rop') ropCodeRef.current?.focus()
      else if (step === 'mop') mopLoginRef.current?.focus()
      else if (step === 'client') clientLoginRef.current?.focus()
      else if (step === 'admin') passRef.current?.focus()
    }, 100)
    return () => clearTimeout(t)
  }, [step])

  function backToRoles() {
    setStep('roles')
    setLoginError('')
  }

  function chooseAdmin() {
    setStep('admin')
    setLoginError('')
    const saved = localStorage.getItem('hp_admin_pass')
    if (saved) {
      if (passRef.current) passRef.current.value = saved
      setRemember(true)
    }
  }

  function togglePass() {
    setPassType((t) => (t === 'password' ? 'text' : 'password'))
  }

  async function ropLogin() {
    const code = (ropCodeRef.current?.value || '').trim()
    if (!code) { setRopErr('Введите код'); return }
    setRopErr('')
    try {
      const d = await auth.rop(code)
      if (d && d.ok) {
        setSession(d.session, { role: d.role || 'rop', org: d.org || 'hunter' })
        onLoggedIn({ role: d.role || 'rop', org: d.org || 'hunter' })
      } else {
        setRopErr((d && d.error) || 'Неверный код')
      }
    } catch (e) { setRopErr('Нет связи с сервером') }
  }

  async function mopLoginGo() {
    const login = (mopLoginRef.current?.value || '').trim()
    const password = mopPassRef.current?.value || ''
    if (!login || !password) { setMopErr('Введите логин и пароль'); return }
    setMopErr('')
    try {
      const d = await auth.mop(login, password)
      if (d && d.ok) {
        setSession(d.session, { role: 'mop', org: d.org || '', mopId: d.mopId, mopName: d.mopName })
        onLoggedIn({ role: 'mop', org: d.org || '' })
      } else {
        setMopErr((d && d.error) || 'Ошибка входа')
      }
    } catch (e) { setMopErr('Нет связи с сервером') }
  }

  async function clientLoginGo() {
    const login = (clientLoginRef.current?.value || '').trim()
    const password = clientPassRef.current?.value || ''
    if (!login || !password) { setClientErr('Введите логин и пароль'); return }
    setClientErr('')
    try {
      const d = await auth.client(login, password)
      if (d && d.ok) {
        setSession(d.session, { role: d.role || 'admin', org: d.org || '', clientName: d.clientName })
        onLoggedIn({ role: d.role || 'admin', org: d.org || '' })
      } else {
        setClientErr((d && d.error) || 'Неверный логин или пароль')
      }
    } catch (e) { setClientErr('Нет связи с сервером') }
  }

  async function demoLoginGo() {
    const code = (demoCodeRef.current?.value || '').trim()
    if (!code) { setLoginError('Введите код'); return }
    setLoginError('')
    try {
      const d = await auth.demo(code)
      if (d && d.ok) {
        setSession(d.session, { role: d.role || 'demo', org: d.org || '', demoName: d.demoName })
        onLoggedIn({ role: d.role || 'demo', org: d.org || '' })
      } else {
        setLoginError((d && d.error) || 'Ошибка входа в демо')
      }
    } catch (e) { setLoginError('Нет связи с сервером') }
  }

  async function doLogin(e) {
    if (e) e.preventDefault()
    const password = passRef.current?.value || ''
    if (!password) { setLoginError('Введите пароль'); return }
    setLoginBtnText('Вход...'); setLoginBtnDisabled(true); setLoginError('')
    try {
      const d = await auth.admin(password)
      if (d && d.ok) {
        setSession(d.session, { role: d.role || 'admin', org: d.org || 'hunter' })
        if (remember) localStorage.setItem('hp_admin_pass', password)
        else localStorage.removeItem('hp_admin_pass')
        onLoggedIn({ role: d.role || 'admin', org: d.org || 'hunter' })
      } else {
        setLoginError((d && d.error) || 'Ошибка входа')
        setLoginBtnText('Войти'); setLoginBtnDisabled(false)
      }
    } catch (err) {
      setLoginError('Нет связи с сервером')
      setLoginBtnText('Войти'); setLoginBtnDisabled(false)
    }
  }

  const inputStyle = {
    width: '100%', padding: '13px 15px', borderRadius: 11, border: '1px solid var(--line2)',
    background: 'var(--card)', color: 'var(--txt)', fontSize: 15,
  }

  return (
    <div id="loginScreen" style={{ position: 'fixed', inset: 0, zIndex: 500, background: 'radial-gradient(1200px 600px at 50% -10%, var(--accent-bg) 0%, transparent 55%), linear-gradient(160deg, var(--bg2) 0%, var(--bg) 60%)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, overflow: 'hidden' }}>
      <div style={{ position: 'absolute', top: -120, right: -100, width: 340, height: 340, borderRadius: '50%', background: 'var(--accent)', opacity: 0.10, filter: 'blur(70px)' }} />
      <div style={{ position: 'absolute', bottom: -140, left: -110, width: 360, height: 360, borderRadius: '50%', background: 'var(--gold)', opacity: 0.08, filter: 'blur(80px)' }} />
      <div style={{ width: '100%', maxWidth: 360, position: 'relative', zIndex: 2 }}>
        <div style={{ textAlign: 'center', marginBottom: 26 }}>
          <div style={{ width: 56, height: 56, borderRadius: 15, background: 'var(--accent-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
            <svg className="ic" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20L20 4M7 4H4v3M17 20h3v-3M12 12l4-1-1 4z" /></svg>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>Hunter AI</div>
          <div style={{ fontSize: 13, color: 'var(--txt2)', marginTop: 3 }}>Выберите вход</div>
        </div>

        {/* Шаг 1: выбор роли */}
        {step === 'roles' && (
          <div id="roleChoice">
            <button onClick={chooseAdmin} style={{ width: '100%', padding: 16, borderRadius: 12, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', marginBottom: 12 }} className="ic-btn">
              <svg className="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M4 8l3 3 5-6 5 6 3-3-2 11H6z" /></svg>Я администратор
            </button>
            <button onClick={() => setStep('rop')} style={{ width: '100%', padding: 16, borderRadius: 12, background: 'var(--card)', border: '1px solid var(--line2)', color: 'var(--txt)', fontSize: 15, fontWeight: 600, cursor: 'pointer' }} className="ic-btn">
              <svg className="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" /></svg>Я РОП (руководитель отдела)
            </button>
            <button onClick={() => setStep('mop')} style={{ width: '100%', padding: 16, borderRadius: 12, background: 'var(--card)', border: '1px solid var(--line2)', color: 'var(--txt)', fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 12 }} className="ic-btn">
              <svg className="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></svg>Я менеджер (МОП)
            </button>
            <button onClick={() => { setStep('client'); setClientErr('') }} style={{ width: '100%', padding: 16, borderRadius: 12, background: 'var(--card)', border: '1px solid var(--line2)', color: 'var(--txt)', fontSize: 15, fontWeight: 600, cursor: 'pointer', marginTop: 12 }} className="ic-btn">
              <svg className="ic" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 21h18M5 21V7l7-4 7 4v14M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01" /></svg>Я владелец бизнеса (клиент)
            </button>
            <div style={{ fontSize: 11.5, color: 'var(--txt3)', marginTop: 14, textAlign: 'center', lineHeight: 1.5 }}>Владелец — дашборд своей компании по логину.<br />РОП — дашборд и задачи. МОП — свой кабинет.</div>
            <div style={{ textAlign: 'center', marginTop: 18 }}>
              <button onClick={() => { setStep('demo'); setLoginError('') }} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 13, cursor: 'pointer', textDecoration: 'underline' }}>Войти в демо по коду</button>
            </div>
          </div>
        )}

        {/* Вход РОПа по коду */}
        {step === 'rop' && (
          <div id="ropLogin">
            <input ref={ropCodeRef} type="password" inputMode="numeric" placeholder="Код доступа РОПа"
              onKeyDown={(e) => { if (e.key === 'Enter') ropLogin() }}
              style={{ ...inputStyle, marginBottom: 12, textAlign: 'center', letterSpacing: 2 }} />
            <button onClick={ropLogin} style={{ width: '100%', padding: 14, borderRadius: 11, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Войти</button>
            {ropErr && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 10, textAlign: 'center' }}>{ropErr}</div>}
            <button onClick={backToRoles} style={{ width: '100%', padding: 11, borderRadius: 11, background: 'none', border: 'none', color: 'var(--txt2)', fontSize: 13, cursor: 'pointer', marginTop: 8 }}>← Назад</button>
          </div>
        )}

        {/* Вход МОПа */}
        {step === 'mop' && (
          <div id="mopLogin">
            <input ref={mopLoginRef} type="text" placeholder="Логин" autoComplete="username" style={{ ...inputStyle, marginBottom: 10 }} />
            <input ref={mopPassRef} type="password" placeholder="Пароль" autoComplete="current-password"
              onKeyDown={(e) => { if (e.key === 'Enter') mopLoginGo() }}
              style={{ ...inputStyle, marginBottom: 12 }} />
            <button onClick={mopLoginGo} style={{ width: '100%', padding: 14, borderRadius: 11, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Войти</button>
            {mopErr && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 10, textAlign: 'center' }}>{mopErr}</div>}
            {!isMopDirect && (
              <button onClick={backToRoles} style={{ width: '100%', padding: 11, borderRadius: 11, background: 'none', border: 'none', color: 'var(--txt2)', fontSize: 13, cursor: 'pointer', marginTop: 8 }}>← Назад</button>
            )}
          </div>
        )}

        {/* Вход клиента-владельца (логин + пароль из реестра clients:list) */}
        {step === 'client' && (
          <div id="clientLogin">
            <input ref={clientLoginRef} type="text" placeholder="Логин" autoComplete="username" style={{ ...inputStyle, marginBottom: 10 }} />
            <input ref={clientPassRef} type="password" placeholder="Пароль" autoComplete="current-password"
              onKeyDown={(e) => { if (e.key === 'Enter') clientLoginGo() }}
              style={{ ...inputStyle, marginBottom: 12 }} />
            <button onClick={clientLoginGo} style={{ width: '100%', padding: 14, borderRadius: 11, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Войти</button>
            {clientErr && <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 10, textAlign: 'center' }}>{clientErr}</div>}
            <button onClick={backToRoles} style={{ width: '100%', padding: 11, borderRadius: 11, background: 'none', border: 'none', color: 'var(--txt2)', fontSize: 13, cursor: 'pointer', marginTop: 8 }}>← Назад</button>
          </div>
        )}

        {/* Вход в демо по коду */}
        {step === 'demo' && (
          <div id="demoLogin">
            <input ref={demoCodeRef} type="text" inputMode="numeric" placeholder="Код демо-доступа (6 цифр)"
              onKeyDown={(e) => { if (e.key === 'Enter') demoLoginGo() }}
              style={{ ...inputStyle, marginBottom: 12, textAlign: 'center', letterSpacing: 2 }} />
            <button onClick={demoLoginGo} style={{ width: '100%', padding: 14, borderRadius: 11, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>Войти в демо</button>
            <button onClick={backToRoles} style={{ width: '100%', padding: 11, borderRadius: 11, background: 'none', border: 'none', color: 'var(--txt2)', fontSize: 13, cursor: 'pointer', marginTop: 8 }}>← Назад</button>
          </div>
        )}

        {/* Шаг 2: пароль админа */}
        {step === 'admin' && (
          <div id="adminLogin">
            <form onSubmit={doLogin} autoComplete="on">
              <input type="text" name="username" defaultValue="admin" autoComplete="username" style={{ display: 'none' }} readOnly />
              <div style={{ position: 'relative' }}>
                <input ref={passRef} type={passType} name="password" placeholder="Пароль администратора" autoComplete="current-password"
                  style={{ width: '100%', padding: '13px 42px 13px 15px', borderRadius: 11, border: '1px solid var(--line2)', background: 'var(--card)', color: 'var(--txt)', fontSize: 15, marginBottom: 12 }} />
                <button type="button" onClick={togglePass} title="Показать пароль"
                  style={{ position: 'absolute', right: 10, top: 11, background: 'none', border: 'none', color: 'var(--txt3)', fontSize: 17, cursor: 'pointer', padding: 0 }}>{passType === 'password' ? '👁' : '🙈'}</button>
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--txt2)', marginBottom: 14, cursor: 'pointer' }}>
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                Запомнить пароль на этом устройстве
              </label>
              <button type="submit" disabled={loginBtnDisabled}
                style={{ width: '100%', padding: 14, borderRadius: 11, background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer' }}>{loginBtnText}</button>
            </form>
            <button onClick={backToRoles} style={{ width: '100%', padding: 11, borderRadius: 11, background: 'none', border: 'none', color: 'var(--txt2)', fontSize: 13, cursor: 'pointer', marginTop: 8 }}>← Назад</button>
          </div>
        )}

        <div id="loginError" style={{ fontSize: 13, color: 'var(--red)', marginTop: 14, textAlign: 'center', minHeight: 18 }}>{loginError}</div>
      </div>
    </div>
  )
}
