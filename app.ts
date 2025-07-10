import { Service } from '.'

export class App {
  header: AppHeader
  body: AnyElement[]
  data: Record<string, string>
  constructor(header: AppHeader, body: AnyElement[], data: Record<string, string> = {}) {
    this.header = header
    this.body = body
    this.data = data
  }
}

declare module '.' {
  interface Service {
    app(app: App): Service
  }
}

Service.prototype.app = function (app: App): Service {
  this.stream(app.header.path, async function* () {
    yield { header: app.header }
  })
  return this
}

interface AppHeader {
  name: string
  path: string
}

type AnyElement = string | TextElement | TextFieldElement | ButtonElement | ListElement | PickerElement | CellElement
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
interface Action {
  path: string
  body?: string | Record<string, string>
  output?: string | Record<string, string>
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
