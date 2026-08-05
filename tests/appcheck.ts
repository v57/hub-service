import { Channel } from 'channel/client'
const ch = new Channel()
const sender = ch.connect(1997)
const v = sender.values('hasher/ui')
const first = await v.next()
if (first.done) { console.error('FAIL: app stream closed immediately'); process.exit(1) }
const app = first.value
console.log('header:', JSON.stringify(app.header))
console.log('body types:', app.body?.map((e: any) => typeof e === 'string' ? 'string' : e.type))
if (app.header?.path !== 'hasher/ui') { console.error('FAIL'); process.exit(1) }
console.log('APP-OK')
process.exit(0)
