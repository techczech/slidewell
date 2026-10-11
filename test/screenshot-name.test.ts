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

// Ticket 15: names built from CleanShot's own mediaNameTemplate (his template, read 2026-10-10 with
// `defaults read`). Every file name below is invented; none comes from his Desktop.
const HIS = ['CleanShot ', '%y', '-', '%m', '-', '%d', ' at ', '%H', '%M', 'from ', '%a', ' with ', '%t']

describe('parseScreenshotName with CleanShot\'s template', () => {
  const tpl = compileNameTemplate(HIS)

  it('his names give date, time, app and window', () => {
    expect(parseScreenshotName('CleanShot 2026-10-10 at 1147from Notes with Shopping list.png', tpl)).toEqual({
      origin: 'cleanshot',
      takenAt: '2026-10-10T11:47:00',
      date: '2026-10-10',
      app: 'Notes',
      window: 'Shopping list'
    })
    expect(parseScreenshotName('CleanShot 2026-07-24 at 1224from Microsoft Outlook with RE Project notes • someone@example.org.png', tpl)).toMatchObject({
      app: 'Microsoft Outlook',
      window: 'RE Project notes • someone@example.org'
    })
    expect(parseScreenshotName('CleanShot 2026-07-25 at 1548from Google Chrome with README.md — draft plan.png', tpl)).toMatchObject({ app: 'Google Chrome', window: 'README.md — draft plan' })
    // a window title that itself contains " with "
    expect(parseScreenshotName('CleanShot 2026-10-01 at 0900from Safari with Tea with Lemon.png', tpl)).toMatchObject({ app: 'Safari', window: 'Tea with Lemon' })
  })

  it('an empty window title: CleanShot trims the name to "… with"', () => {
    expect(parseScreenshotName('CleanShot 2026-10-02 at 0906from Preview with.png', tpl)).toMatchObject({ takenAt: '2026-10-02T09:06:00', app: 'Preview', window: null })
  })

  it('trailing digits stay in the window title unless the plain name is in the same folder', () => {
    expect(parseScreenshotName('CleanShot 2026-10-01 at 0900from Numbers with Quarterly results 2026.png', tpl)).toMatchObject({ window: 'Quarterly results 2026' })
    const dupe = 'CleanShot 2026-10-01 at 0900from Notes with Shopping list 2.png'
    expect(parseScreenshotName(dupe, tpl)).toMatchObject({ window: 'Shopping list 2' })
    const siblings = new Set(['cleanshot 2026-10-01 at 0900from notes with shopping list.png', dupe.toLowerCase()])
    expect(parseScreenshotName(dupe, tpl, { siblings })).toMatchObject({ window: 'Shopping list' })
    expect(parseScreenshotName('CleanShot 2026-10-01 at 0900from Notes with Shopping list (3).png', tpl, { siblings })).toMatchObject({ window: 'Shopping list' })
    // a counter after a time field is outside any title: always a duplicate counter
    const t = compileNameTemplate(['Shot ', '%y', '-', '%m', '-', '%d', ' ', '%H', '%M'])
    expect(parseScreenshotName('Shot 2026-10-01 0900 2.png', t)).toMatchObject({ takenAt: '2026-10-01T09:00:00' })
    expect(parseScreenshotName('CleanShot 2026-10-08 at 10.39.03 2.png')).toMatchObject({ takenAt: '2026-10-08T10:39:03' })
  })

  it('the default CleanShot style and macOS names still parse with his template in place', () => {
    expect(parseScreenshotName('CleanShot 2026-10-08 at 10.39.03.png', tpl)).toEqual({ origin: 'cleanshot', takenAt: '2026-10-08T10:39:03', date: '2026-10-08', app: null, window: null })
    expect(parseScreenshotName('CleanShot 2026-10-08 at 10.39.03@2x.png', tpl)?.takenAt).toBe('2026-10-08T10:39:03')
    expect(parseScreenshotName('Screenshot 2026-10-08 at 10.05.01.png', tpl)).toMatchObject({ origin: 'macos', takenAt: '2026-10-08T10:05:01' })
  })

  it('his names also parse without the template (reader failed)', () => {
    expect(parseScreenshotName('CleanShot 2026-10-10 at 1147from Notes with Shopping list.png')).toMatchObject({ takenAt: '2026-10-10T11:47:00', app: 'Notes', window: 'Shopping list' })
  })

  it('other templates: seconds, two-digit year, retina suffix', () => {
    const t = compileNameTemplate(['Shot_', '%y', '%m', '%d', '_', '%H', '%M', '%S'])
    expect(parseScreenshotName('Shot_261010_114701@2x.png', t)).toMatchObject({ takenAt: '2026-10-10T11:47:01', app: null, window: null })
  })

  it('rejects impossible dates and non-matching names', () => {
    expect(parseScreenshotName('CleanShot 2026-13-10 at 1147from X with Y.png', tpl)).toBeNull()
    expect(parseScreenshotName('CleanShot 2026-10-10 at 2547from X with Y.png', tpl)).toBeNull()
    expect(parseScreenshotName('holiday.png', tpl)).toBeNull()
  })

  it('a template without a leading word gives no screenshot authority: the built-in patterns are used', () => {
    const bare = compileNameTemplate(['%y', '-', '%m', '-', '%d', ' ', '%t'])
    expect(bare).toBeNull()
    expect(parseScreenshotName('2026-10-10 holiday.png', bare)).toBeNull()
    expect(compileNameTemplate(['at ', '%y', '-', '%m', '-', '%d'])).toBeNull() // two letters are not a discriminator
    expect(compileNameTemplate(['Shot ', '%a', ' ', '%t'])).toBeNull() // no date
    expect(compileNameTemplate([])).toBeNull()
    expect(compileNameTemplate(null)).toBeNull()
  })

  it('unknown, repeated or adjacent free-text tokens: the template is rejected', () => {
    expect(compileNameTemplate(['CleanShot ', '%y', '-', '%m', '-', '%d', ' ', '%q'])).toBeNull()
    expect(compileNameTemplate(['CleanShot ', '%y', '-', '%m', '-', '%d', ' ', '%t', ' ', '%t'])).toBeNull()
    expect(compileNameTemplate(['CleanShot ', '%y', '-', '%m', '-', '%d', ' ', '%a', '%t'])).toBeNull()
  })

  it('bounded time: the ten-%q template and a 201-character name finish in under 50 ms', () => {
    const tenQ = compileNameTemplate(['CleanShot ', '%y', '-', '%m', '-', '%d', ...Array(10).fill('%q'), 'Z'])
    expect(tenQ).toBeNull()
    const name = `CleanShot 2026-10-10${'a'.repeat(201 - 'CleanShot 2026-10-10'.length - 4)}.png`
    expect(name).toHaveLength(201)
    const t0 = performance.now()
    expect(parseScreenshotName(name, tenQ)).toBeNull()
    // his template at the length limit, built to fail late
    const evil = `CleanShot 2026-10-10 at 1147from ${' with'.repeat(44)}x`.slice(0, 251) + '.png'
    parseScreenshotName(evil, tpl)
    parseScreenshotName('x'.repeat(300) + '.png', tpl) // over the limit: not parsed at all
    expect(performance.now() - t0).toBeLessThan(50)
  })
})
