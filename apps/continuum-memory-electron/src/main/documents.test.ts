import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDocumentService, probeDocumentRuntime } from './documents'
const runtimeRoot = join(process.env.USERPROFILE ?? '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies')
const pythonPath = process.env.CONTINUUM_MEMORY_DOCUMENT_PYTHON || join(runtimeRoot, 'python', 'python.exe')
const scriptPath = join(import.meta.dirname, '../../resources/document_tools.py')
const popplerPath = join(runtimeRoot, 'native', 'poppler', 'Library', 'bin', 'pdftoppm.exe')
const directories: string[] = []
const storage = () => { let payload: string | undefined; return { load: () => payload, save: (value: string) => { payload = value } } }
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
describe('fixed PDF and Word document tools', () => {
  it('marks missing runtimes unavailable without invoking an arbitrary command', async () => {
    const runtime = await probeDocumentRuntime({ pythonPath: 'missing-python', scriptPath })
    expect(runtime).toMatchObject({ pdf: false, word: false })
  })
  it.skipIf(!existsSync(pythonPath))('creates and rereads Chinese PDF/DOCX tables, preserves partition isolation and rejects path escapes', async () => {
    const runtime = await probeDocumentRuntime({ pythonPath, scriptPath, popplerPath })
    expect(runtime).toMatchObject({ pdf: true, word: true })
    const root = mkdtempSync(join(tmpdir(), 'document-skills-')); directories.push(root)
    const saved = storage(), a = createDocumentService({ root: join(root, 'A'), runtime, persistence: saved })
    const b = createDocumentService({ root: join(root, 'B'), runtime, persistence: storage() })
    const blocks = [{ type: 'heading', text: '测试内容', level: 1 }, { type: 'paragraph', text: '中文文档测试：样品 S7 保存在恒温箱中。' },
      { type: 'table', rows: [['项目', '说明'], ['样品 S7', '保持原意，保留否定和时间。']] }]
    const word = await a.create({ format: 'docx', title: '中文报告', blocks })
    expect(word.validated).toBe(true)
    expect(JSON.stringify(await a.read(word.id))).toContain('样品 S7')
    const pdf = await a.create({ format: 'pdf', title: '中文报告', blocks })
    expect(pdf.pageCount).toBe(1)
    expect(JSON.stringify(await a.read(pdf.id))).toContain('中文文档测试')
    await expect(b.read(word.id)).rejects.toThrow('当前对话')
    const restored = createDocumentService({ root: join(root, 'A'), runtime, persistence: saved })
    expect(restored.list().items).toHaveLength(2)
    expect(JSON.stringify(await restored.read(word.id))).toContain('中文文档测试')
    await expect(a.create({ format: 'pdf', title: 'A', filename: '../outside', blocks })).rejects.toThrow('文件名')
    await expect(a.create({ format: 'docx', title: 'A', blocks: [{ type: 'table', rows: [['A'], ['A', 'B']] }] })).rejects.toThrow('列数')
    expect(a.list().items).toHaveLength(2)
    if (existsSync(popplerPath)) expect((await a.preview(pdf.id)).images).toHaveLength(1)
    const copy = b.importFiles([word.path]).items[0]!
    expect(JSON.stringify(await b.read(copy.id))).toContain('中文文档测试')
  }, 30000)
})
