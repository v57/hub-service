import { afterEach, describe, expect, test } from 'bun:test'
import { KeyFile, authToken } from './keys'
import { MultiplatformService } from './service'
import { errorCode } from './errors'
import { checkSchema, jsonSchema, type JSONSchema } from './schema'
import { FakeHub, vectors, waitFor } from './testing/fake-hub'

const serviceKey = new KeyFile(vectors.keys.service.keyFile)
const sign = async (hubKey: string, nonce: string) => authToken(serviceKey, Math.round(Date.now() / 1000) + 30, hubKey, nonce)

let hub: FakeHub
let service: MultiplatformService
afterEach(() => {
  service?.stop()
  hub?.stop()
})

async function headers(setup: (service: MultiplatformService) => void) {
  hub = new FakeHub()
  service = new MultiplatformService({ sign }, { address: hub.start() })
  setup(service)
  service.start()
  await waitFor(() => hub.open.some(c => c.version === '1' && c.updates.length > 0))
  const connection = hub.open.find(c => c.version === '1' && c.updates.length > 0)!
  return { connection, services: connection.updates[0].services as any[] }
}

const pathSchema: JSONSchema = { type: 'string', minLength: 1, description: 'File path' }

describe('API descriptions', () => {
  test('headers carry kind and what the settings describe, one per path and kind', async () => {
    const { services } = await headers(s =>
      s
        .post('files/read', () => 'url', {
          title: 'Download link',
          description: 'A presigned URL for one file.',
          inputSchema: pathSchema,
          outputSchema: { type: 'string', format: 'uri' },
          annotations: { readOnlyHint: true },
          limit: 4,
        })
        .post('files/list', () => [], { description: 'Files under a prefix, once.' })
        .stream('files/list', async function* () {}, { description: 'Files under a prefix, then on every change.', outputSchema: { type: 'array' } })
        .post('files/bare', () => 1),
    )
    const header = (path: string, kind: string) => services.find(h => h.path === path && h.kind === kind)
    expect(header('files/read', 'post')).toEqual({
      path: 'files/read',
      limit: 4,
      kind: 'post',
      title: 'Download link',
      description: 'A presigned URL for one file.',
      inputSchema: pathSchema,
      outputSchema: { type: 'string', format: 'uri' },
      annotations: { readOnlyHint: true },
    })
    expect(header('files/list', 'post').description).toBe('Files under a prefix, once.')
    expect(header('files/list', 'stream')).toMatchObject({ description: 'Files under a prefix, then on every change.', outputSchema: { type: 'array' } })
    expect(header('files/bare', 'post')).toEqual({ path: 'files/bare', kind: 'post' })
    expect(services.length).toBe(4)
  })

  test('input: jsonSchema(...) validates the body and publishes the schema', async () => {
    let runs = 0
    const { connection, services } = await headers(s =>
      s.post('files/size', (path: string) => (runs++, path.length), { input: jsonSchema(pathSchema), description: 'Size of a file' }),
    )
    expect(services.find(h => h.path === 'files/size').inputSchema).toEqual(pathSchema)
    expect(await connection.sender.send('files/size', 'a.txt')).toBe(5)
    const error = await connection.sender.send('files/size', 42).catch(e => e)
    expect(errorCode(error)).toBe('invalid_input')
    expect(String(error?.message ?? error)).toContain('expected string')
    expect(runs).toBe(1)
  })

  test('an inputSchema given next to a jsonSchema validator wins', async () => {
    const published: JSONSchema = { type: 'string', description: 'shown' }
    const { services } = await headers(s => s.post('t/x', () => 1, { input: jsonSchema(pathSchema), inputSchema: published }))
    expect(services[0].inputSchema).toEqual(published)
  })
})

describe('checkSchema', () => {
  const user: JSONSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', maxLength: 5 },
      age: { type: 'integer', minimum: 0 },
      role: { enum: ['admin', 'member'] },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
      note: { type: ['string', 'null'] },
    },
    required: ['name'],
    additionalProperties: false,
  }
  test('matching values have no issues', () => {
    expect(checkSchema(user, { name: 'Ann', age: 3, role: 'admin', tags: ['a'], note: null })).toEqual([])
    expect(checkSchema({ type: 'number' }, 3)).toEqual([])
    expect(checkSchema({}, { anything: true })).toEqual([])
    expect(checkSchema({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 2)).toEqual([])
    expect(checkSchema({ const: 'x' }, 'x')).toEqual([])
  })
  test('issues name the place', () => {
    const issues = checkSchema(user, { age: 1.5, role: 'owner', tags: ['a', 2, 'c'], extra: 1, note: 2 })
    expect(issues.map(i => i.path).sort()).toEqual(['$.age', '$.extra', '$.name', '$.note', '$.role', '$.tags', '$.tags[1]'].sort())
    expect(checkSchema({ type: 'string', pattern: '^a' }, 'b')[0].message).toContain('match')
    expect(checkSchema({ type: 'integer' }, 1.5)[0].message).toBe('expected integer, got number')
    expect(checkSchema({ anyOf: [{ type: 'string' }] }, 2)[0].message).toBe('matches none of anyOf')
  })
})
