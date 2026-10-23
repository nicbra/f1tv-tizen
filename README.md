# F1 TV for Samsung Tizen

Unofficial F1 TV app for Samsung Smart TVs that have no F1 TV app in their store. Developed
and tested on a QE55Q77A (2021, Tizen 6.0).

Not affiliated with Formula 1, F1 TV or Formula One Licensing BV. You need your own F1 TV
subscription. Video is decrypted by the TV's own Widevine DRM with a license from F1 TV, the same
way the official apps do it; this app does not break or bypass any DRM.

## Features

- Sign in by code: the TV shows a code and a QR code, you confirm it on your phone at
  `f1tv.formula1.com/tv`. No passwords are typed or stored on the TV, and the TV renews its
  session on its own.
- Browse F1 TV's own pages (home, archive, shows, documentaries, my list) as rails.
- "This weekend" rail and a Schedule tab: the season calendar and every broadcast of a race
  weekend (sessions, pre/post shows, F1 Academy) in local time, with live and countdown badges.
- Live sessions and replays, including the extra feeds (onboard cameras, F1 Live, tracker, data).
  Live sessions can be joined live or from the start of the broadcast.
- YouTube-style seeking: the arrows move a preview marker (steps grow while you keep pressing) that
  shows the position and the real clock time; it jumps on OK or after a short pause.
- Switching feed (▲ ▼ or CH +/-) continues at the same moment of the session.

## Remote

| Key | Browse | Player |
| --- | --- | --- |
| Arrows | move | ◀ ▶ preview a jump, ▲ ▼ switch feed |
| OK | open | jump to the previewed time, otherwise pause / play |
| ⏪ ⏩ | | preview jumps of 60 s |
| CH +/- | | switch feed |
| Back | back / exit | stop |

## How it works

- `app/` is a Tizen web app in plain ES5-style JavaScript, because Tizen 6.0's engine is Chromium 76.
- `js/api.js` talks to the F1 TV API (`f1tv.formula1.com`). The play API refuses requests
  without an `x-f1-device-info` header, so the app sends one describing the TV's web engine.
- `js/auth.js` does the pairing ("rendezvous") flow against F1's account API
  (`GenerateDeviceRendezvousCode` → confirm on the web → `RetrieveDeviceRendezvousStatus` →
  `authenticate/by-device`). The device key is kept in the app's local storage.
- `js/player.js` has two engines:
  - **AVPlay** (Samsung's native player) for F1's encrypted streams. They are CBCS-encrypted, and
    the 2021 TV's browser engine can't decrypt CBCS video (it shows noise), but AVPlay can.
  - **Shaka Player** for unencrypted streams (most replays and archive content).
- `service/service.js` is a small background Node.js service that runs on the TV. F1's live audio
  segments contain a `senc` box that claims 0 samples, which AVPlay rejects. The service serves the
  manifest, routes only the audio segments through itself and sets the sample count to the real
  value. Video segments go straight to F1's CDN. Nothing is decrypted or re-encoded.

## Setup

1. On the TV: open **Apps**, press `1 2 3 4 5`, switch **Developer mode** on, set **Host PC IP**
   to your computer's address, then restart the TV (hold the power button).
2. Install the Tizen Studio CLI (`web-cli` installer from download.tizen.org) to `~/tizen-studio`.
3. `scripts/deploy.sh cert` creates a signing certificate (a normal Tizen developer certificate is
   enough for a 2021 TV).
4. `TV_IP=<tv address> scripts/deploy.sh` builds, installs and launches the app.

Apps installed in developer mode can expire after a while; run `scripts/deploy.sh install` again
if it disappears.

### Signing in

Open the app, scan the QR code (or go to `f1tv.formula1.com/tv`) and confirm the code. If F1's
login page shows `NoSuchKey`, your browser language has no F1 login page; use
`https://account.formula1.com/#/en/login?redirect=https%3A%2F%2Ff1tv.formula1.com%2Ftv` instead.

The TV appears as an Android tablet in your F1 account's device list (the official TV app builds
aren't public, so the app uses the Android tablet profile). Removing it there signs the TV out.

## Credits

- [Shaka Player](https://github.com/shaka-project/shaka-player) (Apache-2.0) and
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), bundled in `app/vendor/`.
- F1 TV API request shapes from [eXhumer/f1tv-api](https://github.com/eXhumer/f1tv-api) and
  [npanu420/F1OpenViewer](https://github.com/npanu420/F1OpenViewer).
- The background-service approach follows [TizenBrew](https://github.com/reisxd/TizenBrew).
