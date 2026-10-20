import { NetworkService, type ServiceOptions } from './service'
export type { Context, Caller, ServiceRequest, ServiceProvider, ServiceIdentity, HubKeyStore, HubInfo } from './service'
export * from './network'
export { publicKey, signChallenge, HubKeyFile } from './keychain'
import { hubKeys, publicKey, sign, signChallenge } from './keychain'

export class Service extends NetworkService {
  constructor(options?: ServiceOptions) {
    super({ sign: hubKey => sign(60, hubKey), hubKeys }, signChallenge, () => publicKey(), options)
  }
}
