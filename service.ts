import { sign } from './keychain'
import { Channel } from 'channel/client'
const v = '0'
type AnyIterator = AsyncIterator<any, void, any> | Promise<AsyncIterator<any, void, any>>

export class Service {
  address: string | number
  channel = new Channel()
  apps: AppHeader[] = []
  constructor(address?: string | number) {
    this.address = address ?? Bun.env.HUB ?? 1997
  }
  start() {
    const api = [...Object.keys(this.channel.postApi.storage), ...Object.keys(this.channel.streamApi.storage)]
    const apps = this.apps
    this.channel.connect(this.address, {
      headers: async () => ({ auth: await sign(), v }),
      async onConnect(sender) {
        await sender.send('hub/service/update', { add: api, addApps: apps })
      },
    })
  }
  post(path: string, action: (body: any) => any | Promise<any>) {
    this.channel.post(path, ({ body }) => action(body))
    return this
  }
  stream(path: string, action: (body: any) => AnyIterator) {
    this.channel.stream(path, ({ body }) => action(body))
    return this
  }
}
export interface AppHeader {
  type: 'app'
  name: string
  path: string
}
