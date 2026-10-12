// Debug: hub/api list + provider list for echo.
import { Channel } from 'channel/client'

const ch = new Channel()
const sender = ch.connect(1997)

const api = await sender.send('hub/api')
console.log('hub/api:', JSON.stringify(api))

const values = sender.values('hub/api/services', 'echo')
const timer = setTimeout(() => {
  console.error('hub/api/services HANG')
  process.exit(3)
}, 8000)
const first = await values.next()
clearTimeout(timer)
console.log('providers for echo:', JSON.stringify(first.value))
process.exit(0)
