// The service features against a real hub-server in local mode (ports 2400-2499).
// HUB_SERVER_DIR points to a hub-server checkout (default ../../Core/hub-server); without one the tests are skipped.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Subprocess } from 'bun'
import { Service, HubError, errorCode, type BunServiceOptions } from './index'
import { KeyFile } from './keys'
import { waitFor } from './testing/fake-hub'

const hubServer = resolve(process.env.HUB_SERVER_DIR ?? join(import.meta.dir, '..', '..', 'Core', 'hub-server'), 'index.ts')
const available = existsSync(hubServer)
const port = 2400 + Math.floor(Math.random() * 100)

const failure = (promise: Promise<unknown>) =>
  promise.then(
    value => `ok ${JSON.stringify(value)}`,
    (error: any) => `${error?.message ?? error}|${errorCode(error) ?? ''}`,
  )

describe.skipIf(!available)('against hub-server', () => {
  const ownerKey = KeyFile.generate()
  let hub: Subprocess
  const services: Service[] = []
  const make = (key: KeyFile, options: BunServiceOptions = {}) => {
    const service = new Service({ address: port, key, device: false, ...options })
    services.push(service)
    return service
  }
  /** A started client with its own key, connected with a v1 token once it learned the hub key */
  const client = async (key = KeyFile.generate()) => {
    const service = make(key).start()
    await waitFor(() => service.connectedVersion === '1' && service.health.connected, 5000)
    return { service, key: key.publicKey }
  }
  let owner: Service
  let released!: () => void
  const release = new Promise<void>(resolve => (released = resolve))
  let streamSignal: AbortSignal | undefined

  beforeAll(async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'hub-service-integration-'))
    hub = Bun.spawn(['bun', hubServer, '--local', '--port', `${port}`, '--owner', ownerKey.publicKey], {
      cwd,
      env: { ...process.env, HUB_DEVICE_KEY: join(cwd, 'device.key') },
      stdout: 'ignore',
      stderr: 'ignore',
    })
    // The provider runs with the owner key, so its hosting needs no approval
    owner = make(ownerKey, { delegates: ['gateways'], name: 'social' })
      .post('social/posts/create', (body: { text: string }, request) => ({ author: request.requireUser().id, text: body.text }), {
        auth: 'user',
        input: body => {
          if (typeof (body as any)?.text !== 'string') throw 'text required'
          return body as { text: string }
        },
      })
      .post('social/posts/delete', () => 'deleted', { permission: 'social/posts/moderate' })
      .post('social/posts/like', () => 'liked', { auth: 'key', rateLimit: { limit: 2, window: 60 } })
      .post('social/slow', async () => (await release, 'slow done'))
      .stream('social/feed', async function* (_, request) {
        streamSignal = request.signal
        yield 'first'
        await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason)))
      })
      .stream('social/broken', async function* () {
        yield 1
        throw HubError.notFound('feed gone', { feed: 'x' })
      })
      .start()
    await waitFor(() => owner.connectedVersion === '1' && owner.health.connected, 10_000)
    // The owner's connection registered its paths
    const callable = async () => (await owner.send('hub/api')).includes('social/posts/create')
    for (let i = 0; i < 100 && !(await callable()); i += 1) await Bun.sleep(50)
  })
  afterAll(() => {
    services.forEach(service => service.stop())
    hub?.kill()
  })

  test('a gateway acts for an end user; others cannot', async () => {
    const gateway = await client()
    await owner.send('hub/group/create', 'gateways')
    await owner.send('hub/group/update/users', { group: 'gateways', add: [`key:${gateway.key}`] })
    const post = (from: Service, user?: string, body: any = { text: 'hi' }) =>
      failure(from.send('social/posts/create', body, { context: user ? { user } : {} }))
    expect(await post(gateway.service, 'u1')).toBe('ok {"author":"u1","text":"hi"}')
    expect(await post(gateway.service, 'u1', {})).toBe('text required|invalid_input')
    const stranger = await client()
    expect(await post(stranger.service, 'u1')).toBe('user required|unauthorized')
  })

  test('a permission is granted by an owner on the hub', async () => {
    const moderator = await client()
    expect(await failure(moderator.service.send('social/posts/delete'))).toBe('permissions required|forbidden')
    const grant = await owner.send('hub/grant/add', { subject: { key: moderator.key }, object: { path: 'social/posts/moderate' } })
    expect(await failure(moderator.service.send('social/posts/delete'))).toBe('ok "deleted"')
    await owner.send('hub/grant/remove', { id: grant.id })
    expect(await failure(moderator.service.send('social/posts/delete'))).toBe('permissions required|forbidden')
  })

  test('rate limits are per caller', async () => {
    const [a, b] = [await client(), await client()]
    expect(await a.service.send('social/posts/like')).toBe('liked')
    expect(await a.service.send('social/posts/like')).toBe('liked')
    const error: any = await a.service.send('social/posts/like').catch(error => error)
    expect([error.message, error.code, error.info.retryAfter > 0]).toEqual(['rate limited', 'rate_limited', true])
    expect(await b.service.send('social/posts/like')).toBe('liked')
  })

  test('errors keep their codes through the hub, also from a stream', async () => {
    const { service } = await client()
    expect(await failure(service.send('social/missing'))).toBe('api not found|not_found')
    const values: unknown[] = []
    const error: any = await (async () => {
      for await (const value of service.values('social/broken')) values.push(value)
    })().catch(error => error)
    expect(values).toEqual([1])
    expect([error.message, error.code, error.info]).toEqual(['feed gone', 'not_found', { feed: 'x' }])
  })

  test('a caller leaving a stream aborts the handler signal through the hub', async () => {
    const { service } = await client()
    for await (const value of service.values('social/feed')) {
      expect(value).toBe('first')
      break
    }
    await waitFor(() => streamSignal?.aborted === true)
  })

  test('shutdown hands new calls to another provider and finishes running ones', async () => {
    const second = make(ownerKey, { name: 'social 2' })
      .post('social/slow', () => 'second')
      .start()
    await waitFor(() => second.connectedVersion === '1' && second.health.connected, 5000)
    const { service } = await client()
    // The first provider gets the first call: wait until it runs there
    let running: Promise<unknown> | undefined
    for (let i = 0; i < 10 && owner.runningCalls === 0; i += 1) {
      const call = service.send('social/slow')
      await Bun.sleep(100)
      if (owner.runningCalls) running = call
    }
    expect(running).toBeDefined()
    const shutdown = owner.shutdown({ timeout: 5000 })
    await waitFor(() => owner.health.status === 'shutting_down')
    await Bun.sleep(100)
    for (let i = 0; i < 3; i += 1) expect(await service.send('social/slow')).toBe('second')
    released()
    expect(await running).toBe('slow done')
    expect(await shutdown).toBeTrue()
  })
})
