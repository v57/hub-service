import { createPublicKey, verify } from 'node:crypto'
import type { Server } from 'bun'
import { Channel, type Sender } from 'channel/server'
import { KeyFile, readCertificate } from '../keys'

/** Test vectors shared by every SDK (Docs/Devices/vectors.json, copied into testdata). */
export const vectors = await Bun.file(new URL('../testdata/devices-v1/vectors.json', import.meta.url)).json()

export interface FakeConnection {
  version: string
  key?: string
  device?: string
  sender: Sender
  updates: any[]
  closed: boolean
}

export interface FakeHubOptions {
  /** Answer `hub/info` like hub-pro. Off behaves like hub-lite. */
  info?: boolean
  /** Rejects connections with this reason instead of accepting them. */
  refuse?: (connection: { version: string; key?: string }) => string | undefined
}

/** A minimal hub that checks v0/v1 tokens the way hub-pro does and records what services send. */
export class FakeHub {
  readonly key = new KeyFile(vectors.keys.hub.keyFile)
  readonly channel = new Channel<FakeConnection>()
  readonly connections: FakeConnection[] = []
  infoCalls = 0
  describes: any[] = []
  data: any[] = []
  /** Connection whose describe/data calls are accepted; the first reporter by default. */
  reporter?: FakeConnection
  server?: Server<any>
  constructor(options: FakeHubOptions = {}) {
    if (options.info !== false) {
      this.channel.post('hub/info', () => {
        this.infoCalls += 1
        return { key: this.key.publicKey, protocol: 1, pro: true, mode: 'default-allow' }
      })
    }
    this.channel
      .post('hub/service/update', ({ body, state }) => {
        state.updates.push(body)
        if (body?.reporter && state.device && !this.reporter) this.reporter = state
      })
      .post('hub/profile/update', () => {})
      .post('hub/device/describe', ({ body, state }) => {
        if (this.reporter !== state) throw 'not the device reporter'
        this.describes.push(body)
      })
      .post('hub/device/data', ({ body, state }) => {
        if (this.reporter !== state) throw 'not the device reporter'
        this.data.push(body)
      })
    this.refuse = options.refuse
  }
  private refuse?: FakeHubOptions['refuse']
  start(): number {
    const hub = this
    // Refused connections fail the upgrade like hub-pro, without the test runner reporting the throw
    const serve = Bun.serve
    ;(Bun as any).serve = (options: any) => serve({ ...options, error: () => new Response('refused', { status: 403 }) })
    let server: Server<any>
    try {
      server = this.listen()
    } finally {
      ;(Bun as any).serve = serve
    }
    this.server = server
    return server.port!
  }
  private listen() {
    const hub = this
    return this.channel.listen(0, {
      state(headers): FakeConnection {
        const version = headers['v'] ?? '0'
        const key = headers['auth'] ? hub.verify(headers['auth'], version) : undefined
        const reason = hub.refuse?.({ version, key })
        if (reason) throw reason
        return { version, key, device: headers['device'], sender: undefined as any, updates: [], closed: false }
      },
      onConnect(connection) {
        connection.state.sender = connection.sender
        hub.connections.push(connection.state)
      },
      onDisconnect(connection) {
        connection.state.closed = true
        if (hub.reporter === connection.state) {
          // The next connected reporter of the device takes over
          hub.reporter = hub.open.find(c => c.device && c.updates.some(update => update?.reporter))
        }
      },
    })
  }
  stop() {
    this.server?.stop(true)
  }
  get open(): FakeConnection[] {
    return this.connections.filter(connection => !connection.closed)
  }
  /** The certificate of a connection, decoded. */
  certificate(connection: FakeConnection) {
    return connection.device ? readCertificate(connection.device) : undefined
  }
  private verify(token: string, version: string): string {
    const [prefix, key, signature, expiry] = token.split('.')
    if (prefix !== 'key' || !key || !signature || !expiry) throw 'invalid key'
    let data: string
    if (version === '0') data = expiry
    else if (version === '1') data = `hub1:${this.key.publicKey}:${expiry}`
    else throw 'unsupported version'
    const publicKey = createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
    if (!verify(null, Buffer.from(data), publicKey, Buffer.from(signature, 'base64'))) throw 'invalid signature'
    return key
  }
}

export async function waitFor(check: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 10))
  }
}
