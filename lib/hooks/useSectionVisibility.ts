'use client'

// RD-DASHBOARD-05 · The React binding for lib/dashboard/sections.ts.
//
// ═══ WHY useSyncExternalStore AND NOT useState + useEffect ═══════════════════
// localStorage genuinely IS an external store, and every other shape of this hook is a
// known-bad pattern this codebase has already hit twice:
//
//   • Reading storage in `useMemo` / during render — impure, React 19 rejects it.
//   • Reading it in an effect and calling setState — `react-hooks/set-state-in-effect`,
//     and it paints the DEFAULT layout for one frame before the stored one, so an
//     operator sees the sections they deliberately hid flash into view on every load.
//   • Keying state by uid and re-reading when the uid changes — the same setState-in-
//     effect, just spelled differently.
//
// `useSyncExternalStore` is the primitive for exactly this: a cached snapshot read
// during render (legal, because it is memoised and stable), a subscription for changes,
// and a separate server snapshot so SSR and hydration agree.
//
// The snapshot cache is keyed by uid, so two accounts on one machine cannot inherit each
// other's layout — the same reason the workspace permission cache is keyed by uid.

import { useCallback, useSyncExternalStore } from 'react'
import {
  defaultVisibility, normalizeVisibility, toggleSection, visibilityStorageKey,
  type DashboardSectionId,
} from '@/lib/dashboard/sections'

type Visibility = Record<DashboardSectionId, boolean>

/**
 * Stable reference for "everything visible".
 *
 * A fresh object per call would make `getSnapshot` return a new value every render, and
 * useSyncExternalStore would loop forever. Frozen so a caller cannot mutate the default
 * out from under every other consumer.
 */
const ALL_VISIBLE: Visibility = Object.freeze(defaultVisibility()) as Visibility

const listeners = new Set<() => void>()
/** uid → parsed preference. Also the referential-stability guarantee getSnapshot needs. */
const cache = new Map<string, Visibility>()

function readStorage(uid: string): Visibility {
  try {
    return normalizeVisibility(JSON.parse(window.localStorage.getItem(visibilityStorageKey(uid)) ?? 'null'))
  } catch {
    // Private mode, disabled storage, corrupt JSON. A layout preference is never worth an
    // error state — fall back to showing everything.
    return ALL_VISIBLE
  }
}

function snapshot(uid: string | null): Visibility {
  // No uid yet (auth still resolving) ⇒ nothing to key storage by. Show everything rather
  // than guess; the snapshot switches once the uid arrives, with no effect involved.
  if (!uid || typeof window === 'undefined') return ALL_VISIBLE
  const hit = cache.get(uid)
  if (hit) return hit
  const v = readStorage(uid)
  cache.set(uid, v)
  return v
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  // Cross-tab: two dashboards open, a toggle in one should not leave the other showing a
  // layout that is no longer the operator's preference.
  const onStorage = (e: StorageEvent) => {
    if (!e.key?.startsWith('rd:dashboard:sections:')) return
    cache.clear()
    listeners.forEach(l => l())
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

function commit(uid: string, next: Visibility): void {
  cache.set(uid, next)
  try { window.localStorage.setItem(visibilityStorageKey(uid), JSON.stringify(next)) } catch { /* see readStorage */ }
  listeners.forEach(l => l())
}

export interface SectionVisibility {
  visible: Visibility
  toggle:  (id: DashboardSectionId) => void
  reset:   () => void
}

export function useSectionVisibility(uid: string | null): SectionVisibility {
  const visible = useSyncExternalStore(
    subscribe,
    () => snapshot(uid),
    // Server render: no storage exists, so everything is visible. Matching the client's
    // no-uid snapshot exactly is what keeps hydration from mismatching.
    () => ALL_VISIBLE,
  )

  const toggle = useCallback((id: DashboardSectionId) => {
    if (!uid) return                       // nothing to persist against yet
    const current = snapshot(uid)
    const next = toggleSection(current, id)
    if (next === current) return           // locked section — a no-op, not an error
    commit(uid, next)
  }, [uid])

  const reset = useCallback(() => {
    if (!uid) return
    commit(uid, defaultVisibility())
  }, [uid])

  return { visible, toggle, reset }
}

/** Test/sign-out seam: drops every cached preference. Mirrors clearWorkspaceCache(). */
export function clearSectionVisibilityCache(): void {
  cache.clear()
  listeners.forEach(l => l())
}
