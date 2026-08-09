// RD-EVENT-14 · A minimal React DevTools global hook. DEV TOOLING ONLY.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// The RD-EVENT-07 harness reads React's commit stream through
// `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`, which normally comes from the browser extension.
// Playwright runs a clean Chromium with no extensions, so React finds no hook at bootstrap,
// never calls `onCommitFiberRoot`, and the harness records zero commits.
//
// React looks for the hook ONCE, when react-dom initialises. So this must be installed via
// `page.addInitScript` — before any application script runs. Injecting it later silently
// produces empty profiles, which is the failure mode this file exists to prevent.
//
// ═══ WHAT REACT ACTUALLY REQUIRES ════════════════════════════════════════════
// Far less than the real extension. React checks for the hook object, calls `inject()` to
// register its renderer, and then calls the commit callbacks. `supportsFiber` must be true
// or react-dom refuses to attach. `checkDCE` is called by production builds to verify
// dead-code elimination ran; it must exist and must not throw.
//
// Everything else is a no-op stub. This is deliberately NOT a DevTools reimplementation —
// it is the smallest surface that makes the commit stream observable.

/** The hook shape react-dom probes for. Kept structural — we never import React's types. */
export interface MinimalDevToolsHook {
  supportsFiber: true
  renderers: Map<number, unknown>
  onCommitFiberRoot?: (id: number, root: unknown, priority?: unknown, didError?: boolean) => void
  onCommitFiberUnmount?: (id: number, fiber: unknown) => void
  onPostCommitFiberRoot?: (id: number, root: unknown) => void
  inject: (renderer: unknown) => number
  checkDCE: (fn: unknown) => void
  isDisabled?: boolean
}

/**
 * Source of the init script, as a string.
 *
 * Returned as source rather than a function reference because `addInitScript` serialises it
 * into a fresh JS context — it cannot close over anything in the Node process.
 */
export const DEVTOOLS_HOOK_INIT_SCRIPT = `
(() => {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return
  let nextId = 1
  const renderers = new Map()
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    renderers,
    // React calls this to register itself. The returned id is passed back on every commit.
    inject(renderer) {
      const id = nextId++
      renderers.set(id, renderer)
      return id
    },
    // Production React calls this to confirm dead-code elimination ran. It must exist and
    // must not throw; the real implementation only emits a console warning.
    checkDCE() {},
    // Overwritten by the RD-EVENT-07 harness once it installs. Defined here so React has
    // something to call between bootstrap and harness installation.
    onCommitFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
  }
})()
`
