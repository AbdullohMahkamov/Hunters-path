import React, { useEffect, useRef, useState } from 'react'
import { support } from '../lib/api.js'
import { getRole } from '../lib/session.js'

// Панель саппорта — изолированный инструмент (НЕ часть ALTRONE). Три вкладки:
// «Новая отправка» / «Отправки» / «Шаблоны» (+ «Саппорты» для админа).
// Отправка оферты/правил ученикам через отдельного Telegram-бота, учёт подтверждений.

const C = {
  card: 'var(--card)', line: 'var(--line2)', txt: 'var(--txt)', txt2: 'var(--txt2)', txt3: 'var(--txt3)',
  accent: 'var(--accent)', red: 'var(--red)', green: '#22c55e', gold: 'var(--gold)', bg: 'var(--bg)',
}
const inp = { width: '100%', padding: '11px 13px', borderRadius: 10, border: `1px solid ${C.line}`, background: C.bg, color: C.txt, fontSize: 14, boxSizing: 'border-box' }
const btn = (bg = C.accent, color = '#fff') => ({ padding: '11px 16px', borderRadius: 10, background: bg, border: 'none', color, fontSize: 14, fontWeight: 600, cursor: 'pointer' })

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = reject
    r.readAsDataURL(file)
  })
}
function fmtDate(ts) { if (!ts) return '—'; try { return new Date(ts + 5 * 3600000).toISOString().replace('T', ' ').slice(0, 16) } catch (e) { return '—' } }
const STATUS = { created: { label: 'создана', color: C.txt3 }, opened: { label: 'открыл бот', color: C.gold }, confirmed: { label: 'подтвердил', color: C.green } }

export default function Support({ onLogout }) {
  const isAdmin = getRole() === 'admin'
  const [tab, setTab] = useState('new')
  const [templates, setTemplates] = useState({ defaultText: '', offer: null, rules: null })

  useEffect(() => { support.templatesGet().then((d) => { if (d && d.ok) setTemplates(d.templates) }) }, [])

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', color: C.txt }}>
      <div style={{ maxWidth: 860, margin: '0 auto', padding: '20px 16px 60px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 700 }}>Панель саппорта</div>
            <div style={{ fontSize: 12.5, color: C.txt2, marginTop: 2 }}>Отправка документов ученикам и учёт подтверждений</div>
          </div>
          <button onClick={onLogout} style={{ ...btn(C.card, C.txt2), border: `1px solid ${C.line}` }}>Выйти</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          {[['new', 'Новая отправка'], ['list', 'Отправки'], ['tpl', 'Шаблоны'], ...(isAdmin ? [['acc', 'Саппорты']] : [])].map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              style={{ ...btn(tab === k ? C.accent : C.card, tab === k ? '#fff' : C.txt2), border: tab === k ? 'none' : `1px solid ${C.line}` }}>{label}</button>
          ))}
        </div>

        {tab === 'new' && <NewSend templates={templates} />}
        {tab === 'list' && <SendList />}
        {tab === 'tpl' && <Templates templates={templates} onSaved={setTemplates} />}
        {tab === 'acc' && isAdmin && <><BotCard /><Accounts /></>}
      </div>
    </div>
  )
}

// ─────────── Вкладка 1: Новая отправка ───────────
function NewSend({ templates }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [phone, setPhone] = useState('')
  const [docKeys, setDocKeys] = useState({ offer: true, rules: true })
  const [message, setMessage] = useState('')
  const [custom, setCustom] = useState(null) // { base64, name }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const fileRef = useRef(null)

  useEffect(() => { setMessage(templates.defaultText || '') }, [templates.defaultText])

  async function onFile(e) {
    const f = e.target.files && e.target.files[0]
    if (!f) { setCustom(null); return }
    setCustom({ base64: await fileToBase64(f), name: f.name })
  }

  async function generate() {
    setErr(''); setLink(''); setCopied(false)
    if (!firstName.trim() || !phone.trim()) { setErr('Заполните имя и телефон'); return }
    const keys = Object.keys(docKeys).filter((k) => docKeys[k] && templates[k])
    if (!keys.length && !custom) { setErr('Выберите хотя бы один документ или приложите файл'); return }
    setBusy(true)
    try {
      const d = await support.create({ firstName, lastName, phone, docKeys: keys, customFile: custom, message })
      if (d && d.ok) { setLink(d.link); setFirstName(''); setLastName(''); setPhone(''); setCustom(null); if (fileRef.current) fileRef.current.value = '' }
      else setErr((d && d.error) || 'Не удалось создать ссылку')
    } catch (e) { setErr('Нет связи с сервером') }
    setBusy(false)
  }

  async function copyLink() { try { await navigator.clipboard.writeText(link); setCopied(true) } catch (e) {} }

  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }
  return (
    <div style={card}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <input style={inp} placeholder="Имя" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        <input style={inp} placeholder="Фамилия" value={lastName} onChange={(e) => setLastName(e.target.value)} />
      </div>
      <input style={{ ...inp, marginBottom: 14 }} placeholder="Телефон" value={phone} onChange={(e) => setPhone(e.target.value)} />

      <div style={{ fontSize: 13, fontWeight: 600, color: C.txt2, marginBottom: 8 }}>Документы</div>
      {['offer', 'rules'].map((k) => (
        <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, opacity: templates[k] ? 1 : 0.45, cursor: templates[k] ? 'pointer' : 'not-allowed' }}>
          <input type="checkbox" disabled={!templates[k]} checked={!!docKeys[k] && !!templates[k]} onChange={(e) => setDocKeys((s) => ({ ...s, [k]: e.target.checked }))} style={{ width: 16, height: 16 }} />
          <span style={{ fontSize: 14 }}>{k === 'offer' ? 'Оферта' : 'Правила обучения'}{templates[k] ? ` — ${templates[k].name} (в.${templates[k].version})` : ' — не загружен'}</span>
        </label>
      ))}
      <div style={{ marginTop: 8, marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, color: C.txt3, marginBottom: 6 }}>Файл-исключение (необязательно):</div>
        <input ref={fileRef} type="file" onChange={onFile} style={{ fontSize: 13, color: C.txt2 }} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: C.txt2, marginBottom: 6 }}>Текст сообщения ученику</div>
      <textarea style={{ ...inp, minHeight: 90, resize: 'vertical', marginBottom: 14 }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Текст, который увидит ученик" />

      <button onClick={generate} disabled={busy} style={{ ...btn(), opacity: busy ? 0.6 : 1 }}>{busy ? 'Создаю…' : 'Сгенерировать ссылку'}</button>
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
      {link && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: C.bg, border: `1px solid ${C.line}` }}>
          <div style={{ fontSize: 12.5, color: C.txt3, marginBottom: 6 }}>Персональная ссылка (отправьте ученику):</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input readOnly value={link} style={{ ...inp, fontSize: 13 }} onFocus={(e) => e.target.select()} />
            <button onClick={copyLink} style={btn(copied ? C.green : C.accent)}>{copied ? 'Скопировано' : 'Копировать'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────── Вкладка 2: Отправки ───────────
function SendList() {
  const [items, setItems] = useState([])
  const [status, setStatus] = useState('all')
  const [phone, setPhone] = useState('')
  const [loading, setLoading] = useState(false)

  async function load() {
    setLoading(true)
    try { const d = await support.list({ status, phone }); if (d && d.ok) setItems(d.items) } catch (e) {}
    setLoading(false)
  }
  useEffect(() => { load() }, [status]) // eslint-disable-line

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ ...inp, width: 'auto' }}>
          <option value="all">Все статусы</option>
          <option value="created">Создана</option>
          <option value="opened">Открыл бот</option>
          <option value="confirmed">Подтвердил</option>
        </select>
        <input style={{ ...inp, width: 200 }} placeholder="Поиск по телефону" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load() }} />
        <button onClick={load} style={btn()}>{loading ? '…' : 'Найти'}</button>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 620 }}>
            <thead>
              <tr style={{ color: C.txt3, textAlign: 'left' }}>
                {['Ученик', 'Телефон', 'Статус', 'Создана', 'Подтвердил', 'Саппорт'].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={6} style={{ padding: 18, color: C.txt3, textAlign: 'center' }}>{loading ? 'Загрузка…' : 'Пусто'}</td></tr>}
              {items.map((r) => {
                const st = STATUS[r.status] || { label: r.status, color: C.txt3 }
                return (
                  <tr key={r.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                    <td style={{ padding: '10px 12px' }}>{`${r.firstName || ''} ${r.lastName || ''}`.trim() || '—'}</td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>{r.phone || '—'}</td>
                    <td style={{ padding: '10px 12px' }}><span style={{ color: st.color, fontWeight: 600 }}>● {st.label}</span></td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: C.txt2 }}>{fmtDate(r.createdAt)}</td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap', color: C.txt2 }}>{fmtDate(r.confirmedAt)}</td>
                    <td style={{ padding: '10px 12px', color: C.txt2 }}>{r.supportName || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

// ─────────── Вкладка 3: Шаблоны ───────────
function Templates({ templates, onSaved }) {
  const [defaultText, setDefaultText] = useState(templates.defaultText || '')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const offerRef = useRef(null)
  const rulesRef = useRef(null)

  useEffect(() => { setDefaultText(templates.defaultText || '') }, [templates.defaultText])

  async function save(key) {
    setBusy(true); setMsg('')
    try {
      const payload = { defaultText }
      if (key) {
        const ref = key === 'offer' ? offerRef : rulesRef
        const f = ref.current && ref.current.files && ref.current.files[0]
        if (!f) { setMsg('Выберите файл'); setBusy(false); return }
        payload.key = key; payload.base64 = await fileToBase64(f); payload.fileName = f.name
      }
      const d = await support.templatesSet(payload)
      if (d && d.ok) { onSaved(d.templates); setMsg('Сохранено'); if (offerRef.current) offerRef.current.value = ''; if (rulesRef.current) rulesRef.current.value = '' }
      else setMsg((d && d.error) || 'Ошибка')
    } catch (e) { setMsg('Нет связи с сервером') }
    setBusy(false)
  }

  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 14 }
  const Row = ({ k, title, ref_ }) => (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: C.txt3, marginBottom: 10 }}>
        {templates[k] ? `Загружен: ${templates[k].name} · версия ${templates[k].version} · ${fmtDate(templates[k].updatedAt)}` : 'Пока не загружен'}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={ref_} type="file" style={{ fontSize: 13, color: C.txt2 }} />
        <button onClick={() => save(k)} disabled={busy} style={btn()}>{templates[k] ? 'Заменить' : 'Загрузить'}</button>
      </div>
    </div>
  )

  return (
    <div>
      <Row k="offer" title="Оферта" ref_={offerRef} />
      <Row k="rules" title="Правила обучения" ref_={rulesRef} />
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Текст сообщения по умолчанию</div>
        <textarea style={{ ...inp, minHeight: 90, resize: 'vertical', marginBottom: 12 }} value={defaultText} onChange={(e) => setDefaultText(e.target.value)} />
        <button onClick={() => save(null)} disabled={busy} style={btn()}>Сохранить текст</button>
      </div>
      {msg && <div style={{ fontSize: 13, color: msg === 'Сохранено' ? C.green : C.red }}>{msg}</div>}
    </div>
  )
}

// ─────────── Бот учеников: статус + настройка вебхука (только админ) ───────────
function BotCard() {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function loadStatus() { try { const d = await support.botStatus(); setSt(d) } catch (e) { setSt({ ok: false, error: 'нет связи' }) } }
  useEffect(() => { loadStatus() }, [])

  async function setup() {
    setBusy(true); setMsg('')
    try { const d = await support.botSetup(); setMsg(d && d.ok ? 'Вебхук настроен ✓' : ('Ошибка: ' + ((d && (d.error || d.detail)) || '—'))); await loadStatus() }
    catch (e) { setMsg('Нет связи с сервером') }
    setBusy(false)
  }

  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 14 }
  const uname = st && st.username
  const hookUrl = st && st.webhook && st.webhook.url
  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Бот для учеников</div>
      {!st && <div style={{ fontSize: 13, color: C.txt3 }}>Проверяю…</div>}
      {st && st.error && <div style={{ fontSize: 13, color: C.red }}>Не удалось проверить: {st.error}. Проверьте, что задан TELEGRAM_SUPPORT_BOT_TOKEN.</div>}
      {st && !st.error && (
        <div style={{ fontSize: 13, color: C.txt2, lineHeight: 1.7 }}>
          Бот: {uname ? <b>@{uname}</b> : <span style={{ color: C.txt3 }}>токен не задан</span>}<br />
          Вебхук: {hookUrl ? <span style={{ color: C.green }}>подключён</span> : <span style={{ color: C.gold }}>не настроен</span>}
        </div>
      )}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={setup} disabled={busy} style={{ ...btn(), opacity: busy ? 0.6 : 1 }}>{busy ? '…' : (hookUrl ? 'Перенастроить вебхук' : 'Настроить бота')}</button>
        <button onClick={loadStatus} style={{ ...btn(C.card, C.txt2), border: `1px solid ${C.line}` }}>Обновить</button>
      </div>
      {msg && <div style={{ fontSize: 13, color: msg.includes('✓') ? C.green : C.red, marginTop: 10 }}>{msg}</div>}
    </div>
  )
}

// ─────────── Вкладка 4: Саппорты (только админ) ───────────
function Accounts() {
  const [list, setList] = useState([])
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')

  async function load() { try { const d = await support.accountsList(); if (d && d.ok) setList(d.accounts) } catch (e) {} }
  useEffect(() => { load() }, [])

  async function add() {
    setMsg('')
    if (!login.trim() || !password) { setMsg('Нужны логин и пароль'); return }
    const d = await support.accountAdd({ login, password, name })
    if (d && d.ok) { setLogin(''); setPassword(''); setName(''); load() } else setMsg((d && d.error) || 'Ошибка')
  }
  async function del(l) { if (!confirm(`Удалить саппорта «${l}»?`)) return; await support.accountDel(l); load() }

  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }
  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Учётные записи саппорта</div>
      {list.length === 0 && <div style={{ fontSize: 13, color: C.txt3, marginBottom: 12 }}>Пока нет ни одного саппорта.</div>}
      {list.map((a) => (
        <div key={a.login} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${C.line}` }}>
          <div style={{ fontSize: 14 }}><b>{a.login}</b>{a.name && a.name !== a.login ? <span style={{ color: C.txt3 }}> — {a.name}</span> : null}</div>
          <button onClick={() => del(a.login)} style={{ ...btn('transparent', C.red), border: `1px solid ${C.line}`, padding: '6px 12px', fontSize: 13 }}>Удалить</button>
        </div>
      ))}
      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, alignItems: 'center' }}>
        <input style={inp} placeholder="Логин" value={login} onChange={(e) => setLogin(e.target.value)} />
        <input style={inp} placeholder="Пароль" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input style={inp} placeholder="Имя (необяз.)" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={add} style={btn()}>Добавить</button>
      </div>
      {msg && <div style={{ fontSize: 13, color: C.red, marginTop: 10 }}>{msg}</div>}
    </div>
  )
}
