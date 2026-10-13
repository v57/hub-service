import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  HUB_NETWORK_WIRE_VERSION,
  LocalAgentError,
  NetworkPublisher,
  type NetworkShare,
} from './network'

const servers: Bun.Server<undefined>[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

describe('macOS local-agent IPC', () => {
  test('discovers the Unix socket and negotiates a fresh attestation', async () => {
    const socket = join(tmpdir(), `hub-net-agent-${process.pid}-${crypto.randomUUID()}.sock`)
    const requests: Array<{ path: string; body: any }> = []
    servers.push(Bun.serve({
      unix: socket,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/') return new Response('not found', { status: 404 })
        const body = await request.json()
        requests.push({ path: url.pathname, body })
        if (url.pathname === '/challenge') {
          return Response.json({ nonce: 'hub-network/local-agent/challenge/v1:fresh' })
        }
        return Response.json({
          version: HUB_NETWORK_WIRE_VERSION,
          attestationId: crypto.randomUUID(),
          serviceKey: body.serviceKey,
          key: 'agent-key',
          shareName: body.shareName,
          protocol: body.protocol,
          target: body.target,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          signature: 'agent-signature',
        })
      },
    }))

    const publisher = new NetworkPublisher(undefined, { agentSocketPath: socket })
    expect(await publisher.discoverAgent()).toBeTrue()
    const signed: string[] = []
    const attestation = await publisher.requestAttestation(
      share(),
      'service-key',
      async challenge => {
        signed.push(challenge)
        return 'service-signature'
      },
    )

    expect(signed).toEqual(['hub-network/local-agent/challenge/v1:fresh'])
    expect(requests.map(item => item.path)).toEqual(['/challenge', '/attest'])
    expect(requests[1].body.signature).toBe('service-signature')
    expect(attestation.shareName).toBe('s3')
  })

  test('reports an unavailable socket with a stable error code', async () => {
    const publisher = new NetworkPublisher(undefined, {
      agentSocketPath: join(tmpdir(), `missing-hub-net-${crypto.randomUUID()}.sock`),
      agentTimeoutMs: 100,
    })

    try {
      await publisher.requestAttestation(share(), 'service-key', async () => 'signature')
      throw new Error('expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalAgentError)
      expect((error as LocalAgentError).code).toBe('agent-unavailable')
    }
  })

  test('rejects an expired attestation before publishing it', async () => {
    const socket = join(tmpdir(), `hub-net-agent-${process.pid}-${crypto.randomUUID()}.sock`)
    servers.push(Bun.serve({
      unix: socket,
      async fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === '/') return new Response()
        const body = await request.json()
        if (url.pathname === '/challenge') return Response.json({ nonce: 'challenge' })
        return Response.json({
          version: 1,
          attestationId: 'expired',
          serviceKey: body.serviceKey,
          key: 'agent-key',
          shareName: body.shareName,
          protocol: body.protocol,
          target: body.target,
          issuedAt: new Date(Date.now() - 120_000).toISOString(),
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          signature: 'agent-signature',
        })
      },
    }))
    const publisher = new NetworkPublisher(undefined, { agentSocketPath: socket })

    try {
      await publisher.requestAttestation(share(), 'service-key', async () => 'signature')
      throw new Error('expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalAgentError)
      expect((error as LocalAgentError).code).toBe('attestation-expired')
    }
  })

  test('rejects an expired injected attestation before Hub registration', async () => {
    const publisher = new NetworkPublisher(async (requestedShare, serviceKey) => ({
      version: HUB_NETWORK_WIRE_VERSION,
      attestationId: 'expired-provider-attestation',
      serviceKey,
      key: 'agent-key',
      shareName: requestedShare.name,
      protocol: requestedShare.protocol,
      target: requestedShare.target,
      issuedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      signature: 'agent-signature',
    }))
    let registrationAttempts = 0

    try {
      await publisher.publishShare(
        share(),
        'service-key',
        async () => 'signature',
        {
          async send() {
            registrationAttempts += 1
            return { shares: [] }
          },
        },
      )
      throw new Error('expected request to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(LocalAgentError)
      expect((error as LocalAgentError).code).toBe('attestation-expired')
      expect(registrationAttempts).toBe(0)
    }
  })
})

function share(): NetworkShare {
  return {
    name: 's3',
    protocol: 'tcp',
    target: { host: '127.0.0.1', port: 9001 },
    policy: { mode: 'hub' },
  }
}
