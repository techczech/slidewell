# 08 — SlideWell tells you when a newer version exists

**What to build:** Element 17 (Update notices) of the shared app design elements, as the roadmap item decided: a daily check, on by default, of a small `updates.json` on SlideWell's site (sending nothing but the request); a status-bar mark with Download / Not now / Skip this version; Check for Updates… in the app menu, the command palette and a Settings › About and updates section; a What's new mark after an update. The click opens the download page; nothing downloads or installs by itself.

**Decided item and evidence:** `_DTC/slidewell/roadmap/update-notices.md` (fate: planned; plan: adopt element 17). SlideWell's public builds are on GitHub releases, signed and notarised; there is no update check today. TalkWeaver ships the same element and is the reference implementation.

**Feature / journey:** `update-notices` (roadmap); journey: open SlideWell → see a newer version → open its download page.
**Design:** the `app-design-elements` skill, element 17, including its drawn states; TalkWeaver's implementation for wording and behaviour. Use the shared App Patterns commands/settings for the menu item and the setting.
**Blocked by:** 01.
**Seams under test:** the version comparison and the "skip this version" state as a pure module; the check with a fake fetch.

**Real-path test that proves it:** unit tests: newer, same, older, pre-release ordering (0.4.0-alpha.19 < 0.4.0), skipped version stays quiet, network error stays quiet. One hidden-Electron run against a local `updates.json` served from a temp folder shows the status-bar mark (screenshot in the pull request).

- [ ] Check runs at most daily and on Check for Updates…; nothing but the GET is sent.
- [ ] Download opens the release page in the browser; no automatic download or install.
- [ ] The setting appears in Settings and the command in the menu and palette.
- [ ] `updates.json` format matches TalkWeaver's, and the pull request names where SlideWell's copy must be published (publishing it is not part of this ticket).

**May touch:** new main and renderer modules, `src/shared/commands.ts`, `src/shared/settings-schema.ts`, the status bar component.
**Must not touch:** packaging, signing, the website repository, any other network call.
**Boundary:** none (outbound GET of a public file only) → normal review.
**Status:** ready
