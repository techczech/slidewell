import { useEffect, useRef, useState } from 'react'
import {
  aboutLines, answerView, availableMarkText, cardView, dateText, privacyText, updatedMarkText,
  type AnswerView, type UpdateSnapshot
} from '@app-patterns/updates'
import type { UpdateNotes } from '../../preload'
import { UPDATE_CHECK_KEY } from '../../shared/update-identity'
import './update-notices.css'

const answerFor = (snapshot: UpdateSnapshot): AnswerView =>
  answerView(snapshot.state, { ...snapshot, now: Date.now() })

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
  return snapshot
}

function AnswerActions({ view, onAnswer }: { view: AnswerView; onAnswer: (answer: AnswerView | null) => void }): JSX.Element {
  const api = window.sw.updates
  return (
    <div className="sw-update-actions">
      {view.action === 'download' && <button className="primary-btn" onClick={() => void api.download()}>Download</button>}
      {view.action === 'try-again' && <button className="copyref" onClick={() => void api.check().then((next) => onAnswer(answerFor(next)))}>Try again</button>}
      {view.action === 'stop-skipping' && (
        <button className="copyref" onClick={() => void api.stopSkipping().then((next) => onAnswer(answerFor(next)))}>Stop skipping</button>
      )}
      {view.action === 'open-store' && <button className="copyref" onClick={() => void api.store()}>Open in Mac App Store</button>}
      {view.whatsNew && <button className="link" onClick={() => void api.releaseNotes()}>What’s new in {view.version}</button>}
    </div>
  )
}

export function UpdateStatus(): JSX.Element | null {
  const snapshot = useUpdateSnapshot()
  const [open, setOpen] = useState(false)
  const [answer, setAnswer] = useState<AnswerView | null>(null)
  const [notes, setNotes] = useState<UpdateNotes | null>(null)
  const anchor = useRef<HTMLDivElement>(null)
  const markButton = useRef<HTMLButtonElement>(null)
  const latest = snapshot?.mark
  const api = window.sw?.updates

  useEffect(() => {
    if (!api) return
    const offAnswer = api.onAnswer((next) => setAnswer(answerFor(next)))
    const offNotes = api.onShowNotes(setNotes)
    return () => { offAnswer(); offNotes() }
  }, [api])
  useEffect(() => {
    if (!latest) setOpen(false)
  }, [latest])
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
        {latest && (
          <button ref={markButton} className="link sw-update-mark" data-update-mark aria-expanded={open} onClick={() => setOpen(!open)}>
            ↑ {availableMarkText(latest)}
          </button>
        )}
        {snapshot.whatsNew && (
          <button className="link sw-update-mark" onClick={() => void api.whatsNew().then(setNotes)}>{updatedMarkText(snapshot.whatsNew)}</button>
        )}
        {open && latest && (
          <div className="sw-update-popover" role="dialog" aria-label="A new version is available">
            <strong>SlideWell {latest.version} is available</strong>
            <p>Released {dateText(latest.released)}. {aboutLines(snapshot).version} is installed.</p>
            <ul>{latest.summary.map((line, i) => <li key={i}>{line}</li>)}</ul>
            <div className="sw-update-actions">
              <button className="primary-btn" onClick={() => { setOpen(false); void api.download() }}>Download</button>
              <button className="copyref" onClick={() => { setOpen(false); void api.notNow() }}>Not now</button>
              <button className="copyref" onClick={() => { setOpen(false); void api.skip() }}>Skip this version</button>
            </div>
            <p>Download opens the download page in your browser.</p>
            <button className="link" onClick={() => void api.releaseNotes()}>What’s new in {latest.version}</button>
          </div>
        )}
      </div>
      {answer && (
        <div className="sw-update-answer" role="status">
          <button className="copyref sw-update-close" aria-label="Dismiss update message" onClick={() => setAnswer(null)}>×</button>
          <strong>{answer.title}</strong>
          <p>{answer.detail}</p>
          <AnswerActions view={answer} onAnswer={setAnswer} />
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
  const setEnabled = async (on: boolean): Promise<void> => {
    setSaving(true)
    setError(null)
    setAsked(false)
    try {
      const result = await window.bridleSettings.set(UPDATE_CHECK_KEY, on)
      if (!result.ok) setError(result.error)
    } catch {
      setError('The setting could not be saved.')
    } finally {
      setSaving(false)
    }
  }
  return (
    <section className="sw-page sw-about-updates">
      <h2>About and updates</h2>
      <p><strong>SlideWell · {about.version}</strong><br />{about.where}</p>
      {!store && (
        <>
          <label>
            <input type="checkbox" checked={snapshot.enabled} disabled={saving} onChange={(event) => void setEnabled(event.target.checked)} />
            {' '}Check for new versions daily
          </label>
          <p>{privacyText(snapshot.identity)}</p>
          {error && <p role="alert">{error}</p>}
        </>
      )}
      <button className="copyref" disabled={snapshot.checking} onClick={() => void api.check().then(() => setAsked(true))}>
        {snapshot.checking ? 'Checking…' : 'Check for Updates…'}
      </button>
      {view && (
        <div className="sw-update-settings-answer" role="status">
          <strong>{view.title}</strong>
          {view.detail && <p>{view.detail}</p>}
          <AnswerActions view={view} onAnswer={() => setAsked(true)} />
        </div>
      )}
    </section>
  )
}
