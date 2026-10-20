import { describe, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'node:crypto'
import { join } from 'node:path'
import { KeyFile, authSignedData, authToken, deviceId, makeCertificate, readCertificate, safetyCode } from './keys'
import { MultiplatformService } from './service'
import { vectors } from './testing/fake-hub'

const docsVectors = join(import.meta.dir, '../../Docs/Devices/vectors.json')
const hub = new KeyFile(vectors.keys.hub.keyFile)
const service = new KeyFile(vectors.keys.service.keyFile)
const device = new KeyFile(vectors.keys.device.keyFile)

function verifies(publicKey: string, data: string, signature: string) {
  const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' })
  return verify(null, Buffer.from(data), key, Buffer.from(signature, 'base64'))
}

describe('device-layer vectors (Docs/Devices/vectors.json)', () => {
  test('the copy in testdata matches the contract', async () => {
    const file = Bun.file(docsVectors)
    if (!(await file.exists())) return // Only checkable next to the Hub docs
    expect(vectors).toEqual(await file.json())
  })

  test('key files come from the seeds', () => {
    for (const name of ['hub', 'service', 'device'] as const) {
      const entry = vectors.keys[name]
      const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(entry.seed, 'hex')])
      const spki = Buffer.from(entry.publicKey, 'base64')
      expect(Buffer.concat([pkcs8, spki]).toString('base64')).toBe(entry.keyFile)
      expect(new KeyFile(entry.keyFile).publicKey).toBe(entry.publicKey)
    }
  })

  test('device id and safety code', () => {
    expect(deviceId(device.publicKey)).toBe(vectors.keys.device.deviceId)
    expect(safetyCode(device.publicKey)).toBe(vectors.keys.device.safetyCode)
  })

  test('v0 auth token', () => {
    const v0 = vectors.auth.v0
    expect(authSignedData(vectors.auth.expiry)).toBe(v0.signedData)
    expect(service.sign(v0.signedData)).toBe(v0.signature)
    expect(authToken(service, vectors.auth.expiry)).toBe(v0.header)
  })

  test('v1 auth token', () => {
    const v1 = vectors.auth.v1
    expect(authSignedData(vectors.auth.expiry, hub.publicKey)).toBe(v1.signedData)
    expect(service.sign(v1.signedData)).toBe(v1.signature)
    expect(authToken(service, vectors.auth.expiry, hub.publicKey)).toBe(v1.header)
    expect(verifies(service.publicKey, v1.signedData, v1.signature)).toBeTrue()
    // A v1 token does not verify as v0, so it can't be replayed on another hub or protocol
    expect(verifies(service.publicKey, v1.signedData.replace(hub.publicKey, device.publicKey), v1.signature)).toBeFalse()
  })

  for (const name of ['certificate', 'childCertificate'] as const) {
    test(name, () => {
      const vector = vectors[name]
      const fields = JSON.parse(vector.json)
      const { v, device: _, ...rest } = fields
      const header = makeCertificate(device, rest)
      expect(header).toBe(vector.header)
      const [payload, signature] = header.split('.')
      expect(payload).toBe(vector.payload)
      expect(signature).toBe(vector.signature)
      expect(Buffer.from(payload!, 'base64url').toString()).toBe(vector.json)
      // The signature covers the base64url payload string
      expect(verifies(device.publicKey, vector.payload, vector.signature)).toBeTrue()
      expect(readCertificate(header)).toEqual(fields)
    })
  }

  test('caller context', () => {
    const service = new MultiplatformService({ sign: async () => '' })
    service.hubKey = vectors.keys.hub.publicKey
    const request = service.request(vectors.caller.context)
    expect(request.caller).toEqual(vectors.caller.context.hub.caller)
    expect(request.caller!.device!.id).toBe(vectors.keys.device.deviceId)
    expect(request.context).toEqual({})
  })
})
