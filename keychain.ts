import { generateKeyPairSync, createPrivateKey, sign as signData } from 'crypto'

let privateKey: string | undefined
export async function sign(expires: number = 10) {
  const publicKey = await getServicePublicKey()
  const data = `${Math.round(new Date().getTime() / 1000) + expires}`
  const signature = await signChallenge(data)
  return `key.${publicKey}.${signature}.${data}`
}

/** Sign arbitrary challenge data with existing service identity. */
export async function signChallenge(challenge: string): Promise<string> {
  return makeSignature(await loadKey(), challenge)
}

export async function publicKey(): Promise<string> {
  return getServicePublicKey()
}

async function getServicePublicKey(): Promise<string> {
  const key = await loadKey()
  return getPublicKey(key)
}

async function loadKey(): Promise<string> {
  if (privateKey) return privateKey
  try {
    const key = await Bun.file('auth').text()
    privateKey = key
    return key
  } catch {
    const privateKey = await generateKey()
    await Bun.file('auth').write(privateKey)
    return privateKey
  }
}

async function generateKey(): Promise<string> {
  const keys = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { format: 'der', type: 'pkcs8' },
    publicKeyEncoding: { format: 'der', type: 'spki' },
  })
  return Buffer.concat([keys.privateKey, keys.publicKey]).toString('base64')
}
function getPublicKey(key: string): string {
  return Buffer.from(key, 'base64')
    .subarray(48, 48 + 44)
    .toString('base64')
}

function makeSignature(key: string, data: string): string {
  const keyBuffer = Buffer.from(key, 'base64')
  const privateKey = createPrivateKey({
    key: keyBuffer.subarray(0, 48), // Extract private key
    format: 'der',
    type: 'pkcs8',
  })
  const signature = signData(null, Buffer.from(data), privateKey)
  return signature.toString('base64')
}
