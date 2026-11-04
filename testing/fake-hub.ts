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
  /** Answer `hub/info` like hub-server. Off behaves like a server with no such API. */
  info?: boolean
  /** Claims this hub key in `hub/info`: without its private key the proof can't hold */
  claimKey?: string
  /** Answers `hub/info` without a proof, like a hub from before auth v2 */
  noProof?: boolean
  /** Rejects keyed connections with this reason instead of accepting them. */
  refuse?: (connection: { version: string; key?: string }) => string | undefined
}

/** A minimal hub that checks v0/v1 tokens the way hub-server does and records what services send. */
export class FakeHub {
  readonly key = new KeyFile(vectors.keys.hub.keyFile)
  readonly channel = new Channel<FakeConnection>()
  readonly connections: FakeConnection[] = []
  infoCalls = 0
  /** Challenges handed out and not used yet */
  private nonces = new Set<string>()
  private nextNonce = 0
  /** Every set of headers a connection brought, also refused ones, as a hub that keeps them would */
  received: Record<string, string | undefined>[] = []
  describes: any[] = []
  data: any[] = []
  /** Paths granted per caller key, for `hub/grant/check` */
  grants = new Map<string, Set<string>>()
  grantChecks: any[] = []
  /** Connection whose describe/data calls are accepted; the first reporter by default. */
  reporter?: FakeConnection
  server?: Server<any>
  constructor(options: FakeHubOptions = {}) {
    if (options.info !== false) {
      this.channel.post('hub/info', ({ body }) => {
        this.infoCalls += 1
        const key = options.claimKey ?? this.key.publicKey
        const challenge = `nonce-${this.nextNonce++}`
        this.nonces.add(challenge)
        const proof = options.noProof || !body?.nonce ? {} : { proof: this.key.sign(`hubinfo1:${key}:${body.nonce}`) }
        return { key, protocol: 2, pro: true, mode: 'default-allow', challenge, ...proof }
      })
    }
    this.channel
      .post('hub/service/update', ({ body, state }) => {
        state.updates.push(body)
        if (body?.reporter && state.device && !this.reporter) this.reporter = state
      })
      .post('hub/profile/update', () => {})
      .post('hub/grant/check', ({ body }) => {
        this.grantChecks.push(body)
        return { allowed: this.grants.get(body?.caller?.key)?.has(body?.path) === true }
      })
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
    // Refused connections fail the upgrade like hub-server, without the test runner reporting the throw
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
        if (headers['auth'] || headers['device']) hub.received.push({ ...headers })
        const version = headers['v'] ?? '0'
        const key = headers['auth'] ? hub.verify(headers['auth'], version) : undefined
        // Like hub-server, anonymous connections stay open for `hub/info`
        const reason = key ? hub.refuse?.({ version, key }) : undefined
        if (reason) throw reason
        return { version, key, device: headers['device'], sender: undefined as any, updates: [], closed: false }
      },
      onConnect(connection) {
        connection.state.sender = connection.sender
        // An anonymous connection only asks `hub/info`
        if (connection.state.key) hub.connections.push(connection.state)
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
  /** Request context the way the hub forwards a call from `caller` */
  context(caller: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return { ...extra, hub: { hubKey: this.key.publicKey, caller: { groups: [], owner: false, ...caller } } }
  }
  get open(): FakeConnection[] {
    return this.connections.filter(connection => !connection.closed)
  }
  /** The certificate of a connection, decoded. */
  certificate(connection: FakeConnection) {
    return connection.device ? readCertificate(connection.device) : undefined
  }
  private verify(token: string, version: string): string {
    const [prefix, key, signature, expiry, nonce] = token.split('.')
    if (prefix !== 'key' || !key || !signature || !expiry) throw 'invalid key'
    let data: string
    if (version === '0') data = expiry
    else if (version === '1') {
      if (!nonce || !this.nonces.delete(nonce)) throw 'invalid nonce'
      data = `hub1:${this.key.publicKey}:${nonce}:${expiry}`
    } else throw 'unsupported version'
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
