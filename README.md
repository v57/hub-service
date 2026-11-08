# hub-service

Hub service runtime for Bun and web targets. It provides a small RPC layer over `channel`, Ed25519-based request signing, and an optional app payload format.

Full documentation, including apps and the other 13 languages: [docs](docs/README.md).

## Install

```sh
bun add v57/hub-service
```

## Entry Points

| Entry point | Purpose | Runtime | Import |
|---|---|---|---|
| [`hub-service`](docs/README.md) | `Service` for servers: post and stream APIs, calling other services, auth v2 with the key in an `auth` file, device certificates, Hub Network shares, [API descriptions](docs/README.md#api-descriptions-and-schemas) (`jsonSchema`, `checkSchema`, `apiList()`), `HubError` | Bun | `import { Service } from 'hub-service'` |
| [`hub-service/web`](docs/README.md#auth) | The same `Service` for browsers: Web Crypto, the key in `localStorage` (memory when unavailable); no device certificates or network shares, and the schema helpers aren't re-exported | Browsers, Bun | `import { Service } from 'hub-service/web'` |
| [`hub-service/app`](docs/apps.md) | App builders: `App`, element helpers (`text`, `button`, `cell`, `list`, `files`, `fileOperation`, `stat`, `chart`, ...), `action`, `widget`, `webApp`. Importing it adds `app(...)` to every service class, so import it before calling `service.app(...)` | Bun, browsers | `import { App, button } from 'hub-service/app'` |
| [`hub-service/testing/fake-hub`](docs/README.md#testing-a-service) | `FakeHub`, `vectors` and `waitFor` for a service's tests: a hub on a free port that checks tokens like hub-server and records what services send | Bun (`bun test`) | `import { FakeHub, vectors, waitFor } from 'hub-service/testing/fake-hub'` |

The package has no `exports` map, so its other files resolve too; Hub's services import `MultiplatformService` from
`hub-service/service` and `KeyFile`/`authToken` from `hub-service/keys` in tests.

## Quick Start

```ts
import { Service } from 'hub-service'

new Service()
  .post('hash/sha256', body => new Bun.SHA256().update(body).digest('hex'))
  .start()
```

By default the service connects to `Bun.env.HUB` when set, otherwise `1997`.

Set a custom address and profile:

```ts
import { Service } from 'hub-service'

new Service({
  address: 1998,
  name: 'Hasher',
})
  .post('hash/sha256', body => new Bun.SHA256().update(body).digest('hex'))
  .start()
```

## Client Use

```ts
import { Client } from 'hub-client'

const client = new Client()
const hash = await client.post('hash/sha256', 'Hello World')
console.log(hash)
```

## Service API

### `new Service(options?)`

The Bun `Service` extends `NetworkService`, which adds local Hub Network
publication to the platform-neutral `MultiplatformService`. The web entry point
extends `MultiplatformService` directly and does not expose Unix-socket network
publication.

Options:

- `address?: string | number`
- `name?: string`
- `icon?: Icon`
- `hubKey?: string` - the hub's key when known up front; otherwise learned on the first connection (see Auth)
- `reporter?: boolean` - ask for the reporter role of this service's device (see Devices)
- `instance?: string` (Bun) - instance name, unique on the device; defaults to `HUB_INSTANCE`, then `name`, then the
  working directory's name
- `device?: DeviceOptions | false` (Bun) - device key path, name, platform, parent and certificate lifetime, or
  `false` to connect without a device
- `delegates?: string[]` - hub groups whose members may act for end users (`context.user` → `request.user`)
- `rateLimit?: RateLimit` - default per-caller limit of every path
- `grantCache?: number` - seconds to keep `hub/grant/check` answers (default 0)
- `ready?: boolean` - false to connect without taking calls until `setReady(true)`
- `key?: string | KeyFile | ServiceKey` (Bun) - this service's key: a key file path (created on first use, hub pins
  in `hubs.json` beside it), key text, or a `KeyFile` (hub pins in memory). Defaults to `./auth`. Services with
  different keys can run in one process; give each its own `instance` (or `name`) so their device certificates don't
  share an instance name. `service.key.publicKey()` returns its public key.

`name` and `icon` are sent as the service profile when a client connects.

### `post(path, handler, settings?)`

Register a request handler.

```ts
service.post('math/add', body => body.a + body.b)
```

Handlers get a second argument, the `ServiceRequest`: `caller`, `context`, `user`, `path`, `signal` and checks.
`caller` is who made the request, as the hub reports it: `{ key?, device?: { id, name }, groups?, owner? }`. It is
set only when the hub that forwarded the request is the pinned hub, so a hub that passes client context through
can't be used to forge it.

```ts
service.post('git/push', (body, request) => {
  request.requireOwner() // throws HubError unauthorized / forbidden
  // ...
})
```

Settings:

- `auth: 'key' | 'device' | 'owner' | 'user'`, `groups: [...]`, `permission: 'posts/moderate'`: who may call,
  checked before the handler (`permission` asks the hub with `hub/grant/check`)
- `input`: a validator function or schema with `parse` (zod works); the handler gets its result
- `rateLimit: { limit, window, by?, bucket? }`: calls per caller per window (seconds), or `false`
- `limit`: calls the hub runs at once on this provider; `public: true`: callable by anyone on `default-deny` hubs
- `shutdown: 'wait' | 'end'`: what `shutdown()` does with a running call
- `title`, `description`, `inputSchema`, `outputSchema`, `annotations`: what the path does, for `hub/api/list` and
  MCP-style tools; `input: jsonSchema(schema)` validates and publishes the schema
  ([API descriptions](docs/README.md#api-descriptions-and-schemas))

```ts
service.post('posts/delete', ({ id }, request) => posts.delete(id, request.signal), {
  permission: 'posts/moderate',
  input: z.object({ id: z.string() }),
  rateLimit: { limit: 30, window: 60 },
})
```

Throw `HubError` for errors with a code (`HubError.notFound('post not found', { id })`); callers get a
`ChannelError` with the same message, code and info. [Service features](docs/service-features.md) has the details:
error codes, end users through a gateway (`delegates`, `context.user`), cancellation, readiness and shutdown.

### `stream(path, handler, settings?)`

Register an async iterator handler.

```ts
service.stream('clock/ticks', async function* () {
  while (true) {
    yield Date.now()
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
})
```

### `send(path, body?, options?)`

Send a message after `start()` has been called.

### `values(path, body?, options?)`

Collect streamed values after `start()` has been called.

### `stop()`

Disconnects from the hub and stops reconnecting. Sends that are waiting fail, running handlers' signals abort and
`reportDeviceData` loops end; `start()` connects again.

### `shutdown({ timeout? })`, `setReady(ready)`, `health`

`shutdown` stops new calls (the hub routes them to other providers), ends running streams, waits up to `timeout`
milliseconds (10 s) for running posts, then stops; it resolves true when everything finished.
`shutdownOnSignals({ timeout })` (Bun) does it on SIGTERM and SIGINT, then exits. The `ready: false` option and
`setReady(false)` keep the paths registered without taking calls. `health` is
`{ status, connected, ready, running }`.

### `apiList()`

The hub's APIs this connection may call, with what their services say about them (`hub/api/list`): `ApiDescription[]`
of `{ path, kind?, title?, description?, inputSchema?, outputSchema?, annotations? }`. A hub from before API
descriptions fails it with `api not found`.

### `publicKey()`

Returns the public key of the default `./auth` keypair (`service.key.publicKey()` for a service's own key).

### Network shares

Once the service and local `hub-net` agent are running, publish the port that
the application actually selected:

```ts
const service = new Service().start()

const server = Bun.serve({
  port: 0,
  fetch: () => new Response('ok'),
})

await service.publishShare(
  's3',
  'tcp',
  '127.0.0.1',
  server.port,
  { mode: 'hub' },
)
```

When the listener is created before the Hub connection, declare its selected
port in the service chain. The declaration is published as part of connection
registration, so startup does not race `sender` initialization:

```ts
new Service()
  .share('s3', 'tcp', '127.0.0.1', server.port, { mode: 'hub' })
  .start()
```

`publishShare`, `updateShare`, and `removeShare` resolve to the service, so
awaited calls remain chainable. Every change atomically republishes the complete
declared share set. Shares are re-attested and republished after a Hub
reconnect; publication results expose the canonical overlay authority and
selected port through `getSharePublication(name)`.

## Auth

- The Bun runtime stores the generated keypair in a file named `auth` in the current working directory, or in the file
  the `key` option names.
- The file is base64 encoded and contains both private and public key material.
- The file is ignored by git in this repo.
- The web runtime stores the key in `localStorage` under `auth` when possible, otherwise in memory.

Tokens work once, for one hub (auth v2, `Docs/Devices/protocol.md` in the Hub workspace). Before each connect the service
asks `hub/info` on an anonymous connection with a nonce of its own. The hub signs that nonce with its key, and the service
pins the key only after the proof holds; until one does it keeps waiting and sends nothing. It then connects with `v: 1`,
signing `hub1:<hub key>:<challenge>:<expiry>` over the one-time challenge from that answer, valid for 30 seconds.
Pins live in `hubs.json` beside the `auth` file (`localStorage` key `hubs` on the web), keyed by the dialed
URL (a bare port is `ws://localhost:<port>`; scheme and host lowercased, no trailing slash).

Plain `ws://` is allowed on loopback, the overlay (100.64.0.0/10) and the local network; anything else is refused before
dialing, since the token and the service's calls would cross the internet in the clear. `allowPlaintext` (or
`HUB_ALLOW_PLAINTEXT=1`) allows it for a private network such as a container's.

If a hub can't prove the pinned key, or refuses the connection twice (a revoked service key), the service sets
`refusedError` (a `HubRefusedError` naming the pinned key), logs it, calls the `onError` option, and fails waiting and
new `send` calls with it instead of hanging. One refusal only asks for a new challenge: it can be gone after a hub restart.
`forgetHubKey()` clears the pin and reconnects.

## Devices

A Bun service runs on a device: it signs a 7-day certificate for its service key with the device key and sends it in
the `device` header, renewing it at connect when less than a day is left. Every service of a
device shares the key at `~/.hub/device.key` (`/var/lib/hub/device.key` for root on Linux; `HUB_DEVICE_KEY` overrides
it), created by the first service that needs it. `HUB_DEVICE_NAME` and `HUB_DEVICE_PARENT` set the suggested name and
a declared parent name, which gives nothing; `device: { attach }` or `HUB_DEVICE_ATTACH` (`1`, or a parent's device id) asks to
attach as a child, holding only what the owner gives it (Docs/Devices/protocol.md section 14), which is what a container or VM
should do; `HUB_DEVICE=0` or `device: false` turns device mode off. Apps that keep the device key in their own
store pass it as `device: { key }` (key file text, a `KeyFile`, or a loader). The Hub Launcher passes its device key and
the app name (`HUB_INSTANCE`) to the apps it runs.

The device's reporter (the Hub app on Apple devices, the launcher on servers) describes it:

```ts
const service = new Service({ reporter: true }).start()
await service.describeDevice({ name: 'Mac Studio', capabilities: { memory: 68719476736 } })
const stop = service.reportDeviceData(5000, () => ({ cpu: 0.25 }))
```

The hub takes descriptions and data from the first connected reporter of each device; the others get `false` until
they take over. Owners and granted callers read `devices()`, `pendingDevices()` and `deviceData(id)`, and can ask for
a provider on a given device with `send(path, body, { context: { device: id } })`.

## Apps

Every builder, live updates, cells, lists and the file elements: [docs/apps.md](docs/apps.md).

Import the side-effect module before using `service.app(...)` (on any service, `MultiplatformService` and the web
`Service` included):

```ts
import { Service } from 'hub-service'
import 'hub-service/app'
import { App, text, button, action } from 'hub-service/app'

const service = new Service()

service.app(
  new App(
    { type: 'app', name: 'Demo', path: 'demo' },
    [
      text('Ready'),
      button('Refresh', { path: 'demo/refresh' }),
    ],
  ).actions(
    action({
      path: 'demo/refresh',
      execute: async () => 'ok',
    }),
  ),
).start()
```

### App constructor

`new App(header, body, data?, state?, options?)`

- `header` - app header with `type: 'app'`, `name`, and `path`
- `body` - array of UI elements
- `data` - arbitrary payload sent with the initial app state
- `state` - optional lazy state stream
- `options.top` - content shown above the body
- `options.bottom` - content shown below the body
- call `.actions(...)` to register executable handlers for action paths used by UI elements

### Element helpers

- `text(value)` - plain text element
- `textField(value, { placeholder?, action? })`
- `progress(value, { min?, max? })`
- `button(title, action)`
- `slider(value, { defaultValue?, min?, max?, step?, action? })`
- `list(data, content)`
- `picker(options, selected)`
- `cell(title?, subtitle?)`
- `files(value, title?, action)`
- `fileOperation(format, title?, action)`
- `hstack(content, { spacing? })`
- `vstack(content, { spacing? })`
- `zstack(content)`
- `spacer()`
- `action({ path, body?, output?, execute })` - registers an executable action for `service.app(...)`

### Settings

`post()` and `stream()` accept optional settings:

- `permissions.group` is auto-filled from the first path segment when omitted.
- `permissions.name` is the permission label.
- `permissions.allows` marks the permission as allowed by default.
- `limit` sets an optional API limit.

## Development

```sh
bun install
bun run example
```

`example.ts` starts a simple echo service.
