# 02 — Exercise capture-folder refusal through the app

**What to build.** Give the existing capture-folder spec an npm script. In its disposable hidden app, choose symlink aliases of the synthetic well and archive through the Add folder picker. Verify the warning and that the watched folder list is unchanged. The existing valid add, move and stop steps must still pass.

**Defect and evidence.** The capture-folder refusal is currently checked with a fake IPC registrar and a shared Settings store test. The hidden journey covers missing folders and replacement but does not exercise the refusal through the real preload, app handler and persisted settings. It is the only top-level E2E spec without an npm entry.

**Feature / journey.** `capture-inbox`. Add a capture source and get a clear explanation when it is SlideWell’s storage.

**Design.** Retain the folder policy from PR 26. Stub native pickers and warning dialogs in the hidden process.

**Blocked by.** None.

**Seams under test.** Hidden Electron, the actual preload and Settings write path, directory symlinks in disposable scratch.

- [ ] `npm run test:capture-folders` builds and runs the existing spec.
- [ ] Both refusals return false, show the expected warning and leave watched folders unchanged after restart.
- [ ] A valid folder is still accepted and the existing recovery assertions pass.

**Status.** Ready.
