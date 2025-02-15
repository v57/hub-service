# Usage

## Start hub process

```ts
import { Hub } from 'hub-lite'
new Hub()
```

## Create hub service

```ts
import { Service } from 'hub-service'
new Service().post('hash/sha256', body => new Bun.SHA256().update(body).digest('hex')).start()
```

## Client api

```ts
import { Client } from 'hub-client'
const client = new Client()
const hash = await client.post('hash/sha256', 'Hello World')
console.log(hash)
```
