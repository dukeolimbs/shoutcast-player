const PlayerState = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  PLAYING: "playing",
  NO_SIGNAL: "no-signal",
  ERROR: "error",
});

/**
 * Manages the audio stream connection with a simple state machine.
 *
 * States:
 *   idle       → not started
 *   connecting → play() called; waiting for audio to begin (8s timeout)
 *   playing    → audio confirmed playing
 *   no-signal  → server reached but no source (Mixxx not broadcasting); auto-retries every 15s
 *   error      → server unreachable; requires manual retry
 */
class StreamPlayerManager {
  constructor() {
    this.audio = null;
    this.state = PlayerState.IDLE;
    this._connectTimer = null;
    this._retryTimer = null;
    this._retryCount = 0;
    this._teardown = false;
  }

  get isPlaying() {
    return this.state === PlayerState.PLAYING;
  }

  getVolume() {
    return game.settings.get("shoutcast-player-v2", "volume");
  }

  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    console.log(`Stream Player | State → ${newState}`);
    const app = Object.values(ui.windows).find(
      (w) => w.id === "stream-player-app",
    );
    app?.render(false);
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
    this._retryTimer = setTimeout(() => {
      this._retryTimer = null;
      if (this.state === PlayerState.NO_SIGNAL) {
        this._retryCount++;
        this._tryConnect();
      }
    }, 15000);
  }

  initialize() {
    if (this.audio) return;

    this.audio = new Audio();
    this.audio.preload = "none";
    this.audio.volume = this.getVolume();

    this.audio.addEventListener("playing", () => {
      this._clearConnectTimer();
      this._retryCount = 0;
      this._setState(PlayerState.PLAYING);
    });

    this.audio.addEventListener("canplay", () => {
      if (this.state === PlayerState.CONNECTING) {
        this._clearConnectTimer();
        this._retryCount = 0;
        this._setState(PlayerState.PLAYING);
      }
    });

    this.audio.addEventListener("pause", () => {
      if (this.state !== PlayerState.IDLE) {
        this._setState(PlayerState.IDLE);
      }
    });

    this.audio.addEventListener("error", () => {
      if (this._teardown) return; // raised by our own stopLocal() teardown
      this._clearConnectTimer();
      const err = this.audio?.error;
      if (!err) return;
      console.error(
        `Stream Player | MediaError code=${err.code}:`,
        err.message,
      );

      // MEDIA_ERR_SRC_NOT_SUPPORTED (4): mount not found — Mixxx likely not broadcasting yet
      // MEDIA_ERR_NETWORK (2): network failure — server itself may be down
      if (err.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
        this._setState(PlayerState.NO_SIGNAL);
        this._scheduleRetry();
      } else {
        this._setState(PlayerState.ERROR);
      }
    });
  }

  _tryConnect() {
    const streamUrl = game.settings.get("shoutcast-player-v2", "streamUrl");
    if (!streamUrl || !this.audio) return;

    this._teardown = false;
    this._setState(PlayerState.CONNECTING);
    this.audio.src = streamUrl;
    this.audio.load();

    // If no 'playing' event within 8s, assume no signal
    this._connectTimer = setTimeout(() => {
      this._connectTimer = null;
      if (this.state === PlayerState.CONNECTING) {
        console.warn("Stream Player | Connection timed out — no signal");
        this._setState(PlayerState.NO_SIGNAL);
        this._scheduleRetry();
      }
    }, 8000);

    this.audio.play().catch((err) => {
      if (err.name === "AbortError") return; // Normal when src changes before play resolves
      console.error("Stream Player | Play rejected:", err);
      this._clearConnectTimer();
      this._setState(PlayerState.ERROR);
    });
  }

  /** Start the local stream without touching other clients. */
  playLocal() {
    const streamUrl = game.settings.get("shoutcast-player-v2", "streamUrl");
    if (!streamUrl) {
      ui.notifications.warn(
        "Audio Stream URL is not configured. Check Module Settings.",
      );
      return;
    }
    this.initialize();
    this._clearRetryTimer();
    this._retryCount = 0;
    this._tryConnect();
  }

  play() {
    this.playLocal();
    this._broadcast("play");
  }

  /**
   * Mirror GM transport actions to players. Only the originating client emits:
   * incoming commands run through playLocal/stopLocal so that two GMs (or a GM
   * and an assistant, who both satisfy isGM) cannot bounce an action back and
   * forth between each other forever.
   */
  _broadcast(action) {
    if (!game.user.isGM) return;
    game.socket.emit("module.shoutcast-player-v2", { action });
  }

  retry() {
    this._clearRetryTimer();
    this._retryCount++;
    this._tryConnect();
  }

  /** Tear down the local stream without touching other clients. */
  stopLocal() {
    this._clearConnectTimer();
    this._clearRetryTimer();
    this._retryCount = 0;

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

  setVolume(volume) {
    if (this.audio) this.audio.volume = volume;
    game.settings.set("shoutcast-player-v2", "volume", volume);
  }
}

window.streamPlayer = new StreamPlayerManager();

/**
 * Control window for the stream player
 */
class StreamPlayerApp extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "stream-player-app",
      title: "Audio Stream",
      template: "modules/shoutcast-player-v2/templates/player.hbs",
      classes: ["app", "window-app"],
      width: 340,
      height: "auto",
      resizable: false,
    });
  }

  getData() {
    const { state } = window.streamPlayer;
    return {
      streamUrl: game.settings.get("shoutcast-player-v2", "streamUrl"),
      isGM: game.user.isGM,
      state,
      isIdle: state === PlayerState.IDLE,
      isConnecting: state === PlayerState.CONNECTING,
      isPlaying: state === PlayerState.PLAYING,
      isNoSignal: state === PlayerState.NO_SIGNAL,
      isError: state === PlayerState.ERROR,
      currentVolume: Math.round(window.streamPlayer.getVolume() * 100),
    };
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("#play-stream").click(() => window.streamPlayer.play());
    html.find("#stop-stream").click(() => window.streamPlayer.stop());
    html.find("#retry-stream").click(() => window.streamPlayer.retry());

    html.find("#volume-control").on("input", (e) => {
      const volume = parseInt(e.target.value, 10);
      window.streamPlayer.setVolume(volume / 100);
      html.find("#volume-display").text(`${volume}%`);
    });
  }
}

Hooks.once("init", () => {
  console.log("Stream Player | Initializing");

  game.settings.register("shoutcast-player-v2", "streamUrl", {
    name: "Stream URL",
    hint: "Full URL of your Icecast/SHOUTcast audio stream (e.g., http://your.stream.ip:8000/stream)",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });

  game.settings.register("shoutcast-player-v2", "volume", {
    name: "Stream Volume",
    hint: "Volume level for the stream (saved per client).",
    scope: "client",
    config: false,
    type: Number,
    default: 0.5,
  });
});

Hooks.once("ready", () => {
  window.streamPlayer.initialize();

  game.socket.on("module.shoutcast-player-v2", (data) => {
    console.log("Stream Player | Socket command:", data.action);
    switch (data.action) {
      case "play":
        window.streamPlayer.playLocal();
        break;
      case "stop":
        window.streamPlayer.stopLocal();
        break;
    }
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!controls.tokens?.tools) return;
  if (controls.tokens.tools["stream-player"]) return;

  controls.tokens.tools["stream-player"] = {
    name: "stream-player",
    title: "Audio Stream",
    icon: "fa-solid fa-radio",
    order: 99,
    button: true,
    visible: true,
    // v13+ SceneControlTool defines onChange only; onClick is not in the API.
    onChange: () => {
      const existing = Object.values(ui.windows).find(
        (w) => w.id === "stream-player-app",
      );
      if (existing) {
        existing.close();
      } else {
        new StreamPlayerApp().render(true);
      }
    },
  };
  console.log("Stream Player | Tool registered");
});
