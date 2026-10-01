# SlideWell Raycast commands

Keep a screenshot the moment you take it, so there is nothing to triage later. Each command copies
the file into the well's inbox (`~/SlideWell/well/_inbox/`, or `<wellRoot>/_inbox` if you moved the
well). SlideWell picks it up immediately if it is running, otherwise on next launch. Then it
OCRs the image and, if a local vision model is running, adds a description (Settings → Screenshot
descriptions).

| Command | What it keeps |
|---|---|
| **Keep Last Screenshot** | The newest image or recording in your screenshot folder. Type a number to keep the last N. |
| **Keep Clipboard Image** | The image on the clipboard (e.g. after CleanShot's *Copy*). |

## Set up

1. Raycast → Settings → Extensions → **+** → *Add Script Directory* → choose this `raycast/` folder.
2. Give **Keep Last Screenshot** a hotkey (e.g. ⌃⌥K) so keeping is one keystroke after CleanShot.

The screenshot folder is, in order: `$SLIDEWELL_SCREENSHOT_DIR`, SlideWell's *Triage source folder*,
the macOS screenshot location (`defaults read com.apple.screencapture location`), then `~/Desktop`.
If CleanShot saves somewhere else, set that folder as the Triage source folder in SlideWell.

A screenshot kept this way is also recorded as *in the well* for Triage, so a later Triage pass over
the same folder won't offer it again.
