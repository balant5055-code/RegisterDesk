// Phase P.2 — Platform framework barrel (types + registry + seo helpers).

export type {
  PlatformPageConfig, PlatformHeroConfig, PlatformSectionConfig, PlatformCtaConfig,
  PlatformSeoConfig, PlatformCapabilityItem, PlatformHighlightItem,
  PlatformIntegrationItem, PlatformUseCaseItem,
} from './types'
export { PLATFORM_PAGES, getPlatformPage, getAllPlatformSlugs, getAllPlatformPages } from './registry'
export { platformPath, buildPlatformMetadata, platformJsonLd } from './seo'
