import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const p = join(dir, e)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

it('never writes to stdout from src', () => {
  const offenders = walk('src').filter((f) => readFileSync(f, 'utf8').includes('console.log'))
  expect(offenders).toEqual([])
})
