import { useEffect, useRef, useState } from 'react'
import {
  aboutLines, answerView, availableMarkText, cardView, dateText, privacyText, updatedMarkText,
  type AnswerView
} from '@app-patterns/updates'
import type { UpdateNotes } from '../../preload'
import type { UpdateSnapshot } from '../../shared/update-snapshot'
import { ALPHA_HINT, blockersSentence, FAIL_TEXT, installMarkText, REFUSAL_TEXT, reopenText, sizeText, updateFoot } from '../../shared/update-install'
import { UPDATE_ALPHA_KEY, UPDATE_CHECK_KEY } from '../../shared/update-identity'
import './update-notices.css'

const answerFor = (snapshot: UpdateSnapshot): AnswerView =>
  !snapshot.enabled && snapshot.source !== 'store'
    ? { tone: 'plain', title: 'Update checks are off.', detail: 'Turn them on in Settings to check for updates.', action: null }
    : answerView(snapshot.state, { ...snapshot, now: Date.now() })

function useUpdateSnapshot(): UpdateSnapshot | null {
  const [snapshot, setSnapshot] = useState<UpdateSnapshot | null>(null)
  useEffect(() => {
    const api = window.sw?.updates
    if (!api) return
    let live = true
    let changed = false
    const unsubscribe = api.onChanged((next) => { changed = true; setSnapshot(next) })
    void api.get().then((next) => { if (live && !changed) setSnapshot(next) }).catch(() => undefined)
    return () => { live = false; unsubscribe() }
  }, [])
  const waiting = snapshot?.install.phase === 'waiting'
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => {
      void window.sw.updates.get().then(setSnapshot).catch(() => undefined)
    }, 1000)
    return () => clearInterval(timer)
  }, [waiting])
  return snapshot
}

function AnswerActions({ view, snapshot, onAnswer }: { view: AnswerView; snapshot: UpdateSnapshot; onAnswer: (answer: AnswerView | null) => void }): JSX.Element {
  const api = window.sw.updates
  return (
    <div className="sw-update-actions">
      {view.action === 'download' && <UpdateAction snapshot={snapshot} version={view.version} />}
      {view.action === 'try-again' && <button className="copyref" onClick={() => void api.check().then((next) => onAnswer(answerFor(next)))}>Try again</button>}
      {view.action === 'stop-skipping' && (
        <button className="copyref" onClick={() => void api.stopSkipping().then((next) => onAnswer(answerFor(next)))}>Stop skipping</button>
      )}
      {view.action === 'open-store' && <button className="copyref" onClick={() => void api.store()}>Open in Mac App Store</button>}
      {view.whatsNew && <button className="link" onClick={() => void api.releaseNotes()}>What’s new in {view.version}</button>}
    </div>
  )
}

function UpdateAction({ snapshot, version }: { snapshot: UpdateSnapshot; version?: string }): JSX.Element | null {
  if (!snapshot.enabled || !version) return null
  const api = window.sw.updates
  if (snapshot.file && !snapshot.refusal && snapshot.state.lastResult !== 'unreadable') {
    return <button className="primary-btn" onClick={() => void api.update(version)}>Update</button>
  }
  return <button className="primary-btn" onClick={() => void api.download()}>Download</button>
}

function InstallDetails({ snapshot }: { snapshot: UpdateSnapshot }): JSX.Element | null {
  const update = snapshot.install
  const api = window.sw.updates
  switch (update.phase) {
    case 'idle': return null
    case 'downloading': return <>
      <strong>Downloading SlideWell {update.version}</strong>
      <progress aria-label="Update download" max={update.total} value={update.received} />
      <p>{sizeText(update.received)} of {sizeText(update.total)}. You can keep working.</p>
      <button className="copyref" onClick={() => void api.cancel()}>Cancel</button>
    </>
    case 'waiting': return <>
      <strong>SlideWell {update.version} is ready</strong>
      <p>{blockersSentence(snapshot.blockers) || 'Restart to finish updating.'}</p>
      <div className="sw-update-actions">
        <button className="primary-btn" disabled={snapshot.blockers.length > 0} onClick={() => void api.restart()}>Restart</button>
        <button className="copyref" onClick={() => void api.cancel()}>Cancel update</button>
      </div>
    </>
    case 'restarting': return <>
      <strong>Restarting into SlideWell {update.version}…</strong>
      <p>macOS checks the new version before it opens.</p>
    </>
    case 'failed': return <>
      <strong>Could not update to {update.version}</strong>
      <p>{FAIL_TEXT[update.reason]}</p>
      <div className="sw-update-actions">
        {update.reason !== 'reopen' && snapshot.enabled && snapshot.file && !snapshot.refusal &&
          <button className="primary-btn" onClick={() => void api.update(update.version)}>Try again</button>}
        <button className="copyref" onClick={() => void api.download()}>Download</button>
      </div>
    </>
    case 'reopen': {
      const message = reopenText(update)
      return <><strong>{message.title}</strong><p>{message.detail}</p></>
    }
  }
}

function UpdateFoot({ snapshot, version }: { snapshot: UpdateSnapshot; version: string }): JSX.Element {
  return <p>{snapshot.file && !snapshot.refusal
    ? updateFoot(version, snapshot.file)
    : snapshot.refusal && snapshot.refusal !== 'development' && snapshot.refusal !== 'no-file'
      ? REFUSAL_TEXT[snapshot.refusal]
      : 'Download opens the download page in your browser.'}</p>
}

export function UpdateStatus(): JSX.Element | null {
  const snapshot = useUpdateSnapshot()
  const [open, setOpen] = useState(false)
  const [answer, setAnswer] = useState<AnswerView | null>(null)
  const [notes, setNotes] = useState<UpdateNotes | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const markButton = useRef<HTMLButtonElement>(null)
  const latest = snapshot?.mark
  const installMark = snapshot ? installMarkText(snapshot.install) : null
  const mark = installMark ?? (latest ? availableMarkText(latest) : null)
  const api = window.sw?.updates

  useEffect(() => {
    if (!api) return
    const offAnswer = api.onAnswer((next) => setAnswer(answerFor(next)))
    const offNotes = api.onShowNotes(setNotes)
    return () => { offAnswer(); offNotes() }
  }, [api])
  useEffect(() => {
    if (!mark) setOpen(false)
  }, [mark])
  useEffect(() => {
    if (!open && !notes) return
    const closeOutside = (event: MouseEvent): void => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      setNotes(null)
      if (open) markButton.current?.focus()
    }
    document.addEventListener('mousedown', closeOutside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', closeOutside); document.removeEventListener('keydown', escape) }
  }, [open, notes])
  useEffect(() => {
    if (!answer || answer.action) return
    const timer = setTimeout(() => setAnswer(null), 6000)
    return () => clearTimeout(timer)
  }, [answer])

  if (!snapshot || !api) return null
  return (
    <>
      <div className="sw-update-status" ref={anchor}>
        <span title={aboutLines(snapshot).version}>v{snapshot.running}</span>
        {mark && (
          <button ref={markButton} className="link sw-update-mark" data-update-mark aria-expanded={open} onClick={() => setOpen(!open)}>
            ↑ {mark}
          </button>
        )}
        {snapshot.whatsNew && (
          <button className="link sw-update-mark" onClick={() => void api.whatsNew().then(setNotes)}>{updatedMarkText(snapshot.whatsNew)}</button>
        )}
        {open && installMark && (
          <div className="sw-update-popover" role="dialog" aria-label="SlideWell update">
            <InstallDetails snapshot={snapshot} />
          </div>
        )}
        {open && !installMark && latest && (
          <div className="sw-update-popover" role="dialog" aria-label="A new version is available">
            <strong>SlideWell {latest.version} is available</strong>
            <p>Released {dateText(latest.released)}. {aboutLines(snapshot).version} is installed.</p>
            <ul>{latest.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
            <div className="sw-update-actions">
              <UpdateAction snapshot={snapshot} version={latest.version} />
              <button className="copyref" onClick={() => { setOpen(false); void api.notNow() }}>Not now</button>
              <button className="copyref" onClick={() => { setOpen(false); void api.skip() }}>Skip this version</button>
            </div>
            <UpdateFoot snapshot={snapshot} version={latest.version} />
            <button className="link" onClick={() => void api.releaseNotes()}>What’s new in {latest.version}</button>
          </div>
        )}
      </div>
      {answer && (
        <div className="sw-update-answer" role="status">
          <button className="copyref sw-update-close" aria-label="Dismiss update message" onClick={() => setAnswer(null)}>×</button>
          <strong>{answer.title}</strong>
          <p>{answer.detail}</p>
          {installMark
            ? <InstallDetails snapshot={snapshot} />
            : <><AnswerActions view={answer} snapshot={snapshot} onAnswer={setAnswer} />
                {answer.version && answer.action === 'download' && <UpdateFoot snapshot={snapshot} version={answer.version} />}</>}
        </div>
      )}
      {notes && (
        <div className="overlay" onClick={() => setNotes(null)}>
          <div className="modal sw-update-notes" role="dialog" aria-label="What’s new in SlideWell" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <strong>What’s new in SlideWell {notes.version}</strong>
              <button autoFocus className="copyref" onClick={() => setNotes(null)}>Close</button>
            </div>
            {notes.items.length > 0 ? (
              <ul>{notes.items.map(({ title, text }, i) => <li key={i}>{title && <strong>{title}. </strong>}{text}</li>)}</ul>
            ) : <p>Release notes are unavailable for this version.</p>}
          </div>
        </div>
      )}
    </>
  )
}

export function AboutUpdates(): JSX.Element {
  const snapshot = useUpdateSnapshot()
  const [asked, setAsked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!snapshot) return <p>Loading version information…</p>
  const about = aboutLines(snapshot)
  const api = window.sw.updates
  const store = snapshot.source === 'store'
  const view = (asked || store) && !snapshot.checking
    ? answerFor(snapshot)
    : cardView(snapshot.state, { ...snapshot, now: Date.now() })
  const setUpdateSetting = async (key: string, on: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    setAsked(false)
    try {
      const result = await window.bridleSettings.set(key, on)
      if (!result.ok) setError(result.error)
    } catch {
      setError('The setting could not be saved.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="sw-page sw-about-updates">
      <p><strong>SlideWell · {about.version}</strong><br />{about.where}</p>
      {!store && (
        <>
          <label>
            <input type="checkbox" checked={snapshot.enabled} disabled={saving} onChange={(event) => void setUpdateSetting(UPDATE_CHECK_KEY, event.target.checked)} />
            {' '}Check for new versions daily
          </label>
          <p>{privacyText(snapshot.identity)}</p>
          <label>
            <input type="checkbox" checked={snapshot.alpha} disabled={saving} onChange={(event) => void setUpdateSetting(UPDATE_ALPHA_KEY, event.target.checked)} />
            {' '}Get early versions (alpha)
          </label>
          <p>{ALPHA_HINT}</p>
          {error && <p role="alert">{error}</p>}
        </>
      )}
      <button className="copyref" disabled={snapshot.checking || (!store && !snapshot.enabled)} onClick={() => void api.check().then(() => setAsked(true))}>
        {snapshot.checking ? 'Checking…' : 'Check for Updates…'}
      </button>
      {snapshot.install.phase !== 'idle' ? (
        <div className="sw-update-settings-answer" role="status"><InstallDetails snapshot={snapshot} /></div>
      ) : view && (
        <div className="sw-update-settings-answer" role="status">
          <strong>{view.title}</strong>
          {view.detail && <p>{view.detail}</p>}
          <AnswerActions view={view} snapshot={snapshot} onAnswer={() => setAsked(true)} />
          {view.version && view.action === 'download' && <UpdateFoot snapshot={snapshot} version={view.version} />}
        </div>
      )}
    </section>
  )
}
