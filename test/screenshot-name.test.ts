import { describe, it, expect } from 'vitest'
import { parseScreenshotName } from '../src/main/screenshot-name'

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
