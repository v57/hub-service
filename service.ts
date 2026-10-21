import type { SendOptions } from 'channel/channel'
import { Channel, type Sender } from 'channel/client'
import { NetworkPublisher, type NetworkShare, type NetworkPolicy } from './network'
import type { DeviceData, DeviceDescription } from './device-api'
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

/** Second argument of post and stream handlers. */
export interface ServiceRequest {
  /** The caller, when the hub that forwarded the request is the pinned hub */
  caller?: Caller
  /** Request context without the hub's `hub` entry */
  context: Context
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
  constructor(sign: (() => Promise<string>) | ServiceIdentity, options?: ServiceOptions) {
    this.supportsV1 = typeof sign !== 'function'
    this.identity = typeof sign === 'function' ? { sign: () => sign() } : sign
    this.initialHubKey = options?.hubKey
    this.reporter = options?.reporter ?? false
    this.onError = options?.onError
    this.address = options?.address ?? globalThis.Bun?.env?.HUB ?? 1997
    if (options?.name || options?.icon) {
      this.profile = {}
      if (options.name) this.profile.name = options.name
      if (options.icon) this.profile.icon = options.icon
    }
  }
  start(): this {
    this.isStopped = false
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
        await sender.send('hub/service/update', reporter ? { services, apps, reporter } : { services, apps })
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
  post(path: string, action: (body: any, request: ServiceRequest) => any | Promise<any>, settings?: ApiSettings) {
    this.addSettings(path, settings)
    this.channel.post(path, ({ body, context }) => action(body, this.request(context)))
    return this
  }
  stream(path: string, action: (body: any, request: ServiceRequest) => AnyIterator, settings?: ApiSettings) {
    this.addSettings(path, settings)
    this.channel.stream(path, ({ body, context }) => action(body, this.request(context)))
    return this
  }
  /**
   * Reads the caller from `context.hub`. It is trusted only when it names the pinned hub key, because a hub
   * that predates caller identity may pass a client's context through unchanged.
   */
  request(context: any): ServiceRequest {
    if (!context || typeof context !== 'object') return { context: {} }
    const { hub, ...rest } = context
    const request: ServiceRequest = { context: rest }
    if (hub && typeof hub === 'object' && this.hubKey && hub.hubKey === this.hubKey && hub.caller && typeof hub.caller === 'object') {
      request.caller = hub.caller
    }
    return request
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
      if (error === 'not the device reporter') this.isDeviceReporter = false
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
      if (error === 'not the device reporter') this.isDeviceReporter = false
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
  private addSettings(path: string, settings: ApiSettings | undefined) {
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
export interface ApiSettings {
  permissions?: ServicePermissions
  limit?: number
  /** Callable by anyone, also on hubs in default-deny mode */
  public?: boolean
}
export interface ServicePermissions {
  group?: string
  /// Permission name
  name: string
  /// Allows permission by default
  allows?: boolean
}

interface ServiceHeader extends ApiSettings {
  path: string
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
