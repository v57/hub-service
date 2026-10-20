import { basename } from 'node:path'
import { NetworkService, type ServiceOptions } from './service'
import { DeviceCertificates, deviceModeEnabled, type DeviceOptions } from './device'
export type { Context, Caller, ServiceRequest, ServiceProvider, ServiceIdentity, HubKeyStore, HubInfo } from './service'
export type * from './device-api'
export * from './network'
export { publicKey, signChallenge, HubKeyFile } from './keychain'
export { DeviceCertificates, deviceKeyPath, loadDeviceKey, type DeviceOptions } from './device'
export { deviceId, safetyCode } from './keys'
import { hubKeys, publicKey, sign, signChallenge } from './keychain'

export interface BunServiceOptions extends ServiceOptions {
  /**
   * Instance name, unique on this device (`s3-local/Backup Disk`). Defaults to `HUB_INSTANCE`,
   * then the service name, then the working directory's name.
   */
  instance?: string
  /** Device mode settings, or false to connect without a device certificate. Also off with `HUB_DEVICE=0`. */
  device?: DeviceOptions | false
}

export class Service extends NetworkService {
  /** Issues this service's device certificates; absent when device mode is off. */
  readonly device?: DeviceCertificates
  constructor(options?: BunServiceOptions) {
    const device =
      options?.device === false || !deviceModeEnabled()
        ? undefined
        : new DeviceCertificates({
            ...options?.device,
            instance: options?.instance ?? process.env.HUB_INSTANCE ?? options?.name ?? basename(process.cwd()),
            service: () => publicKey(),
          })
    super(
      { sign: hubKey => sign(60, hubKey), hubKeys, certificate: device && (() => device.header()) },
      signChallenge,
      () => publicKey(),
      options,
    )
    this.device = device
  }
}
