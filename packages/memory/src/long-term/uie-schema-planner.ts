import type { UieSchema } from './local-uie'

const domains = [
  { id: 'experiment', cue: /样品|试剂|实验|恒温箱|冷柜|仪器|传感器/u,
    schema: ['样品', '设备', '试剂', { 样品: ['存放位置', '保管人', '保存条件'] }, { 设备: ['供电设备', '故障', '状态'] }] },
  { id: 'software', cue: /模块|接口|依赖|配置|代码|运行环境|数据库/u,
    schema: ['模块', '接口', '配置', { 模块: ['依赖模块', '使用设备', '运行环境'] }, { 项目: ['负责人', '依赖项目'] }] },
  { id: 'work', cue: /任务|负责|接手|会议|交付|排期/u,
    schema: ['任务', { 任务: ['负责人', '截止时间', '前置任务'] }] },
] as const

/** Bounded content-driven goals, never a whitelist for graph admission. */
export function planUieSchema(text: string): { schema: UieSchema; domains: string[]; version: string } {
  const schema: UieSchema = ['人物', '地点', '组织机构', '项目', '时间', '姓名', '职业', '所在地',
    '喜好', '当前项目', '课程', '上课地点', '爱好', '喜欢',
    { 人物: ['父亲', '母亲', '丈夫', '妻子', '国籍', '毕业院校', '居住地', '所属组织'] },
    { 企业: ['董事长', '创始人', '总部地点'] }]
  const selected = domains.filter(d => d.cue.test(text)).slice(0, 2)
  for (const domain of selected) for (const target of domain.schema) {
    const copy = typeof target === 'string' ? target : Object.fromEntries(Object.entries(target).map(([k, v]) => [k, [...v]]))
    if (!schema.some(s => JSON.stringify(s) === JSON.stringify(copy))) schema.push(copy)
  }
  if (/电影|影视|主演|导演|票房/u.test(text)) schema.push({ 影视作品: ['主演', '导演', '出品公司', '上映时间', '票房', '主题曲'] })
  if (/歌曲|专辑|歌手|作词|作曲/u.test(text)) schema.push({ 歌曲: ['歌手', '作词', '作曲', '所属专辑'] })
  if (/图书|作者|书籍/u.test(text)) schema.push({ 图书作品: ['作者'] })
  return { schema, domains: selected.map(d => d.id), version: 'uie-domain-plan-v1' }
}
