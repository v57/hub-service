import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DeviceCertificates, certificateRenewal, deviceKeyPath, devicePlatform, loadDeviceKey } from './device'
import { KeyFile, authToken, deviceId, readCertificate, truncateUTF8 } from './keys'
import { Service } from './index'
import { MultiplatformService } from './service'
import { FakeHub, vectors, waitFor } from './testing/fake-hub'

const serviceKey = new KeyFile(vectors.keys.service.keyFile)
let directory: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'hub-service-device-test-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

describe('device key', () => {
  test('is created once with private permissions', async () => {
    const path = join(directory, 'hub', 'device.key')
    const key = await loadDeviceKey(path)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(directory, 'hub'))).mode & 0o777).toBe(0o700)
    expect(new KeyFile(await Bun.file(path).text()).publicKey).toBe(key.publicKey)
    expect((await loadDeviceKey(path)).publicKey).toBe(key.publicKey)
  })

  test('reads an existing key file with trailing whitespace', async () => {
    const path = join(directory, 'device.key')
    await Bun.write(path, `${vectors.keys.device.keyFile}\n`)
    expect((await loadDeviceKey(path)).publicKey).toBe(vectors.keys.device.publicKey)
  })

  test('processes creating it at the same time end up with one key', async () => {
    const path = join(directory, 'race', 'device.key')
    const script = `import { loadDeviceKey } from ${JSON.stringify(join(import.meta.dir, 'device.ts'))}
console.log((await loadDeviceKey(${JSON.stringify(path)})).publicKey)`
    const scriptPath = join(directory, 'race.ts')
    await Bun.write(scriptPath, script)
    const outputs = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const child = Bun.spawn(['bun', scriptPath], { stdout: 'pipe' })
        return (await new Response(child.stdout).text()).trim()
      }),
    )
    expect(new Set(outputs).size).toBe(1)
    expect(outputs[0]).toBe(new KeyFile(await Bun.file(path).text()).publicKey)
  })

  test('location follows HUB_DEVICE_KEY', () => {
    expect(deviceKeyPath({ HUB_DEVICE_KEY: '/tmp/x.key' })).toBe('/tmp/x.key')
    if (process.platform !== 'linux' || process.getuid?.() !== 0) {
      expect(deviceKeyPath({})).toEndWith(join('.hub', 'device.key'))
    }
  })

  test('platform names', () => {
    expect(['darwin', 'linux', 'win32', 'android', 'aix'].map(devicePlatform)).toEqual([
      'macos',
      'linux',
      'windows',
      'android',
      'other',
    ])
  })
})

describe('service certificates', () => {
  async function issuer(options: Partial<ConstructorParameters<typeof DeviceCertificates>[0]> = {}) {
    const keyPath = join(directory, 'device.key')
    await Bun.write(keyPath, vectors.keys.device.keyFile)
    return new DeviceCertificates({
      keyPath,
      instance: 's3-local/Backup Disk',
      name: 'Mac Studio',
      platform: 'macos',
      service: async () => serviceKey.publicKey,
      ...options,
    })
  }

  test('match the shared vector', async () => {
    const certificates = await issuer()
    expect(await certificates.header(1792500000)).toBe(vectors.certificate.header)
    expect(await certificates.id()).toBe(vectors.keys.device.deviceId)
  })

  test('are renewed with less than a day left', async () => {
    const certificates = await issuer()
    const now = 1792500000
    const first = await certificates.header(now)
    expect(readCertificate(first).exp - readCertificate(first).iat).toBe(604800)
    expect(await certificates.header(now + 3600)).toBe(first)
    expect(await certificates.header(now + 604800 - certificateRenewal)).toBe(first)
    const renewed = await certificates.header(now + 604800 - certificateRenewal + 1)
    expect(renewed).not.toBe(first)
    expect(readCertificate(renewed).iat).toBe(now + 604800 - certificateRenewal + 1)
  })

  test('cap the lifetime at 7 days and limit field sizes', async () => {
    const certificates = await issuer({ lifetime: 10 ** 9, instance: 'é'.repeat(100), name: 'n'.repeat(100) })
    const fields = readCertificate(await certificates.header(1000))
    expect(fields.exp - fields.iat).toBe(604800)
    expect(Buffer.byteLength(fields.instance)).toBe(128)
    expect(fields.deviceName).toBe('n'.repeat(64))
  })

  test('carry a declared parent', async () => {
    const certificates = await issuer({ instance: 'builder', name: 'builder', platform: 'linux', parent: 'Mac Studio' })
    expect(await certificates.header(1792500000)).toBe(vectors.childCertificate.header)
  })

  test('truncation keeps whole characters', () => {
    expect(truncateUTF8('aé', 2)).toBe('a')
    expect(truncateUTF8('abc', 3)).toBe('abc')
  })
})

describe('device header', () => {
  let hub: FakeHub | undefined
  let service: MultiplatformService | undefined
  afterEach(() => {
    service?.sender?.stop()
    hub?.stop()
  })

  test('is sent on v1 connections with the auth key as the service', async () => {
    const keyPath = join(directory, 'device.key')
    const certificates = new DeviceCertificates({ keyPath, instance: 'test', service: async () => serviceKey.publicKey })
    hub = new FakeHub()
    const port = hub.start()
    service = new MultiplatformService(
      {
        sign: async hubKey => authToken(serviceKey, Math.round(Date.now() / 1000) + 60, hubKey),
        certificate: () => certificates.header(),
      },
      { address: port },
    )
    service.start()
    await waitFor(() => hub!.open.some(c => c.version === '1' && c.updates.length > 0))
    // No certificate on the v0 connection that learns the hub key
    expect(hub.connections[0]!.device).toBeUndefined()
    const connection = hub.open[0]!
    const fields = hub.certificate(connection)!
    expect(fields.service).toBe(connection.key!)
    expect(fields.device).toBe((await loadDeviceKey(keyPath)).publicKey)
    expect(fields.instance).toBe('test')
    expect(deviceId(fields.device)).toBe(await certificates.id())
  })
})

describe('Service device options', () => {
  test('instance defaults to HUB_INSTANCE, then the name', () => {
    const previous = process.env.HUB_INSTANCE
    try {
      process.env.HUB_INSTANCE = 'from-env'
      expect(new Service({ name: 'Named' }).device?.instance).toBe('from-env')
      delete process.env.HUB_INSTANCE
      expect(new Service({ name: 'Named' }).device?.instance).toBe('Named')
      expect(new Service({ name: 'Named', instance: 'explicit' }).device?.instance).toBe('explicit')
    } finally {
      if (previous === undefined) delete process.env.HUB_INSTANCE
      else process.env.HUB_INSTANCE = previous
    }
  })

  test('uses the shared device key path', () => {
    expect(new Service().device?.keyPath).toBe(process.env.HUB_DEVICE_KEY!)
  })

  test('device mode can be turned off', () => {
    expect(new Service({ device: false }).device).toBeUndefined()
    process.env.HUB_DEVICE = '0'
    try {
      expect(new Service().device).toBeUndefined()
    } finally {
      delete process.env.HUB_DEVICE
    }
  })
})
