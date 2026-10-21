import { MultiplatformService } from './service'
import type { AppHeader, ServiceRequest } from './service'
import { LazyState } from 'channel/more'

// The app protocol is described in Docs/Apps/ui.md (Hub repository docs). Every element is a JSON object with a
// `type`; a plain string is a text element. Strings that start with `$` read the app's `data`.

export interface AppInterface {
  header?: AppHeader
  body?: AnyElement[]
  top?: AnyElement
  bottom?: AnyElement
  data?: Record<string, unknown>
  /** Home screen tile content, see `App.widget` */
  widget?: WidgetInterface
}

/** Widget sizes in Home tiles, width x height. A 1x1 tile is a small square; 2x2 fills a phone's width. */
export type WidgetSize = '1x1' | '1x2' | '2x1' | '2x2'
export const widgetSizes: readonly WidgetSize[] = ['1x1', '1x2', '2x1', '2x2']

/** Declared in the app header, so Home knows a widget's sizes before opening its stream */
export interface WidgetHeader {
  /** Supported sizes, the first is the default */
  sizes: WidgetSize[]
}

/** Widget bodies in the app stream: one per size, or `body` for every size that has none */
export type WidgetInterface = { body?: AnyElement[] } & { [size in WidgetSize]?: AnyElement[] }

/** Declared in the app header: the app is a web page that the Hub app opens in a web view */
export interface WebHeader {
  /**
   * The page. `{hubHost}` is replaced by the host the Hub app uses for this hub, for pages served next to the hub
   * (`http://{hubHost}:8080/`); public, local network and Hub Network addresses work as they are.
   */
  url: string
  /** Other origins the page may navigate to without asking the user (`https://cdn.example.com`) */
  origins?: string[]
  /** The Hub app fetches a signed page token from `<path>/token` and hands it to the page */
  token?: boolean
}

declare module './service' {
  interface AppHeader {
    /** SF Symbol name for the Home icon. Other platforms map it or show the name's first letter */
    icon?: string
    /** The app is also a Home widget */
    widget?: WidgetHeader
    /** The app is a web page */
    web?: WebHeader
  }
}

interface AppOptions {
  top?: AnyElement
  bottom?: AnyElement
}

export interface WidgetOptions {
  /** Supported sizes, the first is the default. Defaults to every size */
  sizes?: WidgetSize[]
  /** Content for every size without its own body */
  body?: AnyElement[]
  /** Content per size */
  bodies?: { [size in WidgetSize]?: AnyElement[] }
}

export class App {
  header: AppHeader
  body: AnyElement[]
  top?: AnyElement
  bottom?: AnyElement
  data: Record<string, unknown>
  state?: LazyState<AppInterface>
  widgetBody?: WidgetInterface
  executableActions: ExecutableAction[] = []
  /** Signs and verifies page tokens of a web app */
  tokens?: WebTokens
  constructor(
    header: AppHeader,
    body: AnyElement[],
    data: Record<string, unknown> = {},
    state?: LazyState<AppInterface>,
    options: AppOptions = {},
  ) {
    this.header = header
    this.body = body
    this.top = options.top
    this.bottom = options.bottom
    this.data = data
    this.state = state
  }
  actions(...actions: ExecutableAction[]): App {
    this.executableActions = actions
    return this
  }
  /** Makes the app a Home widget as well. Tapping the widget opens the app. */
  widget(options: WidgetOptions): App {
    const sizes = options.sizes?.length ? options.sizes.filter(s => widgetSizes.includes(s)) : [...widgetSizes]
    if (sizes.length === 0) throw new Error('A widget needs at least one of the sizes 1x1, 1x2, 2x1, 2x2')
    this.header.widget = { sizes }
    const widget: WidgetInterface = {}
    if (options.body) widget.body = options.body
    for (const size of sizes) {
      const body = options.bodies?.[size]
      if (body) widget[size] = body
    }
    this.widgetBody = widget
    return this
  }
  /** Verifies a page token from this web app. Throws when it is invalid or expired. */
  async verifyToken(token: string): Promise<WebToken> {
    if (!this.tokens) throw new Error(`${this.header.path} doesn't issue page tokens`)
    const payload = await this.tokens.verify(token)
    if (payload.app !== this.header.path) throw new Error('The token belongs to another app')
    return payload
  }
}

/**
 * A Home widget: an app whose full page shows the widget's content until you give it a body.
 * `widget({ name: 'Users', path: 'social/users', sizes: ['1x1', '2x1'] }, [stat('Users', '$users')])`
 */
export function widget(
  header: { name: string; path: string; icon?: string },
  body: AnyElement[],
  options: Omit<WidgetOptions, 'body'> & { data?: Record<string, unknown>; state?: LazyState<AppInterface> } = {},
): App {
  const app = new App({ type: 'app', ...header }, body, options.data ?? {}, options.state)
  return app.widget({ sizes: options.sizes, bodies: options.bodies, body })
}

export interface WebAppOptions {
  name: string
  path: string
  icon?: string
  url: string
  origins?: string[]
  /** Issue signed page tokens at `<path>/token`. Defaults to true */
  token?: boolean
  /** HMAC key for page tokens; share it between instances of a service. Defaults to a random key per process */
  secret?: string | Uint8Array
  /** Token lifetime in seconds. Defaults to 300 */
  lifetime?: number
}

/**
 * A web app. The Hub app opens `url` in a web view and hands the page a token naming the hub and the caller,
 * which the page sends back to the service (`app.verifyToken(token)`). Older Hub apps show a link instead.
 */
export function webApp(options: WebAppOptions): App {
  const web: WebHeader = { url: options.url }
  if (options.origins?.length) web.origins = options.origins
  const token = options.token ?? true
  if (token) web.token = true
  const header: AppHeader = { type: 'app', name: options.name, path: options.path, web }
  if (options.icon) header.icon = options.icon
  const app = new App(header, [
    text('This app is a web page. Update the Hub app to open it here.', { secondary: true }),
    link(`Open ${options.name}`, options.url.replaceAll('{hubHost}', 'localhost')),
  ])
  if (token) app.tokens = new WebTokens(options.secret, options.lifetime)
  return app
}

/** What a page token says. The hub and caller come from the hub that forwarded the token request. */
export interface WebToken {
  v: 1
  /** App path */
  app: string
  /** Key of the hub that asked for the token */
  hub?: string
  /** Caller's public key, absent for anonymous callers or hubs that don't name callers */
  caller?: string
  device?: { id: string; name: string }
  owner?: boolean
  /** Unix time in seconds */
  iat: number
  exp: number
  nonce: string
}

/** HMAC-SHA256 page tokens: `base64url(payload).base64url(signature)` */
export class WebTokens {
  private key: Promise<CryptoKey>
  lifetime: number
  constructor(secret?: string | Uint8Array, lifetime = 300) {
    const bytes = typeof secret === 'string' ? new TextEncoder().encode(secret) : new Uint8Array(secret ?? crypto.getRandomValues(new Uint8Array(32)))
    this.key = crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    this.lifetime = lifetime
  }
  async issue(app: string, request: Pick<ServiceRequest, 'caller'> & { hub?: string }, now = Date.now()): Promise<string> {
    const iat = Math.floor(now / 1000)
    const payload: WebToken = { v: 1, app, iat, exp: iat + this.lifetime, nonce: base64url(crypto.getRandomValues(new Uint8Array(12))) }
    if (request.hub) payload.hub = request.hub
    const caller = request.caller
    if (caller?.key) payload.caller = caller.key
    if (caller?.device) payload.device = caller.device
    if (caller?.owner) payload.owner = true
    const body = base64url(new TextEncoder().encode(JSON.stringify(payload)))
    const signature = await crypto.subtle.sign('HMAC', await this.key, new TextEncoder().encode(body))
    return `${body}.${base64url(new Uint8Array(signature))}`
  }
  async verify(token: string, now = Date.now()): Promise<WebToken> {
    const token_ = token.replace(/^Bearer\s+/i, '').trim()
    const [body, signature, extra] = token_.split('.')
    if (!body || !signature || extra !== undefined) throw new Error('Malformed token')
    const valid = await crypto.subtle.verify('HMAC', await this.key, fromBase64url(signature), new TextEncoder().encode(body))
    if (!valid) throw new Error('Invalid token signature')
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as WebToken
    if (payload.v !== 1) throw new Error('Unsupported token version')
    if (payload.exp * 1000 < now) throw new Error('Token expired')
    return payload
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

declare module './service' {
  interface MultiplatformService {
    /** Publishes an app: its stream at `app.header.path` and its actions */
    app(app: App): this
  }
}

MultiplatformService.prototype.app = function <T extends MultiplatformService>(this: T, app: App): T {
  this.apps.push(app.header)
  const state = app.state
  for (const action of app.executableActions) {
    this.post(action.header.path, action.execute)
  }
  const tokens = app.tokens
  if (tokens) {
    const service = this
    this.post(`${app.header.path}/token`, (_body, request) => tokens.issue(app.header.path, { caller: request.caller, hub: service.hubKey }))
  }
  this.stream(app.header.path, async function* () {
    const first: AppInterface = { header: app.header, body: app.body, top: app.top, bottom: app.bottom, data: app.data }
    if (app.widgetBody) first.widget = app.widgetBody
    yield first
    if (state) {
      for await (const event of state.makeIterator()) {
        yield event
      }
    }
  })
  return this
}

export type AnyElement =
  | string
  | TextElement
  | ProgressElement
  | TextFieldElement
  | ButtonElement
  | SliderElement
  | ListElement
  | PickerElement
  | CellElement
  | FilesElement
  | FileOperationElement
  | HStackElement
  | VStackElement
  | ZStackElement
  | SpacerElement
  | MarkdownElement
  | ImageElement
  | BadgeElement
  | DividerElement
  | LinkElement
  | StatElement
  | GaugeElement
  | ChartElement
  | TableElement
  | GridElement
  | SectionElement
  | TabsElement
  | SheetElement

/** A literal, or `$key` to read the app's data */
export type Value = string | number
/** Named system colors, `#rrggbb`, or `$key` */
export type Color =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'mint'
  | 'teal'
  | 'cyan'
  | 'blue'
  | 'indigo'
  | 'purple'
  | 'pink'
  | 'brown'
  | 'gray'
  | 'primary'
  | 'secondary'
  | 'accent'
  | (string & {})

export type TextStyle = 'largeTitle' | 'title' | 'headline' | 'body' | 'callout' | 'caption' | 'footnote' | 'monospaced'

interface TextElement {
  type: 'text'
  value: string
  secondary?: boolean
  style?: TextStyle
  color?: Color
}
interface ProgressElement {
  type: 'progress'
  value: string
  min?: number
  max?: number
}
interface TextFieldElement {
  type: 'textField'
  value: string
  placeholder?: string
  action?: Action
}
interface ButtonElement {
  type: 'button'
  title: string
  action: Action
  icon?: string
  style?: ButtonStyle
  confirm?: Confirmation
}
export type ButtonStyle = 'default' | 'prominent' | 'bordered' | 'destructive'
/** Asks before running a button's action */
export interface Confirmation {
  title: string
  message?: string
  /** Confirm button title, defaults to the button's title */
  button?: string
  destructive?: boolean
}
interface SliderElement {
  type: 'slider'
  value: string
  defaultValue?: number
  min?: number
  max?: number
  step?: number
  action?: Action
}
interface ListElement {
  type: 'list'
  data: string
  content: AnyElement
}
interface PickerElement {
  type: 'picker'
  options: string[]
  selected: string
}
interface CellElement {
  type: 'cell'
  title?: AnyElement
  subtitle?: AnyElement
}
interface FilesElement {
  type: 'files'
  value: string
  title?: AnyElement
  action: Action
}
interface FileOperationElement {
  type: 'fileOperation'
  format?: string
  title?: AnyElement
  action: Action
}
interface HStackElement {
  type: 'hstack'
  content: AnyElement[]
  spacing?: number
}
interface VStackElement {
  type: 'vstack'
  content: AnyElement[]
  spacing?: number
}
interface ZStackElement {
  type: 'zstack'
  content: AnyElement[]
}
interface SpacerElement {
  type: 'spacer'
}
interface MarkdownElement {
  type: 'markdown'
  value: string
}
interface ImageElement {
  type: 'image'
  /** http(s) URL or `$key` */
  url?: string
  /** SF Symbol name or `$key` */
  symbol?: string
  width?: number
  height?: number
  /** `fit` (default) shows all of the image, `fill` crops it */
  mode?: 'fit' | 'fill'
  cornerRadius?: number
  color?: Color
}
interface BadgeElement {
  type: 'badge'
  value: string
  color?: Color
}
interface DividerElement {
  type: 'divider'
}
interface LinkElement {
  type: 'link'
  title: string
  /** http(s) URL or `$key`; opens in the browser */
  url: string
  icon?: string
}
interface StatElement {
  type: 'stat'
  title: string
  value: Value
  unit?: string
  /** Change since the last period: a number (`$key`) shown with a sign, green when it goes the good way */
  delta?: Value
  /** `percent` shows 0.12 as +12% */
  deltaFormat?: 'number' | 'percent'
  /** Which way is good, defaults to up */
  positive?: 'up' | 'down'
  /** Small line under the value: `$key` of a number array, or the numbers */
  sparkline?: string | number[]
  icon?: string
  color?: Color
}
interface GaugeElement {
  type: 'gauge'
  value: Value
  min?: number
  max?: number
  title?: string
  /** Shown in the middle, defaults to the value */
  label?: string
  style?: 'ring' | 'semicircle' | 'bar'
  color?: Color
  /** Color from these values up: `[{ value: 70, color: 'orange' }, { value: 90, color: 'red' }]` */
  thresholds?: { value: number; color: Color }[]
}
export type ChartKind = 'line' | 'bar' | 'area' | 'pie' | 'donut'
/**
 * A chart point: a number (x is its index), `[x, y]`, `{ x, y }` or `{ label, value }`.
 * x is a number, a category string or a time (Unix milliseconds or an ISO string when the chart's `x` is `time`).
 */
export type ChartPoint = number | [number | string, number] | { x: number | string; y: number } | { label: string; value: number }
export interface ChartSeries {
  name: string
  /** `$key` of a point array, or the points */
  data: string | ChartPoint[]
  color?: Color
}
interface ChartElement {
  type: 'chart'
  kind: ChartKind
  series: ChartSeries[]
  title?: string
  /** How x values read, defaults to `number` for numbers and `category` for strings */
  x?: 'number' | 'category' | 'time'
  height?: number
  /** Stacks bars and areas of several series */
  stacked?: boolean
  legend?: boolean
  yMin?: number
  yMax?: number
  unit?: string
}
export interface TableColumn {
  title: string
  /** Field of each row */
  key: string
  align?: 'leading' | 'center' | 'trailing'
  /** `badge` shows the cell as a badge, `monospaced` for numbers and ids */
  style?: 'text' | 'secondary' | 'monospaced' | 'badge'
}
interface TableElement {
  type: 'table'
  /** `$key` of an array of row objects */
  data: string
  columns: TableColumn[]
}
interface GridElement {
  type: 'grid'
  content: AnyElement[]
  /** Fixed column count */
  columns?: number
  /** Adaptive columns at least this wide, defaults to 160 */
  minWidth?: number
  spacing?: number
}
interface SectionElement {
  type: 'section'
  title?: string
  subtitle?: string
  content: AnyElement[]
  /** `card` (default) draws a rounded background */
  style?: 'card' | 'plain'
}
export interface Tab {
  title: string
  icon?: string
  content: AnyElement[]
}
interface TabsElement {
  type: 'tabs'
  tabs: Tab[]
  /** Data key that holds the selected tab's title, so actions can read it */
  selected?: string
  style?: 'segmented' | 'tabs'
}
interface SheetElement {
  type: 'sheet'
  /** Button title */
  title: string
  icon?: string
  content: AnyElement[]
}
interface Action {
  path: string
  body?: string | Record<string, string>
  output?: string | Record<string, string>
}

interface ActionExecution {
  execute: (body: any) => any | Promise<any>
}

interface ExecutableAction {
  header: Action
  execute: (body: any) => any | Promise<any>
}

export function textField(value: string, options: { placeholder?: string; action?: Action } = {}): TextFieldElement {
  return {
    type: 'textField',
    value,
    placeholder: options.placeholder,
    action: options.action,
  }
}
/** Plain text, or a styled text element when options are given */
export function text(value: string): string
export function text(value: string, options: { secondary?: boolean; style?: TextStyle; color?: Color }): TextElement
export function text(value: string, options?: { secondary?: boolean; style?: TextStyle; color?: Color }): string | TextElement {
  if (!options) return value
  return defined<TextElement>({ type: 'text', value, secondary: options.secondary || undefined, style: options.style, color: options.color })
}
export function progress(value: string, options: { min?: number; max?: number } = {}): ProgressElement {
  const element: ProgressElement = { type: 'progress', value }
  if (options.min !== undefined) element.min = options.min
  if (options.max !== undefined) element.max = options.max
  return element
}
export function button(title: string, action: Action, options: { icon?: string; style?: ButtonStyle; confirm?: Confirmation } = {}): ButtonElement {
  return defined({ type: 'button', title, action, icon: options.icon, style: options.style, confirm: options.confirm })
}
export function slider(
  value: string,
  options: {
    defaultValue?: number
    min?: number
    max?: number
    step?: number
    action?: Action
  } = {},
): SliderElement {
  const element: SliderElement = { type: 'slider', value }
  if (options.defaultValue !== undefined) element.defaultValue = options.defaultValue
  if (options.min !== undefined) element.min = options.min
  if (options.max !== undefined) element.max = options.max
  if (options.step !== undefined) element.step = options.step
  if (options.action !== undefined) element.action = options.action
  return element
}
export function list(data: string, content: AnyElement): ListElement {
  return { type: 'list', data, content }
}
export function picker(options: string[], selected: string): PickerElement {
  return { type: 'picker', options, selected }
}
export function cell(title?: AnyElement, subtitle?: AnyElement): CellElement {
  const element: CellElement = { type: 'cell' }
  if (title !== undefined) element.title = title
  if (subtitle !== undefined) element.subtitle = subtitle
  return element
}
export function files(value: string, title: AnyElement | undefined, action: Action): FilesElement {
  const element: FilesElement = { type: 'files', value, action }
  if (title !== undefined) element.title = title
  return element
}
export function fileOperation(format: string, title: AnyElement | undefined, action: Action): FileOperationElement {
  const element: FileOperationElement = { type: 'fileOperation', action }
  if (format !== undefined) element.format = format
  if (title !== undefined) element.title = title
  return element
}
export function hstack(content: AnyElement[], options: { spacing?: number } = {}): HStackElement {
  const element: HStackElement = { type: 'hstack', content }
  if (options.spacing !== undefined) element.spacing = options.spacing
  return element
}
export function vstack(content: AnyElement[], options: { spacing?: number } = {}): VStackElement {
  const element: VStackElement = { type: 'vstack', content }
  if (options.spacing !== undefined) element.spacing = options.spacing
  return element
}
export function zstack(content: AnyElement[]): ZStackElement {
  return { type: 'zstack', content }
}
export function spacer(): SpacerElement {
  return { type: 'spacer' }
}
/** CommonMark inline text: bold, italic, code and links */
export function markdown(value: string): MarkdownElement {
  return { type: 'markdown', value }
}
export function image(
  source: { url: string } | { symbol: string },
  options: { width?: number; height?: number; mode?: 'fit' | 'fill'; cornerRadius?: number; color?: Color } = {},
): ImageElement {
  return defined({ type: 'image', ...source, ...options })
}
export function badge(value: string, options: { color?: Color } = {}): BadgeElement {
  return defined({ type: 'badge', value, color: options.color })
}
export function divider(): DividerElement {
  return { type: 'divider' }
}
export function link(title: string, url: string, options: { icon?: string } = {}): LinkElement {
  return defined({ type: 'link', title, url, icon: options.icon })
}
export function stat(title: string, value: Value, options: Omit<StatElement, 'type' | 'title' | 'value'> = {}): StatElement {
  return defined({ type: 'stat', title, value, ...options })
}
export function gauge(value: Value, options: Omit<GaugeElement, 'type' | 'value'> = {}): GaugeElement {
  return defined({ type: 'gauge', value, ...options })
}
export function series(name: string, data: string | ChartPoint[], options: { color?: Color } = {}): ChartSeries {
  return defined({ name, data, color: options.color })
}
export function chart(
  kind: ChartKind,
  data: ChartSeries | ChartSeries[],
  options: Omit<ChartElement, 'type' | 'kind' | 'series'> = {},
): ChartElement {
  return defined({ type: 'chart', kind, series: Array.isArray(data) ? data : [data], ...options })
}
export function column(title: string, key: string, options: Omit<TableColumn, 'title' | 'key'> = {}): TableColumn {
  return defined({ title, key, ...options })
}
/** Rows from `$key`; a column given as a string uses it as both title and key */
export function table(data: string, columns: (TableColumn | string)[]): TableElement {
  return { type: 'table', data, columns: columns.map(c => (typeof c === 'string' ? { title: c, key: c } : c)) }
}
export function grid(content: AnyElement[], options: { columns?: number; minWidth?: number; spacing?: number } = {}): GridElement {
  return defined({ type: 'grid', content, ...options })
}
export function section(
  title: string | undefined,
  content: AnyElement[],
  options: { subtitle?: string; style?: 'card' | 'plain' } = {},
): SectionElement {
  return defined({ type: 'section', title, content, ...options })
}
export function tab(title: string, content: AnyElement[], options: { icon?: string } = {}): Tab {
  return defined({ title, content, icon: options.icon })
}
export function tabs(items: Tab[], options: { selected?: string; style?: 'segmented' | 'tabs' } = {}): TabsElement {
  return defined({ type: 'tabs', tabs: items, ...options })
}
/** A button that opens a sheet with `content` */
export function sheet(title: string, content: AnyElement[], options: { icon?: string } = {}): SheetElement {
  return defined({ type: 'sheet', title, content, icon: options.icon })
}
export function action(action: Action & ActionExecution): ExecutableAction {
  return {
    header: {
      path: action.path,
      body: action.body,
      output: action.output,
    },
    execute: action.execute,
  }
}

/** Drops undefined fields so elements stay small on the wire */
function defined<T extends object>(value: T): T {
  for (const key of Object.keys(value) as (keyof T)[]) {
    if (value[key] === undefined) delete value[key]
  }
  return value
}
