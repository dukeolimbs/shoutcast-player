# SHOUTcast Player

A lightweight [Foundry VTT](https://foundryvtt.com/) module that plays a
SHOUTcast/Icecast audio stream directly from the Token Controls toolbar — with
proper connection state management and automatic retrying.

Handy for running live music (e.g. a [Mixxx](https://mixxx.org/) broadcast) or
any internet radio stream into your game session without leaving Foundry.

## Features

- 🎵 Play/stop a SHOUTcast/Icecast stream from a toolbar button (📻 radio icon).
- 🔄 **Connection state machine** — clear status for _Connecting_, _Live_,
  _No Signal_, _Waiting for you_ and _Connection Failed_.
- ⏳ **Auto-retry with backoff** — when the server is reachable but not yet
  broadcasting (e.g. your DJ software isn't live), it reconnects on its own,
  backing off from 15s to 60s. Stop cancels it at any point.
- 🔊 **Per-client volume** — each player controls and remembers their own volume.
- 📡 **GM sync** — when the GM presses Play/Stop, connected clients follow along
  via the module socket.

## Installation

### From manifest URL (recommended)

In Foundry, go to **Add-on Modules → Install Module** and paste this manifest URL:

```
https://github.com/dukeolimbs/shoutcast-player-v2/releases/latest/download/module.json
```

### Manual

Download the latest `module.zip` from the
[Releases](https://github.com/dukeolimbs/shoutcast-player-v2/releases) page and
extract it into your Foundry `Data/modules/` folder as `shoutcast-player-v2`.

## Usage

1. Enable the module in **Manage Modules**.
2. As GM, open **Game Settings → Configure Settings → SHOUTcast Player** and set
   the **Stream URL**, e.g. `https://your.stream.host:8000/stream`. This is a
   world setting — you set it once and every player uses it.
3. Click the **📻 radio button** in the Token Controls toolbar to open the player.
4. Press **Play**. The status bar shows the live connection state; adjust volume
   with the slider.

> **Upgrading from 2.0.x:** the Stream URL used to be a per-client setting. It is
> now world-scoped, so it needs entering once more after the update.

### Connection states

| State | Meaning |
| --- | --- |
| **Connecting…** | Attempting to reach the stream (8s timeout). |
| **LIVE** | Audio is confirmed playing. |
| **No Signal — retrying…** | Nothing is coming through yet — normally because nobody is broadcasting. Reconnects on its own (15s → 60s backoff); **Retry Now** forces an immediate attempt. This is an ordinary waiting state, not a fault. |
| **Waiting for you** | Your browser will not start audio until you interact with the page — normally when the GM starts the stream remotely. Press **Play**. |
| **Connection Failed** | A configuration problem that retrying cannot fix — in practice, a mixed-content block. The window explains it. Anything that might resolve on its own stays in *No Signal* instead. |

**Stop** is available in every state except idle, so an auto-retry loop can
always be cancelled.

## Troubleshooting

**"No Signal" forever, but the stream plays fine in a browser tab.**
Check the protocol. If Foundry is served over `https://` then the stream must be
too — browsers block `http://` media on an HTTPS page. The module detects this
case and says so explicitly rather than leaving you guessing.

**Players hear nothing when the GM presses Play.**
Their browser blocked autoplay, which the window reports as *Waiting for you*.
Any click in Foundry releases it; the module retries automatically once that
happens.

**The GM's Play doesn't reach anyone.**
GM sync needs the module's socket namespace, which means `"socket": true` in the
manifest. If you have a hand-edited copy of `module.json`, make sure it is there.

## Compatibility

- Foundry VTT **v14+** (verified on 14.359).

## Development

This is a plain JS/CSS/Handlebars module — no build step. For local development,
symlink the repo into your Foundry `Data/modules/` folder:

```bash
ln -s /path/to/shoutcast-player-v2 ".../FoundryVTT/Data/modules/shoutcast-player-v2"
```

Edits to JS, CSS and templates only need a browser reload. **Edits to
`module.json` need Foundry itself restarted** — return to Setup, or restart the
server — because manifests are parsed at startup and a reload keeps serving the
cached copy. Until you do, a newly declared socket namespace or language file is
simply absent, which shows up as GM sync doing nothing and the UI rendering raw
`SHOUTCAST.*` keys. The module warns about both cases in the console on startup.

The player is reachable from macros and the console:

```js
const { player, PlayerState } = game.modules.get("shoutcast-player-v2").api;
player.play();          // start locally, and broadcast to players if you are GM
player.playLocal();     // start locally only
player.state === PlayerState.PLAYING;
```

`window.streamPlayer` is kept as an alias for the same object.

### Tests

The connection state machine has a dependency-free regression suite that drives
it against stubbed Foundry and browser globals:

```bash
node test/state-machine.test.js
```

Each case corresponds to an entry in [`ISSUES.md`](ISSUES.md). It does not
cover rendering — that still needs a look in an actual game.

Known issues and their triage live in [`ISSUES.md`](ISSUES.md); release notes in
[`CHANGELOG.md`](CHANGELOG.md).

Releases are published automatically by GitHub Actions on version tags — see
[`.github/workflows/release.yml`](.github/workflows/release.yml).

## License

[MIT](LICENSE) © Owen (dukeolimbs)
