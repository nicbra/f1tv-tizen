# What the app sends

<!-- The app shows this file under "Read more" in the diagnostics question, and the README links to it. Keep it in
step with app/js/diag-upload.js and the server's contract. Plain Markdown only: headings, paragraphs, lists, **bold**,
`code` and links (see app/js/markdown.js). -->

The app is made and tested on one TV. Diagnostics show how it works on other TV models, so problems there can be
found and fixed.

## Crash reports

Crash reports are always sent, but contain limited information that may not uncover bugs that doesn't crash the app.
When the app crashes, a script fails or an app update doesn't start, the app sends a short crash report, whether
diagnostics are on or off:

- the app version, the TV model, firmware and Tizen version
- what failed: the script file and line (never the error message), or the update's version and why it didn't start
- how many times it happened

A crash report has no ID, so nothing links it to your TV or to other reports. That is also why it can't be deleted
on request. Crash reports are deleted from the server after 30 days.

## Diagnostics

Diagnostics are only sent if you turn it on.
With diagnostics on, the app also sends small reports under a random ID made for this TV. Account → Diagnostics shows
the ID.

- the TV model, firmware and Tizen version, and the app version
- your F1 TV plan (Access, Pro or Premium) and which kinds of streams F1 offered (HDR, 4K, multiview)
- which player (AVPlay/Shaka) worked or failed, error codes, start-up and buffering times
- requests to F1 that failed (which kind of request and the error code), sign-in renewals and live timing that failed
- script errors (file and line only)

Crashes are then sent as part of diagnostics, under the ID.

## Problem reports

With diagnostics on, Account → Diagnostics can send a problem report: the kind of problem you pick, a few settings
(HDR, multiview, timing, commentary language), what this TV can play, and this session's diagnostics. You get a
reference to mention when you tell about the problem on [GitHub](https://github.com/nicbra/f1tv-tizen/issues).

## Never sent

Your F1 account, e-mail or sign-in, what you watch (no titles or video IDs), web addresses, or anything you type.

## Where it goes and for how long

Everything goes to the app's diagnostics server, run by the app's developer, and is stored and handled only in the
EU/EEA. The server doesn't store IP addresses. Diagnostics are kept 30 days.

## Turning it off and deleting

Account → Diagnostics turns diagnostics on or off. **Delete my diagnostics data** there deletes everything sent under
this TV's ID and turns diagnostics off. Crash reports have no ID, so they stay until they expire after 30 days.
