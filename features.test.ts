import { afterEach, describe, expect, test } from 'bun:test'
import { KeyFile, authToken } from './keys'
import { MultiplatformService, type ServiceOptions } from './service'
import { HubError, errorCode } from './errors'
import type { ServiceRequest } from './request'
import { FakeHub, vectors, waitFor, type FakeConnection } from './testing/fake-hub'

const serviceKey = new KeyFile(vectors.keys.service.keyFile)
const sign = async (hubKey?: string) => authToken(serviceKey, Math.round(Date.now() / 1000) + 60, hubKey)

let hub: FakeHub
let service: MultiplatformService
afterEach(() => {
  service?.stop()
  hub?.stop()
})

/** Starts a service set up by `setup` against a fake hub; returns the hub's connection to it */
async function start(setup: (service: MultiplatformService) => void, options: ServiceOptions = {}): Promise<FakeConnection> {
  hub = new FakeHub()
  const port = hub.start()
  service = new MultiplatformService({ sign }, { address: port, ...options })
  setup(service)
  service.start()
  await waitFor(() => hub.open.some(c => c.version === '1' && c.updates.length > 0))
  return hub.open.find(c => c.version === '1' && c.updates.length > 0)!
}

/** Calls `path` as `caller` the way the hub forwards it */
function call(connection: FakeConnection, path: string, caller: Record<string, unknown> | undefined, body?: any, extra?: Record<string, unknown>) {
  const context = caller ? hub.context(caller, extra) : extra
  return connection.sender.send(path, body, { context })
}

/** message|code of a rejection */
const failure = (promise: Promise<unknown>) =>
  promise.then(
    value => `ok ${JSON.stringify(value)}`,
    (error: any) => `${error?.message ?? error}|${errorCode(error) ?? ''}`,
  )

const alice = { key: 'alice-key' }
const owner = { key: 'owner-key', owner: true, groups: ['owners'] }
const onDevice = { key: 'device-key', device: { id: 'dev1', name: 'Phone' } }

describe('requirements', () => {
  test('auth levels fail with unauthorized or forbidden before the handler runs', async () => {
    let runs = 0
    const connection = await start(s =>
      s
        .post('t/key', () => ++runs, { auth: 'key' })
        .post('t/device', () => ++runs, { auth: 'device' })
        .post('t/owner', () => ++runs, { auth: 'owner' })
        .post('t/group', () => ++runs, { groups: ['editors'] }),
    )
    expect(await failure(call(connection, 't/key', undefined))).toBe('unauthorized|unauthorized')
    expect(await failure(call(connection, 't/key', {}))).toBe('unauthorized|unauthorized')
    expect(await failure(call(connection, 't/key', alice))).toBe('ok 1')
    expect(await failure(call(connection, 't/device', alice))).toBe('device required|forbidden')
    expect(await failure(call(connection, 't/device', onDevice))).toBe('ok 2')
    expect(await failure(call(connection, 't/owner', alice))).toBe('permissions required|forbidden')
    expect(await failure(call(connection, 't/owner', owner))).toBe('ok 3')
    expect(await failure(call(connection, 't/group', alice))).toBe('permissions required|forbidden')
    expect(await failure(call(connection, 't/group', { ...alice, groups: ['editors'] }))).toBe('ok 4')
    expect(await failure(call(connection, 't/group', owner))).toBe('ok 5')
    expect(runs).toBe(5)
  })

  test('a caller from another hub is not trusted', async () => {
    const connection = await start(s => s.post('t/key', () => 'ok', { auth: 'key' }))
    const context = { hub: { hubKey: vectors.keys.device.publicKey, caller: owner } }
    expect(await failure(connection.sender.send('t/key', null, { context }))).toBe('unauthorized|unauthorized')
  })

  test('request helpers check inside handlers', async () => {
    const connection = await start(s =>
      s.post('t/edit', (body: { author: string }, request) => {
        const caller = request.requireKey()
        if (caller.key !== body.author) request.requireGroup('moderators')
        return 'edited'
      }),
    )
    expect(await failure(call(connection, 't/edit', alice, { author: 'alice-key' }))).toBe('ok "edited"')
    expect(await failure(call(connection, 't/edit', alice, { author: 'bob-key' }))).toBe('permissions required|forbidden')
    expect(await failure(call(connection, 't/edit', { ...alice, groups: ['moderators'] }, { author: 'bob-key' }))).toBe('ok "edited"')
  })
})

describe('permissions', () => {
  test('a permission is asked from the hub; owners and anonymous callers are answered locally', async () => {
    const connection = await start(s =>
      s
        .post('posts/delete', () => 'deleted', { permission: 'posts/moderate' })
        .post('posts/can', async (_, request) => [await request.can('posts/moderate'), await request.can('posts/moderate')]),
    )
    expect(await failure(call(connection, 'posts/delete', alice))).toBe('permissions required|forbidden')
    hub.grants.set('alice-key', new Set(['posts/moderate']))
    expect(await failure(call(connection, 'posts/delete', alice))).toBe('ok "deleted"')
    expect(hub.grantChecks.at(-1)).toEqual({ path: 'posts/moderate', caller: { key: 'alice-key' } })
    const checks = hub.grantChecks.length
    expect(await failure(call(connection, 'posts/delete', owner))).toBe('ok "deleted"')
    expect(await failure(call(connection, 'posts/delete', undefined))).toBe('unauthorized|unauthorized')
    // Within one request the answer is kept
    expect(await call(connection, 'posts/can', alice)).toEqual([true, true])
    expect(hub.grantChecks.length).toBe(checks + 1)
  })

  test('grantCache keeps answers across requests', async () => {
    const connection = await start(s => s.post('posts/delete', () => 'deleted', { permission: 'posts/moderate' }), { grantCache: 60 })
    hub.grants.set('alice-key', new Set(['posts/moderate']))
    for (let i = 0; i < 3; i += 1) expect(await call(connection, 'posts/delete', { ...alice, device: onDevice.device })).toBe('deleted')
    expect(hub.grantChecks).toEqual([{ path: 'posts/moderate', caller: { key: 'alice-key', device: { id: 'dev1' } } }])
  })
})

describe('errors', () => {
  test('HubError reaches the caller with its code and info, also from a stream', async () => {
    const connection = await start(s =>
      s
        .post('t/missing', () => {
          throw HubError.notFound('post not found', { id: 'p1' })
        })
        .stream('t/broken', async function* () {
          yield 1
          throw new HubError('upstream failed', 502, { retry: true })
        }),
    )
    const error: any = await call(connection, 't/missing', alice).catch(error => error)
    expect([error.message, error.code, error.info]).toEqual(['post not found', 'not_found', { id: 'p1' }])
    const values: unknown[] = []
    const streamError: any = await (async () => {
      for await (const value of connection.sender.values('t/broken', null, { context: hub.context(alice) })) values.push(value)
    })().catch(error => error)
    expect(values).toEqual([1])
    expect([streamError.message, streamError.code, streamError.info]).toEqual(['upstream failed', 502, { retry: true }])
  })
})

describe('input validation', () => {
  test('a validator function or a parse schema gives the handler its input', async () => {
    const zodLike = {
      parse(body: unknown) {
        if (typeof (body as any)?.text !== 'string') {
          throw Object.assign(new Error('bad'), { issues: [{ path: ['text'], message: 'Expected string' }] })
        }
        return { text: (body as any).text.trim() }
      },
    }
    const connection = await start(s =>
      s
        .post('t/fn', (n: number) => n * 2, {
          input: body => {
            if (typeof body !== 'number') throw 'expected a number'
            return body
          },
        })
        .post('t/schema', (body: { text: string }) => body.text, { input: zodLike }),
    )
    expect(await call(connection, 't/fn', alice, 21)).toBe(42)
    expect(await failure(call(connection, 't/fn', alice, 'x'))).toBe('expected a number|invalid_input')
    expect(await call(connection, 't/schema', alice, { text: ' hi ' })).toBe('hi')
    const error: any = await call(connection, 't/schema', alice, {}).catch(error => error)
    expect([error.message, error.code, error.info]).toEqual(['invalid input', 'invalid_input', { issues: [{ path: ['text'], message: 'Expected string' }] }])
  })
})

describe('rate limits', () => {
  test('limits each caller on its own, with retryAfter', async () => {
    const connection = await start(s =>
      s
        .post('t/limited', () => 'ok', { rateLimit: { limit: 2, window: 60 } })
        .post('t/a', () => 'a')
        .post('t/b', () => 'b')
        .post('t/free', () => 'free', { rateLimit: false }),
      { rateLimit: { limit: 1, window: 60, bucket: 'shared' } },
    )
    expect(await call(connection, 't/limited', alice)).toBe('ok')
    expect(await call(connection, 't/limited', alice)).toBe('ok')
    const error: any = await call(connection, 't/limited', alice).catch(error => error)
    expect([error.message, error.code]).toEqual(['rate limited', 'rate_limited'])
    expect(error.info.retryAfter).toBeGreaterThan(55)
    expect(await call(connection, 't/limited', { key: 'bob-key' })).toBe('ok')
    // The service-wide limit puts t/a and t/b in one bucket
    expect(await call(connection, 't/a', alice)).toBe('a')
    expect(await failure(call(connection, 't/b', alice))).toBe('rate limited|rate_limited')
    expect(await call(connection, 't/free', alice)).toBe('free')
    expect(await call(connection, 't/free', alice)).toBe('free')
  })

  test('delegated users are limited by user', async () => {
    const connection = await start(s => s.post('t/limited', (_, request) => request.user?.id ?? null, { rateLimit: { limit: 1, window: 60 } }), {
      delegates: ['gateways'],
    })
    const gateway = { key: 'gateway-key', groups: ['gateways'] }
    expect(await call(connection, 't/limited', gateway, null, { user: 'u1' })).toBe('u1')
    expect(await call(connection, 't/limited', gateway, null, { user: 'u2' })).toBe('u2')
    expect(await failure(call(connection, 't/limited', gateway, null, { user: 'u1' }))).toBe('rate limited|rate_limited')
  })
})

describe('delegated users', () => {
  test('context.user is trusted from delegates and owners only', async () => {
    const connection = await start(s => s.post('posts/create', (_, request) => request.requireUser(), { auth: 'user' }), { delegates: ['gateways'] })
    const gateway = { key: 'gateway-key', groups: ['gateways'] }
    expect(await call(connection, 'posts/create', gateway, null, { user: 'u1' })).toEqual({ id: 'u1' })
    expect(await call(connection, 'posts/create', gateway, null, { user: { id: 'u2', name: 'Ann' } })).toEqual({ id: 'u2', name: 'Ann' })
    expect(await call(connection, 'posts/create', owner, null, { user: 'u3' })).toEqual({ id: 'u3' })
    expect(await failure(call(connection, 'posts/create', alice, null, { user: 'u1' }))).toBe('user required|unauthorized')
    expect(await failure(call(connection, 'posts/create', gateway))).toBe('user required|unauthorized')
    expect(await failure(call(connection, 'posts/create', gateway, null, { user: { name: 'no id' } }))).toBe('user required|unauthorized')
  })
})

describe('cancellation', () => {
  test('a cancelled post aborts its signal', async () => {
    let request!: ServiceRequest
    let aborted = false
    const connection = await start(s =>
      s.post('t/slow', (_, r) => {
        request = r
        r.signal.addEventListener('abort', () => (aborted = true))
        return new Promise(() => {})
      }),
    )
    const pending = connection.sender.request('t/slow', null, { context: hub.context(alice) })
    pending.response.catch(() => {})
    await waitFor(() => request !== undefined && service.runningCalls === 1)
    pending.cancel()
    await waitFor(() => aborted)
    expect(request.cancelled).toBeTrue()
  })

  test('a cancelled stream aborts its signal while the handler waits', async () => {
    let signal!: AbortSignal
    let cleanedUp = false
    const connection = await start(s =>
      s.stream('t/generate', async function* (_, request) {
        signal = request.signal
        try {
          yield 'token'
          // Waits for work that only the signal ends, like an upstream fetch
          await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)))
        } finally {
          cleanedUp = true
        }
      }),
    )
    for await (const value of connection.sender.values('t/generate', null, { context: hub.context(alice) })) {
      expect(value).toBe('token')
      break
    }
    await waitFor(() => signal?.aborted && cleanedUp)
    await waitFor(() => service.runningCalls === 0)
  })
})

describe('ready and shutdown', () => {
  test('a service that is not ready registers draining and refuses calls until ready', async () => {
    const connection = await start(s => s.post('t/a', () => 'a'), { ready: false })
    expect(connection.updates[0].draining).toBeTrue()
    expect(service.health).toMatchObject({ status: 'not_ready', ready: false, connected: true })
    expect(await failure(call(connection, 't/a', alice))).toBe('service unavailable|unavailable')
    await service.setReady(true)
    expect(connection.updates.at(-1)).toEqual({ draining: false })
    expect(await call(connection, 't/a', alice)).toBe('a')
    expect(service.health.status).toBe('ready')
  })

  test('shutdown drains, waits for posts, ends streams and stops', async () => {
    let release!: () => void
    const released = new Promise<void>(resolve => (release = resolve))
    const connection = await start(s =>
      s.post('t/work', async () => (await released, 'done')).stream('t/live', async function* (_, request) {
        while (!request.cancelled) {
          yield Date.now()
          await new Promise(resolve => setTimeout(resolve, 5))
        }
      }),
    )
    const work = call(connection, 't/work', alice)
    const live = (async () => {
      let count = 0
      for await (const _ of connection.sender.values('t/live', null, { context: hub.context(alice) })) count += 1
      return count
    })()
    await waitFor(() => service.runningCalls === 2)
    const shutdown = service.shutdown({ timeout: 2000 })
    await waitFor(() => connection.updates.some(update => update.draining === true))
    // The live stream ended for its caller; the post still runs
    expect(await live).toBeGreaterThan(0)
    expect(service.health.status).toBe('shutting_down')
    expect(await failure(call(connection, 't/work', alice))).toBe('service unavailable|unavailable')
    release()
    expect(await work).toBe('done')
    expect(await shutdown).toBeTrue()
    expect(service.health.status).toBe('stopped')
  })

  test('shutdown aborts calls still running at the timeout', async () => {
    let signal!: AbortSignal
    const connection = await start(s =>
      s.post('t/stuck', (_, request) => {
        signal = request.signal
        return new Promise(() => {})
      }),
    )
    call(connection, 't/stuck', alice).catch(() => {})
    await waitFor(() => service.runningCalls === 1)
    expect(await service.shutdown({ timeout: 50 })).toBeFalse()
    expect(signal.aborted).toBeTrue()
    expect(errorCode(signal.reason)).toBe('unavailable')
  })
})

describe('address', () => {
  test('a numeric HUB address is a port', () => {
    expect(new MultiplatformService({ sign }, { address: '1998' }).address).toBe(1998)
    expect(new MultiplatformService({ sign }, { address: 'wss://hub.example' }).address).toBe('wss://hub.example')
  })
})
