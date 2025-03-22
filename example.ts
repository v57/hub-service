import { Service } from './service'
new Service().post('test/echo', body => body).start()
