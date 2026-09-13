/**
 * Regression tests for the connection state machine.
 *
 * Loads stream-player.js against stubbed Foundry and browser globals so the
 * state machine can actually be driven rather than reasoned about. No
 * dependencies and no build step -- run it with:
 *
 *     node test/state-machine.test.js
 *
 * Every case corresponds to a bug in ISSUES.md; they exist so those bugs
 * cannot come back quietly.
 */
const fs = require("fs");
const vm = require("vm");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "stream-player.js");

function build({ isGM = true, https = false, url = "http://stream.test:8000/live", socket, translations } = {}) {
  const emitted = [];
  const notifications = [];
  const logs = [];

  // ---- controllable clock ------------------------------------------------
  let now = 0;
  let seq = 0;
  const timers = new Map();
  const setTimeoutStub = (fn, ms) => {
    const id = ++seq;
    timers.set(id, { at: now + ms, fn });
    return id;
  };
  const clearTimeoutStub = (id) => timers.delete(id);
  const advance = (ms) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      timers.delete(id);
      now = t.at;
      t.fn();
    }
    now = target;
  };

  // ---- fake media element ------------------------------------------------
  class FakeAudio {
    constructor() {
      this.listeners = {};
      this._src = null;
      this.paused = true;
      this.error = null;
      this.volume = 1;
      this.preload = "";
      this.playCalls = 0;
      this.loadCalls = 0;
      this.playBehaviour = () => Promise.resolve();
    }
    addEventListener(t, fn) { (this.listeners[t] ||= []).push(fn); }
    get src() { return this._src; }
    set src(v) { this._src = v; }
    removeAttribute(a) { if (a === "src") this._src = null; }
    load() { this.loadCalls++; }
    pause() { this.paused = true; this.fire("pause"); }
    play() { this.playCalls++; this.paused = false; return this.playBehaviour(); }
    fire(type) { (this.listeners[type] || []).forEach((fn) => fn()); }
    /** Raise a media error the way a browser would. */
    fireError(code, message = "") {
      this.error = { code, message };
      this.fire("error");
    }
  }

  const settings = new Map([
    ["shoutcast-player-v2.streamUrl", url],
    ["shoutcast-player-v2.volume", 0.5],
  ]);

  const moduleEntry = socket === undefined ? {} : { socket };
  const sandbox = {
    console: {
      log: (...a) => logs.push(a.join(" ")),
      warn: (...a) => logs.push("WARN " + a.join(" ")),
      error: (...a) => logs.push("ERROR " + a.join(" ")),
    },
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimeoutStub,
    Audio: FakeAudio,
    MediaError: { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 },
    Hooks: {
      _hooks: {},
      once(name, fn) { (this._hooks[name] ||= []).push(fn); },
      on(name, fn) { (this._hooks[name] ||= []).push(fn); },
      call(name, ...args) { (this._hooks[name] || []).forEach((fn) => fn(...args)); },
    },
    game: {
      user: { isGM },
      modules: { get: () => moduleEntry },
      i18n: {
        localize: (k) => (translations && k in translations ? translations[k] : k),
        format: (k) => k,
      },
      audio: { awaitFirstGesture: () => new Promise(() => {}) },
      settings: {
        register() {},
        get: (m, k) => settings.get(`${m}.${k}`),
        set: (m, k, v) => { settings.set(`${m}.${k}`, v); return Promise.resolve(v); },
      },
      socket: {
        emit: (ev, data) => emitted.push({ ev, data }),
        on: (ev, fn) => { sandbox.__socketHandler = fn; },
      },
    },
    ui: { notifications: { warn: (m) => notifications.push(m) } },
    foundry: {
      applications: {
        instances: new Map(),
        api: {
          ApplicationV2: class { constructor() {} render() {} close() {} },
          HandlebarsApplicationMixin: (Base) => class extends Base {},
        },
      },
      utils: { mergeObject: Object.assign },
    },
  };
  sandbox.window = sandbox;
  sandbox.window.location = { protocol: https ? "https:" : "http:" };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(SRC, "utf8"), sandbox, { filename: SRC });

  sandbox.Hooks.call("init");
  sandbox.Hooks.call("ready");

  return {
    sandbox,
    player: sandbox.streamPlayer,
    audio: () => sandbox.streamPlayer.audio,
    emitted,
    notifications,
    logs,
    advance,
    settings,
    socketSend: (action) => sandbox.__socketHandler({ action }),
  };
}

// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const asyncTests = [];
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? " -- " + detail : ""}`); }
};
const test = (name, fn) => { console.log("\n" + name); const r = fn(); if (r && r.then) asyncTests.unshift(() => r); };

// 1 -------------------------------------------------------------------------
test("Stop stays stopped (regression: empty src restarted the stream)", () => {
  const h = build();
  h.player.play();
  h.audio().fire("playing");
  check("playing after the audio element starts", h.player.state === "playing", h.player.state);

  h.player.stop();
  check("idle immediately after stop", h.player.state === "idle", h.player.state);
  check("src cleared without assigning an empty string", h.audio().src === null);

  // The browser used to raise this against the empty src right after stop().
  h.audio().fireError(4, "MEDIA_ELEMENT_ERROR: Empty src attribute");
  check("teardown error ignored", h.player.state === "idle", h.player.state);

  h.advance(60000);
  check("still idle a minute later", h.player.state === "idle", h.player.state);
  check("no reconnect attempted", h.audio().playCalls === 1, `playCalls=${h.audio().playCalls}`);
});

// 2 -------------------------------------------------------------------------
test("Socket commands do not re-broadcast (regression: two GMs looped)", () => {
  const h = build({ isGM: true });
  h.socketSend("play");
  check("remote play started locally", h.player.state === "connecting", h.player.state);
  check("remote play emitted nothing", h.emitted.length === 0, JSON.stringify(h.emitted));

  h.socketSend("stop");
  check("remote stop emitted nothing", h.emitted.length === 0, JSON.stringify(h.emitted));

  h.player.play();
  check("local play does broadcast", h.emitted.length === 1, JSON.stringify(h.emitted));
  check("broadcast uses the module namespace",
    h.emitted[0].ev === "module.shoutcast-player-v2" && h.emitted[0].data.action === "play");
});

test("Players never broadcast", () => {
  const h = build({ isGM: false });
  h.player.play();
  h.player.stop();
  check("no emits from a non-GM", h.emitted.length === 0, JSON.stringify(h.emitted));
});

// 3 -------------------------------------------------------------------------
test("Reconnect backoff and escalation", () => {
  const h = build();
  h.player.play();
  const delays = [];
  const lastDelay = () =>
    Number(h.logs.filter((l) => l.includes("retrying in")).pop().match(/retrying in (\d+)s/)[1]);

  for (let i = 0; i < 6; i++) {
    h.audio().fireError(4, "not supported");
    delays.push(lastDelay());
    if (i < 5) h.player.retry();   // begin the next attempt
  }
  check("backoff is 15,15,30,30,60,60", delays.join(",") === "15,15,30,30,60,60", delays.join(","));
  check("stays in no-signal", h.player.state === "no-signal", h.player.state);
  check("escalates after 4 failures", h.player.looksUnreachable === true, "attempts=" + h.player.attempts);
  check("attempt count tracks failures", h.player.attempts === 6, String(h.player.attempts));
});

test("One failed attempt counts once, however many ways it is reported", () => {
  const h = build();
  h.player.play();
  h.audio().fireError(4, "not supported");
  h.audio().fireError(4, "not supported");
  h.audio().fireError(2, "network");
  check("attempts incremented once", h.player.attempts === 1, String(h.player.attempts));
});
test("Stop cancels a pending reconnect", () => {
  const h = build();
  h.player.play();
  h.audio().fireError(4, "not supported");
  check("in no-signal", h.player.state === "no-signal", h.player.state);
  const before = h.audio().playCalls;
  h.player.stop();
  h.advance(120000);
  check("no further connection attempts", h.audio().playCalls === before, `${h.audio().playCalls} vs ${before}`);
  check("idle", h.player.state === "idle", h.player.state);
});

// 4 -------------------------------------------------------------------------
test("Connect timeout", () => {
  const h = build();
  h.player.play();
  check("connecting", h.player.state === "connecting", h.player.state);
  h.advance(7999);
  check("still connecting at 7.999s", h.player.state === "connecting", h.player.state);
  h.advance(2);
  check("no-signal after 8s", h.player.state === "no-signal", h.player.state);
});

// 5 -------------------------------------------------------------------------
asyncTests.push(async () => {
  console.log("\nAutoplay blocking is its own state");
  let releaseGesture;
  const h = build();
  h.sandbox.game.audio.awaitFirstGesture = () => new Promise((r) => { releaseGesture = r; });
  h.player.initialize();
  h.audio().playBehaviour = () =>
    Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));

  h.player.play();
  await new Promise((r) => setImmediate(r));
  check("parks in blocked, not error", h.player.state === "blocked", h.player.state);
  check("did not blame the server", h.player.state !== "no-signal", h.player.state);

  h.advance(120000);
  check("no retry storm while blocked", h.audio().playCalls === 1, "playCalls=" + h.audio().playCalls);

  // A user gesture arrives; playback is allowed now.
  h.audio().playBehaviour = () => Promise.resolve();
  releaseGesture();
  await new Promise((r) => setImmediate(r));
  check("resumes on first gesture", h.player.state === "connecting", h.player.state);
  h.audio().fire("playing");
  check("reaches live", h.player.state === "playing", h.player.state);
});

asyncTests.push(async () => {
  console.log("\nAutoplay gesture resume is one-shot");
  let release;
  const h = build();
  h.sandbox.game.audio.awaitFirstGesture = () => new Promise((r) => { release = r; });
  h.player.initialize();
  h.audio().playBehaviour = () =>
    Promise.reject(Object.assign(new Error("blocked"), { name: "NotAllowedError" }));
  h.player.play();
  await new Promise((r) => setImmediate(r));

  release();                                   // still blocked by the browser
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  check("still blocked", h.player.state === "blocked", h.player.state);
  const calls = h.audio().playCalls;
  h.advance(300000);
  check("does not spin", h.audio().playCalls === calls, h.audio().playCalls + " vs " + calls);
});

// 6 -------------------------------------------------------------------------
test("Mixed content is refused up front", () => {
  const h = build({ https: true, url: "http://stream.test:8000/live" });
  h.player.play();
  check("error state", h.player.state === "error", h.player.state);
  check("reason is mixed content", h.player.errorReason === "mixed-content", String(h.player.errorReason));
  check("never touched the network", (h.audio() ? h.audio().playCalls : 0) === 0);

  const ok = build({ https: true, url: "https://stream.test:8000/live" });
  ok.player.play();
  check("https stream on https page is allowed", ok.player.state === "connecting", ok.player.state);
});

// 7 -------------------------------------------------------------------------
test("A stream that ends reconnects", () => {
  const h = build();
  h.player.play();
  h.audio().fire("playing");
  check("live", h.player.state === "playing", h.player.state);
  h.audio().fire("ended");
  check("drops to no-signal", h.player.state === "no-signal", h.player.state);
});

// 8 -------------------------------------------------------------------------
test("load()'s pause does not disturb a reconnect", () => {
  const h = build();
  h.player.play();
  h.audio().fire("playing");
  h.player.retry();               // re-enters connecting, load() fires pause
  h.audio().fire("pause");
  check("still connecting after a spurious pause", h.player.state === "connecting", h.player.state);
});

// 9 -------------------------------------------------------------------------
test("Volume is debounced but reads back immediately", () => {
  const h = build();
  h.player.initialize();
  for (let i = 0; i <= 10; i++) h.player.setVolume(i / 10);
  check("setting not written yet", h.settings.get("shoutcast-player-v2.volume") === 0.5,
    String(h.settings.get("shoutcast-player-v2.volume")));
  check("live value visible to the UI", h.player.getVolume() === 1);
  check("element volume applied", h.audio().volume === 1);
  h.advance(300);
  check("persisted once settled", h.settings.get("shoutcast-player-v2.volume") === 1,
    String(h.settings.get("shoutcast-player-v2.volume")));
});

// 10 ------------------------------------------------------------------------
test("Missing URL warns instead of connecting", () => {
  const h = build({ url: "" });
  h.player.play();
  check("warned", h.notifications.length === 1, JSON.stringify(h.notifications));
  check("stayed idle", h.player.state === "idle", h.player.state);
});

test("Toolbar tool registers with onChange", () => {
  const h = build();
  const controls = { tokens: { tools: {} } };
  h.sandbox.Hooks.call("getSceneControlButtons", controls);
  const tool = controls.tokens.tools["stream-player"];
  check("tool added", !!tool);
  check("uses onChange", typeof tool.onChange === "function");
  check("no onClick", tool.onClick === undefined);
  check("is a button", tool.button === true);
});


test("Template variables all come from _prepareContext", async () => {
  const h = build();
  const App = h.sandbox.game.modules.get().api.app;
  const context = await App.prototype._prepareContext.call({}, {});

  const hbs = fs.readFileSync(path.join(ROOT, "templates", "player.hbs"), "utf8");
  const helpers = new Set(["localize", "if", "else", "unless", "each", "with"]);
  const used = new Set();
  for (const m of hbs.matchAll(/{{[#/]?(?:if |else if |unless )?([a-zA-Z][a-zA-Z0-9_]*)/g)) {
    if (!helpers.has(m[1])) used.add(m[1]);
  }
  for (const m of hbs.matchAll(/{{localize ([a-zA-Z][a-zA-Z0-9_]*)}}/g)) used.add(m[1]);

  const missing = [...used].filter((k) => !(k in context));
  check("no template variable is undefined in context", missing.length === 0, missing.join(", "));

  const lang = JSON.parse(fs.readFileSync(path.join(ROOT, "lang", "en.json"), "utf8"));
  const keys = [...hbs.matchAll(/"(SHOUTCAST\\.[A-Za-z.]+)"/g)].map((m) => m[1]);
  const absent = keys.filter((k) => !(k in lang));
  check("every localization key in the template exists", absent.length === 0, absent.join(", "));

  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "module.json"), "utf8"));
  check("manifest declares the socket namespace", manifest.socket === true);
  check("manifest registers the language file", (manifest.languages || []).length === 1);
});


test("Stale manifest data announces itself", () => {
  const healthy = build({
    socket: true,
    translations: JSON.parse(fs.readFileSync(path.join(ROOT, "lang", "en.json"), "utf8")),
  });
  const quiet = healthy.logs.filter((l) => l.startsWith("WARN") && l.includes("restart Foundry"));
  check("healthy manifest warns about nothing", quiet.length === 0, quiet.join(" | "));

  const stale = build({ socket: false });
  const warns = stale.logs.filter((l) => l.includes("restart Foundry"));
  check("missing socket namespace is reported",
    warns.some((l) => l.includes("GM sync")), warns.join(" | "));
  check("missing translations are reported",
    warns.some((l) => l.includes("raw keys")), warns.join(" | "));

  const unknown = build();
  const socketWarn = unknown.logs.filter((l) => l.includes("GM sync"));
  check("no false alarm when the field is absent", socketWarn.length === 0, socketWarn.join(" | "));
});


asyncTests.push(async () => {
  console.log("\nAn empty mount is no-signal, not a browser refusal");
  const h = build();
  h.player.initialize();
  // What Chrome and Firefox actually produce when the mount has no source.
  h.audio().playBehaviour = () =>
    Promise.reject(Object.assign(new Error("no supported source"), { name: "NotSupportedError" }));

  h.player.play();
  await new Promise((r) => setImmediate(r));
  check("lands in no-signal", h.player.state === "no-signal", h.player.state);
  check("not a terminal error", h.player.state !== "error", h.player.state);
  check("no error reason set", !h.player.errorReason, String(h.player.errorReason));
  check("a retry is scheduled", h.logs.some((l) => l.includes("retrying in")));
});

asyncTests.push(async () => {
  console.log("\nThe error event and the play() rejection agree");
  const h = build();
  h.player.initialize();
  h.audio().playBehaviour = () => {
    // The browser fires both for one failed load.
    h.audio().fireError(4, "no supported source");
    return Promise.reject(Object.assign(new Error("x"), { name: "NotSupportedError" }));
  };
  h.player.play();
  await new Promise((r) => setImmediate(r));
  check("still no-signal after both signals", h.player.state === "no-signal", h.player.state);
  check("counted as a single attempt", h.player.attempts === 1, String(h.player.attempts));
});

asyncTests.push(async () => {
  console.log("\nAn unexpected rejection is still retried, not fatal");
  const h = build();
  h.player.initialize();
  h.audio().playBehaviour = () =>
    Promise.reject(Object.assign(new Error("?"), { name: "SomethingNewError" }));
  h.player.play();
  await new Promise((r) => setImmediate(r));
  check("retryable rather than terminal", h.player.state === "no-signal", h.player.state);
  check("logged for diagnosis", h.logs.some((l) => l.includes("SomethingNewError")));
});

test("Module API is exposed", () => {
  const h = build();
  check("api.player present", !!h.sandbox.game.modules.get().api?.player);
  check("window.streamPlayer alias present", h.sandbox.window.streamPlayer === h.player);
});

(async () => {
  for (const t of asyncTests) await t();
  console.log("\n" + pass + " passed, " + fail + " failed");
  process.exit(fail ? 1 : 0);
})();
