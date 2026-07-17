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
        priority={priority}
        className={className}
      />
    </Link>
  )
}
