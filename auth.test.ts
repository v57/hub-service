import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyFile, authToken } from './keys'
import { HubKeyFile } from './keychain'
import { MultiplatformService, type HubKeyStore, type ServiceIdentity } from './service'
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
  return { sign: async key => authToken(serviceKey, Math.round(Date.now() / 1000) + 60, key), hubKeys }
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
  test('learns the hub key on a v0 connection and reconnects with v1', async () => {
    const { hub, port } = startHub()
    const pins = new Pins()
    const service = startService(new MultiplatformService(identity(pins), { address: port }))
    await waitFor(() => hub.open.some(c => c.version === '1' && c.updates.length > 0))
    expect(hub.infoCalls).toBe(1)
    expect(hub.connections[0]!.version).toBe('0')
    // The v0 connection switches before registering its services
    expect(hub.connections[0]!.updates).toEqual([])
    expect(hub.open.map(c => c.version)).toEqual(['1'])
    expect(hub.open[0]!.key).toBe(serviceKey.publicKey)
    expect(pins.keys).toEqual({ [`ws://localhost:${port}`]: hubKey })
    expect(service.hubKey).toBe(hubKey)
    expect(service.connectedVersion).toBe('1')
  })

  test('connects with v1 at once when the key is pinned', async () => {
    const { hub, port } = startHub()
    const pins = new Pins()
    pins.keys[`ws://localhost:${port}`] = hubKey
    startService(new MultiplatformService(identity(pins), { address: port }))
    await waitFor(() => hub.open.some(c => c.updates.length > 0))
    expect(hub.connections.map(c => c.version)).toEqual(['1'])
    expect(hub.infoCalls).toBe(0)
  })

  test('uses a hub key supplied up front', async () => {
    const { hub, port } = startHub()
    startService(new MultiplatformService(identity(), { address: port, hubKey }))
    await waitFor(() => hub.open.some(c => c.updates.length > 0))
    expect(hub.connections.map(c => c.version)).toEqual(['1'])
  })

  test('stays on v0 with a hub that has no hub/info', async () => {
    const { hub, port } = startHub({ info: false })
    const pins = new Pins()
    const service = startService(new MultiplatformService(identity(pins), { address: port }))
    await waitFor(() => hub.open.some(c => c.updates.length > 0))
    expect(hub.connections.map(c => c.version)).toEqual(['0'])
    expect(pins.keys).toEqual({})
    expect(service.hubKey).toBeUndefined()
  })

  test('a plain sign function keeps v0', async () => {
    const { hub, port } = startHub()
    startService(new MultiplatformService(() => identity().sign(), { address: port }))
    await waitFor(() => hub.open.some(c => c.updates.length > 0))
    expect(hub.connections.map(c => c.version)).toEqual(['0'])
    expect(hub.infoCalls).toBe(0)
  })

  test('does not fall back to v0 when the pinned key is refused', async () => {
    const { hub, port } = startHub()
    const pins = new Pins()
    // Another server's key: the hub refuses the token
    pins.keys[`ws://localhost:${port}`] = vectors.keys.device.publicKey
    const service = startService(new MultiplatformService(identity(pins), { address: port }))
    await new Promise(r => setTimeout(r, 300))
    expect(hub.connections).toEqual([])
    expect(service.connectedVersion).toBe('1')
    expect(service.refusedError).toContain('refused')

    await service.forgetHubKey()
    expect(pins.keys).toEqual({})
    await waitFor(() => hub.open.some(c => c.version === '1' && c.updates.length > 0))
    expect(pins.keys[`ws://localhost:${port}`]).toBe(hubKey)
  })

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
