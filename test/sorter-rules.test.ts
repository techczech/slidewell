import { describe, it, expect } from 'vitest'
import { applyRules, builtInForApp, builtInRules } from '../src/main/sorter/rules'

describe('sorter rules: throwaway-leaning', () => {
  it('Terminal by app name; a short error makes it surer', () => {
    const plain = applyRules({ app: 'Terminal', windowTitle: 'dominik — zsh — 80×24', ocrText: 'ls -la total 48 drwxr-xr-x README.md package.json src test node_modules' })
    expect(plain).toMatchObject({ lean: 'throwaway', rule: 'terminal', reason: 'Terminal window — usually throwaway' })
    const err = applyRules({ app: 'iTerm2', ocrText: 'npm ERR! code ENOENT npm ERR! syscall open npm ERR! path package.json' })
    expect(err).toMatchObject({ lean: 'throwaway', reason: 'Terminal window with a short error — usually throwaway' })
    expect(err!.confidence).toBeGreaterThan(plain!.confidence)
  })

  it('Terminal recognised from OCR alone (no app in the file name), at lower confidence', () => {
    const v = applyRules({ ocrText: 'Last login: Thu Oct 9 on ttys001\nzsh: command not found: pyhton' })
    expect(v).toMatchObject({ lean: 'throwaway', rule: 'terminal' })
    expect(v!.confidence).toBeLessThan(0.8)
  })

  it('System Settings by app and by pane names', () => {
    expect(applyRules({ app: 'System Settings', windowTitle: 'Privacy & Security' })).toMatchObject({ lean: 'throwaway', rule: 'system-settings', confidence: 0.85 })
    expect(applyRules({ ocrText: 'Wi-Fi Bluetooth Notifications Privacy & Security Screen Recording' })).toMatchObject({ lean: 'throwaway', rule: 'system-settings' })
  })

  it('Finder by app and by a file list in the OCR', () => {
    expect(applyRules({ app: 'Finder', windowTitle: 'Downloads' })).toMatchObject({ lean: 'throwaway', rule: 'finder', reason: 'Finder window — usually throwaway' })
    expect(applyRules({ ocrText: 'Favourites AirDrop Recents Applications Name Date Modified Size Kind report.pdf' })).toMatchObject({ lean: 'throwaway', rule: 'finder' })
  })
})

describe('sorter rules: keep-leaning', () => {
  it('Claude and ChatGPT answers, by app and by the footer text', () => {
    expect(applyRules({ app: 'Claude', ocrText: 'Here is a summary of the argument' })).toMatchObject({ lean: 'keep', rule: 'ai-answer' })
    expect(applyRules({ app: 'Google Chrome', windowTitle: 'ChatGPT', ocrText: 'some answer' })).toMatchObject({ lean: 'keep', rule: 'ai-answer' })
    expect(applyRules({ ocrText: 'The three main points are... Message ChatGPT ChatGPT can make mistakes. Check important info.' })).toMatchObject({ lean: 'keep', rule: 'ai-answer' })
  })

  it('a chart: many numbers with chart words, percentages or a run of years', () => {
    expect(applyRules({ ocrText: 'Figure 2: Share of respondents using AI 2019 2020 2021 2022 2023 12 18 25 41 57 Source: survey' })).toMatchObject({ lean: 'keep', rule: 'chart' })
    expect(applyRules({ ocrText: 'Adoption 12% 25% 33% 48% 52% 61%' })).toMatchObject({ lean: 'keep', rule: 'chart' })
  })

})

describe('sorter rules: own apps (turned round, ticket 20)', () => {
  it('a TalkWeaver, WriteFlex or SlideWell screen, by app or window title, is usually throwaway', () => {
    const reason = 'TalkWeaver, WriteFlex or SlideWell screen — usually throwaway'
    expect(applyRules({ app: 'TalkWeaver', windowTitle: 'Metaphor talk' })).toMatchObject({ lean: 'throwaway', rule: 'own-apps', confidence: 0.85, reason })
    expect(applyRules({ app: 'Electron', windowTitle: 'WriteFlex — draft' })).toMatchObject({ lean: 'throwaway', rule: 'own-apps', reason })
    expect(applyRules({ app: 'SlideWell' })).toMatchObject({ lean: 'throwaway', rule: 'own-apps' })
  })

  it('a mention in the text says nothing about the app: no rule', () => {
    expect(applyRules({ ocrText: 'WriteFlex Collections Draft Outline' })).toBeNull()
    expect(applyRules({ app: 'Quillpad', ocrText: 'notes about TalkWeaver and SlideWell' })).toBeNull()
  })
})

describe('sorter rules: his per-app rules (ticket 20)', () => {
  const mine = (app: string, rule: 'keep' | 'throwaway') => (name: string) => (name.trim().toLowerCase() === app.toLowerCase() ? { app, rule } : null)

  it('his rule overrides a built-in app rule, both ways', () => {
    expect(applyRules({ app: 'Finder', windowTitle: 'Downloads' }, mine('Finder', 'keep'))).toMatchObject({ lean: 'keep', rule: 'your-rule', reason: 'Your rule: Finder — usually kept' })
    expect(applyRules({ app: 'Claude', ocrText: 'a summary' }, mine('Claude', 'throwaway'))).toMatchObject({ lean: 'throwaway', rule: 'your-rule', reason: 'Your rule: Claude — usually throwaway' })
    // a built-in rule that knows the app from the window title is an app rule too
    expect(applyRules({ app: 'Brightloom', windowTitle: 'TalkWeaver preview' }, mine('Brightloom', 'keep'))).toMatchObject({ lean: 'keep', rule: 'your-rule' })
  })

  it('leans with the strength of the built-in app rules', () => {
    expect(applyRules({ app: 'Brightloom' }, mine('Brightloom', 'throwaway'))!.confidence).toBe(0.85)
    expect(applyRules({ app: 'Brightloom' }, mine('Brightloom', 'keep'))!.confidence).toBe(0.85)
  })

  it('does not silence a rule that fires on the text or the look', () => {
    // a chart (keep, from the text) still beats his throwaway rule: keep wins when both fit
    const chart = applyRules({ app: 'Brightloom', ocrText: 'Adoption 12% 25% 33% 48% 52% 61%' }, mine('Brightloom', 'throwaway'))
    expect(chart).toMatchObject({ lean: 'keep', rule: 'chart' })
    // a terminal recognised from the text alone, surer than nothing: his keep rule still wins as keep
    const shell = applyRules({ app: 'Brightloom', ocrText: 'Last login: Thu Oct 9 on ttys001\nzsh: command not found: pyhton' }, mine('Brightloom', 'keep'))
    expect(shell).toMatchObject({ lean: 'keep', rule: 'your-rule' })
    // with no keep rule in play the text rule is still there beside his throwaway rule (the surer one is reported)
    const both = applyRules({ app: 'Brightloom', ocrText: 'Wi-Fi Bluetooth Notifications Privacy & Security Screen Recording' }, mine('Brightloom', 'throwaway'))
    expect(both).toMatchObject({ lean: 'throwaway', rule: 'your-rule' })
    expect(applyRules({ app: 'Finder', ocrText: 'Favourites AirDrop Recents Applications Name Date Modified Size Kind report.pdf' }, mine('Finder', 'keep'))).toMatchObject({ lean: 'keep', rule: 'your-rule' })
  })

  it('a rule for another app changes nothing; a rule for "App not known" fits an empty name', () => {
    expect(applyRules({ app: 'Finder' }, mine('Brightloom', 'keep'))).toMatchObject({ rule: 'finder' })
    expect(applyRules({ app: '  ' }, mine('', 'throwaway'))).toMatchObject({ lean: 'throwaway', rule: 'your-rule', reason: 'Your rule: App not known — usually throwaway' })
  })

  it('the built-in rules in words, and the one that fires on an app name alone', () => {
    const all = builtInRules()
    expect(all.filter((r) => r.lean === 'keep').map((r) => r.title)).toEqual(['Claude or ChatGPT answer', 'Slides on screen', 'Looks like a chart'])
    expect(all.filter((r) => r.lean === 'throwaway').map((r) => r.title)).toEqual(['TalkWeaver, WriteFlex or SlideWell screen', 'Terminal window', 'System Settings window', 'Finder window'])
    expect(builtInForApp('talkweaver')).toBe('throwaway')
    expect(builtInForApp('Claude')).toBe('keep')
    expect(builtInForApp('Brightloom')).toBeNull()
    expect(builtInForApp('')).toBeNull()
  })
})

describe('sorter rules: ties and nothing', () => {
  it('no rule fits → null', () => {
    expect(applyRules({ ocrText: 'A photograph of a lake at dusk' })).toBeNull()
    expect(applyRules({})).toBeNull()
  })

  it('when a keep rule and a throwaway rule both fit, keep wins', () => {
    const v = applyRules({ app: 'Terminal', ocrText: 'Adoption 12% 25% 33% 48% 52% 61%' })
    expect(v?.lean).toBe('keep')
  })
})
