import { describe, expect, test } from 'bun:test'
import { Service } from './web'

describe('web service surface', () => {
  test('does not advertise Unix-socket network publication', () => {
    const service = new Service()

    expect('network' in service).toBeFalse()
    expect('publishShare' in service).toBeFalse()
  })
})

describe('web keychain', () => {
  test('signs hub-bound v1 tokens', async () => {
    const { createPublicKey, verify } = await import('node:crypto')
    const { sign } = await import('./keychain-web')
    const hubKey = 'MCowBQYDK2VwAyEAiojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w='
    const [, key, signature, expiry] = (await sign(60, hubKey)).split('.')
    const publicKey = createPublicKey({ key: Buffer.from(key!, 'base64'), format: 'der', type: 'spki' })
    expect(verify(null, Buffer.from(`hub1:${hubKey}:${expiry}`), publicKey, Buffer.from(signature!, 'base64'))).toBeTrue()
    expect(verify(null, Buffer.from(expiry!), publicKey, Buffer.from(signature!, 'base64'))).toBeFalse()
  })
})
