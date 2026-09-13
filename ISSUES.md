# Issue triage — 2026-09-13

Audit of v2.0.1 against Foundry VTT v14. Severity is about user-visible impact,
not effort. Everything marked **Fixed** landed in v2.1.0; see `CHANGELOG.md`.

## P0 — advertised features that do not work

| # | Issue | Status |
| --- | --- | --- |
| 1 | **GM sync never worked.** `module.json` omits `"socket": true`, so Foundry refuses to relay the `module.shoutcast-player-v2` namespace. The server accepts the `emit` and delivers nothing. | Fixed |
| 2 | **Stop restarted the stream 15s later.** `stop()` assigned `audio.src = ""`, which re-enters the media load algorithm and fires `MediaError` code 4 (`MEDIA_ELEMENT_ERROR: Empty src attribute`). The error handler read that as "broadcaster offline", entered `no-signal` and armed the retry timer. | Fixed |
| 3 | **Socket ping-pong between two GMs.** `play()`/`stop()` emitted whenever `game.user.isGM`, and the socket handler called those same public methods. A GM + Assistant GM bounced each action back and forth forever. | Fixed |
| 4 | **`onClick` is not part of the v13+ scene control API.** `SceneControlTool` defines only `onChange`. The toolbar button was relying on an undocumented path at best. | Fixed |

## P1 — wrong behaviour or misleading feedback

| # | Issue | Status |
| --- | --- | --- |
| 5 | **`streamUrl` was client-scoped** while GM sync assumed everyone shared it. A synced Play showed players a "not configured" warning instead of audio. | Fixed — now `world` scope |
| 6 | **Autoplay blocking was reported as a dead server.** A socket-driven `play()` has no user gesture, so it rejects with `NotAllowedError`; that was mapped to generic `error` and rendered as "Cannot reach the stream server." | Fixed — new `blocked` state + `game.audio.awaitFirstGesture()` |
| 7 | **The MediaError heuristic was wrong.** Code 4 was treated as "no broadcaster" and everything else as "server down", but an unreachable server also yields code 4 in Chrome — code 2 only fires after a stream is established. `error` was effectively unreachable and a dead server was retried forever at a fixed 15s. | Fixed — escalating copy + backoff instead of guessing from the code |
| 8 | **Mixed content had no diagnosis.** An `http://` stream on an HTTPS Foundry is blocked by the browser and surfaced as a permanent "No Signal". | Fixed — detected before connecting |
| 9 | **The retry loop could not be cancelled.** The template only rendered Stop while `isPlaying`, so `no-signal` retried indefinitely with no way out. | Fixed — Stop available in every non-idle state |
| 10 | **`canplay` reported LIVE for silent audio.** Buffered data is not playback; if `play()` was blocked the UI still said LIVE. | Fixed — handler removed, `playing` is authoritative |
| 11 | **The `pause` listener was too broad.** `load()` fires `pause` on an already-playing element, knocking state from `connecting` to `idle` and defeating the 8s timeout's own `state === CONNECTING` guard. | Fixed — gated on a teardown flag |
| 12 | **`_retryCount` was write-only.** Incremented in four places, never read: no backoff, no escalation. | Fixed — drives backoff and messaging |
| 13 | **Volume wrote a setting on every slider tick**, unawaited. | Fixed — debounced 300ms, live value held in memory |
| 14 | **A stream ending was never noticed.** If the broadcaster disconnected cleanly the element fired `ended` and the UI sat on LIVE forever. | Fixed — `ended` reconnects |

## P2 — maintenance

| # | Issue | Status |
| --- | --- | --- |
| 15 | `Application` (V1) deprecated since v13. | Fixed — migrated to `ApplicationV2` + `HandlebarsApplicationMixin` |
| 16 | Legacy CSS variables. `--color-text-light-primary`, `--color-background-application`, `--color-form-field-highlight` and `--color-border-dark-primary` are pre-v13 names; no v14-verified module still uses them, so those declarations were silently dropping. | Fixed — local tokens with fallback chains |
| 17 | No i18n; every string hardcoded English. | Fixed — `lang/en.json` |
| 18 | `window.streamPlayer` global instead of the module API. | Fixed — `game.modules.get(id).api`, global kept as an alias so existing macros survive |
| 19 | `.gitattributes` declared `packs/** binary` for a directory that does not exist. | Fixed |
| 20 | Release zip omitted `lang/` and `CHANGELOG.md`. | Fixed |

## Deliberately not done

- **Late-joiner state sync.** A client connecting mid-session does not learn that
  the stream is already running. Doing it properly needs a GM state broadcast and
  a join handshake, and it collides with autoplay blocking anyway — a fresh client
  cannot start audio without a gesture. Worth its own change.
- **Per-world sync toggle.** GM sync is currently unconditional. Fine for now;
  revisit if it proves annoying.
- **Respecting Foundry's global/interface volume.** The stream is independent of
  `game.settings.get("core", "globalAmbientVolume")` by design — it is not a
  Foundry playlist.
