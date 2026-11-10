import type { CreateReleaseInput, ProviderCapabilities, ProviderId } from '@shared/types'
import { PROVIDERS } from '@shared/types'

/**
 * Validate publication intent against a provider's real capabilities before
 * any HTTP write. A requested draft or prerelease that the forge cannot
 * represent must fail here, not silently become an ordinary publication.
 */
export function assertReleaseIntent(
  provider: ProviderId,
  capabilities: ProviderCapabilities['releases'],
  input: CreateReleaseInput
): void {
  const name = PROVIDERS[provider].name
  if (!capabilities.create) throw new Error(`${name} does not support creating releases from Commit87.`)
  if (input.draft && !capabilities.draft) {
    throw new Error(`${name} releases have no draft state. Clear the draft option before publishing.`)
  }
  if (input.prerelease && !capabilities.prerelease) {
    throw new Error(`${name} releases have no prerelease flag. Clear the pre-release option before publishing.`)
  }
}
