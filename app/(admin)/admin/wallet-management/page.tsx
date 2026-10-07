// RD-WALLET-W2.e · Super Admin Wallet Management (read-only). Server wrapper so the route can
// export `metadata`; the console is the Client Component beside it (the admin convention).

import { adminMetadata } from '@/app/(admin)/adminMetadata'
import PageClient from './PageClient'

export const metadata = adminMetadata('Wallet Management', 'Wallets, event services, refunds and reconciliation — read-only.')

export default function Page() {
  return <PageClient />
}
