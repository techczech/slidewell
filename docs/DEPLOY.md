# Deploying the website (Cloudflare Pages → talkweaver.app/slidewell)

The site is a single static page in `docs/` (mirrors the Highlight Scout setup).
Hosted on **Cloudflare Pages**; downloads link to the GitHub **Releases**
(built by `.github/workflows/release.yml`) — the two are independent.

## Before you deploy
- **Add a screenshot** at `docs/screenshots/home.png` that you're happy to make
  public (the hero hides itself if the file is missing). Avoid real client slides.
- **Cut a release first** so the Download buttons resolve: `git tag v0.1.0 && git push --tags`,
  then publish the draft Release the workflow creates.
- The app is **not notarised** (no paid Apple Developer ID) — the page already
  tells users to right-click → Open. Don't announce widely until the bundled
  build (Phase 2) actually works on a machine without your archive engine.

## The URL: `talkweaver.app/slidewell` is a sub-PATH
Cloudflare Pages custom domains map a whole **hostname**, not a sub-path, so there
are three ways to get `talkweaver.app/slidewell`:

1. **Put the page inside the talkweaver.app project** (cleanest if talkweaver.app is
   already a Pages site): copy this `docs/` into that repo at `slidewell/` so it
   serves at `/slidewell`. The page is self-contained, so it's a drop-in.
2. **A subdomain instead** — `slidewell.talkweaver.app`: create a Pages project from
   this repo (output dir `docs`) and attach `slidewell.talkweaver.app` as a custom
   domain. One step, no path juggling. (Recommended if talkweaver.app's setup is unknown.)
3. **A Cloudflare redirect/Worker route** mapping `talkweaver.app/slidewell/*` to a
   standalone Pages project. More moving parts.

## Standalone Pages project (options 2/3)
```bash
# one-time
npx wrangler pages project create slidewell --production-branch main
# deploy the static folder
npx wrangler pages deploy docs --project-name slidewell
```
Then attach the custom domain (`slidewell.talkweaver.app`, or wire the `/slidewell`
path) in the Cloudflare dashboard. Pushes to `main` auto-publish once Git is connected.
