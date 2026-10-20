# hub-service

Hub service runtime for Bun and web targets. It provides a small RPC layer over `channel`, Ed25519-based request signing, and an optional app payload format.

Full documentation, including apps and the other 13 languages: [docs](docs/README.md).

## Install

```sh
bun add hub-service
```

## Entry Points

- `hub-service` - Bun/server runtime. Persists the private key in a local `auth` file.
- `hub-service/web` - browser/Web Crypto runtime. Uses `localStorage` when available and falls back to memory.
- `hub-service/app` - app builder and UI element helpers. This file also patches `Service.prototype.app`, so import it before calling `service.app(...)`.

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

`name` and `icon` are sent as the service profile when a client connects.

### `post(path, handler, settings?)`

Register a request handler.

```ts
service.post('math/add', body => body.a + body.b)
```

Handlers get a second argument `{ caller, context }`. `caller` is who made the request, as the hub reports it:
`{ key?, device?: { id, name }, groups?, owner? }`. It is set only when the hub that forwarded the request is the
pinned hub, so a hub that passes client context through can't be used to forge it.

```ts
service.post('git/push', (body, { caller }) => {
  if (!caller?.owner) throw 'permissions required'
  // ...
})
```

Settings may mark a path `public: true`: callable by anyone on hubs in `default-deny` mode.

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

### `publicKey()`

Returns the public key for the current auth keypair.

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

- The Bun runtime stores the generated keypair in a file named `auth` in the current working directory.
- The file is base64 encoded and contains both private and public key material.
- The file is ignored by git in this repo.
- The web runtime stores the key in `localStorage` under `auth` when possible, otherwise in memory.

The signing token includes a short expiration window. Default expiration is 60 seconds.

Tokens are bound to one hub (protocol v1, `Docs/Devices/protocol.md` in the Hub workspace): on its first connection a
service signs a v0 token, asks `hub/info` for the hub's key, pins it and reconnects with `v: 1`, signing
`hub1:<hub key>:<expiry>`. Pins live in `hubs.json` beside the `auth` file (`localStorage` key `hubs` on the web).
Hubs without `hub/info` (Hub Lite) stay on v0. If the hub refuses a v1 connection, the service reports it in
`refusedError` and stays disconnected rather than falling back; `forgetHubKey()` clears the pin and reconnects.

## Devices

A Bun service runs on a device: it signs a 7-day certificate for its service key with the device key and sends it in
the `device` header of v1 connections, renewing it at connect when less than a day is left. Every service of a
device shares the key at `~/.hub/device.key` (`/var/lib/hub/device.key` for root on Linux; `HUB_DEVICE_KEY` overrides
it), created by the first service that needs it. `HUB_DEVICE_NAME` and `HUB_DEVICE_PARENT` set the suggested name and
declared parent; `HUB_DEVICE=0` or `device: false` turns device mode off. The Hub Launcher passes its device key and
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

Import the side-effect module before using `service.app(...)`:

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
