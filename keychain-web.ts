const textEncoder = new TextEncoder()
let privateKey: string | undefined
let memoryKey: string | undefined

export async function sign(expires: number = 10) {
  const key = await loadKey()
  const pub = getPublicKey(key)
  const data = `${Math.round(new Date().getTime() / 1000) + expires}`
  const signature = await makeSignature(key, data)
  return `key.${pub}.${signature}.${data}`
}

export async function publicKey(): Promise<string> {
  const key = await loadKey()
  return getPublicKey(key)
}

async function loadKey(): Promise<string> {
  if (privateKey) return privateKey
  const key = await readStoredKey()
  if (key) {
    privateKey = key
    return key
  }
  const generated = await generateKey()
  await writeStoredKey(generated)
  privateKey = generated
  return generated
}

async function generateKey(): Promise<string> {
  const keyPair = await getSubtleCrypto().generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
  const privateKey = new Uint8Array(await getSubtleCrypto().exportKey('pkcs8', keyPair.privateKey))
  const publicKey = new Uint8Array(await getSubtleCrypto().exportKey('spki', keyPair.publicKey))
  const key = new Uint8Array(privateKey.byteLength + publicKey.byteLength)
  key.set(privateKey, 0)
  key.set(publicKey, privateKey.byteLength)
  return encodeBase64(key)
}

function getPublicKey(key: string): string {
  const keyBuffer = fromBase64(key)
  const publicLength = getPublicLength(keyBuffer)
  return encodeBase64(keyBuffer.subarray(keyBuffer.length - publicLength))
}

async function makeSignature(key: string, data: string): Promise<string> {
  const keyBuffer = fromBase64(key)
  const publicLength = getPublicLength(keyBuffer)
  const privateKey = await getSubtleCrypto().importKey(
    'pkcs8',
    keyBuffer.subarray(0, keyBuffer.length - publicLength),
    { name: 'Ed25519' },
    false,
    ['sign'],
  )
  const signature = await getSubtleCrypto().sign({ name: 'Ed25519' }, privateKey, textEncoder.encode(data))
  return encodeBase64(new Uint8Array(signature))
}

function getPublicLength(key: Uint8Array): number {
  if (key.length >= 44) return 44
  return 0
}

function getSubtleCrypto(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) throw 'Web Crypto unavailable'
  return globalThis.crypto.subtle
}

function fromBase64(value: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(value, 'base64'))
  if (typeof atob === 'undefined') throw 'Base64 decode unavailable'
  const decoded = atob(value)
  const bytes = new Uint8Array(decoded.length)
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i)
  return bytes
}

function encodeBase64(value: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(value).toString('base64')
  if (typeof btoa === 'undefined') throw 'Base64 encode unavailable'
  let output = ''
  for (const byte of value) output += String.fromCharCode(byte)
  return btoa(output)
}

async function readStoredKey(): Promise<string | undefined> {
  if (typeof localStorage !== 'undefined') {
    try {
      const cached = localStorage.getItem('auth')
      if (cached) return cached
    } catch {}
  }
  return memoryKey
}

async function writeStoredKey(key: string): Promise<void> {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem('auth', key)
      return
    } catch {}
  }
  memoryKey = key
}
