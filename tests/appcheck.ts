// App interface check: verifies a hub app path streams an AppInterface with a
// matching header. Usage: bun hub-service/tests/appcheck.ts <appPath> <name>
import { Channel } from 'channel/client'

const [appPath, name = ''] = process.argv.slice(2)
if (!appPath) {
  console.error('usage: appcheck.ts <appPath> [name]')
  process.exit(2)
}

const ch = new Channel()
const sender = ch.connect(1997)
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
