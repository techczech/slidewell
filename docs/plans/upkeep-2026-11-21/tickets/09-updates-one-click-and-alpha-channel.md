---
title: SlideWell one-click updates and opt-in alpha channel
register: FOR AGENTS
---

# 09 — Update SlideWell in place with one click

**What to build.** Keep the quiet update notice and daily check from ticket 08. Selecting **Update** downloads the selected macOS release, verifies it, replaces SlideWell in its installed location and restarts into the new version. The click is the authorisation for download and installation. No launch, background check, Settings change, or ordinary quit starts or completes an update by itself.

**Feature / journey.** `update-notices`. See a release, choose Update, watch progress, and return to the same profile in the updated app. In Settings, **Get early versions (alpha)** is off by default. Turning it on allows later alphas to be offered. Turning it off never downgrades an installed alpha.

**Design and reference.** Follow TalkWeaver [ADR-0044, decided 15 November 2026](https://github.com/techczech/talk-weaver/blob/main/_ADR/0044-in-place-updates.md). Reuse `@app-patterns/updates` for the existing check and notice. Follow TalkWeaver’s selection and installer verification in its app integration, including safe cancellation and its explicit restart gate. Apply SlideWell’s own work and write lifecycle when deciding whether restart is safe.

**Feed.** The canonical address is [SlideWell updates.json](https://techczech.github.io/slidewell/updates.json). It returned HTTP 404 on 21 November 2026 and will need publication. Retain the schema-1 `latest` release entry for older clients. Add release and alpha channels and validated macOS update assets after the corresponding GitHub builds exist. Publish alphas as GitHub prereleases. Notarise public releases and public alphas.

**Blocked by.** 08, update notices. End-to-end publication proof also needs the published feed and matching release assets.

**Seams under test.** Feed validation and channel selection, explicit Update action, signed-asset verification, restart gate and installed-profile continuity.

- [ ] A daily or manual check makes the feed request without starting an installer or asset download.
- [ ] One Update click on a supported installation downloads and verifies the advertised asset and upgrades in place. In-use work and failed writes prevent an unsafe restart.
- [ ] Invalid metadata, a wrong asset or signature, a cancelled attempt and a later ordinary quit leave the installed version and profile intact.
- [ ] Release is the default channel. Alpha is opt-in. Both channels offer strictly newer eligible versions, including semantic ordering within alpha.
- [ ] A disposable signed app copy upgrades in place and restarts against its own fixture profile. Public release verification confirms notarisation and feed-to-asset agreement.

**Status.** Planned follow-up.
