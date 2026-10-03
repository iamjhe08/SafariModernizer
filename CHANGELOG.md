# Changelog

## 1.0.1 (2026-10-02)

- Install is now limited to iOS 15. On iOS 16, 1.0.0 made Safari crash on launch, so package managers will no longer offer it there. iOS 16 support may come later.
- Works in other browser apps too: iCab, Firefox, Chrome, Brave, Edge and DuckDuckGo
- iCab opens again (its own screen uses code Safari 15 can't read; the tweak now fixes it)
- Calendly booking pages load instead of staying white
- loadout.tf loads with its full layout and 3D view
- Scripts Safari 15 can't read are now fixed even when they come from another site or are very large, and the fixed copy runs once, at the right point in page loading
- Added support for: slots filled from code, offscreen canvas, site file storage (`navigator.storage`), and style sheets added with `adoptedStyleSheets.push()`
- The tweak's page log is also written to the phone's system log, for debugging browsers other than Safari

## 1.0.0 (2026-10-02)

First public release.

- Modern JavaScript and web features added to every page in Safari on iOS 15
- Modern CSS rewritten for Safari 15: cascade layers, nesting, `oklch()`, `color-mix()`, light/dark colors, `:has()`, `svh`/`dvh` units, anchor positioning, container queries
- Sites using import maps run through a built-in module loader, including webpack chunk loading (GitHub)
- Workarounds for Safari 15 security-policy bugs, limited to scripts the site itself approved
- Identifies as Safari 18.6, with a per-site switch back to Safari's real ID
- Per-site modes and a log panel (two-finger hold, or `#smdebug`)
- Freeze protection
- Packages for rootless, roothide and rootful jailbreaks
