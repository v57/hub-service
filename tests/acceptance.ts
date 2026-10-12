// Final acceptance: verifies a live hub has echo providers registered and
// answers calls. Usage: PORT=1998 EXPECTED=10 bun hub-service/tests/acceptance.ts
import { Channel } from 'channel/client'

const port = Number(process.env.PORT ?? 1997)
const expected = Number(process.env.EXPECTED ?? 1)

const ch = new Channel()
const sender = ch.connect(port)

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ])
}

// 1. hub/api via POST (authoritative current list, no stream staleness)
const api = (await withTimeout(sender.send('hub/api'), 5000, 'hub/api')) as string[]
if (!api.includes('echo')) {
  console.error(`FAIL: 'echo' not in hub/api: ${JSON.stringify(api)}`)
  process.exit(2)
}
console.log(`hub/api includes 'echo' (${api.length} paths)`)

// 2. Count providers for echo — collect for up to 10s or until >= expected
let providers: { id: string }[] = []
{
  const services = sender.values('hub/api/services', 'echo')
  const deadline = Date.now() + 10_000
  await withTimeout(
    (async () => {
      for await (const list of services) {
        providers = (list as any) ?? []
        console.log(`providers for 'echo': ${providers.length}`)
        if (providers.length >= expected) break
        if (Date.now() > deadline) break
      }
    })(),
    15_000,
    'provider collection',
  ).catch(() => {})
}
if (providers.length < expected) {
  console.error(`FAIL: expected at least ${expected} providers, got ${providers.length}`)
  process.exit(1)
}

// 3. Call through the hub
const response = await withTimeout(sender.send('echo/upper', 'hello'), 5000, 'echo/upper')
if (JSON.stringify(response) !== '"HELLO"') {
  console.error(`FAIL: echo/upper -> ${JSON.stringify(response)}`)
  process.exit(1)
}
console.log('OK: echo/upper -> "HELLO"')

// 4. App interface
const appValues = sender.values('echo/ui')
const appFirst = await withTimeout(appValues.next(), 5000, 'echo/ui first value')
const app = appFirst.value
if (app?.header?.path !== 'echo/ui') {
  console.error(`FAIL: echo/ui header mismatch: ${JSON.stringify(app?.header)}`)
  process.exit(1)
}
console.log('OK: echo/ui AppInterface', JSON.stringify(app.header))
console.log('ACCEPTANCE-PASS')
process.exit(0)
