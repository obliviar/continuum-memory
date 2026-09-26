import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEncryptedGraphL1Persistence } from './encrypted-l1-persistence'

describe('encrypted L1 scalar persistence', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'graph-l1-test-')) })
  afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

  function persistence(readOnly = false) {
    return createEncryptedGraphL1Persistence({
      encryptedPath: join(directory, 'relations.enc'),
      keyPath: join(directory, 'relations.key'),
      // Test-only stand-in. Production must use host OS key protection.
      protectKey: key => Buffer.from(key),
      unprotectKey: key => Buffer.from(key),
      readOnly,
    })
  }

  it('round-trips an authenticated snapshot without plaintext on disk', () => {
    const first = persistence()
    expect(first.load()).toBeUndefined()
    first.save('{"hypothesisText":"暴雨导致航班取消"}')
    expect(persistence().load()).toBe('{"hypothesisText":"暴雨导致航班取消"}')
    expect(readFileSync(join(directory, 'relations.enc'), 'utf8')).not.toContain('暴雨')
  })

  it('rejects tampering and read-only writes', () => {
    persistence().save('{"relation":"accepted"}')
    const file = join(directory, 'relations.enc')
    const envelope = JSON.parse(readFileSync(file, 'utf8')) as { ciphertext: string }
    envelope.ciphertext = Buffer.from('tampered').toString('base64')
    writeFileSync(file, JSON.stringify(envelope))
    expect(() => persistence().load()).toThrow('authenticate')
    expect(() => persistence(true).save('new payload')).toThrow('read-only')
  })
})
