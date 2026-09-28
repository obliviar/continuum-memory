import { describe, expect, it } from 'vitest'
import { runDirectLexicalRegression } from '../eval/direct-lexical-regression'

describe('direct graph lexical candidate isolation', () => {
  it.each(runDirectLexicalRegression())('$id', row => {
    expect(row.actual).toEqual(row.expected)
  })
})
