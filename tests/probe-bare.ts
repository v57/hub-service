// Bare connect-and-exit probe: connects to the hub, waits 3s, exits abruptly.
// Tests whether an abrupt client disconnect kills other clients' connections.
import { Channel } from 'channel/client'

const ch = new Channel()
const sender = ch.connect(Number(process.env.PORT ?? 1998))
console.log('connected, exiting abruptly in 3s')
await new Promise(r => setTimeout(r, 3000))
process.exit(0)
