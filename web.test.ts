import { describe, expect, test } from 'bun:test'
import { Service } from './web'

describe('web service surface', () => {
  test('does not advertise Unix-socket network publication', () => {
    const service = new Service()

    expect('network' in service).toBeFalse()
    expect('publishShare' in service).toBeFalse()
  })
})
