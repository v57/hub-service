# Service features: authorization, errors, limits, cancellation, readiness

What a service needs beyond `post` and `stream` when real users call it: who may call, typed errors, per-caller rate
limits, input validation, cancellation, readiness and graceful shutdown. The TypeScript SDK (this repo) is the
reference and the Swift SDK (`HubService`) follows it. The last section is the contract for the other ports.

Needs: a hub with channel wire v2 errors and the hub APIs below (hub-server and the Swift HubServer since
2026-10-21). Older hubs still work: the SDK checks fail closed and `draining` is ignored.

## Who may call

The hub forwards every call with `context.hub.caller` = `{ key?, device?: { id, name }, groups, owner, via? }`
(`Docs/Devices/protocol.md` section 4). The SDK trusts it only when `context.hub.hubKey` is the pinned hub key.

Declare the rule per path; the SDK checks it before the handler runs:

```ts
service
  .post('posts/create', createPost, { auth: 'user' })                  // an end user, through a gateway
  .post('posts/delete', deletePost, { permission: 'posts/moderate' })  // an owner granted it on the hub
  .post('admin/reindex', reindex, { auth: 'owner' })
  .post('builds/run', runBuild, { auth: 'device', groups: ['builders'] })
```

| setting | passes when | fails with |
|---|---|---|
| `auth: 'key'` | a keyed caller | `unauthorized` (anonymous, or no caller from the hub) |
| `auth: 'device'` | the caller's connection is on an approved device | `unauthorized`, or `forbidden` (`device required`) |
| `auth: 'owner'` | the caller is in the hub's `owners` group | `unauthorized` / `forbidden` |
| `auth: 'user'` | a delegate set `context.user` (below) | `unauthorized` (`user required`) |
| `groups: [...]` | the caller is in one of them, or an owner | `unauthorized` / `forbidden` |
| `permission: 'p'` | an owner, or the hub says `p` is granted to the caller | `unauthorized` / `forbidden` |

The same checks run inside handlers, on the request (the handler's second argument):

```ts
service.post('posts/edit', async (body, request) => {
  const caller = request.requireKey()
  if (caller.key !== post.author) await request.requirePermission('posts/moderate')
  // also: requireOwner(), requireDevice(), requireGroup(...groups), requireUser(), can(permission)
})
```

### Permissions

A permission is a path an owner grants like any other: `hub/grant/add { subject, object: { path: 'posts/moderate' } }`
(or a `prefix`), to a key, a device, a group or everyone. It doesn't have to be an API. The service asks the hub with
`hub/grant/check { path, caller }` → `{ allowed }`: true for owners and when a grant names the path for the caller,
false while the hub is locked down. A service may ask only about paths under the first segment of a path it
registered (`posts/...` for a service of `posts/*`); owners may ask about anything.

`request.can(p)` answers owners locally, anonymous callers with false, and keeps the answer for the rest of the
request. `grantCache: seconds` (service option) keeps answers longer, so a revoked grant takes up to that long to
apply.

### End users through a gateway

Hub callers are services and devices, not the people using an app. A gateway (a service that signs users in, say
with a session cookie or a token) calls other services for them and names the user in the context:

```ts
// gateway, a member of the hub group "gateways"
await gateway.send('posts/create', { text }, { context: { user: session.userId } })   // or { user: { id, name } }

// posts service
new Service({ delegates: ['gateways'] })
  .post('posts/create', (body, request) => db.insert({ author: request.user!.id, ...body }), { auth: 'user' })
```

`request.user` is `{ id, ... }` only when the caller is an owner or a member of a `delegates` group; from anyone else
`context.user` is ignored. The hub passes context keys other than `hub` through unchanged. A service that calls
another service while handling a user's request passes `context: { user: request.user }` on, and needs to be a
delegate there too.

## Errors

Throw a `HubError` (or anything with `message`, `code` and `info`); the caller gets a `ChannelError` with the same
three, also when the hub is in between and also from a stream that fails after it started.

```ts
throw HubError.notFound('post not found', { id })
throw new HubError('payment required', 402)

try { await client.send('posts/delete', { id }) }
catch (error) { if (errorCode(error) === 'forbidden') showLogin() }
```

| code | message | from |
|---|---|---|
| `unauthorized` | `unauthorized`, `user required` | SDK checks, hub (`auth` built-ins) |
| `forbidden` | `permissions required`, `device required` | SDK checks, hub (a call it doesn't allow) |
| `invalid_input` | the validator's message, or `invalid input` with `info.issues` | `input` validation |
| `rate_limited` | `rate limited`, `info.retryAfter` (seconds) | `rateLimit` |
| `unavailable` | `service unavailable`, `service stopped`; hub: `api not available` | not ready, shutting down; hub: no provider in time |
| `not_found` | `api not found` | hub: nobody provides the path |
| `cancelled` | `cancelled` | the call was cancelled |

Messages stay what v1 clients compared; codes are for new code.

## Input validation

`input` is a function returning the handler's input, or anything with `parse` (a zod schema works as is). Its errors
become `invalid_input`: the message of a plain error, or `invalid input` with `info: { issues }` when it has issues.
A `HubError` it throws passes as it is.

```ts
service.post('posts/create', (body: { text: string }) => ..., { input: z.object({ text: z.string().max(500) }) })
```

## Rate limits

`rateLimit: { limit, window, by?, bucket? }`: `limit` calls per `window` seconds per caller, a sliding window, in memory.
The caller is the delegated user, else the key, else the device, else all anonymous callers together; `by(request)`
picks another key (return `undefined` to not count a request). Each path counts on its own unless paths share a
`bucket`. `ServiceOptions.rateLimit` is the default of every path; `rateLimit: false` turns it off for one.

The hub's `limit` setting is different: how many calls one provider runs at once.

## Cancellation

`request.signal` is an `AbortSignal`, aborted when the caller cancels or disconnects, when the hub drops the call
(its provider was revoked), and when the service stops or a shutdown ends the call. `request.cancelled` is the same
as a boolean. Pass it on:

```ts
service.stream('llm/chat', async function* (body, request) {
  const response = await fetch(url, { body, signal: request.signal })
  for await (const chunk of response.body!) yield decode(chunk)
})
```

An async generator only notices `return()` at its next `yield`; the signal fires at once.

## Readiness and shutdown

- `new Service({ ready: false })` connects and registers its paths without taking calls; `setReady(true)` once its
  database is up. `setReady(false)` stops taking calls again. While not ready the hub sends calls to other providers or
  keeps them waiting (up to 30 s), and calls that still arrive fail with `unavailable`.
- `shutdown({ timeout = 10000 })`: tells the hub to send no more calls, ends running streams, waits for running posts,
  aborts what is left at the timeout and stops. Resolves true when everything finished in time. A path's
  `shutdown: 'wait' | 'end'` overrides the default (`wait` for posts, `end` for streams; an LLM stream would `wait`).
- `service.shutdownOnSignals({ timeout })` (Bun) shuts down on SIGTERM or SIGINT and exits.
- `service.health`: `{ status, connected, ready, running }`, status `ready | not_ready | shutting_down |
  disconnected | refused | stopped`. `runningCalls`, `acceptsCalls` and `isReady` are there too.

With two providers of a path, shutting one down hands new calls to the other while the first finishes its own: a
rolling restart without failed calls.

## Hub side

- `hub/service/update { draining: true | false }`: the connection's paths stop (or start again) taking new calls;
  its running calls go on. A path whose last provider drains leaves `hub/api`; calls to it wait for another provider.
  Paths the connection registers while draining start drained. Disconnecting cancels what still runs, as before.
- `hub/grant/check { path, caller }` → `{ allowed }` (access: any keyed caller, limited as above).
- Call failures carry codes (`forbidden`, `not_found`, `unavailable`, `unauthorized`), and a provider's own error
  passes through with its code and info.
- A caller leaving a stream cancels it at the provider at once, also while the provider is waiting for its next value.

Both hubs implement these; hub-server's conformance harness checks them (`bun run conformance`).

## For other ports

What each port needs, in order of value. Wire names are exact; the rest follows the language.

1. **Errors with codes.** Thrown errors become `{ id, error, code?, info? }` (channel wire v2). Ship a `HubError`
   type with the codes above and constructors for them. A `HubError` keeps its message, code and info on the wire;
   other errors may stay opaque (Swift sends `internal error`).
2. **Request object** passed to handlers: `caller` (trusted only when `context.hub.hubKey` is the pinned hub key),
   `context` without `hub`, `user`, `path`, cancellation (`signal`, a cancellation token, a context, or structured
   task cancellation), and `requireKey/Device/Owner/Group/User`, `can`, `requirePermission`.
3. **Declarative settings** checked before the handler, in this order: readiness (`unavailable`), `auth`, `groups`,
   `rateLimit`, `permission`, `input`. Owners pass `groups` and `permission`. No caller means `unauthorized`, so
   every check fails closed on hubs that don't send one.
4. **`hub/grant/check`** with the caller's `key`, `device: { id }` and `via` (when set); keep the answer per request.
5. **Cancellation:** a `{ cancel: id }` for a post or stream reaches the handler at once, also for a stream that is
   waiting between values.
6. **Ready and shutdown:** `draining: true` in the first `hub/service/update` while not ready; `{ draining }` updates on
   change; shutdown = draining, end streams, wait for posts up to a timeout, abort, stop; flush the last responses
   before closing.
7. **Rate limits** per caller key as above (`rate_limited`, `info.retryAfter` whole seconds, at least 1).
8. **Delegates:** `context.user` (string id or `{ id }`) is honoured only from owners and `delegates` group members.

Test them against a hub-server in local mode (`bun index.ts --local --port <n> --owner <service SPKI>`), as
`hub-server.integration.test.ts` does here.
