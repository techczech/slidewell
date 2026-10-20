// Preload of the shared Settings window. Bundled with the app (a sandboxed preload cannot load packages).
// It carries the shared settings bridge (window.bridleSettings) and the app's own bridge (window.sw), which
// the app's custom pages use; main answers those only from the main window and this window (fromAppWindow).
import { exposeSettingsBridge } from '@bridle/settings-electron/preload'
import './index'

exposeSettingsBridge()
