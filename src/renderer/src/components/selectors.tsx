import { Badge, Select } from './ui'
import { useStore } from '../store'
import type { IntegrationAccount, ProviderId } from '@shared/types'

export function IdentitySelect({
  value,
  onChange,
  className = ''
}: {
  value: string | undefined
  onChange: (value: string | undefined) => void
  className?: string
}) {
  const identities = useStore((state) => state.config?.identities ?? [])
  return (
    <Select className={className} value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
      {identities.map((identity) => (
        <option key={identity.id} value={identity.id}>
          {identity.name} · {identity.email}
          {identity.isDefault ? ' (default)' : ''}
        </option>
      ))}
      {identities.length === 0 ? <option value="">No identity configured</option> : null}
    </Select>
  )
}

export function AccountSelect({
  value,
  onChange,
  provider,
  allowNone = true,
  className = ''
}: {
  value: string | undefined
  onChange: (value: string | undefined) => void
  provider?: ProviderId
  allowNone?: boolean
  className?: string
}) {
  const integrations = useStore((state) => state.config?.integrations ?? [])
  const filtered = provider ? integrations.filter((account) => account.provider === provider) : integrations
  return (
    <Select className={className} value={value ?? ''} onChange={(event) => onChange(event.target.value || undefined)}>
      {allowNone ? <option value="">Automatic (match remote host)</option> : null}
      {filtered.map((account) => (
        <option key={account.id} value={account.id}>
          {account.label} · {account.provider} ({account.username || 'no username'})
          {account.hasToken ? '' : ' — no token'}
        </option>
      ))}
    </Select>
  )
}

export function ProviderBadge({ account, provider }: { account?: IntegrationAccount; provider?: ProviderId }) {
  const resolved = account?.provider ?? provider
  if (!resolved) return <Badge tone="outline">no forge</Badge>
  return (
    <Badge tone={account?.hasToken ? 'blue' : 'outline'} title={account?.baseUrl}>
      {resolved === 'gitea' ? 'gitea' : resolved}
    </Badge>
  )
}
