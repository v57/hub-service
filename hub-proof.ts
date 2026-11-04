// Auth v2's client side (Docs/Devices/protocol.md section 2), on Web Crypto so it also runs in browsers.

/** How a connection to an address travels */
export type HubTransport = 'encrypted' | 'loopback' | 'overlay' | 'localNetwork' | 'refused'

/** An answer to `hub/info` with a nonce */
export interface HubProof {
  key: string
  proof: string
  challenge: string
}

export function makeClientNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/** The string `proof` signs */
export function hubInfoSignedData(hubKey: string, nonce: string): string {
  return `hubinfo1:${hubKey}:${nonce}`
}

const fromBase64 = (text: string) => Uint8Array.from(atob(text), c => c.charCodeAt(0))

/** Whether a `hub/info` answer proves its key over `nonce`. A relayed answer passes too: it never decides credentials. */
export async function verifyHubProof(info: any, nonce: string): Promise<boolean> {
  if (typeof info?.key !== 'string' || typeof info?.proof !== 'string' || typeof info?.challenge !== 'string') return false
  try {
    const key = await crypto.subtle.importKey('spki', fromBase64(info.key), { name: 'Ed25519' }, false, ['verify'])
    return await crypto.subtle.verify('Ed25519', key, fromBase64(info.proof), new TextEncoder().encode(hubInfoSignedData(info.key, nonce)))
  } catch {
    return false
  }
}

function ipv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.')
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return
  const bytes = parts.map(Number)
  return bytes.every(byte => byte <= 255) ? (bytes as [number, number, number, number]) : undefined
}

/** Classifies an address before anything is dialed: `refused` is plain `ws://` beyond loopback, the overlay and the LAN */
export function hubTransport(address: string | number): HubTransport {
  if (typeof address === 'number' || /^\d+$/.test(address)) return 'loopback'
  const match = address.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(?:[^/?#@]*@)?(\[[^\]]*\]|[^/?#:]*)/)
  if (!match) return 'refused'
  const scheme = match[1]!.toLowerCase()
  const host = match[2]!.toLowerCase().replace(/\.$/, '')
  if (scheme === 'wss' || scheme === 'https' || scheme === 'quic') return 'encrypted'
  if (scheme !== 'ws' && scheme !== 'http') return 'refused'
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1)
    if (v6 === '::1') return 'loopback'
    if (/^f[cd]/.test(v6) || /^fe[89ab]/.test(v6)) return 'localNetwork'
    return 'refused'
  }
  const v4 = ipv4(host)
  if (v4) {
    const [a, b] = v4
    if (a === 127) return 'loopback'
    if (a === 100 && b >= 64 && b <= 127) return 'overlay'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return 'localNetwork'
    return 'refused'
  }
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  if (host.endsWith('.hub.invalid')) return 'overlay'
  if (host.endsWith('.local')) return 'localNetwork'
  return 'refused'
}
