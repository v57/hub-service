import type { SendOptions } from 'channel/channel'
import { Channel, type Sender } from 'channel/client'
import { NetworkPublisher, type NetworkShare, type NetworkPolicy } from './network'
const v = '0'
type AnyIterator = AsyncIterator<any, void, any> | Promise<AsyncIterator<any, void, any>>

export interface Context {
  service?: string
}

export interface ServiceProvider {
  id: string
  name?: string
}

export class MultiplatformService {
  address: string | number
  channel = new Channel()
  sender?: Sender
  apps: AppHeader[] = []
  group?: string
  settings: Record<string, ApiSettings> = {}
  profile?: Profile
  sign: () => Promise<string>
  constructor(sign: () => Promise<string>, options?: ServiceOptions) {
    this.sign = sign
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
    this.sender = this.channel.connect(this.address, {
      headers: async () => ({ auth: await this.sign(), v }),
      async onConnect(sender) {
        try {
          const profile = getProfile()
          if (profile) await sender.send('hub/profile/update', profile)
        } catch {}
        await sender.send('hub/service/update', { services, apps })

        await onConnected(sender)
      },
    })
    return this
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
    sign: () => Promise<string>,
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
