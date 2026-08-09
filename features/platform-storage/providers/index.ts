// RD-STORAGE-01 · Provider registry — SERVER ONLY.
//
// THE extension point. Adding LocalStorageProvider / S3Provider / AzureBlobProvider /
// GoogleCloudStorageProvider means:
//
//   1. implement `StorageProvider`
//   2. add one line here
//
// No business module changes, because no business module names a provider — they all go
// through StorageService.
//
// Sprint 5 ships exactly ONE provider, per the brief.

import { CloudflareR2Provider } from './cloudflare-r2/CloudflareR2Provider'
import type { StorageProvider } from '@/features/platform-storage/interfaces/StorageProvider'

export type StorageProviderId = 'cloudflare-r2'

/** The default provider id. A future `STORAGE_PROVIDER` env var selects among several. */
export const DEFAULT_PROVIDER_ID: StorageProviderId = 'cloudflare-r2'

/** Built once per process — the provider itself creates its client lazily. */
const singletons = new Map<StorageProviderId, StorageProvider>()

function construct(id: StorageProviderId): StorageProvider {
  switch (id) {
    case 'cloudflare-r2': return new CloudflareR2Provider()
    // Future:
    //   case 'local': return new LocalStorageProvider()
    //   case 's3':    return new S3Provider()
    default: {
      // Exhaustiveness: adding an id without a case is a COMPILE error, not a runtime one.
      const never: never = id
      throw new Error(`Unknown storage provider: ${String(never)}`)
    }
  }
}

export function getProvider(id: StorageProviderId = DEFAULT_PROVIDER_ID): StorageProvider {
  const existing = singletons.get(id)
  if (existing) return existing
  const created = construct(id)
  singletons.set(id, created)
  return created
}

/** Test seam: lets a suite install a fake provider without touching business code. */
export function __setProviderForTests(id: StorageProviderId, provider: StorageProvider): void {
  singletons.set(id, provider)
}

export function __resetProvidersForTests(): void {
  singletons.clear()
}
