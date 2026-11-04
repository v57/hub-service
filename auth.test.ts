import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyFile, authToken } from './keys'
import { HubKeyFile } from './keychain'
import { HubRefusedError, MultiplatformService, normalizeHubAddress, type HubKeyStore, type ServiceIdentity } from './service'
import { FakeHub, vectors, waitFor, type FakeHubOptions } from './testing/fake-hub'

const serviceKey = new KeyFile(vectors.keys.service.keyFile)
const hubKey = vectors.keys.hub.publicKey

class Pins implements HubKeyStore {
  keys: Record<string, string> = {}
  get(address: string) {
    return this.keys[address]
  }
  set(address: string, key: string | undefined) {
    if (key) this.keys[address] = key
    else delete this.keys[address]
  }
}

function identity(hubKeys: HubKeyStore = new Pins()): ServiceIdentity {
  return { sign: async (key, nonce) => authToken(serviceKey, Math.round(Date.now() / 1000) + 30, key, nonce), hubKeys }
}

let hubs: FakeHub[] = []
let services: MultiplatformService[] = []
afterEach(() => {
  services.forEach(service => service.sender?.stop())
  hubs.forEach(hub => hub.stop())
  services = []
  hubs = []
})

function startHub(options?: FakeHubOptions) {
  const hub = new FakeHub(options)
  hubs.push(hub)
  return { hub, port: hub.start() }
}
function startService(service: MultiplatformService) {
  services.push(service)
  service.post('test/echo', body => body).start()
  return service
}

describe('hub key pinning', () => {
  test('pins the key the hub proved and connects with v1 at once', async () => {
    const { hub, port } = startHub()
    const pins = new Pins()
    const service = startService(new MultiplatformService(identity(pins), { address: port }))
    await waitFor(() => hub.open.some(c => c.version === '1' && c.updates.length > 0))
    expect(hub.connections.map(c => c.version)).toEqual(['1'])
    expect(pins.keys).toEqual({ [`ws://localhost:${port}`]: hubKey })
    expect(service.hubKey).toBe(hubKey)
    expect(service.connectedVersion).toBe('1')
  })

  test('asks for a challenge before every connection', async () => {
    const { hub, port } = startHub()
    const pins = new Pins()
    pins.keys[`ws://localhost:${port}`] = hubKey
    startService(new MultiplatformService(identity(pins), { address: port }))
    await waitFor(() => hub.open.some(c => c.updates.length > 0))
    expect(hub.connections.map(c => c.version)).toEqual(['1'])
    expect(hub.infoCalls).toBe(1)
    hub.connections[0]!.sender.stop()
    await waitFor(() => hub.open.some(c => c.updates.length > 0), 5000)
    expect(hub.infoCalls).toBe(2)
    const tokens = hub.received.map(headers => headers.auth)
    expect(new Set(tokens).size).toBe(tokens.length)
  })

  test('a refused challenge is asked for again before it counts as refused', async () => {
    let refusals = 1
    const { hub, port } = startHub({ refuse: () => (refusals-- > 0 ? 'invalid nonce' : undefined) })
    const errors: HubRefusedError[] = []
    startService(new MultiplatformService(identity(), { address: port, onError: error => errors.push(error) }))
    await waitFor(() => hub.open.some(c => c.updates.length > 0), 5000)
    expect(errors).toEqual([])
  })

  test('reports a connection refused twice', async () => {
    const { hub, port } = startHub({ refuse: () => 'key revoked' })
    const errors: HubRefusedError[] = []
    const service = new MultiplatformService(identity(), { address: port, onError: error => errors.push(error) })
    startService(service)
    await waitFor(() => errors.length === 1, 5000)
    expect(errors[0]!.hubKey).toBe(hubKey)
    expect(hub.connections).toEqual([])
  })

  test('uses a hub key supplied up front', async () => {
    const { hub, port } = startHub()
    startService(new MultiplatformService(identity(), { address: port, hubKey }))
    await waitFor(() => hub.open.some(c => c.updates.length > 0))
    expect(hub.connections.map(c => c.version)).toEqual(['1'])
  })

  test('a plain sign function signs v1 too', async () => {
    const { hub, port } = startHub()
    startService(new MultiplatformService(identity().sign, { address: port }))
    await waitFor(() => hub.open.some(c => c.updates.length > 0))
    expect(hub.connections.map(c => c.version)).toEqual(['1'])
  })
})

describe('no credentials before proof', () => {
  const nothingSent = async (hub: FakeHub) => {
    await waitFor(() => hub.infoCalls > 0)
    await new Promise(r => setTimeout(r, 300))
    expect(hub.received).toEqual([])
  }
  test('a hub with no hub/info gets no credentials and pins nothing', async () => {
    const { hub, port } = startHub({ info: false })
    const pins = new Pins()
    const service = startService(new MultiplatformService(identity(pins), { address: port }))
    await new Promise(r => setTimeout(r, 400))
    expect(hub.received).toEqual([])
    expect(pins.keys).toEqual({})
    expect(service.hubKey).toBeUndefined()
  })
  test('a hub answering without a proof gets no credentials and pins nothing', async () => {
    const { hub, port } = startHub({ noProof: true })
    const pins = new Pins()
    startService(new MultiplatformService(identity(pins), { address: port }))
    await nothingSent(hub)
    expect(pins.keys).toEqual({})
  })
  test('a hub claiming another hub key without proof is not pinned and gets nothing', async () => {
    const claimed = vectors.keys.device.publicKey
    const { hub, port } = startHub({ claimKey: claimed })
    const pins = new Pins()
    const service = startService(new MultiplatformService(identity(pins), { address: port }))
    await nothingSent(hub)
    expect(pins.keys).toEqual({})
    expect(service.hubKey).toBeUndefined()
  })
  test('another key at a pinned address is reported, never pinned, and gets nothing', async () => {
    const { hub, port } = startHub()
    const pins = new Pins()
    const pinned = vectors.keys.device.publicKey
    pins.keys[`ws://localhost:${port}`] = pinned
    const errors: HubRefusedError[] = []
    const service = new MultiplatformService(identity(pins), { address: port, onError: error => errors.push(error) })
    startService(service)
    // Sent before the refusal: fails instead of waiting forever
    const waiting = service.send('hub/info')
    await expect(waiting).rejects.toBeInstanceOf(HubRefusedError)
    expect(hub.received).toEqual([])
    expect(hub.connections).toEqual([])
    expect(pins.keys[`ws://localhost:${port}`]).toBe(pinned)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe(service.refusedError!)
    expect(errors[0]!.hubKey).toBe(pinned)
    expect(errors[0]!.message).toContain(pinned)
    // Sent after the refusal: fails at once
    await expect(service.send('hub/info')).rejects.toBe(service.refusedError!)
    expect(() => service.values('hub/info')).toThrow(HubRefusedError)

    await service.forgetHubKey()
    expect(pins.keys).toEqual({})
    await waitFor(() => hub.open.some(c => c.version === '1' && c.updates.length > 0))
    expect(pins.keys[`ws://localhost:${port}`]).toBe(hubKey)
    expect(service.refusedError).toBeUndefined()
    expect(await service.send('hub/info')).toMatchObject({ key: hubKey })
  })
})

describe('plain ws://', () => {
  test('a public address is refused before anything is dialed', async () => {
    const errors: HubRefusedError[] = []
    const service = new MultiplatformService(identity(), { address: 'ws://8.8.8.8:1997', onError: error => errors.push(error) })
    services.push(service)
    service.start()
    expect(errors).toHaveLength(1)
    expect(errors[0]!.message).toContain('unencrypted')
    expect(service.sender).toBeUndefined()
    await expect(service.send('hub/info')).rejects.toBe(errors[0]!)
  })
  test('allowPlaintext is the way out for a private network', () => {
    const service = new MultiplatformService(identity(), { address: 'ws://hub.invalid:1', allowPlaintext: true })
    services.push(service)
    service.start()
    expect(service.refusedError).toBeUndefined()
    expect(service.sender).toBeDefined()
  })
})

describe('answers', () => {
  test('answers requests on the v1 connection', async () => {
    const { hub, port } = startHub()
    startService(new MultiplatformService(identity(), { address: port }))
    await waitFor(() => hub.open.some(c => c.version === '1' && c.updates.length > 0))
    expect(await hub.open[0]!.sender.send('test/echo', 'hi')).toBe('hi')
  })
})

describe('hub key file', () => {
  let directory: string | undefined
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  test('stores pins as an address map', async () => {
    directory = await mkdtemp(join(tmpdir(), 'hub-service-'))
    const path = join(directory, 'hubs.json')
    const store = new HubKeyFile(path)
    expect(await store.get('ws://localhost:1997')).toBeUndefined()
    await store.set('ws://localhost:1997', hubKey)
    expect(await Bun.file(path).json()).toEqual({ 'ws://localhost:1997': hubKey })
    expect(await new HubKeyFile(path).get('ws://localhost:1997')).toBe(hubKey)
    await store.set('ws://localhost:1997', undefined)
    expect(await Bun.file(path).json()).toEqual({})
  })
})

describe('hub addresses', () => {
  test('are normalized like the dialed URL', () => {
    expect(normalizeHubAddress(1997)).toBe('ws://localhost:1997')
    expect(normalizeHubAddress('1997')).toBe('ws://localhost:1997')
    expect(normalizeHubAddress('WSS://Hub.Example.COM/')).toBe('wss://hub.example.com')
    expect(normalizeHubAddress('ws://Host:80/Path/')).toBe('ws://host:80/Path')
  })
})
