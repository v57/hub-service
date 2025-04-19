import { sign } from './keychain'
import { Channel } from 'channel/client'
const v = '0'
export class Service {
  private id: number = 0
  address: string
  channel = new Channel()
  constructor(address?: string) {
    this.address = address ?? Bun.env.HUB ?? 'ws://localhost:1997'
  }
  async start() {
    const auth = await sign()
    const api = Object.keys(this.channel.postApi.storage)
    this.channel.connect(this.address, {
      headers: () => ({ auth, v }),
      async onConnect(sender) {
        await sender.send('hub/service/add', api)
      },
    })
  }
  post(path: string, action: (body: any) => any) {
    this.channel.post(path, ({ body }) => action(body))
    return this
  }
}
