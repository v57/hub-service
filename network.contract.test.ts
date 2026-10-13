import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type {
  AgentAttestation,
  GatewayCapability,
  GatewayDiagnostic,
  GatewayGrant,
  GatewayRevocation,
  GatewayStatus,
  NetworkInvitation,
  NetworkPolicy,
  WireNetworkShare,
} from './network'

interface SharesReplaceFixture {
  version: 1
  type: 'shares.replace'
  requestId?: string
  payload: { shares: WireNetworkShare[] }
}

const fixturePath = fileURLToPath(
  new URL('./testdata/hub-network-v1/shares-replace.json', import.meta.url),
)
const invitationFixturePath = fileURLToPath(
  new URL('./testdata/hub-network-v1/invitation.json', import.meta.url),
)
const gatewayFixturePath = fileURLToPath(
  new URL('./testdata/hub-network-v1/gateway.json', import.meta.url),
)

interface InvitationFixture {
  envelope: NetworkInvitation
}

interface GatewayFixture {
  capability: GatewayCapability
  status: GatewayStatus
  grant: GatewayGrant
  revocation: GatewayRevocation
  diagnostic: GatewayDiagnostic
}

describe('Hub Network shared v1 contract fixture', () => {
  test('decodes and semantically round-trips share replacement', () => {
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as SharesReplaceFixture
    const share = fixture.payload.shares[0]
    const policy: NetworkPolicy | undefined = share.policy
    const attestation: AgentAttestation = share.attestation

    expect(fixture).toMatchObject({ version: 1, type: 'shares.replace' })
    expect(share).toMatchObject({
      version: 1,
      name: 's3',
      protocol: 'tcp',
      target: { host: '127.0.0.1', port: 9001 },
    })
    expect(policy).toEqual({ mode: 'group', group: 'editors' })
    expect(attestation.version).toBe(1)
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture)
  })

  test('decodes and semantically round-trips invitation', () => {
    const fixture = JSON.parse(
      readFileSync(invitationFixturePath, 'utf8'),
    ) as InvitationFixture
    const invitation: NetworkInvitation = fixture.envelope

    expect(invitation).toMatchObject({
      version: 1,
      signatureDomain: 'hub-network/invitation/v1',
      invitingAgentAddress: '100.96.0.2',
      hubProHost: '100.96.0.1',
    })
    expect(invitation.node).toBeUndefined()
    expect(invitation.scopes.map(scope => scope.audience)).toEqual([
      'node',
      'inviting-agent',
      'joiner',
      'hub-pro',
    ])
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture)
  })

  test('decodes and semantically round-trips gateway contract', () => {
    const fixture = JSON.parse(
      readFileSync(gatewayFixturePath, 'utf8'),
    ) as GatewayFixture
    const { capability, status, grant, revocation, diagnostic } = fixture

    expect(capability.capability).toBe('internet-gateway-v1')
    expect(status.capability).toEqual(capability)
    expect(status.state).toBe('available')
    expect(grant.gatewayKey).toBe(status.key)
    expect(grant.gatewayWireGuardKey).toBe(status.wireGuardKey)
    expect(revocation.generation).toBe(grant.generation + 1)
    expect(diagnostic.details).toEqual({ attempt: 2, dns: true })
    expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture)
  })
})
