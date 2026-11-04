import { useMemo, useState } from 'react'
import { Cloud, CloudDownload, Link2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { RemoteInfo } from '@shared/types'
import { useStore } from '../store'
import { call } from '../lib/ipc'
import { Badge, Button, ConfirmDialog, Field, IconButton, Modal, Select, TextInput } from '../components/ui'
import { AccountSelect, ProviderBadge } from '../components/selectors'

export function RemotesView() {
  const repo = useStore((state) => state.currentRepo)
  const detection = useStore((state) => state.detection)
  const repoDefaults = useStore((state) => state.repoDefaults)
  const integrations = useStore((state) => state.config?.integrations ?? [])
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const [busy, setBusy] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [edit, setEdit] = useState<RemoteInfo | null>(null)
  const [editUrl, setEditUrl] = useState('')
  const [editPushUrl, setEditPushUrl] = useState('')
  const [remove, setRemove] = useState<RemoteInfo | null>(null)
  const account = useMemo(
    () => integrations.find((item) => item.id === detection.accountId),
    [detection.accountId, integrations]
  )

  if (!repo) return null

  const run = async (task: () => Promise<void>, message?: string): Promise<void> => {
    setBusy(true)
    try {
      await task()
      const info = await call('repo.info', { path: repo.path })
      useStore.setState({ currentRepo: info })
      if (message) notify(message, 'success')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const add = (): void => {
    if (!name.trim() || !url.trim()) return
    void run(async () => {
      await call('git.remoteAdd', { path: repo.path, name: name.trim(), url: url.trim() })
      setAddOpen(false)
      setName('')
      setUrl('')
    }, 'Remote added')
  }

  const saveEdit = (): void => {
    if (!edit) return
    void run(async () => {
      await call('git.remoteSetUrl', { path: repo.path, name: edit.name, url: editUrl.trim() })
      if (editPushUrl.trim() && editPushUrl.trim() !== editUrl.trim()) {
        await call('git.remoteSetUrl', { path: repo.path, name: edit.name, url: editPushUrl.trim(), push: true })
      }
      setEdit(null)
    }, 'Remote updated')
  }

  const doRemove = (): void => {
    if (!remove) return
    void run(async () => {
      await call('git.remoteRemove', { path: repo.path, name: remove.name })
      setRemove(null)
    }, 'Remote removed')
  }

  const saveMapping = async (provider: keyof typeof repoDefaults.integrationByProvider, accountId?: string): Promise<void> => {
    try {
      const defaults = await call('repo.setDefaults', {
        path: repo.path,
        defaults: {
          ...repoDefaults,
          integrationByProvider: { ...repoDefaults.integrationByProvider, [provider]: accountId }
        }
      })
      useStore.setState({ repoDefaults: defaults, detection: await call('provider.detect', { path: repo.path }) })
      await useStore.getState().refreshConfig()
      notify('Integration mapping saved', 'success')
    } catch (error) {
      notifyError(error)
    }
  }

  const saveDefaultRemote = async (value: string): Promise<void> => {
    try {
      const defaults = await call('repo.setDefaults', {
        path: repo.path,
        defaults: { ...repoDefaults, defaultRemote: value || undefined }
      })
      useStore.setState({ repoDefaults: defaults })
    } catch (error) {
      notifyError(error)
    }
  }

  return (
    <div className="view remotes-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <Cloud size={17} />
          <h2>Remotes</h2>
          <Badge tone="neutral">{repo.remotes.length}</Badge>
          {detection.provider ? <Badge tone="blue">{detection.provider}</Badge> : null}
        </div>
        <div className="toolbar-actions">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void useStore.getState().refreshAll()}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => setAddOpen(true)}>
            Add remote
          </Button>
        </div>
      </div>

      <div className="remotes-layout">
        <div className="remote-list">
          {repo.remotes.map((remote) => {
            const remoteProvider = remote.provider
            const remoteAccount = remoteProvider ? integrations.find((item) => item.provider === remoteProvider && item.hasToken) : undefined
            return (
              <article className="remote-card" key={remote.name}>
                <header className="remote-head">
                  <span className="remote-icon">
                    <Cloud size={16} />
                  </span>
                  <span className="remote-name">{remote.name}</span>
                  <ProviderBadge provider={remote.provider} account={remoteAccount} />
                  {repoDefaults.defaultRemote === remote.name ? <Badge tone="green">default</Badge> : null}
                  <div className="remote-actions">
                    <IconButton
                      label="Fetch this remote"
                      onClick={() =>
                        void call('git.fetch', { repoPath: repo.path, remote: remote.name, prune: true, accountId: remoteAccount?.id }).catch(notifyError)
                      }
                    >
                      <CloudDownload size={14} />
                    </IconButton>
                    <IconButton label="Edit remote" onClick={() => { setEdit(remote); setEditUrl(remote.fetchUrl); setEditPushUrl(remote.pushUrl) }}>
                      <Pencil size={14} />
                    </IconButton>
                    <IconButton label="Remove remote" danger onClick={() => setRemove(remote)}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                </header>
                <div className="remote-url">
                  <Link2 size={12} />
                  <span className="mono">{remote.fetchUrl}</span>
                </div>
                {remote.pushUrl && remote.pushUrl !== remote.fetchUrl ? (
                  <div className="remote-url">
                    <Link2 size={12} />
                    <span className="mono">push → {remote.pushUrl}</span>
                  </div>
                ) : null}
                <div className="remote-meta">
                  <span>{remote.host ?? 'unknown host'}</span>
                  <span>{remote.owner && remote.repo ? `${remote.owner}/${remote.repo}` : ''}</span>
                </div>
              </article>
            )
          })}
          {repo.remotes.length === 0 ? <div className="table-empty">No remotes. Add one to fetch, pull and push.</div> : null}
        </div>

        <aside className="remote-settings">
          <h3>Repository wiring</h3>
          <p>Choose the identity and forge account used by default for this repository.</p>
          <Field label="Default remote">
            <Select value={repoDefaults.defaultRemote ?? ''} onChange={(event) => void saveDefaultRemote(event.target.value)}>
              <option value="">First remote</option>
              {repo.remotes.map((remote) => (
                <option key={remote.name} value={remote.name}>{remote.name}</option>
              ))}
            </Select>
          </Field>
          <Field label="Default Git identity" hint="Used for commits, merges, tags and pushes.">
            <Select
              value={repoDefaults.identityId ?? ''}
              onChange={(event) =>
                void call('repo.setDefaults', {
                  path: repo.path,
                  defaults: { ...repoDefaults, identityId: event.target.value || undefined }
                }).then((defaults) => {
                  useStore.setState({ repoDefaults: defaults })
                  void useStore.getState().refreshConfig()
                })
              }
            >
              <option value="">Default identity</option>
              {(useStore.getState().config?.identities ?? []).map((identity) => (
                <option key={identity.id} value={identity.id}>{identity.name} · {identity.email}</option>
              ))}
            </Select>
          </Field>
          {(['github', 'gitlab', 'bitbucket', 'gitea'] as const).map((provider) => (
            <Field key={provider} label={`${provider} account`}>
              <AccountSelect
                provider={provider}
                value={repoDefaults.integrationByProvider[provider]}
                onChange={(value) => void saveMapping(provider, value)}
              />
            </Field>
          ))}
          <div className="remote-account-card">
            <span>Active forge</span>
            {account ? (
              <>
                <strong>{account.label}</strong>
                <span className="mono">{account.baseUrl}</span>
                <span>{account.username || 'no username'} · {account.hasToken ? 'token stored' : 'no token'}</span>
              </>
            ) : (
              <span>No account matched this remote. Connect one in Settings → Integrations.</span>
            )}
          </div>
        </aside>
      </div>

      <Modal
        open={addOpen}
        title="Add remote"
        onClose={() => setAddOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={add}>Add remote</Button>
          </>
        }
      >
        <Field label="Name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="origin" autoFocus />
        </Field>
        <Field label="URL">
          <TextInput value={url} onChange={(event) => setUrl(event.target.value)} placeholder="git@github.com:owner/repo.git" />
        </Field>
      </Modal>

      <Modal
        open={Boolean(edit)}
        title={`Edit ${edit?.name ?? ''}`}
        onClose={() => setEdit(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={saveEdit}>Save</Button>
          </>
        }
      >
        <Field label="Fetch URL">
          <TextInput value={editUrl} onChange={(event) => setEditUrl(event.target.value)} />
        </Field>
        <Field label="Push URL" hint="Leave empty to use the fetch URL.">
          <TextInput value={editPushUrl} onChange={(event) => setEditPushUrl(event.target.value)} />
        </Field>
      </Modal>

      <ConfirmDialog
        open={Boolean(remove)}
        title="Remove remote"
        message={`Remove remote "${remove?.name}"? Branches and commits stay local.`}
        confirmLabel="Remove"
        danger
        busy={busy}
        onCancel={() => setRemove(null)}
        onConfirm={doRemove}
      />
    </div>
  )
}
