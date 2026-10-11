// Settings › Screenshot backlog (ticket 13): the one-off "bring in screenshots from the Desktop and
// CleanShot history". Step 1 is always the dry run (shows counts, sizes, example names; changes
// nothing). Only then does the run button appear; it runs exactly the plan that was shown. After the
// run, CleanShot's export folder can be pointed at the watched folder — shown first, changed on a click.
import { useEffect, useState } from 'react'
import type { BacklogPlanView, BacklogProgress, BacklogRunResult, CleanShotSetting } from '../../preload'

const mb = (bytes: number): string => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3)).toLocaleString('en-GB')} KB` : `${(bytes / 1e6).toLocaleString('en-GB', { maximumFractionDigits: 1 })} MB`)
// The shared detail row is one ellipsised line; the plan and the exact command must be read in full.
const WRAP = { whiteSpace: 'normal', overflowWrap: 'anywhere' } as const
const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`

export function BacklogImportSettings(): JSX.Element {
  const [plan, setPlan] = useState<{ id: string; plan: BacklogPlanView } | null>(null)
  const [busy, setBusy] = useState<'planning' | 'running' | null>(null)
  const [progress, setProgress] = useState<BacklogProgress | null>(null)
  const [result, setResult] = useState<BacklogRunResult | null>(null)
  const [note, setNote] = useState('')
  const [cs, setCs] = useState<CleanShotSetting | null>(null)
  const [csNote, setCsNote] = useState('')

  useEffect(() => window.sw.backlog.onProgress(setProgress), [])
  const loadCs = (): void => void window.sw.backlog.cleanShotSetting().then(setCs)
  useEffect(loadCs, [])

  const showPlan = async (): Promise<void> => {
    setBusy('planning')
    setResult(null)
    setNote('')
    try {
      setPlan(await window.sw.backlog.dryRun())
    } finally {
      setBusy(null)
    }
  }
  const run = async (): Promise<void> => {
    if (!plan) return
    setBusy('running')
    setProgress(null)
    try {
      const r = await window.sw.backlog.run(plan.id)
      if (r?.result) setResult(r.result)
      else setNote(r?.refused ? `Not started: ${r.refused}.` : 'Not started.')
    } finally {
      setPlan(null)
      setBusy(null)
      loadCs()
    }
  }
  const pointCleanShot = async (): Promise<void> => {
    if (!cs) return
    const r = await window.sw.backlog.setCleanShot(cs.target) // exactly the folder shown
    setCsNote(r && 'refused' in r && r.refused ? `Not changed: ${r.refused}.` : r && 'ok' in r && r.ok ? 'Done. If CleanShot still saves to the old folder, quit and reopen CleanShot.' : 'CleanShot’s setting did not change.')
    loadCs()
  }

  const p = plan?.plan
  const todo = p?.ok ? p.summary.desktop.count + p.summary.cleanshot.count : 0

  return (
    <>
      <div className="settings-section">Screenshot backlog</div>
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">Bring in screenshots from the Desktop and CleanShot history</div>
            <div className="settings-row-detail" style={WRAP}>
              <i>
                Copies them into the Triage source folder and checks every copy. The originals stay where they are; nothing is moved or deleted. You see the list before anything is copied.
              </i>
            </div>
          </div>
          <button className="copyref" disabled={busy !== null} onClick={() => void showPlan()}>
            {busy === 'planning' ? 'Looking…' : 'Show what would be copied'}
          </button>
        </div>

        {p && !p.ok && (
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-detail" style={WRAP}>{p.detail}</div>
            </div>
          </div>
        )}

        {p?.ok && (
          <div className="settings-row backlog-plan" data-testid="backlog-plan">
            <div className="settings-row-main">
              <div className="settings-row-label">
                {todo === 0 ? 'Nothing left to bring in.' : `${plural(todo, 'file')} to copy, ${mb(p.summary.totalBytes)} · into ${p.watchedFolder}`}
              </div>
              <PlanLine title="Desktop screenshots" s={p.summary.desktop} />
              {p.cleanshotDir ? <PlanLine title="CleanShot history" s={p.summary.cleanshot} /> : <div className="settings-row-detail" style={WRAP}>CleanShot history not found on this Mac.</div>}
              {p.summary.recopy > 0 && (
                <div className="settings-row-detail" style={WRAP}>
                  <b>{plural(p.summary.recopy, 'file')} copied before, but the copy is missing or changed</b>: copied again (included above). A changed copy is never overwritten.
                </div>
              )}
              {p.summary.unverifiedOnlineOnly > 0 && (
                <div className="settings-row-detail" style={WRAP}>
                  {plural(p.summary.unverifiedOnlineOnly, 'earlier copy', 'earlier copies')} unverified, online-only: not checked (that would download them) and not copied again.
                </div>
              )}
              {p.summary.needDownloading.count > 0 && (
                <div className="settings-row-detail" style={WRAP} data-testid="backlog-need-downloading">
                  <b>
                    {p.summary.needDownloading.count.toLocaleString('en-GB')} need downloading (about {mb(p.summary.needDownloading.bytes)})
                  </b>
                  : they are only in iCloud or OneDrive. SlideWell downloads them one at a time while copying; a file that does not arrive within two minutes is left out, and running this again tries it again.
                </div>
              )}
              {p.summary.done > 0 && <div className="settings-row-detail" style={WRAP}>{plural(p.summary.done, 'file')} already copied earlier and checked; not copied twice.</div>}
              {p.summary.nameTaken > 0 && (
                <div className="settings-row-detail" style={WRAP}>{plural(p.summary.nameTaken, 'name')} already used in the folder: an identical file is kept as is, a different one is saved under a new name. Nothing is overwritten.</div>
              )}
              {p.summary.skipped.cleanshotProjects + p.summary.skipped.cleanshotOther > 0 && (
                <div className="settings-row-detail" style={WRAP}>Left out: {plural(p.summary.skipped.cleanshotProjects + p.summary.skipped.cleanshotOther, 'CleanShot project file')} (not images or videos).</div>
              )}
              {p.summary.skipped.notRegular > 0 && <div className="settings-row-detail" style={WRAP}>Skipped: {plural(p.summary.skipped.notRegular, 'item')} that are not regular files.</div>}
              {p.summary.leftoverStaged > 0 && (
                <div className="settings-row-detail" style={WRAP}>{plural(p.summary.leftoverStaged, 'unfinished copy', 'unfinished copies')} from an interrupted run in the hidden “.slidewell-staging” folder. SlideWell leaves them; they are safe to remove.</div>
              )}
            </div>
            {todo > 0 && (
              <button className="primary-btn" disabled={busy !== null} onClick={() => void run()}>
                Bring them in
              </button>
            )}
            <button className="copyref" disabled={busy !== null} onClick={() => setPlan(null)}>
              Not now
            </button>
          </div>
        )}

        {busy === 'running' && (
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-detail" style={WRAP}>{progress ? `${progress.done.toLocaleString('en-GB')} of ${progress.total.toLocaleString('en-GB')}${progress.name ? ` · ${progress.name}` : ''}` : 'Starting…'}</div>
            </div>
            <button className="copyref" onClick={() => void window.sw.backlog.cancel()}>
              Stop
            </button>
          </div>
        )}

        {note && (
          <div className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-detail" style={WRAP}>{note}</div>
            </div>
          </div>
        )}

        {result && (
          <div className="settings-row" data-testid="backlog-result">
            <div className="settings-row-main">
              <div className="settings-row-label">{result.cancelled ? 'Stopped. Run it again to carry on; nothing is copied twice.' : result.ok ? 'Done.' : 'Finished with problems.'}</div>
              <div className="settings-row-detail" style={WRAP}>
                {plural(result.copied, 'copy', 'copies')} made
                {result.downloaded > 0 ? ` · ${plural(result.downloaded, 'file')} downloaded first` : ''}
                {result.reused + result.alreadyDone > 0 ? ` · ${plural(result.reused + result.alreadyDone, 'file')} already there` : ''}
                {result.onlineOnly > 0 ? ` · ${plural(result.onlineOnly, 'online-only file')} not downloaded, left out (run again to retry)` : ''}
                {result.unverifiedOnlineOnly > 0 ? ` · ${plural(result.unverifiedOnlineOnly, 'earlier copy', 'earlier copies')} unverified, online-only` : ''}
                {result.notRegular > 0 ? ` · ${plural(result.notRegular, 'item')} skipped: not a regular file` : ''}
                {result.gone > 0 ? ` · ${plural(result.gone, 'file')} no longer there` : ''}
                {result.failed > 0 ? ` · ${plural(result.failed, 'problem')}` : ''}
              </div>
              {result.desktopWithCopy > 0 && (
                <div className="settings-row-detail" style={WRAP} data-testid="backlog-desktop-note">
                  {result.desktopWithCopy === 1 ? '1 original is' : `${result.desktopWithCopy.toLocaleString('en-GB')} originals are`} still on your Desktop — they’re safe to delete yourself once you’ve checked the copies.
                </div>
              )}
              {result.errors.slice(0, 3).map((e) => (
                <div className="settings-row-detail" style={WRAP} key={e}>
                  {e}
                </div>
              ))}
            </div>
            <button className="copyref" onClick={() => void window.sw.backlog.showLogs()}>
              Open log folder
            </button>
          </div>
        )}

        {cs && (
          <div className="settings-row" data-testid="backlog-cleanshot">
            <div className="settings-row-main">
              <div className="settings-row-label">{cs.matches ? 'CleanShot already saves new captures to the Triage source folder' : 'Save new CleanShot captures straight into the Triage source folder'}</div>
              <div className="settings-row-detail" style={WRAP}>Now: {cs.current ?? 'not set'}</div>
              {!cs.matches && (
                <div className="settings-row-detail" style={WRAP}>
                  Will run: <code>{cs.command}</code>
                </div>
              )}
              {csNote && <div className="settings-row-detail" style={WRAP}>{csNote}</div>}
            </div>
            {!cs.matches && (
              <button className="copyref" onClick={() => void pointCleanShot()}>
                Point CleanShot here
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function PlanLine({ title, s }: { title: string; s: { count: number; bytes: number; examples: string[] } }): JSX.Element {
  return (
    <div className="settings-row-detail" style={WRAP}>
      <b>{title}:</b> {s.count === 0 ? 'none' : `${s.count.toLocaleString('en-GB')}, ${mb(s.bytes)}`}
      {s.examples.length > 0 && <span> · e.g. {s.examples.join(' · ')}</span>}
    </div>
  )
}
