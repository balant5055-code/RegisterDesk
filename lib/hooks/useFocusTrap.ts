import { useEffect, useRef } from 'react'

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * Returns a ref to attach to a modal container.
 * On mount: focuses the first focusable element and traps Tab/Shift+Tab within.
 * On unmount: restores focus to the previously focused element.
 */
export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(active = true) {
  const ref = useRef<T>(null)

  useEffect(() => {
    if (!active || !ref.current) return

    const container = ref.current
    const getFocusable = () => Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE))
    const previously  = document.activeElement as HTMLElement | null

    getFocusable()[0]?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== 'Tab') return
      const els   = getFocusable()
      if (!els.length) { e.preventDefault(); return }
      const first = els[0]
      const last  = els[els.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus() }
      } else {
        if (document.activeElement === last)  { e.preventDefault(); first.focus() }
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      container.removeEventListener('keydown', onKeyDown)
      previously?.focus()
    }
  }, [active])

  return ref
}
