import { Service } from '.'
new Service().post('test/echo', body => body).start()
