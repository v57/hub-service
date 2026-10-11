<h1>
  <img alt="Containerization logo" src="./icon.png" width="70" valign="middle">
  &nbsp;service.ts
</h1>

Full documentation, including apps and the other 13 languages: [docs](docs/README.md).

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
