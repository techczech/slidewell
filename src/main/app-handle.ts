import type { IpcMainInvokeEvent } from 'electron'

export type AppHandle = (channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown) => void // eslint-disable-line @typescript-eslint/no-explicit-any
