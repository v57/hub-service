import { basename } from 'node:path'
import { NetworkService, type ServiceOptions } from './service'
import { DeviceCertificates, deviceModeEnabled, type DeviceOptions } from './device'
export type { Context, Caller, ServiceProvider, ServiceIdentity, HubKeyStore, HubInfo, ServiceHealth, ApiSettings, ServiceHeader } from './service'
export { HubRefusedError, normalizeHubAddress, ServiceRequest } from './service'
export type { Auth, Requirements, DelegatedUser, Validator, RateLimit } from './request'
export { checkSchema, jsonSchema, type JSONSchema, type JSONSchemaType, type ApiAnnotations, type ApiDescription, type SchemaIssue, type SchemaValidator } from './schema'
export { HubError, ChannelError, errorCode, type HubErrorCode } from './errors'
export type * from './device-api'
export * from './network'
export { publicKey, signChallenge, HubKeyFile, ServiceKey, type ServiceKeySource } from './keychain'
export { DeviceCertificates, deviceKeyPath, loadDeviceKey, type DeviceOptions, type DeviceKeySource } from './device'
export { KeyFile, attachSignedData, deviceId, safetyCode } from './keys'
import { attachSignedData } from './keys'
import { ServiceKey, defaultKey, type ServiceKeySource } from './keychain'

export interface BunServiceOptions extends ServiceOptions {
  /**
   * Instance name, unique on this device (`s3-local/Backup Disk`). Defaults to `HUB_INSTANCE`,
   * then the service name, then the working directory's name.
   */
  instance?: string
  /** Device mode settings, or false to connect without a device certificate. Also off with `HUB_DEVICE=0`. */
  device?: DeviceOptions | false
  /**
   * This service's key: a key file path (created on first use, hub pins in `hubs.json` beside it), key text or a
   * `KeyFile` (hub pins in memory). Defaults to `./auth`. Services with different keys can run in one process.
   */
  key?: ServiceKeySource | ServiceKey
}

export class Service extends NetworkService {
  /** Issues this service's device certificates; absent when device mode is off. */
  readonly device?: DeviceCertificates
  /** This service's key */
  readonly key: ServiceKey
  constructor(options?: BunServiceOptions) {
    const key = options?.key === undefined ? defaultKey : options.key instanceof ServiceKey ? options.key : new ServiceKey(options.key)
    const device =
      options?.device === false || !deviceModeEnabled()
        ? undefined
        : new DeviceCertificates({
            ...options?.device,
            // Configured (option or HUB_INSTANCE), else the profile name, else the directory; empty becomes 'service'
            instance: options?.instance ?? process.env.HUB_INSTANCE ?? options?.name ?? basename(process.cwd()),
            service: () => key.publicKey(),
          })
    super(
      { sign: (hubKey, nonce) => key.sign(30, hubKey, nonce), hubKeys: key.hubKeys, certificate: device && (() => device.header()), attach: device?.attach },
      challenge => key.signChallenge(challenge),
      () => key.publicKey(),
      options,
    )
    this.key = key
    this.device = device
  }
  /**
   * Takes a device that asked to attach as a child of this one, signing for it with the device key (protocol.md
   * section 14). Compare the safety code first: the signature is the approval.
   */
  async attachChild(child: { id: string; key: string }, now: number = Math.floor(Date.now() / 1000)) {
    if (!this.device) throw new Error('no device key')
    if (!this.hubKey) throw new Error('hub key not pinned')
    const key = await this.device.key()
    return this.send('hub/device/attach', {
      child: child.id,
      at: now,
      signature: key.sign(attachSignedData(this.hubKey, key.publicKey, child.key, now)),
    })
  }
  /**
   * Shuts this service down gracefully (`shutdown`) on SIGTERM or SIGINT, then exits once every service that asked
   * for it has stopped. `timeout` is in milliseconds.
   */
  shutdownOnSignals(options: { timeout?: number } = {}): this {
    signalled.set(this, options)
    if (!signalHandler) {
      signalHandler = async () => {
        process.off('SIGTERM', signalHandler!)
        process.off('SIGINT', signalHandler!)
        await Promise.all(Array.from(signalled, ([service, options]) => service.shutdown(options)))
        process.exit(0)
      }
      process.on('SIGTERM', signalHandler)
      process.on('SIGINT', signalHandler)
    }
    return this
  }
}

const signalled = new Map<Service, { timeout?: number }>()
let signalHandler: (() => Promise<void>) | undefined
