import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Validates the committed TEMPLATE, not a filled set. `clickup-daily.xml`
 * names real spaces, folders, lists and workspace members, so it is
 * generated locally and kept out of git (see evals/README.md and
 * .gitignore); a test that read it would fail on any clone but the author's.
 * The structural rules a filled set must keep are the template's rules, so
 * checking the template checks them.
 */
describe('evaluation set template', () => {
  const xml = readFileSync('evals/clickup-daily.template.xml', 'utf8')

  it('contains exactly ten qa pairs', () => {
    expect(xml.match(/<qa_pair>/g)).toHaveLength(10)
  })

  it('has a non empty answer slot for every question', () => {
    const answers = [...xml.matchAll(/<answer>(.*?)<\/answer>/gs)].map((m) => m[1]!.trim())
    expect(answers).toHaveLength(10)
    expect(answers.every((a) => a.length > 0)).toBe(true)
  })

  it('contains no time relative wording that would make answers unstable', () => {
    // The instruction block names the forbidden words in order to forbid
    // them, so it is stripped before the check rather than exempted by a
    // looser pattern.
    const withoutComments = xml.replace(/<!--[\s\S]*?-->/g, '')
    expect(withoutComments.toLowerCase()).not.toMatch(
      /\b(today|yesterday|now|currently|running|open tasks?|as of|(?:this|last|next) week)\b/,
    )
  })

  // Guards the fix for the committed set that carried a real workspace id,
  // real client folder names and two colleagues' surnames with their email
  // domain. Every workspace-specific value in the template must be a
  // placeholder, and each of the ten questions must carry at least one.
  it('carries only ALL_CAPS placeholders, never real workspace values', () => {
    const questions = [...xml.matchAll(/<question>(.*?)<\/question>/gs)].map((m) => m[1]!)
    expect(questions).toHaveLength(10)
    for (const question of questions) {
      expect(question).toMatch(/[A-Z]{2,}(?:_[A-Z]+)+/)
    }
    expect(xml).not.toMatch(/\b\d{8,}\b/)
    expect(xml).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i)
  })
})
