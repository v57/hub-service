/** Device-layer hub API types (Docs/Devices/protocol.md, section 6). */

export interface Capabilities {
  cpu?: { cores?: number; model?: string }
  memory?: number
  gpu?: string
  disks?: { name: string; total?: number; free?: number }[]
  power?: 'ac' | 'battery'
  tools?: {
    xcode?: string
    swift?: string
    simulators?: string[]
    adb?: boolean
    docker?: boolean
    [key: string]: unknown
  }
  ssh?: { port: number; user?: string; hostKey: string; hostKeySignature: string }
  [key: string]: unknown
}

/** Body of `hub/device/describe`. */
export interface DeviceDescription {
  name?: string
  os?: string
  arch?: string
  capabilities?: Capabilities
}

/** Body of `hub/device/data`: free-form, with these known keys. */
export interface DeviceData {
  /** 0–1 */
  cpu?: number
  memoryUsed?: number
  /** 0–1 */
  battery?: number
  charging?: boolean
  network?: 'wifi' | 'cellular' | 'ethernet' | 'other'
  thermal?: string
  [key: string]: unknown
}

export interface Device {
  id: string
  key: string
  name: string
  platform?: string
  os?: string
  arch?: string
  parent?: string
  approved: boolean
  revoked: boolean
  online: boolean
  network?: 'online' | 'offline'
  /** ISO 8601 */
  lastSeen: string
  capabilities?: Capabilities
  services: { key: string; instance: string; name?: string; online: boolean; paths: string[] }[]
}

export interface PendingDevice {
  id: string
  key: string
  name?: string
  platform?: string
  parent?: string
  safetyCode: string
  firstSeen: string
}
