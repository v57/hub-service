import { sign } from './keychain'
import { Channel } from 'channel/client'
const v = '0'
export class Service {
  address: string | number
  channel = new Channel()
  constructor(address?: string | number) {
    this.address = address ?? Bun.env.HUB ?? 1997
  }
  start() {
    const api = [...Object.keys(this.channel.postApi.storage), ...Object.keys(this.channel.streamApi.storage)]
    this.channel.connect(this.address, {
      headers: async () => ({ auth: await sign(), v }),
      async onConnect(sender) {
        await sender.send('hub/service/update', { add: api })
      },
    })
  }
  post(path: string, action: (body: any) => any) {
    this.channel.post(path, ({ body }) => action(body))
    return this
  }
  stream(path: string, action: (body: any) => AsyncIterator<any, void, any>) {
    this.channel.stream(path, ({ body }) => action(body))
    return this
  }
}
