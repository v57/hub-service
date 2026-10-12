// Target a specific provider by id via context.service, with a short timeout.
// Usage: bun hub-service/tests/probe-one.ts <providerId> <path> <bodyJson>
import { Channel } from 'channel/client'

const [providerId, path, bodyJson] = process.argv.slice(2)
const body = JSON.parse(bodyJson ?? 'null')

const ch = new Channel()
const sender = ch.connect(Number(process.env.PORT ?? 1998))

const result = await new Promise<string>(resolve => {
  const timer = setTimeout(() => resolve('HANG'), 5000)
  sender
    .send(path, body, { context: { service: providerId } })
    .then(r => {
      clearTimeout(timer)
      resolve(`OK ${JSON.stringify(r)}`)
    })
    .catch(e => {
      clearTimeout(timer)
      resolve(`ERR ${e}`)
    })
})
console.log(result)
process.exit(0)
