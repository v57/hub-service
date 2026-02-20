import { Channel, type Sender } from 'channel/client'
const v = '0'
type AnyIterator = AsyncIterator<any, void, any> | Promise<AsyncIterator<any, void, any>>

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
    this.address = options?.address ?? (typeof Bun !== 'undefined' ? Bun?.env?.HUB : undefined) ?? 1997
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
      })
    }
    for (const path of Object.keys(this.channel.streamApi.storage)) {
      const settings = this.settings[path] ?? {}
      services.push({
        path,
        permissions: settings.permissions,
      })
    }
    const apps = this.apps
    const getProfile = () => this.profile
    this.sender = this.channel.connect(this.address, {
      headers: async () => ({ auth: await this.sign(), v }),
      async onConnect(sender) {
        try {
          const profile = getProfile()
          if (profile) await sender.send('hub/profile/update', profile)
        } catch {}
        await sender.send('hub/service/update', { services, apps })
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
  send(path: string, body?: any, context?: any) {
    if (!this.sender) throw 'Service not started'
    return this.sender.send(path, body, context)
  }
  values(path: string, body?: any, context?: any) {
    if (!this.sender) throw 'Service not started'
    return this.sender.values(path, body, context)
  }
  private addSettings(path: string, settings: ApiSettings | undefined) {
    if (!settings) return
    this.settings[path] = settings
    if (settings.permissions && !settings.permissions.group) {
      if (!this.group) this.group = path.split('/')[0]
      settings.permissions.group = this.group
    }
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
