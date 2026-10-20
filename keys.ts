import { createHash, createPrivateKey, generateKeyPairSync, sign as signData } from 'crypto'

/**
 * An Ed25519 key in the Hub key file format: base64 of the PKCS#8 DER private key (48 bytes)
 * followed by the SPKI DER public key (44 bytes). Service `auth` files and `device.key` both use it.
 */
export class KeyFile {
  readonly text: string
  /** SPKI DER, standard base64 */
  readonly publicKey: string
  private readonly privateKey: ReturnType<typeof createPrivateKey>
  constructor(text: string) {
    this.text = text.trim()
    const bytes = Buffer.from(this.text, 'base64')
    if (bytes.length !== 92) throw new Error('invalid key file')
    this.privateKey = createPrivateKey({ key: bytes.subarray(0, 48), format: 'der', type: 'pkcs8' })
    this.publicKey = bytes.subarray(48).toString('base64')
  }
  static generate(): KeyFile {
    const keys = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { format: 'der', type: 'pkcs8' },
      publicKeyEncoding: { format: 'der', type: 'spki' },
    })
    return new KeyFile(Buffer.concat([keys.privateKey, keys.publicKey]).toString('base64'))
  }
  /** Ed25519 signature over the UTF-8 bytes of `data`, standard base64. */
  sign(data: string): string {
    return signData(null, Buffer.from(data), this.privateKey).toString('base64')
  }
}

/** The string an `auth` token signs: `<expiry>` for v0, `hub1:<hub key>:<expiry>` for v1. */
export function authSignedData(expiry: number, hubKey?: string): string {
  return hubKey ? `hub1:${hubKey}:${expiry}` : `${expiry}`
}

/** `key.<service SPKI>.<signature>.<expiry>` */
export function authToken(key: KeyFile, expiry: number, hubKey?: string): string {
  return `key.${key.publicKey}.${key.sign(authSignedData(expiry, hubKey))}.${expiry}`
}

/** First 32 lowercase hex characters of SHA-256 of the device SPKI DER bytes. */
export function deviceId(devicePublicKey: string): string {
  return spkiDigest(devicePublicKey).slice(0, 32)
}

/** Six digits from the device key digest, shown as `ddd ddd` on both devices during approval. */
export function safetyCode(devicePublicKey: string): string {
  const n = parseInt(spkiDigest(devicePublicKey).slice(0, 8), 16) % 1_000_000
  const digits = n.toString().padStart(6, '0')
  return `${digits.slice(0, 3)} ${digits.slice(3)}`
}

function spkiDigest(publicKey: string): string {
  return createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex')
}

export interface CertificateFields {
  device: string
  service: string
  instance: string
  deviceName?: string
  platform?: string
  parent?: string
  hub?: string
  iat: number
  exp: number
}

/** Longest certificate lifetime the hub accepts, in seconds (7 days) */
export const certificateMaxLifetime = 604_800

/**
 * Encodes a service certificate as `<base64url(JSON)>.<signature>`.
 * The device key signs the base64url payload string. Fields keep the protocol's order.
 */
export function makeCertificate(device: KeyFile, fields: Omit<CertificateFields, 'device'>): string {
  const ordered: Record<string, unknown> = {
    v: 1,
    device: device.publicKey,
    service: fields.service,
    instance: fields.instance,
  }
  if (fields.deviceName !== undefined) ordered.deviceName = fields.deviceName
  if (fields.platform !== undefined) ordered.platform = fields.platform
  if (fields.parent !== undefined) ordered.parent = fields.parent
  if (fields.hub !== undefined) ordered.hub = fields.hub
  ordered.iat = fields.iat
  ordered.exp = fields.exp
  const payload = Buffer.from(JSON.stringify(ordered)).toString('base64url')
  return `${payload}.${device.sign(payload)}`
}

/** Decodes a certificate without verifying it. */
export function readCertificate(header: string): CertificateFields & { v: number } {
  const [payload] = header.split('.')
  return JSON.parse(Buffer.from(payload!, 'base64url').toString())
}

/** Truncates to at most `limit` UTF-8 bytes without splitting a character. */
export function truncateUTF8(value: string, limit: number): string {
  if (Buffer.byteLength(value) <= limit) return value
  let result = ''
  let length = 0
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (length + size > limit) break
    result += character
    length += size
  }
  return result
}
