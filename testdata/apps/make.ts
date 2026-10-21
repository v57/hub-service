// Writes interface.json: one app interface with every element, the shared fixture for app decoders in other SDKs.
// `bun testdata/apps/make.ts` after changing the builders; app.test.ts checks the file is current.
import { appFixture } from './fixture'
await Bun.write(new URL('./interface.json', import.meta.url), JSON.stringify(appFixture(), null, 2) + '\n')
