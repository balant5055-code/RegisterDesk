'use client'

import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { Ticket } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import type { PassPublic } from '@/components/event-templates/types'
import { formatINR, minPassPrice } from '@/components/event-templates/shared/utils/format'

export function StickyMobileCTA({ visible, title, isFreeEvent, passes, registrationOpen }: {
  visible:          boolean
  title:            string
  isFreeEvent:      boolean
  passes:           PassPublic[]
  registrationOpen: boolean
}) {
  const active = passes.filter(p => p.status !== 'inactive')
  if (!registrationOpen || active.length === 0) return null

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: '100%', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '100%', opacity: 0 }}
          transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
          className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card/95 px-4 py-3 shadow-[0_-4px_20px_rgb(0_0_0/0.1)] backdrop-blur-md lg:hidden"
        >
          <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-bold text-foreground">{title}</p>
              <p className="text-[10.5px] text-muted-foreground">
                {isFreeEvent ? 'Free registration' : `From ${formatINR(minPassPrice(passes))}`}
              </p>
            </div>
            <Link
              href="#register"
              className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'shrink-0 gap-1.5')}
            >
              <Ticket className="size-3.5" aria-hidden />
              {isFreeEvent ? 'Register' : 'Get Tickets'}
            </Link>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
