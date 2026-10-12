import { NetworkService, type ServiceOptions } from './service'
export type { Context, ServiceProvider } from './service'
export * from './network'
export { publicKey, signChallenge } from './keychain'
import { publicKey, sign, signChallenge } from './keychain'

export class Service extends NetworkService {
  constructor(options?: ServiceOptions) {
    super(() => sign(), signChallenge, () => publicKey(), options)
  }
}
