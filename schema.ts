import { HubError } from './errors'
import type { Validator } from './request'

export type JSONSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null'

/**
 * The JSON Schema subset services describe their paths with (docs/api-descriptions.md). Other keywords may be
 * present: the hub passes them through and `checkSchema` ignores them.
 */
export interface JSONSchema {
  type?: JSONSchemaType | JSONSchemaType[]
  title?: string
  description?: string
  properties?: Record<string, JSONSchema>
  required?: string[]
  additionalProperties?: boolean | JSONSchema
  items?: JSONSchema
  enum?: unknown[]
  const?: unknown
  anyOf?: JSONSchema[]
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
  default?: unknown
  examples?: unknown[]
  [keyword: string]: unknown
}

/** MCP's tool annotations, passed through as they are */
export interface ApiAnnotations {
  /** Changes nothing */
  readOnlyHint?: boolean
  /** May delete or overwrite (meaningful when not read-only) */
  destructiveHint?: boolean
  /** Calling again with the same body has no further effect */
  idempotentHint?: boolean
  /** Reaches beyond the hub (the internet, other systems) */
  openWorldHint?: boolean
}

/** What a service says about one of its paths, and what `hub/api/list` answers per path and kind */
export interface ApiDescription {
  path: string
  /** Absent when the provider didn't say */
  kind?: 'post' | 'stream'
  title?: string
  description?: string
  inputSchema?: JSONSchema
  /** For a stream, the schema of each value */
  outputSchema?: JSONSchema
  annotations?: ApiAnnotations
}

export interface SchemaIssue {
  /** JSON path of the value, `$` for the body itself */
  path: string
  message: string
}

const typeOf = (value: unknown): JSONSchemaType => {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value as JSONSchemaType
}

const matchesType = (value: unknown, type: JSONSchemaType) => {
  const actual = typeOf(value)
  return actual === type || (type === 'number' && actual === 'integer')
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Checks `value` against the subset; returns the issues found, none when it matches */
export function checkSchema(schema: JSONSchema | boolean, value: unknown, path = '$'): SchemaIssue[] {
  if (schema === true) return []
  if (schema === false) return [{ path, message: 'not allowed' }]
  const issues: SchemaIssue[] = []
  const fail = (message: string) => issues.push({ path, message })
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some(type => matchesType(value, type))) {
      fail(`expected ${types.join(' or ')}, got ${typeOf(value)}`)
      return issues
    }
  }
  if (schema.enum && !schema.enum.some(option => same(option, value))) fail(`expected one of ${JSON.stringify(schema.enum)}`)
  if ('const' in schema && !same(schema.const, value)) fail(`expected ${JSON.stringify(schema.const)}`)
  if (schema.anyOf && !schema.anyOf.some(option => checkSchema(option, value, path).length === 0)) fail('matches none of anyOf')
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) fail(`below ${schema.minimum}`)
    if (schema.maximum !== undefined && value > schema.maximum) fail(`above ${schema.maximum}`)
  }
  if (typeof value === 'string') {
    const length = [...value].length
    if (schema.minLength !== undefined && length < schema.minLength) fail(`shorter than ${schema.minLength}`)
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`longer than ${schema.maxLength}`)
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) fail(`doesn't match ${schema.pattern}`)
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`)
    if (schema.items) value.forEach((item, index) => issues.push(...checkSchema(schema.items!, item, `${path}[${index}]`)))
  }
  if (typeOf(value) === 'object') {
    const object = value as Record<string, unknown>
    for (const key of schema.required ?? []) if (object[key] === undefined) issues.push({ path: `${path}.${key}`, message: 'required' })
    for (const [key, item] of Object.entries(object)) {
      if (item === undefined) continue
      const property = schema.properties?.[key]
      if (property) issues.push(...checkSchema(property, item, `${path}.${key}`))
      else if (schema.additionalProperties !== undefined) issues.push(...checkSchema(schema.additionalProperties, item, `${path}.${key}`))
    }
  }
  return issues
}

/** A validator for `ApiSettings.input` that checks the body against `schema` and publishes it as `inputSchema` */
export interface SchemaValidator<T> extends Exclude<Validator<T>, Function> {
  readonly schema: JSONSchema
}

/**
 * `input: jsonSchema(schema)` checks the body against the subset and fails with `invalid_input` and the issues;
 * the path's `inputSchema` is `schema` unless the settings give another.
 */
export function jsonSchema<T = any>(schema: JSONSchema): SchemaValidator<T> {
  return {
    schema,
    parse(body: unknown): T {
      const issues = checkSchema(schema, body)
      if (issues.length) throw HubError.invalidInput(issues.map(issue => `${issue.path}: ${issue.message}`).join('; '), { issues })
      return body as T
    },
  }
}

/** The schema published for a validator made by `jsonSchema` */
export function validatorSchema(validator: unknown): JSONSchema | undefined {
  const schema = (validator as { schema?: unknown } | undefined)?.schema
  return schema && typeof schema === 'object' && !Array.isArray(schema) && typeof (validator as any).parse === 'function' ? (schema as JSONSchema) : undefined
}
