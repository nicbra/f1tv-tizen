# F1 TV for Samsung Tizen

Unofficial F1 TV app for Samsung Smart TVs that have no F1 TV app in their store. Developed
and tested on a QE55Q77A (2021, Tizen 6.0).

Not affiliated with Formula 1, F1 TV or Formula One Licensing BV. You need your own F1 TV subscription. Video is
decrypted by the TV's own Widevine DRM with a license from F1 TV, the same way the official apps
do it; this app does not break or bypass any DRM.
I have shamelessly added the F1 logo in the app.

## Screenshots
| | |
| --- | --- |
| ![Home](docs/screenshots/home.jpg) | ![A race weekend's broadcasts](docs/screenshots/weekend.jpg) |
| ![The timing tower, seeking with lap info](docs/screenshots/player.jpg) | ![Watch options: timing, commentary and feeds](docs/screenshots/panel.jpg) |
| ![Season calendar](docs/screenshots/schedule.png) | ![Standings](docs/screenshots/standings.png) |
| ![Championship battle](docs/screenshots/battle.png) | ![Driver page](docs/screenshots/driver.png) |


## Install

You need a computer (Windows, Mac or Linux) on the same network as the TV, for about five minutes.
Nothing else needs to be installed.

**1. Put the TV in Developer Mode** (once):

1. Find your computer's IP address. The installer in step 2 can help you with that.
2. On the TV, open **Apps** and press `1` `2` `3` `4` `5` on the remote (or the on-screen keypad).
3. Switch **Developer mode** to **On**, enter your computer's IP address as **Host PC IP**, and
   press OK.
4. Restart the TV: hold the remote's power button until the TV turns off and on again.

**2. Run the installer** on the computer:

- **Linux or Mac:** open Terminal and paste:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/nicbra/f1tv-tizen/HEAD/scripts/install.sh | bash
  ```

- **Windows:** open PowerShell (Start menu → type `PowerShell`) and paste:

  ```powershell
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://raw.githubusercontent.com/nicbra/f1tv-tizen/HEAD/scripts/install.ps1 | iex
  ```

The installer finds the TV on your network, checks that Developer Mode points at your computer,
downloads Samsung's `sdb` tool (from Samsung's Tizen site) and the latest release of the app (from
this repository's releases), checks both against SHA-256 sums, installs the app and starts it. It
keeps its downloads in `%LOCALAPPDATA%\f1tv-tizen` or `~/.cache/f1tv-tizen` and changes nothing
else on your computer.

**3. Sign in:** see [Signing in](#signing-in).

### Updating

The app tells you when a new version is out (and shows it under your name -> About). Choose
**Check for updates now** there to check GitHub immediately, even if automatic update checks
are off. To update, run the same installer command again. The TV stays signed in.

### If something goes wrong

- *No TV found / the TV didn't accept the connection:* Developer Mode must be on, its Host PC IP
  must be this computer's current address, and the TV must have been restarted after changing it.
  You can also give the TV's address directly: `… | bash -s -- 192.168.1.50` on Mac/Linux, or
  download `install.ps1` and run `powershell -ExecutionPolicy Bypass -File install.ps1 -Tv 192.168.1.50`.
- *"This TV only accepts apps signed with a Samsung certificate":* some newer TVs refuse apps
  that aren't signed with a Samsung certificate made for that particular TV
  (error `[118, -12]`). Then the release package can't be used; see
  [Building it yourself](#building-it-yourself) and create a Samsung certificate in Tizen Studio's
  Certificate Manager instead of the plain Tizen one.
- *Apple Silicon Mac:* Samsung's `sdb` tool is Intel-only. The installer tells you how to install
  Rosetta if it's missing.
- Apps installed in Developer Mode can expire after a while on some TVs. Running the installer
  again reinstalls the app: add `-s -- --force` after `bash` (Mac/Linux), or run the downloaded
  `install.ps1` with `-Force` (Windows).

## Signing in

Open the app, scan the QR code (or go to `f1tv.formula1.com/tv`) and confirm the code. If F1's
login page shows `NoSuchKey`, your browser language has no F1 login page; use
`https://account.formula1.com/#/en/login?redirect=https%3A%2F%2Ff1tv.formula1.com%2Ftv` instead.

The TV appears as an Android tablet in your F1 account's device list (the official TV app builds
aren't public, so the app uses the Android tablet profile). Removing it there signs the TV out.

## Features

- Sign in by code: the TV shows a code and a QR code, you confirm it on your phone at
  `f1tv.formula1.com/tv`. No passwords are typed or stored on the TV, and the TV renews its
  session on its own.
- Browse F1 TV's own pages (home, archive, shows, documentaries, my list) as rails.
- "This weekend" rail and a Schedule tab: the season calendar and every broadcast of a race
  weekend (sessions, pre/post shows, F1 Academy) in local time, with live and countdown badges.
- Live sessions and replays, including the extra feeds (onboard cameras, F1 Live, tracker, data).
- Video seeking that shows the lap number and the real clock time, before jumping in the video.
- Watch options panel: pick a feed (onboards), turn the timing overlay on or off,
  choose commentary (English, German, French, Dutch, Portuguese, Japanese, or
  track sound only) and subtitles (F1's own captions, also live).
- Live timing: a timing tower (positions, gaps or best laps, tyres, track status) and lap or
  session info ("Lap 34/56", "Q2 · 07:12 left") above the time in the seeker.
  The gap times are shown with 3 decimals, that F1TV for some reason removed from their feed.
- Resume where you left off, synced with F1 TV's other apps.
- Spoiler-free mode (Settings, under your name): blurs artwork of replays and highlights.
- Standings: drivers' and constructors' championships, and a page per driver with headshot,
  season stats (wins, podiums, poles, fastest laps, best/average finish, DNFs), a points-per-round
  chart and every race result.
- Championship battle: cumulative points round by round for the top 6 drivers or constructors.

## How it works

- `app/` is a Tizen web app in plain ES5-style JavaScript, because Tizen 6.0's engine is Chromium 76.
- `js/api.js` talks to the F1 TV API (`f1tv.formula1.com`).
- `js/auth.js` does the pairing ("rendezvous") flow against F1's account API
  (`GenerateDeviceRendezvousCode` -> confirm on the web -> `RetrieveDeviceRendezvousStatus` ->
  `authenticate/by-device`). The device key is kept in the app's local storage.
- `js/player.js` has two engines:
  - **AVPlay** (Samsung's native player) for F1's encrypted streams. They are CBCS-encrypted, and
    the 2021 TV's browser engine can't decrypt CBCS video (it shows noise), but AVPlay can.
  - **Shaka Player** for unencrypted streams (most replays and archive content).
- `js/timing.js` + `js/timing-worker.js` load the session from F1's timing archive
  (`livetiming.formula1.com/static`, authorised with the F1 TV token) in a Web Worker. F1's video
  timeline counts real (Unix) time, so every position maps to a moment in the timing data. During
  live sessions the worker polls the feeds with HTTP range requests.
- `service/service.js` is a small background Node.js service that runs on the TV. F1's live audio
  segments contain a `senc` box that claims 0 samples, which AVPlay rejects. The service serves the
  manifest, routes only the audio segments through itself and sets the sample count to the real
  value. Video segments go straight to F1's CDN. Nothing is decrypted or re-encoded.

## Building it yourself

For developers, or for TVs that need their own Samsung certificate.

1. Put the TV in Developer Mode as described under [Install](#install).
2. Install the Tizen Studio CLI (`web-cli` installer from download.tizen.org) to `~/tizen-studio`.
3. `scripts/deploy.sh cert` creates a signing certificate (a plain Tizen developer certificate is
   enough for a 2021 TV; newer TVs may need a Samsung certificate for that TV, made in Tizen
   Studio's Certificate Manager with the Samsung Certificate Extension, saved as profile `f1tv`).
4. `TV_IP=<tv address> scripts/deploy.sh` builds, installs and launches the app.

A personal app icon can be put in `local/icon.png` (git-ignored); `deploy.sh` uses it instead of
`app/img/icon.png`, and `local/logo.png` replaces `app/img/logo.png`. Release builds never include
`local/`.

A TV only accepts an update signed with the same certificate as the installed app. Switching
between your own builds and the release packages means removing the app first (the installer
offers to), which signs the TV out.

## Releasing

Releases are built and signed by GitHub Actions on a standard Ubuntu runner. Set these repository
secrets under **Settings → Secrets and variables → Actions** once:

| Secret | Value |
| --- | --- |
| `TIZEN_AUTHOR_CERT_BASE64` | Base64-encoded contents of `~/tizen-studio-data/keystore/author/f1tv-author.p12` |
| `TIZEN_AUTHOR_PASSWORD` | Contents of `.cert-password` |

No personal access token is needed; the workflow uses GitHub's built-in token. The SDK's bundled
distributor certificate is used, matching the local `f1tv` profile created by `deploy.sh cert`.

After committing and pushing the changes you want to release, create and push a version tag:

```sh
git tag v0.2.0
git push origin v0.2.0
```

Pushing the tag starts the **Build release** workflow. It runs tests, installs the pinned Tizen
CLI, takes the app version from the tag (`v0.2.0` becomes `0.2.0`), and builds and signs `F1TV.wgt`
and its checksum `F1TV.wgt.sha256`. There is no release preparation script or version commit.
The checked-in `app/config.xml` uses `0.0.0` for development; only the temporary packaging copy
gets the tag's version. The installed app reads its version from that packaged manifest.
All other app files come from the tag; personal overrides in `local/` and uncommitted files are
excluded. Merge the installer scripts into the repository's default branch before the first release,
since the install commands above download them from that branch.

Open the **draft release** on GitHub, download `F1TV.wgt`, and test that exact package on your TV.
Then publish the draft; the installers and in-app update checker will pick up the published release.
Re-running a failed workflow replaces assets only on a draft, never on an already published release.
You can also select **Actions → Build release → Run workflow** and enter an existing tag to retry
(the workflow must be present on the repository's default branch for the manual button to appear).

To build an existing release tag locally with your configured signing profile:

```sh
scripts/build-release.sh v0.2.0
```

This writes `build/F1TV.wgt` and `build/F1TV.wgt.sha256` without publishing anything.

Every release must be signed with the same author certificate, or people's TVs refuse the update.
Back up `~/tizen-studio-data/keystore/author/f1tv-author.p12` and `.cert-password`.

## Credits

- [Shaka Player](https://github.com/shaka-project/shaka-player) (Apache-2.0) and
  [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), bundled in `app/vendor/`.
- F1 TV API request shapes from [eXhumer/f1tv-api](https://github.com/eXhumer/f1tv-api) and
  [npanu420/F1OpenViewer](https://github.com/npanu420/F1OpenViewer).
- The background-service approach follows [TizenBrew](https://github.com/reisxd/TizenBrew).
- Standings and results from [jolpica-f1](https://github.com/jolpica/jolpica-f1) (Ergast-compatible API);
  headshots and team colours from F1's timing data.
- [Ubuntu font](https://design.ubuntu.com/font) under the Ubuntu Font Licence 1.0 (`app/fonts/LICENCE.txt`).
