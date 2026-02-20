import { MultiplatformService, type ServiceOptions } from './service'
export { publicKey } from './keychain-web'
import { sign } from './keychain-web'

export class Service extends MultiplatformService {
  constructor(options?: ServiceOptions) {
    super(() => sign(), options)
  }
}
