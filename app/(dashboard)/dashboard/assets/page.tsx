import { Suspense } from 'react'
import AssetLibraryClient from './AssetLibraryClient'

export const metadata = {
  title: 'Asset Library — RegisterDesk',
}

export default function AssetLibraryPage() {
  return (
    <Suspense>
      <AssetLibraryClient />
    </Suspense>
  )
}
