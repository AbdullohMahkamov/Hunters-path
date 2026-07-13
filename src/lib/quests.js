// Задачи/квесты (вкладка «Задачи») — дословный перенос из public/index.html.
// Императивный: рендер в #filters/#stages/#dopSection/#dopQuests, генератор в #genOverlay/#genBody.
// Эндпоинт /api/generate-quests не менялся.
import { state, save, getGoal } from './appState.js'
import { getRole, getSession } from './session.js'
import { tr } from './shellI18n.js'
import { escapeHtml } from './format.js'
import { STAGES, ALL_QUESTS, RANKS, svg, stageDone, stageUnlocked } from './questsData.js'

const $ = (id) => document.getElementById(id)
const goChat = () => { if (window.__switchToChat) window.__switchToChat() }
const ask = (t) => { if (window.quickAsk) window.quickAsk(t) }

function doneCount() { return ALL_QUESTS.filter((id) => state.done[id]).length }
function trophies() { return STAGES.filter((s) => state.bosses[s.id]).length }
function rankFor(p) { let r = 'Старт'; RANKS.forEach(([m, n]) => { if (p >= m) r = n }); return r }

// renderHeader — прогресс-элементы (#pct/#bar/...) в текущей оболочке отсутствуют → безопасные no-op.
function renderHeader() {
  const d = doneCount(), p = Math.round(d / (STAGES.flatMap((s) => s.quests).length || 1) * 100)
  const set = (id, v, prop) => { const e = $(id); if (e) { if (prop === 'width') e.style.width = v; else e.textContent = v } }
  set('pct', p + '%'); set('bar', p + '%', 'width'); set('doneN', d); set('trophN', trophies()); set('rank', rankFor(p))
}

function LX(o, field) {
  if (state.lang === 'uz') { const uz = o[field + 'Uz']; if (uz) return uz }
  return o[field]
}

function renderFilters() {
  const F = [['all', tr('fAll')], ['active', tr('fActive')], ['locked', tr('fLocked')], ['done', tr('fDone')]]
  const filters = $('filters'); if (!filters) return
  filters.innerHTML = ''
  F.forEach(([id, l]) => {
    const b = document.createElement('button'); b.className = 'fbtn' + (state.filter === id ? ' on' : '')
    b.textContent = l; b.onclick = () => { state.filter = id; save(); renderStages() }
    filters.appendChild(b)
  })
}

export function renderStages() {
  renderFilters()
  const uz = state.lang === 'uz'
  const wrap = $('stages'); if (!wrap) return
  wrap.innerHTML = ''
  if (state.customPlan) { renderCustomPlan(); return }
  if (getRole() === 'demo') {
    const auditBanner = document.createElement('div')
    auditBanner.style.cssText = 'background:var(--accent-bg);border:1px solid var(--accent);border-radius:12px;padding:15px 16px;margin-bottom:16px;'
    auditBanner.innerHTML = `
      <div style="font-size:15px;font-weight:700;margin-bottom:5px;">${svg('rocket', 17)} ${tr('auditBannerT')}</div>
      <div style="font-size:12.5px;color:var(--txt2);line-height:1.5;margin-bottom:11px;">${tr('auditBannerB')}</div>
      <button onclick="openWizard()" style="width:100%;padding:12px;border-radius:10px;background:var(--accent);border:none;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">${tr('auditBannerBtn')} ${svg('arrow', 15)}</button>`
    wrap.appendChild(auditBanner)
  }
  let lastSection = null
  STAGES.forEach((s, idx) => {
    const unlocked = stageUnlocked(idx), sdone = stageDone(s), cnt = s.quests.filter((q) => state.done[q.id]).length
    const bossReady = sdone && !state.bosses[s.id]
    if (state.filter === 'active' && (sdone || !unlocked)) return
    if (state.filter === 'locked' && unlocked) return
    if (state.filter === 'done' && !sdone) return
    if (s.section && s.section !== lastSection) {
      lastSection = s.section
      const secH = document.createElement('div')
      secH.className = 'task-section'
      const label = (s.section === 'marketing' ? svg('mega', 16) : svg('bag', 16)) + ' ' + (s.section === 'marketing' ? (uz ? 'Marketing' : 'Маркетинг') : (uz ? 'Sotuvlar' : 'Продажи'))
      secH.innerHTML = label
      wrap.appendChild(secH)
    }
    const card = document.createElement('div')
    card.className = 'stage' + (sdone ? ' done' : '') + (bossReady ? ' bossready' : '') + (state.open[s.id] ? ' open' : '')
    const prev = idx > 0 ? STAGES[idx - 1] : null
    let body = ''
    if (!unlocked) {
      body = `<div class="locked-msg">🔒 ${uz ? 'Avval' : 'Сначала закройте этап'} ${prev.id} «${LX(prev, 'name')}»${uz ? ' bosqichini yoping.' : '.'}</div>`
    } else {
      s.quests.forEach((q) => {
        const on = !!state.done[q.id]
        body += `<div class="quest${on ? ' done' : ''}">
          <div class="qcheck${on ? ' on' : ''}" onclick="toggleQuest('${q.id}',event)">${on ? '✓' : ''}</div>
          <div class="q-main"><div class="q-t">${LX(q, 't')}</div><div class="q-d">${LX(q, 'd')}</div></div>
          ${getRole() !== 'rop' ? `<button class="q-help" onclick="helpQuest('${q.id}')">${uz ? 'yordam' : 'помощь'}</button>` : ''}
        </div>`
      })
      const bdown = !!state.bosses[s.id]
      body += `<div class="boss${bdown ? ' down' : (sdone ? ' ready' : '')}">
        <div class="boss-h">${LX(s, 'boss')}</div>
        <div class="boss-d">${bdown ? (uz ? '✅ Bosqich yopildi! ' : '✅ Этап закрыт! ') + LX(s, 'reward') : LX(s, 'bossDesc')}</div>
        ${bdown ? '' : `<button class="boss-btn ${sdone ? 'ready' : 'locked'}" ${sdone ? `onclick="fightBoss(${s.id})"` : 'disabled'}>${sdone ? (uz ? '✅ Bosqichni yopish' : '✅ Закрыть этап') : (uz ? '🔒 Avval barcha vazifalarni bajaring' : '🔒 Сначала выполните все задачи этапа')}</button>`}
      </div>`
    }
    card.innerHTML = `
      <div class="s-head" onclick="toggleStage(${s.id})">
        <div class="s-icon">${unlocked ? svg(s.iconName, 18) : svg('lock', 18)}</div>
        <div style="min-width:0;">
          <div class="s-name">${uz ? 'Bosqich' : 'Этап'} ${s.id} · ${LX(s, 'name')}
            ${s.main ? `<span class="tag tag-dyra">${uz ? 'asosiy yo‘qotish nuqtasi' : 'ключевая точка потерь'}</span>` : ''}
            ${sdone ? `<span class="tag tag-done">${uz ? 'yopildi' : 'закрыт'}</span>` : ''}
          </div>
          <div class="s-sub">${LX(s, 'sub')} · ${cnt}/${s.quests.length} ${uz ? 'vazifa' : 'задач'}</div>
        </div>
        <div class="s-chev">▾</div>
      </div>
      <div class="s-body">${body}</div>`
    wrap.appendChild(card)
  })
}

function renderCustomPlan() {
  const uz = state.lang === 'uz'
  const wrap = $('stages'); if (!wrap) return
  wrap.innerHTML = ''
  const cp = state.customPlan
  if (!state.done) state.done = {}
  const head = document.createElement('div')
  head.style.cssText = 'background:var(--card);border:1px solid var(--line);border-radius:12px;padding:13px 15px;margin-bottom:14px;'
  const allTasks = [...(cp.marketing || []), ...(cp.sales || [])]
  const taskDone = (q) => { const steps = (q.steps || []); return steps.length > 0 ? steps.every((_, si) => !!state.done[q.id + '_s' + si]) : !!state.done[q.id] }
  const doneN = allTasks.filter(taskDone).length
  // цель — красиво с разделителями тысяч (250.000.000 so'm) вместо сырого числа
  const goalDigits = Number(String(cp.goal == null ? '' : cp.goal).replace(/[^\d]/g, '')) || 0
  const goalTxt = goalDigits > 0
    ? new Intl.NumberFormat('de-DE').format(goalDigits) + (uz ? " so'm" : ' сум')
    : (cp.goal ? escapeHtml(String(cp.goal)) : (uz ? 'Belgilanmagan' : 'Не указана'))
  head.innerHTML = `
    <div style="font-size:13px;color:var(--txt2);">${svg('target', 15)} ${uz ? 'Sizning maqsadingiz' : 'Ваша цель'}:</div>
    <div style="font-size:15px;font-weight:600;margin:3px 0 8px;">${goalTxt}</div>
    <div style="font-size:12.5px;color:var(--txt3);">${uz ? 'Bajarildi' : 'Выполнено'}: ${doneN}/${allTasks.length}</div>
    ${doneN >= allTasks.length && allTasks.length > 0 ? `<div style="margin-top:11px;padding:11px 13px;border-radius:11px;background:var(--green-bg);border:1px solid var(--green);">
        <div style="font-size:13.5px;font-weight:700;color:var(--green);margin-bottom:8px;">🎉 ${uz ? 'Barcha vazifalar bajarildi!' : 'Все задачи выполнены!'}</div>
        <div style="font-size:12.5px;color:var(--txt2);margin-bottom:10px;">${uz ? 'Yangi maʼlumotlar boʻyicha keyingi rejani tuzamiz.' : 'Соберём следующий план по свежим данным.'}</div>
        <button onclick="replanFromTasks()" style="width:100%;padding:11px;border-radius:10px;background:var(--green);border:none;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">${uz ? 'Yangi vazifalar olish →' : 'Получить новые задачи →'}</button>
      </div>` : ''}
    <button onclick="replanFromTasks()" style="width:100%;margin-top:8px;padding:9px;border-radius:9px;background:none;border:1px solid var(--line2);color:var(--txt2);font-size:12.5px;cursor:pointer;">${svg('refresh', 14)} ${uz ? 'Rejani qayta tuzish' : 'Пересобрать план'}</button>`
  wrap.appendChild(head)
  const sections = [
    { key: 'marketing', iconName: 'mega', label: (uz ? 'Marketing' : 'Маркетинг'), items: cp.marketing || [] },
    { key: 'sales', iconName: 'bag', label: (uz ? 'Sotuvlar' : 'Продажи'), items: cp.sales || [] },
  ]
  if (!state.cpOpen) state.cpOpen = {}
  let bosqich = 0
  sections.forEach((sec) => {
    if (!sec.items.length) return
    const h = document.createElement('div'); h.className = 'task-section'; h.innerHTML = svg(sec.iconName, 16) + ' ' + sec.label; wrap.appendChild(h)
    sec.items.forEach((q) => {
      bosqich++
      const steps = (q.steps || [])
      const stepDone = (si) => !!state.done[q.id + '_s' + si]
      const hasSteps = steps.length > 0
      const on = hasSteps ? steps.every((_, si) => stepDone(si)) : !!state.done[q.id]
      const doneSteps = steps.filter((_, si) => stepDone(si)).length
      const isOpen = !!state.cpOpen[q.id]
      // шаги — как красивые .quest-строки (тот же дизайн, что у статичных этапов)
      let body = ''
      if (hasSteps) {
        steps.forEach((st, si) => {
          const sd = stepDone(si)
          body += `<div class="quest${sd ? ' done' : ''}">
            <div class="qcheck${sd ? ' on' : ''}" onclick="toggleCpStep('${q.id}',${si})">${sd ? '✓' : ''}</div>
            <div class="q-main"><div class="q-t">${escapeHtml(st)}</div></div>
            ${getRole() !== 'rop' ? `<button class="q-help" onclick="event.stopPropagation();helpCustomStep('${q.id}',${si})">${uz ? 'yordam' : 'помощь'}</button>` : ''}
          </div>`
        })
      } else {
        body += `<div class="quest${on ? ' done' : ''}">
          <div class="qcheck${on ? ' on' : ''}" onclick="toggleCustomTask('${q.id}')">${on ? '✓' : ''}</div>
          <div class="q-main"><div class="q-t">${escapeHtml(q.t)}</div></div>
        </div>`
      }
      // блок «Зачем эта задача» — в стиле boss-цели этапа
      if (q.d) {
        body += `<div class="boss${on ? ' down' : ''}">
          <div class="boss-h">${uz ? 'Vazifaning maqsadi' : 'Зачем эта задача'}</div>
          <div class="boss-d">${escapeHtml(q.d)}</div>
          ${getRole() !== 'rop' ? `<button class="boss-btn ready" onclick="helpCustomTask('${q.id}')">${uz ? 'Butun vazifa bo‘yicha yordam' : 'Помощь по всей задаче'}</button>` : ''}
        </div>`
      }
      // отчёт при закрытии задачи (когда все шаги выполнены) — питает коллективный разум
      if (on && getRole() !== 'rop') {
        body += q.report
          ? `<div class="task-report done">✓ ${uz ? 'Hisobot yuborildi' : 'Отчёт отправлен'}</div>`
          : `<button class="task-report-btn" onclick="openTaskReport('${q.id}')">📝 ${uz ? 'Hisobot qoldirish (vazifani yopish)' : 'Оставить отчёт (закрыть задачу)'}</button>`
      }
      const card = document.createElement('div')
      card.className = 'stage' + (on ? ' done' : '') + (isOpen ? ' open' : '')
      card.innerHTML = `
        <div class="s-head" onclick="toggleCpCard('${q.id}')">
          <div class="s-icon">${on ? svg('check', 18) : svg(sec.iconName, 18)}</div>
          <div style="min-width:0;flex:1;">
            <div class="s-name">${uz ? 'Bosqich' : 'Этап'} ${bosqich} · ${escapeHtml(q.t)}
              ${on ? `<span class="tag tag-done">${uz ? 'yopildi' : 'закрыт'}</span>` : ''}
            </div>
            <div class="s-sub">${hasSteps ? `${doneSteps}/${steps.length} ${uz ? 'vazifa' : 'задач'}` : (uz ? '1 vazifa' : '1 задача')}</div>
          </div>
          <div class="s-chev">▾</div>
        </div>
        <div class="s-body">${body}</div>`
      wrap.appendChild(card)
    })
  })
}

function toggleStage(id) { state.open[id] = !state.open[id]; save(); renderStages() }
function toggleQuest(id, e) { e.stopPropagation(); state.done[id] = !state.done[id]; save(); renderHeader(); renderStages() }
function toggleCpCard(id) { if (!state.cpOpen) state.cpOpen = {}; state.cpOpen[id] = !state.cpOpen[id]; save(); renderStages() }
function toggleCpStep(qid, si) { const key = qid + '_s' + si; state.done[key] = !state.done[key]; save(); renderStages(); renderHeader() }
function toggleCustomTask(id) { state.done[id] = !state.done[id]; save(); renderStages(); renderHeader() }
function helpCustomStep(qid, si) {
  const cp = state.customPlan; if (!cp) return
  const q = [...(cp.marketing || []), ...(cp.sales || [])].find((x) => x.id === qid)
  if (!q || !q.steps || !q.steps[si]) return
  goChat()
  ask('Помоги выполнить этот шаг из задачи «' + q.t + '»: «' + q.steps[si] + '». Дай конкретные пошаговые действия и готовые материалы (скрипты, тексты, настройки), чтобы я закрыл этот шаг сегодня.')
}
function helpCustomTask(id) {
  const cp = state.customPlan; if (!cp) return
  const q = [...(cp.marketing || []), ...(cp.sales || [])].find((x) => x.id === id)
  if (!q) return
  goChat()
  const stepsTxt = (q.steps && q.steps.length) ? (' Под-задачи: ' + q.steps.join('; ') + '.') : ''
  ask('Помоги выполнить задачу «' + q.t + '». ' + (q.d || '') + stepsTxt + ' Дай конкретные пошаговые действия и готовые материалы, чтобы я закрыл её.')
}
// Отчёт при закрытии задачи → сохраняем в задаче + отправляем в коллективный разум (/api/knowledge).
function openTaskReport(qid) {
  const cp = state.customPlan; if (!cp) return
  const q = [...(cp.marketing || []), ...(cp.sales || [])].find((x) => x.id === qid); if (!q) return
  const uz = state.lang === 'uz'
  const section = (cp.marketing || []).includes(q) ? 'marketing' : 'sales'
  const ov = document.createElement('div')
  ov.className = 'plan-confirm-ov'
  ov.innerHTML = `<div class="plan-confirm-box" style="max-width:440px;">
    <div class="plan-confirm-t">${uz ? 'Vazifa hisoboti' : 'Отчёт по задаче'}</div>
    <div style="font-size:12.5px;color:var(--txt3);margin:-4px 0 14px;">${escapeHtml(q.t)}</div>
    <label class="tr-lbl">${uz ? 'Nima qildingiz?' : 'Что вы сделали?'}</label>
    <textarea id="tr_done" class="tr-ta" rows="3" placeholder="${uz ? 'Qisqacha: nima va qanday qildingiz' : 'Коротко: что и как сделали'}"></textarea>
    <label class="tr-lbl">${uz ? 'Qanday natija?' : 'Какой результат?'}</label>
    <textarea id="tr_res" class="tr-ta" rows="2" placeholder="${uz ? 'Nima oʻzgardi' : 'Что изменилось'}"></textarea>
    <label class="tr-lbl">${uz ? 'Ishladimi?' : 'Сработало?'}</label>
    <div class="tr-toggle">
      <button type="button" class="tr-opt" data-v="1">${uz ? '👍 Ha, ishladi' : '👍 Да, сработало'}</button>
      <button type="button" class="tr-opt" data-v="0">${uz ? '👎 Unchalik emas' : '👎 Не очень'}</button>
    </div>
    <div class="plan-confirm-actions" style="margin-top:16px;">
      <button class="plan-btn ghost" data-act="cancel">${uz ? 'Bekor' : 'Отмена'}</button>
      <button class="plan-btn primary" data-act="save">${uz ? 'Yuborish va yopish' : 'Отправить и закрыть'}</button>
    </div>
  </div>`
  let positive = null
  const opts = ov.querySelectorAll('.tr-opt')
  opts.forEach((o) => { o.onclick = () => { positive = o.dataset.v === '1'; opts.forEach((x) => x.classList.remove('on')); o.classList.add('on') } })
  const close = () => ov.remove()
  ov.addEventListener('click', (e) => { if (e.target === ov) close() })
  ov.querySelector('[data-act="cancel"]').onclick = close
  ov.querySelector('[data-act="save"]').onclick = () => {
    const whatDone = ov.querySelector('#tr_done').value.trim()
    const result = ov.querySelector('#tr_res').value.trim()
    if (!whatDone) { ov.querySelector('#tr_done').focus(); return }
    if (positive == null) { alert(uz ? 'Ishladimi yoki yoʻqmi belgilang' : 'Отметьте: сработало или нет'); return }
    q.report = { whatDone, result, positive, at: Date.now() }
    save(); renderStages(); close()
    // в общую базу попадут только положительные (решает бэкенд)
    fetch('/api/knowledge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session: getSession(), action: 'submit', taskTitle: q.t, section, whatDone, result, positive }),
    }).catch(() => {})
  }
  document.body.appendChild(ov)
}
function wizRegenerate() { if (!confirm('Пересобрать план заново? Текущие задачи и прогресс по ним сбросятся.')) return; state.customPlan = null; state.done = {}; save(); if (window.openWizard) window.openWizard() }
function wizReaudit() { if (!confirm('Все задачи выполнены! Сделать новый аудит и получить следующий план? (текущие задачи заменятся новыми)')) return; state.customPlan = null; state.done = {}; save(); if (window.openWizard) window.openWizard() }

function fightBoss(id) {
  state.bosses[id] = true; save()
  const s = STAGES.find((x) => x.id === id)
  const all = doneCount() === (STAGES.flatMap((x) => x.quests).length) && trophies() === STAGES.length
  celebrate(s, all); renderHeader(); renderStages()
}
function celebrate(s, all) {
  const ov = document.createElement('div'); ov.className = 'celebrate'
  ov.innerHTML = `<div class="cel-card">
    <div class="cel-emoji">${all ? '👑' : '🏆'}</div>
    <div class="cel-title">${all ? 'ЦЕЛЬ ДОСТИГНУТА' : 'Этап закрыт!'}</div>
    ${all ? '' : `<div class="cel-sub">Этап «${s.name}» закрыт</div>`}
    <div class="cel-d">${all ? 'Вы прошли весь план роста. Все 6 этапов закрыты, система продаж настроена. Отличная работа! 🎯' : s.reward}</div>
    <button class="cel-btn" onclick="this.closest('.celebrate').remove()">${all ? 'Завершить' : 'Продолжить'}</button>
  </div>`
  document.body.appendChild(ov)
  confetti()
}
function confetti() {
  const cols = ['#3b9eff', '#27c08a', '#f2b134', '#9b8cff', '#ff6b6b']
  for (let i = 0; i < 46; i++) {
    const c = document.createElement('div'); c.className = 'confetti'
    const sz = 6 + Math.random() * 7; c.style.width = sz + 'px'; c.style.height = sz + 'px'
    c.style.background = cols[i % 5]; c.style.left = (50) + '%'; c.style.top = '40%'
    document.body.appendChild(c)
    const ang = Math.random() * Math.PI * 2, dist = 90 + Math.random() * 220
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist
    c.animate([{ transform: 'translate(0,0) rotate(0)', opacity: 1 }, { transform: `translate(${dx}px,${dy + 300}px) rotate(${540 * Math.random()}deg)`, opacity: 0 }], { duration: 1200 + Math.random() * 600, easing: 'cubic-bezier(.2,.6,.3,1)' }).onfinish = () => c.remove()
  }
}

function resetHunt() {
  if (confirm('Сбросить весь прогресс? Это нельзя отменить.')) {
    state.done = {}; state.bosses = {}; state.open = {}; state.filter = 'all'; state.dopQuests = state.dopQuests || []
    save(); renderHeader(); renderStages(); renderDopQuests()
  }
}

// ===== ДОП-КВЕСТЫ =====
export function renderDopQuests() {
  // Фича «доп-задачи по проблемам» убрана — секция всегда скрыта.
  const sec = $('dopSection'); if (sec) sec.style.display = 'none'
}
function toggleDop(i) { state.done['dop' + i] = !state.done['dop' + i]; save(); renderDopQuests() }
function removeDop(i) {
  if (!confirm('Удалить эту доп-задачу?')) return
  state.dopQuests.splice(i, 1)
  const newDone = { ...state.done }
  Object.keys(newDone).forEach((k) => { if (k.startsWith('dop')) delete newDone[k] })
  state.done = newDone
  save(); renderDopQuests()
}

// ===== ГЕНЕРАТОР =====
function openGenerator() {
  $('genOverlay').style.display = 'flex'
  $('genBody').innerHTML = '<div class="gen-loading">⏳ Советник анализирует ваши проблемы из CRM и подбирает задачи...</div>'
  generateQuests()
}
function closeGenerator() { $('genOverlay').style.display = 'none' }
let genCandidates = []
async function generateQuests() {
  const body = $('genBody')
  try {
    const existingQuests = STAGES.flatMap((s) => s.quests.map((q) => ({ id: q.id, t: q.t })))
    const acceptedExtra = (state.dopQuests || []).map((q) => ({ t: q.t }))
    const r = await fetch('/api/generate-quests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ existingQuests, acceptedExtra, goal: getGoal() }) })
    const d = await r.json()
    if (d && d.ok && d.quests && d.quests.length) { renderGenCards(d.quests) }
    else if (d && d.ok && (!d.quests || !d.quests.length)) { body.innerHTML = '<div class="gen-loading">✅ Все ваши текущие проблемы уже закрываются существующими задачами. Новых пока не нужно.</div>' }
    else { body.innerHTML = '<div class="gen-loading">⚠️ Не удалось сгенерировать: ' + (d.error || '') + '. Проверь, что дашборд синхронизирован (есть проблемы).</div>' }
  } catch (e) { body.innerHTML = '<div class="gen-loading">⚠️ Нет связи с сервером. Попробуй ещё раз.</div>' }
}
function renderGenCards(quests) {
  genCandidates = quests
  const body = $('genBody')
  body.innerHTML = quests.map((q, i) => `
    <div class="gen-q" id="genq${i}">
      <div class="gen-q-t">${escapeHtml(q.t)}</div>
      <div class="gen-q-d">${escapeHtml(q.d || '')}</div>
      ${q.problem ? `<div class="gen-q-prob">🎯 ${escapeHtml(q.problem)}</div>` : ''}
      <div class="gen-q-btns">
        <button class="gen-accept" onclick="acceptGen(${i})">✓ Принять</button>
        <button class="gen-skip" onclick="skipGen(${i})">Пропустить</button>
      </div>
    </div>`).join('')
}
function acceptGen(i) {
  const q = genCandidates[i]; if (!q) return
  if (!state.dopQuests) state.dopQuests = []
  state.dopQuests.push({ t: q.t, d: q.d || '', problem: q.problem || '' })
  save()
  const el = $('genq' + i)
  if (el) el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--green);font-weight:600;">✓ Добавлено в доп-задачи</div>'
  renderDopQuests()
}
function skipGen(i) { const el = $('genq' + i); if (el) el.style.display = 'none' }

function askNext() { goChat(); ask('Я выполнил ' + doneCount() + ' из ' + (STAGES.flatMap((s) => s.quests).length) + ' задач. С какой задачи продолжить и почему именно она даст максимальный рост? Дай одну конкретную задачу на сегодня.') }
function helpQuest(id) {
  let q, st; STAGES.forEach((s) => s.quests.forEach((x) => { if (x.id === id) { q = x; st = s } }))
  if (!q) return
  goChat()
  ask('Помоги выполнить задачу «' + q.t + '» (этап ' + st.id + ', ' + st.sub + '). Дай конкретные пошаговые действия и готовые материалы, чтобы я закрыл её сегодня.')
}

let _inited = false
export function initQuests() {
  if (_inited) return
  _inited = true
  Object.assign(window, {
    toggleStage, toggleQuest, toggleCpCard, toggleCpStep, toggleCustomTask, helpCustomStep, helpCustomTask, openTaskReport,
    wizRegenerate, wizReaudit, fightBoss, resetHunt, toggleDop, removeDop,
    openGenerator, closeGenerator, acceptGen, skipGen, askNext, helpQuest,
  })
}
