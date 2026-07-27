import React, { useEffect, useRef, useState } from 'react'
import { support } from '../lib/api.js'
import { getRole } from '../lib/session.js'

// Qo'llab-quvvatlash paneli — alohida, mustaqil vosita (ALTRONE tarkibiga kirmaydi). Uch bo'lim:
// «Yangi yuborish» / «Yuborilganlar» / «Shablonlar» (+ admin uchun «Operatorlar»).
// O'quvchilarga oferta/qoidalarni alohida Telegram-bot orqali yuborish va tasdiqlarni hisobga olish.
// Интерфейс полностью на узбекской латинице (C1). Internal-логика/ключи не переводятся.

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
// Telefon faqat +998XXXXXXXXX ko'rinishida. Kiritilgan raqamni shu ko'rinishga keltiradi yoki null qaytaradi.
function normUzPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.startsWith('998')) d = d.slice(3)
  return d.length === 9 ? '+998' + d : null
}
const STATUS = { created: { label: 'yaratilgan', color: C.txt3 }, opened: { label: 'botni ochdi', color: C.gold }, confirmed: { label: 'tasdiqladi', color: C.green } }

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
            <div style={{ fontSize: 19, fontWeight: 700 }}>Qo'llab-quvvatlash paneli</div>
            <div style={{ fontSize: 12.5, color: C.txt2, marginTop: 2 }}>O'quvchilarga hujjat yuborish va tasdiqlarni hisobga olish</div>
          </div>
          <button onClick={onLogout} style={{ ...btn(C.card, C.txt2), border: `1px solid ${C.line}` }}>Chiqish</button>
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
          {[['new', 'Yangi yuborish'], ['list', 'Yuborilganlar'], ['tpl', 'Shablonlar'], ...(isAdmin ? [['acc', 'Operatorlar']] : [])].map(([k, label]) => (
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

// ─────────── 1-bo'lim: Yangi yuborish ───────────
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
    if (!firstName.trim()) { setErr('Ismni to\'ldiring'); return }
    const nPhone = normUzPhone(phone)
    if (!nPhone) { setErr('Telefon raqami +998XXXXXXXXX ko\'rinishida bo\'lishi kerak (masalan, +998933957755)'); return }
    const keys = Object.keys(docKeys).filter((k) => docKeys[k] && templates[k])
    if (!keys.length && !custom) { setErr('Kamida bitta hujjat tanlang yoki fayl biriktiring'); return }
    setBusy(true)
    try {
      const d = await support.create({ firstName, lastName, phone: nPhone, docKeys: keys, customFile: custom, message })
      if (d && d.ok) { setLink(d.link); setFirstName(''); setLastName(''); setPhone(''); setCustom(null); if (fileRef.current) fileRef.current.value = '' }
      else setErr((d && d.error) || 'Havola yaratib bo\'lmadi')
    } catch (e) { setErr('Server bilan aloqa yo\'q') }
    setBusy(false)
  }

  async function copyLink() { try { await navigator.clipboard.writeText(link); setCopied(true) } catch (e) {} }

  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }
  return (
    <div style={card}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
        <input style={inp} placeholder="Ism" value={firstName} onChange={(e) => setFirstName(e.target.value)} />
        <input style={inp} placeholder="Familiya" value={lastName} onChange={(e) => setLastName(e.target.value)} />
      </div>
      <input style={{ ...inp, marginBottom: 14 }} placeholder="Telefon: +998933957755" value={phone} onChange={(e) => setPhone(e.target.value)} />

      <div style={{ fontSize: 13, fontWeight: 600, color: C.txt2, marginBottom: 8 }}>Hujjatlar</div>
      {['offer', 'rules'].map((k) => (
        <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, opacity: templates[k] ? 1 : 0.45, cursor: templates[k] ? 'pointer' : 'not-allowed' }}>
          <input type="checkbox" disabled={!templates[k]} checked={!!docKeys[k] && !!templates[k]} onChange={(e) => setDocKeys((s) => ({ ...s, [k]: e.target.checked }))} style={{ width: 16, height: 16 }} />
          <span style={{ fontSize: 14 }}>{k === 'offer' ? 'Oferta' : 'O\'qish qoidalari'}{templates[k] ? ` — ${templates[k].name} (v.${templates[k].version})` : ' — yuklanmagan'}</span>
        </label>
      ))}
      <div style={{ marginTop: 8, marginBottom: 14 }}>
        <div style={{ fontSize: 12.5, color: C.txt3, marginBottom: 6 }}>Istisno fayl (ixtiyoriy):</div>
        <input ref={fileRef} type="file" onChange={onFile} style={{ fontSize: 13, color: C.txt2 }} />
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: C.txt2, marginBottom: 6 }}>O'quvchiga xabar matni</div>
      <textarea style={{ ...inp, minHeight: 90, resize: 'vertical', marginBottom: 14 }} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="O'quvchi ko'radigan matn" />

      <button onClick={generate} disabled={busy} style={{ ...btn(), opacity: busy ? 0.6 : 1 }}>{busy ? 'Yaratilmoqda…' : 'Havola yaratish'}</button>
      {err && <div style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{err}</div>}
      {link && (
        <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: C.bg, border: `1px solid ${C.line}` }}>
          <div style={{ fontSize: 12.5, color: C.txt3, marginBottom: 6 }}>Shaxsiy havola (o'quvchiga yuboring):</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input readOnly value={link} style={{ ...inp, fontSize: 13 }} onFocus={(e) => e.target.select()} />
            <button onClick={copyLink} style={btn(copied ? C.green : C.accent)}>{copied ? 'Nusxalandi' : 'Nusxalash'}</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─────────── 2-bo'lim: Yuborilganlar ───────────
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
          <option value="all">Barcha holatlar</option>
          <option value="created">Yaratilgan</option>
          <option value="opened">Botni ochdi</option>
          <option value="confirmed">Tasdiqladi</option>
        </select>
        <input style={{ ...inp, width: 200 }} placeholder="Telefon bo'yicha qidirish" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') load() }} />
        <button onClick={load} style={btn()}>{loading ? '…' : 'Qidirish'}</button>
      </div>

      <div style={{ background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5, minWidth: 620 }}>
            <thead>
              <tr style={{ color: C.txt3, textAlign: 'left' }}>
                {['O\'quvchi', 'Telefon', 'Holat', 'Yaratilgan', 'Tasdiqladi', 'Operator'].map((h) => (
                  <th key={h} style={{ padding: '10px 12px', fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && <tr><td colSpan={6} style={{ padding: 18, color: C.txt3, textAlign: 'center' }}>{loading ? 'Yuklanmoqda…' : 'Bo\'sh'}</td></tr>}
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

// ─────────── 3-bo'lim: Shablonlar ───────────
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
        if (!f) { setMsg('Fayl tanlang'); setBusy(false); return }
        payload.key = key; payload.base64 = await fileToBase64(f); payload.fileName = f.name
      }
      const d = await support.templatesSet(payload)
      if (d && d.ok) { onSaved(d.templates); setMsg('Saqlandi'); if (offerRef.current) offerRef.current.value = ''; if (rulesRef.current) rulesRef.current.value = '' }
      else setMsg((d && d.error) || 'Xatolik')
    } catch (e) { setMsg('Server bilan aloqa yo\'q') }
    setBusy(false)
  }

  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 14 }
  const Row = ({ k, title, ref_ }) => (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: C.txt3, marginBottom: 10 }}>
        {templates[k] ? `Yuklangan: ${templates[k].name} · versiya ${templates[k].version} · ${fmtDate(templates[k].updatedAt)}` : 'Hali yuklanmagan'}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={ref_} type="file" style={{ fontSize: 13, color: C.txt2 }} />
        <button onClick={() => save(k)} disabled={busy} style={btn()}>{templates[k] ? 'Almashtirish' : 'Yuklash'}</button>
      </div>
    </div>
  )

  return (
    <div>
      <Row k="offer" title="Oferta" ref_={offerRef} />
      <Row k="rules" title="O'qish qoidalari" ref_={rulesRef} />
      <div style={card}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>Standart xabar matni</div>
        <textarea style={{ ...inp, minHeight: 90, resize: 'vertical', marginBottom: 12 }} value={defaultText} onChange={(e) => setDefaultText(e.target.value)} />
        <button onClick={() => save(null)} disabled={busy} style={btn()}>Matnni saqlash</button>
      </div>
      {msg && <div style={{ fontSize: 13, color: msg === 'Saqlandi' ? C.green : C.red }}>{msg}</div>}
    </div>
  )
}

// ─────────── O'quvchilar uchun bot: holat + vebhukni sozlash (faqat admin) ───────────
function BotCard() {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  async function loadStatus() { try { const d = await support.botStatus(); setSt(d) } catch (e) { setSt({ ok: false, error: 'aloqa yo\'q' }) } }
  useEffect(() => { loadStatus() }, [])

  async function setup() {
    setBusy(true); setMsg('')
    try { const d = await support.botSetup(); setMsg(d && d.ok ? 'Vebhuk sozlandi ✓' : ('Xatolik: ' + ((d && (d.error || d.detail)) || '—'))); await loadStatus() }
    catch (e) { setMsg('Server bilan aloqa yo\'q') }
    setBusy(false)
  }

  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18, marginBottom: 14 }
  const uname = st && st.username
  const hookUrl = st && st.webhook && st.webhook.url
  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>O'quvchilar uchun bot</div>
      {!st && <div style={{ fontSize: 13, color: C.txt3 }}>Tekshirilmoqda…</div>}
      {st && st.error && <div style={{ fontSize: 13, color: C.red }}>Tekshirib bo'lmadi: {st.error}. TELEGRAM_SUPPORT_BOT_TOKEN o'rnatilganini tekshiring.</div>}
      {st && !st.error && (
        <div style={{ fontSize: 13, color: C.txt2, lineHeight: 1.7 }}>
          Bot: {uname ? <b>@{uname}</b> : <span style={{ color: C.txt3 }}>token o'rnatilmagan</span>}<br />
          Vebhuk: {hookUrl ? <span style={{ color: C.green }}>ulangan</span> : <span style={{ color: C.gold }}>sozlanmagan</span>}
        </div>
      )}
      <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={setup} disabled={busy} style={{ ...btn(), opacity: busy ? 0.6 : 1 }}>{busy ? '…' : (hookUrl ? 'Vebhukni qayta sozlash' : 'Botni sozlash')}</button>
        <button onClick={loadStatus} style={{ ...btn(C.card, C.txt2), border: `1px solid ${C.line}` }}>Yangilash</button>
      </div>
      {msg && <div style={{ fontSize: 13, color: msg.includes('✓') ? C.green : C.red, marginTop: 10 }}>{msg}</div>}
    </div>
  )
}

// ─────────── 4-bo'lim: Operatorlar (faqat admin) ───────────
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
    if (!login.trim() || !password) { setMsg('Login va parol kerak'); return }
    const d = await support.accountAdd({ login, password, name })
    if (d && d.ok) { setLogin(''); setPassword(''); setName(''); load() } else setMsg((d && d.error) || 'Xatolik')
  }
  async function del(l) { if (!confirm(`«${l}» operatorini o'chirilsinmi?`)) return; await support.accountDel(l); load() }

  const card = { background: C.card, border: `1px solid ${C.line}`, borderRadius: 14, padding: 18 }
  return (
    <div style={card}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Operator hisoblari</div>
      {list.length === 0 && <div style={{ fontSize: 13, color: C.txt3, marginBottom: 12 }}>Hozircha birorta operator yo'q.</div>}
      {list.map((a) => (
        <div key={a.login} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: `1px solid ${C.line}` }}>
          <div style={{ fontSize: 14 }}><b>{a.login}</b>{a.name && a.name !== a.login ? <span style={{ color: C.txt3 }}> — {a.name}</span> : null}</div>
          <button onClick={() => del(a.login)} style={{ ...btn('transparent', C.red), border: `1px solid ${C.line}`, padding: '6px 12px', fontSize: 13 }}>O'chirish</button>
        </div>
      ))}
      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 8, alignItems: 'center' }}>
        <input style={inp} placeholder="Login" value={login} onChange={(e) => setLogin(e.target.value)} />
        <input style={inp} placeholder="Parol" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input style={inp} placeholder="Ism (ixtiyoriy)" value={name} onChange={(e) => setName(e.target.value)} />
        <button onClick={add} style={btn()}>Qo'shish</button>
      </div>
      {msg && <div style={{ fontSize: 13, color: C.red, marginTop: 10 }}>{msg}</div>}
    </div>
  )
}
