import { HubError } from './errors'
import type { Caller, Context } from './service'

/**
 * Who may call a path, checked before the handler runs:
 * - `key`: a keyed caller (not anonymous)
 * - `device`: a caller on an approved device of the hub
 * - `owner`: a member of the hub's owners group
 * - `user`: an end user a trusted gateway acts for (`request.user`, see `ServiceOptions.delegates`)
 */
export type Auth = 'key' | 'device' | 'owner' | 'user'

/** Declarative access rules of a path (`ApiSettings`); owners pass `groups` and `permission`. */
export interface Requirements {
  auth?: Auth
  /** The caller must be in one of these hub groups */
  groups?: string[]
  /**
   * A permission an owner grants on the hub (a grant of this path to the caller's key, device, group or everyone),
   * checked with `hub/grant/check`. It must be under the first segment of a path this service registers
   * (`posts/moderate` for a service of `posts/*`).
   */
  permission?: string
}

/** An end user a gateway acts for. A gateway sets `context.user` to an id or `{ id, ... }`. */
export interface DelegatedUser {
  id: string
  [key: string]: unknown
}

/** Asks the hub whether `permission` is granted to `caller` */
export type GrantCheck = (permission: string, caller: Caller) => Promise<boolean>

/**
 * The second argument of post and stream handlers: who calls, the request context, cancellation, and checks that
 * throw a `HubError` (`unauthorized` without a caller identity, `forbidden` with one).
 */
export class ServiceRequest {
  /** The caller, when the hub that forwarded the request is the pinned hub */
  declare caller?: Caller
  /** Request context without the hub's `hub` entry */
  context: Context
  /** The end user a trusted gateway acts for, from `context.user`; only set when the caller is a delegate */
  declare user?: DelegatedUser
  /** @internal */
  declare _check?: GrantCheck
  /** @internal */
  declare _path?: string
  private declare controller?: AbortController
  private declare abortReason?: unknown
  private declare grants?: Map<string, Promise<boolean>>
  constructor(context: Context, caller?: Caller) {
    this.context = context
    if (caller) this.caller = caller
  }
  /** The path being called */
  get path(): string {
    return this._path ?? ''
  }
  /**
   * Aborted when the caller cancels or disconnects, when the hub drops the call, and when the service stops or a
   * shutdown ends the call. Pass it to `fetch` and other long work.
   */
  get signal(): AbortSignal {
    if (!this.controller) {
      this.controller = new AbortController()
      if (this.abortReason !== undefined) this.controller.abort(this.abortReason)
    }
    return this.controller.signal
  }
  /** True once `signal` is aborted */
  get cancelled(): boolean {
    return this.abortReason !== undefined
  }
  /** @internal Aborts `signal` */
  _abort(reason: unknown = new HubError('cancelled', 'cancelled')) {
    if (this.abortReason !== undefined) return
    this.abortReason = reason
    this.controller?.abort(reason)
  }

  /** A keyed caller. Throws `unauthorized` for anonymous callers and when the hub sent no caller. */
  requireKey(): Caller & { key: string } {
    if (!this.caller?.key) throw HubError.unauthorized()
    return this.caller as Caller & { key: string }
  }
  /** A caller on an approved device of the hub */
  requireDevice(): Caller & { device: { id: string; name: string } } {
    const caller = this.requireKey()
    if (!caller.device) throw HubError.forbidden('device required')
    return caller as Caller & { key: string; device: { id: string; name: string } }
  }
  /** An owner of the hub */
  requireOwner(): Caller & { key: string } {
    const caller = this.requireKey()
    if (!caller.owner) throw HubError.forbidden()
    return caller
  }
  /** A member of one of `groups` (or an owner) */
  requireGroup(...groups: string[]): Caller & { key: string } {
    const caller = this.requireKey()
    if (!caller.owner && !groups.some(group => caller.groups?.includes(group))) throw HubError.forbidden()
    return caller
  }
  /** The end user a trusted gateway acts for */
  requireUser(): DelegatedUser {
    if (!this.user) throw HubError.unauthorized('user required')
    return this.user
  }
  /** Checks `auth` and `groups` */
  require(requirements: Requirements): void {
    switch (requirements.auth) {
      case 'key':
        this.requireKey()
        break
      case 'device':
        this.requireDevice()
        break
      case 'owner':
        this.requireOwner()
        break
      case 'user':
        this.requireUser()
        break
    }
    if (requirements.groups?.length) this.requireGroup(...requirements.groups)
  }

  /**
   * Whether an owner granted `permission` to the caller (`hub/grant/check`); owners always have it, anonymous callers
   * never. The answer is kept for the rest of this request.
   */
  can(permission: string): Promise<boolean> {
    const caller = this.caller
    if (!caller?.key) return Promise.resolve(false)
    if (caller.owner) return Promise.resolve(true)
    if (!this._check) return Promise.reject(HubError.unavailable('not connected to a hub'))
    this.grants ??= new Map()
    let answer = this.grants.get(permission)
    if (!answer) {
      answer = this._check(permission, caller)
      this.grants.set(permission, answer)
      answer.catch(() => this.grants?.delete(permission))
    }
    return answer
  }
  /** Throws `unauthorized` or `forbidden` unless the caller has `permission` */
  async requirePermission(permission: string): Promise<void> {
    this.requireKey()
    if (!(await this.can(permission))) throw HubError.forbidden()
  }
}

/** The end user in `context.user`, when the caller may act for users: an owner or a member of a `delegates` group */
export function delegatedUser(context: Context, caller: Caller | undefined, delegates: string[] | undefined): DelegatedUser | undefined {
  const value = context.user
  if (value === undefined || !caller?.key) return
  if (!caller.owner && !delegates?.some(group => caller.groups?.includes(group))) return
  if (typeof value === 'string' && value) return { id: value }
  if (value && typeof value === 'object' && typeof (value as any).id === 'string' && (value as any).id) return value as DelegatedUser
}

/**
 * Turns a body into the handler's input, or throws. A function, or an object with `parse` (a zod schema, for
 * example); any other error it throws becomes `invalid_input` with its message and `info.issues` when it has them.
 */
export type Validator<T> = ((body: unknown) => T) | { parse(body: unknown): T }

export function validate<T>(validator: Validator<T>, body: unknown): T {
  try {
    return typeof validator === 'function' ? validator(body) : validator.parse(body)
  } catch (error) {
    if (error instanceof HubError) throw error
    const message = typeof error === 'string' ? error : (error as any)?.message
    const issues = (error as any)?.issues
    throw HubError.invalidInput(
      typeof message === 'string' && message && !Array.isArray(issues) ? message : 'invalid input',
      Array.isArray(issues) ? { issues } : undefined,
    )
  }
}

/** Per-caller limit: `limit` calls per `window` seconds, a sliding window of accepted calls */
export interface RateLimit {
  limit: number
  window: number
  /**
   * Who is limited. Defaults to the delegated user, else the caller's key, else its device, else every anonymous
   * caller together. Return `undefined` to not limit a request.
   */
  by?: (request: ServiceRequest) => string | undefined
  /** Paths with the same bucket share their counts; each path has its own by default */
  bucket?: string
}

export function rateLimitKey(request: ServiceRequest): string {
  if (request.user) return `user:${request.user.id}`
  const caller = request.caller
  if (caller?.key) return `key:${caller.key}`
  if (caller?.device) return `device:${caller.device.id}`
  return 'anonymous'
}

/** Counts calls per key in memory, per process */
export class RateLimiter {
  private calls = new Map<string, number[]>()
  private swept = Date.now()
  constructor(readonly options: RateLimit) {}
  /** Throws `rate_limited` with `info.retryAfter` (whole seconds) when the key is over its limit */
  take(key: string, now = Date.now()) {
    const window = this.options.window * 1000
    if (now - this.swept > window) {
      this.swept = now
      this.calls.forEach((times, id) => {
        if (times[times.length - 1]! <= now - window) this.calls.delete(id)
      })
    }
    let times = this.calls.get(key)
    if (times) {
      while (times.length && times[0]! <= now - window) times.shift()
    } else {
      times = []
      this.calls.set(key, times)
    }
    if (times.length >= this.options.limit) {
      throw HubError.rateLimited(Math.max(1, Math.ceil((times[0]! + window - now) / 1000)))
    }
    times.push(now)
  }
}
