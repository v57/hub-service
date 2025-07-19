import { Service } from './service'
import type { AppHeader } from './service'

export class App {
  header: AppHeader
  body: AnyElement[]
  data: Record<string, string>
  executableActions: ExecutableAction[] = []
  constructor(header: AppHeader, body: AnyElement[], data: Record<string, string> = {}) {
    this.header = header
    this.body = body
    this.data = data
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
  for (const action of app.executableActions) {
    this.post(action.header.path, action.execute)
  }
  this.stream(app.header.path, async function* () {
    yield { header: app.header, body: app.body }
  })
  return this
}

type AnyElement =
  | string
  | TextElement
  | TextFieldElement
  | ButtonElement
  | ListElement
  | PickerElement
  | CellElement
  | FilesElement
interface TextElement {
  type: 'text'
  value: string
  secondary?: boolean
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
interface ListElement {
  type: 'list'
  data: string
  cell: AnyElement
}
interface PickerElement {
  type: 'picker'
  options: string[]
  selected: string
}
interface CellElement {
  type: 'cell'
  title: AnyElement
  subtitle?: AnyElement
}
interface FilesElement {
  type: 'files'
  value: string
  title: AnyElement
  action?: Action
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

export function textField(value: string, options: { placeholder?: string; action?: Action }): TextFieldElement {
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
export function button(title: string, action: Action): ButtonElement {
  return { type: 'button', title, action }
}
export function list(data: string, cell: AnyElement): ListElement {
  return { type: 'list', data, cell }
}
export function picker(options: string[], selected: string): PickerElement {
  return { type: 'picker', options, selected }
}
export function cell(title: AnyElement, subtitle: AnyElement): CellElement {
  return { type: 'cell', title, subtitle }
}
export function files(value: string, title: AnyElement, action: Action): FilesElement {
  return { type: 'files', value, title, action }
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
