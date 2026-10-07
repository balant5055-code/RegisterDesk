'use client'

// ConfettiBurst — the /welcome celebration (owner, 2026-09-24: "an attractive welcome
// with a popper").
//
// Two gestures, one palette:
//   • the POPPER — a spray from a point (the party-popper tile), up and outward, that
//     then falls and fades;
//   • the CANNONS — two fans fired from the bottom corners of the viewport, up and in.
//
// Pure framer-motion keyframes over absolutely positioned spans: no canvas, no library,
// no layout cost, pointer-events none. Every value comes from a SEEDED generator, so a
// render is deterministic (and lint-pure) — change `seed` to fire a fresh burst.
// Colours are tokens: the public accent ramp, the bronze accent and the success green.
// The caller decides whether to render it at all (it never does under reduced motion).

import { motion } from 'framer-motion'
import { useMemo } from 'react'

const COLORS = [
  'var(--action)', 'var(--action-end)', 'var(--hero-accent-rule)',
  'var(--action)', 'var(--hero-accent-rule)', 'var(--success)',
]

/** mulberry32 — a tiny, fast, seeded PRNG. */
function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Piece {
  dx: number; dy: number; fall: number; rotate: number
  w: number; h: number; round: boolean
  color: string; delay: number; duration: number
}

function makePieces(seed: number, count: number, aim: (r: () => number) => { dx: number; dy: number }): Piece[] {
  const r = rng(seed)
  return Array.from({ length: count }, (_, i) => {
    const { dx, dy } = aim(r)
    const strip = r() > 0.4
    return {
      dx, dy,
      fall: 180 + r() * 260,
      rotate: (r() > 0.5 ? 1 : -1) * (360 + r() * 540),
      w: strip ? 5 + r() * 3 : 6 + r() * 3,
      h: strip ? 10 + r() * 6 : 6 + r() * 3,
      round: !strip,
      color: COLORS[i % COLORS.length],
      delay: r() * 0.18,
      duration: 1.9 + r() * 1.1,
    }
  })
}

function Pieces({ pieces, className, style }: { pieces: Piece[]; className: string; style?: React.CSSProperties }) {
  return (
    <span aria-hidden className={className} style={style}>
      {pieces.map((p, i) => (
        <motion.span
          key={i}
          className="absolute left-0 top-0 block"
          style={{ width: p.w, height: p.h, background: p.color, borderRadius: p.round ? 9999 : 1.5 }}
          initial={{ x: 0, y: 0, rotate: 0, opacity: 1, scale: 0.4 }}
          animate={{
            x: [0, p.dx * 0.85, p.dx],
            y: [0, p.dy, p.dy + p.fall],
            rotate: [0, p.rotate * 0.6, p.rotate],
            opacity: [1, 1, 0],
            scale: [0.4, 1, 0.9],
          }}
          transition={{ duration: p.duration, delay: p.delay, times: [0, 0.32, 1], ease: 'easeOut' }}
        />
      ))}
    </span>
  )
}

/** The spray from the popper. Mount it inside a `relative` box centred on the popper. */
export function PopperSpray({ seed }: { seed: number }) {
  const pieces = useMemo(() => makePieces(seed, 46, r => {
    // Up and outward: angles between ~200° and ~340° (screen space, y down).
    const angle = (200 + r() * 140) * (Math.PI / 180)
    const dist = 110 + r() * 230
    return { dx: Math.cos(angle) * dist, dy: Math.sin(angle) * dist }
  }), [seed])
  return <Pieces pieces={pieces} className="pointer-events-none absolute left-1/2 top-1/2 z-20" />
}

/** The two corner cannons — fixed to the viewport, above everything, click-through. */
export function CornerCannons({ seed }: { seed: number }) {
  const left = useMemo(() => makePieces(seed + 1, 34, r => ({
    dx: 140 + r() * 420, dy: -(360 + r() * 380),
  })), [seed])
  const right = useMemo(() => makePieces(seed + 2, 34, r => ({
    dx: -(140 + r() * 420), dy: -(360 + r() * 380),
  })), [seed])
  return (
    <span aria-hidden className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      <Pieces pieces={left} className="absolute" style={{ left: 0, bottom: 0 }} />
      <Pieces pieces={right} className="absolute" style={{ right: 0, bottom: 0 }} />
    </span>
  )
}
