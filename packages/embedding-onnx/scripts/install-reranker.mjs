import '../../memory/src/graph-core/eval/register-typescript.mjs'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
const { RERANKER_MODEL, RERANKER_REVISION, RERANKER_FILES } = await import('../src/reranker-manifest.ts')
const { values } = parseArgs({ options: { directory: { type: 'string' } } })
if (!values.directory) throw new Error('Pass --directory for the local model destination')
const directory = resolve(values.directory)
async function verify(path, file) {
  try {
    if ((await stat(path)).size !== file.bytes) return false
    const hash = createHash(file.sha256 ? 'sha256' : 'sha1')
    if (!file.sha256) hash.update(`blob ${file.bytes}\0`)
    for await (const chunk of createReadStream(path)) hash.update(chunk)
    return hash.digest('hex') === (file.sha256 ?? file.gitBlob)
  } catch { return false }
}
for (const file of RERANKER_FILES) {
  const path = resolve(directory, file.path)
  if (await verify(path, file)) { console.log(`Verified ${file.path}`); continue }
  await mkdir(dirname(path), { recursive: true })
  console.log(`Downloading ${file.path} (${file.bytes} bytes)`)
  const response = await fetch(`https://huggingface.co/${RERANKER_MODEL}/resolve/${RERANKER_REVISION}/${file.path}`, { signal: AbortSignal.timeout(600000) })
  if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.partial`))
  if (!await verify(`${path}.partial`, file)) throw new Error(`Integrity check failed: ${file.path}`)
  await rename(`${path}.partial`, path)
  console.log(`Verified ${file.path}`)
}
await writeFile(resolve(directory, 'reranker-manifest.json'), JSON.stringify({ model: RERANKER_MODEL, revision: RERANKER_REVISION, files: RERANKER_FILES }, null, 2))
console.log(`Installed verified model at ${directory}`)
