// PA-3 — Print rendering engine public surface.
// Pure/server helpers for turning a Print Template design into a document.

export {
  RENDER_SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS, RENDER_TIER_ORDER,
  pageSizeOf, unitToPt,
  type RenderDocument, type RenderCanvas, type RenderMetadata, type PageSize,
} from './types'
export { normalizeDesign, validateRenderDocument, type ValidateResult } from './validate'
export {
  PRINT_VARIABLES, buildVariableMap, resolvePrintText, resolveWithSources,
  sampleVariableSources, type PrintVariableSources, type VariableSource,
} from './variables'
export { renderToPdf, renderToSvg, RenderError, type RenderInput } from './renderer'
export {
  loadPrintAssets, ensurePrintAssets, collectImageSources, type PrintAssetMap,
} from './assets'
