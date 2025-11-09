import { sign } from './keychain'
import { Channel } from 'channel/client'
const v = '0'
type AnyIterator = AsyncIterator<any, void, any> | Promise<AsyncIterator<any, void, any>>

export class Service {
  address: string | number
  channel = new Channel()
  apps: AppHeader[] = []
  group?: string
  settings: Record<string, ApiSettings> = {}
  constructor(address?: string | number) {
    this.address = address ?? Bun.env.HUB ?? 1997
  }
  start() {
    const services: ServiceHeader[] = []
    for (const path of Object.keys(this.channel.postApi.storage)) {
      services.push({
        path,
        settings: this.settings[path],
      })
    }
    for (const path of Object.keys(this.channel.streamApi.storage)) {
      services.push({
        path,
        settings: this.settings[path],
      })
    }
    const apps = this.apps
    this.channel.connect(this.address, {
      headers: async () => ({ auth: await sign(), v }),
      async onConnect(sender) {
        await sender.send('hub/service/update', { services, apps })
      },
    })
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
  private addSettings(path: string, settings: ApiSettings | undefined) {
    if (!settings) return
    this.settings[path] = settings
    if (settings.permissions && !settings.permissions.group) {
      if (!this.group) this.group = path.split('/')[0]
      settings.permissions.group = this.group
    }
  }
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

interface ServiceHeader {
  path: string
  settings: ApiSettings
}
