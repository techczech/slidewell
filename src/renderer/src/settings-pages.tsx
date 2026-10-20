// The app's own pages in the shared Settings window (the package's custom-page slot). They hold what is
// not a single setting: lists, downloads, runs, connection tests and status. Each reuses the main window's
// component where one exists; every call goes through window.sw, which main answers only from the main
// window and the Settings window.
import { useCallback, useEffect, useState } from 'react'
import type { CustomPage } from '@app-patterns/settings-react'
import type { Dependency } from '../../preload'
import { PictureSearchSettings } from './PictureSearch'
import { SorterServiceSettings } from './SorterServiceSettings'
import { BacklogImportSettings } from './BacklogImport'

type Source = { path: string; namedOnly: boolean; exists: boolean }

function CaptureSources(): JSX.Element {
  const [sources, setSources] = useState<Source[]>([])
  const [cleanshot, setCleanshot] = useState(false)
  const load = useCallback(async () => {
    const p = await window.sw.settings.getPaths()
    setSources(p.captureSources)
    setCleanshot(Boolean(p.captureDefaults.cleanshot))
  }, [])
  useEffect(() => void load(), [load])
  return (
    <div className="sw-page">
      <p className="sw-page-note">Folders watched for new screenshots, besides the Triage source folder (Settings › Screenshots). New files reach Triage within a minute. SlideWell only reads these folders; it never moves or changes the originals.</p>
      {sources.map((c) => (
        <div className={`sw-page-row${c.exists ? '' : ' bad'}`} key={c.path}>
          <div className="grow">
            <div>{c.namedOnly ? 'Only files named like screenshots (Screenshot…, CleanShot…)' : 'All images and videos'}</div>
            <div className="sub" title={c.path}>{c.path}{c.exists ? '' : ' · folder not found'}</div>
          </div>
          <button className="copyref" onClick={() => void window.sw.settings.removeCaptureSource(c.path).then(load)}>Remove</button>
        </div>
      ))}
      <div className="sw-page-row">
        <div className="grow">{sources.length === 0 ? 'No extra folders yet.' : 'Add another folder'}</div>
        <button className="copyref" onClick={() => void window.sw.settings.addCaptureSource('desktop').then(load)}>Add Desktop</button>
        {cleanshot && <button className="copyref" onClick={() => void window.sw.settings.addCaptureSource('cleanshot').then(load)}>Add CleanShot folder</button>}
        <button className="copyref" onClick={() => void window.sw.settings.addCaptureSource('folder').then(load)}>Add folder…</button>
      </div>
    </div>
  )
}

function SyncAndLibraries(): JSX.Element {
  const [storage, setStorage] = useState<{ archive: 'local' | 'r2'; others: 'local' | 'r2'; well: 'local' | 'r2' } | null>(null)
  const [hasCreds, setHasCreds] = useState(false)
  const [status, setStatus] = useState('')
  const load = useCallback(async () => {
    setStorage(await window.sw.settings.getStorage())
    setHasCreds((await window.sw.settings.getR2()).hasCreds)
  }, [])
  useEffect(() => void load(), [load])
  const test = async (): Promise<void> => {
    setStatus('Testing…')
    const r = await window.sw.settings.testR2()
    setStatus(r.ok ? 'Connected to R2.' : `Not connected: ${r.error ?? 'failed'}`)
  }
  const sync = async (store: 'archive' | 'others' | 'well'): Promise<void> => {
    setStatus(`Syncing ${store} to R2…`)
    const r = await window.sw.settings.syncStore(store)
    setStatus(r.ok ? `${store}: ${r.uploaded ?? 0} uploaded, ${r.skipped ?? 0} already there` : `${store}: ${r.error ?? `${r.failed ?? 0} failed`}`)
  }
  const purge = async (): Promise<void> => {
    const r = await window.sw.settings.clearOthersLibrary()
    if (r.ok) setStatus('The Others’ Library is empty.')
  }
  return (
    <div className="sw-page">
      <p className="sw-page-note">The R2 account, bucket and where each library is kept are in Settings › Storage; the two R2 keys are in Accounts and keys.</p>
      <div className="sw-page-row">
        <div className="grow">
          <div>R2 connection</div>
          <div className="sub">{status || (hasCreds ? 'Both keys are saved.' : 'Add both R2 keys in Accounts and keys first.')}</div>
        </div>
        <button className="copyref" disabled={!hasCreds} onClick={() => void test()}>Test connection</button>
      </div>
      {storage && (['archive', 'others', 'well'] as const).filter((s) => storage[s] === 'r2').map((s) => (
        <div className="sw-page-row" key={s}>
          <div className="grow">{s === 'archive' ? 'Archive' : s === 'others' ? 'Others’ Library' : 'Well'}: mirrored to R2</div>
          <button className="copyref" disabled={!hasCreds} onClick={() => void sync(s)}>Sync to R2</button>
        </div>
      ))}
      <div className="sw-page-row">
        <div className="grow">
          <div>Empty the Others’ Library</div>
          <div className="sub">Deletes everything imported into the Others’ Library. Your own archive is never touched.</div>
        </div>
        <button className="copyref" onClick={() => void purge()}>Clear library…</button>
      </div>
    </div>
  )
}

function Requirements(): JSX.Element {
  const [deps, setDeps] = useState<Dependency[]>([])
  const [url, setUrl] = useState('')
  useEffect(() => {
    void window.sw.settings.dependencies().then((d) => {
      setDeps(d.deps)
      setUrl(d.requirementsUrl)
    })
  }, [])
  return (
    <div className="sw-page">
      <p className="sw-page-note">Anything missing only turns its feature off; SlideWell still runs.</p>
      {deps.map((d) => (
        <div className={`sw-page-row${d.found ? '' : ' bad'}`} key={d.key}>
          <div className="grow">
            <div>{d.found ? '✓' : '⚠'} {d.label}{d.required && !d.found ? ' · required' : ''}</div>
            <div className="sub">{d.requiredFor}{d.found ? '' : ` — ${d.install}`}</div>
          </div>
        </div>
      ))}
      {url && (
        <div className="sw-page-row">
          <div className="grow">How to install what is missing</div>
          <button className="copyref" onClick={() => void window.sw.shell.openExternal(url)}>Open the setup guide</button>
        </div>
      )}
    </div>
  )
}

/** Ids match CUSTOM_PAGES in main/settings-host.ts. */
export function customPages(openSection: (id: string) => void): CustomPage[] {
  return [
    { id: 'picture-search', label: 'Picture search', icon: 'image', render: () => <div className="sw-page"><PictureSearchSettings /></div> },
    {
      id: 'sorter-service', label: 'Sorting help', icon: 'bot',
      render: () => (
        <div className="sw-page">
          <SorterServiceSettings onOpenAutoSorting={() => void window.sw.app.showInMain('open-auto-sorting')} onOpenKeys={() => openSection('accounts')} />
        </div>
      )
    },
    { id: 'capture-sources', label: 'Watched folders', icon: 'folder-search', render: () => <CaptureSources /> },
    { id: 'backlog-import', label: 'Older screenshots', icon: 'history', render: () => <div className="sw-page"><BacklogImportSettings /></div> },
    { id: 'sync', label: 'Sync and libraries', icon: 'refresh-cw', render: () => <SyncAndLibraries /> },
    { id: 'requirements', label: 'Requirements', icon: 'list-checks', render: () => <Requirements /> }
  ]
}
