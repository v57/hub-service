import { afterEach, describe, expect, test } from 'bun:test'
import { KeyFile, authToken } from './keys'
import { MultiplatformService } from './service'
import { FakeHub, vectors, waitFor } from './testing/fake-hub'
import {
  App,
  WebTokens,
  badge,
  button,
  chart,
  column,
  divider,
  gauge,
  grid,
  image,
  link,
  markdown,
  section,
  series,
  sheet,
  stat,
  tab,
  table,
  tabs,
  text,
  vstack,
  webApp,
  widget,
  type AppInterface,
} from './app'

describe('element builders', () => {
  test('text stays a plain string without options', () => {
    expect(text('Hello')).toBe('Hello')
    expect(text('$title', { style: 'title', color: 'blue' })).toEqual({ type: 'text', value: '$title', style: 'title', color: 'blue' })
  })

  test('leave out unset fields', () => {
    expect(button('Go', { path: 'a/go' })).toEqual({ type: 'button', title: 'Go', action: { path: 'a/go' } })
    expect(badge('ok')).toEqual({ type: 'badge', value: 'ok' })
    expect(link('Docs', 'https://example.com')).toEqual({ type: 'link', title: 'Docs', url: 'https://example.com' })
    expect(image({ symbol: 'star' })).toEqual({ type: 'image', symbol: 'star' })
    expect(divider()).toEqual({ type: 'divider' })
    expect(markdown('**hi**')).toEqual({ type: 'markdown', value: '**hi**' })
  })

  test('button confirmation and style', () => {
    const element = button('Delete', { path: 'a/delete', body: 'id' }, { style: 'destructive', confirm: { title: 'Delete it?', destructive: true } })
    expect(element).toEqual({
      type: 'button',
      title: 'Delete',
      action: { path: 'a/delete', body: 'id' },
      style: 'destructive',
      confirm: { title: 'Delete it?', destructive: true },
    })
  })

  test('stat and gauge', () => {
    expect(stat('Users', '$users', { delta: '$usersDelta', deltaFormat: 'percent', sparkline: '$usersHistory' })).toEqual({
      type: 'stat',
      title: 'Users',
      value: '$users',
      delta: '$usersDelta',
      deltaFormat: 'percent',
      sparkline: '$usersHistory',
    })
    expect(gauge('$cpu', { max: 100, style: 'ring', thresholds: [{ value: 80, color: 'red' }] })).toEqual({
      type: 'gauge',
      value: '$cpu',
      max: 100,
      style: 'ring',
      thresholds: [{ value: 80, color: 'red' }],
    })
  })

  test('charts take one or several series', () => {
    expect(chart('pie', series('Share', [{ label: 'iOS', value: 3 }]))).toEqual({
      type: 'chart',
      kind: 'pie',
      series: [{ name: 'Share', data: [{ label: 'iOS', value: 3 }] }],
    })
    const line = chart('line', [series('In', '$in', { color: 'blue' }), series('Out', '$out')], { x: 'time', height: 180, legend: true })
    expect(line.series).toHaveLength(2)
    expect(line).toMatchObject({ x: 'time', height: 180, legend: true })
  })

  test('tables expand string columns', () => {
    expect(table('$rows', ['name', column('Status', 'status', { style: 'badge' })])).toEqual({
      type: 'table',
      data: '$rows',
      columns: [
        { title: 'name', key: 'name' },
        { title: 'Status', key: 'status', style: 'badge' },
      ],
    })
  })

  test('layouts', () => {
    expect(grid(['a', 'b'], { minWidth: 120 })).toEqual({ type: 'grid', content: ['a', 'b'], minWidth: 120 })
    expect(section('Users', ['a'])).toEqual({ type: 'section', title: 'Users', content: ['a'] })
    expect(section(undefined, ['a'], { style: 'plain' })).toEqual({ type: 'section', content: ['a'], style: 'plain' })
    expect(tabs([tab('Day', ['d'], { icon: 'sun.max' }), tab('Week', ['w'])], { selected: 'range' })).toEqual({
      type: 'tabs',
      tabs: [
        { title: 'Day', content: ['d'], icon: 'sun.max' },
        { title: 'Week', content: ['w'] },
      ],
      selected: 'range',
    })
    expect(sheet('Details', [vstack(['x'])], { icon: 'info.circle' })).toEqual({
      type: 'sheet',
      title: 'Details',
      icon: 'info.circle',
      content: [{ type: 'vstack', content: ['x'] }],
    })
  })
})

describe('widgets', () => {
  test('declare their sizes in the header and bodies in the app', () => {
    const app = new App({ type: 'app', name: 'Users', path: 'social/users' }, ['full']).widget({
      sizes: ['2x1', '1x1'],
      body: ['adaptive'],
      bodies: { '1x1': ['small'], '2x2': ['ignored, not a declared size'] },
    })
    expect(app.header.widget).toEqual({ sizes: ['2x1', '1x1'] })
    expect(app.widgetBody).toEqual({ body: ['adaptive'], '1x1': ['small'] })
  })

  test('default to every size', () => {
    const app = widget({ name: 'Users', path: 'social/users', icon: 'person.2' }, [stat('Users', '$users')])
    expect(app.header).toEqual({ type: 'app', name: 'Users', path: 'social/users', icon: 'person.2', widget: { sizes: ['1x1', '1x2', '2x1', '2x2'] } })
    expect(app.body).toEqual(app.widgetBody!.body!)
  })

  test('refuse unknown sizes only', () => {
    expect(() => new App({ type: 'app', name: 'A', path: 'a' }, []).widget({ sizes: ['3x3' as any] })).toThrow()
  })
})

describe('web apps', () => {
  test('declare the page and fall back to a link for older apps', () => {
    const app = webApp({ name: 'Admin', path: 'social/admin', url: 'http://{hubHost}:8080/', icon: 'globe', origins: ['https://cdn.example.com'] })
    expect(app.header).toEqual({
      type: 'app',
      name: 'Admin',
      path: 'social/admin',
      icon: 'globe',
      web: { url: 'http://{hubHost}:8080/', origins: ['https://cdn.example.com'], token: true },
    })
    expect(app.body[1]).toEqual({ type: 'link', title: 'Open Admin', url: 'http://localhost:8080/' })
  })

  test('name the share they are served from', () => {
    const app = webApp({ name: 'Admin', path: 'social/admin', url: 'http://{hubHost}:8080/', share: 'admin-web', token: false })
    expect(app.header.web).toEqual({ url: 'http://{hubHost}:8080/', share: 'admin-web' })
  })

  test('without tokens', () => {
    const app = webApp({ name: 'Docs', path: 'docs', url: 'https://example.com', token: false })
    expect(app.header.web).toEqual({ url: 'https://example.com' })
    expect(app.tokens).toBeUndefined()
  })
})

describe('page tokens', () => {
  const caller = { key: 'caller-key', device: { id: 'd1', name: 'Mac' }, owner: true }

  test('round trip', async () => {
    const tokens = new WebTokens('secret')
    const token = await tokens.issue('social/admin', { caller, hub: 'hub-key' })
    const payload = await tokens.verify(`Bearer ${token}`)
    expect(payload).toMatchObject({ v: 1, app: 'social/admin', hub: 'hub-key', caller: 'caller-key', device: caller.device, owner: true })
    expect(payload.exp - payload.iat).toBe(300)
  })

  test('reject other keys, changes and expiry', async () => {
    const tokens = new WebTokens('secret', 60)
    const token = await tokens.issue('a', { caller })
    await expect(new WebTokens('other').verify(token)).rejects.toThrow('signature')
    const [body, signature] = token.split('.')
    const forged = btoa(JSON.stringify({ ...JSON.parse(atob(body!.replaceAll('-', '+').replaceAll('_', '/'))), owner: false }))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/, '')
    await expect(tokens.verify(`${forged}.${signature}`)).rejects.toThrow('signature')
    await expect(tokens.verify(token, Date.now() + 61_000)).rejects.toThrow('expired')
    await expect(tokens.verify('nonsense')).rejects.toThrow('Malformed')
  })

  test('apps refuse tokens of other apps', async () => {
    const one = webApp({ name: 'One', path: 'one', url: 'https://one', secret: 's' })
    const two = webApp({ name: 'Two', path: 'two', url: 'https://two', secret: 's' })
    const token = await one.tokens!.issue('one', {})
    expect((await one.verifyToken(token)).app).toBe('one')
    await expect(two.verifyToken(token)).rejects.toThrow('another app')
  })
})

describe('publishing', () => {
  const serviceKey = new KeyFile(vectors.keys.service.keyFile)
  const sign = async (hubKey?: string) => authToken(serviceKey, Math.round(Date.now() / 1000) + 60, hubKey)
  let hub: FakeHub
  let service: MultiplatformService
  afterEach(() => {
    service?.sender?.stop()
    hub?.stop()
  })

  test('streams widget bodies and issues page tokens naming the caller', async () => {
    hub = new FakeHub()
    const port = hub.start()
    service = new MultiplatformService({ sign }, { address: port })
    const users = widget({ name: 'Users', path: 'test/users' }, [stat('Users', '$users')], { sizes: ['1x1'], data: { users: 3 } })
    const admin = webApp({ name: 'Admin', path: 'test/admin', url: 'https://example.com' })
    service.app(users).app(admin).start()
    await waitFor(() => hub.open.some(c => c.updates.length > 0))
    const connection = hub.open.find(c => c.updates.length > 0)!
    expect(connection.updates[0].apps).toEqual([users.header, admin.header])

    for await (const value of connection.sender.values('test/users')) {
      const app = value as AppInterface
      expect(app.widget).toEqual({ body: [{ type: 'stat', title: 'Users', value: '$users' }] })
      expect(app.data).toEqual({ users: 3 })
      break
    }

    const token: string = await connection.sender.send('test/admin/token', null, { context: vectors.caller.context })
    const payload = await admin.verifyToken(token)
    expect(payload.caller).toBe(vectors.caller.context.hub.caller.key)
    expect(payload.hub).toBe(hub.key.publicKey)
  })
})

describe('shared fixture', () => {
  test('testdata/apps/interface.json matches the builders (bun testdata/apps/make.ts)', async () => {
    const { appFixture } = await import('./testdata/apps/fixture')
    const file = await Bun.file(new URL('./testdata/apps/interface.json', import.meta.url)).json()
    expect(file).toEqual(JSON.parse(JSON.stringify(appFixture())))
  })
})
