/**
 * An ipcMain.handle that answers only the windows `allowed` accepts (the main window). Any other
 * sender — the hidden picture-search window, a stray webContents — gets an error and the handler
 * never runs. Used by the Triage handlers; Review and the sorter have their own equivalent.
 */
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'

export function guardedHandle(
  ipc: Pick<IpcMain, 'handle'>,
  allowed: (sender: WebContents) => boolean,
  channel: string,
  fn: (e: IpcMainInvokeEvent, ...args: any[]) => unknown // eslint-disable-line @typescript-eslint/no-explicit-any
): void {
  ipc.handle(channel, (e, ...args) => {
    if (!allowed(e.sender)) throw new Error(`${channel}: not allowed from this window`)
    return fn(e, ...args)
  })
}
