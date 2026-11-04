import type { IntegrationAccount, ProviderId } from '@shared/types'
import { BitbucketClient } from './bitbucket'
import { GiteaClient } from './gitea'
import { GithubClient } from './github'
import { GitlabClient } from './gitlab'
import type { ProviderClient } from './types'

export type { ProviderClient } from './types'
export { ProviderError } from './types'

export function createProviderClient(account: IntegrationAccount, token: string | null): ProviderClient {
  switch (account.provider) {
    case 'github':
      return new GithubClient(account, token)
    case 'gitlab':
      return new GitlabClient(account, token)
    case 'bitbucket':
      return new BitbucketClient(account, token)
    case 'gitea':
      return new GiteaClient(account, token)
  }
}

export type { ProviderId }
