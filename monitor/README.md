# F1 TV monitor

Runs the app's own code against F1's live services on a schedule, and sends a message to your
phone when something the app depends on stops working, and again when it works again. Meant for
an always-on machine at home, such as a NUC, in Docker.

It checks:

- **without signing in:** the API config, the menu, the season calendar, the weekend schedule,
  video details and onboard feeds, the links from pre-shows to sessions to post-shows, the
  standings from jolpica, and F1's live timing connection;
- **signed in:** renewing the sign-in, HLS or DASH playback on the TV platform, that every
  broadcast feed and an onboard of the latest replay play, the manifest's
  clock (including HLS program date-times), Premium HLG HDR resolution and its match to the SDR
  clock, the audio fix on encrypted DASH (during live broadcasts while replays are clear HLS),
  the latest timing archive session and Race/Sprint start, driver headshots and colours, and,
  while something is live, the live stream and time-shifting;
- **what F1 offers (changes):** device stream types, enabled platforms, video fields, feeds and
  playback offset versions. Reports anything new F1 starts offering, or removes, once, then
  saves the new baseline in `DATA_DIR/offer.json` so the next unchanged run passes again.

The schedule check always uses the current weekend. Replay checks use its latest completed F1
session, or the latest available session from an earlier weekend if nothing has aired yet.
The **replay selection** result names the session and meeting being tested.

## Set up

On the NUC, with Docker and Docker Compose installed:

```sh
git clone https://github.com/nicbra/f1tv-tizen
cd f1tv-tizen
```

1. **Choose where messages go.** Easiest is [ntfy](https://ntfy.sh): install the ntfy app on your
   phone and subscribe to a topic with a long random name (anyone who knows the name can read
   it). Then set `NOTIFY_URL` in `monitor/compose.yaml` to `https://ntfy.sh/<that topic>`.
   A Discord webhook URL works too.

2. **Sign the NUC in** (once). It shows a code; confirm it on your phone as for the TV:

   ```sh
   docker compose -f monitor/compose.yaml run --rm f1tv-monitor pair
   ```

   The NUC appears in your F1 account's device list as an Android tablet, separate from the TV.
   The sign-in is kept in the container's Docker volume, never in the repository.

3. **Start it:**

   ```sh
   docker compose -f monitor/compose.yaml up -d --build
   ```

   The first run sends a message with every result, so you know messages arrive. After that you
   only hear from it when the set of failing checks changes. It checks every 6 hours
   (`CHECK_EVERY`); a check that fails because of a rate limit or a network error is retried once
   a minute later before it counts.

## Use

```sh
docker compose -f monitor/compose.yaml logs -f                 # the results of each run
docker compose -f monitor/compose.yaml run --rm f1tv-monitor check   # run once now
git pull && docker compose -f monitor/compose.yaml up -d --build  # update to the app's latest code
```

Set `NOTIFY_ON: always` in `monitor/compose.yaml` to get a message after every run instead of
only on changes.

Without Docker, Node.js 18 or newer runs it directly: `node monitor/check.js pair`, then
`NOTIFY_URL=… node monitor/check.js loop`. The sign-in is then kept in `monitor/data/`.

Removing the NUC from your F1 account's devices stops the signed-in checks; run `pair` again to
add it back.

## Diagnostic files

Every check run also appends JSON Lines to `/data/logs/YYYY-MM-DD.jsonl` in the Docker data
volume (`DATA_DIR/logs/` when running directly). Files use UTC dates, survive container rebuilds,
and are kept for 14 days. Set `LOG_KEEP_DAYS` to change that. Each console report prints the
file path; each record has a `runId` to distinguish scheduled and manual runs.

Files include the selected replay's content ID and meeting, check attempts, retries, errors and
stacks, request URLs, device headers, HTTP statuses and timings, redacted PLAY responses,
HLS encryption methods/key formats and HLG resolutions, DASH protection types, and the previous
and current offer snapshots. A `http.start` without a matching response or error shows where a
request stopped making progress. Account tokens and signed URL query values are redacted;
manifest summaries omit key URIs, PSSH payloads and segment URLs.

Read or copy a day's diagnostics on the NUC:

```sh
docker compose -f monitor/compose.yaml exec -T f1tv-monitor cat /data/logs/2026-10-31.jsonl
docker compose -f monitor/compose.yaml cp f1tv-monitor:/data/logs/2026-10-31.jsonl ./monitor-debug.jsonl
```

For an HDR fallback, find `http.response` records in the `4K HDR (Premium)` check with
`device=tvos;`, then any manifest summary and the `hdr.result` record. They show whether F1
offered SDR, an HDR response with a licence URL, or a playlist with encryption keys. The final
`hdr.result` names the stream the app actually selected. An `HDR_…` stream type alone doesn't
establish that the app can play it: supported CBCS offers are also checked through the app's native DASH converter. Unsupported encryption still fails this check.
These are API and manifest checks; the monitor does not decode video or acquire DRM licences.
