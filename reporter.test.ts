import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceCertificates } from './device'
import { KeyFile, authToken } from './keys'
import { MultiplatformService } from './service'
import { FakeHub, vectors, waitFor } from './testing/fake-hub'

let hub: FakeHub
let services: MultiplatformService[] = []
let directory: string | undefined
afterEach(async () => {
  services.forEach(service => service.sender?.stop())
  services = []
  hub?.stop()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function deviceService(port: number, options: { reporter?: boolean; device?: boolean } = {}) {
  directory ??= await mkdtemp(join(tmpdir(), 'hub-service-reporter-'))
  const key = KeyFile.generate()
  const certificates = new DeviceCertificates({
    keyPath: join(directory, 'device.key'),
    instance: `test-${services.length}`,
    service: async () => key.publicKey,
  })
  const service = new MultiplatformService(
    {
      sign: async hubKey => authToken(key, Math.round(Date.now() / 1000) + 60, hubKey),
      certificate: options.device === false ? undefined : () => certificates.header(),
    },
    { address: port, reporter: options.reporter ?? true },
  )
  services.push(service)
  return { service, key }
}

function registered(key: KeyFile) {
  return () => hub.open.some(c => c.key === key.publicKey && c.version === '1' && c.updates.length > 0)
}

describe('device reporter', () => {
  test('declares the role and sends the description on connect', async () => {
    hub = new FakeHub()
    const port = hub.start()
    const { service, key } = await deviceService(port)
    expect(await service.describeDevice({ name: 'Mac Studio' })).toBeFalse()
    service.start()
    await waitFor(registered(key))
    await waitFor(() => hub.describes.length === 1)
    expect(hub.open.find(c => c.key === key.publicKey)!.updates[0].reporter).toBeTrue()
    expect(hub.describes).toEqual([{ name: 'Mac Studio' }])
    expect(service.isDeviceReporter).toBeTrue()
    expect(await service.sendDeviceData({ cpu: 0.5 })).toBeTrue()
    expect(hub.data).toEqual([{ cpu: 0.5 }])
  })

  test('does not declare the role without reporter', async () => {
    hub = new FakeHub()
    const port = hub.start()
    const { service, key } = await deviceService(port, { reporter: false })
    service.start()
    await waitFor(registered(key))
    expect(hub.open[0]!.updates[0].reporter).toBeUndefined()
    expect(await service.describeDevice({ name: 'x' })).toBeFalse()
    expect(await service.sendDeviceData({ cpu: 1 })).toBeFalse()
    expect(hub.describes).toEqual([])
  })

  test('a second reporter takes over when the first disconnects', async () => {
    hub = new FakeHub()
    const port = hub.start()
    const first = await deviceService(port)
    first.service.start()
    await first.service.describeDevice({ name: 'first' })
    await waitFor(registered(first.key))
    await waitFor(() => hub.describes.length === 1)

    const second = await deviceService(port)
    second.service.start()
    await second.service.describeDevice({ name: 'second' })
    await waitFor(registered(second.key))
    expect(await second.service.sendDeviceData({ cpu: 0.1 })).toBeFalse()
    expect(second.service.isDeviceReporter).toBeFalse()

    first.service.sender?.stop()
    await waitFor(() => hub.reporter?.key === second.key.publicKey)
    // The next data tick re-describes the device before sending
    expect(await second.service.sendDeviceData({ cpu: 0.2 })).toBeTrue()
    expect(hub.describes.map(d => d.name)).toEqual(['first', 'second'])
    expect(hub.data).toEqual([{ cpu: 0.2 }])
  })

  test('reports live data on an interval', async () => {
    hub = new FakeHub()
    const port = hub.start()
    const { service, key } = await deviceService(port)
    service.start()
    await waitFor(registered(key))
    let n = 0
    const stop = service.reportDeviceData(10, () => ({ cpu: ++n / 10 }))
    await waitFor(() => hub.data.length >= 3)
    stop()
    const count = hub.data.length
    await new Promise(r => setTimeout(r, 50))
    expect(hub.data.length).toBeLessThanOrEqual(count + 1)
    expect(hub.data[0]).toEqual({ cpu: 0.1 })
  })
})
