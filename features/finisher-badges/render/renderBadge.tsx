// RD-BADGE-01 · Badge rendering — the IMPURE half. SERVER ONLY.
//
// Turns a view model into a 1080×1080 PNG using `next/og` (Satori + resvg), which ships with
// Next.js — no new dependency, and no `sharp`.
//
// It runs in the NODE runtime, verified against the Node build of @vercel/og, so the same
// route can also use firebase-admin. An Edge-only renderer would have made that impossible
// and forced a second service.
//
// This file contains NO decisions: every fallback, truncation and label comes from
// ./design.ts, which is pure and tested.
//
// Satori constraints worth knowing before editing:
//   • no CSS variables, no Tailwind — literal values only
//   • every element with children needs an explicit `display`
//   • no `gap` on block layout; use margins
//   • remote images are fetched at render time, so they must be optional

import { ImageResponse } from 'next/og'
import {
  BADGE_COLORS, buildViewModel,
} from './design'
import {
  BADGE_HEIGHT, BADGE_WIDTH, type BadgeRenderInput,
} from '@/features/finisher-badges/types'

/** Renders the badge and returns PNG bytes. Throws on an unrecoverable render failure. */
export async function renderBadgePng(input: BadgeRenderInput): Promise<Uint8Array> {
  const vm = buildViewModel(input)

  const response = new ImageResponse(
    (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          padding: 72,
          backgroundColor: BADGE_COLORS.primaryDeep,
          backgroundImage: `linear-gradient(150deg, ${BADGE_COLORS.primaryDeep} 0%, ${BADGE_COLORS.primary} 55%, ${BADGE_COLORS.ink} 100%)`,
          color: BADGE_COLORS.surface,
          fontFamily: 'sans-serif',
        }}
      >
        {/* ── Header: logo + event ── */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {vm.eventLogoUrl && (
            /* Satori renders straight to PNG — next/image has no meaning inside an
               ImageResponse tree and would not resolve. */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={vm.eventLogoUrl}
              alt=""
              width={104}
              height={104}
              style={{ width: 104, height: 104, borderRadius: 24, objectFit: 'cover', marginRight: 28 }}
            />
          )}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ fontSize: 46, fontWeight: 700, letterSpacing: -1 }}>{vm.eventName}</div>
            {vm.eventDate && (
              <div style={{ fontSize: 26, opacity: 0.75, marginTop: 6 }}>{vm.eventDate}</div>
            )}
          </div>
        </div>

        {/* ── Status pill ── */}
        <div style={{ display: 'flex', marginTop: 56 }}>
          <div
            style={{
              display: 'flex',
              paddingLeft: 28, paddingRight: 28, paddingTop: 12, paddingBottom: 12,
              borderRadius: 999,
              backgroundColor: vm.status.color,
              fontSize: 28, fontWeight: 700, letterSpacing: 3,
            }}
          >
            {vm.status.label}
          </div>
        </div>

        {/* ── Runner ── */}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 28 }}>
          <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05 }}>
            {vm.displayName}
          </div>
          <div style={{ fontSize: 34, opacity: 0.8, marginTop: 14 }}>
            {vm.raceName} · Bib {vm.bibNumber}
          </div>
        </div>

        {/* ── Spacer pushes the stats to the bottom ── */}
        <div style={{ display: 'flex', flexGrow: 1 }} />

        {/* ── Stats ── */}
        <div
          style={{
            display: 'flex',
            borderTop: `2px solid ${BADGE_COLORS.hairline}`,
            paddingTop: 34,
          }}
        >
          {vm.timeLabel && (
            <div style={{ display: 'flex', flexDirection: 'column', marginRight: 84 }}>
              <div style={{ fontSize: 22, opacity: 0.7, letterSpacing: 2 }}>CHIP TIME</div>
              <div style={{ fontSize: 68, fontWeight: 800, marginTop: 6 }}>{vm.timeLabel}</div>
            </div>
          )}
          {vm.rankLabel && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: 22, opacity: 0.7, letterSpacing: 2 }}>OVERALL</div>
              <div style={{ fontSize: 68, fontWeight: 800, marginTop: 6 }}>{vm.rankLabel}</div>
              {vm.rankSubLabel && (
                <div style={{ fontSize: 20, opacity: 0.6 }}>{vm.rankSubLabel}</div>
              )}
            </div>
          )}
        </div>

        {/* ── Branding, deliberately small ── */}
        <div style={{ display: 'flex', alignItems: 'center', marginTop: 34, opacity: 0.55 }}>
          <div style={{ fontSize: 20, letterSpacing: 2 }}>REGISTERDESK</div>
        </div>
      </div>
    ),
    { width: BADGE_WIDTH, height: BADGE_HEIGHT },
  )

  return new Uint8Array(await response.arrayBuffer())
}
