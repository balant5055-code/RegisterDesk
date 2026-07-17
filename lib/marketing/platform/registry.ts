// Phase P.2.2A — Platform page registry.
//
// The single source of truth mapping a platform slug → its page config. This
// phase ships the framework only; individual pages (registration, payments, …)
// register their config here in later phases. The renderer + routes read from
// these accessors so nothing is hardcoded.

import type { PlatformPageConfig } from './types'

export const PLATFORM_PAGES: Record<string, PlatformPageConfig> = {}

export function getPlatformPage(slug: string): PlatformPageConfig | undefined {
  return PLATFORM_PAGES[slug]
}

export function getAllPlatformSlugs(): string[] {
  return Object.keys(PLATFORM_PAGES)
}

export function getAllPlatformPages(): PlatformPageConfig[] {
  return Object.values(PLATFORM_PAGES)
}
