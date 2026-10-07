// Shared marketing section components.
//
// These were built for the public Platform pages, which have been retired. Four of them
// outlived that section because /about, /security and /support compose their pages from
// the same primitives — so the folder stays, minus the seven parts that only ever rendered
// a Platform page (PlatformPage and the section blocks it assembled).
//
// The name is now historical. Renaming the folder would touch three unrelated pages for a
// word, so it is left alone deliberately rather than by oversight.

export { PlatformHero } from './PlatformHero'
export { PlatformSection } from './PlatformSection'
export { CapabilityGrid } from './CapabilityGrid'
export { PlatformCTA } from './PlatformCTA'
// Composed by the /solutions/* pages via SolutionPage, not by any Platform route.
export { ProductShowcase } from './ProductShowcase'
export { UseCases } from './UseCases'
