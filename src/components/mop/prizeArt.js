// Яркие SVG-иллюстрации призов «с нуля» (fallback, когда не задано живое фото).
// Плоские заливки без <defs>/градиентов — чтобы не было конфликта id при многократном рендере.
// viewBox 0 0 64 64. Отдаём внутренний markup; компонент оборачивает в <svg>.

const ART = {
  money: `
    <rect x="7" y="24" width="40" height="24" rx="3" fill="#2e9c55"/>
    <rect x="11" y="20" width="40" height="24" rx="3" fill="#43c26e" stroke="#2e9c55" stroke-width="1.5"/>
    <circle cx="31" cy="32" r="7" fill="#eafff1"/><circle cx="31" cy="32" r="4" fill="#43c26e"/>
    <path d="M18 24h4M40 40h4" stroke="#eafff1" stroke-width="2" stroke-linecap="round"/>
    <ellipse cx="45" cy="49" rx="13" ry="5" fill="#d99a1f"/>
    <rect x="32" y="43" width="26" height="6" fill="#f2c23e"/>
    <ellipse cx="45" cy="43" rx="13" ry="5" fill="#ffd85e" stroke="#d99a1f" stroke-width="1.2"/>
    <path d="M45 40v6" stroke="#d99a1f" stroke-width="1.6" stroke-linecap="round"/>`,
  phone: `
    <rect x="19" y="6" width="26" height="52" rx="6" fill="#20263a"/>
    <rect x="22" y="12" width="20" height="38" rx="2" fill="#4aa3ff"/>
    <path d="M22 12h20v13l-20 9z" fill="#8fd0ff" opacity=".55"/>
    <circle cx="32" cy="9" r="1" fill="#465074"/>
    <circle cx="39" cy="15" r="1.3" fill="#0e1524"/>
    <circle cx="32" cy="54" r="2.4" fill="#2b3350"/>`,
  tablet: `
    <rect x="12" y="6" width="40" height="52" rx="5" fill="#20263a"/>
    <rect x="16" y="12" width="32" height="40" rx="2" fill="#7c5cff"/>
    <path d="M16 12h32v15l-32 12z" fill="#b6a4ff" opacity=".5"/>
    <circle cx="32" cy="55" r="2" fill="#2b3350"/>`,
  airpods: `
    <rect x="21" y="30" width="22" height="26" rx="7" fill="#f4f7fc" stroke="#cbd3e2" stroke-width="1.5"/>
    <rect x="21" y="30" width="22" height="6" rx="3" fill="#e6ebf3"/>
    <circle cx="32" cy="47" r="1.8" fill="#c3cad8"/>
    <path d="M22 9a4 4 0 0 1 8 0v4a2.4 2.4 0 0 1-2.4 2.4H27v9a2.5 2.5 0 0 1-5 0z" fill="#fff" stroke="#cbd3e2" stroke-width="1.2"/>
    <path d="M34 9a4 4 0 0 1 8 0v4a2.4 2.4 0 0 1-2.4 2.4H39v9a2.5 2.5 0 0 1-5 0z" fill="#fff" stroke="#cbd3e2" stroke-width="1.2"/>`,
  headphone: `
    <path d="M12 36v-4a20 20 0 0 1 40 0v4" fill="none" stroke="#ff6b4a" stroke-width="4"/>
    <rect x="8" y="34" width="10" height="18" rx="4" fill="#ff6b4a"/>
    <rect x="46" y="34" width="10" height="18" rx="4" fill="#ff6b4a"/>
    <rect x="11" y="38" width="4" height="10" rx="2" fill="#ffd1c5"/>
    <rect x="49" y="38" width="4" height="10" rx="2" fill="#ffd1c5"/>`,
  watch: `
    <rect x="23" y="6" width="18" height="12" rx="3" fill="#333a4d"/>
    <rect x="23" y="46" width="18" height="12" rx="3" fill="#333a4d"/>
    <rect x="18" y="18" width="28" height="28" rx="8" fill="#20263a" stroke="#465074" stroke-width="1.5"/>
    <rect x="22" y="22" width="20" height="20" rx="5" fill="#2ee6a6"/>
    <path d="M22 22h20v9l-20 7z" fill="#b8fce6" opacity=".5"/>`,
  speaker: `
    <rect x="18" y="8" width="28" height="48" rx="8" fill="#2a2f42"/>
    <circle cx="32" cy="38" r="10" fill="#161a28"/>
    <circle cx="32" cy="38" r="6" fill="#ff8a3c"/>
    <circle cx="32" cy="38" r="2.4" fill="#161a28"/>
    <circle cx="32" cy="18" r="3" fill="#161a28"/><circle cx="32" cy="18" r="1.4" fill="#ff8a3c"/>`,
  gamepad: `
    <path d="M14 26h36a9 9 0 0 1 8.5 12l-3 8.5a5.5 5.5 0 0 1-10.3.6L42.5 42h-21l-2.7 5.1a5.5 5.5 0 0 1-10.3-.6l-3-8.5A9 9 0 0 1 14 26z" fill="#2b3145"/>
    <rect x="17" y="33" width="10" height="3.4" rx="1.5" fill="#8a93a7"/>
    <rect x="20.3" y="29.7" width="3.4" height="10" rx="1.5" fill="#8a93a7"/>
    <circle cx="44" cy="31" r="2.2" fill="#ff6b6b"/><circle cx="49" cy="36" r="2.2" fill="#f2c23e"/>
    <circle cx="44" cy="41" r="2.2" fill="#5fbf7f"/><circle cx="39" cy="36" r="2.2" fill="#4aa3ff"/>`,
  keyboard: `
    <rect x="6" y="22" width="52" height="26" rx="4" fill="#2b3145"/>
    <rect x="10" y="26" width="44" height="14" rx="2" fill="#1c2131"/>
    <rect x="12" y="28" width="5" height="4" rx="1" fill="#8a93a7"/><rect x="19" y="28" width="5" height="4" rx="1" fill="#8a93a7"/>
    <rect x="26" y="28" width="5" height="4" rx="1" fill="#4aa3ff"/><rect x="33" y="28" width="5" height="4" rx="1" fill="#8a93a7"/>
    <rect x="40" y="28" width="5" height="4" rx="1" fill="#8a93a7"/><rect x="47" y="28" width="5" height="4" rx="1" fill="#ff6b6b"/>
    <rect x="16" y="34" width="32" height="4" rx="1" fill="#8a93a7"/>`,
  powerbank: `
    <rect x="18" y="8" width="28" height="48" rx="6" fill="#2b3145"/>
    <rect x="23" y="14" width="18" height="6" rx="2" fill="#161a28"/>
    <rect x="25" y="15.5" width="12" height="3" rx="1.5" fill="#43c26e"/>
    <circle cx="32" cy="34" r="7" fill="#161a28"/><path d="M33 30l-4 6h4l-1 4 4-6h-4z" fill="#f2c23e"/>
    <rect x="28" y="48" width="8" height="3" rx="1" fill="#465074"/>`,
  mug: `
    <path d="M16 20h24v18a10 10 0 0 1-10 10h-4a10 10 0 0 1-10-10z" fill="#ff7d3b"/>
    <path d="M40 24h4.5a6.5 6.5 0 0 1 0 13H40" fill="none" stroke="#ff7d3b" stroke-width="4"/>
    <ellipse cx="28" cy="20" rx="12" ry="3.4" fill="#ffa86b"/>
    <path d="M24 10c0 2-2 3-2 5M31 9c0 2-2 3-2 5" stroke="#cdd4e0" stroke-width="2" stroke-linecap="round" fill="none"/>`,
  cap: `
    <path d="M10 42a22 22 0 0 1 44 0z" fill="#3b9eff"/>
    <path d="M32 20a22 22 0 0 1 22 22H32z" fill="#2b83e0"/>
    <path d="M32 42a22 22 0 0 1 24-6l1 6z" fill="#1f6dc0"/>
    <circle cx="32" cy="21" r="2.5" fill="#1f6dc0"/>`,
  sticker: `
    <rect x="10" y="14" width="24" height="24" rx="5" fill="#ff6b6b" transform="rotate(-12 22 26)"/>
    <rect x="26" y="22" width="24" height="24" rx="5" fill="#4aa3ff" transform="rotate(10 38 34)"/>
    <path d="M30 12l2.4 5 5.6.6-4 4 1 5.4-5-2.8-5 2.8 1-5.4-4-4 5.6-.6z" fill="#f2c23e"/>`,
  snack: `
    <path d="M24 20h16l-1.6 30a3 3 0 0 1-3 2.8H28.6a3 3 0 0 1-3-2.8z" fill="#e23b3b"/>
    <rect x="24" y="26" width="16" height="10" fill="#fff"/>
    <path d="M27 28h10M27 31h8M27 34h10" stroke="#e23b3b" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M24 20l2-4h12l2 4z" fill="#b02a2a"/>
    <circle cx="49" cy="42" r="10" fill="#f2b134"/><path d="M45 40l2 2M50 39l1 2M47 45l2-1" stroke="#a9741f" stroke-width="1.5" stroke-linecap="round"/>`,
  subscription: `
    <rect x="10" y="16" width="44" height="32" rx="5" fill="#ff4d67"/>
    <rect x="10" y="16" width="44" height="10" rx="5" fill="#ff7088"/>
    <circle cx="32" cy="35" r="9" fill="#fff"/><path d="M29 30l8 5-8 5z" fill="#ff4d67"/>`,
  cert: `
    <path d="M20 10l-8 6v10l8-4 12 6 12-6 8 4V16l-8-6-12 6z" fill="#3b9eff"/>
    <path d="M32 16v30" stroke="#2b83e0" stroke-width="2"/>
    <path d="M20 10v18M44 10v18" stroke="#2b83e0" stroke-width="1.5" opacity=".6"/>
    <rect x="26" y="30" width="12" height="12" rx="2" fill="#fff" opacity=".85"/>
    <path d="M29 36l2 2 4-4" stroke="#3b9eff" stroke-width="2" fill="none" stroke-linecap="round"/>`,
  gift: `
    <rect x="12" y="26" width="40" height="28" rx="3" fill="#7c5cff"/>
    <rect x="9" y="18" width="46" height="10" rx="3" fill="#9a7fff"/>
    <rect x="28" y="18" width="8" height="36" fill="#f2c23e"/>
    <path d="M32 18c-3-8-14-6-9 0zM32 18c3-8 14-6 9 0z" fill="#ffd85e" stroke="#e0b52f" stroke-width="1"/>`,
}

export function prizeArt(name) {
  const s = (name || '').toLowerCase()
  if (/бонус|ваучер|сум|000|деньг/.test(s)) return ART.money
  if (/airpods/.test(s)) return ART.airpods
  if (/наушник/.test(s)) return ART.headphone
  if (/iphone|смартфон|redmi|телефон/.test(s)) return ART.phone
  if (/ipad|планшет/.test(s)) return ART.tablet
  if (/playstation|ps5|консоль|приставк/.test(s)) return ART.gamepad
  if (/час/.test(s)) return ART.watch
  if (/колонка|jbl|bluetooth|динамик/.test(s)) return ART.speaker
  if (/клав|мыш/.test(s)) return ART.keyboard
  if (/пауэрбанк|power/.test(s)) return ART.powerbank
  if (/кружк/.test(s)) return ART.mug
  if (/кепк|шоппер|шапк/.test(s)) return ART.cap
  if (/стикер|наклей/.test(s)) return ART.sticker
  if (/кола|чипс|шоколад|кофе|энергетик|обед|снек|перекус/.test(s)) return ART.snack
  if (/подписк|spotify|netflix|youtube|premium/.test(s)) return ART.subscription
  if (/сертификат|мерч|поездк|набор|футболк|худи/.test(s)) return ART.cert
  return ART.gift
}
