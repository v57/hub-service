import { MultiplatformService, type ServiceOptions } from './service'
export type { Context, ServiceProvider } from './service'
export { publicKey } from './keychain'
import { sign } from './keychain'

export class Service extends MultiplatformService {
  constructor(options?: ServiceOptions) {
    super(() => sign(), options)
  }
}
