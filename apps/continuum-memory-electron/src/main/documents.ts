import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ToolHandler } from '@continuum-memory/tools'

export interface DocumentRuntime { pythonPath: string; scriptPath: string; popplerPath?: string; pdf: boolean; word: boolean; error?: string }
export interface DesktopDocument { id: string; name: string; format: 'pdf' | 'docx'; kind: 'input' | 'output'; file: string; createdAt: number; validated?: boolean }

function processJson(executable: string, args: string[], input?: unknown): Promise<any> {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } })
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    let out = '', error = '', settled = false
    const finish = (failure?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); failure ? reject(failure) : accept(value) }
    const timer = setTimeout(() => { child.kill(); finish(new Error('文档处理超时，请缩小文件或内容范围')) }, 60_000)
    child.on('error', failure => finish(failure))
    child.stdout.on('data', data => { out += data; if (out.length > 2_000_000) { child.kill(); finish(new Error('文档结果超过大小上限')) } })
    child.stderr.on('data', data => { if (error.length < 4000) error += data })
    child.on('close', code => {
      if (input === undefined) { finish(code ? new Error(error || '预览生成失败') : undefined, { ok: true }); return }
      try { const result = JSON.parse(out); finish(result.ok && code === 0 ? undefined : new Error(result.error || '文档处理失败'), result) }
      catch { finish(new Error(error || '文档运行时没有返回有效结果')) }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input))
  })
}
export async function probeDocumentRuntime(input: { pythonPath: string; scriptPath: string; popplerPath?: string }): Promise<DocumentRuntime> {
  try {
    if (!existsSync(input.pythonPath) || !existsSync(input.scriptPath)) throw new Error('文档 Python 运行时或处理脚本不存在')
    const result = await processJson(input.pythonPath, [input.scriptPath], { action: 'probe' })
    return { ...input, pdf: !!result.pypdf && !!result.reportlab, word: !!result.docx }
  } catch (error) { return { ...input, pdf: false, word: false, error: error instanceof Error ? error.message : String(error) } }
}

export function createDocumentService(options: {
  root: string; runtime: DocumentRuntime; persistence: { load(): string | undefined; save(value: string): void }; onChanged?: () => void
}) {
  mkdirSync(options.root, { recursive: true })
  const root = realpathSync(options.root)
  const raw = options.persistence.load()
  let files: DesktopDocument[] = raw ? JSON.parse(raw) : []
  if (!Array.isArray(files) || new Set(files.map(file => file.id)).size !== files.length
    || files.some(file => typeof file.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(file.id) || !['pdf', 'docx'].includes(file.format)
    || !['input', 'output'].includes(file.kind) || typeof file.file !== 'string' || isAbsolute(file.file)
    || extname(file.file).toLowerCase() !== '.' + file.format || file.file.split(/[\\/]/).includes('..'))) throw new Error('文档目录数据无效')
  const list = () => ({ items: files.map(({ file: _file, ...item }) => item), runtime: {
    pdf: options.runtime.pdf, word: options.runtime.word, pdfPreview: !!options.runtime.popplerPath && existsSync(options.runtime.popplerPath),
    error: options.runtime.error, wordPreview: 'structure' } })
  const inside = (target: string) => {
    const difference = relative(root, realpathSync(target))
    if (difference === '..' || difference.startsWith(`..${sep}`) || isAbsolute(difference)) throw new Error('文件超出当前对话文档目录')
    return target
  }
  const get = (id: unknown) => {
    const file = files.find(file => file.id === id)
    if (!file) throw new Error('当前对话没有此文档，请先选择文件或生成文档')
    const path = inside(resolve(root, file.file))
    if (statSync(path).size > 20_000_000) throw new Error('文件超过 20 MB 上限')
    return { file, path }
  }
  const save = (record: DesktopDocument) => {
    const next = [...files, record]; options.persistence.save(JSON.stringify(next)); files = next; options.onChanged?.()
  }
  const importFiles = (paths: string[]) => {
    if (!Array.isArray(paths) || paths.length > 10) throw new Error('每次最多选择 10 个文件')
    for (const source of paths) {
      const extension = extname(source).toLowerCase()
      if (!['.pdf', '.docx'].includes(extension) || !statSync(source).isFile() || statSync(source).size > 20_000_000) throw new Error('仅支持不超过 20 MB 的 PDF 与 DOCX')
      const id = randomUUID(), directory = join(root, 'inputs'); mkdirSync(directory, { recursive: true }); inside(directory)
      const target = join(directory, `${id}${extension}`); copyFileSync(source, target)
      save({ id, name: basename(source), format: extension.slice(1) as 'pdf' | 'docx', kind: 'input', file: relative(root, target), createdAt: Date.now() })
    }
    return list()
  }
  const read = async (id: unknown, args: Record<string, unknown> = {}) => {
    const { file, path } = get(id)
    if (file.format === 'pdf' ? !options.runtime.pdf : !options.runtime.word) throw new Error('当前文档运行时不可用')
    const maximum = args.max_characters === undefined ? 12_000 : args.max_characters
    const start = args.page_start === undefined ? 1 : args.page_start, end = args.page_end
    if (!Number.isInteger(maximum) || Number(maximum) < 100 || Number(maximum) > 50_000
      || !Number.isInteger(start) || Number(start) < 1 || (end !== undefined && (!Number.isInteger(end) || Number(end) < Number(start)))) throw new Error('读取范围无效')
    const result = await processJson(options.runtime.pythonPath, [options.runtime.scriptPath],
      { action: 'read', path, maximum, page_start: start, ...(end === undefined ? {} : { page_end: end }) })
    return { id: file.id, name: file.name, ...result }
  }
  const create = async (args: Record<string, unknown>) => {
    if (args.format !== 'pdf' && args.format !== 'docx') throw new Error('仅支持 PDF 和 DOCX 输出')
    if (args.format === 'pdf' ? !options.runtime.pdf : !options.runtime.word) throw new Error('文档运行时缺少对应依赖')
    if (typeof args.title !== 'string' || !args.title.trim() || args.title.length > 200 || !Array.isArray(args.blocks)
      || JSON.stringify(args.blocks).length > 100_000) throw new Error('请提供标题和不超过长度上限的内容块')
    const requested = typeof args.filename === 'string' ? args.filename : args.title
    if (requested.length > 150 || /[\\/:]/.test(requested)) throw new Error('文件名不能包含路径或目录')
    const name = (requested.replace(/\.(pdf|docx)$/i, '').replace(/[<>"|?*\x00-\x1f]/g, '_').trim() || '文档') + '.' + args.format
    const id = randomUUID(), directory = join(root, 'outputs', id); mkdirSync(directory, { recursive: true }); inside(directory)
    const output = join(directory, name)
    const result = await processJson(options.runtime.pythonPath, [options.runtime.scriptPath],
      { action: 'create', format: args.format, title: args.title, blocks: args.blocks, output })
    if (!existsSync(output) || !result.validated) throw new Error('文档尚未通过结构验证')
    save({ id, name, format: args.format, kind: 'output', file: relative(root, output), createdAt: Date.now(), validated: true })
    return { ...result, id, name, path: output, notice: result.notice ?? '文件已生成并通过结构验证；使用 document_preview 检查页面，不代表已做完整视觉审核。' }
  }
  const preview = async (id: unknown) => {
    const { file, path } = get(id)
    if (file.format === 'docx') return read(id, { max_characters: 20_000 })
    if (!options.runtime.popplerPath || !existsSync(options.runtime.popplerPath)) throw new Error('PDF 页面预览需要 Poppler，请先配置运行时')
    const directory = join(root, 'previews', file.id); mkdirSync(directory, { recursive: true }); inside(directory)
    const prefix = join(directory, 'page')
    await processJson(options.runtime.popplerPath, ['-f', '1', '-l', '3', '-scale-to', '1280', '-png', path, prefix])
    const { readdirSync } = await import('node:fs')
    const images = readdirSync(directory).filter(name => /^page-\d+\.png$/.test(name)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map(name => pathToFileURL(inside(join(directory, name))).href)
    return { id: file.id, name: file.name, format: 'pdf', images, notice: '仅预览前 3 页；其他页面未在此面板展示。' }
  }
  const service = { list, importFiles, read, create, preview, path: (id: string) => get(id).path,
    tools(): ToolHandler[] {
      return [
        { name: 'document_list', description: 'List PDFs and Word DOCX files explicitly selected or generated in the current conversation only.', parameters: { type: 'object', properties: {}, additionalProperties: false }, execute: async () => JSON.stringify(list()) },
        { name: 'document_read', description: 'Read text and tables from a registered PDF or DOCX by document_id. PDF defaults to five pages. Scanned PDFs may require OCR; preserve uncertainty and report truncation.',
          parameters: { type: 'object', properties: { document_id: { type: 'string' }, max_characters: { type: 'integer', minimum: 100, maximum: 50000 }, page_start: { type: 'integer', minimum: 1 }, page_end: { type: 'integer', minimum: 1 } }, required: ['document_id'], additionalProperties: false }, execute: async args => JSON.stringify(await read(args.document_id, args)) },
        { name: 'document_create', description: 'Generate a new PDF or Word DOCX in the current conversation output directory. Supports paragraphs, headings, lists and tables. Never overwrites the source. No macros, arbitrary scripts, signed-PDF editing or legacy DOC conversion.',
          parameters: { type: 'object', properties: { format: { type: 'string', enum: ['pdf', 'docx'] }, title: { type: 'string', maxLength: 200 }, filename: { type: 'string', maxLength: 150 },
            blocks: { type: 'array', maxItems: 200, items: { type: 'object', properties: { type: { type: 'string', enum: ['paragraph', 'heading', 'list', 'table'] }, text: { type: 'string' }, level: { type: 'integer', minimum: 1, maximum: 3 }, items: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }, required: ['type'] } } }, required: ['format', 'title', 'blocks'], additionalProperties: false }, execute: async args => JSON.stringify(await create(args)) },
        { name: 'document_preview', description: 'Prepare the first three PDF page previews or a Word structural preview. Word structural preview is not actual Word pagination. Never claim complete visual validation based on structure alone.', parameters: { type: 'object', properties: { document_id: { type: 'string' } }, required: ['document_id'], additionalProperties: false }, execute: async args => JSON.stringify(await preview(args.document_id)) },
      ]
    } }
  return service
}
