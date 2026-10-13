// Triage › Auto sorting (locked mockup 2026-10-12): everything about the screenshot sorter that is not
// choosing a service or saving a key (those stay in Settings). Status line; Sort now (one button: sorts on
// this Mac, then, when a service is on, shows the confirm box before anything is sent); Training;
// Nightly sorting; Last run; and a side card with the service state. Main owns all of it
// (src/main/sorter/); this file shows state and sends commands. Sorting records proposals only.
import { useCallback, useState } from 'react'
import type { CloudPreview, CloudStatus, SorterStatus } from '../../preload'
import { CloudConfirm } from './CloudConfirm'
import { SortPeriodSelect } from './SortPeriodSelect'
import { SorterAccuracyTable } from './SorterAccuracyTable'
import { SorterGoesBy } from './SorterGoesBy'
import { SortChooser, SortPiles, type SortFollowUp } from './SortPiles'
import { sorterRunning, useCloudStatus, useSortRuns, useSorterStatus } from './sorter-hooks'
import { day, n, plural, when, whenShort } from './sorter-format'
import './auto-sorting.css'

const lower = (s: string): string => (s ? s[0].toLowerCase() + s.slice(1) : s)
const RULES_CHANGED = 'You changed an app rule since the last accuracy test. Nightly sorting waits until you train again. Sort now still works.'
const upper = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** "Trained today at 02:00" / "Trained on Tue 13 Oct, 02:00". */
function trainedWhen(iso: string): string {
  const t = whenShort(iso)
  return t.startsWith('today') || t.startsWith('yesterday') ? `Trained ${t.replace(' ', ' at ')}` : `Trained on ${t}`
}

function BalanceBar({ kept, binned }: { kept: number; binned: number }): JSX.Element {
  const total = kept + binned
  return (
    <>
      <div className="as-bar">
        <div className="as-bar-k" style={{ width: `${total ? (kept / total) * 100 : 0}%` }} />
        <div className="as-bar-t" style={{ width: `${total ? (binned / total) * 100 : 0}%` }} />
      </div>
      <div className="as-barlab">
        <span>
          <b>{n(kept)}</b> kept
        </span>
        <span>
          <b>{n(binned)}</b> binned
        </span>
      </div>
    </>
  )
}

// The last run as the three numbers of the mockup: the local sort's, then the service's run when it followed that sort.
function lastRunNumbers(st: SorterStatus, cl: CloudStatus): { label: string; at: string; lookedAt: number | null; confident: number | null; needLook: number | null; settled: number; sent: number; note: string | null } | null {
  const local = st.lastRun
  const cloud = cl.lastRun
  const follows = cloud && (!local || cloud.at >= local.at) // a service run older than the latest local sort belongs to an earlier sort
  const ran = follows && !cloud.skipped && !cloud.error && cloud.sent > 0
  const label = follows ? (cloud.trigger === 'nightly' ? 'nightly sort' : 'Sort now') : 'sort on this Mac'
  if (!local && !follows) return null
  if (!local) return { label, at: cloud!.at, lookedAt: null, confident: null, needLook: null, settled: 0, sent: 0, note: cloud!.message }
  const settled = ran ? cloud.settled : 0
  return {
    label,
    at: local.at,
    lookedAt: local.lookedAt,
    confident: local.confident + settled,
    needLook: Math.max(0, local.needLook - settled),
    settled,
    sent: ran ? cloud.sent : 0,
    note: follows && !ran ? cloud.message : null
  }
}

export function AutoSortingTab({ onReview, onSettings, triageUndecided }: { onReview: () => void; onSettings: () => void; triageUndecided?: number }): JSX.Element {
  const st = useSorterStatus()
  const [cl, setCl] = useCloudStatus()
  const [result, setResult] = useState<string | null>(null)
  const [preview, setPreview] = useState<CloudPreview | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [showAccuracy, setShowAccuracy] = useState(false)
  const [nightlyError, setNightlyError] = useState<string | null>(null)
  const [chosenRun, setChosenRun] = useState<string | null>(null) // null = the latest sort
  // the sorts are read again whenever a sort or a service run ends or proposes something new
  const { runs, version: runsVersion } = useSortRuns([st?.phase, cl?.phase, st?.pending.lastProposedAt, st?.lastRun?.at, cl?.lastRun?.at].join('|'))

  const trainNow = useCallback(async () => {
    setResult(null)
    const r = await window.sw.sorter.train()
    if (!r.ok && r.error && !r.cancelled) setResult(r.error) // on success the pushed status carries the new report
  }, [])
  // one button: with a service on, main sorts on this Mac and prepares the batch (shown in the confirm box); with none, only the local sort
  const rulesChanged = st?.rulesChangedSinceTest === true
  const sortNow = useCallback(async () => {
    setResult(null)
    const alone = async (): Promise<string | null> => {
      const r = await window.sw.sorter.sort()
      return r.ok && r.counts ? `Sorted ${n(r.sorted ?? 0)}${r.periodPhrase ?? ''}: ${n(r.counts.keep)} keep, ${n(r.counts.throwaway)} throwaway, ${n(r.counts.doubtful)} need a look.` : (r.error ?? null)
    }
    if (cl?.settings.enabled) {
      setPreparing(true)
      try {
        // While an app rule is newer than the accuracy test, main's cloud.prepare cannot sort on this Mac (it answers "not trained enough"),
        // so the sorter's own sort runs first, which main still allows; prepare then only builds the batch from the unsure ones.
        const sorted = rulesChanged ? await alone() : null
        const p = await window.sw.cloud.prepare()
        const local = rulesChanged ? sorted : p.local.message
        if (p.blocked) setResult([local, p.message].filter(Boolean).join(' '))
        else setPreview(rulesChanged ? { ...p, local: { ok: true, message: sorted ?? '' } } : p)
      } finally {
        setPreparing(false)
      }
      return
    }
    setResult(await alone())
  }, [cl?.settings.enabled, rulesChanged])
  const send = useCallback(async () => {
    if (!preview?.token) return
    const token = preview.token
    setPreview(null)
    const r = await window.sw.cloud.send(token)
    setResult(r.message)
  }, [preview])
  const setNightly = useCallback(
    async (on: boolean) => {
      const r = await window.sw.cloud.setNightly(on)
      setCl(r.status)
      setNightlyError(r.ok ? null : (r.error ?? 'Nightly sorting was not changed.'))
    },
    [setCl]
  )
  const setTime = useCallback(async (batchTime: string) => setCl(await window.sw.cloud.setSettings({ batchTime })), [setCl])

  if (!st || !cl) return <div className="as-tab" />
  const service = cl.settings.enabled
  const { name } = cl
  const rep = st.report
  const running = sorterRunning(st)
  const busy = running || cl.phase !== 'idle' || preparing
  const periodLabel = lower(st.periods.find((p) => p.id === st.period)?.label ?? '')
  const kept = st.learnable?.kept ?? rep?.trainedOn.keep ?? 0
  const binned = st.learnable?.binned ?? rep?.trainedOn.throwaway ?? 0
  const choices = kept + binned
  // the model in use is retrained on all usable choices after the test (service.ts trainAndTest: fitModel(usable)), so report.usable is what it learnt from
  const trainedOnAll = rep ? rep.usable.keep + rep.usable.throwaway : 0
  const sinceTraining = Math.max(0, choices - trainedOnAll)
  // why Sort now and the nightly switch are off, in his words; null when sorting can run
  const whyNot = !st.modelReady
    ? 'Needs the picture search model (in Settings › Picture search).'
    : st.canRunUnattended || st.rulesChangedSinceTest
      ? null
      : st.retrainNeeded
        ? 'Retrain needed: the sorter has changed since it last learnt from your choices. Sorting stays off until you train it again.'
        : rep
          ? `Not enough of your past choices to measure accuracy yet: it needs at least ${st.minHeldBack.total} held back, with ${st.minHeldBack.perLabel} kept and ${st.minHeldBack.perLabel} binned. Sorting stays off until then.`
          : 'Train the sorter first. Sorting stays off until it has been trained and tested.'
  const u = st.undecided
  const asking = cl.phase === 'asking'
  const run = lastRunNumbers(st, cl)
  const holdBack = Math.round(choices / 5)
  const shownRun = runs.find((r) => r.id === chosenRun) ?? runs[0] ?? null // the latest sort unless he chose an earlier one

  const trainButton = (primary: boolean, label: string): JSX.Element => (
    <button className={primary ? 'pic-primary as-train' : 'copyref as-train as-train-again'} disabled={!st.modelReady || busy} onClick={() => void trainNow()}>
      {label}
    </button>
  )

  // while something runs, its block replaces Sort now and the rest steps back (frame S3)
  const progress = (
    <div className="as-block as-working">
      <h2>{running && st.phase !== 'sorting' ? 'Training' : 'Sort now'}</h2>
      <div className="as-row">
        <div className="as-working-head">
          {asking
            ? `Asking ${name} · ${n(cl.done)} of ${n(cl.total)}`
            : st.phase === 'sorting'
              ? `Sorting ${n(st.done)} of ${n(st.total)}${periodLabel ? ` · ${periodLabel}` : ''}`
              : running
                ? `${upper(st.message)}${st.total > 0 ? ` · ${n(st.done)} of ${n(st.total)}` : ''}`
                : 'Sorting on this Mac…'}
        </div>
        {asking ? <progress className="pic-progress as-progress" value={cl.done} max={Math.max(1, cl.total)} /> : st.total > 0 && running ? <progress className="pic-progress as-progress" value={st.done} max={st.total} /> : <progress className="pic-progress as-progress" />}
        <button className="copyref" onClick={() => void (asking ? window.sw.cloud.cancel() : window.sw.sorter.cancel())}>
          Stop
        </button>
      </div>
      <p className="as-muted">
        {asking
          ? `Asking ${name} about the unsure ones. Stopping keeps what has been answered.`
          : running && st.phase !== 'sorting'
            ? 'Stopping keeps nothing from this run.'
            : service
              ? `Sorting on this Mac first. Unsure ones then wait for your confirmation before anything goes to ${name}. Stopping keeps what is already sorted.`
              : 'Sorting on this Mac. Stopping keeps what is already sorted.'}
      </p>
    </div>
  )

  const sortNowBlock = (
    <div className="as-block as-sort">
      <h2>Sort now</h2>
      {u && (
        <p>
          {u.period && st.period !== 'all' && u.inPeriod !== null ? (
            <>
              <b>{n(u.inPeriod)}</b> undecided {u.inPeriod === 1 ? 'picture' : 'pictures'} from the {periodLabel} can be sorted ({n(u.all)} in all).
            </>
          ) : (
            <>
              <b>{n(u.all)}</b> undecided {u.all === 1 ? 'picture' : 'pictures'} can be sorted.
            </>
          )}
          {triageUndecided !== undefined && triageUndecided > u.all && (
            <span className="as-muted"> Triage counts {n(triageUndecided)} undecided files; videos, files not downloaded to this Mac and extra copies of the same picture are not sorted.</span>
          )}
        </p>
      )}
      <div className="as-row as-sort-row">
        {runs.length > 0 && <SortChooser runs={runs} selectedId={shownRun?.id ?? ''} periods={st.periods} onSelect={setChosenRun} />}
        <SortPeriodSelect period={st.period} periods={st.periods} disabled={busy} />
        <button className="pic-primary sorter-cloud-sort as-sort-btn" disabled={busy || whyNot !== null} onClick={() => void sortNow()}>
          Sort now
        </button>
        {whyNot && <span className="as-why">{whyNot}</span>}
      </div>
      <p className="as-service-line">
        {!service
          ? 'No service is chosen in Settings, so unsure ones wait for you in Review.'
          : whyNot
            ? `${name} is on, but is asked about nothing until the sorter can sort.`
            : `${name} is on. Unsure ones go to ${name}${cl.leftTonight !== null ? `, within tonight’s allowance of ${n(cl.leftTonight)}` : ''}. You confirm the count and cost before anything is sent.`}
      </p>
      <p className="as-muted">Only screenshots with a date in the file name fall in a period; the others are sorted under Everything. The nightly sort takes everything.</p>
      {st.error && <p className="pic-error">The sorter stopped: {st.error}</p>}
      {result && <div className="pic-note sorter-cloud-result">{result}</div>}
    </div>
  )

  const nightlyOn = service && cl.settings.nightly && st.canRunUnattended // stored on, but it does not run until the sorter can sort
  const nightlyReason = !service ? 'When no service is chosen in Settings, nightly sorting is off.' : !st.canRunUnattended ? (st.rulesChangedSinceTest ? 'Waiting for you to train again.' : 'Train the sorter first.') : null
  const nightlyBlock = (
    <div className="as-block as-nightly" style={!st.canRunUnattended ? { opacity: 0.55 } : undefined}>
      <h2>Nightly sorting</h2>
      <div className="as-nightly-grid">
        <div>
          <div className="as-row">
            <label className="as-switch">
              <input type="checkbox" role="switch" className="sorter-cloud-nightly" checked={nightlyOn} disabled={nightlyReason !== null || busy} onChange={(e) => void setNightly(e.target.checked)} />
              <span className="as-switch-track" />
              <span className="as-switch-label">{nightlyOn ? 'On, at' : 'Off'}</span>
            </label>
            <input type="time" className="sorter-cloud-time as-time" value={cl.settings.batchTime} disabled={nightlyReason !== null} onChange={(e) => e.target.value && void setTime(e.target.value)} aria-label="Nightly sorting time" />
          </div>
          {st.rulesChangedSinceTest && <p className="as-why as-note as-rules-changed">{RULES_CHANGED}</p>}
          {!(st.rulesChangedSinceTest && service) && <p className={nightlyReason ? 'as-why as-note' : 'as-muted as-note'}>{nightlyReason ?? 'When no service is chosen in Settings, nightly sorting is off.'}</p>}
          {nightlyError && <p className="pic-error">{nightlyError}</p>}
        </div>
        <p>
          Sorts every undecided screenshot and asks {service ? name : 'the chosen service'} about the unsure ones, up to {n(cl.nightlyLimit)} a night (nightly sort and Sort now together). It runs only while SlideWell is open; if{' '}
          {cl.settings.batchTime} passes while it is closed, it runs at the next launch.{nightlyOn && cl.nextRunAt ? ` Next: ${when(cl.nextRunAt)}.` : ''}
        </p>
      </div>
    </div>
  )

  // the piles of the chosen sort (replace the old "Last run" block, whose numbers are now the result line); the old block stays for a Mac with no recorded sort yet
  // the latest sort also carries what followed it (the numbers the old Last run block showed); an earlier sort shows what its run record has
  const followUp: SortFollowUp | null = shownRun && shownRun.id === runs[0]?.id && run && run.needLook !== null ? { name, sent: run.sent, settled: run.settled, waiting: run.needLook } : null
  const pilesBlock = shownRun ? <SortPiles runId={shownRun.id} reloadKey={runsVersion} periods={st.periods} onReview={onReview} followUp={followUp} /> : null
  const lastRunBlock =
    shownRun ? null : run || st.pending.lastProposedAt ? (
      <div className="as-block as-last">
        <div className="as-row">
          <h2 className="as-inline-h">Last run</h2>
          {run && (
            <span className="as-muted">
              {run.label}, {whenShort(run.at)}
              {run.lookedAt !== null ? ` · ${n(run.lookedAt)} looked at` : ''}
            </span>
          )}
          <button className="as-link as-review-link" onClick={onReview}>
            Review what it sorted →
          </button>
        </div>
        {run && run.confident !== null && run.needLook !== null && (
          <div className="as-stats">
            <div>
              <div className="as-n">{n(run.confident)}</div>
              <div className="as-l">sorted confidently{run.settled > 0 ? `, ${n(run.settled)} of them settled by ${name}` : ''}</div>
            </div>
            <div>
              <div className="as-n as-n-need">{n(run.needLook)}</div>
              <div className="as-l">need a look</div>
            </div>
            {run.sent > 0 && (
              <div>
                <div className="as-n">{n(run.sent)}</div>
                <div className="as-l">unsure ones sent to {name}</div>
              </div>
            )}
          </div>
        )}
        {run?.note && <p className="as-muted">{run.note}</p>}
        {st.pending.lastProposedAt && (
          <p className="as-muted">
            Waiting for you: {n(st.pending.keep)} proposed keep, {n(st.pending.throwaway)} proposed throwaway, {n(st.pending.doubtful)} need a look. Nothing is moved or deleted until you decide.
          </p>
        )}
      </div>
    ) : null

  const sideCard = (
    <aside className={busy ? 'as-side as-dim' : 'as-side'}>
      <h3>Cloud step</h3>
      <div className="as-block as-card">
        <div className="as-card-head">
          <span className={service ? 'as-dot' : 'as-dot as-dot-off'} />
          {service ? `${name} is on` : 'No service is chosen'}
        </div>
        {service ? (
          <>
            <p className="as-muted">
              Second opinions {cl.settings.secondOpinions ? 'on' : 'off'} · {cl.hasKey ? 'key saved' : 'no key saved'}
            </p>
            <p className="as-card-line">
              {nightlyOn
                ? `Unsure screenshots go to ${name} at ${cl.settings.batchTime}, up to ${n(cl.nightlyLimit)} a night.`
                : `Unsure screenshots go to ${name} when you press Sort now, up to ${n(cl.nightlyLimit)} a night.`}
            </p>
          </>
        ) : (
          <p className="as-card-line">Unsure screenshots wait for you in Review. Luna from OpenAI or Haiku from Anthropic can be chosen in Settings.</p>
        )}
        <p>
          <button className="as-link" onClick={onSettings}>
            Change in Settings →
          </button>
        </p>
      </div>
    </aside>
  )

  const trainedStatus = rep ? (
    <div className="as-status">
      <span className="as-dot" />
      <div>
        <b>{trainedWhen(rep.trainedAt)}</b> on {n(trainedOnAll)} of your choices.
        {st.rulesChangedSinceTest && <div className="as-why as-rules-changed">{RULES_CHANGED}</div>}
      </div>
    </div>
  ) : null

  const ready = st.minHeldBack && choices * 0.2 >= st.minHeldBack.total && kept * 0.2 >= st.minHeldBack.perLabel && binned * 0.2 >= st.minHeldBack.perLabel
  const untrainedCard = (
    <div className="as-block as-untrained">
      <div className="as-row as-untrained-head">
        <span className="as-dot as-dot-off" />
        <span>{st.retrainNeeded ? 'The sorter needs training again.' : 'The sorter has not been trained yet.'}</span>
      </div>
      <p>
        {st.retrainNeeded
          ? 'Retrain needed: the sorter has changed since it last learnt from your choices. Sorting stays off until you train it again. '
          : ''}
        It proposes keep, throwaway or “needs a look” for screenshots you have not decided yet, and learns from the ones you kept and binned before. It only records proposals and never moves or deletes a file. It runs on this Mac.
      </p>
      {st.learnable && (
        <>
          <p>
            You have made <b>{n(choices)}</b> choices it can learn from: <b>{n(kept)}</b> kept and <b>{n(binned)}</b> binned.{' '}
            {ready ? 'That is enough to start.' : `Measuring accuracy needs at least ${st.minHeldBack.total} held back, with ${st.minHeldBack.perLabel} kept and ${st.minHeldBack.perLabel} binned.`}
          </p>
          <div className="as-untrained-bar">
            <BalanceBar kept={kept} binned={binned} />
          </div>
        </>
      )}
      <div className="as-row as-train-row">
        {trainButton(true, 'Train on my past choices and test')}
        <span className="as-muted">Holds back about a fifth{choices ? ` (${n(holdBack)})` : ''} of your choices, tests itself on those, then shows how accurate it is. Takes a few minutes.</span>
      </div>
      {!st.modelReady && <p className="as-why">Needs the picture search model (in Settings › Picture search).</p>}
    </div>
  )

  const trainingBlock = rep ? (
    <div className="as-block as-training">
      <h2>Training</h2>
      <div className="as-training-head">{plural(choices, 'choice')} so far.</div>
      {sinceTraining > 0 && (
        <p className="as-muted">It last trained on {n(trainedOnAll)} of them; you have made {n(sinceTraining)} since. Train again to include them.</p>
      )}
      <div className="as-training-body">
        <div className="as-learnt">What it has learnt from</div>
        <BalanceBar kept={kept} binned={binned} />
        <div className="as-row as-train-row">{trainButton(false, 'Train again and test')}</div>
        <p className="as-muted">
          Accuracy table and thresholds:{' '}
          <button className="as-link as-accuracy-toggle" onClick={() => setShowAccuracy((v) => !v)}>
            {showAccuracy ? 'hide' : 'show'}
          </button>
        </p>
      </div>
      {showAccuracy && <SorterAccuracyTable report={rep} />}
    </div>
  ) : null

  return (
    <div className="as-tab" data-phase={st.phase} data-cloud-phase={cl.phase}>
      <div className="as-main">
        {rep ? (
          <>
            <div className={busy ? 'as-dim' : ''}>{trainedStatus}</div>
            <SorterGoesBy reloadKey={runsVersion} />
            {busy ? progress : sortNowBlock}
            <div className={busy ? 'as-dim as-stack' : 'as-stack'}>
              {pilesBlock}
              {trainingBlock}
              {nightlyBlock}
              {lastRunBlock}
            </div>
          </>
        ) : (
          <>
            {busy && running && st.phase !== 'sorting' ? progress : untrainedCard}
            <SorterGoesBy reloadKey={runsVersion} />
            {sortNowBlock}
            {pilesBlock}
            {nightlyBlock}
          </>
        )}
      </div>
      {sideCard}
      {preview && <CloudConfirm preview={preview} status={cl} onCancel={() => setPreview(null)} onSend={() => void send()} />}
    </div>
  )
}
