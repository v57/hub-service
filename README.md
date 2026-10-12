# hub-service

Hub service runtime for Bun and web targets. It provides a small RPC layer over `channel`, Ed25519-based request signing, and an optional app payload format.

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

`name` and `icon` are sent as the service profile when a client connects.

### `post(path, handler, settings?)`

Register a request handler.

```ts
service.post('math/add', body => body.a + body.b)
```

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

The signing token includes a short expiration window. Default expiration is 10 seconds.

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
