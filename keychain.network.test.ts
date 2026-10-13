import { describe, expect, test } from 'bun:test'
import { createPublicKey, verify } from 'node:crypto'
import { publicKey, sign, signChallenge } from './keychain'

describe('service identity network challenge proof', () => {
  test('signs the exact challenge with the existing Ed25519 identity', async () => {
    const challenge = 'hub-network/local-agent/challenge/v1:test-nonce'
    const signature = await signChallenge(challenge)
    const serviceKey = await publicKey()
    const key = createPublicKey({
      key: Buffer.from(serviceKey, 'base64'),
      format: 'der',
      type: 'spki',
    })

    expect(verify(null, Buffer.from(challenge), key, Buffer.from(signature, 'base64'))).toBeTrue()
    expect(verify(null, Buffer.from(`${challenge}-changed`), key, Buffer.from(signature, 'base64'))).toBeFalse()
  })

  test('signs auth token payload through the same identity primitive', async () => {
    const token = await sign()
    const [, serviceKey, signature, payload] = token.split('.')
    const key = createPublicKey({
      key: Buffer.from(serviceKey!, 'base64'),
      format: 'der',
      type: 'spki',
    })

    expect(verify(
      null,
      Buffer.from(payload!),
      key,
      Buffer.from(signature!, 'base64'),
    )).toBeTrue()
  })
})
