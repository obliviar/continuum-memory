import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDesktopSkillService } from './skills'
const directories: string[] = []
const storage = () => { let payload: string | undefined; return { load: () => payload, save: (value: string) => { payload = value } } }
const fixture = (name = 'local-text', requirements = '[file_read]') => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-skills-')); directories.push(root)
  const directory = join(root, name); mkdirSync(directory)
  const text = `---\nname: ${name}\ndescription: >\n  本地文本指导\n  保持原意\nrequired-tools: ${requirements}\n---\n只阅读用户指定文本，按事实整理。\n`
  writeFileSync(join(directory, 'SKILL.md'), text)
  return { root, directory, text }
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
describe('desktop Skill discovery and invocation', () => {
  it('provides seven usable builtins and exposes them through the real model tool handlers', async () => {
    const service = createDesktopSkillService({ roots: [], persistence: storage() })
    expect(service.list().items).toHaveLength(9)
    expect(service.list().items.filter(e => e.available && e.enabled)).toHaveLength(7)
    const tools = service.tools('A')
    const list = JSON.parse(await tools.find(t => t.name === 'list_skills')!.execute({ query: '摘要' }))
    expect(list.map((entry: { id: string }) => entry.id)).toEqual(['builtin:summary'])
    const result = JSON.parse(await tools.find(t => t.name === 'use_skill')!.execute({ skill_id: 'builtin:summary' }))
    expect(result.instructions).toContain('行动项')
    expect(service.history('A')[0]?.mode).toBe('model')
    expect(service.history('B')).toEqual([])
  })
  it('enables PDF and Word only when the fixed document runtime supports them', () => {
    const service = createDesktopSkillService({ roots: [], persistence: storage(), documentCapabilities: { pdf: true, word: true } })
    expect(service.list().items.find(e => e.id === 'builtin:pdf')).toMatchObject({ available: true, enabled: true })
    expect(service.load('builtin:word', 'A').availableTools).toContain('document_create')
    const absent = createDesktopSkillService({ roots: [], persistence: storage() })
    expect(() => absent.load('builtin:word', 'A')).toThrow()
  })
  it('imports local workflows disabled by default, persists enablement and requires re-enabling changed content', () => {
    const f = fixture(), persistence = storage()
    const service = createDesktopSkillService({ roots: [f.root], persistence })
    const entry = service.list().items.find(e => e.source === 'local')!
    expect(entry).toMatchObject({ name: 'local-text', available: true, enabled: false })
    expect(entry.description).toBe('本地文本指导 保持原意')
    expect(() => service.load(entry.id, 'A')).toThrow()
    service.setEnabled(entry.id, true)
    expect(service.load(entry.id, 'A').instructions).toContain('只阅读')
    expect(createDesktopSkillService({ roots: [f.root], persistence }).list().items.find(e => e.id === entry.id)?.enabled).toBe(true)
    writeFileSync(join(f.directory, 'SKILL.md'), f.text + '修改后的指导。')
    expect(() => service.load(entry.id, 'A')).toThrow('已变化')
    service.scan()
    expect(service.list().items.find(e => e.id === entry.id)?.enabled).toBe(false)
  })
  it('blocks missing capabilities, including declared multiline dependencies', () => {
    const f = fixture('external', '\n  - missing_connector')
    const service = createDesktopSkillService({ roots: [f.root], persistence: storage() })
    const entry = service.list().items.find(e => e.source === 'local')!
    expect(entry.available).toBe(false)
    expect(entry.reason).toContain('missing_connector')
    expect(() => service.setEnabled(entry.id, true)).toThrow()
  })
  it.each(['slack-reply-drafting', 'sites-preview-troubleshooting', 'artifact-template-system-design'])('does not mistake %s for an executable text-only workflow', name => {
    const f = fixture(name, '[]'), service = createDesktopSkillService({ roots: [f.root], persistence: storage() })
    expect(service.list().items.find(e => e.source === 'local')?.available).toBe(false)
  })
  it('reads allowed package resources but rejects absolute and escaping paths without executing scripts', async () => {
    const f = fixture(), service = createDesktopSkillService({ roots: [f.root], persistence: storage() })
    const entry = service.list().items.find(e => e.source === 'local')!
    service.setEnabled(entry.id, true)
    writeFileSync(join(f.directory, 'reference.md'), '参考资料')
    writeFileSync(join(f.root, 'outside.txt'), '不可读取')
    const tool = service.tools('A').find(t => t.name === 'read_skill_resource')!
    expect(await tool.execute({ skill_id: entry.id, path: 'reference.md' })).toBe('参考资料')
    await expect(tool.execute({ skill_id: entry.id, path: '../outside.txt' })).rejects.toThrow('超出')
    await expect(tool.execute({ skill_id: entry.id, path: join(f.root, 'outside.txt') })).rejects.toThrow()
  })
  it('keeps disabled skills out of listing and rejects stale invocation', async () => {
    const service = createDesktopSkillService({ roots: [], persistence: storage() })
    service.setEnabled('builtin:summary', false)
    const tools = service.tools('A')
    expect(JSON.parse(await tools[0]!.execute({ query: '摘要' }))).toEqual([])
    await expect(tools[1]!.execute({ skill_id: 'builtin:summary' })).rejects.toThrow()
    expect(service.history('A')).toEqual([])
  })
  it('persists explicitly added directories and never changes enablement on storage failure', () => {
    const f = fixture(), persistence = storage()
    const service = createDesktopSkillService({ roots: [], persistence })
    service.addRoot(f.root)
    expect(createDesktopSkillService({ roots: [], persistence }).list().items.some(e => e.source === 'local')).toBe(true)
    const failing = createDesktopSkillService({ roots: [], persistence: { load: () => undefined, save() { throw Error('disk full') } } })
    expect(() => failing.setEnabled('builtin:summary', false)).toThrow('disk full')
    expect(failing.list().items.find(e => e.id === 'builtin:summary')?.enabled).toBe(true)
  })
})
