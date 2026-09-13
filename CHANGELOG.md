# Changelog

## 2.1.0

An audit against Foundry v14 turned up several things that had never worked.
Full triage in [`ISSUES.md`](ISSUES.md).

### Fixed

- **An idle stream server no longer reads as a failure.** With nothing being
  broadcast, the window said *Connection Failed — the browser refused to play
  this stream*. That is the most common state this module sits in, and it is
  not an error: it now shows *No Signal* and keeps reconnecting quietly. The
  escalated message after several attempts is no longer red and no longer
  assumes something is broken.
- **GM sync now works at all.** The manifest was missing `"socket": true`, so
  Foundry silently refused to relay the module's socket namespace. Play/Stop
  never reached other clients.
- **Stop actually stops.** Clearing the source with an empty `src` made the
  browser raise `MEDIA_ERR_SRC_NOT_SUPPORTED`, which the module read as
  "broadcaster offline" — so pressing Stop flipped to *No Signal* and restarted
  the audio 15 seconds later.
- **No more socket loop between two GMs.** A GM and an assistant GM (both count
  as `isGM`) bounced every Play/Stop back and forth forever.
- **The toolbar button uses the documented API.** `SceneControlTool` in v13+
  defines `onChange`; the module was registering `onClick`.
- **The retry loop can be cancelled.** Stop is now offered in every non-idle
  state, not just while playing.
- **Autoplay blocking is no longer blamed on the server.** A GM-triggered play
  on someone else's client has no user gesture behind it, so the browser
  refuses it. That showed "Cannot reach the stream server". There is now a
  *Waiting for you* state that resumes on your first interaction.
- **Mixed content is diagnosed.** An `http://` stream on an HTTPS Foundry is
  blocked by the browser; it used to look like a stream that never came up.
- **LIVE means audible.** The window reported LIVE whenever data was buffered,
  including over silence when autoplay was blocked.
- **A broadcaster going offline is noticed** instead of leaving the window on
  LIVE over a dead mount.
- **Reconnects back off** (15s, 15s, 30s, 30s, then 60s) and the message
  escalates after four failures instead of blaming the broadcaster forever.
- **Styling applies again.** The stylesheet used pre-v13 colour variables that
  no longer resolve, so most of its colour rules were being dropped.
- Volume is no longer written to settings on every pixel of slider travel.

### Changed

- **The Stream URL is now a world setting.** The GM sets it once for everyone
  instead of each player configuring their own copy. **You will need to re-enter
  it after updating** — the old per-client value is not migrated.
- The player window is an `ApplicationV2`; `Application` V1 has been deprecated
  since v13.
- All strings are localizable (`lang/en.json`).
- Added `game.modules.get("shoutcast-player-v2").api`. `window.streamPlayer`
  still works.

## 2.0.1

- Renamed the display title to "SHOUTcast Player".

## 2.0.0

- Packaged as a distributable Foundry module with automated releases.
