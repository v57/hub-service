import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Service, ServiceKey } from '.'
import { App } from './app'
import { KeyFile, authToken } from './keys'
import { MultiplatformService } from './service'
import { FakeHub, vectors, waitFor } from './testing/fake-hub'

let hubs: FakeHub[] = []
let services: MultiplatformService[] = []
let dirs: string[] = []
afterEach(async () => {
  services.forEach(service => service.stop())
  hubs.forEach(hub => hub.stop())
  await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true })))
  services = []
  hubs = []
  dirs = []
})

function startHub() {
  const hub = new FakeHub()
  hubs.push(hub)
  return { hub, port: hub.start() }
}
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'hub-service-key-'))
  dirs.push(dir)
  return dir
}
function start<T extends MultiplatformService>(service: T): T {
  services.push(service)
  service.post('test/echo', body => body).start()
  return service
}
/** The hub key is learned on the first (v0) connection; the service reconnects with v1 */
const boundTo = (hub: FakeHub, key: string) => () => hub.open.some(c => c.key === key && c.version === '1')

describe('service keys', () => {
  test('services with different keys run in one process, each with its own identity', async () => {
    const { hub, port } = startHub()
    const dir = await tempDir()
    const text = KeyFile.generate()
    const keyFile = KeyFile.generate()
    const fromPath = start(new Service({ address: port, device: false, key: join(dir, 'a.key') }))
    const fromText = start(new Service({ address: port, device: false, key: text.text }))
    const fromKeyFile = start(new Service({ address: port, device: false, key: keyFile }))
    const pathKey = await fromPath.key.publicKey()
    expect(await fromText.key.publicKey()).toBe(text.publicKey)
    expect(await fromKeyFile.key.publicKey()).toBe(keyFile.publicKey)
    expect(new Set([pathKey, text.publicKey, keyFile.publicKey]).size).toBe(3)
    for (const key of [pathKey, text.publicKey, keyFile.publicKey]) await waitFor(boundTo(hub, key))
  })

  test('a key file is created on first use (0600) and keeps its hub pins beside it', async () => {
    const { hub, port } = startHub()
    const dir = await tempDir()
    const path = join(dir, 'nested', 'service.key')
    const service = start(new Service({ address: port, device: false, key: path }))
    await waitFor(boundTo(hub, await service.key.publicKey()))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await Bun.file(join(dir, 'nested', 'hubs.json')).json()).toEqual({ [`ws://localhost:${port}`]: hub.key.publicKey })
    // The same file gives the same identity next time
    expect(await new ServiceKey(path).publicKey()).toBe(await service.key.publicKey())
  })

  test('key files in one folder share their pins without overwriting each other', async () => {
    const one = startHub()
    const two = startHub()
    const dir = await tempDir()
    const a = start(new Service({ address: one.port, device: false, key: join(dir, 'a.key') }))
    const b = start(new Service({ address: two.port, device: false, key: join(dir, 'b.key') }))
    await waitFor(boundTo(one.hub, await a.key.publicKey()))
    await waitFor(boundTo(two.hub, await b.key.publicKey()))
    expect(await Bun.file(join(dir, 'hubs.json')).json()).toEqual({
      [`ws://localhost:${one.port}`]: one.hub.key.publicKey,
      [`ws://localhost:${two.port}`]: two.hub.key.publicKey,
    })
  })

  test('a key without a file pins hubs in memory', async () => {
    const { hub, port } = startHub()
    const service = start(new Service({ address: port, device: false, key: KeyFile.generate() }))
    await waitFor(boundTo(hub, await service.key.publicKey()))
    expect(service.key.path).toBeUndefined()
    expect(service.key.hubKeys).toBeUndefined()
    expect(service.hubKey).toBe(hub.key.publicKey)
  })

  test('a device certificate signs the service key it was given', async () => {
    const { hub, port } = startHub()
    const dir = await tempDir()
    const key = KeyFile.generate()
    const service = start(new Service({ address: port, key, instance: 'one', device: { keyPath: join(dir, 'device.key'), name: 'Test' } }))
    await waitFor(boundTo(hub, key.publicKey))
    const connection = hub.open.find(c => c.key === key.publicKey)!
    expect(hub.certificate(connection)?.service).toBe(key.publicKey)
    expect(service.device).toBeDefined()
  })
})

describe('stop()', () => {
  test('disconnects without counting as a refusal, fails waiting sends and connects again on start()', async () => {
    const { hub, port } = startHub()
    const key = KeyFile.generate()
    const service = start(new Service({ address: port, device: false, key }))
    await waitFor(boundTo(hub, key.publicKey))
    service.stop()
    await waitFor(() => !hub.open.some(c => c.key === key.publicKey))
    await Bun.sleep(150)
    expect(service.refusedError).toBeUndefined()
    expect(service.sender).toBeUndefined()
    expect(() => service.send('test/echo', 1)).toThrow()
    service.start()
    await waitFor(boundTo(hub, key.publicKey))
  })

  test('ends the reportDeviceData loops', async () => {
    const { hub, port } = startHub()
    const dir = await tempDir()
    let collected = 0
    const service = start(
      new Service({ address: port, key: KeyFile.generate(), reporter: true, device: { keyPath: join(dir, 'device.key') } }),
    )
    service.reportDeviceData(20, () => ({ cpu: ++collected / 100 }))
    await waitFor(() => hub.data.length > 1)
    service.stop()
    const after = collected
    await Bun.sleep(120)
    expect(collected).toBe(after)
  })
})

describe('app()', () => {
  test('is available on MultiplatformService', async () => {
    const { hub, port } = startHub()
    const key = new KeyFile(vectors.keys.service.keyFile)
    const service = new MultiplatformService(
      { sign: async hubKey => authToken(key, Math.round(Date.now() / 1000) + 60, hubKey) },
      { address: port },
    )
    const app = new App({ type: 'app', name: 'Test App', path: 'test/ui' }, [])
    expect(service.app(app)).toBe(service)
    start(service)
    await waitFor(() => hub.open.some(c => c.updates.some(update => update?.apps?.[0]?.path === 'test/ui')))
    const connection = hub.open.find(c => c.key === key.publicKey)!
    const iterator = connection.sender.values('test/ui')[Symbol.asyncIterator]()
    expect(((await iterator.next()).value as any).header.name).toBe('Test App')
    iterator.return?.()
  })
})
