import type { GraphClaimRecord, GraphEntityRecord } from './types'

/** The role description is an interpretation; exact source quotations remain separately visible. */
export function renderSourceStatementComparison(claim: Partial<GraphClaimRecord>,
  entities: readonly GraphEntityRecord[], sourceText: string): string {
  if (!claim.sourceStatement || !claim.atom) return sourceText
  const roles = Object.entries(claim.atom.args).map(([role, value]) => `${role}：${value.kind === 'entity'
    ? entities.find(e => e.ref.id === value.ref.id && e.ref.version === value.ref.version)?.canonicalName ?? '身份未解析'
    : String(value.value)}`)
  return [`本条陈述的关系表达：${claim.sourceStatement.relationText}`, `参与角色：${roles.join('；')}`,
    `极性：${claim.polarity}；模态：${claim.modality}；时间：${JSON.stringify(claim.validTime ?? { kind: 'unknown' })}`,
    `条件：${claim.condition?.kind === 'none' ? '无' : claim.condition?.text ?? '未知'}`,
    '以下为完整来源证据，不得把其他陈述的关系归给本条参与者：', sourceText].join('\n')
}

/** A matching name is never proof that two source-local identities are equal. */
export function basicStatementIdentitiesCompatible(a: GraphClaimRecord, b: GraphClaimRecord,
  entities: readonly GraphEntityRecord[]): boolean {
  if (!a.sourceStatement && !b.sourceStatement) return true
  const names = (claim: GraphClaimRecord) => Object.values(claim.atom.args).flatMap(term => {
    if (term.kind !== 'entity') return []
    const entity = entities.find(e => e.ref.id === term.ref.id && e.ref.version === term.ref.version)
    return entity ? [{ name: entity.canonicalName.normalize('NFKC'), id: `${term.ref.id}:${term.ref.version}` }] : []
  })
  const left = names(a), right = names(b)
  return !left.some(x => right.some(y => x.name === y.name && x.id !== y.id))
}
