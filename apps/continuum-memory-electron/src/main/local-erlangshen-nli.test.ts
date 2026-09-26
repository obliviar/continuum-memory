import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalErlangshenNli, ERLANGSHEN_NLI_MODEL_ID,
  ERLANGSHEN_NLI_PREPROCESSING_VERSION } from './local-erlangshen-nli'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('local Erlangshen process adapter', () => {
  it('keeps one local process and validates the pinned model revision and probabilities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'graph-nli-test-'))
    directories.push(directory)
    const scriptPath = join(directory, 'fake-nli.cjs')
    writeFileSync(scriptPath, `
      process.stdout.write(JSON.stringify({ready:true,modelId:${JSON.stringify(ERLANGSHEN_NLI_MODEL_ID)},
        modelRevision:'revision-1'})+'\\n');
      let buffer=''; process.stdin.on('data', chunk => { buffer += chunk;
        let i; while ((i=buffer.indexOf('\\n'))>=0) {
          const line=buffer.slice(0,i); buffer=buffer.slice(i+1);
          const request=JSON.parse(line); process.stdout.write(JSON.stringify({id:request.id,
            scores:{CONTRADICTION:0.1,NEUTRAL:0.2,ENTAILMENT:0.7},label:'ENTAILMENT',truncated:false,
            modelId:${JSON.stringify(ERLANGSHEN_NLI_MODEL_ID)},modelRevision:'revision-1'})+'\\n');
        }
      });
    `)
    const judge = createLocalErlangshenNli({ pythonPath: process.execPath, scriptPath,
      modelPath: directory, modelRevision: 'revision-1', startupTimeoutMs: 5000, requestTimeoutMs: 5000 })
    try {
      const request = { premise: { kind: 'claim' as const,
        ref: { kind: 'claim' as const, id: 'a', version: 1 }, text: '张三在星河公司工作。' },
      hypothesisText: '张三任职于星河公司。' }
      expect(await judge.judge(request)).toEqual({ ok: true, value: {
        scores: { CONTRADICTION: 0.1, NEUTRAL: 0.2, ENTAILMENT: 0.7 },
        modelId: ERLANGSHEN_NLI_MODEL_ID, modelRevision: 'revision-1',
        preprocessingVersion: ERLANGSHEN_NLI_PREPROCESSING_VERSION, truncated: false,
      } })
      expect((await judge.judge(request)).ok).toBe(true)
    }
    finally { judge.close() }
  })

  it.skipIf(!process.env.CONTINUUM_MEMORY_NLI_MODEL_PATH || !process.env.CONTINUUM_MEMORY_NLI_PYTHON)(
    'runs a Chinese pair through the installed offline 330M model', async () => {
      const modelPath = process.env.CONTINUUM_MEMORY_NLI_MODEL_PATH!
      const judge = createLocalErlangshenNli({
        pythonPath: process.env.CONTINUUM_MEMORY_NLI_PYTHON!,
        modelPath,
        dependenciesPath: process.env.CONTINUUM_MEMORY_NLI_DEPENDENCIES,
        scriptPath: join(dirname(fileURLToPath(import.meta.url)), '../../resources/erlangshen_nli.py'),
        modelRevision: modelPath.split(/[\\/]/).at(-1)!,
      })
      try {
        const result = await judge.judge({ premise: { kind: 'claim',
          ref: { kind: 'claim', id: 'source', version: 1 }, text: '张三在星河公司工作。' },
        hypothesisText: '张三任职于星河公司。' })
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(Object.values(result.value.scores).reduce((sum, score) => sum + score, 0)).toBeCloseTo(1)
          expect(result.value.truncated).toBe(false)
        }
      }
      finally { judge.close() }
    }, 120_000)
})
