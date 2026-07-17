'use client'

// RD-CONF-11: bridges the runtime security policy into the session manager.
// Rendered INSIDE BusinessConfigProvider so useSecurity() returns the live config
// (the dashboard layout itself sits above the provider). It owns the idle-session
// hook + warning modal that previously lived directly in the layout — no auth
// logic changed, only where the timeout values come from.

import { useSessionManager } from '@/lib/session/useSessionManager'
import { useSecurity } from '@/lib/config/securityClient'
import { SessionWarningModal } from './SessionWarningModal'

export function SessionGuard({ enabled }: { enabled: boolean }) {
  const { sessionIdleTimeoutMinutes, sessionWarnBeforeMinutes } = useSecurity()

  const { showWarning, countdown, onStaySignedIn, onLogout } = useSessionManager(enabled, {
    idleTimeoutMs: sessionIdleTimeoutMinutes * 60_000,
    warnBeforeMs:  sessionWarnBeforeMinutes * 60_000,
  })

  return (
    <SessionWarningModal
      open={showWarning}
      countdown={countdown}
      onStaySignedIn={onStaySignedIn}
      onLogout={onLogout}
    />
  )
}
