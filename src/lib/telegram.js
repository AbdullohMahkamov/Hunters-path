// Telegram-раздел — дословный перенос из public/index.html.
// Императивный (innerHTML в #tgChatList/#tgSummary/#tgChatWindow/#tgSegments/#tgDigest/#tgHistoryAnalysis).
// Эндпоинты /api/telegram-* (chats/import/send) не менялись.
import { getSession } from './session.js'
import { escapeHtml } from './format.js'

const $ = (id) => document.getElementById(id)

const TG_PRICE = ['цена', 'стоит', 'сколько', 'narx', 'qancha', 'нарх', 'pul', 'почём']
const TG_OBJ = ['дорого', 'подумаю', 'qimmat', 'oylab', "o'ylab", 'потом', 'нет денег', 'keyin']
const TG_INSTALL = ['рассрочк', 'части', 'bolib', "bo'lib", 'nasiya', 'кредит']
function tgText(m) { const t = m.text; if (Array.isArray(t)) return t.map((x) => typeof x === 'string' ? x : (x.text || '')).join(' '); return t || '' }

const TG_TEMPLATES = {
  'Без ответа': 'Assalomu alaykum, {name}! Kechirasiz, avval javob bera olmadim. Hunter Academy kursi bo‘yicha savolingizga javob bermoqchiman. Hali ham qiziqasizmi?',
  'Спросили цену': 'Assalomu alaykum, {name}! Hunter Academy kursi narxini so‘ragandingiz. Kurs to‘liq narxi + bo‘lib to‘lash (rassrochka) imkoniyati ham bor. Batafsil gaplashamizmi?',
  'Возражение': 'Assalomu alaykum, {name}! Hunter Academy haqida o‘ylab ko‘rdingizmi? Ayni damda maxsus shartlar bor — sizga mos variantni topamiz. Qanday savollaringiz bor?',
  'Рассрочка': 'Assalomu alaykum, {name}! Rassrochka bo‘yicha so‘ragandingiz — ha, bo‘lib to‘lash mavjud. Rasmiylashtiramizmi?',
  'Давно не писали': 'Assalomu alaykum, {name}! Ancha bo‘ldi gaplashmaganimizga. Hunter Academy’da yangi guruh ochilyapti. Qaytib o‘qishni boshlamoqchimisiz?',
}

async function analyzeTgHistory(ev) {
  const file = ev.target.files[0]
  if (!file) return
  const box = $('tgHistoryAnalysis')
  box.innerHTML = '<div style="color:var(--txt3);">Читаю файл... (может занять минуту)</div>'
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    let chats = (data.chats && data.chats.list) || []
    chats = chats.filter((c) => c.type === 'personal_chat')
    const cnt = {}
    chats.forEach((c) => (c.messages || []).forEach((m) => { if (m.type === 'message') cnt[m.from_id] = (cnt[m.from_id] || 0) + 1 }))
    const ownerId = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0]
    let total = 0, priceQ = 0, objQ = 0, installQ = 0, noReply = 0, leftAfterPrice = 0
    chats.forEach((c) => {
      const msgs = (c.messages || []).filter((m) => m.type === 'message')
      if (msgs.length < 3) return
      total++
      const allText = msgs.map((m) => tgText(m).toLowerCase()).join(' ')
      const last = msgs[msgs.length - 1]
      const lastFromClient = last.from_id !== ownerId
      const askedPrice = TG_PRICE.some((w) => allText.includes(w))
      if (askedPrice) priceQ++
      if (TG_OBJ.some((w) => allText.includes(w))) objQ++
      if (TG_INSTALL.some((w) => allText.includes(w))) installQ++
      if (lastFromClient) noReply++
      if (askedPrice && lastFromClient) leftAfterPrice++
    })
    const histStats = { total, priceQ, objQ, installQ, noReply, leftAfterPrice }
    await fetch('/api/telegram-import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'save_history_stats', stats: histStats }) })
    box.innerHTML = '<div style="color:var(--green);font-size:13px;">✓ История сохранена (' + total + ' диалогов). Новые чаты будут добавляться автоматически.</div>'
    loadLiveAnalysis()
  } catch (e) { box.innerHTML = '<div style="color:var(--red);">Ошибка чтения файла: ' + String(e).slice(0, 80) + '</div>' }
}

async function loadLiveAnalysis() {
  const box = $('tgHistoryAnalysis')
  if (!box) return
  try {
    const r = await fetch('/api/telegram-import?action=live_analysis&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok || !d.analysis || !d.analysis.total) { box.innerHTML = '<div style="font-size:12px;color:var(--txt3);">Загрузите историю или дождитесь новых чатов.</div>'; return }
    const a = d.analysis
    const pct = (n) => a.total ? Math.round(n / a.total * 100) : 0
    box.innerHTML = `
      <div style="font-size:13px;color:var(--txt);margin-bottom:10px;">Всего <b>${a.total}</b> диалогов <span style="font-size:11px;color:var(--txt3);">(история: ${a.fromHistory} + новые: ${a.fromNew})</span></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:12px;">
        <div style="background:var(--red-bg);border:1px solid var(--red);border-radius:10px;padding:10px;"><div style="font-size:20px;font-weight:700;color:var(--red);">${a.noReply}</div><div style="font-size:11px;color:var(--txt2);">без ответа (${pct(a.noReply)}%)</div></div>
        <div style="background:var(--gold-bg);border:1px solid var(--gold);border-radius:10px;padding:10px;"><div style="font-size:20px;font-weight:700;color:var(--gold);">${a.leftAfterPrice}</div><div style="font-size:11px;color:var(--txt2);">спросили цену и ушли</div></div>
        <div style="background:var(--card2);border-radius:10px;padding:10px;"><div style="font-size:20px;font-weight:700;">${a.priceQ}</div><div style="font-size:11px;color:var(--txt2);">спрашивали цену (${pct(a.priceQ)}%)</div></div>
        <div style="background:var(--card2);border-radius:10px;padding:10px;"><div style="font-size:20px;font-weight:700;">${a.objQ}</div><div style="font-size:11px;color:var(--txt2);">возражения (${pct(a.objQ)}%)</div></div>
      </div>
      <div style="font-size:12px;color:var(--txt2);line-height:1.6;background:var(--card2);border-radius:10px;padding:12px;">
        💡 <b>Выводы:</b><br>
        ${a.noReply > a.total * 0.15 ? `• <b>${a.noReply} клиентов без ответа</b> — потерянные деньги. Отвечайте всем.<br>` : ''}
        ${a.leftAfterPrice > 5 ? `• <b>${a.leftAfterPrice} ушли после вопроса о цене</b> — объясняйте ценность до цены.<br>` : ''}
        ${a.objQ > a.total * 0.15 ? `• <b>${pct(a.objQ)}% возражений</b> — подготовьте ответы на «дорого/подумаю».<br>` : ''}
        ${a.installQ < a.priceQ * 0.3 ? `• Про рассрочку спрашивают редко — предлагайте сами.<br>` : ''}
      </div>`
  } catch (e) { /* ignore */ }
}

async function segmentActiveChats() {
  const box = $('tgSegments')
  if (!box) return
  box.innerHTML = '<div style="color:var(--txt3);">Разбиваю активные чаты на сегменты...</div>'
  try {
    const r = await fetch('/api/telegram-import?action=segment_active&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok) { box.innerHTML = '<div style="color:var(--red);">' + (d.error || 'Ошибка') + '</div>'; return }
    renderTgSegments()
  } catch (e) { box.innerHTML = '<div style="color:var(--red);">Ошибка сегментации</div>' }
}

async function renderTgSegments() {
  const box = $('tgSegments')
  if (!box) return
  try {
    const r = await fetch('/api/telegram-import?action=segments&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok || !d.summary) { box.innerHTML = 'Загрузите историю, чтобы увидеть сегменты.'; return }
    const q = await (await fetch('/api/telegram-send?action=quota&session=' + encodeURIComponent(getSession()))).json()
    const rem = q.remaining != null ? q.remaining : 25
    box.innerHTML = `<div style="font-size:12px;color:var(--txt3);margin-bottom:10px;">Сегодня можно отправить: <b style="color:${rem > 0 ? 'var(--green)' : 'var(--red)'}">${rem}</b> из ${q.daily_limit || 25} (лимит для защиты аккаунта)</div>` +
      d.summary.filter((s) => s.count > 0).map((s) => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-top:1px solid var(--line);">
        <div><b style="font-size:13px;">${escapeHtml(s.name)}</b> <span style="color:var(--txt3);font-size:12px;">— ${s.count} клиентов</span></div>
        <button onclick="openTgSend('${escapeHtml(s.name).replace(/'/g, '')}',${s.count})" style="padding:5px 12px;border-radius:8px;background:var(--accent);color:#fff;border:none;font-size:12px;font-weight:600;cursor:pointer;">Написать</button>
      </div>`).join('')
  } catch (e) { box.innerHTML = '<div style="color:var(--red);">Ошибка загрузки сегментов</div>' }
}

async function openTgSend(segName, count) {
  const win = $('tgChatWindow')
  const list = $('tgChatList')
  if (list) list.style.display = 'none'
  if (win) { win.style.display = 'block'; win.innerHTML = '<div style="color:var(--txt3);">Загрузка сегмента...</div>' }
  const r = await fetch('/api/telegram-import?action=segment&name=' + encodeURIComponent(segName) + '&session=' + encodeURIComponent(getSession()))
  const d = await r.json()
  const q = await (await fetch('/api/telegram-send?action=quota&session=' + encodeURIComponent(getSession()))).json()
  const rem = q.remaining != null ? q.remaining : 25
  const tpl = TG_TEMPLATES[segName] || 'Assalomu alaykum, {name}!'
  const chats = d.chats || []
  win.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
      <button onclick="loadTelegramChats()" style="width:34px;height:34px;border-radius:9px;background:var(--card);border:1px solid var(--line2);cursor:pointer;font-size:16px;">←</button>
      <div><div style="font-weight:700;font-size:16px;">${escapeHtml(segName)}</div><div style="font-size:12px;color:var(--txt3);">${chats.length} клиентов · сегодня можно ${rem}</div></div>
    </div>
    <div style="font-size:13px;font-weight:600;margin-bottom:6px;">Текст сообщения (можно менять, {name} = имя клиента):</div>
    <textarea id="tgTemplate" style="width:100%;min-height:100px;padding:11px;border-radius:10px;border:1px solid var(--line2);font-family:inherit;font-size:13px;resize:vertical;">${escapeHtml(tpl)}</textarea>
    <div style="display:flex;align-items:center;gap:10px;margin-top:12px;">
      <label style="font-size:13px;">Отправить сейчас:</label>
      <input id="tgSendCount" type="number" value="${Math.min(rem, chats.length, 20)}" min="1" max="${Math.min(rem, chats.length)}" style="width:70px;padding:7px;border-radius:8px;border:1px solid var(--line2);">
      <button onclick='doTgSend(${JSON.stringify(segName)})' style="padding:9px 18px;border-radius:9px;background:var(--accent);color:#fff;border:none;font-weight:600;cursor:pointer;">Отправить</button>
    </div>
    <div style="font-size:11px;color:var(--txt3);margin-top:8px;">⚠️ Отправка идёт по одному с паузами (безопасно для аккаунта). Не закрывайте страницу.</div>
    <div id="tgSendResult" style="margin-top:12px;"></div>`
  window._tgSegChats = chats
}

async function doTgSend(segName) {
  const tpl = $('tgTemplate').value.trim()
  const cnt = parseInt($('tgSendCount').value) || 0
  const chats = window._tgSegChats || []
  if (!tpl || cnt < 1) { alert('Введите текст и количество'); return }
  const recipients = chats.slice(0, cnt).map((c) => ({ id: c.id, name: c.name }))
  const rb = $('tgSendResult')
  rb.innerHTML = '<div style="color:var(--txt3);">Отправляю ' + recipients.length + ' сообщений... подождите</div>'
  try {
    const r = await fetch('/api/telegram-send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: getSession(), action: 'send', recipients, template: tpl }) })
    const d = await r.json()
    if (d.blocked) { rb.innerHTML = '<div style="color:var(--red);">' + d.reason + '</div>'; return }
    if (d.ok === false && d.message) { rb.innerHTML = '<div style="background:var(--red-bg);border:1px solid var(--red);border-radius:10px;padding:12px;color:var(--red);font-size:13px;">⚠️ ' + escapeHtml(d.message) + '</div>'; return }
    rb.innerHTML = `<div style="color:${d.sent > 0 ? 'var(--green)' : 'var(--gold)'};font-weight:600;">✓ Отправлено: ${d.sent} из ${d.requested}</div>` +
      (d.remaining_after != null ? `<div style="font-size:12px;color:var(--txt3);">Осталось на сегодня: ${d.remaining_after}</div>` : '') +
      (d.note ? `<div style="font-size:12px;color:var(--gold);margin-top:6px;">${escapeHtml(d.note)}</div>` : '') +
      (d.errors && d.errors.length ? `<div style="font-size:11px;color:var(--txt3);margin-top:8px;padding:8px;background:var(--card2);border-radius:8px;">Причина от Telegram: «${escapeHtml(d.errors[0].err || '')}»</div>` : '')
  } catch (e) { rb.innerHTML = '<div style="color:var(--red);">Ошибка отправки</div>' }
}

async function loadTgDigest() {
  const box = $('tgDigest')
  if (!box) return
  try {
    const r = await fetch('/api/telegram-chats?action=digest&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok || !d.digest) { box.innerHTML = ''; return }
    const dg = d.digest
    const tips = (dg.tips || []).map((t) => `<li style="margin-bottom:4px;">${escapeHtml(t)}</li>`).join('')
    box.innerHTML = `<div style="background:var(--card);border:1px solid var(--accent);border-radius:14px;padding:16px;">
      <div style="font-size:13px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;">📋 Разбор за вчера${dg.date ? ' · ' + dg.date : ''}</div>
      <div style="font-size:14px;color:var(--txt);line-height:1.5;margin-bottom:${tips ? '10px' : '0'};">${escapeHtml(dg.summary || '')}</div>
      ${tips ? `<div style="font-size:13px;color:var(--txt2);font-weight:600;margin-bottom:4px;">💡 Советы:</div><ul style="margin:0;padding-left:18px;font-size:13px;color:var(--txt);">${tips}</ul>` : ''}
    </div>`
  } catch (e) { box.innerHTML = '' }
}

async function loadTelegramChats() {
  loadTgDigest()
  renderTgSegments()
  loadLiveAnalysis()
  const list = $('tgChatList')
  const sum = $('tgSummary')
  const win = $('tgChatWindow')
  if (win) win.style.display = 'none'
  if (list) list.style.display = 'block'
  if (sum) sum.style.display = 'flex'
  if (!list) return
  list.innerHTML = '<div style="font-size:13px;color:var(--txt3);">Загрузка...</div>'
  try {
    const r = await fetch('/api/telegram-chats?action=list&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok) { list.innerHTML = '<div style="font-size:13px;color:var(--red);">' + (d.error || 'Ошибка') + '</div>'; return }
    sum.innerHTML = `
      <div style="flex:1;background:var(--card);border:1px solid var(--line2);border-radius:12px;padding:12px;">
        <div style="font-size:22px;font-weight:700;">${d.total_chats}</div>
        <div style="font-size:12px;color:var(--txt2);">Всего чатов</div>
      </div>
      <div style="flex:1;background:${d.waiting_reply ? 'var(--red-bg)' : 'var(--card)'};border:1px solid ${d.waiting_reply ? 'var(--red)' : 'var(--line2)'};border-radius:12px;padding:12px;">
        <div style="font-size:22px;font-weight:700;color:${d.waiting_reply ? 'var(--red)' : 'var(--txt)'};">${d.waiting_reply}</div>
        <div style="font-size:12px;color:var(--txt2);">Ждут ответа</div>
      </div>
      <div style="flex:1;background:${d.waiting_over_30min ? 'var(--gold-bg)' : 'var(--card)'};border:1px solid ${d.waiting_over_30min ? 'var(--gold)' : 'var(--line2)'};border-radius:12px;padding:12px;">
        <div style="font-size:22px;font-weight:700;color:${d.waiting_over_30min ? 'var(--gold)' : 'var(--txt)'};">${d.waiting_over_30min}</div>
        <div style="font-size:12px;color:var(--txt2);">Ждут &gt;30 мин</div>
      </div>`
    if (!d.chats.length) { list.innerHTML = '<div style="font-size:13px;color:var(--txt3);">Чатов пока нет. Напишите боту или подключите бизнес-аккаунт.</div>'; return }
    list.innerHTML = d.chats.map((c) => {
      const wait = c.waitingReply ? `<span style="font-size:11px;color:var(--red);font-weight:600;">● ждёт ответа ${c.waitingMinutes} мин</span>` : `<span style="font-size:11px;color:var(--txt3);">вы ответили</span>`
      return `<div onclick="openTgChat(${c.chatId},'${escapeHtml(c.name).replace(/'/g, '')}')" style="background:var(--card);border:1px solid ${c.waitingReply ? 'var(--red)' : 'var(--line2)'};border-radius:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <div style="font-weight:600;font-size:14px;">${escapeHtml(c.name)}</div>
          <div style="font-size:11px;color:var(--txt3);">${c.lastTime}</div>
        </div>
        <div style="font-size:13px;color:var(--txt2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px;">${escapeHtml(c.lastText)}</div>
        ${wait}
      </div>`
    }).join('')
  } catch (e) { list.innerHTML = '<div style="font-size:13px;color:var(--red);">Нет связи</div>' }
}

async function openTgChat(chatId, name) {
  const list = $('tgChatList')
  const sum = $('tgSummary')
  const win = $('tgChatWindow')
  if (list) list.style.display = 'none'
  if (sum) sum.style.display = 'none'
  if (!win) return
  win.style.display = 'block'
  win.innerHTML = '<div style="font-size:13px;color:var(--txt3);">Загрузка переписки...</div>'
  try {
    const r = await fetch('/api/telegram-chats?action=chat&chatId=' + chatId + '&session=' + encodeURIComponent(getSession()))
    const d = await r.json()
    if (!d.ok) { win.innerHTML = '<div style="color:var(--red);">Ошибка</div>'; return }
    const avg = d.avg_reply_minutes != null ? `Среднее время ответа: <b>${d.avg_reply_minutes} мин</b>` : ''
    win.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">
        <button onclick="loadTelegramChats()" style="width:34px;height:34px;border-radius:9px;background:var(--card);border:1px solid var(--line2);cursor:pointer;font-size:16px;">←</button>
        <div><div style="font-weight:700;font-size:16px;">${escapeHtml(name)}</div><div style="font-size:12px;color:var(--txt3);">${avg}</div></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;max-width:680px;">
        ${d.messages.map((m) => {
          const mine = m.isOwner
          return `<div style="align-self:${mine ? 'flex-end' : 'flex-start'};max-width:75%;background:${mine ? 'var(--accent)' : 'var(--card2)'};color:${mine ? '#fff' : 'var(--txt)'};padding:9px 13px;border-radius:14px;font-size:14px;">
            <div>${escapeHtml(m.text)}</div>
            <div style="font-size:10px;opacity:.6;margin-top:3px;">${m.time}</div>
          </div>`
        }).join('')}
      </div>`
  } catch (e) { win.innerHTML = '<div style="color:var(--red);">Нет связи</div>' }
}

let _inited = false
export function initTelegram() {
  if (_inited) return
  _inited = true
  Object.assign(window, {
    loadTelegramChats, openTgChat, segmentActiveChats, renderTgSegments, analyzeTgHistory,
    loadLiveAnalysis, loadTgDigest, openTgSend, doTgSend,
  })
}
export { loadTelegramChats }
