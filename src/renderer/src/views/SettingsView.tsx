import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  GitBranch,
  KeyRound,
  Laptop,
  Link2,
  Pencil,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  Terminal,
  Trash2,
  UserRound,
  XCircle
} from 'lucide-react'
import { PROVIDERS, type AppConfig, type GitIdentity, type IntegrationAccount, type ProviderId } from '@shared/types'
import { useStore } from '../store'
import { call } from '../lib/ipc'
import { Badge, Button, ConfirmDialog, EmptyState, Field, IconButton, Modal, Select, TextInput, Toggle } from '../components/ui'
import { IdentitySelect, AccountSelect } from '../components/selectors'

type SettingsTab = 'general' | 'identities' | 'integrations' | 'repository' | 'about'

export function SettingsView() {
  const config = useStore((state) => state.config)
  const appInfo = useStore((state) => state.appInfo)
  const repoDefaults = useStore((state) => state.repoDefaults)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const [tab, setTab] = useState<SettingsTab>('general')
  const [busy, setBusy] = useState(false)

  if (!config) return null

  const patch = async (value: Partial<AppConfig>): Promise<void> => {
    try {
      const updated = await call('config.update', { patch: value })
      useStore.setState({ config: updated })
      notify('Preferences saved', 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  return (
    <div className="view settings-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <Settings2 size={17} />
          <h2>Settings</h2>
        </div>
        <div className="settings-tabs">
          {([
            ['general', 'General'],
            ['identities', 'Git identities'],
            ['integrations', 'Integrations'],
            ['repository', 'Repository'],
            ['about', 'About & diagnostics']
          ] as const).map(([id, label]) => (
            <button key={id} className={tab === id ? 'is-active' : ''} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="settings-body">
        {tab === 'general' ? <GeneralSettings config={config} appInfo={appInfo} patch={patch} notify={notify} /> : null}
        {tab === 'identities' ? <IdentitiesSettings busy={busy} setBusy={setBusy} /> : null}
        {tab === 'integrations' ? <IntegrationsSettings busy={busy} setBusy={setBusy} /> : null}
        {tab === 'repository' ? (
          <RepositorySettings repoDefaults={repoDefaults} />
        ) : null}
        {tab === 'about' ? <AboutSettings /> : null}
      </div>
    </div>
  )
}

function GeneralSettings({
  config,
  appInfo,
  patch,
  notify
}: {
  config: AppConfig
  appInfo: ReturnType<typeof useStore.getState>['appInfo']
  patch: (value: Partial<AppConfig>) => Promise<void>
  notify: (message: string, kind?: 'info' | 'success' | 'error') => void
}) {
  const [gitPath, setGitPath] = useState(config.gitBinary)
  const [checking, setChecking] = useState(false)
  const [gitResult, setGitResult] = useState<{ available: boolean; version: string; error?: string } | null>(null)

  const checkGit = async (path?: string): Promise<void> => {
    setChecking(true)
    try {
      const result = await call('app.checkGit', { path: path || undefined })
      setGitResult(result)
      if (result.available) {
        notify(result.version, 'success')
        await useStore.getState().refreshConfig()
        useStore.setState({ appInfo: await call('app.info', undefined) })
      } else {
        notify(result.error || 'Git not found', 'error')
      }
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), 'error')
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="settings-sections">
      <section className="settings-card">
        <h3>Appearance</h3>
        <p>GitGrove follows the theme across all views and the git console.</p>
        <Field label="Theme">
          <Select value={config.theme} onChange={(event) => void patch({ theme: event.target.value as 'dark' | 'light' | 'system' })}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="system">Match system</option>
          </Select>
        </Field>
        <Field label="Commits loaded in the graph" hint="Higher values use more memory; 500 is a good default.">
          <TextInput
            type="number"
            min={50}
            max={5000}
            value={config.maxCommits}
            onChange={(event) => void patch({ maxCommits: Number(event.target.value) })}
          />
        </Field>
        <Toggle
          checked={config.autoFetchOnOpen}
          onChange={(value) => void patch({ autoFetchOnOpen: value })}
          label="Fetch when opening a repository"
          hint="Runs git fetch in the background after opening a repo."
        />
        <Toggle
          checked={config.confirmDestructive}
          onChange={(value) => void patch({ confirmDestructive: value })}
          label="Confirm destructive actions"
          hint="Ask before discarding changes, deleting branches, tags and worktrees."
        />
      </section>

      <section className="settings-card">
        <h3>System Git</h3>
        <p>GitGrove shells out to the Git installed on this machine. No bundled Git, no libgit2.</p>
        <div className="git-status-row">
          <span className={`git-status-dot ${appInfo?.git.available ? 'is-ok' : 'is-bad'}`} />
          <span>
            {appInfo?.git.available ? appInfo.git.version : appInfo?.git.error || 'Git not detected'}
          </span>
          <Badge tone={appInfo?.git.available ? 'green' : 'red'}>{appInfo?.git.path}</Badge>
        </div>
        <Field label="Git executable" hint="Leave empty to use git from PATH. A custom path is stored in the app config.">
          <div className="row-gap">
            <TextInput value={gitPath} onChange={(event) => setGitPath(event.target.value)} placeholder="/usr/bin/git" />
            <Button size="sm" variant="outline" loading={checking} onClick={() => void checkGit(gitPath)}>
              Test
            </Button>
            <Button
              size="sm"
              variant="ghost"
              icon={<FolderOpen size={13} />}
              onClick={() =>
                void call('app.pickFile', { title: 'Select the git executable' }).then((chosen) => {
                  if (chosen) {
                    setGitPath(chosen)
                    void checkGit(chosen)
                  }
                })
              }
            >
              Browse
            </Button>
          </div>
        </Field>
        {gitResult ? (
          <div className={`inline-result ${gitResult.available ? 'ok' : 'bad'}`}>
            {gitResult.available ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
            {gitResult.available ? gitResult.version : gitResult.error}
          </div>
        ) : null}
      </section>

      <section className="settings-card">
        <h3>Default forge</h3>
        <p>Used when a remote host cannot be matched to a configured integration.</p>
        <Field label="Provider">
          <Select value={config.defaultProvider ?? ''} onChange={(event) => void patch({ defaultProvider: (event.target.value || undefined) as ProviderId | undefined })}>
            <option value="">Automatic</option>
            {Object.values(PROVIDERS).map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </Select>
        </Field>
      </section>
    </div>
  )
}

interface IdentityFormState {
  open: boolean
  id?: string
  label: string
  name: string
  email: string
  sshKeyPath: string
  gpgKeyId: string
  gpgSign: boolean
  isDefault: boolean
}

const emptyIdentityForm: IdentityFormState = {
  open: false,
  label: '',
  name: '',
  email: '',
  sshKeyPath: '',
  gpgKeyId: '',
  gpgSign: false,
  isDefault: false
}

function IdentitiesSettings({ busy, setBusy }: { busy: boolean; setBusy: (value: boolean) => void }) {
  const config = useStore((state) => state.config)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshConfig = useStore((state) => state.refreshConfig)
  const [form, setForm] = useState<IdentityFormState>(emptyIdentityForm)
  const [del, setDel] = useState<GitIdentity | null>(null)
  const identities = config?.identities ?? []

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('identity.save', {
        id: form.id,
        label: form.label,
        name: form.name,
        email: form.email,
        sshKeyPath: form.sshKeyPath || undefined,
        gpgKeyId: form.gpgKeyId || undefined,
        gpgSign: form.gpgSign,
        isDefault: form.isDefault
      })
      await refreshConfig()
      setForm(emptyIdentityForm)
      notify('Identity saved', 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-sections">
      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Git identities</h3>
            <p>Name and email written into commits and tags. Pick a default, or override per repository and per integration.</p>
          </div>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setForm({ ...emptyIdentityForm, open: true })}>
            Add identity
          </Button>
        </div>
        {identities.length === 0 ? (
          <EmptyState icon={<UserRound size={20} />} title="No identities" description="Add the name and email you use for commits." />
        ) : (
          <div className="account-list">
            {identities.map((identity) => (
              <article className="account-row" key={identity.id}>
                <span className="account-avatar">{identity.name.slice(0, 1).toUpperCase()}</span>
                <div className="account-main">
                  <div className="account-title">
                    <strong>{identity.label}</strong>
                    {identity.isDefault ? <Badge tone="green">default</Badge> : null}
                    {identity.gpgSign ? <Badge tone="purple">signed</Badge> : null}
                  </div>
                  <span>{identity.name} &lt;{identity.email}&gt;</span>
                  {identity.sshKeyPath ? <span className="mono account-sub">SSH · {identity.sshKeyPath}</span> : null}
                </div>
                <div className="account-actions">
                  {!identity.isDefault ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void call('identity.setDefault', { id: identity.id }).then((updated) => {
                          useStore.setState({ config: updated })
                          notify('Default identity updated', 'success')
                        }).catch(notifyError)
                      }
                    >
                      Make default
                    </Button>
                  ) : null}
                  <IconButton
                    label="Edit identity"
                    onClick={() =>
                      setForm({
                        open: true,
                        id: identity.id,
                        label: identity.label,
                        name: identity.name,
                        email: identity.email,
                        sshKeyPath: identity.sshKeyPath ?? '',
                        gpgKeyId: identity.gpgKeyId ?? '',
                        gpgSign: Boolean(identity.gpgSign),
                        isDefault: Boolean(identity.isDefault)
                      })
                    }
                  >
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton label="Delete identity" danger onClick={() => setDel(identity)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={form.open}
        title={form.id ? 'Edit identity' : 'Add identity'}
        onClose={() => setForm(emptyIdentityForm)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(emptyIdentityForm)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>Save identity</Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Label">
            <TextInput value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="Work" autoFocus />
          </Field>
          <Field label="Name">
            <TextInput value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Ada Lovelace" />
          </Field>
        </div>
        <Field label="Email">
          <TextInput value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} placeholder="ada@example.com" />
        </Field>
        <Field label="SSH key" hint="Optional. Used with GIT_SSH_COMMAND when pushing over SSH.">
          <div className="row-gap">
            <TextInput value={form.sshKeyPath} onChange={(event) => setForm({ ...form, sshKeyPath: event.target.value })} placeholder="~/.ssh/id_ed25519" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void call('app.pickFile', { title: 'Select an SSH private key' }).then((chosen) => chosen && setForm({ ...form, sshKeyPath: chosen }))}
            >
              Browse
            </Button>
          </div>
        </Field>
        <div className="form-grid">
          <Field label="GPG key id" hint="Optional commit signing key.">
            <TextInput value={form.gpgKeyId} onChange={(event) => setForm({ ...form, gpgKeyId: event.target.value })} placeholder="ABCD1234" />
          </Field>
          <label className="checkbox-row compact">
            <input type="checkbox" checked={form.gpgSign} onChange={(event) => setForm({ ...form, gpgSign: event.target.checked })} />
            Sign commits
          </label>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={form.isDefault} onChange={(event) => setForm({ ...form, isDefault: event.target.checked })} />
          Make this the default identity
        </label>
      </Modal>

      <ConfirmDialog
        open={Boolean(del)}
        title={`Delete ${del?.label ?? 'identity'}`}
        message="Repositories and integrations linked to this identity will fall back to the default identity."
        confirmLabel="Delete"
        danger
        busy={busy}
        onCancel={() => setDel(null)}
        onConfirm={() => {
          if (!del) return
          setBusy(true)
          void call('identity.delete', { id: del.id })
            .then(async () => {
              await refreshConfig()
              setDel(null)
              notify('Identity deleted', 'success')
            })
            .catch(notifyError)
            .finally(() => setBusy(false))
        }}
      />
    </div>
  )
}

interface IntegrationFormState {
  open: boolean
  id?: string
  provider: ProviderId
  label: string
  username: string
  baseUrl: string
  identityId: string
  token: string
}

const emptyIntegration = (): IntegrationFormState => ({
  open: false,
  provider: 'github',
  label: 'GitHub',
  username: '',
  baseUrl: PROVIDERS.github.defaultBaseUrl,
  identityId: '',
  token: ''
})

function IntegrationsSettings({ busy, setBusy }: { busy: boolean; setBusy: (value: boolean) => void }) {
  const config = useStore((state) => state.config)
  const appInfo = useStore((state) => state.appInfo)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshConfig = useStore((state) => state.refreshConfig)
  const [form, setForm] = useState<IntegrationFormState>(emptyIntegration())
  const [del, setDel] = useState<IntegrationAccount | null>(null)
  const [testing, setTesting] = useState<string | null>(null)
  const integrations = config?.integrations ?? []

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await call('integration.save', {
        id: form.id,
        provider: form.provider,
        label: form.label,
        username: form.username,
        baseUrl: form.baseUrl,
        identityId: form.identityId || undefined,
        token: form.token || undefined
      })
      await refreshConfig()
      setForm(emptyIntegration())
      notify('Integration saved', 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-sections">
      <section className="settings-card">
        <div className="settings-card-head">
          <div>
            <h3>Forge integrations</h3>
            <p>Tokens are used only by the main process for HTTPS Git and forge APIs. They are encrypted with your OS keychain when available.</p>
          </div>
          <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => setForm({ ...emptyIntegration(), open: true })}>
            Add account
          </Button>
        </div>
        {!appInfo?.secretsEncrypted ? (
          <div className="inline-result warn">
            <AlertTriangle size={14} /> OS encryption is unavailable. Tokens are stored with file permissions 0600, not encrypted.
          </div>
        ) : (
          <div className="inline-result ok">
            <ShieldCheck size={14} /> Tokens are encrypted with the OS credential store.
          </div>
        )}
        {integrations.length === 0 ? (
          <EmptyState icon={<Link2 size={20} />} title="No integrations" description="Connect GitHub, GitLab, Bitbucket or Gitea with a personal access token." />
        ) : (
          <div className="account-list">
            {integrations.map((account) => (
              <article className="account-row" key={account.id}>
                <span className={`account-provider provider-${account.provider}`}>{account.provider.slice(0, 2).toUpperCase()}</span>
                <div className="account-main">
                  <div className="account-title">
                    <strong>{account.label}</strong>
                    <Badge tone="outline">{PROVIDERS[account.provider].name}</Badge>
                    <Badge tone={account.hasToken ? 'green' : 'red'}>{account.hasToken ? 'token stored' : 'no token'}</Badge>
                  </div>
                  <span className="mono">{account.baseUrl}</span>
                  <span className="account-sub">{account.username || 'no username'} · added {new Date(account.createdAt).toLocaleDateString()}</span>
                </div>
                <div className="account-actions">
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={testing === account.id}
                    onClick={() => {
                      setTesting(account.id)
                      void call('integration.test', { id: account.id })
                        .then((result) => notify(result.message, result.ok ? 'success' : 'error'))
                        .finally(() => setTesting(null))
                    }}
                  >
                    {account.hasToken ? 'Test' : 'Needs token'}
                  </Button>
                  <IconButton
                    label="Edit integration"
                    onClick={() =>
                      setForm({
                        open: true,
                        id: account.id,
                        provider: account.provider,
                        label: account.label,
                        username: account.username,
                        baseUrl: account.baseUrl,
                        identityId: account.identityId ?? '',
                        token: ''
                      })
                    }
                  >
                    <Pencil size={14} />
                  </IconButton>
                  <IconButton label="Delete integration" danger onClick={() => setDel(account)}>
                    <Trash2 size={14} />
                  </IconButton>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <Modal
        open={form.open}
        title={form.id ? 'Edit integration' : 'Add integration'}
        onClose={() => setForm(emptyIntegration())}
        footer={
          <>
            <Button variant="ghost" onClick={() => setForm(emptyIntegration())}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void save()}>Save integration</Button>
          </>
        }
      >
        <Field label="Provider">
          <Select
            value={form.provider}
            onChange={(event) => {
              const provider = event.target.value as ProviderId
              setForm({
                ...form,
                provider,
                label: PROVIDERS[provider].name,
                baseUrl: PROVIDERS[provider].defaultBaseUrl
              })
            }}
          >
            {Object.values(PROVIDERS).map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.name}</option>
            ))}
          </Select>
        </Field>
        <div className="form-grid">
          <Field label="Label">
            <TextInput value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </Field>
          <Field label="Username" hint="Used for HTTPS auth on Bitbucket; optional elsewhere.">
            <TextInput value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="octocat" />
          </Field>
        </div>
        <Field label="API base URL" hint={PROVIDERS[form.provider].tokenHint}>
          <TextInput value={form.baseUrl} onChange={(event) => setForm({ ...form, baseUrl: event.target.value })} />
        </Field>
        <Field label={form.id ? 'Replace token' : 'Personal access token'} hint={form.id ? 'Leave blank to keep the stored token.' : undefined}>
          <TextInput type="password" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} placeholder="ghp_…" autoComplete="off" />
        </Field>
        <Field label="Linked identity">
          <IdentitySelect value={form.identityId || undefined} onChange={(value) => setForm({ ...form, identityId: value ?? '' })} />
        </Field>
        <div className="inline-info">
          <KeyRound size={13} /> Create a token at{' '}
          <button className="link-button" onClick={() => void call('app.openExternal', { url: PROVIDERS[form.provider].tokenUrl })}>
            {new URL(PROVIDERS[form.provider].tokenUrl).host}
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(del)}
        title={`Delete ${del?.label ?? 'integration'}`}
        message="The stored token will be removed. Repositories mapped to this account will fall back to automatic matching."
        confirmLabel="Delete"
        danger
        busy={busy}
        onCancel={() => setDel(null)}
        onConfirm={() => {
          if (!del) return
          setBusy(true)
          void call('integration.delete', { id: del.id })
            .then(async () => {
              await refreshConfig()
              setDel(null)
              notify('Integration deleted', 'success')
            })
            .catch(notifyError)
            .finally(() => setBusy(false))
        }}
      />
    </div>
  )
}

function RepositorySettings({ repoDefaults }: { repoDefaults: ReturnType<typeof useStore.getState>['repoDefaults'] }) {
  const repo = useStore((state) => state.currentRepo)
  const detection = useStore((state) => state.detection)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const refreshConfig = useStore((state) => state.refreshConfig)
  const [entries, setEntries] = useState<Array<{ key: string; value: string; scope: string }>>([])

  useEffect(() => {
    if (!repo?.path) return
    void call('git.config', { path: repo.path }).then((list) => setEntries(list.slice(0, 40))).catch(notifyError)
  }, [notifyError, repo?.path])

  if (!repo) {
    return <EmptyState icon={<GitBranch size={20} />} title="No repository open" description="Open a repository to configure its identity and forge mapping." />
  }

  const setDefaults = async (value: typeof repoDefaults): Promise<void> => {
    try {
      const defaults = await call('repo.setDefaults', { path: repo.path, defaults: value })
      useStore.setState({ repoDefaults: defaults })
      await refreshConfig()
      notify('Repository settings saved', 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  return (
    <div className="settings-sections">
      <section className="settings-card">
        <h3>Repository</h3>
        <div className="kv-grid">
          <span>Name</span><span>{repo.name}</span>
          <span>Path</span><span className="mono">{repo.path}</span>
          <span>Git directory</span><span className="mono">{repo.gitDir}</span>
          <span>Branch</span><span>{repo.currentBranch ?? 'detached'}</span>
          <span>Worktree</span><span>{repo.worktree ? 'linked worktree' : 'main checkout'}</span>
          <span>State</span><span>{repo.state}</span>
          <span>Forge</span><span>{detection.provider ?? 'not detected'}</span>
        </div>
        <div className="row-gap">
          <Button size="sm" variant="outline" icon={<FolderOpen size={13} />} onClick={() => void call('app.showItemInFolder', { path: repo.path })}>
            Show in file manager
          </Button>
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void useStore.getState().refreshAll()}>
            Refresh
          </Button>
        </div>
      </section>

      <section className="settings-card">
        <h3>Defaults for this repository</h3>
        <Field label="Git identity">
          <IdentitySelect value={repoDefaults.identityId} onChange={(value) => void setDefaults({ ...repoDefaults, identityId: value })} />
        </Field>
        <Field label="Default remote">
          <Select value={repoDefaults.defaultRemote ?? ''} onChange={(event) => void setDefaults({ ...repoDefaults, defaultRemote: event.target.value || undefined })}>
            <option value="">First remote</option>
            {repo.remotes.map((remote) => (
              <option key={remote.name} value={remote.name}>{remote.name}</option>
            ))}
          </Select>
        </Field>
        {(['github', 'gitlab', 'bitbucket', 'gitea'] as const).map((provider) => (
          <Field key={provider} label={`${PROVIDERS[provider].name} account`}>
            <AccountSelect
              provider={provider}
              value={repoDefaults.integrationByProvider[provider]}
              onChange={(value) =>
                void setDefaults({
                  ...repoDefaults,
                  integrationByProvider: { ...repoDefaults.integrationByProvider, [provider]: value }
                })
              }
            />
          </Field>
        ))}
      </section>

      <section className="settings-card">
        <h3>Git configuration</h3>
        <p>Effective values from system, global and local scopes.</p>
        <div className="config-table">
          {entries.map((entry) => (
            <div key={`${entry.scope}-${entry.key}`}>
              <Badge tone="outline">{entry.scope}</Badge>
              <span className="mono">{entry.key}</span>
              <span className="mono config-value">{entry.value}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function AboutSettings() {
  const appInfo = useStore((state) => state.appInfo)
  const notify = useStore((state) => state.notify)
  const diagnostics = useMemo(
    () =>
      JSON.stringify(
        {
          app: appInfo?.version,
          electron: appInfo?.electron,
          chrome: appInfo?.chrome,
          node: appInfo?.node,
          platform: appInfo?.platform,
          arch: appInfo?.arch,
          git: appInfo?.git,
          configPath: appInfo?.configPath,
          secretsEncrypted: appInfo?.secretsEncrypted
        },
        null,
        2
      ),
    [appInfo]
  )

  return (
    <div className="settings-sections">
      <section className="settings-card about-card">
        <div className="about-brand">
          <Laptop size={28} />
          <div>
            <h3>GitGrove {appInfo?.version}</h3>
            <p>
              A focused Git desktop client built on your system Git, with multi-account identities and
              multi-forge integrations.
            </p>
          </div>
        </div>
        <div className="kv-grid">
          <span>Electron</span><span>{appInfo?.electron}</span>
          <span>Chromium</span><span>{appInfo?.chrome}</span>
          <span>Node</span><span>{appInfo?.node}</span>
          <span>Platform</span><span>{appInfo?.platform} / {appInfo?.arch}</span>
          <span>Git</span><span>{appInfo?.git.version || 'not available'}</span>
          <span>Git path</span><span className="mono">{appInfo?.git.path}</span>
          <span>Config</span><span className="mono">{appInfo?.configPath}</span>
          <span>Secrets</span><span>{appInfo?.secretsEncrypted ? 'encrypted with OS keychain' : 'plain file (0600)'}</span>
        </div>
        <div className="row-gap">
          <Button size="sm" variant="outline" icon={<Terminal size={13} />} onClick={() => void call('app.openConfigFolder', undefined)}>
            Open config folder
          </Button>
          <Button size="sm" variant="ghost" icon={<ExternalLink size={13} />} onClick={() => void call('app.openExternal', { url: 'https://git-scm.com/doc' })}>
            Git documentation
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(diagnostics).then(() => notify('Diagnostics copied', 'success'))
            }}
          >
            Copy diagnostics
          </Button>
        </div>
        <details className="diagnostics">
          <summary>Diagnostics JSON</summary>
          <pre>{diagnostics}</pre>
        </details>
      </section>
    </div>
  )
}
