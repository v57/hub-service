import { MultiplatformService, type ServiceOptions } from './service'
export type { Context, Caller, ServiceProvider, ServiceIdentity, HubKeyStore, HubInfo, ServiceHealth, ApiSettings } from './service'
export { HubRefusedError, normalizeHubAddress, ServiceRequest } from './service'
export type { Auth, Requirements, DelegatedUser, Validator, RateLimit } from './request'
export { HubError, ChannelError, errorCode, type HubErrorCode } from './errors'
export type * from './device-api'
export { publicKey, signChallenge } from './keychain-web'
import { hubKeys, sign } from './keychain-web'

export class Service extends MultiplatformService {
  constructor(options?: ServiceOptions) {
    super({ sign: hubKey => sign(60, hubKey), hubKeys }, options)
  }
}
