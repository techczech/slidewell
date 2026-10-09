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
  const copies = p?.ok ? p.summary.desktop.count + p.summary.cleanshot.count : 0
  const moves = p?.ok ? p.summary.pendingMoves : 0
  const todo = copies + moves

  return (
    <>
      <div className="settings-section">Screenshot backlog</div>
      <div className="settings-rows">
        <div className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">Bring in screenshots from the Desktop and CleanShot history</div>
            <div className="settings-row-detail" style={WRAP}>
              <i>
                Copies them into the Triage source folder and checks every copy, then moves the Desktop originals into a “Moved by SlideWell” folder there. Nothing is deleted. CleanShot’s history is only read. You see the list before anything moves.
              </i>
            </div>
          </div>
          <button className="copyref" disabled={busy !== null} onClick={() => void showPlan()}>
            {busy === 'planning' ? 'Looking…' : 'Show what would move'}
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
                {todo === 0 ? 'Nothing left to bring in.' : copies > 0 ? `${plural(copies, 'file')} to bring in, ${mb(p.summary.totalBytes)} · into ${p.watchedFolder}` : `Nothing new to copy · into ${p.watchedFolder}`}
              </div>
              <PlanLine title="Desktop screenshots (moved after copying)" s={p.summary.desktop} />
              {p.cleanshotDir ? <PlanLine title="CleanShot history (copied; left in CleanShot)" s={p.summary.cleanshot} /> : <div className="settings-row-detail" style={WRAP}>CleanShot history not found on this Mac.</div>}
              {p.summary.desktop.count > 0 && <div className="settings-row-detail" style={WRAP}>Desktop originals go to “{p.movedFolder.split('/').pop()}”.</div>}
              {moves > 0 && (
                <div className="settings-row-detail" style={WRAP}>
                  <b>{plural(moves, 'original')} still to move to the dated folder</b> (copied in an earlier run that did not finish; each copy is checked again first).
                </div>
              )}
              {p.summary.onlineOnly > 0 && (
                <div className="settings-row-detail" style={WRAP}>
                  {plural(p.summary.onlineOnly, 'file')} online-only, left out: open OneDrive (or iCloud) to download them, then run this again.
                </div>
              )}
              {p.summary.likelyDone - moves > 0 && <div className="settings-row-detail" style={WRAP}>{plural(p.summary.likelyDone - moves, 'file')} already brought in earlier; checked again, not copied twice.</div>}
              {p.summary.nameTaken > 0 && (
                <div className="settings-row-detail" style={WRAP}>{plural(p.summary.nameTaken, 'name')} already used in the folder: an identical file is kept as is, a different one is saved under a new name. Nothing is overwritten.</div>
              )}
              {p.summary.skipped.cleanshotProjects + p.summary.skipped.cleanshotOther > 0 && (
                <div className="settings-row-detail" style={WRAP}>Left out: {plural(p.summary.skipped.cleanshotProjects + p.summary.skipped.cleanshotOther, 'CleanShot project file')} (not images or videos).</div>
              )}
              {p.summary.leftoverPartials > 0 && (
                <div className="settings-row-detail" style={WRAP}>{plural(p.summary.leftoverPartials, 'hidden unfinished copy', 'hidden unfinished copies')} from an interrupted run in the folder (names end “.slidewell-partial”). SlideWell leaves them; they are safe to remove.</div>
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
                {plural(result.copied, 'copy', 'copies')} made · {plural(result.moved, 'Desktop original')} moved
                {result.reused + result.alreadyDone > 0 ? ` · ${plural(result.reused + result.alreadyDone, 'file')} already there` : ''}
                {result.moveSkipped > 0 ? ` · ${plural(result.moveSkipped, 'original')} left on the Desktop (see the log)` : ''}
                {result.onlineOnly > 0 ? ` · ${plural(result.onlineOnly, 'online-only file')} left out` : ''}
                {result.gone > 0 ? ` · ${plural(result.gone, 'file')} no longer there` : ''}
                {result.failed > 0 ? ` · ${plural(result.failed, 'problem')}` : ''}
              </div>
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
