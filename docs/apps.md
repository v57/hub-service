# Apps: UI for a service (`hub-service/app`)

A service can publish **apps**: UI described as JSON that the Hub app renders, so a service gets a page, a Home
widget or a web page without shipping a client. This page covers the builders of `hub-service/app`. The overview and
the binding rules are in the guide's [Apps](README.md#apps) section; the protocol for other SDKs and clients is
`Docs/Apps/ui.md` in the Hub workspace, and every element is in the shared fixture
[`testdata/apps/interface.json`](../testdata/apps/interface.json).

- [A minimal app](#a-minimal-app)
- [`App`](#app): header, body, data, live state, top and bottom bars, actions
- [Live updates](#live-updates)
- [Cells and lists](#cells-and-lists)
- [Files and file operations](#files-and-file-operations)
- [Builders](#builders): every element helper with its arguments
- [Widgets and web apps](#widgets-and-web-apps)
- [Swift](#swift)

## A minimal app

```ts
import { Service } from 'hub-service'
import { App, action, button, cell, hstack, spacer, text, textField } from 'hub-service/app'

const greet = { path: 'greeter/greet', body: { name: 'name' }, output: { text: 'greeting' } }

const app = new App(
  { type: 'app', name: 'Greeter', path: 'greeter/ui', icon: 'hand.wave' },
  [
    textField('name', { placeholder: 'Your name', action: greet }),
    cell('Greeting', '$greeting'),
  ],
  { name: '', greeting: '' },
  undefined,
  { bottom: hstack([text('Greets as you type', { secondary: true }), spacer(), button('Greet', greet)]) },
).actions(
  action({ ...greet, execute: ({ name }: { name: string }) => ({ text: `Hello, ${name || 'stranger'}` }) }),
)

new Service({ name: 'Greeter' }).app(app).start()
```

What happens:

1. `.app(app)` adds the header to the service's `apps` (sent in `hub/service/update`), serves a stream at
   `greeter/ui` and registers the post of each action (`greeter/greet`).
2. The Hub app opens the stream and draws the first event: `{ header, body, top, bottom, data }`.
3. Typing in the field, or pressing the button, posts `{ name: data.name }` to `greeter/greet` as the user, and the
   answer's `text` field is written to `data.greeting`, which the cell shows.

Importing `hub-service/app` adds `app(...)` to every service class (`Service` of `hub-service` and of
`hub-service/web`, and `MultiplatformService`); import it before calling `service.app(...)`.

## `App`

```ts
new App(header, body, data?, state?, { top?, bottom? }?)
```

| Argument | Type | Meaning |
|---|---|---|
| `header` | `{ type: 'app', name, path, icon?, widget?, web? }` | `path` is where the app's stream is served; `icon` is an SF Symbol name (other clients map it or show the name's first letter) |
| `body` | `AnyElement[]` | The page, top to bottom |
| `data` | `Record<string, unknown>` | Values the elements read (`'$key'`) and write (bare keys of inputs). Defaults to `{}` |
| `state` | `LazyState<AppInterface>` | Later events of the stream, see [Live updates](#live-updates) |
| `top`, `bottom` | `AnyElement` | One element pinned above or below the page: a bar. Use `hstack` or `vstack` to put several in it |

Methods:

- `app.actions(...actions)`: posts registered together with the app, made with `action({ path, body?, output?,
  execute })`. `execute` gets the request body (resolved from `data` as the element's `body` says) and returns the
  answer. Pass every action in one call: a second call replaces the first.
- `app.widget({ sizes?, body?, bodies? })`: the app is also a Home widget, see [Widgets](#widgets-and-web-apps).
- `app.verifyToken(token)`: checks a page token of a web app.

An action registered with `action()` has no settings. When the path needs `auth`, a `permission`, input validation or
a [description](README.md#api-descriptions-and-schemas), register it with `service.post(path, handler, settings)`
instead and give the element a plain `{ path, body?, output? }`.

An action is `{ path, body?, output? }`:

- `body: 'key'` sends `data.key`; `body: { field: 'key' }` sends `{ field: data.key }`; no `body` sends nothing.
- `output: 'key'` stores the whole answer in `data.key`; `output: { field: 'key' }` stores the answer's `field` in
  `data.key`; without `output`, an object answer is merged into `data`.

## Live updates

The first event of an app's stream carries the whole app. Pass a `LazyState` (from `channel/more`; `channel` comes
with hub-service, and services usually list it too: `bun add v57/channel`) as the fourth argument to send more
events. Each event is a partial `AppInterface`: `body`, `top`, `bottom`, `data` and `widget` are all optional, and the
client keeps the last value of each. A new `data` **replaces** the old one, so send every key.

```ts
import { LazyState } from 'channel/more'
import { App, gauge, stat, type AppInterface } from 'hub-service/app'

let load = { cpu: 0.2, users: 12 }
const state = new LazyState<AppInterface>(() => ({ data: load }))

const app = new App({ type: 'app', name: 'Load', path: 'load/ui' }, [gauge('$cpu', { title: 'CPU' }), stat('Users', '$users')], load, state)

setInterval(() => {
  load = { cpu: Math.random(), users: load.users + 1 }
  state.setNeedsUpdate() // every open app gets { data: load }
}, 5000)
```

The state's function runs when a viewer opens the app and again after each `setNeedsUpdate()` while someone has it
open; viewers that open it later start from the last value. An event can also replace the page or the bars, for
example `{ body: [...], bottom: 'Updated' }`.

## Cells and lists

`cell(title?, subtitle?)` is a list row with two lines. Both are elements, so a cell can hold plain text, a `$key`,
a styled `text(...)` or a `badge(...)`:

```ts
cell('SHA 256', '$sha256')
cell(text('$name', { style: 'headline' }), badge('$status'))
```

`list(data, content)` repeats `content` once per item of the array in `data[data]`. Inside a row, keys resolve against
the row's object first, then the app's `data`, and an action in a row sends the row's values:

```ts
const body = [
  list('servers', hstack([cell('$name', '$region'), spacer(), button('Restart', { path: 'ops/restart', body: { id: 'id' } })])),
]
const data = { servers: [{ id: 'a1', name: 'api', region: 'eu' }, { id: 'b2', name: 'web', region: 'us' }] }
```

`table(data, columns)` shows the same kind of array as columns, see [Builders](#builders).

## Files and file operations

Both elements are drop areas: the user drops files on them in the Hub app, and the Hub app uploads them to the hub's
storage service (`s3/write`) under a folder named after the app. They need a storage service on the hub (such as
hub-s3 or hub-s3-local).

`files(value, title, action)`: after the upload the Hub app writes the files' download links (`s3/read`, presigned
URLs) into `data[value]` as an array of strings, then runs `action`. Send the links with `body`:

```ts
files('photos', 'Photos to index', { path: 'photos/index', body: 'photos' })
service.post('photos/index', async (links: string[]) => { for (const link of links) await index(await fetch(link)) })
```

`fileOperation(format, title, action)` runs `action` once per dropped file to turn it into another file. For each one
the Hub app sends the action's body (an object) with two links added: `from`, a download link of the uploaded file,
and `to`, an upload link (`s3/write`) for the result at `<folder>/Output/<name>.<format>`. `format` is the output
extension, a literal (`'png'`) or a `$key` of `data`. The service downloads `from`, works, and uploads with `PUT` to
`to`:

```ts
import { App, fileOperation, slider } from 'hub-service/app'

const app = new App({ type: 'app', name: 'Image Encoder', path: 'image/ui' }, [
  fileOperation('$format', 'Drop images', { path: 'image/encode', body: { format: 'format', quality: 'quality' } }),
  slider('quality', { min: 0.1, max: 1, step: 0.1 }),
], { format: 'webp', quality: 0.8 })

service.post('image/encode', async ({ from, to, format, quality }: { from: string; to: string; format: string; quality: number }) => {
  const input = new Uint8Array(await (await fetch(from)).arrayBuffer())
  await fetch(to, { method: 'PUT', body: await encode(input, format, quality) })
}, { limit: 4 })
```

The Hub app shows the progress of the uploads and of the processed files, and where the results are.

## Builders

Every helper returns a plain JSON element and leaves out unset fields. Strings that start with `$` read `data`;
`value` arguments of inputs (`textField`, `slider`, `progress`, `files`, `picker`'s `selected`) are bare keys.

Display:

| Helper | Notes |
|---|---|
| `text(value)` | A plain string. `text(value, { style, color, secondary })` styles it: `style` is `largeTitle`, `title`, `headline`, `body`, `callout`, `caption`, `footnote` or `monospaced` |
| `markdown(value)` | Inline Markdown: bold, italic, code, links |
| `image({ url } \| { symbol }, { width, height, mode, cornerRadius, color })` | An http(s) image or an SF Symbol; `mode` is `fit` or `fill` |
| `badge(value, { color })` | A small label; status words (`up`, `down`, `pending`, `failed`, ...) pick a color |
| `divider()` | A line |
| `link(title, url, { icon })` | Opens an http(s) or mailto link outside the app |
| `progress(value, { min, max })` | A small ring; `min` 0 and `max` 1 by default |
| `stat(title, value, { unit, delta, deltaFormat, positive, sparkline, icon, color })` | A number with its change and a sparkline |
| `gauge(value, { min, max, title, label, style, color, thresholds })` | `style`: `ring`, `semicircle` or `bar` |
| `chart(kind, series, { title, x, height, stacked, legend, yMin, yMax, unit })` | `kind`: `line`, `bar`, `area`, `pie`, `donut`; `series` is one `series(name, data, { color })` or an array of them |
| `table(data, columns)` | Rows from an array; a column is `column(title, key, { align, style })` or a key name |
| `cell(title?, subtitle?)` | A two-line row, see [Cells and lists](#cells-and-lists) |

Input and actions:

| Helper | Notes |
|---|---|
| `button(title, action, { icon, style, confirm })` | `style`: `default`, `prominent`, `bordered`, `destructive`; `confirm: { title, message?, button?, destructive? }` asks first |
| `textField(value, { placeholder, action })` | Writes `data[value]` and runs `action` on change |
| `slider(value, { defaultValue, min, max, step, action })` | Writes `data[value]` |
| `picker(options, selected)` | Chooses one of `options` into `data[selected]` |
| `sheet(title, content, { icon })` | A button that opens `content` in a sheet |
| `files(value, title, action)` | See [Files and file operations](#files-and-file-operations) |
| `fileOperation(format, title, action)` | See [Files and file operations](#files-and-file-operations) |
| `action({ path, body?, output?, execute })` | An action with its handler, for `app.actions(...)` |

Layout:

| Helper | Notes |
|---|---|
| `hstack(content, { spacing })`, `vstack(content, { spacing })`, `zstack(content)`, `spacer()` | Stacks |
| `grid(content, { columns, minWidth, spacing })` | Fixed `columns`, else as many columns of at least `minWidth` (160) as fit |
| `section(title, content, { subtitle, style })` | A titled group; `style` `card` (default) or `plain` |
| `tabs([tab(title, content, { icon })], { selected, style })` | Pages; with `selected`, the selected title is kept in `data[selected]` |
| `list(data, content)` | `content` once per item of an array, see [Cells and lists](#cells-and-lists) |

Exported types: `AppInterface`, `AnyElement`, `Color`, `TextStyle`, `ButtonStyle`, `Confirmation`, `ChartKind`,
`ChartPoint`, `ChartSeries`, `TableColumn`, `Tab`, `WidgetSize`, `WidgetHeader`, `WidgetInterface`, `WidgetOptions`,
`WebHeader`, `WebAppOptions`, `WebToken`, and `widgetSizes`.

## Widgets and web apps

- `widget(header, body, { sizes, bodies, data, state })` makes an app that is a Home widget, and
  `app.widget({ sizes, body, bodies })` makes any app one too. Sizes are `1x1`, `1x2`, `2x1` and `2x2` Home tiles, the
  first is the default. The widget shares the app's `data`, so one `LazyState` updates both.
- `webApp({ name, path, url, icon, origins, share, token, secret, lifetime })` publishes a web page instead of
  elements. With `token` (the default) the service answers `<path>/token` with a signed page token naming the hub
  and the caller; the page's server checks it with `app.verifyToken(token)`. `WebTokens` is the HMAC signer behind
  it; give instances of a service the same `secret` so they accept each other's tokens.

The guide has examples of both: [Widgets](README.md#widgets) and [Web apps](README.md#web-apps).

## Swift

The Swift package builds the same JSON with `App`, `AppHeader` and `Element` (`HText`, `HButton`, `HCell`, ...) and
`service.app(_:)`, and its `HubUI` library is the renderer the Hub app uses. See
[HubService](https://github.com/v57/HubService/blob/main/docs/HubService.md#apps).
