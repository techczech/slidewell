// Teach the sorter (ticket 23): the words and the chart geometry, as pure functions so the components only draw.
// Nothing here reads window.sw. Frames B1-B3 and A3 (docs/design/2026-10-12-sorter-training-feedback); numbers in the
// frames were invented, everything below works from the real status and learning reading.
import type { SorterLearning, SorterLearningPoint, SorterRetrain, SorterStatus } from '../../preload'
import { n } from './sorter-format'

/** 0..1 as a whole percent; "89.5" style when the half matters (chart labels). */
export const wholePct = (x: number): number => Math.round(x * 100)
export const chartPct = (x: number): string => {
  const v = Math.round(x * 1000) / 10
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`
}

/** How many choices the sorter can learn from, as the Auto sorting tab counts them. */
export function choicesOf(st: SorterStatus): number {
  if (st.learnable) return st.learnable.kept + st.learnable.binned
  return st.report ? st.report.usable.keep + st.report.usable.throwaway : 0
}

/** "Leaning throwaway, 62% sure": how sure the sorter is of the way it leans. */
export function certainty(pKeep: number, leans: 'keep' | 'throwaway'): { keep: number; throwaway: number; sure: number; lean: string } {
  const keep = wholePct(pKeep)
  const throwaway = 100 - keep
  return { keep, throwaway, sure: leans === 'keep' ? keep : throwaway, lean: leans === 'keep' ? 'keep' : 'throwaway' }
}

// ---------------------------------------------------------------- the strip

export type StripLine = { kind: 'few' | 'retraining' | 'waiting' | 'off' | 'counting'; text: string; action: { id: 'retrain-now' | 'retrain'; label: string } | null }

/** The one line at the top of Review. Order of precedence: running, waiting for power, too few choices, automatic retraining off, counting. */
export function stripLine(st: SorterStatus, needALook: number): StripLine {
  const choices = choicesOf(st)
  const base = `Sorter: ${n(choices)} ${choices === 1 ? 'choice' : 'choices'} · ${n(needALook)} need a look`
  if (st.retraining) {
    const how = st.retraining === 'auto' ? 'by itself after ten answers' : st.retraining === 'round' ? 'after the round' : 'now'
    return { kind: 'retraining', text: `Sorter: retraining ${how} on ${n(choices)} choices. You can keep answering.`, action: null }
  }
  if (st.waitingForPower) {
    const a = st.waitingForPower.answers
    return { kind: 'waiting', text: `Sorter: ${n(a)} ${a === 1 ? 'answer is' : 'answers are'} waiting. It retrains when the Mac is plugged in.`, action: { id: 'retrain-now', label: 'Retrain now' } }
  }
  if (st.choicesNeeded > 0) {
    return { kind: 'few', text: `${base} · it needs ${n(st.choicesNeeded)} more choices before it can learn from them`, action: null }
  }
  if (!st.autoRetrain) {
    const a = st.answersSinceTraining
    return { kind: 'off', text: `${base} · retraining by itself is off (${n(a)} ${a === 1 ? 'answer' : 'answers'} since it last trained)`, action: { id: 'retrain', label: 'Retrain' } }
  }
  const toGo = Math.max(0, st.retrainEvery - st.answersSinceTraining)
  return { kind: 'counting', text: `${base} · retrains after every ${st.retrainEvery} answers (${toGo > 0 ? `${toGo} to go` : 'retraining next'})`, action: null }
}

/** "Next retrain after 10 more answers (10 to go)" for the expanded strip. */
export function nextRetrain(st: SorterStatus): string {
  if (st.retraining) return 'Retraining now.'
  if (st.waitingForPower) return `${n(st.waitingForPower.answers)} answers are waiting. It retrains when the Mac is plugged in.`
  if (!st.autoRetrain) return 'Retraining by itself is off. Retrain when you want to.'
  if (st.choicesNeeded > 0) return `It needs ${n(st.choicesNeeded)} more choices before it can retrain by itself.`
  const toGo = Math.max(0, st.retrainEvery - st.answersSinceTraining)
  return toGo > 0 ? `Next retrain after ${st.retrainEvery} more answers (${toGo} to go)` : 'Retraining next.'
}

const shareLine = (label: string, before: number | null | undefined, after: number | null | undefined): string | null =>
  after === null || after === undefined ? null : before === null || before === undefined ? `${label}: ${wholePct(after)}%.` : `${label}: ${wholePct(before)}% → ${wholePct(after)}%.`

/** What a retrain moved, in words. `needALook` / `movedToSure` null = it could not be checked: then only that it retrained, and the accuracy. */
export function retrainSummary(r: SorterRetrain): string {
  const parts = [`Retrained on ${n(r.choices.after)} choices.`]
  if (r.needALook && r.movedToSure) {
    const moved = r.movedToSure.keep + r.movedToSure.throwaway
    parts.push(
      moved === 0
        ? 'No screenshots left the need-a-look queue.'
        : `${n(moved)} ${moved === 1 ? 'screenshot' : 'screenshots'} left the need-a-look queue (${n(r.movedToSure.keep)} keep, ${n(r.movedToSure.throwaway)} throwaway).`
    )
    parts.push(`Need a look: ${n(r.needALook.before)} → ${n(r.needALook.after)}.`)
  }
  const t = shareLine('Throwaway right', r.accuracy.before?.throwawayRight, r.accuracy.after.throwawayRight)
  const k = shareLine('Keep right', r.accuracy.before?.keepRight, r.accuracy.after.keepRight)
  if (t) parts.push(t)
  if (k) parts.push(k)
  return parts.join(' ')
}

// ---------------------------------------------------------------- the reading

/** Throwaway-right gain per extra 50 choices between neighbouring points, in percentage points ("+9, +4, +2.5"). */
export function perFifty(points: SorterLearningPoint[]): number[] {
  const out: number[] = []
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    if (a.throwawayRight === null || b.throwawayRight === null || b.choices <= a.choices) continue
    out.push(Math.round(((b.throwawayRight - a.throwawayRight) * 100 * 50 / (b.choices - a.choices)) * 10) / 10)
  }
  return out
}
export const signed = (x: number): string => `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x)}`

/** The last step's change per extra 50 choices: throwaway-right gain and need-a-look drop, points. null = the last two points cannot be compared. */
function lastStep(points: SorterLearningPoint[]): { ta: number; nl: number } | null {
  const a = points[points.length - 2]
  const b = points[points.length - 1]
  if (!a || !b || b.choices <= a.choices || a.throwawayRight === null || b.throwawayRight === null || a.needALook === null || b.needALook === null) return null
  const k = 50 / (b.choices - a.choices)
  return { ta: (b.throwawayRight - a.throwawayRight) * 100 * k, nl: (a.needALook - b.needALook) * 100 * k }
}

/** The verdict sentence and the line under it. */
export function readingWords(l: SorterLearning, choicesNow: number = l.choices): { headline: string; sub: string } {
  const choices = `${n(choicesNow)} ${choicesNow === 1 ? 'choice' : 'choices'} so far.` // his count now; the reading itself is for the last training
  if (l.verdict === 'not-enough') {
    const half = Math.floor(l.minimum / 2)
    return {
      headline: `${choices} It needs ${n(l.more)} more before it can be tested.`,
      sub: `The sorter can be tested from ${n(l.minimum)} choices, ${n(half)} kept and ${n(half)} thrown away. Until then it does not retrain by itself.`
    }
  }
  const headline = l.verdict === 'still-helping' ? `${choices} More would still help.` : `${choices} Another round is unlikely to change much.`
  if (l.points.length === 0) return { headline, sub: l.error ? `The reading could not be worked out: ${l.error}` : '' }
  const s = lastStep(l.points)
  if (!s) return { headline, sub: '' }
  const taFlat = Math.abs(s.ta) < 1
  const nlFalling = s.nl >= 1
  if (l.verdict === 'levelling-off') return { headline, sub: 'Throwaway accuracy and the share it is unsure about have both stopped moving much over the last 50 choices.' }
  if (taFlat && nlFalling) return { headline, sub: 'Throwaway accuracy has levelled off, but the share it is unsure about is still falling.' }
  if (!taFlat && nlFalling) return { headline, sub: 'Throwaway accuracy is still rising and the share it is unsure about is still falling.' }
  if (!taFlat) return { headline, sub: 'Throwaway accuracy is still rising.' }
  return { headline, sub: 'Each batch of choices is still improving the result a little.' }
}

/** Which kind of answer helps most, from what it has seen so far. */
export function balanceNote(kept: number, thrownAway: number): string {
  if (kept + thrownAway === 0) return ''
  if (thrownAway < kept * 0.6) return 'It has seen fewer thrown-away screenshots than kept ones, so answers about throwaways help most.'
  if (kept < thrownAway * 0.6) return 'It has seen fewer kept screenshots than thrown-away ones, so answers about keepers help most.'
  return 'It has seen a fair mix of kept and thrown-away screenshots.'
}

// ---------------------------------------------------------------- the chart

export const CHART = { w: 708, h: 372, left: 58, right: 686, top: 24, bottom: 320, topPlotY: 30, topPlotH: 150.8, lowPlotH: 102.24 } as const

export type ChartTick = { y: number; label: string }
export type ChartDot = { x: number; y: number; label: string; last: boolean }
export type ChartModel = {
  minimumX: number | null // x of the dashed line; the shaded band runs from `left` to it
  topTicks: ChartTick[]
  lowTicks: ChartTick[]
  xTicks: Array<{ x: number; label: string }>
  throwaway: { dots: ChartDot[]; line: string[] } // line = one polyline points string per unbroken run
  needALook: { dots: ChartDot[]; line: string[] }
  boundary: number // y of the low panel's title, just above its top gridline
}

const r1 = (x: number): number => Math.round(x * 10) / 10

/** Geometry of the two-panel chart: throwaway right on top (70-100%, lower if it ever falls below), need-a-look share below (0-60%, higher if needed). */
export function chartModel(l: Pick<SorterLearning, 'points' | 'minimum'>): ChartModel {
  const pts = l.points
  const lastChoices = pts.length ? pts[pts.length - 1].choices : l.minimum
  const xmax = Math.max(lastChoices, l.minimum) * 1.058
  const x = (c: number): number => r1(CHART.left + (c / xmax) * (CHART.right - CHART.left))
  const ta = pts.map((p) => p.throwawayRight).filter((v): v is number => v !== null)
  const nl = pts.map((p) => p.needALook).filter((v): v is number => v !== null)
  const topLo = Math.min(70, ta.length ? Math.floor((Math.min(...ta) * 100) / 10) * 10 : 70)
  const lowHi = Math.min(100, Math.max(60, nl.length ? Math.ceil((Math.max(...nl) * 100) / 20) * 20 : 60))
  const yTop = (v: number): number => r1(CHART.topPlotY + (1 - v) * 100 * (CHART.topPlotH / (100 - topLo)))
  const yLow = (v: number): number => r1(CHART.bottom - v * 100 * (CHART.lowPlotH / lowHi))
  const series = (get: (p: SorterLearningPoint) => number | null, y: (v: number) => number) => {
    const dots: ChartDot[] = []
    const line: string[] = []
    let run: string[] = []
    pts.forEach((p, i) => {
      const v = get(p)
      if (v === null) {
        if (run.length) line.push(run.join(' '))
        run = []
        return
      }
      const px = x(p.choices)
      const py = y(v)
      run.push(`${px},${py}`)
      dots.push({ x: px, y: py, label: chartPct(v), last: i === pts.length - 1 })
    })
    if (run.length) line.push(run.join(' '))
    return { dots, line: line.filter((s) => s.includes(' ')) } // a lone point has no line
  }
  const topTicks: ChartTick[] = []
  for (let v = topLo; v <= 100; v += 10) topTicks.push({ y: yTop(v / 100), label: `${v}%` })
  const lowTicks: ChartTick[] = []
  for (let v = 0; v <= lowHi; v += 20) lowTicks.push({ y: yLow(v / 100), label: `${v}%` })
  return {
    minimumX: l.minimum > 0 ? x(l.minimum) : null,
    topTicks,
    lowTicks,
    xTicks: pts.map((p) => ({ x: x(p.choices), label: String(p.choices) })),
    throwaway: series((p) => p.throwawayRight, yTop),
    needALook: series((p) => p.needALook, yLow),
    boundary: r1(yLow(lowHi / 100) - 9) // just above the highest low-panel gridline
  }
}

/** The chart's values as sentences, for the screen-reader table and the label. */
export function chartRows(points: SorterLearningPoint[]): Array<{ choices: number; throwawayRight: string; needALook: string }> {
  return points.map((p) => ({ choices: p.choices, throwawayRight: p.throwawayRight === null ? 'not measured' : chartPct(p.throwawayRight), needALook: p.needALook === null ? 'not measured' : chartPct(p.needALook) }))
}
