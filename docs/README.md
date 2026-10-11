# hub-service documentation

`hub-service` is the SDK for writing [Hub](https://github.com/v57/hub-pro) services and clients. A service
connects to a Hub and publishes APIs by path (for example `hash/sha256`). Any connection can then call
those APIs through the Hub by name. When several services publish the same path, the Hub splits the
requests between them.

The same SDK exists in 14 languages. This repo (TypeScript, Bun) is the reference: every port speaks the
same wire contract and is checked against a live hub with [`tests/verify.ts`](../tests/verify.ts).

- [Quick start](#quick-start)
- [Concepts](#concepts): hub address, post and stream APIs, calling APIs, settings, profile, auth
- [Apps](#apps): UI that the Hub app renders for your service
- [Wire contract](#wire-contract)
- [Languages](#languages)

## Quick start

1. Start a hub. Hub Lite has no security and is the quickest for development; Hub Pro adds keys and
   permissions. Both listen on port `1997`.

   ```sh
   bunx v57/hub-lite   # or: bunx v57/hub-pro, or the hub CLI: bunx v57/hub
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

- `permissions`: `{ name, group?, allows? }`. On Hub Pro, only connections given this permission can call
  the API (owners always can). `name` is the label shown for it, `allows: true` grants it by default, and
  `group` defaults to the first path segment of the first API that sets permissions.
- `limit`: how many requests this service handles at the same time.

Hub Lite ignores both.

### Profile

`name` and `icon` tell the Hub app how to show your service:

```ts
new Service({ name: 'Hasher', icon: { symbol: 'number', text: '#' } })
```

`icon.symbol` is an SF Symbol name and `icon.text` is a short text fallback. Each one can also be an
object: `{ name, color: { foreground, background, foregroundDark, backgroundDark } }`.

### Auth (Hub Pro)

Every service has an Ed25519 key. On the first run the SDK creates it in a file named `auth` in the working
directory and reuses it after that. Keep that file private: it is the service's identity.

On Hub Pro, an owner has to allow a service's key before it can host APIs. The Hub app shows new keys
under Security. To look up a service's public key:

```ts
import { publicKey } from 'hub-service'
console.log(await publicKey())
```

In the browser, import from `hub-service/web` instead: it keeps the key in `localStorage` (when available)
rather than a file.

## Apps

A service can ship a small UI that the Hub app renders. You describe it with elements and bind them to a
`data` dictionary. Buttons and fields call your APIs and write the responses back into `data`.

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
| `text(value)` or a plain string | Text |
| `textField(value, { placeholder, action })` | Text field. `action` runs on submit |
| `button(title, action)` | Button |
| `slider(value, { defaultValue, min, max, step, action })` | Slider |
| `progress(value, { min, max })` | Progress bar |
| `picker(options, selected)` | Picker |
| `cell(title, subtitle)` | List row with a title and subtitle |
| `list(data, content)` | Repeats `content` for each item of the `data` array |
| `files(value, title, action)` | File list |
| `fileOperation(format, title, action)` | File operation (`format` sets the output file extension) |
| `hstack(content, { spacing })`, `vstack(...)`, `zstack(content)`, `spacer()` | Layout |

Pass `{ top, bottom }` as the fifth `App` argument to pin elements above or below the body. To push changes
to an open app, pass a `LazyState` from `channel/more` as the fourth argument; every value it emits is sent
to the app. `app.actions(action({ path, body, output, execute }))` registers an API together with its
action.

## Wire contract

Any client that speaks [Channel](https://github.com/v57/channel) can act as a service:

1. Open a WebSocket to the hub. For Hub Pro, send the headers `auth: key.<publicKey>.<signature>.<expiry>`
   and `v: 0`. `expiry` is a Unix time in seconds (the SDK uses now + 10 s), `signature` is the Ed25519
   signature of that string, and both keys are base64.
2. Send `hub/profile/update` with `{ name, icon }` (only when either is set).
3. Send `hub/service/update` with `{ services: [{ path, permissions, limit }], apps: [{ type, name, path }] }`.
4. Answer the post and stream requests for those paths.

The hub forgets a connection's services when it disconnects, so steps 1 to 3 run again on every
reconnect.

## Languages

All ports share the API above (`post`, `stream`, `app`, `send`, `values`, `start`) and the element helpers.
Each one is built on the Channel port for its language and is checked against a live hub with this repo's
`tests/verify.ts`. Each port's README has its full API.

| Language | Library | Hub Pro auth |
|---|---|---|
| TypeScript | [hub-service](https://github.com/v57/hub-service) (reference) | yes |
| Swift | [HubService](https://github.com/v57/HubService) (used by the Hub app, includes SwiftUI views) | yes (Keychain) |
| C | [hub-service-c](https://github.com/v57/hub-service-c) | yes |
| C# | [hub-service-cs](https://github.com/v57/hub-service-cs) | yes |
| Dart | [hub-service-dart](https://github.com/v57/hub-service-dart) | yes |
| Elixir | [hub_service_ex](https://github.com/v57/hub_service_ex) | yes |
| Go | [hub-service-go](https://github.com/v57/hub-service-go) | no, Hub Lite only |
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

let client = HubClient(URL(string: "ws://127.0.0.1:1997")!, keyChain: KeyChain(keyChain: "com.example.YourApp"), connect: true)
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
