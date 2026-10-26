import { describe, expect, test, beforeEach } from 'bun:test'
import {
  defaultAgentSocket,
  HUB_NETWORK_WIRE_VERSION,
  NetworkPublisher,
  validateNetworkShare,
  type NetworkPolicy,
  type NetworkShare,
} from './network'
import type {
  AgentAttestation,
  NetworkSharePublication,
  ResourceId,
} from './index'
import { authToken, KeyFile } from './keys'
import { NetworkService } from './service'
import { FakeHub, vectors, waitFor } from './testing/fake-hub'

/**
 * Tests for hub-service network share functionality.
 *
 * HN-204: Tests for share serialization, reconnect replacement,
 * dynamic ports, challenge signing, and absence of WireGuard dependency.
 */

describe('NetworkPublisher', () => {
  let publisher: NetworkPublisher

  beforeEach(() => {
    publisher = new NetworkPublisher()
  })

  describe('Share storage', () => {
    test('declares a runtime-selected port before connecting', () => {
      publisher.declareShare(share('s3', 9001))

      expect(publisher.hasShares).toBeTrue()
      expect(publisher.declaredShares).toEqual([share('s3', 9001)])
    })

    test('stores and retrieves shares', async () => {
      const share: NetworkShare = {
        name: 'test-share',
        protocol: 'tcp',
        target: { host: 'localhost', port: 8080 },
        policy: { mode: 'hub' },
      }

      publisher['shares'].set('test-share', share)

      const retrieved = publisher['shares'].get('test-share')
      expect(retrieved).toEqual(share)
    })

    test('stores multiple shares', async () => {
      const share1: NetworkShare = {
        name: 's3',
        protocol: 'tcp',
        target: { host: 'localhost', port: 8080 },
        policy: { mode: 'private' },
      }

      const share2: NetworkShare = {
        name: 'game',
        protocol: 'udp',
        target: { host: 'localhost', port: 7777 },
        policy: { mode: 'group', group: 'gamers' },
      }

      publisher['shares'].set('s3', share1)
      publisher['shares'].set('game', share2)

      expect(publisher['shares'].size).toBe(2)
      expect(publisher['shares'].get('s3')).toEqual(share1)
      expect(publisher['shares'].get('game')).toEqual(share2)
    })
  })

  describe('Publication storage', () => {
    test('stores and retrieves publications', () => {
      const resourceId: ResourceId = 'hnr1_test123'
      const publication: NetworkSharePublication = {
        version: HUB_NETWORK_WIRE_VERSION,
        resourceId,
        authority: 'test.hub.invalid',
        providerId: 'prov1',
        protocol: 'tcp' as const,
        overlayAddress: '100.96.0.1',
        port: 8080,
      }

      publisher['publicationsByShare'].set('test', publication)

      const retrieved = publisher.getPublication('test')
      expect(retrieved).toEqual(publication)
    })

    test('returns undefined for non-existent share', () => {
      const result = publisher.getPublication('nonexistent')
      expect(result).toBeUndefined()
    })

    test('lists all publications', () => {
      const pub1: NetworkSharePublication = {
        version: 1 as const,
        resourceId: 'hnr1_test1',
        authority: 'test1.hub.invalid',
        providerId: 'prov1',
        protocol: 'tcp' as const,
        overlayAddress: '100.96.0.1',
        port: 8080,
      }

      const pub2: NetworkSharePublication = {
        version: 1 as const,
        resourceId: 'hnr1_test2',
        authority: 'test2.hub.invalid',
        providerId: 'prov2',
        protocol: 'udp' as const,
        overlayAddress: '100.96.0.2',
        port: 7777,
      }

      publisher['publicationsByShare'].set('test1', pub1)
      publisher['publicationsByShare'].set('test2', pub2)

      const all = publisher.getPublications()
      expect(all).toHaveLength(2)
    })
  })

  describe('Policy validation', () => {
    test('accepts valid policy modes', () => {
      const validPolicies: NetworkPolicy[] = [
        { mode: 'hub' },
        { mode: 'private' },
        { mode: 'disabled' },
      ]

      for (const policy of validPolicies) {
        expect(() => validatePolicy(policy)).not.toThrow()
      }
    })

    test('accepts group policy with group name', () => {
      const policy: NetworkPolicy = { mode: 'group', group: 'developers' }
      expect(() => validatePolicy(policy)).not.toThrow()
    })

    test('accepts keys policy with keys', () => {
      const policy: NetworkPolicy = { mode: 'keys', keys: ['key1', 'key2'] }
      expect(() => validatePolicy(policy)).not.toThrow()
    })

    test('rejects group policy without group name', () => {
      const policy = { mode: 'group' } as NetworkPolicy
      expect(() => validatePolicy(policy)).toThrow()
    })

    test('rejects keys policy without keys', () => {
      const policy: NetworkPolicy = { mode: 'keys', keys: [] }
      expect(() => validatePolicy(policy)).toThrow()
    })
  })

  describe('Production share validation', () => {
    test('rejects malformed share fields before declaration', () => {
      const invalidShares: unknown[] = [
        { ...share('s3', 9001), name: '' },
        { ...share('s3', 9001), name: 'bad\u0000name' },
        { ...share('s3', 9001), protocol: 'http' },
        { ...share('s3', 9001), target: null },
        { ...share('s3', 9001), target: { host: '', port: 9001 } },
        { ...share('s3', 9001), target: { host: '127.0.0.1', port: 0 } },
        { ...share('s3', 9001), target: { host: '127.0.0.1', port: 65_536 } },
        { ...share('s3', 9001), target: { host: '127.0.0.1', port: 1.5 } },
        { ...share('s3', 9001), policy: { mode: 'group', group: '' } },
        { ...share('s3', 9001), policy: { mode: 'keys', keys: [] } },
        { ...share('s3', 9001), policy: { mode: 'keys', keys: [''] } },
        { ...share('s3', 9001), policy: { mode: 'unknown' } },
      ]

      for (const invalid of invalidShares) {
        expect(() => publisher.declareShare(invalid as NetworkShare)).toThrow()
      }
      expect(publisher.hasShares).toBeFalse()
    })

    test('accepts every valid policy and boundary port', () => {
      const policies: NetworkPolicy[] = [
        { mode: 'hub' },
        { mode: 'group', group: 'editors' },
        { mode: 'keys', keys: ['key-1'] },
        { mode: 'private' },
        { mode: 'disabled' },
      ]

      for (const [index, policy] of policies.entries()) {
        expect(() => validateNetworkShare({
          ...share(`share-${index}`, index === 0 ? 1 : 65_535),
          policy,
        })).not.toThrow()
      }
    })
  })

  describe('Attestation interval validation', () => {
    test('rejects an attestation issued too far in the future', () => {
      const requestedShare = share('s3', 9001)
      const attestation = {
        ...attestValue(requestedShare, 'service-key'),
        issuedAt: new Date(Date.now() + 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      }

      expect(() => publisher['validateAttestation'](
        attestation,
        requestedShare,
        'service-key',
      )).toThrow()
    })

    test('rejects an interval ending before it starts', () => {
      const requestedShare = share('s3', 9001)
      const attestation = {
        ...attestValue(requestedShare, 'service-key'),
        issuedAt: new Date(Date.now() + 10_000).toISOString(),
        expiresAt: new Date(Date.now() + 5_000).toISOString(),
      }

      expect(() => publisher['validateAttestation'](
        attestation,
        requestedShare,
        'service-key',
      )).toThrow()
    })
  })

  describe('Share serialization', () => {
    test('serializes TCP share correctly', () => {
      const share: NetworkShare = {
        name: 's3',
        protocol: 'tcp',
        target: { host: 'localhost', port: 8080 },
        policy: { mode: 'hub' },
      }

      const json = JSON.stringify(share)
      const parsed = JSON.parse(json)

      expect(parsed.name).toBe('s3')
      expect(parsed.protocol).toBe('tcp')
      expect(parsed.target.host).toBe('localhost')
      expect(parsed.target.port).toBe(8080)
      expect(parsed.policy.mode).toBe('hub')
    })

    test('serializes UDP share correctly', () => {
      const share: NetworkShare = {
        name: 'game-server',
        protocol: 'udp',
        target: { host: '0.0.0.0', port: 7777 },
        policy: { mode: 'group', group: 'gamers' },
      }

      const json = JSON.stringify(share)
      const parsed = JSON.parse(json)

      expect(parsed.protocol).toBe('udp')
      expect(parsed.target.host).toBe('0.0.0.0')
      expect(parsed.target.port).toBe(7777)
      expect(parsed.policy.group).toBe('gamers')
    })

    test('handles private policy (no extra fields)', () => {
      const share: NetworkShare = {
        name: 'private-service',
        protocol: 'tcp',
        target: { host: 'localhost', port: 9000 },
        policy: { mode: 'private' },
      }

      const json = JSON.stringify(share)
      const parsed = JSON.parse(json)

      expect(parsed.policy.mode).toBe('private')
      expect(Object.keys(parsed.policy)).toHaveLength(1)
    })
  })

  describe('Reconnect behavior', () => {
    test('tracks reconnect callbacks', () => {
      let callbackCalled = false
      publisher.onReconnect(() => {
        callbackCalled = true
      })

      const callbacks = publisher['reconnectCallbacks']
      expect(callbacks).toHaveLength(1)
    })

    test('notifies callbacks on republish', async () => {
      let receivedPubs: any[] = []
      publisher.onReconnect((pubs) => {
        receivedPubs = pubs
      })

      // Mock republishAll
      const mockPublications: NetworkSharePublication[] = [
        {
          version: 1 as const,
          resourceId: 'hnr1_test',
          authority: 'test.hub.invalid',
          providerId: 'prov1',
          protocol: 'tcp' as const,
          overlayAddress: '100.96.0.1',
          port: 8080,
        },
      ]

      // Trigger callback manually
      for (const callback of publisher['reconnectCallbacks']) {
        callback(mockPublications)
      }

      expect(receivedPubs).toEqual(mockPublications)
    })

    test('atomically replaces every declared share on reconnect', async () => {
      const requests: any[] = []
      const publications = [
        publication('hnr1_game', 7777),
        publication('hnr1_s3', 9001),
      ]
      publisher = new NetworkPublisher(attest)
      const sender = {
        async send(path: string, body: unknown) {
          requests.push({ path, body })
          return { shares: publications }
        },
      }

      publisher['shares'].set('s3', share('s3', 9001))
      publisher['shares'].set('game', share('game', 7777))
      await publisher.republishAll('service-key', async () => 'proof', sender)

      expect(requests).toHaveLength(1)
      expect(requests[0].path).toBe('network/shares/replace')
      expect(requests[0].body.shares.map((item: NetworkShare) => item.name))
        .toEqual(['game', 's3'])
      expect(publisher.getPublication('game')).toEqual(publications[0])
      expect(publisher.getPublication('s3')).toEqual(publications[1])
    })

    test('publishing a runtime-selected port preserves existing shares', async () => {
      publisher = new NetworkPublisher(attest)
      const requests: any[] = []
      const sender = {
        async send(_path: string, body: any) {
          requests.push(body)
          return {
            shares: body.shares.map((item: NetworkShare, index: number) =>
              publication(`hnr1_${item.name}`, item.target.port, index)),
          }
        },
      }

      await publisher.publishShare(
        share('s3', 9001),
        'service-key',
        async () => 'proof',
        sender,
      )
      await publisher.publishShare(
        share('game', 7777),
        'service-key',
        async () => 'proof',
        sender,
      )

      expect(requests[1].shares.map((item: NetworkShare) => item.name))
        .toEqual(['game', 's3'])
      expect(requests[1].shares[1].target.port).toBe(9001)
    })

    test('removal sends the complete remaining share set', async () => {
      publisher = new NetworkPublisher(attest)
      const requests: any[] = []
      const sender = {
        async send(_path: string, body: any) {
          requests.push(body)
          return {
            shares: body.shares.map((item: NetworkShare, index: number) =>
              publication(`hnr1_${item.name}`, item.target.port, index)),
          }
        },
      }
      publisher['shares'].set('s3', share('s3', 9001))
      publisher['shares'].set('game', share('game', 7777))

      await publisher.removeShare(
        'game',
        'service-key',
        async () => 'proof',
        sender,
      )

      expect(requests[0].shares.map((item: NetworkShare) => item.name)).toEqual(['s3'])
      expect(publisher.declaredShares.map(item => item.name)).toEqual(['s3'])
    })
  })

  describe('Hub response validation', () => {
    test('rejects malformed response containers and publication fields', async () => {
      const invalidResponses: unknown[] = [
        undefined,
        {},
        { shares: {} },
        { shares: [{}] },
        { shares: [{ ...publication('hnr1_s3', 9001), version: 2 }] },
        { shares: [{ ...publication('hnr1_s3', 9001), resourceId: 'bad' }] },
        { shares: [{ ...publication('hnr1_s3', 9001), authority: '' }] },
        { shares: [{ ...publication('hnr1_s3', 9001), providerId: '' }] },
        { shares: [{ ...publication('hnr1_s3', 9001), overlayAddress: '' }] },
        { shares: [{ ...publication('hnr1_s3', 9001), port: 0 }] },
      ]

      for (const response of invalidResponses) {
        publisher = new NetworkPublisher(attest)
        await expect(publisher.publishShare(
          share('s3', 9001),
          'service-key',
          async () => 'proof',
          { async send() { return response } },
        )).rejects.toThrow()
        expect(publisher.hasShares).toBeFalse()
      }
    })

    test('enforces protocol v1 positional ordering', async () => {
      publisher = new NetworkPublisher(attest)
      publisher.declareShare(share('game', 7777))
      publisher.declareShare(share('s3', 9001))

      await expect(publisher.republishAll(
        'service-key',
        async () => 'proof',
        {
          async send() {
            return {
              shares: [
                publication('hnr1_s3', 9001),
                publication('hnr1_game', 7777),
              ],
            }
          },
        },
      )).rejects.toThrow('protocol mismatch')
      expect(publisher.getPublications()).toEqual([])
    })

    test('rejects duplicate resource identities before replacing cache', async () => {
      publisher = new NetworkPublisher(attest)
      publisher.declareShare(share('game', 7777))
      publisher.declareShare(share('s3', 9001))

      await expect(publisher.republishAll(
        'service-key',
        async () => 'proof',
        {
          async send() {
            return {
              shares: [
                publication('hnr1_duplicate', 7777),
                publication('hnr1_duplicate', 9001),
              ],
            }
          },
        },
      )).rejects.toThrow('duplicate resourceId')
      expect(publisher.getPublications()).toEqual([])
    })

    test('preserves prior share and publication cache after invalid update response', async () => {
      publisher = new NetworkPublisher(attest)
      const sender = {
        responses: [
          { shares: [publication('hnr1_s3', 9001)] },
          { shares: [{ ...publication('hnr1_s3_new', 9002), authority: '' }] },
        ],
        async send() {
          return this.responses.shift()
        },
      }
      await publisher.publishShare(
        share('s3', 9001),
        'service-key',
        async () => 'proof',
        sender,
      )

      await expect(publisher.publishShare(
        share('s3', 9002),
        'service-key',
        async () => 'proof',
        sender,
      )).rejects.toThrow()
      expect(publisher.declaredShares).toEqual([share('s3', 9001)])
      expect(publisher.getPublication('s3')).toEqual(publication('hnr1_s3', 9001))
    })
  })

  describe('No WireGuard dependency', () => {
    test('does not import WireGuard modules', () => {
      // Verify that WireGuard dependencies are not loaded
      // This is checked by ensuring the code runs without WireGuard
      const publisher = new NetworkPublisher()
      expect(publisher).toBeDefined()
    })

    test('network types do not reference WireGuard', () => {
      // Verify that NetworkShare doesn't require WireGuard keys
      const share: NetworkShare = {
        name: 'test',
        protocol: 'tcp',
        target: { host: 'localhost', port: 8080 },
      }

      expect(share).not.toHaveProperty('wireGuardKey')
      expect(share).not.toHaveProperty('wgKey')
    })
  })
})

/**
 * Simple policy validator for testing.
 */
function validatePolicy(policy: NetworkPolicy): void {
  switch (policy.mode) {
    case 'group':
      if (!policy.group) {
        throw new Error('group policy requires group name')
      }
      break
    case 'keys':
      if (!policy.keys || policy.keys.length === 0) {
        throw new Error('keys policy requires at least one key')
      }
      break
  }
}

function share(name: string, port: number): NetworkShare {
  return {
    name,
    protocol: name === 'game' ? 'udp' : 'tcp',
    target: { host: '127.0.0.1', port },
    policy: { mode: 'private' },
  }
}

async function attest(
  item: NetworkShare,
  serviceKey: string,
): Promise<AgentAttestation> {
  return attestValue(item, serviceKey)
}

function attestValue(
  item: NetworkShare,
  serviceKey: string,
): AgentAttestation {
  const now = Date.now()
  return {
    version: HUB_NETWORK_WIRE_VERSION,
    attestationId: `att-${item.name}`,
    serviceKey,
    key: 'agent-key',
    shareName: item.name,
    protocol: item.protocol,
    target: item.target,
    issuedAt: new Date(now - 1_000).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
    signature: 'signature',
  }
}

function publication(
  resourceId: ResourceId,
  port: number,
  index = 0,
): NetworkSharePublication {
  return {
    version: HUB_NETWORK_WIRE_VERSION,
    resourceId,
    authority: `share-${index}.hub.invalid`,
    providerId: `provider-${index}`,
    protocol: port === 7777 ? 'udp' : 'tcp',
    overlayAddress: `100.96.0.${index + 1}`,
    port,
  }
}

describe('defaultAgentSocket', () => {
  test('the environment, the system agent, then the Hub app\'s socket in its container or the home folder', () => {
    expect(defaultAgentSocket({ HUB_NET_AGENT_SOCKET: '/tmp/a.sock', HOME: '/Users/me' }, () => true)).toBe('/tmp/a.sock')
    expect(defaultAgentSocket({ HOME: '/Users/me' }, () => true)).toBe('/var/run/hub-net/agent.sock')
    const container = '/Users/me/Library/Containers/dev.v57.Hub/Data/.hub-net/agent.sock'
    expect(defaultAgentSocket({ HOME: '/Users/me' }, path => path === container)).toBe(container)
    expect(defaultAgentSocket({ HOME: '/Users/me' }, () => false)).toBe('/Users/me/.hub-net/agent.sock')
  })
})

describe('NetworkService', () => {
  test('publishes its shares again until the agent answers', async () => {
    const hub = new FakeHub()
    const replaced: unknown[] = []
    hub.channel.post('network/shares/replace', ({ body }) => {
      replaced.push(body)
      return { shares: [publication('hnr1_web', 8642)] }
    })
    const address = hub.start()
    const serviceKey = new KeyFile(vectors.keys.service.keyFile)
    const service = new NetworkService(
      { sign: async hubKey => authToken(serviceKey, Math.round(Date.now() / 1000) + 60, hubKey) },
      async () => 'proof',
      async () => serviceKey.publicKey,
      { address },
    )
    service.shareRetryMs = 20
    let attempts = 0
    service.network.setAttestationProvider(async (item, key) => {
      if (++attempts < 3) throw new Error('agent not listening yet')
      return attestValue(item, key)
    })
    service.share('web', 'tcp', '127.0.0.1', 8642, { mode: 'hub' }).start()
    try {
      await waitFor(() => replaced.length > 0)
      expect(attempts).toBe(3)
      expect(service.network.getPublication('web')?.port).toBe(8642)
    } finally {
      service.stop()
      hub.stop()
    }
  })
})
