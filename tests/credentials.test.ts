import { describe, expect, it } from 'vitest'
import type { GitIdentity, IntegrationAccount } from '../src/shared/types'
import { buildAuthArgs, buildIdentityEnv, redact, shellQuote } from '../src/main/git/runner'

const identity: GitIdentity = {
  id: 'i1',
  label: 'Work',
  name: "Ada O'Lovelace",
  email: 'ada@example.com',
  isDefault: true,
  sshKeyPath: "/home/ada/.ssh/my key",
  createdAt: 0
}

const account: IntegrationAccount = {
  id: 'a1',
  provider: 'github',
  label: 'GitHub',
  username: 'ada',
  baseUrl: 'https://api.github.com',
  hasToken: true,
  createdAt: 0
}

describe('git identity environment', () => {
  it('sets author and committer identity for commits and tags', () => {
    const { env, args } = buildIdentityEnv(identity)
    expect(env.GIT_AUTHOR_NAME).toBe(identity.name)
    expect(env.GIT_COMMITTER_EMAIL).toBe(identity.email)
    expect(args).toContain(`user.name=${identity.name}`)
    expect(args).toContain(`user.email=${identity.email}`)
    expect(env.GIT_SSH_COMMAND).toContain('IdentitiesOnly=yes')
    expect(env.GIT_SSH_COMMAND).toContain('my key')
  })

  it('quotes SSH key paths safely', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
  })

  it('passes credentials through the environment and never in argv', () => {
    const { args, env } = buildAuthArgs(account, 'super-secret-token')
    expect(args).toContain('credential.helper=')
    expect(args.join(' ')).not.toContain('super-secret-token')
    expect(env.GITGROVE_TOKEN).toBe('super-secret-token')
    expect(env.GITGROVE_USERNAME).toBe('ada')
    expect(args.join(' ')).toContain('GITGROVE_USERNAME')
  })

  it('scopes a credential helper to an exact origin', () => {
    const { args, env } = buildAuthArgs(account, 'scoped-token', 'https://github.com')
    expect(args).toContain('credential.helper=')
    expect(args.join(' ')).toContain('credential.https://github.com.helper=')
    expect(args.join(' ')).not.toContain('scoped-token')
    expect(env.GITGROVE_TOKEN).toBe('scoped-token')
  })

  it('redacts secrets from task output', () => {
    const output = 'remote: https://ada:super-secret-token@github.com/acme/app.git'
    expect(redact(output, ['super-secret-token', null])).not.toContain('super-secret-token')
  })
})
