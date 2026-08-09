// RD-STORAGE-01 · Platform Storage — error model.
//
// SDK-FREE. A caller must be able to branch on WHY an operation failed without catching a
// vendor error type. Every provider maps its own failures onto these codes, so swapping
// providers never changes a caller's error handling.

export type StorageErrorCode =
  | 'NOT_CONFIGURED'      // the provider has no usable credentials/bucket
  | 'INVALID_CREDENTIALS' // credentials present but rejected by the provider
  | 'BUCKET_NOT_FOUND'    // the configured bucket does not exist
  | 'NOT_FOUND'           // the object does not exist
  | 'ALREADY_EXISTS'      // a no-overwrite upload hit an existing key
  | 'INVALID_INPUT'       // bad path, bad type, missing event slug, …
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_TYPE'    // mime type or extension not allowed for this asset type
  | 'FORBIDDEN'           // the operation is not allowed (e.g. PUBLIC certificate)
  | 'PROVIDER_ERROR'      // anything else the provider reported

/**
 * The one error type this module throws.
 *
 * `message` is safe to log. It is NOT automatically safe to show a user — a route decides
 * that, the same way every other route in this codebase does.
 */
export class StorageError extends Error {
  readonly code: StorageErrorCode
  /** The provider's own error name/code, kept for logs. Never surfaced to a client. */
  readonly providerCode: string | null

  constructor(code: StorageErrorCode, message: string, providerCode: string | null = null) {
    super(message)
    this.name = 'StorageError'
    this.code = code
    this.providerCode = providerCode
  }
}

export function isStorageError(e: unknown): e is StorageError {
  return e instanceof StorageError
}

/** HTTP status a route should return for a given failure. Keeps route code uniform. */
export function storageErrorStatus(code: StorageErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':           return 404
    case 'ALREADY_EXISTS':      return 409
    case 'INVALID_INPUT':       return 400
    case 'FILE_TOO_LARGE':      return 413
    case 'UNSUPPORTED_TYPE':    return 415
    case 'FORBIDDEN':           return 403
    case 'NOT_CONFIGURED':
    case 'INVALID_CREDENTIALS':
    case 'BUCKET_NOT_FOUND':
    case 'PROVIDER_ERROR':
    default:                    return 500
  }
}
