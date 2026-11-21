# UI preview

Runs the real `app/` in a desktop browser, so you can work on the interface without the TV.
Nothing in `app/` is changed or copied: the server serves the working tree as it is.

```bash
node tools/preview/server.js
```

Open http://127.0.0.1:8090/ in Chrome or Chromium. The 1920×1080 screen is scaled to fit the window.
Press `?` in the page to see the keys.

You need Node 18 or newer, plus ffmpeg for the still-image videos.

## Editing

- **CSS** (`app/css/*.css`): changes apply when you save, without a reload. You stay on the same screen with
  the same focus.
- **JS / HTML:** saving reloads the page. The app then starts the way it does on the TV, and may resume the
  last video.

## Keys

| Keyboard | Remote |
| --- | --- |
| Arrows, Enter | Arrows, OK |
| Backspace, Esc | BACK |
| Space / `p` / `s` | Play-pause / Play / Stop |
| `,` / `.` | Rewind / Fast forward |
| PageUp / PageDown | CH up / down |
| `r` `g` `y` `b` | Colour keys |

## What is real and what is not

- **Real:** all of the app's code, styles, fonts and layout. The catalog comes from F1 (Home, Schedule,
  Archive, Shows, a video's feed list). Standings come from the same public API the app uses.
- **Faked sign-in:** you're signed in as "Preview User". F1's catalog is fetched anonymously, so no account
  or token is ever involved.
- **Video:** a "video" is a still image of that video's key art, with silent English and German commentary.
  The app picks the player the same way it does on the TV. Videos with several feeds play on its Shaka
  player. Single-feed videos (highlights, documentaries) and multiviews play on a fake AVPlay that draws the
  key art and counts time like a playing video. The player bar, seeking, pause, the watch options panel,
  feed switching and dialogs all run the real code.
- **Multiview:** the preview stream lists HEVC feeds at F1's sizes, and the TV's "can you decode this size"
  check gets the QE55Q77A's answer, so the app offers the same layouts it offers there. The server answers
  the stream helper's multiview calls. The fake AVPlay draws each feed's key art in its cell of the layout,
  with a small tag (bottom right) naming the feed. Changing the layout or the feeds while playing goes
  through the helper's rearrange call, as on the TV.
- **Faked TV:** the browser acts as a 4K TV without HDR. HDR, 5.1 and live DRM can't be shown here.
- **Timing data (tower, lap counter, session clock, flags):** F1's timing archive needs the account's token, so
  the server rebuilds it from [OpenF1](https://openf1.org)'s public data (`openf1.js`), in the archive's own
  layout and line format: the app's timing worker reads it unchanged. That covers every session from 2023 on:
  positions, gaps, lap and sector times with their colours, tyres, pit stops, retirements, qualifying parts and
  knock-outs, safety cars, red and yellow flags. Times within a lap are spread from its sector times, so it is a
  close likeness, not F1's feed. 2018-2022 have no timing in the preview. The first load of a session takes a few
  seconds (OpenF1 allows 30 requests a minute); after that it comes from `local/preview-cache/timing/`.
- **Live timing:** the live feed (F1's SignalR, anonymous) goes through the preview server, which keeps the
  cookie F1 wants for the WebSocket. A live video gets real live timing, and between sessions the feed holds the
  last session's final state. A session that ended less than 30 minutes ago has no archive yet (as at F1), so
  the app follows the live feed for it.

## Address options

- `?signedout` shows the sign-in screen.
- `?fresh` forgets the app's saved settings and progress.
- `?noscale` shows the stage at 100%.
- `?noreload` turns off reloading on save.

## Server options

- `--port 8090`
- `--host 127.0.0.1` (use `0.0.0.0` to open it from another device)
- `--offline` uses only answers saved earlier (timing too: sessions opened before).

Answers from F1 and the generated streams are cached in `local/preview-cache/`, which is gitignored.
Delete it to start over.

## Recordings

A file in `local/preview-data/<host>/<path>` is used instead of the network, before anything else, for example
`local/preview-data/livetiming.formula1.com/static/2026/Index.json`. F1's own timing session goes there: the
season's `Index.json`, plus the session folder's `.jsonStream` files that the timing worker reads (`Heartbeat`,
`SessionInfo`, `LapCount`, `ExtrapolatedClock`, `SessionData`, `TrackStatus`, `DriverList`, `TimingAppData`,
`TimingData`). If a feed is missing from a recorded folder (for example `LapCount` outside races), the server
answers 403, as F1's storage does.

To record a session, fetch those files inside the signed-in app on the TV with DevTools attached
(`local/tools/cdp.js`). There, `F1Api.state.ascendon` is the bearer token for
`https://livetiming.formula1.com/static/`. The token is used only on the TV and never saved. The recordings
are gitignored.

## Differences from the TV

The TV's browser is Chromium 76 (Tizen 6). Desktop Chrome is newer, so CSS can work here and not on the TV.
Flexbox `gap` is one example: it arrived in Chrome 84. The app's code is written for Chromium 76 (no
optional chaining). Do the final check on the TV.
