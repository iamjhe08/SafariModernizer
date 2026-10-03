# SafariModernizer

A jailbreak tweak that makes today's websites work, and look modern, in Safari on **iOS 15**, and in some other browser apps (iCab, Firefox, Chrome, Brave, Edge, DuckDuckGo).

Many sites now use web features that only exist in newer Safari versions. On iOS 15 they load half-broken: blank pages, dead buttons, missing menus, wrong colors, or no styling at all. SafariModernizer fills in what's missing, right inside Safari, so those sites work again.

**Free and open source** under the [MIT License](LICENSE).

## What it fixes

- **Missing JavaScript and web features:** adds them to every page (newer array and object methods, popovers, dialogs, invoker buttons, compression streams and more).
- **Modern CSS:** rewrites newer styles into ones Safari 15 understands, including cascade layers, nesting, `oklch()` and `color-mix()` colors, light/dark colors, `:has()`, viewport units (`svh`, `dvh`), anchor-positioned menus and container queries.
- **Import maps:** runs sites built on JavaScript modules with import maps (GitHub, for example), which Safari 15 can't load on its own.
- **Safari 15 security-policy bugs:** Safari 15 wrongly refuses some scripts that sites have approved. The tweak runs exactly those approved scripts, nothing else. If a site's own rules also block a script, it stays blocked.
- **Browser ID:** tells sites it is Safari 18.6, so they send their modern pages. You can switch any site back to Safari's real ID.
- **Freeze protection:** if one of the tweak's own steps ever freezes a page, that site switches to a lighter mode on the next load.

Tested on: Google, Gemini, YouTube, ChatGPT, GitHub and Reddit.

## Requirements

- iOS 15.0 to 15.8, jailbroken (it will not install on iOS 16 or newer: it crashed Safari there, see the Known limits)
- Works on all 64-bit iPhones and iPads (arm64 and arm64e)

## Install

Download the package for your jailbreak from the [Releases](../../releases) page:

| Your jailbreak | File to install |
|---|---|
| Rootless (Dopamine, palera1n rootless) | `..._iphoneos-arm64.deb` |
| Roothide (Dopamine roothide) | `..._iphoneos-arm64e.deb` |
| Rootful (checkra1n, palera1n rootful) | `..._iphoneos-arm.deb` |

Open the file with your package manager (Sileo, Zebra or Filza), install it, then respring.

## Using it

It works automatically; there's nothing to set up.

To see what it's doing on a page, or change settings for that site:

- Hold **two fingers** still on the page for **2 seconds**, or
- add `#smdebug` to the end of the page address.

The panel shows a log of fixes and errors, plus two settings for the current site:

- **This site:** Full (all fixes), Light, Lighter, Basic, or Off. Use a lighter mode if a site misbehaves.
- **Browser ID:** Modern (Safari 18.6) or Real (Safari's own). Some sites, like YouTube, work better with Real.

The **Copy** button copies the log, which is handy for bug reports.

## Known limits

- iOS 16 and newer are not supported yet. Version 1.0.0 crashed Safari on iOS 16, so from 1.0.1 the package only installs on iOS 15. If you are on iOS 16 and have 1.0.0 installed, remove it in your package manager.
- Some sign-in pages (for example "Continue with Google" on other sites) use anti-bot checks that don't pass on iOS 15. The tweak does not try to get around them. Use another sign-in method on those sites.
- Very heavy web apps can load slower than on a newer iPhone.

## Reporting a problem

Open an [issue](../../issues) with:

1. The page address
2. What you expected and what happened
3. The log from the panel (tap **Copy**)
4. Your iOS version and jailbreak

## Building from source

You need a Mac or Linux computer with:

- [Node.js](https://nodejs.org) 18 or newer
- Python 3
- [Theos](https://theos.dev/docs/installation), with a toolchain that can build arm64e for iOS 14+ (LLVM 16 or newer)
- `dpkg-deb` and `rsync`

Then run:

```sh
export THEOS=~/theos
./build.sh
```

The packages land in `tweak/packages/`.

### Project layout

| Folder | What's in it |
|---|---|
| `tweak/` | The tweak itself (`Tweak.x`): adds the page scripts to Safari, fetches and caches files, runs the freeze watchdog and stores per-site settings |
| `web/` | The page scripts: polyfills (`build.mjs`, `extras.js`, `shims.js`, `entries/`) and the fixes (`main.js` and the modules it loads) |
| `tests/` | Automated tests that run the page scripts in a simulated browser (`npm test` in `web/`) |

## Credits

Made by **T4MAG0**.

Inspired by [Polyfills](https://github.com/PoomSmart/Polyfills) by [PoomSmart](https://github.com/PoomSmart), which showed how much older Safari can do with the right fixes. Thanks to PoomSmart for the inspiration, and for bringing parts of SafariModernizer into Polyfills.

Built on many open-source projects. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); their full license texts are in [THIRD_PARTY_LICENSES.txt](THIRD_PARTY_LICENSES.txt) and are installed with the tweak.
