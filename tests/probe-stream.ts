// Streams hub/api/services('echo') then exits abruptly. Tests whether
// streaming + abrupt exit kills other clients' connections.
import { Channel } from 'channel/client'

const ch = new Channel()
const sender = ch.connect(Number(process.env.PORT ?? 1998))
const services = sender.values('hub/api/services', 'echo')
const first = await services.next()
console.log('providers:', (first.value as any)?.length)
await new Promise(r => setTimeout(r, 2000))
process.exit(0)
