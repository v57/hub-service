// App interface check: verifies a hub app path streams an AppInterface with a
// matching header. Usage: bun hub-service/tests/appcheck.ts <appPath> <name> [port]
// Port defaults to 1997, or PORT env.
import { Channel } from 'channel/client'

const [appPath, name = '', portArg] = process.argv.slice(2)
const port = Number(portArg ?? process.env.PORT ?? 1997)
if (!appPath) {
  console.error('usage: appcheck.ts <appPath> [name] [port]')
  process.exit(2)
}

const ch = new Channel()
const sender = ch.connect(port)
const values = sender.values(appPath)
const first = await values.next()
if (first.done) {
  console.error(`FAIL: ${appPath} stream closed immediately`)
  process.exit(1)
}
const app = first.value
console.log('header:', JSON.stringify(app.header))
console.log('body types:', app.body?.map((e: any) => (typeof e === 'string' ? 'string' : e.type)))
if (app.header?.path !== appPath || (name && app.header?.name !== name)) {
  console.error('FAIL: header mismatch')
  process.exit(1)
}
console.log('APP-OK')
process.exit(0)
