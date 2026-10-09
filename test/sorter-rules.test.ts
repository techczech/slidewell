import { describe, it, expect } from 'vitest'
import { applyRules } from '../src/main/sorter/rules'

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

  it('TalkWeaver and WriteFlex screens', () => {
    expect(applyRules({ app: 'TalkWeaver', windowTitle: 'Metaphor talk' })).toMatchObject({ lean: 'keep', rule: 'own-apps', confidence: 0.85 })
    expect(applyRules({ app: 'Electron', windowTitle: 'WriteFlex — draft' })).toMatchObject({ lean: 'keep', rule: 'own-apps' })
    expect(applyRules({ ocrText: 'WriteFlex Collections Draft Outline' })).toMatchObject({ lean: 'keep', rule: 'own-apps' })
  })
})

describe('sorter rules: ties and nothing', () => {
  it('no rule fits → null', () => {
    expect(applyRules({ ocrText: 'A photograph of a lake at dusk' })).toBeNull()
    expect(applyRules({})).toBeNull()
  })

  it('when a keep rule and a throwaway rule both fit, keep wins', () => {
    const v = applyRules({ app: 'Terminal', ocrText: 'claude> TalkWeaver build finished error: none' })
    expect(v?.lean).toBe('keep')
  })
})
