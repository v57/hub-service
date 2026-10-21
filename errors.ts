import { ChannelError } from 'channel/channel'

export { ChannelError }

/**
 * Codes the SDK and the hub use (channel wire v2 errors: `{ error, code, info }`). Services may use any other string
 * or integer code too.
 */
export type HubErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'invalid_input'
  | 'rate_limited'
  | 'unavailable'
  | 'not_found'
  | 'conflict'
  | 'cancelled'
  | (string & {})
  | number

/**
 * An error with a code and optional info. Thrown from a handler, the caller gets a `ChannelError` with the same
 * message, code and info (the hub passes them through).
 *
 * ```ts
 * throw HubError.notFound('post not found', { id })
 * throw new HubError('slow down', 'rate_limited', { retryAfter: 5 })
 * ```
 */
export class HubError extends ChannelError {
  constructor(message: string, code?: HubErrorCode, info?: any) {
    super(message, code, info)
    this.name = 'HubError'
  }
  /** No caller identity where one is needed: anonymous, or no caller from the hub */
  static unauthorized(message = 'unauthorized', info?: any) {
    return new HubError(message, 'unauthorized', info)
  }
  /** The caller is known but may not do this. The message is the hub's own `permissions required`. */
  static forbidden(message = 'permissions required', info?: any) {
    return new HubError(message, 'forbidden', info)
  }
  /** The body failed validation; `info.issues` lists the problems when the validator gave any */
  static invalidInput(message = 'invalid input', info?: any) {
    return new HubError(message, 'invalid_input', info)
  }
  static notFound(message = 'not found', info?: any) {
    return new HubError(message, 'not_found', info)
  }
  static conflict(message = 'conflict', info?: any) {
    return new HubError(message, 'conflict', info)
  }
  /** Too many calls; `retryAfter` in whole seconds */
  static rateLimited(retryAfter: number) {
    return new HubError('rate limited', 'rate_limited', { retryAfter })
  }
  /** The service isn't ready or is shutting down */
  static unavailable(message = 'service unavailable', info?: any) {
    return new HubError(message, 'unavailable', info)
  }
}

/** The code of an error from `send`, `values` or a handler, if it has one */
export function errorCode(error: unknown): string | number | undefined {
  const code = (error as any)?.code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}
