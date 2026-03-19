import { Service } from '.'
import type { AppHeader } from './service'
import { LazyState } from 'channel/more'

export interface AppInterface {
  header?: AppHeader
  body?: AnyElement[]
  top?: AnyElement
  bottom?: AnyElement
  data?: Record<string, unknown>
}

interface AppOptions {
  top?: AnyElement
  bottom?: AnyElement
}

export class App {
  header: AppHeader
  body: AnyElement[]
  top?: AnyElement
  bottom?: AnyElement
  data: Record<string, unknown>
  state?: LazyState<AppInterface>
  executableActions: ExecutableAction[] = []
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
}

declare module '.' {
  interface Service {
    app(app: App): Service
  }
}

Service.prototype.app = function (app: App): Service {
  this.apps.push(app.header)
  const state = app.state
  for (const action of app.executableActions) {
    this.post(action.header.path, action.execute)
  }
  this.stream(app.header.path, async function* () {
    yield { header: app.header, body: app.body, top: app.top, bottom: app.bottom, data: app.data }
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
interface TextElement {
  type: 'text'
  value: string
  secondary?: boolean
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
export function text(value: string): string {
  return value
}
export function progress(value: string, options: { min?: number; max?: number } = {}): ProgressElement {
  const element: ProgressElement = { type: 'progress', value }
  if (options.min !== undefined) element.min = options.min
  if (options.max !== undefined) element.max = options.max
  return element
}
export function button(title: string, action: Action): ButtonElement {
  return { type: 'button', title, action }
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
