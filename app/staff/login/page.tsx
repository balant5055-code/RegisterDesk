// /staff/login — RD-CHECKIN-2.0
//
// A shell only. Authentication happens client-side against Firebase (the same
// `authenticateUser` every other login surface uses), and every consequence of it —
// which events this operator may open, whether they still owe a password change —
// is decided by a Node route handler that re-verifies the token.

import StaffLoginClient from './StaffLoginClient'

export default function StaffLoginPage() {
  return <StaffLoginClient />
}
