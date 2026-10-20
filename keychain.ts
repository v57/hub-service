import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { KeyFile, authToken } from './keys'
import type { HubKeyStore } from './service'

const keyPath = 'auth'
let key: Promise<KeyFile> | undefined

/**
 * Auth token for the hub connection, valid for `expires` seconds.
 * With `hubKey` the token is bound to that hub (v1), otherwise it is a v0 token.
 */
export async function sign(expires: number = 60, hubKey?: string) {
  return authToken(await loadKey(), Math.round(Date.now() / 1000) + expires, hubKey)
}

/** Sign arbitrary challenge data with existing service identity. */
export async function signChallenge(challenge: string): Promise<string> {
  return (await loadKey()).sign(challenge)
}

export async function publicKey(): Promise<string> {
  return (await loadKey()).publicKey
}

function loadKey(): Promise<KeyFile> {
  if (!key) {
    key = readKey().catch(error => {
      key = undefined
      throw error
    })
  }
  return key
}

async function readKey(): Promise<KeyFile> {
  const file = Bun.file(keyPath)
  if (await file.exists()) return new KeyFile(await file.text())
  const generated = KeyFile.generate()
  await file.write(generated.text)
  return generated
}

/**
 * Pinned hub keys in `hubs.json` beside the key file: `{ "<address>": "<hub SPKI>" }`.
 */
export class HubKeyFile implements HubKeyStore {
  readonly path: string
  private keys?: Promise<Record<string, string>>
  constructor(path: string = join(dirname(keyPath), 'hubs.json')) {
    this.path = path
  }
  async get(address: string): Promise<string | undefined> {
    const keys = await this.load()
    return keys[address]
  }
  async set(address: string, hubKey: string | undefined): Promise<void> {
    const keys = { ...(await this.load()) }
    if (hubKey) keys[address] = hubKey
    else delete keys[address]
    this.keys = Promise.resolve(keys)
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temp, JSON.stringify(keys, null, 2), { mode: 0o600 })
    await rename(temp, this.path)
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

export const hubKeys = new HubKeyFile()
