# What the app sends

<!-- The app shows this file under "Read more" in the diagnostics question, and the README links to it. Keep it in
step with app/js/diag-upload.js and the server's contract. Plain Markdown only: headings, paragraphs, lists, **bold**,
`code` and links (see app/js/markdown.js). -->

The app is made and tested on one TV. Diagnostics show how it works on other TV models, so problems there can be
found and fixed.

## What every TV sends

Nothing until you have answered the question about diagnostics (yes or no). After that, when the app has been open
for 15 minutes, it sends one count with only:

- the app version
- whether diagnostics are on or off

It has no ID and nothing from the TV, so it can't be linked to your TV or to anything else. The server only adds it
to a count per day, which shows how many use the app and how many have diagnostics on.

## Diagnostics

Diagnostics are only sent if you turn it on.
With diagnostics on, the app sends small reports under an ID for this TV. The ID is made from the TV's own device ID
with a one-way hash, so the device ID itself is never sent and can't be worked out from it.
Account → Diagnostics shows the ID.

- the TV model, firmware and Tizen version, and the app version
- your F1 TV plan (Access, Pro or Premium) and which kinds of streams F1 offered (HDR, 4K, multiview)
- which player (AVPlay/Shaka) worked or failed, error codes, start-up and buffering times
- requests to F1 that failed (which kind of request and the error code), sign-in renewals and live timing that failed
- crash reports: script errors (file and line only, never the error message), an app that ended unexpectedly, or an
  app update that didn't start

With diagnostics off, no crash reports are sent.

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
this TV's ID, crash reports included, and turns diagnostics off. The daily counts have no ID, so there is nothing of
yours in them to delete.
