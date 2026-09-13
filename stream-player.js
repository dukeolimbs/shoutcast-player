const MODULE_ID = "shoutcast-player-v2";
const APP_ID = "stream-player-app";

const PlayerState = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  PLAYING: "playing",
  NO_SIGNAL: "no-signal",
  BLOCKED: "blocked",
  ERROR: "error",
});

const ErrorReason = Object.freeze({
  MIXED_CONTENT: "mixed-content",
  PLAY_REJECTED: "play-rejected",
});

/** How long to wait for the 'playing' event before calling a connect failed. */
const CONNECT_TIMEOUT = 8000;

/**
 * Backoff between reconnect attempts, in ms; the last entry repeats forever.
 *
 * A browser cannot distinguish "the mount has no source yet" from "the server
 * is down" — both surface as MEDIA_ERR_SRC_NOT_SUPPORTED, and MEDIA_ERR_NETWORK
 * only appears once a stream has already been established. So rather than
 * guessing from the error code we keep retrying either way and let the attempt
 * count drive what the window says.
 */
const RETRY_DELAYS = [15000, 15000, 30000, 30000, 60000];

/** Consecutive failures before the UI stops blaming the broadcaster. */
const UNREACHABLE_AFTER = 4;

/** How long the volume slider must settle before the setting is persisted. */
const VOLUME_SAVE_DELAY = 300;

/**
 * Manages the audio stream connection with a simple state machine.
 *
 * States:
 *   idle       → not started
 *   connecting → waiting for audio to begin (CONNECT_TIMEOUT)
 *   playing    → audio confirmed audible
 *   no-signal  → connect failed; retrying on a backoff, indefinitely
 *   blocked    → browser refused playback pending a user gesture
 *   error      → terminal; needs the user to fix something and retry
 */
class StreamPlayerManager {
  constructor() {
    this.audio = null;
    this.state = PlayerState.IDLE;
    this.errorReason = null;
    /** Consecutive failed connection attempts. */
    this.attempts = 0;

    this._connectTimer = null;
    this._retryTimer = null;
    this._volumeTimer = null;
    this._volume = null;
    this._teardown = false;
    this._gestureRetryUsed = false;
  }

  get isPlaying() {
    return this.state === PlayerState.PLAYING;
  }

  /** True once we have failed often enough that the server itself is suspect. */
  get looksUnreachable() {
    return this.attempts >= UNREACHABLE_AFTER;
  }

  getStreamUrl() {
    return String(game.settings.get(MODULE_ID, "streamUrl") ?? "").trim();
  }

  getVolume() {
    // Prefer the in-flight slider value; the stored setting lags behind it by
    // up to VOLUME_SAVE_DELAY and would make a mid-drag re-render snap back.
    return this._volume ?? game.settings.get(MODULE_ID, "volume");
  }

  render() {
    const app = foundry.applications.instances.get(APP_ID);
    if (app?.rendered) app.render();
  }

  /** @returns {boolean} whether the state actually changed. */
  _setState(newState, reason = null) {
    this.errorReason = reason;
    if (this.state === newState) return false;
    this.state = newState;
    console.log(`Stream Player | State → ${newState}`);
    this.render();
    return true;
  }

  _clearConnectTimer() {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }
  }

  _clearRetryTimer() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
  }

  _scheduleRetry() {
    this._clearRetryTimer();
    const index = Math.max(
      0,
      Math.min(this.attempts - 1, RETRY_DELAYS.length - 1),
    );
    const delay = RETRY_DELAYS[index];
    console.log(
      `Stream Player | Attempt ${this.attempts} failed; retrying in ${delay / 1000}s`,
    );
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this.state === PlayerState.NO_SIGNAL) this._tryConnect();
    }, delay);
  }

  /**
   * A connection attempt failed in a way that is worth retrying. Stay in
   * no-signal and keep going: the common case is waiting for a DJ to go live,
   * which can take as long as it takes. The user can always press Stop.
   */
  _connectFailed() {
    this._clearConnectTimer();
    this.attempts++;
    // The attempt count changes the on-screen copy even when the state does not.
    if (!this._setState(PlayerState.NO_SIGNAL)) this.render();
    this._scheduleRetry();
  }

  /**
   * Browsers refuse play() without a user gesture, which is exactly the case
   * when a GM's socket command starts the stream on somebody else's client.
   * Park in 'blocked' and let Foundry's own gesture watcher resume us — once
   * only, so a browser that stays locked cannot spin.
   */
  _autoplayBlocked() {
    this._clearConnectTimer();
    this._clearRetryTimer();
    this._setState(PlayerState.BLOCKED);

    if (this._gestureRetryUsed) return;
    this._gestureRetryUsed = true;
    game.audio?.awaitFirstGesture?.()?.then(() => {
      if (this.state === PlayerState.BLOCKED) this._tryConnect();
    });
  }

  /** http:// media on an https:// page is blocked outright by the browser. */
  _isMixedContent(url) {
    return window.location.protocol === "https:" && url.startsWith("http://");
  }

  initialize() {
    if (this.audio) return;

    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.volume = this.getVolume();

    // 'playing' is the only event that proves audio is actually audible.
    // 'canplay' merely means data is buffered, which is also true when autoplay
    // has been blocked — reacting to it used to report LIVE over silence.
    this.audio.addEventListener("playing", () => {
      this._clearConnectTimer();
      this.attempts = 0;
      this._setState(PlayerState.PLAYING);
    });

    this.audio.addEventListener("pause", () => {
      // load() fires 'pause' on a playing element, so only a deliberate
      // teardown means idle. Reacting to every pause used to knock us out of
      // 'connecting' mid-reconnect and defeat the connect timeout's own guard.
      if (this._teardown) this._setState(PlayerState.IDLE);
    });

    // A broadcaster disconnecting cleanly ends the stream rather than erroring,
    // which otherwise left the window reading LIVE over a dead mount forever.
    this.audio.addEventListener("ended", () => {
      if (this._teardown) return;
      console.warn("Stream Player | Stream ended; reconnecting");
      this._connectFailed();
    });

    this.audio.addEventListener("error", () => {
      if (this._teardown) return;
      const err = this.audio?.error;
      if (!err) return;
      // Aborted means we replaced the source ourselves.
      if (err.code === MediaError.MEDIA_ERR_ABORTED) return;
      console.warn(
        `Stream Player | MediaError code=${err.code}: ${err.message}`,
      );
      this._connectFailed();
    });
  }

  _tryConnect() {
    const streamUrl = this.getStreamUrl();
    if (!streamUrl || !this.audio) return;

    this._clearConnectTimer();
    this._teardown = false;
    this._setState(PlayerState.CONNECTING);
    this.audio.src = streamUrl;
    this.audio.load();

    this._connectTimer = setTimeout(() => {
      this._connectTimer = null;
      if (this.state !== PlayerState.CONNECTING) return;
      console.warn("Stream Player | Connection timed out");
      this._connectFailed();
    }, CONNECT_TIMEOUT);

    this.audio.play().catch((err) => {
      if (err.name === "AbortError") return; // src changed before play() settled
      if (err.name === "NotAllowedError") return this._autoplayBlocked();
      console.error("Stream Player | Play rejected:", err);
      this._clearConnectTimer();
      this._setState(PlayerState.ERROR, ErrorReason.PLAY_REJECTED);
    });
  }

  /**
   * Start the local stream without touching other clients.
   * @param {object}  [options]
   * @param {boolean} [options.resetAttempts=true] Forget the failure history.
   */
  playLocal({ resetAttempts = true } = {}) {
    const streamUrl = this.getStreamUrl();
    if (!streamUrl) {
      ui.notifications.warn(game.i18n.localize("SHOUTCAST.Notify.NoUrl"));
      return;
    }

    if (this._isMixedContent(streamUrl)) {
      console.error(
        "Stream Player | Refusing an http:// stream on an https:// page — the browser would block it as mixed content",
      );
      this._clearConnectTimer();
      this._clearRetryTimer();
      if (!this._setState(PlayerState.ERROR, ErrorReason.MIXED_CONTENT)) {
        this.render();
      }
      return;
    }

    this.initialize();
    this._clearRetryTimer();
    if (resetAttempts) this.attempts = 0;
    this._gestureRetryUsed = false;
    this._tryConnect();
  }

  play() {
    this.playLocal();
    this._broadcast("play");
  }

  /**
   * Manual "try again now". Keeps the attempt count so the window does not
   * forget that the server has been failing for a while.
   */
  retry() {
    this.playLocal({ resetAttempts: false });
  }

  /** Tear down the local stream without touching other clients. */
  stopLocal() {
    this._clearConnectTimer();
    this._clearRetryTimer();
    this.attempts = 0;
    this._gestureRetryUsed = false;

    if (this.audio) {
      this._teardown = true;
      this.audio.pause();
      // Never assign "" here. An empty src re-enters the media load algorithm
      // and fires MEDIA_ERR_SRC_NOT_SUPPORTED, which the error handler read as
      // "broadcaster offline" and used to restart the stream 15s after Stop.
      this.audio.removeAttribute("src");
      this.audio.load();
    }

    this._setState(PlayerState.IDLE);
  }

  stop() {
    this.stopLocal();
    this._broadcast("stop");
  }

  /**
   * Mirror GM transport actions to players. Only the originating client emits:
   * incoming commands run through playLocal/stopLocal so that two GMs (or a GM
   * and an assistant, who both satisfy isGM) cannot bounce an action back and
   * forth between each other forever.
   */
  _broadcast(action) {
    if (!game.user.isGM) return;
    game.socket.emit(`module.${MODULE_ID}`, { action });
  }

  setVolume(volume) {
    this._volume = volume;
    if (this.audio) this.audio.volume = volume;

    // The slider fires on every pixel of travel; only persist once it settles.
    if (this._volumeTimer) clearTimeout(this._volumeTimer);
    this._volumeTimer = setTimeout(() => {
      this._volumeTimer = null;
      game.settings.set(MODULE_ID, "volume", volume);
    }, VOLUME_SAVE_DELAY);
  }

  /** The GM changed the world stream URL; follow it if we are mid-stream. */
  onStreamUrlChanged() {
    if (this.state === PlayerState.IDLE) this.render();
    else this.playLocal();
  }
}

const streamPlayer = new StreamPlayerManager();

// Kept as a convenience alias so existing macros and console poking still
// work; game.modules.get(MODULE_ID).api is the supported entry point.
window.streamPlayer = streamPlayer;

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

/**
 * Control window for the stream player.
 */
class StreamPlayerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: APP_ID,
    classes: ["shoutcast-player"],
    position: { width: 340, height: "auto" },
    window: {
      title: "SHOUTCAST.App.Title",
      icon: "fa-solid fa-radio",
      resizable: false,
    },
    actions: {
      play: StreamPlayerApp.#onPlay,
      stop: StreamPlayerApp.#onStop,
      retry: StreamPlayerApp.#onRetry,
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/player.hbs` },
  };

  static #onPlay() {
    streamPlayer.play();
  }

  static #onStop() {
    streamPlayer.stop();
  }

  static #onRetry() {
    streamPlayer.retry();
  }

  async _prepareContext(options) {
    const { state } = streamPlayer;
    const isIdle = state === PlayerState.IDLE;
    const isNoSignal = state === PlayerState.NO_SIGNAL;
    const isBlocked = state === PlayerState.BLOCKED;
    const isError = state === PlayerState.ERROR;

    return {
      streamUrl: streamPlayer.getStreamUrl(),
      isGM: game.user.isGM,
      state,
      isIdle,
      isConnecting: state === PlayerState.CONNECTING,
      isPlaying: state === PlayerState.PLAYING,
      isNoSignal,
      isBlocked,
      isError,
      isMixedContent: streamPlayer.errorReason === ErrorReason.MIXED_CONTENT,
      looksUnreachable: streamPlayer.looksUnreachable,
      attempts: streamPlayer.attempts,

      // Transport. Stop is offered in every non-idle state so the retry loop
      // can always be cancelled — it used to be playing-only, so once the
      // player entered no-signal it retried forever with no way out.
      showPlay: isIdle || isBlocked,
      showRetry: isNoSignal || isError,
      showStop: !isIdle,
      retryLabel: isNoSignal
        ? "SHOUTCAST.Button.RetryNow"
        : "SHOUTCAST.Button.Retry",

      currentVolume: Math.round(streamPlayer.getVolume() * 100),
    };
  }

  _onRender(context, options) {
    // Buttons are wired through DEFAULT_OPTIONS.actions; the slider is not,
    // because it needs the live 'input' event rather than a click.
    const slider = this.element.querySelector("#volume-control");
    const display = this.element.querySelector("#volume-display");
    slider?.addEventListener("input", (event) => {
      const volume = Number(event.target.value);
      streamPlayer.setVolume(volume / 100);
      if (display) display.textContent = `${volume}%`;
    });
  }
}

Hooks.once("init", () => {
  console.log("Stream Player | Initializing");

  game.modules.get(MODULE_ID).api = {
    player: streamPlayer,
    app: StreamPlayerApp,
    PlayerState,
  };

  game.settings.register(MODULE_ID, "streamUrl", {
    name: "SHOUTCAST.Settings.StreamUrl.Name",
    hint: "SHOUTCAST.Settings.StreamUrl.Hint",
    // World-scoped: GM sync tells every client to play, so every client has to
    // resolve the same URL. As a client setting, players who had never filled
    // it in just got a "not configured" warning instead of audio.
    scope: "world",
    config: true,
    type: String,
    default: "",
    onChange: () => streamPlayer.onStreamUrlChanged(),
  });

  game.settings.register(MODULE_ID, "volume", {
    name: "SHOUTCAST.Settings.Volume.Name",
    hint: "SHOUTCAST.Settings.Volume.Hint",
    scope: "client",
    config: false,
    type: Number,
    default: 0.5,
  });
});

Hooks.once("ready", () => {
  streamPlayer.initialize();

  game.socket.on(`module.${MODULE_ID}`, (data) => {
    console.log("Stream Player | Socket command:", data?.action);
    switch (data?.action) {
      case "play":
        streamPlayer.playLocal();
        break;
      case "stop":
        streamPlayer.stopLocal();
        break;
    }
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!controls.tokens?.tools) return;
  if (controls.tokens.tools["stream-player"]) return;

  controls.tokens.tools["stream-player"] = {
    name: "stream-player",
    title: "SHOUTCAST.Control.Title",
    icon: "fa-solid fa-radio",
    order: 99,
    button: true,
    visible: true,
    // v13+ SceneControlTool defines onChange only; onClick is not in the API.
    onChange: () => {
      const existing = foundry.applications.instances.get(APP_ID);
      if (existing) existing.close();
      else new StreamPlayerApp().render(true);
    },
  };
  console.log("Stream Player | Tool registered");
});
