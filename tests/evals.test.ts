import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('evaluation set', () => {
  const xml = readFileSync('evals/clickup-daily.xml', 'utf8')

  it('contains exactly ten qa pairs', () => {
    expect(xml.match(/<qa_pair>/g)).toHaveLength(10)
  })

  it('has a non empty answer for every question', () => {
    const answers = [...xml.matchAll(/<answer>(.*?)<\/answer>/gs)].map((m) => m[1]!.trim())
    expect(answers).toHaveLength(10)
    expect(answers.every((a) => a.length > 0)).toBe(true)
  })

  it('contains no time relative wording that would make answers unstable', () => {
    expect(xml.toLowerCase()).not.toMatch(
      /\b(today|yesterday|now|currently|running|open tasks?|as of|(?:this|last|next) week)\b/,
    )
  })
})
