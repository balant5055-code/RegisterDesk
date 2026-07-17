// ─── AuthAuroraBackground ─────────────────────────────────────────────────────
// Premium aurora wash for the organizer auth left panel — "soft daylight moving
// across premium paper." Sits over the base pink gradient and beneath the panel
// content (DOM order + pointer-events-none). One atmospheric composition of four
// soft-white washes at 3–8%: an oversized top-right light wash, a lower-left
// reflected glow, one long diagonal ribbon of light, and a very soft highlight
// around the logo area. No mesh, no pattern, no discrete objects.
//
// Pure CSS: gradients + transform-only keyframes (see globals.css, .rd-aurora-*).
// Every layer drifts the same gentle down-right arc by 2–3px, but on different
// long periods (29/41/53/67s) so the light shifts as one, never as four objects.
// No JS, canvas, SVG, filters, particles, scaling or opacity pulsing. Reduced-
// motion freezes it; the panel is hidden below md, so this never paints on
// mobile. Tablet dims a touch (opacity-80); desktop is full (lg:opacity-100).

export function AuthAuroraBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden opacity-80 lg:opacity-100"
    >
      {/* Oversized top-right light wash */}
      <div className="rd-aurora-wash absolute -right-[25%] -top-[30%] h-[95%] w-[95%]" />

      {/* Lower-left reflected glow */}
      <div className="rd-aurora-glow absolute -bottom-[30%] -left-[22%] h-[80%] w-[80%]" />

      {/* Long diagonal ribbon of light */}
      <div className="rd-aurora-ribbon absolute inset-0" />

      {/* Very soft highlight around the logo area (upper-left) */}
      <div className="rd-aurora-logo absolute -left-[8%] top-[5%] h-[42%] w-[56%]" />
    </div>
  )
}
