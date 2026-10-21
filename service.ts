import type { SendOptions } from 'channel/channel'
import { Channel, type Sender } from 'channel/client'
import { NetworkPublisher, type NetworkShare, type NetworkPolicy } from './network'
import type { DeviceData, DeviceDescription } from './device-api'
import { HubError } from './errors'
import {
  RateLimiter,
  ServiceRequest,
  delegatedUser,
  rateLimitKey,
  validate,
  type RateLimit,
  type Requirements,
  type Validator,
} from './request'
export { ServiceRequest } from './request'
type AnyIterator = AsyncIterator<any, void, any> | Promise<AsyncIterator<any, void, any>>

export interface Context {
  /** Provider selection: connection id or service key */
  service?: string
  /** Provider selection: device id */
  device?: string
  [key: string]: unknown
}

/** Who made a request, as the hub tells the service (`context.hub.caller`). */
export interface Caller {
  /** Absent for anonymous callers */
  key?: string
  /** Absent unless the caller's connection is attached to a device */
  device?: { id: string; name: string }
  groups?: string[]
  owner?: boolean
  /** Set on requests through a merged hub: the merged hub's key */
  via?: string
  /** What the merged hub said about its caller. Unverified. */
  claimed?: Caller
}

export interface ServiceProvider {
  id: string
  name?: string
}

/** Pinned hub keys by hub address. */
export interface HubKeyStore {
  get(address: string): Promise<string | undefined> | string | undefined
  set(address: string, hubKey: string | undefined): Promise<void> | void
}

/** What a service signs its connection with. */
export interface ServiceIdentity {
  /** `auth` header value; bound to `hubKey` (v1) when one is given. */
  sign(hubKey?: string): Promise<string>
  /** Where learned hub keys are pinned. Without it they are pinned in memory only. */
  hubKeys?: HubKeyStore
  /** `device` header value (service certificate) for a v1 connection, if this service runs in device mode. */
  certificate?(): Promise<string | undefined>
}

/** Result of `hub/info` (hub-server only). */
export interface HubInfo {
  key: string
  protocol: number
  pro?: boolean
  mode?: 'default-allow' | 'default-deny'
}

export class MultiplatformService {
  address: string | number
  channel = new Channel()
  sender?: (Sender & { ws?: ClientSocket }) | undefined
  apps: AppHeader[] = []
  group?: string
  settings: Record<string, ApiSettings> = {}
  profile?: Profile
  identity: ServiceIdentity
  /** Signs v1 tokens. False for a plain sign function, which only makes v0 tokens. */
  readonly supportsV1: boolean
  /** The pinned key of the hub at `address`, once known. */
  hubKey?: string
  /** Protocol version of the current or last connection. */
  connectedVersion?: '0' | '1'
  /**
   * Set when the hub refused the connection. The channel client stops reconnecting then, so the service stays
   * disconnected until `forgetHubKey()`; sends fail with this error instead of waiting.
   */
  refusedError?: HubRefusedError
  /** Called when the hub refuses the connection. */
  onError?: (error: HubRefusedError) => void
  /** Rejects sends that are waiting when a refusal comes in */
  private waitingSends = new Set<(error: Error) => void>()
  /** Asks for the reporter role of this service's device. */
  readonly reporter: boolean
  /** The last description passed to `describeDevice`, sent again on every connect. */
  deviceDescription?: DeviceDescription
  /** True once the hub accepted this connection's description; false when another service reports for the device. */
  isDeviceReporter?: boolean
  private describeRetry?: ReturnType<typeof setInterval>
  /** Stops the `reportDeviceData` loops, for `stop()` */
  private reports = new Set<() => void>()
  private isOpen = false
  /** Set by `stop()`, so the closing connection isn't taken for a refusal */
  private isStopped = false
  private hubKeyLoaded = false
  private readonly initialHubKey?: string
  private readonly memoryHubKeys = new MemoryHubKeys()
  /** Groups whose members may act for end users (`context.user`), see `ServiceOptions.delegates` */
  delegates?: string[]
  /** Default per-caller limit of paths without their own `rateLimit` */
  rateLimit?: RateLimit
  /** Seconds `hub/grant/check` answers are kept, 0 to ask every time */
  grantCache: number
  /** Calls whose handlers are running */
  private running = new Set<RunningCall>()
  private limiters = new Map<string, RateLimiter>()
  private grantAnswers = new Map<string, { allowed: boolean; expires: number }>()
  private readyState: boolean
  private shuttingDown = false
  private idle = new Set<() => void>()
  constructor(sign: (() => Promise<string>) | ServiceIdentity, options?: ServiceOptions) {
    this.supportsV1 = typeof sign !== 'function'
    this.identity = typeof sign === 'function' ? { sign: () => sign() } : sign
    this.initialHubKey = options?.hubKey
    this.reporter = options?.reporter ?? false
    this.onError = options?.onError
    this.delegates = options?.delegates
    this.rateLimit = options?.rateLimit
    this.grantCache = options?.grantCache ?? 0
    this.readyState = options?.ready ?? true
    const address = options?.address ?? globalThis.Bun?.env?.HUB ?? 1997
    // `HUB=1998` is a port
    this.address = typeof address === 'string' && /^\d+$/.test(address) ? Number(address) : address
    if (options?.name || options?.icon) {
      this.profile = {}
      if (options.name) this.profile.name = options.name
      if (options.icon) this.profile.icon = options.icon
    }
  }
  start(): this {
    this.isStopped = false
    this.shuttingDown = false
    const services: ServiceHeader[] = []
    for (const path of Object.keys(this.channel.postApi.storage)) {
      const settings = this.settings[path] ?? {}
      services.push({
        path,
        permissions: settings.permissions,
        limit: settings.limit,
        public: settings.public || undefined,
      })
    }
    for (const path of Object.keys(this.channel.streamApi.storage)) {
      const settings = this.settings[path] ?? {}
      services.push({
        path,
        permissions: settings.permissions,
        limit: settings.limit,
        public: settings.public || undefined,
      })
    }
    const apps = this.apps
    const getProfile = () => this.profile
    const onConnected = (sender: Sender) => this.onConnected(sender)
    const learnHubKey = (sender: Sender) => this.learnHubKey(sender)
    const opened = () => {
      this.isOpen = true
      this.refusedError = undefined
      this.isDeviceReporter = undefined
    }
    const reporter = this.reporter
    const registered = () => this.sendDescription()
    const acceptsCalls = () => this.acceptsCalls
    this.sender = this.channel.connect(this.address, {
      headers: () => this.headers(),
      async onConnect(sender) {
        opened()
        // A newly learned hub key takes effect on the next connect
        if (await learnHubKey(sender)) return
        try {
          const profile = getProfile()
          if (profile) await sender.send('hub/profile/update', profile)
        } catch {}
        const update: Record<string, unknown> = reporter ? { services, apps, reporter } : { services, apps }
        // A service that isn't ready registers its paths without taking calls
        if (!acceptsCalls()) update.draining = true
        await sender.send('hub/service/update', update)
        await registered()

        await onConnected(sender)
      },
    })
    this.watchRefusal()
    return this
  }
  /**
   * The channel client stops for good when the hub refuses the upgrade.
   * A refused v1 connect means the hub key changed or another server answers; it is reported, never retried as v0.
   */
  private watchRefusal() {
    const ws = this.sender?.ws
    if (!ws) return
    const onclose = ws.onclose
    ws.onclose = () => {
      const wasOpen = this.isOpen
      this.isOpen = false
      onclose?.()
      // Channel sets isRunning to false when the upgrade is answered without a WebSocket
      if (wasOpen || ws.isRunning || this.isStopped) return
      this.refused(new HubRefusedError(this.hubAddress, this.connectedVersion === '1' ? this.hubKey : undefined))
    }
  }
  /** Disconnects from the hub and stops reconnecting; sends that are waiting fail. `start()` connects again. */
  stop() {
    this.isStopped = true
    this.isOpen = false
    this.stopDescribeRetry()
    ;[...this.reports].forEach(stop => stop())
    const sender = this.sender
    this.sender = undefined
    sender?.stop()
    const waiting = [...this.waitingSends]
    this.waitingSends.clear()
    waiting.forEach(reject => reject(new Error('Service stopped')))
    const running = [...this.running]
    this.running.clear()
    running.forEach(call => call.request._abort(HubError.unavailable('service stopped')))
    this.notifyIdle()
  }

  /** Takes calls: ready, not shutting down and not stopped */
  get acceptsCalls(): boolean {
    return this.readyState && !this.shuttingDown && !this.isStopped
  }
  /** False between `setReady(false)` (or `ready: false`) and `setReady(true)` */
  get isReady(): boolean {
    return this.readyState
  }
  /** Calls whose handlers are running */
  get runningCalls(): number {
    return this.running.size
  }
  /**
   * Whether the hub may route new calls here. While not ready, the paths stay registered but the hub sends their
   * calls to other providers or keeps them waiting (`hub/service/update { draining: true }`), and calls that still
   * arrive fail with `unavailable`. Running calls go on.
   */
  async setReady(ready: boolean): Promise<void> {
    if (this.readyState === ready) return
    this.readyState = ready
    await this.sendDraining()
  }
  /**
   * Graceful shutdown: tells the hub to send no more calls, ends running streams (paths with `shutdown: 'end'`,
   * the default for streams), waits up to `timeout` milliseconds for the other running calls, aborts what is left
   * and stops. Resolves true when every call finished in time.
   */
  async shutdown(options: { timeout?: number } = {}): Promise<boolean> {
    const timeout = options.timeout ?? 10_000
    this.shuttingDown = true
    await this.sendDraining()
    for (const call of [...this.running]) if (call.shutdown === 'end') call.end()
    const finished = await this.whenIdle(timeout)
    for (const call of [...this.running]) call.end()
    // The last calls' responses go out after their handlers finish
    await new Promise(resolve => setTimeout(resolve, 0))
    this.stop()
    return finished
  }
  /** What a supervisor or health check needs to know */
  get health(): ServiceHealth {
    const status: ServiceHealth['status'] =
      this.isStopped || !this.sender
        ? 'stopped'
        : this.refusedError
          ? 'refused'
          : this.shuttingDown
            ? 'shutting_down'
            : !this.isOpen
              ? 'disconnected'
              : this.readyState
                ? 'ready'
                : 'not_ready'
    return { status, connected: this.isOpen, ready: this.readyState, running: this.running.size }
  }
  private async sendDraining() {
    if (!this.isOpen || !this.sender) return
    try {
      await Promise.race([
        this.sender.send('hub/service/update', { draining: !this.acceptsCalls }),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ])
    } catch {}
  }
  private whenIdle(timeout: number): Promise<boolean> {
    if (!this.running.size) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = (finished: boolean) => {
        clearTimeout(timer)
        this.idle.delete(idle)
        resolve(finished)
      }
      const idle = () => done(true)
      const timer = setTimeout(() => done(false), timeout)
      this.idle.add(idle)
    })
  }
  private notifyIdle() {
    if (this.running.size) return
    ;[...this.idle].forEach(idle => idle())
  }
  private refused(error: HubRefusedError) {
    this.refusedError = error
    console.error(error.message)
    const waiting = [...this.waitingSends]
    this.waitingSends.clear()
    waiting.forEach(reject => reject(error))
    try {
      this.onError?.(error)
    } catch (handlerError) {
      console.error('onError failed:', handlerError)
    }
  }
  /**
   * Registers a request handler. `settings` may require a caller (`auth`, `groups`, `permission`), limit calls per
   * caller (`rateLimit`) and validate the body (`input`, whose result the handler gets); failed checks throw a
   * `HubError` before the handler runs.
   */
  post<Body = any>(path: string, action: (body: Body, request: ServiceRequest) => any | Promise<any>, settings?: ApiSettings<Body>) {
    this.addSettings(path, settings)
    const permission = settings?.permission
    const input = settings?.input
    const shutdown = settings?.shutdown ?? 'wait'
    this.channel.post(path, ({ body, context, task }) => {
      const request = this.admit(path, context, settings)
      if (permission) {
        const result = request.requirePermission(permission).then(() => action(input ? validate(input, body) : body, request))
        return this.track(request, result, shutdown, task)
      }
      const result = action(input ? validate(input, body) : body, request)
      return result?.then ? this.track(request, result, shutdown, task) : result
    })
    return this
  }
  /** Registers an async iterator handler, with the same `settings` as `post` */
  stream<Body = any>(path: string, action: (body: Body, request: ServiceRequest) => AnyIterator, settings?: ApiSettings<Body>) {
    this.addSettings(path, settings)
    const permission = settings?.permission
    const input = settings?.input
    const shutdown = settings?.shutdown ?? 'end'
    this.channel.stream(path, async ({ body, context }) => {
      const request = this.admit(path, context, settings)
      if (permission) await request.requirePermission(permission)
      const values = await action(input ? validate(input, body) : body, request)
      return new TrackedStream(values, request, shutdown, this.running, () => this.notifyIdle())
    })
    return this
  }
  /**
   * Reads the caller from `context.hub`. It is trusted only when it names the pinned hub key, because a hub
   * that predates caller identity may pass a client's context through unchanged.
   */
  request(context: any, path?: string): ServiceRequest {
    const { hub, ...rest } = context && typeof context === 'object' ? context : ({} as any)
    const trusted = hub && typeof hub === 'object' && this.hubKey && hub.hubKey === this.hubKey && hub.caller && typeof hub.caller === 'object'
    const request = new ServiceRequest(rest, trusted ? hub.caller : undefined)
    const user = delegatedUser(rest, request.caller, this.delegates)
    if (user) request.user = user
    if (path) request._path = path
    request._check = this.checkGrant
    return request
  }
  /** A request for `path` that passed readiness, `auth`, `groups` and the rate limit */
  private admit(path: string, context: any, settings: ApiSettings<any> | undefined): ServiceRequest {
    if (!this.acceptsCalls) throw HubError.unavailable()
    const request = this.request(context, path)
    if (settings?.auth || settings?.groups) request.require(settings)
    const limit = settings?.rateLimit === false ? undefined : (settings?.rateLimit ?? this.rateLimit)
    if (limit) {
      const key = limit.by ? limit.by(request) : rateLimitKey(request)
      if (key !== undefined) this.limiter(limit.bucket ?? path, limit).take(key)
    }
    return request
  }
  private limiter(bucket: string, options: RateLimit): RateLimiter {
    let limiter = this.limiters.get(bucket)
    if (!limiter || limiter.options !== options) {
      limiter = new RateLimiter(options)
      this.limiters.set(bucket, limiter)
    }
    return limiter
  }
  /** Keeps a running post in `running`, aborting its signal when the hub cancels it */
  private track<T>(request: ServiceRequest, result: Promise<T>, shutdown: 'wait' | 'end', task?: { onCancel(action: () => void): void }): Promise<T> {
    const call: RunningCall = { request, shutdown, end: () => request._abort(HubError.unavailable('service stopped')) }
    this.running.add(call)
    task?.onCancel(() => request._abort())
    return result.finally(() => {
      this.running.delete(call)
      this.notifyIdle()
    })
  }
  /** Asks the hub whether a permission is granted to a caller, keeping answers for `grantCache` seconds */
  private checkGrant = async (permission: string, caller: Caller): Promise<boolean> => {
    const subject: Record<string, unknown> = {}
    if (caller.key) subject.key = caller.key
    if (caller.device) subject.device = { id: caller.device.id }
    if (caller.via) subject.via = caller.via
    const id = this.grantCache > 0 ? JSON.stringify([permission, subject]) : undefined
    const cached = id ? this.grantAnswers.get(id) : undefined
    if (cached && cached.expires > Date.now()) return cached.allowed
    const answer = await this.send('hub/grant/check', { path: permission, caller: subject })
    const allowed = answer?.allowed === true
    if (id) {
      if (this.grantAnswers.size > 10_000) this.grantAnswers.clear()
      this.grantAnswers.set(id, { allowed, expires: Date.now() + this.grantCache * 1000 })
    }
    return allowed
  }
  /**
   * Reports this device's capabilities as its reporter (`reporter: true`). The description is kept and sent again
   * after every reconnect. Returns false while another service is the device's reporter or the hub is unreachable;
   * it is retried every minute, so a service that takes over the role describes the device.
   */
  async describeDevice(description: DeviceDescription): Promise<boolean> {
    this.deviceDescription = description
    return this.sendDescription()
  }

  /**
   * Sends live data (`hub/device/data`) as the device's reporter. Returns false when this service is not the
   * reporter or the hub is unreachable. Data is not kept: send it again on the next tick.
   */
  async sendDeviceData(data: DeviceData): Promise<boolean> {
    if (!this.reporter || !this.isOpen) return false
    // Re-describe after taking over the role from another reporter
    if (this.deviceDescription && !this.isDeviceReporter && !(await this.sendDescription())) return false
    try {
      await this.send('hub/device/data', data)
      this.isDeviceReporter = true
      return true
    } catch (error) {
      if (String(error) === 'not the device reporter') this.isDeviceReporter = false
      return false
    }
  }

  /** Calls `collect` every `interval` milliseconds and sends the result as live data. Returns a stop function; `stop()` ends it too. */
  reportDeviceData(interval: number, collect: () => DeviceData | Promise<DeviceData>): () => void {
    let running = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        await this.sendDeviceData(await collect())
      } catch (error) {
        console.error('Failed to collect device data:', error)
      }
      if (running) timer = setTimeout(tick, interval)
    }
    timer = setTimeout(tick, 0)
    const stop = () => {
      running = false
      if (timer) clearTimeout(timer)
      this.reports.delete(stop)
    }
    this.reports.add(stop)
    return stop
  }

  /** Devices with their services, presence and capabilities (`hub/devices`, owners and grants). Yields `Device[]`. */
  devices() {
    return this.values('hub/devices')
  }
  /** Devices waiting for approval (`hub/devices/pending`, owners). Yields `PendingDevice[]`. */
  pendingDevices() {
    return this.values('hub/devices/pending')
  }
  /** Latest live data of a device, then updates (`hub/devices/data`). Yields `DeviceData`. */
  deviceData(id: string) {
    return this.values('hub/devices/data', { id })
  }

  private async sendDescription(): Promise<boolean> {
    const description = this.deviceDescription
    if (!this.reporter || !description || !this.isOpen || !this.sender) return false
    try {
      await this.sender.send('hub/device/describe', description)
      this.isDeviceReporter = true
      this.stopDescribeRetry()
      return true
    } catch (error) {
      if (String(error) === 'not the device reporter') this.isDeviceReporter = false
      this.startDescribeRetry()
      return false
    }
  }
  private startDescribeRetry() {
    if (this.describeRetry) return
    this.describeRetry = setInterval(() => {
      if (!this.isOpen) return
      void this.sendDescription()
    }, 60_000)
    ;(this.describeRetry as any).unref?.()
  }
  private stopDescribeRetry() {
    if (!this.describeRetry) return
    clearInterval(this.describeRetry)
    this.describeRetry = undefined
  }

  /** Key under which this service's hub key is pinned. */
  get hubAddress(): string {
    return normalizeHubAddress(this.address)
  }

  /** Connection headers, re-evaluated on every connect. */
  async headers(): Promise<Record<string, string>> {
    const hubKey = this.supportsV1 ? await this.pinnedHubKey() : undefined
    this.connectedVersion = hubKey ? '1' : '0'
    const headers: Record<string, string> = hubKey
      ? { auth: await this.identity.sign(hubKey), v: '1' }
      : { auth: await this.identity.sign(), v: '0' }
    // The hub accepts a certificate on v0 and v1 connects alike
    try {
      const device = await this.identity.certificate?.()
      if (device) headers.device = device
    } catch (error) {
      console.error('Failed to make the device certificate:', error)
    }
    return headers
  }

  /** Clears the pinned hub key, for when the hub's key changed on purpose. The next connect uses v0 and learns it again. */
  async forgetHubKey(): Promise<void> {
    this.hubKey = undefined
    this.hubKeyLoaded = true
    await this.hubKeyStore.set(this.hubAddress, undefined)
    const ws = this.sender?.ws
    if (this.refusedError && ws && !ws.isRunning) {
      this.refusedError = undefined
      ws.isRunning = true
      ws.start()
    }
  }

  private get hubKeyStore(): HubKeyStore {
    return this.identity.hubKeys ?? this.memoryHubKeys
  }

  private async pinnedHubKey(): Promise<string | undefined> {
    if (!this.hubKeyLoaded) {
      try {
        this.hubKey = (await this.hubKeyStore.get(this.hubAddress)) ?? this.initialHubKey
      } catch (error) {
        console.error('Failed to read pinned hub keys:', error)
        this.hubKey = this.initialHubKey
      }
      this.hubKeyLoaded = true
    }
    return this.hubKey
  }

  /**
   * On a v0 connection, asks the hub for its key and pins it.
   * Returns true when it reconnects to switch to v1. Hubs without `hub/info` (hub-lite) stay on v0.
   */
  private async learnHubKey(sender: Sender): Promise<boolean> {
    if (!this.supportsV1 || this.connectedVersion !== '0') return false
    let info: HubInfo
    try {
      info = await sender.send('hub/info')
    } catch {
      return false
    }
    if (typeof info?.key !== 'string' || !info.key) return false
    this.hubKey = info.key
    this.hubKeyLoaded = true
    try {
      await this.hubKeyStore.set(this.hubAddress, info.key)
    } catch (error) {
      console.error('Failed to pin the hub key:', error)
    }
    this.reconnect()
    return true
  }

  /** Drops the current connection; the channel client reconnects with fresh headers. */
  protected reconnect() {
    this.sender?.ws?.ws?.close()
  }

  /** Fails with `refusedError` when the hub refused the connection, instead of waiting for a reconnect that never comes. */
  send(path: string, body?: any, options?: SendOptions): Promise<any> {
    if (!this.sender) throw 'Service not started'
    if (this.refusedError) return Promise.reject(this.refusedError)
    const response = this.sender.send(path, body, options)
    let reject!: (error: Error) => void
    const refused = new Promise<never>((_, r) => (reject = r))
    this.waitingSends.add(reject)
    return Promise.race([response, refused]).finally(() => this.waitingSends.delete(reject))
  }
  values(path: string, body?: any, options?: SendOptions) {
    if (!this.sender) throw 'Service not started'
    if (this.refusedError) throw this.refusedError
    return this.sender.values(path, body, options)
  }
  private addSettings(path: string, settings: ApiSettings<any> | undefined) {
    if (!settings) return
    this.settings[path] = settings
    if (settings.permissions && !settings.permissions.group) {
      if (!this.group) this.group = path.split('/')[0]
      settings.permissions.group = this.group
    }
  }

  protected async onConnected(_sender: Sender): Promise<void> {}
}

/** Bun service with local Hub Network publication support. */
export class NetworkService extends MultiplatformService {
  readonly network = new NetworkPublisher()
  private readonly signChallenge: (challenge: string) => Promise<string>
  private readonly publicKey: () => Promise<string>

  constructor(
    sign: (() => Promise<string>) | ServiceIdentity,
    signChallenge: (challenge: string) => Promise<string>,
    publicKey: () => Promise<string>,
    options?: ServiceOptions,
  ) {
    super(sign, options)
    this.signChallenge = signChallenge
    this.publicKey = publicKey
  }

  protected override async onConnected(sender: Sender): Promise<void> {
    if (!this.network.hasShares) return
    try {
      await this.network.republishAll(await this.publicKey(), this.signChallenge, sender)
    } catch (error) {
      console.error('Failed to republish network shares:', error)
    }
  }

  /**
   * Declare a network share before start().
   *
   * Use this for listeners whose runtime-selected port is known before the
   * service connects. The complete declared set is published on connect and
   * republished after every reconnect.
   */
  share(
    shareName: string,
    protocol: 'tcp' | 'udp',
    host: string,
    port: number,
    policy?: NetworkPolicy,
  ): this {
    this.network.declareShare({
      name: shareName,
      protocol,
      target: { host, port },
      policy: policy ?? { mode: 'private' },
    })
    return this
  }

  /**
   * Publish a network share.
   * Makes a local TCP/UDP port available through Hub Network.
   *
   * @param shareName - Stable name for the share
   * @param protocol - 'tcp' or 'udp'
   * @param host - Local host (usually 'localhost' or '127.0.0.1')
   * @param port - Local port number
   * @param policy - Optional access policy (default: private)
   *
   * @example
   * service.publishShare('s3', 'tcp', 'localhost', 8080, { mode: 'hub' })
   */
  async publishShare(
    shareName: string,
    protocol: 'tcp' | 'udp',
    host: string,
    port: number,
    policy?: NetworkPolicy,
  ): Promise<this> {
    const share: NetworkShare = {
      name: shareName,
      protocol,
      target: { host, port },
      policy: policy ?? { mode: 'private' },
    }

    if (!this.sender) throw new Error('Service not started')
    await this.network.publishShare(
      share,
      await this.publicKey(),
      this.signChallenge,
      this.sender,
    )
    return this
  }

  /**
   * Update a network share's policy or target port.
   * Removes and republishes the share with new settings.
   *
   * @param shareName - Name of the share to update
   * @param options - New policy or port
   */
  async updateShare(
    shareName: string,
    options: { policy?: NetworkPolicy; port?: number },
  ): Promise<this> {
    const currentShare = this.network.declaredShares.find(share => share.name === shareName)
    if (!currentShare) {
      throw new Error(`Share '${shareName}' not found`)
    }

    const updatedShare: NetworkShare = {
      ...currentShare,
      ...(options.policy && { policy: options.policy }),
      ...(options.port !== undefined && {
        target: { ...currentShare.target, port: options.port },
      }),
    }

    if (!this.sender) throw new Error('Service not started')
    await this.network.publishShare(
      updatedShare,
      await this.publicKey(),
      this.signChallenge,
      this.sender,
    )
    return this
  }

  /**
   * Remove a published network share.
   * Disables the share and removes it from Hub Network.
   */
  async removeShare(shareName: string): Promise<this> {
    if (!this.sender) throw new Error('Service not started')
    await this.network.removeShare(
      shareName,
      await this.publicKey(),
      this.signChallenge,
      this.sender,
    )
    return this
  }

  /**
   * Get current network share publications.
   * Returns the overlay addresses and ports for published shares.
   */
  getSharePublications() {
    return this.network.getPublications()
  }

  /**
   * Get a specific share's publication info.
   */
  getSharePublication(shareName: string) {
    return this.network.getPublication(shareName)
  }
}
export interface ServiceOptions {
  address?: string | number
  name?: string
  icon?: Icon
  /** The hub's key, if known up front (from an invitation or config). Otherwise learned through `hub/info`. */
  hubKey?: string
  /**
   * Ask for the reporter role of this service's device: the hub takes `describeDevice` and `sendDeviceData`
   * from the first connected reporter of each device. Needs a device certificate.
   */
  reporter?: boolean
  /** Called when the hub refuses the connection (see `refusedError`). */
  onError?: (error: HubRefusedError) => void
  /**
   * Hub groups whose members may act for end users: a gateway in one of them (or an owner) sets `context.user` to a
   * user id or `{ id, ... }`, and handlers read it as `request.user`. From other callers `context.user` is ignored.
   */
  delegates?: string[]
  /** Per-caller limit for every path without its own `rateLimit` */
  rateLimit?: RateLimit
  /** Seconds to keep `hub/grant/check` answers (permission checks); 0, the default, asks the hub every time */
  grantCache?: number
  /** False to connect without taking calls until `setReady(true)` */
  ready?: boolean
}

/** `service.health` */
export interface ServiceHealth {
  status: 'ready' | 'not_ready' | 'shutting_down' | 'disconnected' | 'refused' | 'stopped'
  connected: boolean
  ready: boolean
  /** Calls whose handlers are running */
  running: number
}

interface RunningCall {
  request: ServiceRequest
  shutdown: 'wait' | 'end'
  /** Aborts the call's signal; a stream also ends for its caller */
  end(): void
}

/**
 * A stream handler's values, kept in `running` until they end. A cancel from the hub aborts the request's signal at
 * once (an async generator only sees `return()` at its next `yield`), and `end()` finishes the stream for the caller.
 */
class TrackedStream implements AsyncIterator<any, void, any> {
  private ended = false
  private finished = false
  private endNow!: (result: IteratorResult<any, void>) => void
  private readonly endPromise = new Promise<IteratorResult<any, void>>(resolve => (this.endNow = resolve))
  private readonly call: RunningCall
  constructor(
    private readonly values: AsyncIterator<any, void, any>,
    private readonly request: ServiceRequest,
    shutdown: 'wait' | 'end',
    private readonly running: Set<RunningCall>,
    private readonly onFinish: () => void,
  ) {
    this.call = { request, shutdown, end: () => this.end() }
    running.add(this.call)
  }
  next(): Promise<IteratorResult<any, void>> {
    if (this.ended) return Promise.resolve({ done: true, value: undefined })
    return Promise.race([this.values.next(), this.endPromise]).then(
      result => {
        if (result.done) this.finish()
        return result
      },
      error => {
        this.finish()
        throw error
      },
    )
  }
  async return(value?: any): Promise<IteratorResult<any, void>> {
    this.request._abort()
    this.ended = true
    this.finish()
    try {
      await this.values.return?.(value)
    } catch {}
    return { done: true, value: undefined }
  }
  /** Ends the stream for its caller and aborts the handler's signal */
  end() {
    if (this.ended) return
    this.ended = true
    this.request._abort(HubError.unavailable('service stopped'))
    this.endNow({ done: true, value: undefined })
    this.finish()
    this.values.return?.()?.catch?.(() => {})
  }
  private finish() {
    if (this.finished) return
    this.finished = true
    this.running.delete(this.call)
    this.onFinish()
  }
}

/**
 * The key a hub's pin is stored under: the dialed URL as channel builds it (a bare port is
 * `ws://localhost:<port>`), with the scheme and host lowercased and no trailing slash.
 */
export function normalizeHubAddress(address: string | number): string {
  if (typeof address === 'number' || /^\d+$/.test(address)) return `ws://localhost:${address}`
  const match = address.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)(.*)$/)
  if (!match) return address.replace(/\/+$/, '')
  const [, scheme, authority, rest] = match
  return `${scheme!.toLowerCase()}://${authority!.toLowerCase()}${rest!.replace(/\/+$/, '')}`
}

/** The hub refused the connection: with a pinned key, the hub key changed or another server answers. */
export class HubRefusedError extends Error {
  constructor(
    readonly address: string,
    /** The pinned key the refused token was bound to; absent for a refused v0 connection */
    readonly hubKey?: string,
  ) {
    super(
      hubKey
        ? `hub at ${address} refused the connection signed for its pinned key ${hubKey}; the hub key changed, the service key was revoked, or a different server answers. Call forgetHubKey() if the hub's key changed on purpose.`
        : `hub at ${address} refused the connection (unknown or revoked key, or not a hub)`,
    )
    this.name = 'HubRefusedError'
  }
}

/** The parts of channel's WebSocketClient the service drives. */
interface ClientSocket {
  ws?: { close(): void }
  isRunning: boolean
  onclose?: () => void
  start(): void
}

class MemoryHubKeys implements HubKeyStore {
  private keys = new Map<string, string>()
  get(address: string) {
    return this.keys.get(address)
  }
  set(address: string, hubKey: string | undefined) {
    if (hubKey) this.keys.set(address, hubKey)
    else this.keys.delete(address)
  }
}
export interface AppHeader {
  type: 'app'
  name: string
  path: string
}
export interface ApiSettings<Body = any> extends Requirements {
  permissions?: ServicePermissions
  /** Calls the hub runs at once on this provider */
  limit?: number
  /** Callable by anyone, also on hubs in default-deny mode */
  public?: boolean
  /** Per-caller limit (`ServiceOptions.rateLimit` by default); false for none */
  rateLimit?: RateLimit | false
  /** Validates the body; the handler gets what it returns */
  input?: Validator<Body>
  /** On `shutdown()`: `wait` for the call (posts' default) or `end` it at once (streams' default) */
  shutdown?: 'wait' | 'end'
}
export interface ServicePermissions {
  group?: string
  /// Permission name
  name: string
  /// Allows permission by default
  allows?: boolean
}

interface ServiceHeader {
  path: string
  permissions?: ServicePermissions
  limit?: number
  public?: boolean
}

export interface Profile {
  name?: string
  icon?: Icon | string
}
export interface Icon {
  symbol?: SFSymbol | string
  text?: TextIcon | string
}
interface SFSymbol {
  name: string
  color?: Color
}
interface TextIcon {
  name: string
  color?: Color
}
interface Color {
  background?: string
  backgroundDark?: string
  foreground?: string
  foregroundDark?: string
}
