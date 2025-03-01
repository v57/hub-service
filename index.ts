import { sign } from './keychain'

const v = '0'
export class Service {
  private id: number = 0
  address: string
  ws?: WebSocket
  requests = new ObjectMap<number, PendingRequest>()
  services = new Set<string>()
  api = new ObjectMap<string, (body: any) => any>()
  constructor(address: string | undefined) {
    this.address = address ?? Bun.env.HUB ?? 'ws://localhost:1997'
  }
  async start() {
    const auth = await sign()
    const ws = new WebSocket(this.address, {
      // @ts-ignore (Bun issue)
      headers: { auth, v },
    })
    ws.onopen = async () => {
      this.ws = ws
      try {
        await this.sendOnce('hub/service/add', Array.from(this.services), -1)
      } catch (e) {
        console.log('Failed to send services')
      }
      let batch: SendBody[] = this.requests.map(a => a.request)
      if (batch.length) {
        this.ws.send(JSON.stringify(batch))
      }
    }
    ws.onclose = () => {
      this.ws = undefined
      setTimeout(() => this.start(), 100)
    }
    ws.onmessage = (message: MessageEvent<any>) => {
      if (typeof message.data == 'string') {
        try {
          const response = JSON.parse(message.data)
          if (Array.isArray(response)) {
            response.forEach(a => this.received(a))
          } else {
            this.received(response as unknown as Response)
          }
        } catch (e) {
          console.log(e)
        }
      }
    }
  }
  post(path: string, action: (body: any) => any) {
    this.api.set(path, action)
    this.services.add(path.split('/')[0])
    return this
  }
  send(path: string, body: any) {
    let id = this.id
    this.id += 1
    return new Promise<any>((resolve, reject) => {
      const request: PendingRequest = {
        request: { id, path, body },
        promise: { resolve, reject },
      }
      this.requests.set(id, request)
      if (this.ws) {
        this.ws.send(JSON.stringify({ id, path, body }))
      }
    })
  }
  sendOnce(path: string, body: any, id: number) {
    return new Promise<any>((resolve, reject) => {
      const request: PendingRequest = {
        request: { id, path, body },
        promise: { resolve, reject },
      }
      this.requests.set(id, request)
      if (this.ws) {
        this.ws.send(JSON.stringify({ id, path, body }))
      }
    })
  }
  sendResponse(response: Response) {
    this.ws?.send(JSON.stringify(response))
  }
  private async received(any: any) {
    if (any.path) {
      const { id, path, body } = any
      try {
        const api = this.api.get(path)
        if (!api) throw 'api not found'
        this.sendResponse({ id, body: await api(body) })
      } catch {
        this.sendResponse({ id, error: 'failed' })
      }
    } else {
      const request = this.requests.get(any.id)
      if (!request) return
      this.requests.delete(any.id)
      if (any.error) {
        request.promise.reject(any.error)
      } else {
        request.promise.resolve(any.body)
      }
    }
  }
}
interface PendingRequest {
  request: SendBody
  promise: {
    resolve: (value: any) => void
    reject: (reason?: any) => void
  }
}
interface SendBody {
  id: number
  path?: string
  body?: any
  error?: string
}
interface Response {
  id: number
  body?: any
  error?: string
}

class ObjectMap<Key, Value> {
  storage: any = {}
  get(id: Key): Value | undefined {
    return this.storage[id]
  }
  set(id: Key, value: Value) {
    this.storage[id] = value
  }
  delete(id: Key) {
    delete this.storage[id]
  }
  get size(): number {
    return Object.values(this.storage).length
  }
  map<O>(transform: (value: Value) => O): O[] {
    let array: O[] = []
    for (let a of Object.values(this.storage)) {
      array.push(transform(a as Value))
    }
    return array
  }
}
