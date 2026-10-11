import { describe, it, expect } from 'vitest'
import { compileNameTemplate, parseScreenshotName } from '../src/main/screenshot-name'

describe('parseScreenshotName', () => {
  it('CleanShot with app and window', () => {
    expect(parseScreenshotName('CleanShot 2026-10-08 at 0801 from Google Chrome with TalkWeaver Layout Showcase.png')).toEqual({
      origin: 'cleanshot',
      takenAt: '2026-10-08T08:01:00',
      date: '2026-10-08',
      app: 'Google Chrome',
      window: 'TalkWeaver Layout Showcase'
    })
  })
  it('CleanShot with dotted time, @2x and window containing dots', () => {
    const p = parseScreenshotName('CleanShot 2026-10-08 at 08.01.23@2x from Safari with example.com - Home.png')
    expect(p).toMatchObject({ takenAt: '2026-10-08T08:01:23', app: 'Safari', window: 'example.com - Home' })
  })
  it('CleanShot without app/window yields date only', () => {
    expect(parseScreenshotName('CleanShot 2026-10-08 at 08.01.23.png')).toEqual({ origin: 'cleanshot', takenAt: '2026-10-08T08:01:23', date: '2026-10-08', app: null, window: null })
  })
  it('CleanShot with app but no window', () => {
    expect(parseScreenshotName('CleanShot 2026-10-08 at 0801 from Slack.png')).toMatchObject({ app: 'Slack', window: null })
  })
  it('macOS Screenshot names, 24h and 12h', () => {
    expect(parseScreenshotName('Screenshot 2026-10-08 at 10.05.01.png')).toEqual({ origin: 'macos', takenAt: '2026-10-08T10:05:01', date: '2026-10-08', app: null, window: null })
    expect(parseScreenshotName('Screen Shot 2026-10-08 at 3.05.01 PM.png')?.takenAt).toBe('2026-10-08T15:05:01')
    expect(parseScreenshotName('Screenshot 2026-10-08 at 12.05.01 AM (2).png')?.takenAt).toBe('2026-10-08T00:05:01')
  })
  it('non-screenshot names and impossible dates are null', () => {
    expect(parseScreenshotName('holiday.png')).toBeNull()
    expect(parseScreenshotName('Screenshots notes.txt')).toBeNull()
    expect(parseScreenshotName('CleanShot 2026-13-08 at 0801.png')).toBeNull()
    expect(parseScreenshotName('CleanShot 2026-10-08 at 2561.png')).toBeNull()
  })
})

// Ticket 15: names built from CleanShot's own mediaNameTemplate (his, read 2026-10-10 with `defaults read`).
const HIS = ['CleanShot ', '%y', '-', '%m', '-', '%d', ' at ', '%H', '%M', 'from ', '%a', ' with ', '%t']

describe('parseScreenshotName with CleanShot\'s template', () => {
  const tpl = compileNameTemplate(HIS)

  it('his names give date, time, app and window', () => {
    expect(parseScreenshotName('CleanShot 2026-10-10 at 1147from TalkWeaver with TalkWeaver.png', tpl)).toEqual({
      origin: 'cleanshot',
      takenAt: '2026-10-10T11:47:00',
      date: '2026-10-10',
      app: 'TalkWeaver',
      window: 'TalkWeaver'
    })
    expect(parseScreenshotName('CleanShot 2026-07-24 at 1224from Microsoft Outlook with RE Project notes • someone@example.org.png', tpl)).toMatchObject({
      app: 'Microsoft Outlook',
      window: 'RE Project notes • someone@example.org'
    })
    expect(parseScreenshotName('CleanShot 2026-07-25 at 1548from Google Chrome with AGENTS-global.md — slimming proposal.png', tpl)).toMatchObject({
      app: 'Google Chrome',
      window: 'AGENTS-global.md — slimming proposal'
    })
    // a window title that itself contains " with "
    expect(parseScreenshotName('CleanShot 2026-10-01 at 0900from Google Chrome with Keep Up with AI.png', tpl)).toMatchObject({ app: 'Google Chrome', window: 'Keep Up with AI' })
  })

  it('an empty window title (CleanShot trims the name) and duplicate counters', () => {
    expect(parseScreenshotName('CleanShot 2026-10-02 at 0906from TodoScout with.png', tpl)).toMatchObject({ takenAt: '2026-10-02T09:06:00', app: 'TodoScout', window: null })
    expect(parseScreenshotName('CleanShot 2026-07-25 at 1042from QA Scout with QA Scout 2.png', tpl)).toMatchObject({ app: 'QA Scout', window: 'QA Scout' })
    expect(parseScreenshotName('CleanShot 2026-10-01 at 0900from Slack with General (3).mp4', tpl)).toMatchObject({ app: 'Slack', window: 'General' })
  })

  it('the default CleanShot style and macOS names still parse with his template in place', () => {
    expect(parseScreenshotName('CleanShot 2026-10-08 at 10.39.03.png', tpl)).toEqual({ origin: 'cleanshot', takenAt: '2026-10-08T10:39:03', date: '2026-10-08', app: null, window: null })
    expect(parseScreenshotName('CleanShot 2026-10-08 at 10.39.03@2x.png', tpl)?.takenAt).toBe('2026-10-08T10:39:03')
    expect(parseScreenshotName('Screenshot 2026-10-08 at 10.05.01.png', tpl)).toMatchObject({ origin: 'macos', takenAt: '2026-10-08T10:05:01' })
  })

  it('his names also parse without the template (reader failed)', () => {
    expect(parseScreenshotName('CleanShot 2026-10-10 at 1147from TalkWeaver with TalkWeaver.png')).toMatchObject({ takenAt: '2026-10-10T11:47:00', app: 'TalkWeaver', window: 'TalkWeaver' })
  })

  it('other templates: seconds, two-digit year, retina suffix', () => {
    const t = compileNameTemplate(['Shot_', '%y', '%m', '%d', '_', '%H', '%M', '%S'])
    expect(parseScreenshotName('Shot_261010_114701@2x.png', t)).toMatchObject({ takenAt: '2026-10-10T11:47:01', app: null, window: null })
  })

  it('rejects impossible dates and non-matching names; a template without a date is not used', () => {
    expect(parseScreenshotName('CleanShot 2026-13-10 at 1147from X with Y.png', tpl)).toBeNull()
    expect(parseScreenshotName('CleanShot 2026-10-10 at 2547from X with Y.png', tpl)).toBeNull()
    expect(parseScreenshotName('holiday.png', tpl)).toBeNull()
    expect(compileNameTemplate(['Shot ', '%a', ' ', '%t'])).toBeNull()
    expect(compileNameTemplate([])).toBeNull()
    expect(compileNameTemplate(null)).toBeNull()
  })
})
