// Homepage hero — decorative background. Single responsibility: the hero's
// backdrop. Pure white + one very subtle radial accent (<5% opacity). No blobs,
// no mesh, no dark. Static (no client JS).

export function HeroBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(55%_45%_at_50%_0%,rgba(229,39,126,0.03),transparent_70%)]"
    />
  )
}
