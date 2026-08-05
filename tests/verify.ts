// Cross-language hub-service acceptance verifier.
// Connects to a live hub (default 127.0.0.1:1997), waits until <servicePath>
// appears in the hub/api stream, then calls <postPath> with <body> through the
// hub and asserts the JSON response equals <expected>.
//
// Usage:
//   bun hub-service/tests/verify.ts <servicePath> <postPath> <bodyJson> <expectedJson>
//   bun hub-service/tests/verify.ts echo echo/upper '"hello"' '"HELLO"'
//
// Exit 0 = pass, 1 = fail, 2 = timeout/usage error.
import { Channel } from 'channel/client'

const [servicePath, postPath, bodyJson, expectedJson] = process.argv.slice(2)
if (!servicePath || !postPath || bodyJson === undefined || expectedJson === undefined) {
  console.error('usage: verify.ts <servicePath> <postPath> <bodyJson> <expectedJson>')
  process.exit(2)
}
const body = JSON.parse(bodyJson)
const expected = JSON.parse(expectedJson)

const ch = new Channel()
const sender = ch.connect(1997)

// Wait for the service path to be registered (10s timeout).
const api = sender.values('hub/api')
const deadline = Date.now() + 10_000
let found = false
for await (const list of api) {
  if (Array.isArray(list) && list.includes(servicePath)) {
    found = true
    break
  }
  if (Date.now() > deadline) break
}
if (!found) {
  console.error(`FAIL: '${servicePath}' never appeared in hub/api`)
  process.exit(2)
}

const response = await sender.send(postPath, body)
const actual = JSON.stringify(response)
const want = JSON.stringify(expected)
if (actual !== want) {
  console.error(`FAIL: ${postPath} -> ${actual} (expected ${want})`)
  process.exit(1)
}
console.log(`OK: ${postPath} -> ${actual}`)
process.exit(0)
