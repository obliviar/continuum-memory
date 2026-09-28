// Node 24+ source loading without a worker process or generated build files.
import { registerHooks, createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../../../package.json', import.meta.url))
const ts = require('typescript')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@continuum-memory/contracts')
      return next(new URL('../../../../contracts/src/index.ts', import.meta.url).href, context)
    if (specifier.startsWith('.') && context.parentURL) {
      const url = new URL(specifier, context.parentURL)
      if (existsSync(fileURLToPath(url) + '.ts')) return next(url.href + '.ts', context)
      if (existsSync(fileURLToPath(url) + '/index.ts')) return next(url.href + '/index.ts', context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText }
    return next(url, context)
  },
})
