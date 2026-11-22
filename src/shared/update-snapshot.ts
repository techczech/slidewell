import type { UpdateSnapshot as NoticeSnapshot } from '@app-patterns/updates'
import type { InPlaceRefusal, InstallPhase, RestartBlocker } from './update-install'
import type { UpdateFile } from './update-channels'

export interface UpdateSnapshot extends NoticeSnapshot {
  alpha: boolean
  install: InstallPhase
  file: UpdateFile | null
  refusal: InPlaceRefusal | null
  blockers: RestartBlocker[]
}
