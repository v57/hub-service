import { afterEach, describe, expect, test } from 'bun:test'
import { KeyFile, authToken } from './keys'
import { MultiplatformService, type ServiceRequest } from './service'
import { FakeHub, vectors, waitFor } from './testing/fake-hub'

const serviceKey = new KeyFile(vectors.keys.service.keyFile)
const sign = async (hubKey?: string) => authToken(serviceKey, Math.round(Date.now() / 1000) + 60, hubKey)

let hub: FakeHub
let service: MultiplatformService
afterEach(() => {
  service?.sender?.stop()
  hub?.stop()
})

async function connect(options: { info?: boolean } = {}) {
  hub = new FakeHub(options)
  const port = hub.start()
  service = new MultiplatformService({ sign }, { address: port })
  const requests: ServiceRequest[] = []
  service
    .post('test/whoami', (_body, request) => {
      requests.push(request)
      return request.caller?.key ?? null
    })
    .post('test/legacy', body => body)
    .post('test/public', () => true, { public: true })
    .stream('test/stream', async function* (body, request) {
      yield request.caller?.device?.name
      yield body
    })
    .start()
  await waitFor(() => hub.open.some(c => c.updates.length > 0))
  return { connection: hub.open.find(c => c.updates.length > 0)!, requests }
}

describe('caller identity', () => {
  test('passes the hub caller to post handlers', async () => {
    const { connection, requests } = await connect()
    const context = { ...vectors.caller.context, service: 'abc' }
    expect(await connection.sender.send('test/whoami', null, { context })).toBe(vectors.keys.service.publicKey)
    expect(requests[0]).toMatchObject({ caller: vectors.caller.context.hub.caller, context: { service: 'abc' } })
  })

  test('passes the hub caller to stream handlers', async () => {
    const { connection } = await connect()
    const values: unknown[] = []
    for await (const value of connection.sender.values('test/stream', 'body', { context: vectors.caller.context })) {
      values.push(value)
      if (values.length === 2) break
    }
    expect(values).toEqual(['Mac Studio', 'body'])
  })

  test('keeps body-only handlers working', async () => {
    const { connection } = await connect()
    expect(await connection.sender.send('test/legacy', { a: 1 }, { context: vectors.caller.context })).toEqual({ a: 1 })
  })

  test('ignores a caller that names another hub', async () => {
    const { connection, requests } = await connect()
    const context = { hub: { ...vectors.caller.context.hub, hubKey: vectors.keys.device.publicKey } }
    expect(await connection.sender.send('test/whoami', null, { context })).toBeNull()
    expect(requests[0]).toMatchObject({ context: {} })
    expect(requests[0]!.caller).toBeUndefined()
  })

  test('ignores a caller when the hub key is not pinned', async () => {
    const { connection, requests } = await connect({ info: false })
    expect(await connection.sender.send('test/whoami', null, { context: vectors.caller.context })).toBeNull()
    expect(requests[0]!.caller).toBeUndefined()
  })

  test('has no caller without context', async () => {
    const { connection, requests } = await connect()
    expect(await connection.sender.send('test/whoami')).toBeNull()
    expect(requests[0]).toMatchObject({ context: {} })
    expect(requests[0]!.caller).toBeUndefined()
  })
})

describe('service header', () => {
  test('marks public paths', async () => {
    const { connection } = await connect()
    const services = connection.updates[0].services
    expect(services.find((s: any) => s.path === 'test/public').public).toBeTrue()
    expect('public' in services.find((s: any) => s.path === 'test/legacy')).toBeFalse()
  })
})
