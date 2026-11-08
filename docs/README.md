# hub-service documentation

`hub-service` is the SDK for writing [Hub](https://github.com/v57/hub-server) services and clients. A service
connects to a Hub and publishes APIs by path (for example `hash/sha256`). Any connection can then call
those APIs through the Hub by name. When several services publish the same path, the Hub splits the
requests between them.

The same SDK exists in 14 languages. This repo (TypeScript, Bun) is the reference: every port speaks the
same wire contract and is checked against a live hub with [`tests/verify.ts`](../tests/verify.ts).

- [Quick start](#quick-start)
- [Concepts](#concepts): hub address, post and stream APIs, calling APIs, settings, API descriptions, profile, auth
- [Apps](#apps): UI that the Hub app renders for your service (builders in detail: [apps.md](apps.md))
- [Testing a service](#testing-a-service)
- [Wire contract](#wire-contract)
- [Languages](#languages)

Other pages: [Service features](service-features.md) (authorization, errors, limits, shutdown),
[API descriptions](api-descriptions.md) (design and the mapping to MCP tools), [Apps](apps.md) (the app SDK).
The Swift package has its own guide: [HubService](https://github.com/v57/HubService/blob/main/docs/HubService.md).

## Quick start

1. Start a hub on port `1997`. Local mode is the quickest for development: it listens on `127.0.0.1` only and
   allows every call.

   ```sh
   bunx v57/hub-server --local   # or the hub CLI: bunx v57/hub
   ```

2. Add the SDK and publish an API:

   ```sh
   bun add v57/hub-service
   ```

   ```ts
   import { Service } from 'hub-service'

   new Service()
     .post('hash/sha256', body => new Bun.SHA256().update(body).digest('hex'))
     .start()
   ```

3. Call it from anywhere connected to the same hub:

   ```ts
   import { Service } from 'hub-service'

   const service = new Service().start()
   const hash = await service.send('hash/sha256', 'Hello World')
   console.log(hash)
   ```

## Concepts

### Hub address

`new Service({ address })` takes a port number or a `ws://` / `wss://` URL. Without one it uses the `HUB`
environment variable, then `1997`.

### Post and stream APIs

Register APIs before `start()`: the list is sent to the hub when the connection opens.

```ts
new Service()
  // post: one request, one response. The handler may be async.
  .post('echo/upper', (body: string) => body.toUpperCase())
  // stream: one request, many values. Return an async iterator.
  .stream('count', async function* (to: number) {
    for (let i = 1; i <= to; i++) yield i
  })
  .start()
```

Handlers receive the decoded JSON body. Throwing in a handler sends an error back to the caller.

### Calling APIs

A started service is also a client:

```ts
const service = new Service().start()
const upper = await service.send('echo/upper', 'hello') // "HELLO"
for await (const n of service.values('count', 3)) console.log(n) // 1, 2, 3
```

Both throw `Service not started` before `start()`.

### Settings: permissions and concurrency

`post` and `stream` take an optional third argument:

```ts
const group = 'launcher'
service.post('launcher/update', update, { permissions: { group, name: 'Update apps' } })
service.post('llm/local', chat, { limit: 4 })
```

- `permissions`: `{ name, group?, allows? }`. Only connections given this permission can call
  the API (owners always can). `name` is the label shown for it, `allows: true` grants it by default, and
  `group` defaults to the first path segment of the first API that sets permissions.
- `limit`: how many requests this service handles at the same time.

A hub in local mode allows every call, so `permissions` has no effect there.

### Authorization, errors, limits and shutdown

Services that real users call need more than a path: who may call it (`auth`, `groups`, a hub-granted `permission`,
end users through a gateway), errors with codes, input validation, per-caller rate limits, cancellation, readiness
and graceful shutdown. [Service features](service-features.md) describes them in TypeScript and Swift, the hub APIs
behind them (`hub/grant/check`, `draining`) and what the other ports need to follow.

### API descriptions and schemas

Each path can say what it does, the way an MCP server describes its tools: a `title`, a `description`, an
`inputSchema` and an `outputSchema` (JSON schemas) and MCP's `annotations`. They go in the same settings as `auth`,
`permission` and `limit`. The service sends them with its paths in `hub/service/update`; the hub keeps them while the
service is connected and lists them with `hub/api/list`, filtered by what the caller may call. People read them in
the Hub app's Services page, and an MCP bridge can turn the list into MCP tools.
[API descriptions](api-descriptions.md) has the design, the hub's rules and the MCP mapping; the wire contract is
section 15 of the Hub protocol (`Docs/Devices/protocol.md` in the Hub workspace).

| Setting | What it says |
|---|---|
| `title` | A short name, plain text (the hub keeps up to 128 characters) |
| `description` | What the path does, when to use it and what the caller needs (a permission, a format); plain text, up to 4096 characters |
| `inputSchema` | JSON schema of the body. Published only: nothing is checked |
| `outputSchema` | JSON schema of the answer; for a stream, of each value |
| `annotations` | MCP's hints, passed through: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` |
| `input: jsonSchema(schema)` | Validates the body against `schema` and publishes it as `inputSchema` (unless `inputSchema` is also given, which wins) |

A worked example, a post and a stream of a notes service:

```ts
import { Service, jsonSchema, type JSONSchema } from 'hub-service'

interface Note { id: string; text: string; updatedAt: number }
const notes: Note[] = []
const waiting = new Set<() => void>()
const changed = () => { for (const wake of waiting) wake(); waiting.clear() }

// Typed as JSONSchema, so `type: 'object'` checks without `as const`
const note: JSONSchema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'Note id' },
    text: { type: 'string' },
    updatedAt: { type: 'integer', description: 'Last change, Unix milliseconds' },
  },
  required: ['id', 'text', 'updatedAt'],
}
const search: JSONSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', minLength: 1, description: 'Text to look for' },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  },
  required: ['query'],
  additionalProperties: false,
}

new Service({ name: 'Notes' })
  .post('notes/search', ({ query, limit = 20 }: { query: string; limit?: number }) =>
    notes.filter(note => note.text.includes(query)).slice(0, limit), {
    title: 'Search notes',
    description: 'Notes whose text contains the query, at most `limit` of them. Fails with invalid_input for an empty query.',
    input: jsonSchema(search), // checks the body, and publishes `search` as inputSchema
    outputSchema: { type: 'array', items: note },
    annotations: { readOnlyHint: true },
  })
  .stream('notes/changes', async function* () {
    while (true) {
      yield notes
      await new Promise<void>(resolve => waiting.add(resolve))
    }
  }, {
    title: 'Watch notes',
    description: 'Every note now, then again after each change. Never ends on its own.',
    outputSchema: { type: 'array', items: note }, // each value of the stream
    annotations: { readOnlyHint: true },
  })
  .start()
```

A body that doesn't match fails with the code `invalid_input` before the handler runs, with the message
`$.query: shorter than 1` and the issues in `info.issues` (`[{ path, message }]`). `checkSchema(schema, value)`
returns the same issues without throwing. The validators check the subset listed in
[API descriptions](api-descriptions.md#json-schema-subset) (`type`, `properties`, `required`, `additionalProperties`,
`items`, `enum`, `const`, `anyOf`, the min/max keywords and `pattern`); other keywords are published and ignored. Write
nested schemas inline, there is no `$ref`.

Any connection reads the descriptions back with `apiList()`, one entry per path and kind, sorted by path:

```ts
import { Service } from 'hub-service'

const client = new Service().start()
for (const api of await client.apiList()) {
  if (api.path.startsWith('notes/')) console.log(api.kind, api.path, '-', api.title, api.annotations)
}
// stream notes/changes - Watch notes { readOnlyHint: true }
// post notes/search - Search notes { readOnlyHint: true }
```

Each entry is an `ApiDescription`: `{ path, kind?, title?, description?, inputSchema?, outputSchema?, annotations? }`.
A path whose service described nothing lists as `{ path }` (or `{ path, kind }` when the service said the kind, as
this SDK always does), and the hub's own `hub/*` paths as `{ path, kind }`. A `default` in a schema is documentation:
the validator doesn't fill it in, so the handler above sets `limit = 20` itself.
`client.values('hub/api/list')` is the same list as a stream that sends it again when the hub's APIs change. A hub
from before descriptions has no `hub/api/list` and fails the call with `api not found`; older hubs also ignore the new
fields, so describing paths is safe everywhere.

For a service with many paths, keep the descriptions in one file beside the handlers and spread them into the
settings, as Hub's own services do:

```ts
// descriptions.ts
import type { ApiSettings } from 'hub-service'
import { note, search } from './schemas' // the JSONSchema constants above

export const descriptions: { post: Record<string, ApiSettings>; stream: Record<string, ApiSettings> } = {
  post: {
    'notes/search': { title: 'Search notes', description: '...', inputSchema: search, annotations: { readOnlyHint: true } },
  },
  stream: {
    'notes/changes': { title: 'Watch notes', description: '...', outputSchema: { type: 'array', items: note } },
  },
}

// api.ts
service.post('notes/search', searchNotes, { ...descriptions.post['notes/search'], permission: 'notes/read' })
```

A test that every registered path has a description, and that each description is a sentence, keeps them complete.
`ApiSettings` and `JSONSchema` are the types to declare them with; a plain object literal widens `type: 'object'` to
`string`, which `JSONSchema` doesn't accept.

### Profile

`name` and `icon` tell the Hub app how to show your service:

```ts
new Service({ name: 'Hasher', icon: { symbol: 'number', text: '#' } })
```

`icon.symbol` is an SF Symbol name and `icon.text` is a short text fallback. Each one can also be an
object: `{ name, color: { foreground, background, foregroundDark, backgroundDark } }`.

### Auth

Every service has an Ed25519 key. On the first run the SDK creates it in a file named `auth` in the working
directory and reuses it after that. Keep that file private: it is the service's identity.

An owner has to allow a service's key before it can host APIs. The Hub app shows new keys
under Security. To look up a service's public key:

```ts
import { publicKey } from 'hub-service'
console.log(await publicKey())
```

In the browser, import from `hub-service/web` instead: it keeps the key in `localStorage` (when available)
rather than a file.

## Apps

A service can ship a small UI that the Hub app renders. You describe it with elements and bind them to a
`data` dictionary. Buttons and fields call your APIs and write the responses back into `data`. This section is the
overview; [Apps](apps.md) has every builder of `hub-service/app` with its arguments, live updates, top and bottom
bars, cells and lists, and the file elements.

```ts
import { Service } from 'hub-service'
import { App, button, cell, textField } from 'hub-service/app'

const hash = { path: 'hasher/all', body: 'value', output: { sha256: 'sha256' } }

const app = new App(
  { type: 'app', name: 'Hasher', path: 'hasher/ui' },
  [
    textField('value', { placeholder: 'Text to hash', action: hash }),
    cell('SHA 256', '$sha256'),
    button('Hash', hash),
  ],
  { value: '', sha256: '' },
)

new Service({ name: 'Hasher', icon: { symbol: 'number', text: '#' } })
  .post('hasher/all', (value: string) => ({ sha256: new Bun.SHA256().update(value).digest('hex') }))
  .app(app)
  .start()
```

`.app(app)` adds the app to the hub's app list and serves it as a stream at `header.path`.

### Binding rules

- **Display text** (a plain string element, `text`, titles): a string is shown as is, unless it starts
  with `$`. Then the rest is a key in `data`: `'$sha256'` shows `data.sha256`.
- **`value`** on `textField`, `slider`, `progress` and `files` names the `data` key the element reads and
  writes.
- **Actions** `{ path, body?, output? }` call the API at `path`:
  - `body: 'value'` sends `data.value` as the request body. `body: { text: 'value' }` sends
    `{ text: data.value }`.
  - `output: 'result'` stores the whole response in `data.result`. `output: { sha256: 'hash' }` renames
    response fields before merging them into `data`. Without `output`, an object response is merged into
    `data` as is.

### Elements

| Helper | Element |
|---|---|
| `text(value)` or a plain string | Text. `text(value, { style, color, secondary })` styles it |
| `markdown(value)` | Inline Markdown: bold, italic, code, links |
| `image({ url } \| { symbol }, { width, height, mode, cornerRadius, color })` | Remote image or SF Symbol |
| `badge(value, { color })` | Small colored label; `up`, `down`, `pending` and other status words pick a color |
| `link(title, url, { icon })` | Opens a web page in the browser |
| `divider()` | Line |
| `textField(value, { placeholder, action })` | Text field. `action` runs when the text changes |
| `button(title, action, { icon, style, confirm })` | Button. `confirm: { title, message, button, destructive }` asks first |
| `sheet(title, content, { icon })` | Button that opens `content` in a sheet |
| `slider(value, { defaultValue, min, max, step, action })` | Slider |
| `progress(value, { min, max })` | Small progress ring |
| `picker(options, selected)` | Picker |
| `stat(title, value, { unit, delta, deltaFormat, positive, sparkline, icon, color })` | Dashboard number with its change and a sparkline |
| `gauge(value, { min, max, title, label, style, color, thresholds })` | Ring, semicircle or bar gauge |
| `chart(kind, series, { title, x, height, stacked, legend, yMin, yMax, unit })` | `line`, `bar`, `area`, `pie` or `donut` chart of one or more `series(name, data, { color })` |
| `table(data, columns)` | Rows from a `data` array, columns from `column(title, key, { align, style })` or key names |
| `cell(title, subtitle)` | List row with a title and subtitle |
| `list(data, content)` | Repeats `content` for each item of the `data` array; the item's keys come first in bindings |
| `grid(content, { columns, minWidth, spacing })` | Fixed or adaptive columns |
| `section(title, content, { subtitle, style })` | Titled group on a card |
| `tabs([tab(title, content, { icon })], { selected, style })` | Segmented pages |
| `files(value, title, action)` | File list |
| `fileOperation(format, title, action)` | File operation (`format` sets the output file extension) |
| `hstack(content, { spacing })`, `vstack(...)`, `zstack(content)`, `spacer()` | Layout |

Pass `{ top, bottom }` as the fifth `App` argument to pin elements above or below the body. To push changes
to an open app, pass a `LazyState` from `channel/more` as the fourth argument; every value it emits is sent
to the app. `app.actions(action({ path, body, output, execute }))` registers an API together with its
action.

Chart data is a `$key` of an array or the array itself. A point is a number (x is its index), `[x, y]`,
`{ x, y }` or `{ label, value }`; with `x: 'time'`, x is Unix milliseconds or an ISO date. Send fresh arrays
from the `LazyState` and charts, stats and gauges animate to them.

### Widgets

An app can also be a Home widget. It declares the sizes it supports (width x height, in Home tiles: `1x1`,
`1x2`, `2x1`, `2x2`); the user picks one per widget, and tapping the widget opens the app.

```ts
import { App, chart, series, stat, widget } from 'hub-service/app'

// A widget whose full page is its own body
const users = widget({ name: 'Active Users', path: 'social/users', icon: 'person.2' }, [stat('Active', '$active')], {
  sizes: ['1x1', '2x1'],
  bodies: { '2x1': [stat('Active', '$active'), chart('line', series('Active', '$history'))] },
  data: { active: 1200, history: [1100, 1180, 1200] },
})
// Or any app with a widget
const app = new App({ type: 'app', name: 'Sales', path: 'sales/ui' }, body).widget({ sizes: ['2x2'], body: [stat('Today', '$today')] })
```

### Web apps

`webApp({ name, path, url, icon, origins, share, token, secret, lifetime })` publishes a web page instead of
elements. The Hub app opens it in a web view and keeps it on `url`'s origin and `origins`; other links ask
the user and open in the browser. `{hubHost}` in `url` becomes the host the Hub app uses for the hub, for
pages served next to it.

`share` names the network share the page is served from. Declare it with `service.share(name, 'tcp', host, port,
policy)` on the hub's machine: the hub's link to that machine then opens the port for the devices the policy lets
in, so a device away from the hub's network loads the page over the Hub Network. The server must listen on the
machine's addresses (`0.0.0.0`), not only on loopback.

The page gets `window.hub`: `hub.token()` returns a short-lived token from `<path>/token` that names the hub
and the caller, signed by the service, and `hub.send(path, body)` calls APIs under `<path>/` as the user.
The page sends the token to its own server, which checks it with `app.verifyToken(token)`.

```ts
const admin = webApp({ name: 'Admin', path: 'social/admin', url: 'http://{hubHost}:8090/', share: 'admin' })
service.share('admin', 'tcp', '127.0.0.1', 8090, { mode: 'hub' })
Bun.serve({
  port: 8090,
  async fetch(request) {
    const token = await admin.verifyToken(request.headers.get('authorization') ?? '') // throws when invalid
    return Response.json({ caller: token.caller, owner: token.owner })
  },
})
service.app(admin)
```

The full protocol, for other SDKs and clients, is in the Hub docs (`Docs/Apps/ui.md`); every element is in
the shared fixture `testdata/apps/interface.json`.

## Testing a service

`bun test` runs this repo's tests; a hub isn't needed. `hub-server.integration.test.ts` also runs the SDK against a
real hub-server when a checkout is next to it (`HUB_SERVER_DIR` points elsewhere) and is skipped without one.

A service's own tests can use the fake hub the SDK's tests use, `hub-service/testing/fake-hub`. `FakeHub` listens on a
free port, answers `hub/info` with a proof like hub-server, checks the service's token and records what it sends;
`hub.context(caller)` builds the context the hub would forward for a caller. Write the service as a function that adds
paths to a `MultiplatformService`, so the test needs no key file and no device key:

```ts
import { afterEach, expect, test } from 'bun:test'
import { KeyFile, authToken } from 'hub-service/keys'
import { MultiplatformService } from 'hub-service/service'
import { FakeHub, vectors, waitFor } from 'hub-service/testing/fake-hub'
import { serveNotes } from './api' // (service: MultiplatformService) => void, adds notes/search

const key = new KeyFile(vectors.keys.service.keyFile)
const sign = async (hubKey: string, nonce: string) => authToken(key, Math.round(Date.now() / 1000) + 30, hubKey, nonce)

let hub: FakeHub
let service: MultiplatformService
afterEach(() => {
  service?.stop()
  hub?.stop()
})

test('notes/search', async () => {
  hub = new FakeHub()
  service = new MultiplatformService({ sign }, { address: hub.start() })
  serveNotes(service)
  service.start()
  await waitFor(() => hub.open.some(c => c.updates.length > 0))
  const connection = hub.open.find(c => c.updates.length > 0)!
  const context = hub.context({ key: 'caller-key', owner: true })
  expect(await connection.sender.send('notes/search', { query: 'milk' }, { context })).toEqual([])
  expect(connection.updates[0].services.map((s: any) => s.path)).toContain('notes/search')
})
```

`FakeHub` options: `noProof` answers like a hub from before auth v2, `claimKey` claims a key it can't prove, `refuse`
refuses connections; `grants` answers `hub/grant/check`. The Bun `Service` creates a device key in `~/.hub` unless
`HUB_DEVICE_KEY` points elsewhere or `device: false` is set, so tests that use it should set one of them (this repo's
`bunfig.toml` preloads `testing/setup.ts`, which does).

## Wire contract

Any client that speaks [Channel](https://github.com/v57/channel) can act as a service:

1. Open a WebSocket to the hub without headers and call `hub/info` with `{ nonce }` (32 random bytes, base64url). Check
   `proof`: the Ed25519 signature by `key` over `hubinfo1:<key>:<nonce>`. Pin `key`, or stop if a pinned key differs.
   Then open a second WebSocket with the headers `auth: key.<publicKey>.<signature>.<expiry>.<challenge>` and `v: 1`.
   `challenge` comes from the same answer and works once, `expiry` is a Unix time in seconds (at most 60 s ahead; the SDK
   uses now + 30 s), `signature` is the Ed25519 signature of `hub1:<key>:<challenge>:<expiry>`, and all keys are base64.
2. Send `hub/profile/update` with `{ name, icon }` (only when either is set).
3. Send `hub/service/update` with `{ services: [{ path, permissions, limit, kind?, title?, description?, inputSchema?,
   outputSchema?, annotations? }], apps: [{ type, name, path, icon?, widget?, web? }] }` (one header per path and kind;
   the description fields are optional, `Docs/Devices/protocol.md` section 15).
4. Answer the post and stream requests for those paths.

The hub forgets a connection's services when it disconnects, so steps 1 to 3 run again on every
reconnect.

## Languages

All ports share the API above (`post`, `stream`, `app`, `send`, `values`, `start`) and the element helpers.
Each one is built on the Channel port for its language and is checked against a live hub with this repo's
`tests/verify.ts`. Each port's README has its full API.

| Language | Library | Auth |
|---|---|---|
| TypeScript | [hub-service](https://github.com/v57/hub-service) (reference) | yes |
| Swift | [HubService](https://github.com/v57/HubService) (used by the Hub app, includes SwiftUI views) | yes (Keychain) |
| C | [hub-service-c](https://github.com/v57/hub-service-c) | yes |
| C# | [hub-service-cs](https://github.com/v57/hub-service-cs) | yes |
| Dart | [hub-service-dart](https://github.com/v57/hub-service-dart) | yes |
| Elixir | [hub_service_ex](https://github.com/v57/hub_service_ex) | yes |
| Go | [hub-service-go](https://github.com/v57/hub-service-go) | yes |
| Java | [hub-service-java](https://github.com/v57/hub-service-java) | yes |
| Kotlin | [hub-service-kotlin](https://github.com/v57/hub-service-kotlin) | yes |
| PHP | [hub-service-php](https://github.com/v57/hub-service-php) | yes |
| Python | [hub-service-py](https://github.com/v57/hub-service-py) | yes |
| Ruby | [hub-service-rb](https://github.com/v57/hub-service-rb) | yes |
| Rust | [hub-service-rs](https://github.com/v57/hub-service-rs) | yes |
| Zig | [hub-service-zig](https://github.com/v57/hub-service-zig) | yes |

The ports keep the key in an `auth` file in the working directory, like the TypeScript SDK, and can be
pointed at another file (`setKeyPath` or similar). All except Python and PHP also read the path from `$HUBKEY`.
Swift stores the key in the Keychain.

The same echo service in each language:

<details><summary>Swift</summary>

```swift
import HubService

let client = HubClient(URL(string: "ws://127.0.0.1:1997")!, keyChain: .keychain("com.example.YourApp"))
client.service.post("echo/upper") { (value: String) in
  value.uppercased()
}
print(try await client.send("echo/upper", "hello") as String)
```
</details>

<details><summary>C</summary>

```c
#include <string.h>
#include <unistd.h>
#include "hub-service-c/hub_service_c.h"

static int echo_handler(const channel_c_post_request_t *request, char **out_body_json, char **out_error) {
  (void)out_error;
  *out_body_json = channel_c_strdup(request->body_json ? request->body_json : "null");
  return *out_body_json ? 0 : -1;
}

int main(void) {
  hub_service_options_t options;
  char *error = NULL;
  memset(&options, 0, sizeof(options));
  options.name = "Echo";
  hub_service_t *service = hub_service_new(&options, &error);
  hub_service_post(service, "echo", echo_handler, NULL);
  if (hub_service_start(service, &error) != 0) return 1;
  for (;;) {
    hub_service_poll(service);
    usleep(1000);
  }
}
```
</details>

<details><summary>C#</summary>

```csharp
using HubServiceCs;

var service = new Service(new ServiceOptions { Name = "Echo" });
service
    .Post("echo", body => body)
    .Post("echo/upper", body => body?.ToString()?.ToUpperInvariant())
    .Start();
await Task.Delay(Timeout.Infinite);
```
</details>

<details><summary>Dart</summary>

```dart
import 'dart:async';
import 'package:hub_service/hub_service.dart';

Future<void> main() async {
  Service(name: 'Echo')
    ..post('echo', (body) => body)
    ..post('echo/upper', (body) => '$body'.toUpperCase())
    ..start();
  await Completer<void>().future;
}
```
</details>

<details><summary>Elixir</summary>

```elixir
alias HubServiceEx, as: Service

Service.new(name: "Echo")
|> Service.post("echo", fn body -> body end)
|> Service.post("echo/upper", fn body -> String.upcase(body) end)
|> Service.start()
```
</details>

<details><summary>Go</summary>

```go
package main

import (
  "fmt"
  "strings"

  "github.com/v57/hub-service-go"
)

func main() {
  service := hubservice.New(hubservice.ServiceOptions{Name: "Echo"})
  service.Post("echo", func(body any) (any, error) { return body, nil })
  service.Post("echo/upper", func(body any) (any, error) {
    return strings.ToUpper(fmt.Sprint(body)), nil
  })
  service.Start()
  select {}
}
```
</details>

<details><summary>Java</summary>

```java
import java.util.Map;
import v57.hubservice.Service;
import v57.hubservice.ServiceOptions;

var service = new Service(new ServiceOptions("Echo", Map.of("text", "E")));
service.post("echo", body -> body);
service.post("echo/upper", body -> String.valueOf(body).toUpperCase());
service.start(); // keep the JVM alive afterwards
```
</details>

<details><summary>Kotlin</summary>

```kotlin
import v57.hubservice.Service
import java.util.concurrent.CountDownLatch

fun main() {
  Service(name = "Echo")
    .post("echo") { body -> body }
    .post("echo/upper") { body -> body.toString().uppercase() }
    .start()
  CountDownLatch(1).await()
}
```
</details>

<details><summary>PHP</summary>

```php
<?php
require 'vendor/autoload.php';

use HubServicePhp\Service;
use OpenSwoole\Coroutine;

Coroutine::run(static function (): void {
    (new Service(['name' => 'Echo']))
        ->post('echo', static fn (mixed $body): mixed => $body)
        ->post('echo/upper', static fn (mixed $body): string => strtoupper((string) $body))
        ->start();
});
```
</details>

<details><summary>Python</summary>

```python
import asyncio
from hub_service_py import Service

async def main():
    service = Service({"name": "Echo"})
    service.post("echo", lambda body: body)
    service.post("echo/upper", lambda body: str(body).upper())
    service.start()
    await asyncio.Event().wait()

asyncio.run(main())
```
</details>

<details><summary>Ruby</summary>

```ruby
require 'hub_service_rb'

service = HubServiceRB::Service.new(name: 'Echo')
service.post('echo') { |body| body }
service.post('echo/upper') { |body| body.to_s.upcase }
service.start
sleep
```
</details>

<details><summary>Rust</summary>

```rust
use hub_service_rs::{Service, ServiceOptions};
use serde_json::json;

#[tokio::main]
async fn main() {
    let mut service = Service::new(ServiceOptions {
        name: Some("Echo".into()),
        ..Default::default()
    });
    service
        .post("echo", |body| Ok(body))
        .post("echo/upper", |body| Ok(json!(body.as_str().unwrap_or_default().to_uppercase())))
        .start();
    tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
}
```
</details>

<details><summary>Zig</summary>

```zig
const std = @import("std");
const hub_service = @import("hub_service");
const Service = hub_service.Service;
const Value = std.json.Value;

fn echoHandler(request: hub_service.PostRequest(?*Service, Value, void)) !?Value {
    return request.body;
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    var svc = try Service.init(gpa.allocator(), .{ .name = "Echo" });
    _ = try svc.post("echo", echoHandler, null);
    _ = try svc.start();
    while (true) std.Thread.sleep(1_000_000_000);
}
```
</details>

To check a port against the reference, start a hub and the port's echo example, then run:

```sh
bun tests/verify.ts echo echo/upper '"hello"' '"HELLO"'
```
