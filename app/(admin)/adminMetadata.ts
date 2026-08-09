// RD-ADMIN-CLOSURE-01 · Page metadata for the admin console.
//
// ═══ WHY A HELPER RATHER THAN 28 LITERALS ════════════════════════════════════
// RD-ADMIN-IA-01 found 27 of 28 admin pages exported no metadata, so every browser tab said
// the same thing — an admin working across Finance, Audit and Operations in three tabs could
// not tell them apart from the tab strip, and bookmarks and history were equally useless.
//
// The fix is one `metadata` export per page. This helper exists so the SUFFIX is defined
// once: 28 hand-written "… — RegisterDesk Admin" strings would drift the first time anyone
// renamed the console, which is the same duplication problem the sidebar SSOT solved for
// navigation.
//
// ═══ WHY NOT THE ADMIN LAYOUT ════════════════════════════════════════════════
// `app/(admin)/layout.tsx` is a Client Component (it holds sidebar state, auth gating and
// the command palette). Next.js supports `metadata` only in Server Components, so a layout
// export is not available and the title must be set per page.
//
// This file is NOT a client module and must not import one — it is read at build time by
// server components only.

import type { Metadata } from 'next'

/** Appended to every admin page title. One definition; change it here and every tab follows. */
const SUFFIX = 'RegisterDesk Admin'

/**
 * Metadata for one admin page.
 *
 * `description` is optional because a few consoles are self-evident from the title, and a
 * padded-out sentence is worse than none — but pass one wherever it tells an admin something
 * the title does not.
 */
export function adminMetadata(title: string, description?: string): Metadata {
  return {
    title: `${title} — ${SUFFIX}`,
    ...(description ? { description } : {}),
  }
}
