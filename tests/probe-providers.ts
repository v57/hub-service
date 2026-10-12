// Probe: calls echo/upper against EVERY registered echo provider via
// context.service selection, reporting which respond and which hang.
import { Channel } from 'channel/client'

const ch = new Channel()
const sender = ch.connect(1997)

// Collect provider ids for 'echo'
const services = sender.values('hub/api/services', 'echo')
const first = await services.next()
const providers: { id: string; name?: string }[] = (first.value as any) ?? []
console.log('providers:', JSON.stringify(providers))

for (const p of providers) {
  const result = await new Promise<string>(resolve => {
    const timer = setTimeout(() => resolve('HANG'), 4000)
    sender
      .send('echo/upper', 'hello', { context: { service: p.id } })
      .then(r => {
        clearTimeout(timer)
        resolve(`OK ${JSON.stringify(r)}`)
      })
      .catch(e => {
        clearTimeout(timer)
        resolve(`ERR ${e}`)
      })
  })
  console.log(`  ${p.id.slice(0, 8)} ${p.name ?? ''}: ${result}`)
}
process.exit(0)
