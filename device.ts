import { link, mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { KeyFile, certificateMaxLifetime, deviceId, makeCertificate, truncateUTF8 } from './keys'

/** A device key: a key file's text, a loaded key, or a loader (for apps that keep it in their own store). */
export type DeviceKeySource = KeyFile | string | (() => KeyFile | string | Promise<KeyFile | string>)

export interface DeviceOptions {
  /**
   * A caller-provided device key, used instead of the key file. One OS instance should still use one device key;
   * an app that can't share it becomes its own device.
   */
  key?: DeviceKeySource
  /** Device key file. Defaults to `HUB_DEVICE_KEY`, `/var/lib/hub/device.key` for root on Linux, else `~/.hub/device.key`. */
  keyPath?: string
  /** Suggested device name. Defaults to `HUB_DEVICE_NAME`, the computer name or the host name. */
  name?: string
  /** Defaults to the OS: `macos`, `linux`, `windows`, `android` or `other`. */
  platform?: string
  /** A name this device declares for where it runs, which gives it nothing. Defaults to `HUB_DEVICE_PARENT`. */
  parent?: string
  /**
   * Ask to attach as a child on every connect (protocol.md section 14): true for an owner to take it, or the parent's
   * device id. Defaults to `HUB_DEVICE_ATTACH`. A child holds only what the owner gives it, which is what a device
   * whose key lies in a file should be (a container, a VM, the launcher's services).
   */
  attach?: boolean | string
  /** Certificate lifetime in seconds, at most 7 days (the default). */
  lifetime?: number
}

/** A certificate is renewed at connect when it has less than this left, in seconds. */
export const certificateRenewal = 86_400

/** Where this process keeps its device key. */
export function deviceKeyPath(env: Record<string, string | undefined> = process.env): string {
  if (env.HUB_DEVICE_KEY) return env.HUB_DEVICE_KEY
  if (process.platform === 'linux' && process.getuid?.() === 0) return '/var/lib/hub/device.key'
  return join(homedir(), '.hub', 'device.key')
}

/** False when `HUB_DEVICE` turns device mode off (`0`, `off`, `false`, `no`). */
export function deviceModeEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = env.HUB_DEVICE?.toLowerCase()
  return !(value === '0' || value === 'off' || value === 'false' || value === 'no')
}

/** `HUB_DEVICE_ATTACH`: `1`, `on`, `true` or `yes` to be taken by an owner, a parent's device id, else nothing */
export function deviceAttach(env: Record<string, string | undefined> = process.env): boolean | string | undefined {
  const value = env.HUB_DEVICE_ATTACH?.trim()
  if (!value) return undefined
  const lower = value.toLowerCase()
  if (lower === '1' || lower === 'on' || lower === 'true' || lower === 'yes') return true
  if (lower === '0' || lower === 'off' || lower === 'false' || lower === 'no') return undefined
  return value
}

const deviceKeys = new Map<string, Promise<KeyFile>>()

/** Loads the device key, creating it if absent. Every service of a device shares it. */
export function loadDeviceKey(path: string = deviceKeyPath()): Promise<KeyFile> {
  let key = deviceKeys.get(path)
  if (!key) {
    key = readOrCreate(path).catch(error => {
      deviceKeys.delete(path)
      throw error
    })
    deviceKeys.set(path, key)
  }
  return key
}

async function readOrCreate(path: string): Promise<KeyFile> {
  const file = Bun.file(path)
  if (await file.exists()) return new KeyFile(await file.text())
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const key = KeyFile.generate()
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, key.text, { mode: 0o600 })
  try {
    // A hard link never replaces a key another process created at the same time
    await link(temp, path)
    return key
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error
    return new KeyFile(await Bun.file(path).text())
  } finally {
    await unlink(temp).catch(() => {})
  }
}

export function devicePlatform(platform: string = process.platform): string {
  switch (platform) {
    case 'darwin':
      return 'macos'
    case 'linux':
      return 'linux'
    case 'win32':
      return 'windows'
    case 'android':
      return 'android'
    default:
      return 'other'
  }
}

let computerName: string | undefined
/** The name a device suggests for itself. */
export function deviceName(env: Record<string, string | undefined> = process.env): string {
  if (env.HUB_DEVICE_NAME) return env.HUB_DEVICE_NAME
  if (computerName === undefined) {
    computerName = ''
    if (process.platform === 'darwin') {
      try {
        const result = Bun.spawnSync(['scutil', '--get', 'ComputerName'], { stderr: 'ignore' })
        if (result.exitCode === 0) computerName = result.stdout.toString().trim()
      } catch {}
    }
    if (!computerName) computerName = hostname().replace(/\.local$/, '')
  }
  return computerName
}

/**
 * Issues service certificates signed by the device key, for the `device` header.
 * A certificate is reused until it has less than a day left.
 */
export class DeviceCertificates {
  readonly keyPath: string
  readonly instance: string
  readonly name: string
  readonly platform: string
  readonly parent?: string
  readonly attach?: boolean | string
  readonly lifetime: number
  private readonly service: () => Promise<string>
  private readonly keySource?: DeviceKeySource
  private providedKey?: Promise<KeyFile>
  private current?: { header: string; service: string; exp: number }
  constructor(options: DeviceOptions & { instance: string; service: () => Promise<string> }) {
    this.keyPath = options.keyPath ?? deviceKeyPath()
    this.instance = truncateUTF8(options.instance, 128) || 'service'
    this.name = truncateUTF8(options.name ?? deviceName(), 64)
    this.platform = options.platform ?? devicePlatform()
    const parent = options.parent ?? process.env.HUB_DEVICE_PARENT
    if (parent) this.parent = truncateUTF8(parent, 64)
    this.attach = options.attach ?? deviceAttach()
    this.lifetime = Math.max(60, Math.min(options.lifetime ?? certificateMaxLifetime, certificateMaxLifetime))
    this.service = options.service
    this.keySource = options.key
  }
  key(): Promise<KeyFile> {
    const source = this.keySource
    if (source === undefined) return loadDeviceKey(this.keyPath)
    if (!this.providedKey) {
      this.providedKey = (async () => {
        const key = typeof source === 'function' ? await source() : source
        return typeof key === 'string' ? new KeyFile(key) : key
      })().catch(error => {
        this.providedKey = undefined
        throw error
      })
    }
    return this.providedKey
  }
  /** The device id: the first 32 hex characters of SHA-256 of the device key. */
  async id(): Promise<string> {
    return deviceId((await this.key()).publicKey)
  }
  async header(now: number = Math.floor(Date.now() / 1000)): Promise<string> {
    const service = await this.service()
    const current = this.current
    if (current && current.service === service && current.exp - now >= certificateRenewal) return current.header
    const exp = now + this.lifetime
    const header = makeCertificate(await this.key(), {
      service,
      instance: this.instance,
      deviceName: this.name || undefined,
      platform: this.platform,
      parent: this.parent,
      iat: now,
      exp,
    })
    this.current = { header, service, exp }
    return header
  }
}
