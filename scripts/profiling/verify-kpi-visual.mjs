/* RD-DASHBOARD-13 — browser verification for the primary/secondary KPI visual pass.
 *
 *   node scripts/profiling/verify-kpi-visual.mjs          (defaults to :3000)
 *   RD_REAL_BASE_URL=http://localhost:3199 node scripts/profiling/verify-kpi-visual.mjs
 *
 * ═══ WHY A SEPARATE SCRIPT ═══════════════════════════════════════════════════
 * The brief's acceptance criteria are half CONTENT ("no cancelled line in Ticket
 * Revenue") and half APPEARANCE ("visibly brighter", "equal height", "icon and title on
 * one row"). Neither half is a source fact:
 *
 *   - "Cancelled moved" is only proven by reading the text INSIDE each card's box, not
 *     the page. Grepping the body would pass while the line sat in the wrong card.
 *   - "Brighter" is `getComputedStyle().backgroundColor` — a real, resolved rgb triple.
 *     A class name proves nothing if the token behind it is still 5% alpha.
 *   - "Equal height" and "one row" are geometry.
 *
 * ═══ IT WRITES NOTHING ═══════════════════════════════════════════════════════
 * Auth is a short-lived custom token for the workspace owner's own uid. Every Firestore
 * interaction is the page's ordinary reads.
 */
import fs from 'node:fs'
import { chromium } from '@playwright/test'

// RD-PREPROD · this script impersonates a workspace owner (custom token) and reads real data against PRODUCTION (registerdesk-c91a3). It must never start by
// accident: the operator confirms the project explicitly in the environment.
if (process.env.RD_CONFIRM_PROD_PROJECT !== 'registerdesk-c91a3') {
  console.error('Refusing to run: set RD_CONFIRM_PROD_PROJECT=registerdesk-c91a3 to confirm this targets production.')
  process.exit(2)
}
// RD-PREPROD · the real owner uid is no longer hard-coded in source: pass RD_REAL_UID explicitly.
if (!process.env.RD_REAL_UID) {
  console.error('Refusing to run: set RD_REAL_UID to the workspace owner uid to verify (no default).')
  process.exit(2)
}


for (const line of fs.readFileSync('.env.local', 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const BASE = process.env.RD_REAL_BASE_URL ?? 'http://localhost:3000'
const UID  = process.env.RD_REAL_UID ?? ''
const OUT  = 'e2e/.shots/kpi-visual'

const checks = [], failures = []
const check = (ok, label, detail = '') => {
  checks.push({ ok, label, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

/**
 * Per-card facts, read from the PRIMARY grid only.
 *
 * `innerText` is taken per card rather than per page — that is the whole point of this
 * check, since the defect being verified was a line living in the wrong card.
 */
const primaryCards = page => page.evaluate(() => {
  const section = document.querySelector('[aria-label="Key metrics"]')
  if (!section) return null
  const srgb = s => (s.match(/[\d.]+/g) ?? []).map(Number)
  const box  = n => { const b = n.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height } }
  // Nearest ancestor that actually paints — `transparent` and `rgba(…, 0)` do not.
  // A tint is an alpha, so a card's own computed colour says nothing until it is
  // composited over whatever is genuinely behind it.
  const backdrop = node => {
    for (let n = node.parentElement; n; n = n.parentElement) {
      const c = srgb(getComputedStyle(n).backgroundColor)
      if (c.length >= 3 && (c.length < 4 || c[3] > 0)) return c.slice(0, 3)
    }
    return [255, 255, 255]
  }
  return [...section.children].map(el => {
    const r  = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    // The decorative wash: an aria-hidden layer whose background is radial gradients.
    const wash = [...el.querySelectorAll('[aria-hidden]')]
      .find(n => /radial-gradient/.test(getComputedStyle(n).backgroundImage))
    // Any SVG bigger than a glyph is a background ILLUSTRATION, which is what this pass
    // removed. Measured rather than asserted on a class, so a large figure cannot return
    // under a different name.
    const svgMax = Math.max(0, ...[...el.querySelectorAll('svg')]
      .map(n => Math.max(n.getBoundingClientRect().width, n.getBoundingClientRect().height)))
    // The glyph chip and the label must share a horizontal band.
    // The glyph chip is "the first aria-hidden span holding an svg", not a size class —
    // pinning the selector to `size-7` meant a legitimate resize to 32px reported the
    // header as broken. Identify it by what it IS, not by how big it happens to be.
    const chip = [...el.querySelectorAll('span[aria-hidden]')].find(n => n.querySelector('svg'))
    const label = chip && chip.parentElement
      ? [...chip.parentElement.children].find(n => n !== chip && n.textContent.trim().length > 0)
      : null
    return {
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      height: Math.round(r.height),
      width:  Math.round(r.width),
      top:    Math.round(r.top),
      bg:     srgb(cs.backgroundColor),
      backdrop: backdrop(el),
      gradient: cs.backgroundImage,
      ink: srgb(cs.color),
      svgMax: Math.round(svgMax),
      washCircles: wash
        ? (getComputedStyle(wash).backgroundImage.match(/radial-gradient/g) ?? []).length
        : 0,
      washOpacity: wash ? Number(getComputedStyle(wash).opacity) : null,
      washInert: wash
        ? getComputedStyle(wash).pointerEvents === 'none' && wash.getAttribute('aria-hidden') !== null
        : false,
      chipBg:   chip  ? srgb(getComputedStyle(chip).backgroundColor) : null,
      chipBox:  chip  ? box(chip)  : null,
      labelBox: label ? box(label) : null,
    }
  })
})

/** Top + height of a section's direct grid children — raw material for row checks. */
const rowBoxes = (page, label) => page.evaluate(sel => {
  const s = document.querySelector(`[aria-label="${sel}"]`)
  if (!s) return null
  return [...s.children].map(e => {
    const r = e.getBoundingClientRect()
    return { top: Math.round(r.top), h: Math.round(r.height) }
  })
}, label)

/**
 * Channel distance between two colours — how far a card sits from a reference.
 *
 * Reading the raw channels is the trap here: `rgba(59,130,246,0.11)` and the solid
 * `#3B82F6` chip have IDENTICAL channels and differ only in alpha, so a raw comparison
 * reports the 11% wash and the solid chip as equally strong. What the eye receives is the
 * composite, so that is what gets measured.
 */
const dist = (c, bd) => c ? Math.round(Math.max(...[0, 1, 2].map(i => Math.abs(c[i] - bd[i])))) : 0

/** Heights on the same visual row must match; a wrapped grid legitimately has more rows. */
function unevenRows(boxes) {
  const rows = new Map()
  for (const b of boxes) {
    const k = Math.round(b.top / 8)
    rows.set(k, [...(rows.get(k) ?? []), b.h])
  }
  const groups = [...rows.values()]
  return { bad: groups.filter(hs => Math.max(...hs) - Math.min(...hs) > 1), groups }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  const { initializeApp, cert } = await import('firebase-admin/app')
  const { getAuth } = await import('firebase-admin/auth')
  initializeApp({ credential: cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8'))) })
  const token = await getAuth().createCustomToken(UID)

  const apiKey = process.env.NEXT_PUBLIC_FIREBASE_API_KEY
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${apiKey}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, returnSecureToken: true }) })
  const session = await res.json()
  check(Boolean(session.idToken), 'exchanged a custom token for a session',
    session.error?.message ?? 'session issued')
  if (!session.idToken) process.exit(1)

  const claims = JSON.parse(Buffer.from(session.idToken.split('.')[1], 'base64').toString('utf-8'))
  const authUser = {
    uid: session.localId ?? claims.user_id ?? claims.sub,
    email: session.email ?? claims.email ?? null,
    emailVerified: true, isAnonymous: false, providerData: [],
    stsTokenManager: {
      refreshToken: session.refreshToken, accessToken: session.idToken,
      expirationTime: Date.now() + Number(session.expiresIn ?? 3600) * 1000,
    },
    createdAt: String(Date.now()), lastLoginAt: String(Date.now()),
    apiKey, appName: '[DEFAULT]',
  }

  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const seedAuth = ({ key, user }) => new Promise(resolve => {
    const open = indexedDB.open('firebaseLocalStorageDb', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' })
    open.onsuccess = () => {
      const tx = open.result.transaction('firebaseLocalStorage', 'readwrite')
      tx.objectStore('firebaseLocalStorage').put({ fbase_key: key, value: user })
      tx.oncomplete = () => resolve()
      tx.onerror = () => resolve()
    }
    open.onerror = () => resolve()
  })

  const page = await context.newPage()
  await page.addInitScript(seedAuth, { key: `firebase:authUser:${apiKey}:[DEFAULT]`, user: authUser })
  const errors = []
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))

  console.log(`\n═══ KPI visual verification · ${BASE} ═══\n`)
  await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !/Loading /.test(document.body.innerText), undefined, { timeout: 180_000 })
  await page.waitForTimeout(1500)

  await page.getByRole('button', { name: /change event|select an event/i }).click()
  await page.getByRole('option', { name: /vanathukkul/i }).first().click()
  await page.waitForFunction(
    () => !/Loading .*…/.test(document.body.innerText) && /VANATHUKKUL/i.test(document.body.innerText),
    undefined, { timeout: 180_000 })
  await page.waitForTimeout(2200)

  await page.screenshot({ path: `${OUT}/desktop-1440.png` })
  await page.screenshot({ path: `${OUT}/desktop-1440-full.png`, fullPage: true })

  const cards = await primaryCards(page)
  check(Array.isArray(cards) && cards.length === 4, 'four primary cards render', `${cards ? cards.length : 0}`)
  if (!cards) { await browser.close(); process.exit(1) }

  const find = re => cards.find(c => re.test(c.text))
  const regs    = find(/Total registrations/i)
  const revenue = find(/Ticket revenue/i)
  const fees    = find(/Fees (&|and) payout/i)

  // ═══ 1 · CANCELLED MOVED INTO TOTAL REGISTRATIONS ═════════════════════════
  check(Boolean(regs), 'Total registrations card found')
  check(Boolean(regs) && /2,295/.test(regs.text), 'Total registrations shows 2,295', regs && regs.text.slice(0, 100))
  check(Boolean(regs) && /2,295 confirmed/.test(regs.text), 'footer reads "2,295 confirmed"')
  check(Boolean(regs) && /34 cancelled/.test(regs.text), 'footer reads "34 cancelled"')

  // ═══ 2 · TICKET REVENUE IS REVENUE ONLY ═══════════════════════════════════
  check(Boolean(revenue), 'Ticket revenue card found')
  check(Boolean(revenue) && /3,44,737/.test(revenue.text), 'Ticket revenue shows ₹3,44,737', revenue && revenue.text.slice(0, 100))
  check(Boolean(revenue) && !/cancel/i.test(revenue.text),
    'Ticket revenue contains NO cancelled line', revenue && revenue.text.slice(0, 130))

  // ═══ 3 · FEES & PAYOUT IS FINANCIAL ONLY ══════════════════════════════════
  check(Boolean(fees), 'Fees & Payout card found')
  const feeLines = [
    [/3,34,011/,  'net payout ₹3,34,011'],
    [/Platform/i, 'a platform fee line'],
    [/3,941/,     'platform fee ₹3,941'],
    [/Razorpay/i, 'a Razorpay fee line'],
    [/8,350/,     'Razorpay fee ₹8,350'],
    [/est/i,      'Razorpay marked est.'],
    [/12,292/,    'total fees ₹12,292'],
  ]
  for (const [re, label] of feeLines) {
    check(Boolean(fees) && re.test(fees.text), `Fees & Payout shows ${label}`)
  }
  check(Boolean(fees) && !/cancel/i.test(fees.text), 'Fees & Payout carries no cancellation count')

  // ═══ 4 · BRIGHT SATURATED GRADIENT FILLS ══════════════════════════════════
  // The reference asks for gradient cards with white type, so what gets measured is the
  // gradient itself and the CONTRAST of the ink against it — not a tint distance.
  check(cards.every(c => /linear-gradient/.test(c.gradient)),
    'all four primary cards carry a gradient fill',
    cards.map(c => (/linear-gradient/.test(c.gradient) ? 'yes' : 'NO')).join(', '))

  const stops = cards.map(c => (c.gradient.match(/rgba?\([^)]+\)/g) ?? []).map(t => (t.match(/[\d.]+/g) ?? []).map(Number)))
  check(stops.every(g => g.length >= 2), 'each gradient has at least two stops',
    stops.map(g => g.length).join(', '))

  // EVERY stop must be saturated — a gradient that merely ends bright but starts near
  // white is the pastel card the brief rejects.
  const depth = cards.map((c, i) => Math.min(...stops[i].map(st => dist(st.slice(0, 3), [255, 255, 255]))))
  check(depth.every(d => d >= 60), 'every stop of every fill is saturated, none near white',
    `min Δ from white per card: ${depth.join(', ')}`)

  const uniqHue = new Set(stops.map(g => g[0].slice(0, 3).join(',')))
  check(uniqHue.size === 4, 'all four fills are different colours', `${uniqHue.size} distinct`)

  // ── The card must be saturated WITHOUT its gradient ───────────────────────
  //
  // A filled card draws no `bg-*` class and no border, so for a while `background-image`
  // was its only background. Any failure to resolve that one token — a corrupted
  // Turbopack CSS cache, a stale chunk, tokens arriving late — rendered the card
  // transparent: white text on the white canvas, which reads exactly like the
  // "washed-out, almost-white" regression it is. The solid base makes that impossible,
  // and this asserts the base is really there rather than trusting the gradient to mask it.
  const baseOpaque = cards.every(c => c.bg.length >= 3 && (c.bg.length < 4 || c.bg[3] >= 1))
  const baseDepth  = cards.map(c => dist(c.bg.slice(0, 3), [255, 255, 255]))
  check(baseOpaque && baseDepth.every(d => d >= 60),
    'each card is saturated from its background-COLOR alone, gradient aside',
    `Δ from white: ${baseDepth.join(', ')}  ·  ${cards.map(c => 'rgb(' + c.bg.slice(0, 3).join(' ') + ')').join(' ')}`)

  const lum = c => {
    const f = v => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2])
  }
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }

  // ── Contrast is measured WHERE THE TEXT IS, not against the whole gradient ──
  //
  // These fills deliberately hold a readable hue across the top-left and open into a
  // bright endpoint in the empty bottom-right corner. Taking the worst stop would score
  // the corner glow — a region that carries nothing but the motif — and would force the
  // whole card darker to satisfy a pixel no one reads.
  //
  // So each text run is projected onto its own card's gradient axis, the fill colour at
  // that exact point is interpolated, and contrast is computed there.
  const textContrast = await page.evaluate(() => {
    const section = document.querySelector('[aria-label="Key metrics"]')
    const num = s => (s.match(/[\d.]+/g) ?? []).map(Number)
    const out = []
    for (const el of section.children) {
      const r = el.getBoundingClientRect()
      const g = getComputedStyle(el).backgroundImage
      // Stops as [r,g,b,position%]. CSS always serialises an explicit position here.
      const parsed = [...g.matchAll(/(rgba?\([^)]+\))\s*([\d.]+)%/g)]
        .map(m => ({ c: num(m[1]).slice(0, 3), p: Number(m[2]) }))
      if (parsed.length < 2) continue
      // ── The decorative wash is a LAYER OVER the fill, so it must be composited in ──
      //
      // Scoring contrast against the card's gradient alone would ignore a translucent
      // white sheet painted on top of it. That sheet only ever lightens a saturated card,
      // so ignoring it reports contrast that is better than what reaches the eye.
      const washEl = [...el.querySelectorAll('[aria-hidden]')]
        .find(n => /radial-gradient/.test(getComputedStyle(n).backgroundImage))
      const washAlpha = washEl ? Number(getComputedStyle(washEl).opacity) : 0
      // centre x%, centre y%, transparent-stop %, and the colour at 0%.
      const washLayers = washEl
        ? [...getComputedStyle(washEl).backgroundImage.matchAll(
            /radial-gradient\(circle at ([\d.]+)% ([\d.]+)%, (rgba?\([^)]+\)) 0%, rgba?\([^)]+\) ([\d.]+)%\)/g)]
            .map(m => ({ cx: Number(m[1]) / 100, cy: Number(m[2]) / 100,
                         c: num(m[3]).slice(0, 3), stop: Number(m[4]) / 100 }))
        : []
      // A `circle` with the default farthest-corner sizing: the ray runs from the centre
      // to whichever corner is furthest, and stop percentages are fractions of that ray.
      const ray = (cx, cy) => Math.max(
        Math.hypot(cx * r.width, cy * r.height),
        Math.hypot((1 - cx) * r.width, cy * r.height),
        Math.hypot(cx * r.width, (1 - cy) * r.height),
        Math.hypot((1 - cx) * r.width, (1 - cy) * r.height))
      const applyWash = (base, x, y) => {
        let out = base
        // Background layers paint first-on-top, so composite from the back forward.
        for (let i = washLayers.length - 1; i >= 0; i--) {
          const L = washLayers[i]
          const d = Math.hypot(x - L.cx * r.width, y - L.cy * r.height)
          const reach = L.stop * ray(L.cx, L.cy)
          if (d >= reach) continue
          const a = (1 - d / reach) * washAlpha
          out = [0, 1, 2].map(k => Math.round(L.c[k] * a + out[k] * (1 - a)))
        }
        return out
      }
      const angle = Number((g.match(/(-?[\d.]+)deg/) ?? [0, 135])[1])
      const rad = angle * Math.PI / 180
      // CSS gradient-line length for a box, and the projection of a point onto it.
      const L = Math.abs(r.width * Math.sin(rad)) + Math.abs(r.height * Math.cos(rad))
      const at = (x, y) => {
        const dx = x - r.width / 2, dy = y - r.height / 2
        // CSS gradient angles are measured clockwise from "to top", so 0deg points UP and
        // the unit direction in screen coordinates (y growing downward) is
        // (sin θ, −cos θ). The projection is therefore dx·sinθ − dy·cosθ.
        //
        // With `+dy·cosθ` the vertical component is mirrored: on a 135deg fill it reads a
        // top-left point as if it sat 35% further ALONG the gradient than it does, i.e.
        // on the bright corner stop instead of the flat one. Every contrast figure for
        // that card was then scored against the wrong colour.
        const t = 50 + ((dx * Math.sin(rad) - dy * Math.cos(rad)) / L) * 100
        if (t <= parsed[0].p) return parsed[0].c
        for (let i = 1; i < parsed.length; i++) {
          if (t <= parsed[i].p) {
            const a = parsed[i - 1], b = parsed[i]
            const f = (t - a.p) / (b.p - a.p || 1)
            return [0, 1, 2].map(k => Math.round(a.c[k] + f * (b.c[k] - a.c[k])))
          }
        }
        return parsed[parsed.length - 1].c
      }
      // Every text-bearing leaf in the card, measured at its own centre.
      const runs = []
      for (const n of el.querySelectorAll('*')) {
        if (n.children.length || !n.textContent.trim()) continue
        const b = n.getBoundingClientRect()
        if (!b.width || !b.height) continue
        const cs = getComputedStyle(n)
        // An element painted on its own OPAQUE surface (the upgrade button) is measured
        // against THAT surface, not against the gradient.
        //
        // This used to `continue` instead, and that blind spot shipped an invisible
        // button: its ink referenced a token that no longer existed, so `color` fell back
        // to the inherited white and printed white-on-white. Skipping a run because it is
        // hard to attribute is how a verifier passes a card nobody can read.
        let backing = null
        for (let a = n; a && a !== el; a = a.parentElement) {
          const bg = num(getComputedStyle(a).backgroundColor)
          if (bg.length >= 3 && (bg.length < 4 || bg[3] >= 0.9)) { backing = bg.slice(0, 3); break }
        }
        // The ink's OWN alpha counts. `rgba(255,255,255,0.95)` is not white — it is white
        // composited over whatever it sits on, which on a saturated card is measurably
        // darker. Taking `.slice(0,3)` discarded that and scored every muted run as if it
        // were fully opaque, reporting contrast the page never actually rendered.
        const rawInk = num(cs.color)
        const inkA = rawInk.length > 3 ? rawInk[3] : 1
        const pt = [b.left - r.left + b.width / 2, b.top - r.top + b.height / 2]
        const under = backing ?? applyWash(at(pt[0], pt[1]), pt[0], pt[1])
        runs.push({
          text: n.textContent.trim().slice(0, 22),
          size: Math.round(parseFloat(cs.fontSize)),
          weight: Number(cs.fontWeight),
          ink: [0, 1, 2].map(k => Math.round(rawInk[k] * inkA + under[k] * (1 - inkA))),
          fill: under,
        })
      }
      out.push({ label: el.innerText.split('\n')[0].slice(0, 20), runs })
    }
    return out
  })

  // ── The floor is 3:1, and that is a DESIGN DECISION, not an oversight ──────
  //
  // WCAG AA wants 4.5:1 for text under 24px. On a bright coral or a bright turquoise
  // that is unreachable: white needs a backdrop under ~0.18 relative luminance to clear
  // 4.5:1, and any rose or teal dark enough to do it stops reading as bright — which is
  // precisely the "dull, heavy" result the brief rejected.
  //
  // So the bar here is 3:1 (AA large-text, AAA-adjacent for non-text) across every run,
  // and the WORST number is printed on every pass rather than hidden behind a green
  // tick. If the accessibility trade-off is ever revisited, the fix is one token per
  // card — deepen the flat stop in styles/tokens.css — and this check will show it.
  const FLOOR = 3
  for (const card of textContrast) {
    const scored = card.runs.map(run => ({ ...run, got: ratio(run.ink, run.fill) }))
    const fails = scored.filter(r => r.got < FLOOR)
    const min = scored.length ? Math.min(...scored.map(r => r.got)) : 0
    const sub45 = scored.filter(r => r.got < 4.5 && !(r.size >= 24 || (r.size >= 19 && r.weight >= 700)))
    check(fails.length === 0, `text on "${card.label}" clears ${FLOOR}:1 where it actually sits`,
      fails.length
        ? fails.map(f => `"${f.text}" ${f.got.toFixed(2)}:1`).join(' | ')
        : `${scored.length} runs, worst ${min.toFixed(2)}:1` +
          (sub45.length ? `  ⚠ ${sub45.length} small runs under AA 4.5:1` : '  · all clear AA'))
    // Name every sub-AA run explicitly. A count tells you something is wrong; the run's
    // own text, size and ratio tell you WHICH token to move and by how much.
    for (const f of sub45) {
      console.log(`          ↳ ${f.got.toFixed(2)}:1  ${f.size}px/${f.weight}  "${f.text}"`)
    }
  }

  // The glyph chip must still separate from the fill it sits on.
  const chipA = cards.map(c => (c.chipBg && c.chipBg.length > 3 ? c.chipBg[3] : 1))
  check(chipA.every(a => a > 0), 'every icon chip paints a surface of its own', chipA.join(', '))

  // ── The wash replaced the line art; assert BOTH halves of that ────────────
  check(cards.every(c => c.washCircles >= 2), 'each card carries a soft multi-circle wash',
    cards.map(c => c.washCircles).join(', ') + ' circles')
  // The small functional glyph beside each title stays; a large background figure must
  // not. 40px is comfortably above a 16px lucide icon and far below any illustration.
  check(cards.every(c => c.svgMax <= 40), 'no oversized background illustration remains',
    `largest svg per card: ${cards.map(c => c.svgMax + 'px').join(', ')}`)
  check(cards.every(c => c.svgMax > 0), 'the small functional icon is still present',
    cards.map(c => c.svgMax + 'px').join(', '))
  check(cards.every(c => c.washInert), 'the wash is aria-hidden and pointer-events-none')

  // ═══ SHARED COMPOSITION — the four cards must be ONE component, not four ══
  //
  // "They should share the same design system with different accents" is a measurable
  // claim: the header band, the title baseline, the value baseline and the footer edge
  // all have to agree across the row. Eyeballing a screenshot cannot separate 3px of
  // drift from none, and 3px of drift is exactly what makes a row look hand-assembled.
  const rhythm = await page.evaluate(() => {
    const section = document.querySelector('[aria-label="Key metrics"]')
    // Baseline ≈ the bottom of the text box; close enough to compare across equal sizes.
    const edge = n => (n ? Math.round(n.getBoundingClientRect().bottom) : null)
    const biggest = el => {
      let best = null, size = 0
      for (const n of el.querySelectorAll('*')) {
        if (n.children.length || !n.textContent.trim()) continue
        const s = parseFloat(getComputedStyle(n).fontSize)
        if (s > size) { size = s; best = n }
      }
      return best
    }
    return [...section.children].map(el => {
      const r = el.getBoundingClientRect()
      const chip = [...el.querySelectorAll('span[aria-hidden]')].find(n => n.querySelector('svg'))
      const cs = getComputedStyle(el)
      return {
        label: el.innerText.split('\n')[0].slice(0, 20),
        padTop: cs.paddingTop, padLeft: cs.paddingLeft, radius: cs.borderTopLeftRadius,
        chipSize: chip ? Math.round(chip.getBoundingClientRect().height) : null,
        chipTop:  chip ? Math.round(chip.getBoundingClientRect().top - r.top) : null,
        valueBase: edge(biggest(el)) === null ? null : Math.round(edge(biggest(el)) - r.top),
        valueSize: biggest(el) ? Math.round(parseFloat(getComputedStyle(biggest(el)).fontSize)) : null,
        bottom: Math.round(r.bottom),
      }
    })
  })
  const spread = key => Math.max(...rhythm.map(c => c[key])) - Math.min(...rhythm.map(c => c[key]))
  const same = key => new Set(rhythm.map(c => c[key])).size === 1
  check(same('padTop') && same('padLeft'), 'identical internal padding on all four',
    rhythm.map(c => c.padTop).join('/'))
  check(same('radius'), 'identical corner radius on all four', rhythm.map(c => c.radius).join('/'))
  check(same('chipSize') && spread('chipTop') <= 1, 'identical icon chip size and top alignment',
    `${rhythm.map(c => c.chipSize).join('/')} px at top ${rhythm.map(c => c.chipTop).join('/')}`)
  check(same('valueSize'), 'identical primary value size', rhythm.map(c => c.valueSize).join('/'))
  check(spread('valueBase') <= 2, 'primary value baselines align across the row',
    `offsets ${rhythm.map(c => c.valueBase).join('/')} px  ·  spread ${spread('valueBase')}px`)
  check(spread('bottom') <= 1, 'identical footer edge', `spread ${spread('bottom')}px`)

  // ═══ 6 · ICON AND TITLE ON ONE ROW ════════════════════════════════════════
  const oneRow = cards.filter(c => c.chipBox && c.labelBox &&
    c.labelBox.top < c.chipBox.bottom && c.labelBox.bottom > c.chipBox.top)
  check(oneRow.length === cards.length, 'icon + title share one horizontal row on all four',
    `${oneRow.length}/${cards.length}`)

  // ═══ 8 · MOTIFS VISIBLE BUT SUBORDINATE ═══════════════════════════════════
  const ops = cards.map(c => c.washOpacity).filter(o => o !== null)
  check(ops.length === 4, 'all four cards carry a wash', `${ops.length}/4`)
  check(ops.every(o => o >= 0.08 && o <= 0.15),
    'wash opacity is felt without competing', ops.join(', '))

  // ═══ 5 · COMPACT TYPOGRAPHY ═══════════════════════════════════════════════
  const valueSize = await page.evaluate(() => {
    const s = document.querySelector('[aria-label="Key metrics"]')
    const el = [...s.querySelectorAll('p,span')].find(n => /^2,295$/.test(n.textContent.trim()))
    return el ? Math.round(parseFloat(getComputedStyle(el).fontSize)) : null
  })
  check(valueSize !== null && valueSize <= 30, 'primary value type stays compact', `${valueSize}px`)

  // ═══ 7 + 9 · EQUAL HEIGHTS AND NO OVERFLOW AT EVERY WIDTH ═════════════════
  const VIEWPORTS = [
    { name: 'wide',    width: 1440, height: 900 },
    { name: 'desktop', width: 1280, height: 860 },
    { name: 'laptop',  width: 1024, height: 820 },
    { name: 'tablet',  width: 768,  height: 1024 },
    { name: 'mobile',  width: 390,  height: 844 },
    { name: 'small',   width: 375,  height: 812 },
  ]
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await page.waitForTimeout(600)
    // Viewport, never fullPage. A fullPage capture of this page renders the below-fold
    // sections blank — they are laid out (the geometry checks below read real heights on
    // them) but do not paint into the stitched image, which reads as a broken page.
    await page.screenshot({ path: `${OUT}/${vp.name}-${vp.width}.png` })

    const primary = await rowBoxes(page, 'Key metrics')
    const p = unevenRows(primary)
    check(p.bad.length === 0, `primary cards equal height @ ${vp.name} ${vp.width}px`,
      p.groups.map(h => h.join('/')).join('  ·  '))

    const secondary = await rowBoxes(page, 'Today')
    if (secondary && secondary.length) {
      const s = unevenRows(secondary)
      check(s.bad.length === 0, `secondary cards equal height @ ${vp.name} ${vp.width}px`,
        s.groups.map(h => h.join('/')).join('  ·  '))
    }

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    check(!overflow, `no horizontal overflow @ ${vp.name} ${vp.width}px`)
  }

  check(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '))

  await browser.close()
  const passed = checks.filter(c => c.ok).length
  console.log(`\n═══ ${passed}/${checks.length} passed ═══`)
  if (failures.length) {
    console.log('FAILURES:')
    failures.forEach(f => console.log('  - ' + f))
    process.exit(1)
  }
  console.log(`screenshots → ${OUT}`)
}

main().catch(e => { console.error(e); process.exit(1) })
