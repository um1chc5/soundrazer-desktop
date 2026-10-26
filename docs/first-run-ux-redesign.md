# First-run setup: UX redesign request

The user's explicit request, verbatim: "the ui of firsttime should be main
ui, and it should list out what need to install for user and have progress
tracking install of each required package/app, after this done, user will
see normal app ui with two tabs."

## What exists today (as of commit eb2edc5)

- `#view-setup` in [index.html](../app/sound_razor/web/index.html) is a
  **separate view**, swapped in/out alongside `#view-new`/`#view-library`/
  `#view-song` by the same `show(name)` mechanism — i.e. it's bolted on as
  a sibling screen, not integrated as "the main UI for first run."
- `app.js`'s `state.setup?.required` gating (see `show()`, `renderSong()`,
  `renderSetupBanner()`) redirects the user to `#view-setup` and blocks the
  Separate/Library tabs until setup completes — the *blocking* logic is
  there, but the *visual framing* is "here's a separate setup page," not
  "this is the app, and it's walking you through getting ready."
- Per-stage status *does* already exist: `renderSetup()` in app.js renders
  each stage with a ✓/↓ `setup-status` icon (done vs missing) and shows a
  total size estimate — the "list what's needed" half of the request is
  there. **What's likely missing or broken is live per-item progress
  *during* the download/install** (right now there's one combined ring/
  progress-view for the whole multi-stage job — `renderProgress()` called
  with `job.kind === 'setup'` — not a per-package progress indicator).
- A real bug in this exact code path was just fixed (commit eb2edc5):
  `buildProgress()` was never called for `#setup-panel`, so the first
  real download attempt crashed with `Cannot set properties of null
  (setting 'textContent')` the moment progress rendering started. That's
  fixed. The redesign below is a separate, follow-up ask — don't assume
  the crash and the redesign are the same task.

## What to build

1. **Make first-run setup feel like the app itself, not a separate
   screen.** Keep the same app chrome (title bar, app bar) visible/
   consistent, and present the setup checklist + progress as the primary
   content area — effectively what `#view-setup` should become is less
   "a page you're sent to" and more "this is what Separate/Library look
   like until setup finishes." Concretely: consider merging `#view-setup`
   content into the layout `#view-new` already uses (same card system,
   same spacing) rather than a visually distinct screen, so the
   transition from "setup in progress" to "normal two-tab app" feels like
   content changing in place, not a screen swap.

2. **Per-component progress, not just one combined ring.** Each item in
   the stage list (`setup.stages` — runtime, FFmpeg, separation engine,
   optionally YouTube support, per
   [docs/first-run-setup-plan.md](first-run-setup-plan.md)) should show
   its *own* download/install progress as it happens (a small inline bar
   or percentage next to that row), not just a single shared ring for
   "the whole thing." The backend (`app/sound_razor/setup.py`) needs to
   be checked for whether it already reports *per-stage* progress
   (bytes/percent per item) through the job/state polling mechanism, or
   only an overall percentage — if it's only overall, that needs adding
   there too, not just in the frontend.

3. **Icon/color distinction per item is implemented already** (✓ green
   for done, ↓ accent color for missing, in `renderSetup()`) — keep that,
   just make sure it still reads correctly once each row also shows live
   progress (i.e. a row goes from "↓ missing" → "downloading, 43%" → "✓
   done", three states, not two).

4. **After the last required stage completes, the transition to the
   normal two-tab (Separate/Library) UI should be seamless** — no
   separate "click to continue" unless that's genuinely useful; the
   gating logic already in app.js (`state.setup?.required`) should just
   naturally stop blocking once the backend reports nothing missing, and
   whatever view the user would normally land on (Separate) should
   just... be there.

## Constraints / don't touch

- Don't touch `app/ui_entrypoint.py`'s `writable_dirs()`/`known_folder()`
  (the OneDrive-aware Documents path fix) or `app/launch.bat` / the NSIS
  shortcut changes (commit 046a1aa) — those are confirmed, hard-won fixes
  for a real crash-on-launch bug, unrelated to this redesign.
- Don't touch the `_install_dir()` fix in `setup.py` (`parents[1]`, not
  `parents[2]`) — already fixed, confirmed correct.
- Follow the existing design system (CSS custom properties in
  [styles.css](../app/sound_razor/web/styles.css), the `.progress-view`
  component family, the dark/orange + light theme already built) — don't
  introduce a new visual language for this screen.

## When done

Rebuild (`cd installer && makensis SoundRazer.nsis`), verify a **real**
first-run setup end to end on an actual Program Files install (not just
the dev preview — this exact code path has already broken once in ways
that only showed up on a real install), then publish as a new GitHub
release (`gh release create vX.Y.Z dist\SoundRazer-Setup-x64.exe --repo
um1chc5/soundrazer-desktop`).
