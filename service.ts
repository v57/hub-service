import type { SendOptions } from 'channel/channel'
import { Channel, type Sender } from 'channel/client'
import { NetworkPublisher, type NetworkShare, type NetworkPolicy } from './network'
type AnyIterator = AsyncIterator<any, void, any> | Promise<AsyncIterator<any, void, any>>

export interface Context {
  service?: string
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

/** Result of `hub/info` (hub-pro only). */
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
  /** Set when the hub refused a v1 connect. The service stays disconnected until `forgetHubKey()`. */
  refusedError?: string
  private isOpen = false
  private hubKeyLoaded = false
  private readonly initialHubKey?: string
  private readonly memoryHubKeys = new MemoryHubKeys()
  constructor(sign: (() => Promise<string>) | ServiceIdentity, options?: ServiceOptions) {
    this.supportsV1 = typeof sign !== 'function'
    this.identity = typeof sign === 'function' ? { sign: () => sign() } : sign
    this.initialHubKey = options?.hubKey
    this.address = options?.address ?? globalThis.Bun?.env?.HUB ?? 1997
    if (options?.name || options?.icon) {
      this.profile = {}
      if (options.name) this.profile.name = options.name
      if (options.icon) this.profile.icon = options.icon
    }
  }
  start(): this {
    const services: ServiceHeader[] = []
    for (const path of Object.keys(this.channel.postApi.storage)) {
      const settings = this.settings[path] ?? {}
      services.push({
        path,
        permissions: settings.permissions,
        limit: settings.limit,
      })
    }
    for (const path of Object.keys(this.channel.streamApi.storage)) {
      const settings = this.settings[path] ?? {}
      services.push({
        path,
        permissions: settings.permissions,
        limit: settings.limit,
      })
    }
    const apps = this.apps
    const getProfile = () => this.profile
    const onConnected = (sender: Sender) => this.onConnected(sender)
    const learnHubKey = (sender: Sender) => this.learnHubKey(sender)
    const opened = () => {
      this.isOpen = true
      this.refusedError = undefined
    }
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
        await sender.send('hub/service/update', { services, apps })

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
      if (wasOpen || ws.isRunning || this.connectedVersion !== '1') return
      this.refusedError = `hub at ${this.hubAddress} refused the connection signed for its pinned key ${this.hubKey}; the hub key changed or a different server answers. Call forgetHubKey() to trust the new hub.`
      console.error(this.refusedError)
    }
  }
  post(path: string, action: (body: any) => any | Promise<any>, settings?: ApiSettings) {
    this.addSettings(path, settings)
    this.channel.post(path, ({ body }) => action(body))
    return this
  }
  stream(path: string, action: (body: any) => AnyIterator, settings?: ApiSettings) {
    this.addSettings(path, settings)
    this.channel.stream(path, ({ body }) => action(body))
    return this
  }
  /** Key under which this service's hub key is pinned. */
  get hubAddress(): string {
    return typeof this.address === 'number' ? `ws://localhost:${this.address}` : this.address
  }

  /** Connection headers, re-evaluated on every connect. */
  async headers(): Promise<Record<string, string>> {
    const hubKey = this.supportsV1 ? await this.pinnedHubKey() : undefined
    if (!hubKey) {
      this.connectedVersion = '0'
      return { auth: await this.identity.sign(), v: '0' }
    }
    this.connectedVersion = '1'
    const headers: Record<string, string> = { auth: await this.identity.sign(hubKey), v: '1' }
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

  send(path: string, body?: any, options?: SendOptions) {
    if (!this.sender) throw 'Service not started'
    return this.sender.send(path, body, options)
  }
  values(path: string, body?: any, options?: SendOptions) {
    if (!this.sender) throw 'Service not started'
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
