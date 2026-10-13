/**
 * Hub Network support for hub-service.
 *
 * This module adds network share publication, agent discovery,
 * and attestation handling for Bun services.
 */

export const HUB_NETWORK_WIRE_VERSION = 1 as const

export type WireVersion = typeof HUB_NETWORK_WIRE_VERSION
export type ResourceId = `hnr1_${string}`
export type Protocol = 'tcp' | 'udp'

/** Public, owner-configurable Hub identity returned during enrollment. */
export interface HubHeader {
  name: string
}

export type InvitationAudience =
  | 'node'
  | 'inviting-agent'
  | 'joiner'
  | 'hub-pro'

export type InvitationBootstrapAction =
  | 'bootstrap-rendezvous'
  | 'bootstrap-peer'
  | 'enroll-profile'
  | 'read-hub-header'

export interface InvitationBootstrapScope {
  audience: InvitationAudience
  actions: InvitationBootstrapAction[]
}

/** Canonical signed payload encoded by a Hub Network invitation. */
export interface NetworkInvitation {
  version: WireVersion
  signatureDomain: 'hub-network/invitation/v1'
  tokenId: string
  issuedAt: string
  expiresAt: string
  hubKey: string
  invitingKey: string
  invitingAgentAddress: string
  hubProHost: string
  /** Omitted for the protocol's default rendezvous node. */
  node?: string
  scopes: InvitationBootstrapScope[]
  signature: string
}

export interface GatewayCapability {
  version: WireVersion
  capability: 'internet-gateway-v1'
  ipv4: boolean
  ipv6: boolean
  dns: boolean
  metered: boolean
  updatedAt: string
}

export type GatewayState = 'disabled' | 'available' | 'unavailable'

export type GatewayDiagnosticValue = string | number | boolean

export interface NetworkGatewayError {
  version: WireVersion
  code: string
  message: string
  retryable: boolean
  details?: Record<string, GatewayDiagnosticValue>
}

export interface GatewayStatus {
  version: WireVersion
  hubNetworkId: string
  key: string
  wireGuardKey: string
  endpoint: string
  capability: GatewayCapability
  state: GatewayState
  updatedAt: string
  error?: NetworkGatewayError
}

export interface AgentProfile {
  version: WireVersion
  key: string
  wireGuardKey: string
  name?: string
  platform?: string
  overlayAddresses: string[]
  connectedAt: string
}

/** Hub-signed, five-minute authorization for one full-tunnel client. */
export interface GatewayGrant {
  version: WireVersion
  grantId: string
  hubKey: string
  hubNetworkId: string
  clientKey: string
  clientWireGuardKey: string
  gatewayKey: string
  gatewayWireGuardKey: string
  ipv4: boolean
  ipv6: boolean
  dns: boolean
  generation: number
  issuedAt: string
  expiresAt: string
  signature: string
}

export interface GatewayRevocation {
  version: WireVersion
  hubNetworkId: string
  gatewayKey: string
  generation: number
  revokedAt: string
  reason: string
}

export interface GatewayDiagnostic {
  version: WireVersion
  hubNetworkId: string
  gatewayKey: string
  code: string
  message: string
  retryable: boolean
  updatedAt: string
  details?: Record<string, GatewayDiagnosticValue>
}

export interface LocalTarget {
  host: string
  port: number
}

export type NetworkPolicyMode = 'hub' | 'group' | 'keys' | 'private' | 'disabled'

export type NetworkPolicy =
  | { mode: 'hub' }
  | { mode: 'group'; group: string }
  | { mode: 'keys'; keys: string[] }
  | { mode: 'private' }
  | { mode: 'disabled' }

export interface NetworkShare {
  name: string
  protocol: Protocol
  target: LocalTarget
  policy?: NetworkPolicy
}

export interface NetworkSharePublication {
  version: WireVersion
  resourceId: ResourceId
  authority: string
  providerId: string
  protocol: Protocol
  overlayAddress: string
  port: number
}

/**
 * `network/shares/replace` protocol v1 returns publications in request order.
 * v1 publications contain no share name, so clients must validate that order
 * before correlating each publication with its declared share.
 */

export interface AgentAttestation {
  version: WireVersion
  attestationId: string
  serviceKey: string
  key: string
  shareName: string
  protocol: Protocol
  target: LocalTarget
  issuedAt: string
  expiresAt: string
  signature: string
}

/** The versioned representation sent to the Hub after local-agent proof. */
export interface WireNetworkShare extends NetworkShare {
  version: WireVersion
  attestation: AgentAttestation
}

export interface NetworkSender {
  send(path: string, body: unknown): Promise<unknown>
}

export type AttestationProvider = (
  share: NetworkShare,
  serviceKey: string,
  sign: (data: string) => Promise<string>,
) => Promise<AgentAttestation>

export type LocalAgentErrorCode =
  | 'agent-unavailable'
  | 'agent-timeout'
  | 'agent-rejected'
  | 'invalid-agent-response'
  | 'attestation-mismatch'
  | 'attestation-expired'

export class LocalAgentError extends Error {
  constructor(
    public readonly code: LocalAgentErrorCode,
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LocalAgentError'
  }
}

export interface NetworkPublisherOptions {
  agentSocketPath?: string
  agentTimeoutMs?: number
}

const MACOS_AGENT_SOCKET = '/var/run/hub-net/agent.sock'
const MAX_SHARE_NAME_LENGTH = 255

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireNonEmptyString(value: unknown, field: string, maxLength?: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (maxLength !== undefined && value.length > maxLength)
  ) {
    throw new TypeError(`Invalid Hub Network ${field}`)
  }
  return value
}

function validatePort(value: unknown, field = 'target port'): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 65_535) {
    throw new TypeError(`Invalid Hub Network ${field}`)
  }
}

function validateShareName(value: unknown): asserts value is string {
  requireNonEmptyString(value, 'share name', MAX_SHARE_NAME_LENGTH)
}

function validatePolicy(value: unknown): asserts value is NetworkPolicy {
  if (!isRecord(value) || typeof value.mode !== 'string') {
    throw new TypeError('Invalid Hub Network policy')
  }
  switch (value.mode) {
    case 'hub':
    case 'private':
    case 'disabled':
      return
    case 'group':
      requireNonEmptyString(value.group, 'policy group')
      return
    case 'keys':
      if (
        !Array.isArray(value.keys) ||
        value.keys.length === 0 ||
        value.keys.some(key => {
          try {
            requireNonEmptyString(key, 'policy key')
            return false
          } catch {
            return true
          }
        })
      ) {
        throw new TypeError('Invalid Hub Network policy keys')
      }
      return
    default:
      throw new TypeError('Invalid Hub Network policy mode')
  }
}

export function validateNetworkShare(value: unknown): asserts value is NetworkShare {
  if (!isRecord(value)) throw new TypeError('Invalid Hub Network share')
  validateShareName(value.name)
  if (value.protocol !== 'tcp' && value.protocol !== 'udp') {
    throw new TypeError('Invalid Hub Network protocol')
  }
  if (!isRecord(value.target)) throw new TypeError('Invalid Hub Network target')
  requireNonEmptyString(value.target.host, 'target host')
  validatePort(value.target.port)
  if (value.policy !== undefined) validatePolicy(value.policy)
}

function validatePublication(
  value: unknown,
  share: NetworkShare,
  index: number,
): NetworkSharePublication {
  if (!isRecord(value)) {
    throw new TypeError(`Invalid Hub publication at share index ${index}`)
  }
  if (value.version !== HUB_NETWORK_WIRE_VERSION) {
    throw new TypeError(`Invalid Hub publication version at share index ${index}`)
  }
  if (
    typeof value.resourceId !== 'string' ||
    !value.resourceId.startsWith('hnr1_') ||
    value.resourceId.length === 'hnr1_'.length
  ) {
    throw new TypeError(`Invalid Hub publication resourceId at share index ${index}`)
  }
  requireNonEmptyString(value.authority, `publication authority at share index ${index}`)
  requireNonEmptyString(value.providerId, `publication providerId at share index ${index}`)
  requireNonEmptyString(
    value.overlayAddress,
    `publication overlayAddress at share index ${index}`,
  )
  if (value.protocol !== share.protocol) {
    throw new TypeError(`Hub publication protocol mismatch at share index ${index}`)
  }
  validatePort(value.port, `publication port at share index ${index}`)
  return value as unknown as NetworkSharePublication
}

/**
 * Network share publication manager.
 * Handles share registration, attestation, and Hub reconnection.
 */
export class NetworkPublisher {
  private shares = new Map<string, NetworkShare>()
  private publicationsByShare = new Map<string, NetworkSharePublication>()
  private reconnectCallbacks: Array<(publications: NetworkSharePublication[]) => void> = []
  private attestationProvider?: AttestationProvider
  private readonly agentSocketPath: string
  private readonly agentTimeoutMs: number

  constructor(attestationProvider?: AttestationProvider, options: NetworkPublisherOptions = {}) {
    this.attestationProvider = attestationProvider
    this.agentSocketPath = options.agentSocketPath ?? MACOS_AGENT_SOCKET
    this.agentTimeoutMs = options.agentTimeoutMs ?? 5_000
  }

  setAttestationProvider(provider: AttestationProvider): void {
    this.attestationProvider = provider
  }

  get declaredShares(): NetworkShare[] {
    return [...this.shares.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  get hasShares(): boolean {
    return this.shares.size > 0
  }

  /**
   * Declare a share before the Hub connection is available.
   *
   * The next connection synchronizes the complete declared set atomically.
   */
  declareShare(share: NetworkShare): void {
    validateNetworkShare(share)
    this.shares.set(share.name, share)
  }

  /**
   * Discover the local hub-net agent.
   * Returns true if agent is available.
   */
  async discoverAgent(): Promise<boolean> {
    try {
      // Any HTTP response proves the Unix socket speaks HTTP. The root endpoint
      // is allowed to be absent, so a 404 still counts as discovery.
      await this.agentFetch('/')
      return true
    } catch {
      return false
    }
  }

  /**
   * Get agent challenge and prove service identity.
   * Returns signed attestation for a share.
   */
  async requestAttestation(
    share: NetworkShare,
    serviceKey: string,
    sign: (data: string) => Promise<string>,
  ): Promise<AgentAttestation> {
    validateNetworkShare(share)
    // Publication can negotiate directly without requiring callers to perform
    // a separate discovery pass. This also preserves timeout vs unavailable
    // transport diagnostics from the real challenge request.
    const body = {
      serviceKey,
      shareName: share.name,
      protocol: share.protocol,
      target: share.target,
    }
    const response = await this.agentFetch('/challenge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    await this.requireAgentSuccess(response, 'challenge')
    const challenge = await this.agentJson<{ nonce?: unknown }>(response)
    if (typeof challenge.nonce !== 'string' || challenge.nonce.length === 0) {
      throw new LocalAgentError(
        'invalid-agent-response',
        'Hub Network agent returned an invalid challenge',
      )
    }

    const signature = await sign(challenge.nonce)
    const attestationResponse = await this.agentFetch('/attest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, signature }),
    })
    await this.requireAgentSuccess(attestationResponse, 'attestation')
    const attestation = await this.agentJson<AgentAttestation>(attestationResponse)
    this.validateAttestation(attestation, share, serviceKey)
    return attestation
  }

  private async agentFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.timeout(this.agentTimeoutMs)
    try {
      return await fetch(`http://localhost${path}`, {
        ...init,
        signal,
        unix: this.agentSocketPath,
      })
    } catch (error) {
      if (signal.aborted) {
        throw new LocalAgentError(
          'agent-timeout',
          `Hub Network agent timed out after ${this.agentTimeoutMs} ms`,
          undefined,
          { cause: error },
        )
      }
      throw new LocalAgentError(
        'agent-unavailable',
        `Hub Network agent is unavailable at ${this.agentSocketPath}`,
        undefined,
        { cause: error },
      )
    }
  }

  private async requireAgentSuccess(response: Response, operation: string): Promise<void> {
    if (response.ok) return
    const detail = (await response.text()).trim()
    throw new LocalAgentError(
      'agent-rejected',
      `Hub Network agent rejected ${operation} (${response.status})${detail ? `: ${detail}` : ''}`,
      response.status,
    )
  }

  private async agentJson<T>(response: Response): Promise<T> {
    try {
      return await response.json() as T
    } catch (error) {
      throw new LocalAgentError(
        'invalid-agent-response',
        'Hub Network agent returned invalid JSON',
        response.status,
        { cause: error },
      )
    }
  }

  private validateAttestation(
    attestation: AgentAttestation,
    share: NetworkShare,
    serviceKey: string,
  ): void {
    if (
      attestation?.version !== HUB_NETWORK_WIRE_VERSION ||
      attestation.serviceKey !== serviceKey ||
      attestation.shareName !== share.name ||
      attestation.protocol !== share.protocol ||
      attestation.target?.host !== share.target.host ||
      attestation.target?.port !== share.target.port
    ) {
      throw new LocalAgentError('attestation-mismatch', 'Local-agent attestation does not match the share')
    }
    const issuedAt = Date.parse(attestation.issuedAt)
    const expiresAt = Date.parse(attestation.expiresAt)
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      issuedAt > Date.now() + 30_000 ||
      expiresAt <= Date.now()
    ) {
      throw new LocalAgentError('attestation-expired', 'Local-agent attestation is expired')
    }
  }

  /**
   * Publish a network share through Hub.
   */
  async publishShare(
    share: NetworkShare,
    serviceKey: string,
    sign: (data: string) => Promise<string>,
    sender: NetworkSender,
  ): Promise<NetworkSharePublication[]> {
    validateNetworkShare(share)
    const previous = this.shares.get(share.name)
    this.shares.set(share.name, share)
    try {
      return await this.synchronize(serviceKey, sign, sender)
    } catch (error) {
      if (previous) this.shares.set(share.name, previous)
      else this.shares.delete(share.name)
      throw error
    }
  }

  /**
   * Publish all registered shares (called on Hub reconnect).
   */
  async republishAll(
    serviceKey: string,
    sign: (data: string) => Promise<string>,
    sender: NetworkSender,
  ): Promise<NetworkSharePublication[]> {
    const publications = await this.synchronize(serviceKey, sign, sender)
    for (const callback of this.reconnectCallbacks) {
      callback(publications)
    }
    return publications
  }

  /**
   * Remove a published share.
   */
  async removeShare(
    shareName: string,
    serviceKey: string,
    sign: (data: string) => Promise<string>,
    sender: NetworkSender,
  ): Promise<NetworkSharePublication[]> {
    validateShareName(shareName)
    const removed = this.shares.get(shareName)
    if (!removed) {
      throw new Error(`Share '${shareName}' not found`)
    }
    this.shares.delete(shareName)
    try {
      return await this.synchronize(serviceKey, sign, sender)
    } catch (error) {
      this.shares.set(shareName, removed)
      throw error
    }
  }

  /**
   * Register a callback for Hub reconnect events.
   */
  onReconnect(callback: (publications: NetworkSharePublication[]) => void): void {
    this.reconnectCallbacks.push(callback)
  }

  /**
   * Get current publications.
   */
  getPublications(): NetworkSharePublication[] {
    return [...this.publicationsByShare.values()]
  }

  /**
   * Get a specific publication by share name.
   */
  getPublication(shareName: string): NetworkSharePublication | undefined {
    return this.publicationsByShare.get(shareName)
  }

  private async synchronize(
    serviceKey: string,
    sign: (data: string) => Promise<string>,
    sender: NetworkSender,
  ): Promise<NetworkSharePublication[]> {
    const shares = this.declaredShares
    const wireShares: WireNetworkShare[] = []
    for (const share of shares) {
      validateNetworkShare(share)
      const attestation = await (this.attestationProvider
        ? this.attestationProvider(share, serviceKey, sign)
        : this.requestAttestation(share, serviceKey, sign))
      this.validateAttestation(attestation, share, serviceKey)
      wireShares.push({ ...share, version: HUB_NETWORK_WIRE_VERSION, attestation })
    }

    const response = await sender.send('network/shares/replace', { shares: wireShares })
    if (!isRecord(response) || !Array.isArray(response.shares)) {
      throw new TypeError('Hub returned an invalid shares/replace response')
    }
    const publications = response.shares
    if (publications.length !== shares.length) {
      throw new Error(
        `Hub returned ${publications.length} publications for ${shares.length} shares`,
      )
    }

    // Protocol v1 response contains no share name. Hub must preserve request
    // order; validate each publication against its request before correlating.
    const correlated = new Map<string, NetworkSharePublication>()
    const resourceIds = new Set<string>()
    for (let index = 0; index < shares.length; index++) {
      const share = shares[index]
      const publication = publications[index]
      if (!share || !publication) {
        throw new Error(`Hub publication mismatch at share index ${index}`)
      }
      const validated = validatePublication(publication, share, index)
      if (resourceIds.has(validated.resourceId)) {
        throw new TypeError(`Hub returned duplicate resourceId at share index ${index}`)
      }
      resourceIds.add(validated.resourceId)
      correlated.set(share.name, validated)
    }
    this.publicationsByShare = correlated
    return [...correlated.values()]
  }
}
