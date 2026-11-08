# API descriptions: titles, descriptions and JSON schemas per path

A service can say what each of its paths does, the way an MCP server describes its tools: a description for people
and agents, and JSON schemas for the body it takes and what it answers. The hub keeps what the providers it routes to
said and lists it with `hub/api/list`, filtered by what the caller may call. An MCP bridge can map that list to MCP
tools without knowing the services.

Additive only: services that describe nothing, hubs that don't keep descriptions and clients that never ask (the Hub
1.0 App Store app) work as before. Describing a path changes nothing about how it's called; validation stays opt-in.

Wire contract: `Docs/Devices/protocol.md` section 15. The TypeScript SDK (this repo) is the reference; the Swift SDK
(`HubService`) follows it.

## Declaring

### TypeScript

Next to the handler, in the settings that already carry `permission`, `auth` and `limit`:

```ts
service.post('s3/read', path => presign(path), {
  ...access['s3/read'],
  title: 'Download link',
  description: 'A presigned URL that reads one file for the next hour.',
  inputSchema: { type: 'string', description: 'File path, like "photos/cat.jpg"' },
  outputSchema: { type: 'string', format: 'uri' },
  annotations: { readOnlyHint: true },
})
```

- `inputSchema`, `outputSchema`: JSON schemas (the subset below). For a stream, `outputSchema` describes each value.
- `title`, `description`: plain text; the description says what the path does, when to use it and what the caller
  needs (a permission, a format).
- `annotations`: MCP's hints, passed through as they are: `readOnlyHint`, `destructiveHint`, `idempotentHint`,
  `openWorldHint`.
- Publishing a schema doesn't validate anything. To validate with the same schema, use `input: jsonSchema(schema)`:
  it checks the body against the subset below, fails with `invalid_input` and the issues, and publishes the schema as
  `inputSchema` when none is given.

### Swift

```swift
service.post("notes/search", options: .init(description: "Notes whose text contains the query, newest first.")) {
  (query: SearchQuery) -> [Note] in ...
}
```

`HubService.Options` takes `title`, `description`, `inputSchema`, `outputSchema` and `annotations`. The typed `post`
and `stream` overloads derive the schemas from the Codable types when `inputSchema`/`outputSchema` aren't given:
`JSONSchema(for: T.self)` decodes `T` once with a decoder that records what it's asked for (keys, which ones are
optional, value types, nested containers). That covers synthesized `Decodable` structs, optionals, arrays, nested
types, `String`/`Int`/`Double`/`Bool`/`Date`/`URL`/`UUID` and `RawRepresentable & CaseIterable` enums (their cases
become `enum`). An output that is only `Encodable`, a type whose `init(from:)` rejects placeholder values, and
recursive types give no schema; pass one explicitly there (`JSONSchema` is a Codable struct with builders like
`.object([...], required:)`, `.string()`, `.array(of:)`). A `description` per property comes only from explicit
schemas.

### JSON Schema subset

What the SDKs build and the SDK validators check: `type` (a name or a list of `string`, `number`, `integer`,
`boolean`, `object`, `array`, `null`), `title`, `description`, `properties`, `required`, `additionalProperties`
(boolean or schema), `items`, `enum`, `const`, `anyOf`, `format` (not checked), `minimum`, `maximum`, `minLength`,
`maxLength`, `pattern`, `minItems`, `maxItems`, `default`, `examples`. Other keywords pass through the hub untouched
and validators ignore them. No `$ref`: write nested schemas inline.

## How the hub keeps and serves them

- `hub/service/update { services }` headers gain optional fields: `kind: 'post' | 'stream'`, `title`, `description`,
  `inputSchema`, `outputSchema`, `annotations`. A path served both ways (`s3/list`) sends one header per kind, as the
  TypeScript SDK already did. Old hubs ignore the fields.
- The hub keeps them per connection and per path and kind, replaced by the next `services` update and dropped with
  the connection. It checks shapes only: strings and a schema that is a JSON object, at most 128 characters of title,
  4096 of description and 64 KiB per schema; anything else is left out, never refused.
- Only providers the hub routes to count (approved for hosting, draining included), so a key waiting for approval
  can't rewrite how another service's path reads. With several providers, the earliest that described a kind wins.
- `hub/api/list` (post, and a stream that updates with `hub/api`), access public like `hub/api`, returns one entry per
  path and kind the caller may call, sorted by path:
  `{ path, kind?, title?, description?, inputSchema?, outputSchema?, annotations? }`. A path no provider described
  is `{ path }` (or `{ path, kind }` when its header said the kind); built-ins are `{ path, kind }` for now.
- Merged hubs pass paths without descriptions, so their paths list bare.

Other ports (C, C#, Dart, Go, Java, Kotlin, PHP, Python, Ruby, Rust, Zig, Elixir) don't send descriptions yet: their
paths list bare until they add the header fields above, which is all a port needs.

Clients: `service.apiList()` (TypeScript) and `HubClient.apiList()` / `values("hub/api/list")` with `[ApiDescription]`
(Swift). The Hub app shows a path's description and schemas in the Services page inspector.

## Mapping to MCP tools (a later bridge)

A bridge is a hub client with its own key (granted what it should expose) that serves MCP over stdio or HTTP:

- `tools/list` ← `hub/api/list`, skipping `hub/*` and `network/*` by default and paths without a description unless
  configured. `name` = path with `/` → `_` (`s3_read`), plus `_stream` for a stream when the path also has a post;
  `title`, `description` and `annotations` as they are.
- MCP wants objects: an `inputSchema` whose type isn't `object` is wrapped as `{ type: 'object', properties:
  { body: <schema> }, required: ['body'] }` and unwrapped on the call; a non-object `outputSchema` becomes
  `{ result: <schema> }` in `structuredContent`. A path with no input schema gets `{ type: 'object' }` and its
  arguments are sent as the body.
- `tools/call` → `post`, answering with text content plus `structuredContent` when there is an output schema. A
  stream is read for its first value (or until a configured count or timeout), or is exposed as an MCP resource
  that the client subscribes to.
- `notifications/tools/list_changed` when the `hub/api/list` stream sends a new list.
- Descriptions are text written by services: an agent reads them as data. Owners approve which keys host services,
  and the bridge's key sees only what it was granted.
