import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { GraphRelationPersistence } from './relation-repository'

const ALGORITHM = 'aes-256-gcm'
const SNAPSHOT_SCHEMA = 'continuum-memory-graph-relations'
const KEY_SCHEMA = 'continuum-memory-graph-relations-key'

interface EncryptedRelationEnvelope {
  readonly version: 1
  readonly schema: typeof SNAPSHOT_SCHEMA
  readonly algorithm: typeof ALGORITHM
  readonly iv: string
  readonly authTag: string
  readonly ciphertext: string
}

interface ProtectedRelationKeyEnvelope {
  readonly version: 1
  readonly schema: typeof KEY_SCHEMA
  readonly protectedKey: string
}

export interface EncryptedGraphRelationPersistenceOptions {
  readonly encryptedPath: string
  readonly keyPath: string
  /** Trusted host provides OS-bound key protection; never store the raw key next to data. */
  readonly protectKey: (key: Buffer) => Buffer
  readonly unprotectKey: (protectedKey: Buffer) => Buffer
  readonly readOnly?: boolean
}

/** Separate authenticated L2 checkpoint; deliberately does not reuse V4 files or keys. */
export function createEncryptedGraphRelationPersistence(options: EncryptedGraphRelationPersistenceOptions): GraphRelationPersistence {
  function existingKey(): Buffer {
    if (!existsSync(options.keyPath))
      throw new Error('Protected relation key does not exist')
    const envelope = JSON.parse(readFileSync(options.keyPath, 'utf8')) as ProtectedRelationKeyEnvelope
    if (envelope.version !== 1 || envelope.schema !== KEY_SCHEMA || typeof envelope.protectedKey !== 'string')
      throw new Error('Invalid protected relation key envelope')
    const key = options.unprotectKey(Buffer.from(envelope.protectedKey, 'base64'))
    assertKey(key)
    return key
  }

  function getOrCreateKey(): Buffer {
    if (existsSync(options.keyPath))
      return existingKey()
    const key = randomBytes(32)
    const protectedKey = options.protectKey(key)
    if (!Buffer.isBuffer(protectedKey) || protectedKey.length === 0)
      throw new Error('Relation key protection returned no data')
    atomicWrite(options.keyPath, JSON.stringify({
      version: 1, schema: KEY_SCHEMA, protectedKey: protectedKey.toString('base64'),
    } satisfies ProtectedRelationKeyEnvelope))
    return key
  }

  return {
    storagePath: options.encryptedPath,
    load: () => existsSync(options.encryptedPath)
      ? decrypt(readFileSync(options.encryptedPath, 'utf8'), existingKey())
      : undefined,
    save(payload: string): void {
      if (options.readOnly)
        throw new Error('Relation persistence is read-only')
      const key = getOrCreateKey()
      const encrypted = encrypt(payload, key)
      if (decrypt(encrypted, key) !== payload)
        throw new Error('Relation encryption verification failed')
      atomicWrite(options.encryptedPath, encrypted)
    },
  }
}

function encrypt(payload: string, key: Buffer): string {
  assertKey(key)
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()])
  return JSON.stringify({
    version: 1,
    schema: SNAPSHOT_SCHEMA,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  } satisfies EncryptedRelationEnvelope)
}

function decrypt(payload: string, key: Buffer): string {
  assertKey(key)
  const envelope = JSON.parse(payload) as EncryptedRelationEnvelope
  if (envelope.version !== 1 || envelope.schema !== SNAPSHOT_SCHEMA || envelope.algorithm !== ALGORITHM
    || typeof envelope.iv !== 'string' || typeof envelope.authTag !== 'string'
    || typeof envelope.ciphertext !== 'string')
    throw new Error('Invalid encrypted relation envelope')
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }
  catch {
    throw new Error('Unable to authenticate encrypted relation snapshot')
  }
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32)
    throw new Error('Relation master key must be exactly 32 bytes')
}

function atomicWrite(path: string, payload: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, payload, { encoding: 'utf8', mode: 0o600 })
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, path)
        return
      }
      catch (cause) {
        const code = (cause as NodeJS.ErrnoException).code
        if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES'))
          throw cause
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5 * 2 ** attempt)
      }
    }
  }
  catch (cause) {
    rmSync(temporary, { force: true })
    throw cause
  }
}
