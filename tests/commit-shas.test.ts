import { describe, expect, it } from 'vitest'
import { validateCommitShas } from '../src/main/git/repo'

describe('IPC commit list validation', () => {
  it('accepts abbreviated and full hexadecimal object names', () => {
    expect(validateCommitShas(['deadbeef'])).toEqual(['deadbeef'])
    expect(validateCommitShas(['ABCD'])).toEqual(['ABCD'])
    expect(validateCommitShas(['a'.repeat(64)])).toEqual(['a'.repeat(64)])
  })

  it('collapses duplicates and keeps the given order', () => {
    expect(validateCommitShas(['deadbeef', 'cafe', 'deadbeef'])).toEqual(['deadbeef', 'cafe'])
  })

  it('rejects an empty list, non-strings and option-like values', () => {
    expect(() => validateCommitShas([])).toThrow('Select at least one commit')
    expect(() => validateCommitShas(undefined)).toThrow('Select at least one commit')
    expect(() => validateCommitShas([12])).toThrow('Invalid commit')
    expect(() => validateCommitShas(['--abort'])).toThrow('Invalid commit')
    expect(() => validateCommitShas(['dead beef'])).toThrow('Invalid commit')
    expect(() => validateCommitShas(['abc'])).toThrow('Invalid commit')
    expect(() => validateCommitShas(['HEAD~1'])).toThrow('Invalid commit')
    expect(() => validateCommitShas(['main'])).toThrow('Invalid commit')
    expect(() => validateCommitShas(['deadbeef..cafe'])).toThrow('Invalid commit')
    expect(() => validateCommitShas(['a'.repeat(65)])).toThrow('Invalid commit')
  })

  it('rejects an oversized selection', () => {
    const tooMany = Array.from({ length: 5001 }, (_, index) => index.toString(16).padStart(4, '0'))
    expect(() => validateCommitShas(tooMany)).toThrow('Too many commits selected')
  })
})