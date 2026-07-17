import { Suspense } from 'react'
import { PrintAssetsClient } from './PrintAssetsClient'

export const metadata = {
  title: 'Print Assets — RegisterDesk',
}

export default function PrintAssetsPage() {
  return (
    <Suspense>
      <PrintAssetsClient />
    </Suspense>
  )
}
