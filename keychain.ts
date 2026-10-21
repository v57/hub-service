import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { KeyFile, authToken } from './keys'
import type { HubKeyStore } from './service'

const keyPath = 'auth'

/** A service key: a key file path (created on first use), key text, or a `KeyFile` */
export type ServiceKeySource = string | KeyFile

/**
 * A service's identity. A key file keeps the hub pins in `hubs.json` beside it; a key given as text or a `KeyFile`
 * has no file, so its service pins hubs in memory.
 */
export class ServiceKey {
  /** The key file, when the key comes from one */
  readonly path?: string
  /** Pins beside the key file; undefined for a key without a file */
  readonly hubKeys?: HubKeyFile
  private key?: Promise<KeyFile>
  constructor(source: ServiceKeySource = keyPath) {
    if (source instanceof KeyFile) {
      this.key = Promise.resolve(source)
    } else if (isKeyText(source)) {
      this.key = Promise.resolve(new KeyFile(source))
    } else {
      this.path = source
      this.hubKeys = HubKeyFile.beside(source)
    }
  }
  /** Auth token for the hub connection, valid for `expires` seconds; bound to `hubKey` (v1) when given. */
  async sign(expires: number = 60, hubKey?: string): Promise<string> {
    return authToken(await this.load(), Math.round(Date.now() / 1000) + expires, hubKey)
  }
  /** Signs arbitrary challenge data with this key. */
  async signChallenge(challenge: string): Promise<string> {
    return (await this.load()).sign(challenge)
  }
  async publicKey(): Promise<string> {
    return (await this.load()).publicKey
  }
  private load(): Promise<KeyFile> {
    if (!this.key) {
      this.key = readKey(this.path!).catch(error => {
        this.key = undefined
        throw error
      })
    }
    return this.key
  }
}

/** Key text is the base64 of 92 bytes (PKCS8 + SPKI); anything else is a path */
function isKeyText(value: string): boolean {
  const text = value.trim()
  return /^[A-Za-z0-9+/]+={0,2}$/.test(text) && Buffer.from(text, 'base64').length === 92
}

async function readKey(path: string): Promise<KeyFile> {
  const file = Bun.file(path)
  if (await file.exists()) return new KeyFile(await file.text())
  const generated = KeyFile.generate()
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, generated.text, { mode: 0o600 })
  return generated
}

/**
 * Pinned hub keys in `hubs.json` beside the key file: `{ "<address>": "<hub SPKI>" }`.
 */
export class HubKeyFile implements HubKeyStore {
  /** One store per file, so keys in the same folder share their pins without overwriting each other */
  private static files = new Map<string, HubKeyFile>()
  static beside(keyPath: string): HubKeyFile {
    const path = resolve(dirname(keyPath), 'hubs.json')
    let file = HubKeyFile.files.get(path)
    if (!file) HubKeyFile.files.set(path, (file = new HubKeyFile(path)))
    return file
  }
  readonly path: string
  private keys?: Promise<Record<string, string>>
  constructor(path: string = join(dirname(keyPath), 'hubs.json')) {
    this.path = path
  }
  async get(address: string): Promise<string | undefined> {
    const keys = await this.load()
    return keys[address]
  }
  /** Writes one at a time, so services sharing this file don't drop each other's pins */
  private writes: Promise<void> = Promise.resolve()
  set(address: string, hubKey: string | undefined): Promise<void> {
    const write = this.writes.then(async () => {
      const keys = { ...(await this.load()) }
      if (hubKey) keys[address] = hubKey
      else delete keys[address]
      this.keys = Promise.resolve(keys)
      await mkdir(dirname(this.path), { recursive: true })
      const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temp, JSON.stringify(keys, null, 2), { mode: 0o600 })
      await rename(temp, this.path)
    })
    this.writes = write.catch(() => {})
    return write
  }
  private load(): Promise<Record<string, string>> {
    if (!this.keys) {
      this.keys = Bun.file(this.path)
        .json()
        .then(value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}))
        .catch(() => ({}))
    }
    return this.keys
  }
}

/** The key in `./auth`, used by services without a `key` option */
export const defaultKey = new ServiceKey()

/**
 * Auth token for the hub connection, valid for `expires` seconds.
 * With `hubKey` the token is bound to that hub (v1), otherwise it is a v0 token.
 */
export function sign(expires: number = 60, hubKey?: string) {
  return defaultKey.sign(expires, hubKey)
}

/** Sign arbitrary challenge data with existing service identity. */
export function signChallenge(challenge: string): Promise<string> {
  return defaultKey.signChallenge(challenge)
}

export function publicKey(): Promise<string> {
  return defaultKey.publicKey()
}

export const hubKeys = defaultKey.hubKeys!
