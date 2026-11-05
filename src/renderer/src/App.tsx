import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderGit2, Plus } from 'lucide-react'
import { activeIdentity, useStore } from './store'
import { call, errorMessage } from './lib/ipc'
import { Logo, TitleBar } from './components/TitleBar'
import { Sidebar } from './components/Sidebar'
import { StatusBar, RepoOperationBanner } from './components/StatusBar'
import { Toasts } from './components/Toasts'
import { CommandPalette, type PaletteAction } from './components/CommandPalette'
import { RebasePlanner } from './components/RebasePlanner'
import { ConsoleDrawer } from './components/ConsoleDrawer'
import { Launchpad } from './views/Launchpad'
import { GraphView } from './views/GraphView'
import { FilesView } from './views/FilesView'
import { BranchesView } from './views/BranchesView'
import { WorktreesView } from './views/WorktreesView'
import { SubmodulesView } from './views/SubmodulesView'
import { TagsView } from './views/TagsView'
import { StashesView } from './views/StashesView'
import { RemotesView } from './views/RemotesView'
import { PullsView } from './views/PullsView'
import { ReleasesView } from './views/ReleasesView'
import { ActionsView } from './views/ActionsView'
import { SettingsView } from './views/SettingsView'
import { Button, Field, Modal, Select, TextInput } from './components/ui'
import { IdentitySelect, AccountSelect } from './components/selectors'

export function App() {
  const ready = useStore((state) => state.ready)
  const fatal = useStore((state) => state.fatal)
  const init = useStore((state) => state.init)
  const config = useStore((state) => state.config)
  const repo = useStore((state) => state.currentRepo)
  const status = useStore((state) => state.status)
  const view = useStore((state) => state.view)
  const sidebarOpen = useStore((state) => state.sidebarOpen)
  const notify = useStore((state) => state.notify)
  const notifyError = useStore((state) => state.notifyError)
  const openRepo = useStore((state) => state.openRepo)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [initOpen, setInitOpen] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneParent, setCloneParent] = useState('')
  const [cloneName, setCloneName] = useState('')
  const [cloneIdentity, setCloneIdentity] = useState<string | undefined>()
  const [cloneAccount, setCloneAccount] = useState<string | undefined>()
  const [cloneBare, setCloneBare] = useState(false)
  const [initParent, setInitParent] = useState('')
  const [initName, setInitName] = useState('')
  const [initBranch, setInitBranch] = useState('main')
  const [initIdentity, setInitIdentity] = useState<string | undefined>()
  const [pushOpen, setPushOpen] = useState(false)
  const [pushRemote, setPushRemote] = useState('')
  const [pushBranch, setPushBranch] = useState('')
  const [pushIdentity, setPushIdentity] = useState<string | undefined>()
  const [pushAccount, setPushAccount] = useState<string | undefined>()
  const [pushUpstream, setPushUpstream] = useState(true)
  const [pushForce, setPushForce] = useState<'none' | 'with-lease' | 'force'>('none')
  const [busy, setBusy] = useState(false)
  const [bootComplete, setBootComplete] = useState(false)
  const pendingClone = useRef<string | null>(null)
  const fetchedFor = useRef<string | null>(null)

  useEffect(() => {
    void init()
      .then(async () => {
        const target = await call('app.launchTarget', undefined).catch(() => null)
        if (target) {
          await useStore.getState().openRepo(target).catch((error) => useStore.getState().notifyError(errorMessage(error)))
        }
      })
      .finally(() => setBootComplete(true))
    const unsubscribeTasks = window.gitgrove.onTaskEvent((event) => {
      useStore.getState().handleTaskEvent(event)
      if (event.kind === 'clone' && event.phase === 'end' && pendingClone.current) {
        const target = pendingClone.current
        pendingClone.current = null
        void useStore.getState().openRepo(target).catch((error) => useStore.getState().notifyError(error))
      }
    })
    const unsubscribeMenu = window.gitgrove.onMenu((action) => {
      if (action.startsWith('open-path:')) {
        void useStore.getState().openRepo(action.slice('open-path:'.length)).catch((error) => useStore.getState().notifyError(error))
        return
      }
      switch (action) {
        case 'command-palette':
          useStore.getState().setPaletteOpen(true)
          break
        case 'toggle-console':
          useStore.getState().toggleConsole()
          break
        case 'open-repo':
          void pickAndOpen()
          break
        case 'clone-repo':
          setCloneOpen(true)
          break
        case 'init-repo':
          setInitOpen(true)
          break
      }
    })
    return () => {
      unsubscribeTasks()
      unsubscribeMenu()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!ready) return
    const theme = config?.theme ?? 'dark'
    const resolved = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme
    document.documentElement.dataset.theme = resolved
  }, [config?.theme, ready])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey
      if (!mod) return
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault()
        useStore.getState().setPaletteOpen(!useStore.getState().paletteOpen)
      } else if (event.key.toLowerCase() === 'j') {
        event.preventDefault()
        useStore.getState().toggleConsole()
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault()
        void useStore.getState().refreshAll()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    if (!repo || !config?.autoFetchOnOpen) return
    if (fetchedFor.current === repo.path) return
    const repoPath = repo.path
    fetchedFor.current = repoPath
    const timer = window.setTimeout(() => {
      void call('git.fetch', {
        repoPath,
        prune: true,
        accountId: useStore.getState().detection.accountId
      }).catch(() => undefined)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [config?.autoFetchOnOpen, repo?.path])

  useEffect(() => {
    if (!repo) return undefined
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !useStore.getState().task) {
        void useStore.getState().refreshStatus()
      }
    }, 5000)
    return () => window.clearInterval(timer)
  }, [repo?.path])

  const pickAndOpen = useCallback(async (): Promise<void> => {
    const chosen = await call('app.pickDirectory', { title: 'Open a Git repository' })
    if (!chosen) return
    try {
      await openRepo(chosen)
    } catch (error) {
      notifyError(errorMessage(error))
    }
  }, [notifyError, openRepo])

  const clone = async (): Promise<void> => {
    if (!cloneUrl.trim() || !cloneParent) {
      notify('A repository URL and a parent folder are required', 'info')
      return
    }
    setBusy(true)
    try {
      const folderName = (cloneName.trim() || deriveName(cloneUrl)).replace(/[\\/:*?"<>|]/g, '-')
      const target = `${cloneParent.replace(/[\\/]+$/, '')}/${folderName}`
      await call('repo.clone', {
        url: cloneUrl.trim(),
        directory: cloneParent,
        name: cloneName.trim() || undefined,
        identityId: cloneIdentity,
        accountId: cloneAccount,
        bare: cloneBare
      })
      pendingClone.current = target
      setCloneOpen(false)
      setCloneUrl('')
      setCloneName('')
      notify('Clone started — progress appears in the status bar', 'info')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const createRepo = async (): Promise<void> => {
    if (!initParent || !initName.trim()) {
      notify('A folder and repository name are required', 'info')
      return
    }
    setBusy(true)
    try {
      const info = await call('repo.init', {
        directory: initParent,
        name: initName.trim(),
        defaultBranch: initBranch.trim() || 'main',
        identityId: initIdentity
      })
      setInitOpen(false)
      setInitName('')
      notify('Repository created', 'success')
      await openRepo(info.path)
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const openPush = useCallback((): void => {
    const state = useStore.getState()
    if (!state.currentRepo) return
    setPushRemote(state.repoDefaults.defaultRemote ?? state.currentRepo.remotes[0]?.name ?? '')
    setPushBranch(state.status?.branch ?? state.currentRepo.currentBranch ?? '')
    setPushIdentity(activeIdentity()?.id)
    setPushAccount(state.detection.accountId)
    setPushUpstream(!state.status?.upstream)
    setPushForce('none')
    setPushOpen(true)
  }, [])

  const push = async (): Promise<void> => {
    const repoNow = useStore.getState().currentRepo
    if (!repoNow) return
    setBusy(true)
    try {
      await call('git.push', {
        repoPath: repoNow.path,
        remote: pushRemote || undefined,
        branch: pushBranch || undefined,
        identityId: pushIdentity,
        accountId: pushAccount,
        setUpstream: pushUpstream,
        force: pushForce
      })
      setPushOpen(false)
      notify('Push started — progress appears in the status bar', 'info')
    } catch (error) {
      notifyError(error)
    } finally {
      setBusy(false)
    }
  }

  const paletteAction = useCallback((action: PaletteAction): void => {
    if (action === 'open') void pickAndOpen()
    else if (action === 'clone') setCloneOpen(true)
    else if (action === 'init') setInitOpen(true)
    else if (action === 'new-branch') useStore.getState().setView('branches')
    else if (action === 'new-tag') useStore.getState().setView('tags')
    else if (action === 'new-worktree') useStore.getState().setView('worktrees')
    else if (action === 'new-submodule') useStore.getState().setView('submodules')
    else if (action === 'push') openPush()
  }, [openPush, pickAndOpen])

  if (!ready || (!fatal && !bootComplete)) {
    return (
      <div className="app-boot">
        <Logo size={40} />
        <span>GitGrove</span>
        <div className="boot-bar">
          <span />
        </div>
      </div>
    )
  }

  if (fatal) {
    return (
      <div className="fatal-screen">
        <Logo size={38} />
        <h1>GitGrove could not start</h1>
        <pre>{fatal}</pre>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Retry
        </Button>
      </div>
    )
  }

  return (
    <div className="app">
      <TitleBar onPalette={() => useStore.getState().setPaletteOpen(true)} onPush={openPush} />
      <div className="app-body">
        {sidebarOpen ? <Sidebar /> : null}
        <main className="content">
          {!repo ? (
            view === 'settings' ? (
              <SettingsView />
            ) : (
              <Launchpad onOpen={() => void pickAndOpen()} onClone={() => setCloneOpen(true)} onInit={() => setInitOpen(true)} />
            )
          ) : (
            <>
              <RepoOperationBanner />
              <div className="view-host">
                {view === 'graph' ? <GraphView /> : null}
                {view === 'files' ? <FilesView /> : null}
                {view === 'branches' ? <BranchesView /> : null}
                {view === 'worktrees' ? <WorktreesView /> : null}
                {view === 'submodules' ? <SubmodulesView /> : null}
                {view === 'tags' ? <TagsView /> : null}
                {view === 'stashes' ? <StashesView /> : null}
                {view === 'remotes' ? <RemotesView /> : null}
                {view === 'pulls' ? <PullsView /> : null}
                {view === 'releases' ? <ReleasesView /> : null}
                {view === 'actions' ? <ActionsView /> : null}
                {view === 'settings' ? <SettingsView /> : null}
              </div>
              <ConsoleDrawer />
            </>
          )}
        </main>
      </div>
      <StatusBar />
      <CommandPalette action={paletteAction} />
      <RebasePlanner />
      <Toasts />

      <Modal
        open={cloneOpen}
        title="Clone repository"
        subtitle="Uses system git. HTTPS credentials come from the selected integration account."
        onClose={() => setCloneOpen(false)}
        width={560}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCloneOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} icon={<FolderGit2 size={15} />} onClick={() => void clone()}>
              Clone
            </Button>
          </>
        }
      >
        <Field label="Repository URL">
          <TextInput value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="https://github.com/owner/repo.git" autoFocus />
        </Field>
        <Field label="Parent folder">
          <div className="row-gap">
            <TextInput value={cloneParent} onChange={(event) => setCloneParent(event.target.value)} placeholder="/home/you/Projects" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void call('app.pickDirectory', { title: 'Choose a parent folder' }).then((chosen) => chosen && setCloneParent(chosen))}
            >
              Browse
            </Button>
          </div>
        </Field>
        <Field label="Folder name" hint="Leave empty to use the repository name from the URL.">
          <TextInput value={cloneName} onChange={(event) => setCloneName(event.target.value)} placeholder={cloneUrl ? deriveName(cloneUrl) : 'my-repo'} />
        </Field>
        <div className="form-grid">
          <Field label="Commit identity">
            <IdentitySelect value={cloneIdentity} onChange={setCloneIdentity} />
          </Field>
          <Field label="Integration account">
            <AccountSelect value={cloneAccount} onChange={setCloneAccount} />
          </Field>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={cloneBare} onChange={(event) => setCloneBare(event.target.checked)} />
          Clone as bare repository
        </label>
      </Modal>

      <Modal
        open={initOpen}
        title="Create repository"
        subtitle="Initializes the folder with system git and sets a local identity."
        onClose={() => setInitOpen(false)}
        width={520}
        footer={
          <>
            <Button variant="ghost" onClick={() => setInitOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} icon={<Plus size={15} />} onClick={() => void createRepo()}>
              Create repository
            </Button>
          </>
        }
      >
        <Field label="Parent folder">
          <div className="row-gap">
            <TextInput value={initParent} onChange={(event) => setInitParent(event.target.value)} placeholder="/home/you/Projects" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void call('app.pickDirectory', { title: 'Choose a parent folder' }).then((chosen) => chosen && setInitParent(chosen))}
            >
              Browse
            </Button>
          </div>
        </Field>
        <Field label="Repository name">
          <TextInput value={initName} onChange={(event) => setInitName(event.target.value)} placeholder="my-new-repo" autoFocus />
        </Field>
        <Field label="Default branch">
          <TextInput value={initBranch} onChange={(event) => setInitBranch(event.target.value)} placeholder="main" />
        </Field>
        <Field label="Commit identity">
          <IdentitySelect value={initIdentity} onChange={setInitIdentity} />
        </Field>
        {initParent && initName ? <div className="inline-info"><FolderGit2 size={13} /> {initParent.replace(/[\\/]+$/, '')}/{initName}</div> : null}
      </Modal>

      <Modal
        open={pushOpen}
        title="Push"
        subtitle={repo ? `${repo.name} · ${pushBranch || status?.branch || 'current branch'}` : undefined}
        onClose={() => setPushOpen(false)}
        width={520}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPushOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => void push()}>
              Push
            </Button>
          </>
        }
      >
        <div className="form-grid">
          <Field label="Remote">
            <Select value={pushRemote} onChange={(event) => setPushRemote(event.target.value)}>
              {(repo?.remotes ?? []).map((remote) => (
                <option key={remote.name} value={remote.name}>{remote.name}</option>
              ))}
              {(repo?.remotes ?? []).length === 0 ? <option value="">No remote</option> : null}
            </Select>
          </Field>
          <Field label="Branch">
            <Select value={pushBranch} onChange={(event) => setPushBranch(event.target.value)}>
              {[...new Set([pushBranch, status?.branch, repo?.currentBranch].filter(Boolean) as string[])].map((branch) => (
                <option key={branch} value={branch}>{branch}</option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Commit identity" hint="Used for merge commits created during the push if needed.">
            <IdentitySelect value={pushIdentity} onChange={setPushIdentity} />
          </Field>
          <Field label="Authenticate as" hint="HTTPS credentials come from this forge account.">
            <AccountSelect value={pushAccount} onChange={setPushAccount} />
          </Field>
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={pushUpstream} onChange={(event) => setPushUpstream(event.target.checked)} />
          Set upstream for this branch
        </label>
        <Field label="Force option">
          <Select value={pushForce} onChange={(event) => setPushForce(event.target.value as typeof pushForce)}>
            <option value="none">Never force</option>
            <option value="with-lease">Force with lease (safer)</option>
            <option value="force">Force (overwrite remote)</option>
          </Select>
        </Field>
      </Modal>
    </div>
  )
}

function deriveName(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const parts = cleaned.split(/[/:]/)
  return parts[parts.length - 1] || 'repository'
}
