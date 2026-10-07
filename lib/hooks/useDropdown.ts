'use client'

// RD-ORG-FOUNDATION · Dismissible-popover state.
//
// Click-outside + Escape, the two behaviours every menu in the shell needs and every
// menu was re-implementing. It existed as a private copy inside
// app/(dashboard)/layout.tsx and another inside app/(admin)/layout.tsx; the organizer
// header now imports this one. The admin copy is deliberately left alone — the admin
// shell is a separate security domain and is not in this phase's scope.

import { useEffect, useRef, useState } from 'react'

export interface DropdownState {
  open:         boolean
  setOpen:      React.Dispatch<React.SetStateAction<boolean>>
  /** Attach to the element that wraps BOTH the trigger and the menu. */
  containerRef: React.RefObject<HTMLDivElement | null>
}

export function useDropdown(): DropdownState {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return

    // mousedown, not click: a click listener fires after the trigger's own onClick has
    // already toggled the menu open, so the menu would close on the same gesture that
    // opened it.
    const onMouseDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return { open, setOpen, containerRef }
}
