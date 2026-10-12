// Query hub-lite status streams: per-path provider counts.
import { Channel } from 'channel/client'

const ch = new Channel()
const sender = ch.connect(Number(process.env.PORT ?? 1998))

const statusIt = sender.values('hub/status')
const first = await statusIt.next()
console.log('hub/status:', JSON.stringify(first.value))

const badgesIt = sender.values('hub/status/badges')
const second = await badgesIt.next()
console.log('hub/status/badges:', JSON.stringify(second.value))
process.exit(0)
