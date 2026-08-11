// Shared RegisterDesk wordmark used by BOTH the marketing navbar and footer —
// one source of truth for the logo (same asset, same styling). Size is the only
// per-consumer difference; pass a height class via `className`.

import Link from 'next/link'
import Image from 'next/image'

export function MarketingLogo({
  className = 'h-7 w-auto md:h-[30px] lg:h-[30px]',
  priority = false,
}: {
  className?: string
  priority?:  boolean
}) {
  return (
    <Link
      href="/"
      aria-label="RegisterDesk home"
      className="inline-flex items-center transition-opacity duration-200 hover:opacity-80"
    >
      <Image
        src="/logo/logo-registerdesk.png"
        alt="RegisterDesk"
        width={658}
        height={127}
        // The intrinsic 658×127 is the asset's real size, but the wordmark renders at
        // h-7/h-[30px] with w-auto — about 145–155 CSS px wide. Without `sizes`, next/image
        // derives the srcset from the `width` prop and requested w=750 (1x) / w=1920 (2x)
        // for a 28px-tall logo. `sizes` describes the rendered WIDTH, so 160px lets the
        // optimizer pick a candidate that matches the display size instead.
        sizes="160px"
        priority={priority}
        className={className}
      />
    </Link>
  )
}
