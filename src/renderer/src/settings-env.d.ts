import type { SettingsBridge } from '@bridle/settings-electron'

declare global {
  interface Window {
    /** Only in the Settings window (preload/settings.ts). */
    bridleSettings: SettingsBridge
  }
}

export {}
