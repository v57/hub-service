import { MultiplatformService, type ServiceOptions } from './service'
export type { Context, Caller, ServiceRequest, ServiceProvider, ServiceIdentity, HubKeyStore, HubInfo } from './service'
export { publicKey, signChallenge } from './keychain-web'
import { hubKeys, sign } from './keychain-web'

export class Service extends MultiplatformService {
  constructor(options?: ServiceOptions) {
    super({ sign: hubKey => sign(60, hubKey), hubKeys }, options)
  }
}
