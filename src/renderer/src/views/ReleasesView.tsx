import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, Calendar, Plus, RefreshCw, Rocket, Tag, Trash2 } from 'lucide-react'
import type { Release } from '@shared/types'
import { useStore } from '../store'
import { call } from '../lib/ipc'
import { formatDate, formatRelativeTime } from '../lib/format'
import { Badge, Button, ConfirmDialog, EmptyState, Field, IconButton, Modal, TextArea, TextInput } from '../components/ui'

export function ReleasesView() {
  const repo = useStore((state) => state.currentRepo)
  const detection = useStore((state) => state.detection)
  const tags = useStore((state) => state.tags)
  const config = useStore((state) => state.config)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const setView = useStore((state) => state.setView)
  const [releases, setReleases] = useState<Release[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [tagName, setTagName] = useState('')
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [prerelease, setPrerelease] = useState(false)
  const [del, setDel] = useState<Release | null>(null)

  const account = useMemo(
    () => config?.integrations.find((item) => item.id === detection.accountId),
    [config?.integrations, detection.accountId]
  )
  const supported = account && account.provider !== 'bitbucket'

  const load = useCallback(async () => {
    if (!detection.accountId || !detection.owner || !detection.repo || !supported) return
    setLoading(true)
    try {
      setReleases(await call('provider.releases', {
        accountId: detection.accountId,
        owner: detection.owner,
        repo: detection.repo
      }))
    } catch (error) {
      notifyError(error)
    } finally {
      setLoading(false)
    }
  }, [detection.accountId, detection.owner, detection.repo, notifyError, supported])

  useEffect(() => {
    void load()
  }, [load])

  if (!repo) return null

  if (!supported) {
    return (
      <div className="view releases-view">
        <EmptyState
          icon={<Rocket size={22} />}
          title={account?.provider === 'bitbucket' ? 'Releases are not supported by Bitbucket Cloud' : 'Connect a forge to manage releases'}
          description={
            account?.provider === 'bitbucket'
              ? 'Bitbucket uses tags and downloadable files instead. Create tags from the Tags view, or connect GitHub, GitLab or Gitea for release notes.'
              : 'Add a GitHub, GitLab, Gitea or Bitbucket account in Settings, then map it to this repository remote.'
          }
          action={
            <div className="row-gap">
              <Button size="sm" variant="outline" onClick={() => setView('tags')}>Open tags</Button>
              <Button size="sm" variant="primary" onClick={() => setView('settings')}>Settings</Button>
            </div>
          }
        />
      </div>
    )
  }

  const create = async (): Promise<void> => {
    if (!tagName.trim() || !name.trim()) {
      notify('A tag and release name are required', 'info')
      return
    }
    setBusy(true)
    try {
      await call('provider.createRelease', {
        accountId: account.id,
        owner: detection.owner!,
        repo: detection.repo!,
        input: { tagName: tagName.trim(), name: name.trim(), body, draft, prerelease }
      })
      notify(`Release ${tagName.trim()} created`, 'success')
      setCreateOpen(false)
      setTagName('')
      setName('')
      setBody('')
      setDraft(false)
      setPrerelease(false)
      await load()
      await useStore.getState().refreshTags(repo.path)
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!del) return
    setBusy(true)
    try {
      await call('provider.deleteRelease', {
        accountId: account.id,
        owner: detection.owner!,
        repo: detection.repo!,
        id: del.id
      })
      notify('Release deleted', 'success')
      setDel(null)
      await load()
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="view releases-view">
      <div className="view-toolbar">
        <div className="toolbar-title">
          <Rocket size={17} />
          <h2>Releases</h2>
          <Badge tone="neutral">{releases.length}</Badge>
          <Badge tone="blue">{detection.owner}/{detection.repo}</Badge>
        </div>
        <div className="toolbar-actions">
          <Button size="sm" variant="ghost" icon={<RefreshCw size={13} />} onClick={() => void load()} loading={loading}>
            Refresh
          </Button>
          <Button size="sm" variant="primary" icon={<Plus size={14} />} onClick={() => { setTagName(tags[0]?.name ?? ''); setName(tags[0]?.name ?? ''); setCreateOpen(true) }}>
            New release
          </Button>
        </div>
      </div>

      {releases.length === 0 && !loading ? (
        <EmptyState
          icon={<Rocket size={22} />}
          title="No releases yet"
          description="Create a release from an existing tag, or publish a new tag and attach release notes."
          action={<Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>Create release</Button>}
        />
      ) : (
        <div className="release-list">
          {releases.map((release) => (
            <article className="release-card" key={release.id}>
              <div className="release-icon">
                <Rocket size={18} />
              </div>
              <div className="release-main">
                <div className="release-title-row">
                  <h3>{release.name}</h3>
                  {release.draft ? <Badge tone="amber">draft</Badge> : null}
                  {release.prerelease ? <Badge tone="purple">pre-release</Badge> : null}
                </div>
                <div className="release-meta">
                  <span>
                    <Tag size={12} /> {release.tagName}
                  </span>
                  <span>
                    <Calendar size={12} /> {formatDate(release.publishedAt ?? release.createdAt)}
                  </span>
                  {release.author ? <span>by {release.author}</span> : null}
                  <span>created {formatRelativeTime(release.createdAt)}</span>
                </div>
                {release.body ? <p className="release-body">{release.body}</p> : null}
              </div>
              <div className="release-actions">
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ArrowUpRight size={13} />}
                  onClick={() => void call('app.openExternal', { url: release.webUrl }).catch(notifyError)}
                >
                  Open
                </Button>
                <IconButton label="Delete release" danger onClick={() => setDel(release)}>
                  <Trash2 size={14} />
                </IconButton>
              </div>
            </article>
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        title="Create release"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void create()}>Publish release</Button>
          </>
        }
      >
        <Field label="Tag" hint="Select an existing tag or type a new tag name.">
          <TextInput
            value={tagName}
            onChange={(event) => {
              setTagName(event.target.value)
              if (!name) setName(event.target.value)
            }}
            list="release-tags"
            placeholder="v1.0.0"
            autoFocus
          />
          <datalist id="release-tags">
            {tags.map((tag) => (
              <option key={tag.name} value={tag.name} />
            ))}
          </datalist>
        </Field>
        <Field label="Release name">
          <TextInput value={name} onChange={(event) => setName(event.target.value)} placeholder="1.0.0 — Worktrees and releases" />
        </Field>
        <Field label="Notes">
          <TextArea value={body} onChange={(event) => setBody(event.target.value)} rows={6} placeholder="What is in this release?" />
        </Field>
        <div className="form-inline">
          <label className="checkbox-row">
            <input type="checkbox" checked={draft} onChange={(event) => setDraft(event.target.checked)} />
            Draft
          </label>
          <label className="checkbox-row">
            <input type="checkbox" checked={prerelease} onChange={(event) => setPrerelease(event.target.checked)} />
            Pre-release
          </label>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(del)}
        title={`Delete release ${del?.name ?? ''}`}
        message={`Delete the release for ${del?.tagName ?? ''}? The tag is kept.`}
        confirmLabel="Delete release"
        danger
        busy={busy}
        onCancel={() => setDel(null)}
        onConfirm={() => void remove()}
      />
    </div>
  )
}
