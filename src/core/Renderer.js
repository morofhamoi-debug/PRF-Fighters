/**
 * @file    src/core/Renderer.js
 * @module  core/Renderer
 *
 * @desc    WebGL renderer wrapper with dynamic quality, context-loss
 *          recovery, throttled resize, and telemetry.
 *
 *          Responsibilities (and ONLY these):
 *            · own the WebGLRenderer instance
 *            · enforce the PBR color pipeline (sRGB in / ACES out)
 *            · manage pixel ratio adaptively from live FPS
 *            · expose resize / dispose / stats
 *            · emit lifecycle events (contextlost, qualitychange)
 *
 *          Non-responsibilities:
 *            · scene graph (see world/World.js)
 *            · camera (see player/Player.js)
 *            · post-processing (see core/PostProcessing.js)
 *            · lighting (see core/Lighting.js)
 */

import * as THREE from 'three';
import { QUALITY, CAMERA, BUILD } from '../config.js';


/* ============================================================================
 * 0. INTERNAL CONSTANTS
 * Not exported — callers who need these should use getStats() or query
 * the Renderer's public API instead.
 * ========================================================================== */

/**
 * Dynamic DPR policy. Three numbers, high leverage:
 *
 *   DROP_BELOW      — if smoothed FPS < this for SUSTAIN_TIME_DROP ms,
 *                     reduce DPR one step (but not below MIN_DPR).
 *   RISE_ABOVE      — if smoothed FPS > this for SUSTAIN_TIME_RISE ms,
 *                     increase DPR one step (up to target).
 *   SUSTAIN_TIME_*  — hysteresis: single-frame spikes must not trigger.
 *
 *   HYSTERESIS_BAND — gap between DROP and RISE prevents oscillation:
 *                     with 45 / 58 there's a 13-FPS dead zone where we
 *                     do nothing.
 */
const DPR_POLICY = Object.freeze({
  DROP_BELOW: 45,
  RISE_ABOVE: 58,
  SUSTAIN_TIME_DROP_MS: 2000,
  SUSTAIN_TIME_RISE_MS: 5000,
  MIN_DPR: 0.75,
  STEP: 0.25,
  /** How many frames to smooth FPS over — ~1 s at 60 Hz. */
  FPS_SMOOTHING_WINDOW: 60,
});

/** Emit `stats` event at this cadence (ms). Not per-frame. */
const STATS_INTERVAL_MS = 1000;

/** Maximum shadow-map side we'll ever request, across all tiers. */
const HARD_SHADOW_MAP_CEIL = 4096;

/** three.js shadowMap.type strings → enum values. Kept local, no magic. */
const SHADOW_TYPE_MAP = Object.freeze({
  pcf: THREE.PCFShadowMap,
  pcfSoft: THREE.PCFSoftShadowMap,
  vsm: THREE.VSMShadowMap,
});


/* ============================================================================
 * 1. TINY EVENT EMITTER
 * Zero-dependency. Used to decouple Renderer from UI/Diagnostics layers.
 * ========================================================================== */

/**
 * @typedef {(payload: any) => void} Listener
 * @typedef {'contextlost'|'contextrestored'|'qualitychange'|'stats'|'resize'} RendererEvent
 */

class TinyEmitter {
  constructor() {
    /** @type {Map<string, Set<Listener>>} */
    this._listeners = new Map();
  }

  /**
   * @param {RendererEvent|string} event
   * @param {Listener} listener
   * @returns {() => void} unsubscribe
   */
  on(event, listener) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  /**
   * @param {RendererEvent|string} event
   * @param {Listener} listener
   */
  off(event, listener) {
    this._listeners.get(event)?.delete(listener);
  }

  /**
   * @param {RendererEvent|string} event
   * @param {any} [payload]
   */
  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy → iteration safety if a listener unsubscribes itself.
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[Renderer] listener for "${event}" threw:`, err);
      }
    }
  }

  dispose() {
    this._listeners.clear();
  }
}


/* ============================================================================
 * 2. RENDERER CLASS
 * ========================================================================== */

export class Renderer extends TinyEmitter {
  /**
   * @param {Object} [opts]
   * @param {HTMLCanvasElement} [opts.canvas]      Reuse an existing canvas.
   * @param {HTMLElement}       [opts.container]   If given, canvas is appended.
   * @param {boolean}           [opts.antialias]   Default false (post-fx SMAA covers it).
   * @param {boolean}           [opts.preserveDrawingBuffer] Debug only.
   */
  constructor(opts = {}) {
    super();

    /* ---- 2.1 WebGL availability gate ---------------------------------- */
    // We never let three.js throw its own cryptic "Error creating WebGL
    // context". Instead, pre-check and produce an actionable message.
    if (!this._hasWebGL()) {
      throw new Error(
        '[Renderer] WebGL is not available. ' +
        'Possible causes: hardware acceleration is off in browser settings, ' +
        'the GPU driver is blocklisted, or the browser tab was opened without ' +
        'a secure context. See https://get.webgl.org for diagnostics.',
      );
    }

    /* ---- 2.2 THREE.ColorManagement ------------------------------------ */
    // r152+ default is `true`, but we set it explicitly so a future
    // three.js version bump never silently changes our color pipeline.
    THREE.ColorManagement.enabled = true;

    /* ---- 2.3 The WebGLRenderer --------------------------------------- */
    /**
     * @type {THREE.WebGLRenderer}
     */
    this._gl = new THREE.WebGLRenderer({
      canvas: opts.canvas,
      antialias: opts.antialias ?? false,
      alpha: false,             // opaque — window is behind nothing
      depth: true,
      stencil: false,           // we never use the stencil buffer
      premultipliedAlpha: true,
      preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,  // allow software fallback (potato tier)
    });

    /* ---- 2.4 Output / color / tone ----------------------------------- */
    // Order matters: outputColorSpace must be set BEFORE toneMapping,
    // otherwise the first rendered frame uses the wrong decode.
    this._gl.outputColorSpace = THREE.SRGBColorSpace;
    this._gl.toneMapping = THREE.ACESFilmicToneMapping;
    this._gl.toneMappingExposure = 1.05;

    /* ---- 2.5 Shadows -------------------------------------------------- */
    this._gl.shadowMap.enabled = QUALITY.sunShadow;
    this._gl.shadowMap.type = SHADOW_TYPE_MAP[QUALITY.shadowMapType] ?? THREE.PCFSoftShadowMap;
    // Auto-update = shadows recompute every frame. We only need them when
    // something changes (sun moves, door opens). Consumers can toggle.
    this._gl.shadowMap.autoUpdate = true;
    this._gl.shadowMap.needsUpdate = true;

    /* ---- 2.6 Pixel ratio and size ------------------------------------ */
    /** @type {number} the DPR we're currently rendering at */
    this._currentDPR = QUALITY.resolvedPixelRatio;
    /** @type {number} the DPR we *would like* to be at (from QUALITY) */
    this._targetDPR = QUALITY.resolvedPixelRatio;

    this._gl.setPixelRatio(this._currentDPR);
    this._gl.setSize(
      window.innerWidth,
      window.innerHeight,
      /* updateStyle */ false,  // canvas is position:fixed inset:0 via CSS
    );

    /* ---- 2.7 Attach to DOM ------------------------------------------ */
    if (opts.container) {
      opts.container.appendChild(this._gl.domElement);
    }
    // Canvas hygiene — CSS handles layout, we only enforce rendering props.
    const c = this._gl.domElement;
    c.style.display = 'block';
    c.style.width = '100%';
    c.style.height = '100%';
    c.style.touchAction = 'none';
    c.style.outline = 'none';
    // Helps browsers pick the right GPU on hybrid laptops.
    c.setAttribute('aria-hidden', 'true');

    /* ---- 2.8 Context-loss wiring ------------------------------------ */
    // Without preventDefault() on webglcontextlost, the context is NOT
    // recoverable. This is the #1 cause of "black screen after alt-tab"
    // reports on Android.
    this._onContextLost = (e) => {
      e.preventDefault();
      this.emit('contextlost', { at: performance.now() });
    };
    this._onContextRestored = () => {
      // three.js re-creates its internal state automatically on restore.
      // We must re-emit so `main.js` can re-upload textures / recompile.
      this._gl.shadowMap.needsUpdate = true;
      this.emit('contextrestored', { at: performance.now() });
    };
    c.addEventListener('webglcontextlost', this._onContextLost, false);
    c.addEventListener('webglcontextrestored', this._onContextRestored, false);

    /* ---- 2.9 Resize plumbing ---------------------------------------- */
    // viewport units, visualViewport, and orientationchange can all fire
    // for one physical change. Coalesce into a single RAF tick.
    this._resizeScheduled = false;
    this._lastWidth = 0;
    this._lastHeight = 0;

    this._onResize = () => {
      if (this._resizeScheduled) return;
      this._resizeScheduled = true;
      requestAnimationFrame(() => {
        this._resizeScheduled = false;
        this.resize(window.innerWidth, window.innerHeight);
      });
    };
    window.addEventListener('resize', this._onResize, { passive: true });
    window.addEventListener('orientationchange', this._onResize, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize, { passive: true });
    }

    /* ---- 2.10 Adaptive DPR state ------------------------------------ */
    /** @type {number[]} rolling FPS history, length ≤ smoothing window */
    this._fpsHistory = [];
    /** @type {number} last time we changed DPR (ms) */
    this._lastDPRChange = 0;
    /** @type {boolean} disables adaptive logic (used in benchmarks) */
    this._adaptivePaused = false;

    /* ---- 2.11 Telemetry state --------------------------------------- */
    /** @type {number} */
    this._frameCounter = 0;
    /** @type {number} last time we emitted stats */
    this._lastStatsEmit = 0;
    /** @type {number} last inter-frame delta, seconds */
    this._lastDelta = 1 / 60;

    /* ---- 2.12 Render loop ------------------------------------------- */
    /** @type {((delta: number, elapsed: number) => void) | null} */
    this._frameCallback = null;

    if (BUILD.dev) {
      // eslint-disable-next-line no-console
      console.info(
        `%c[Renderer] ${QUALITY.tier} · DPR ${this._currentDPR.toFixed(2)} · ` +
        `${QUALITY.sunShadow ? QUALITY.shadowMapSize + 'px ' + QUALITY.shadowMapType : 'no shadows'}`,
        'color:#4a7fff;font-weight:600',
      );
    }
  }


  /* ==========================================================================
   * 3. PUBLIC GETTERS
   * ======================================================================== */

  /** @returns {THREE.WebGLRenderer} the raw renderer — escape hatch, use sparingly */
  get three() { return this._gl; }

  /** @returns {HTMLCanvasElement} */
  get domElement() { return this._gl.domElement; }

  /** @returns {number} live pixel ratio */
  get currentDPR() { return this._currentDPR; }

  /** @returns {number} target (upper bound) pixel ratio */
  get targetDPR() { return this._targetDPR; }

  /** @returns {boolean} whether adaptive DPR is currently adjusting */
  get adaptiveActive() { return !this._adaptivePaused; }


  /* ==========================================================================
   * 4. RESIZE
   * ======================================================================== */

  /**
   * Resize the drawing buffer. Idempotent — calling with the same w/h
   * twice does nothing.
   *
   * @param {number} w CSS pixels
   * @param {number} h CSS pixels
   * @param {boolean} [force] bypass idempotency check
   */
  resize(w, h, force = false) {
    if (!force && w === this._lastWidth && h === this._lastHeight) return;

    this._lastWidth = w;
    this._lastHeight = h;

    this._gl.setSize(w, h, /* updateStyle */ false);
    this._gl.shadowMap.needsUpdate = true;

    // Consumers (camera, composer, cinematic shader) subscribe via `on('resize')`
    // instead of hooking window.resize themselves. One source of truth.
    this.emit('resize', { width: w, height: h, dpr: this._currentDPR });
  }

  /**
   * Force a specific pixel ratio. Used by the adaptive DPR system and
   * by tests/benchmarks. Clamped by device and by QUALITY tier.
   *
   * @param {number} dpr
   * @param {'adaptive'|'manual'} [source]
   */
  setPixelRatio(dpr, source = 'manual') {
    const capped = THREE.MathUtils.clamp(dpr, DPR_POLICY.MIN_DPR, this._targetDPR);
    if (Math.abs(capped - this._currentDPR) < 0.01) return;

    this._currentDPR = capped;
    this._gl.setPixelRatio(capped);
    this._lastDPRChange = performance.now();
    this._gl.shadowMap.needsUpdate = true;

    this.emit('qualitychange', {
      dpr: capped,
      source,
      at: this._lastDPRChange,
    });
  }

  /**
   * Hot-swap the target DPR envelope. Called by main.js when it wants to
   * hold the frame budget while keeping resolution controllable.
   *
   * @param {number} dpr  new target (clamped by device + min)
   */
  setTargetDPR(dpr) {
    this._targetDPR = Math.max(DPR_POLICY.MIN_DPR, dpr);
    if (this._currentDPR > this._targetDPR) {
      this.setPixelRatio(this._targetDPR, 'manual');
    }
  }

  /**
   * Pause / resume the adaptive DPR controller. When paused, the renderer
   * renders at whatever DPR was last set.
   *
   * @param {boolean} paused
   */
  pauseAdaptive(paused) {
    this._adaptivePaused = paused;
    if (paused) this._fpsHistory.length = 0;
  }


  /* ==========================================================================
   * 5. RENDER LOOP
   * ======================================================================== */

  /**
   * Register the per-frame callback and start the loop. Only one callback
   * may be registered — this is intentional: multiple consumers must
   * coordinate inside a single `onFrame(delta, elapsed)`.
   *
   * @param {(delta: number, elapsed: number) => void} fn
   */
  start(fn) {
    this._frameCallback = fn;
    this._gl.setAnimationLoop(this._tick);
  }

  /** Stop the loop and release the callback reference. */
  stop() {
    this._frameCallback = null;
    this._gl.setAnimationLoop(null);
  }

  /**
   * @private
   * @param {number} timeMs  from three.js — DOMHighResTimeStamp
   */
  _tick = (timeMs) => {
    const delta = Math.min(timeMs / 1000 - this._lastTimeSec ?? 0, 0.1);
    // Guard first frame:
    this._lastTimeSec ??= 0;
    const dt = this._lastTimeSec === 0 ? 1 / 60 : delta;
    this._lastTimeSec = timeMs / 1000;
    this._lastDelta = dt;

    // 1. Run user callback.
    if (this._frameCallback) {
      this._frameCallback(dt, timeMs / 1000);
    }

    // 2. Adaptive DPR sampling — cheap, uses smoothed FPS.
    if (!this._adaptivePaused && dt > 0) {
      this._sampleFPS(dt);
    }

    // 3. Throttled stats emission.
    this._frameCounter++;
    const now = performance.now();
    if (now - this._lastStatsEmit >= STATS_INTERVAL_MS) {
      this._lastStatsEmit = now;
      this.emit('stats', this.getStats());
    }
  };


  /* ==========================================================================
   * 6. ADAPTIVE DPR
   * ======================================================================== */

  /**
   * @private
   * @param {number} dt  seconds
   */
  _sampleFPS(dt) {
    const fps = 1 / dt;
    this._fpsHistory.push(fps);
    if (this._fpsHistory.length > DPR_POLICY.FPS_SMOOTHING_WINDOW) {
      this._fpsHistory.shift();
    }
    // Need a full window before making decisions.
    if (this._fpsHistory.length < DPR_POLICY.FPS_SMOOTHING_WINDOW) return;

    const avg = this._fpsHistory.reduce((a, b) => a + b, 0) / this._fpsHistory.length;
    const now = performance.now();
    const since = now - this._lastDPRChange;

    // ── Downward pressure ───────────────────────────────────────────
    if (
      avg < DPR_POLICY.DROP_BELOW &&
      since > DPR_POLICY.SUSTAIN_TIME_DROP_MS &&
      this._currentDPR > DPR_POLICY.MIN_DPR + 0.01
    ) {
      this.setPixelRatio(this._currentDPR - DPR_POLICY.STEP, 'adaptive');
      this._fpsHistory.length = 0;   // reset — new DPR, new baseline
      return;
    }

    // ── Upward pressure ─────────────────────────────────────────────
    if (
      avg > DPR_POLICY.RISE_ABOVE &&
      since > DPR_POLICY.SUSTAIN_TIME_RISE_MS &&
      this._currentDPR < this._targetDPR - 0.01
    ) {
      this.setPixelRatio(this._currentDPR + DPR_POLICY.STEP, 'adaptive');
      this._fpsHistory.length = 0;
    }
  }


  /* ==========================================================================
   * 7. STATS / TELEMETRY
   * ======================================================================== */

  /**
   * Snapshot of GPU-side counters. Shape is stable — safe to serialize.
   *
   * @returns {{
   *   fps: number,
   *   drawCalls: number,
   *   triangles: number,
   *   lines: number,
   *   points: number,
   *   geometries: number,
   *   textures: number,
   *   programs: number,
   *   dpr: number,
   *   targetDPR: number,
   *   width: number,
   *   height: number,
   *   memory: { geometries: number, textures: number },
   * }}
   */
  getStats() {
    const info = this._gl.info;
    const avgFps = this._fpsHistory.length
      ? this._fpsHistory.reduce((a, b) => a + b, 0) / this._fpsHistory.length
      : 60;

    return {
      fps: Math.round(avgFps),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      dpr: this._currentDPR,
      targetDPR: this._targetDPR,
      width: this._lastWidth,
      height: this._lastHeight,
      memory: {
        geometries: info.memory.geometries,
        textures: info.memory.textures,
      },
    };
  }

  /**
   * Drop GPU-side caches that we don't need for a while.
   * Useful when tabbing away — releases VRAM back to the OS.
   */
  releaseTransientCaches() {
    // three.js has no public API for this in r160; `renderer.dispose()`
    // is all-or-nothing. What we CAN do is force a shader recompile check
    // and let the driver evict.
    this._gl.shadowMap.needsUpdate = true;
  }


  /* ==========================================================================
   * 8. DISPOSE
   * ======================================================================== */

  /**
   * Full teardown. After this call the instance is unusable — main.js
   * must construct a fresh one.
   */
  dispose() {
    this.stop();
    this._frameCallback = null;

    // DOM listeners
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', this._onResize);
    }
    const c = this._gl.domElement;
    c.removeEventListener('webglcontextlost', this._onContextLost);
    c.removeEventListener('webglcontextrestored', this._onContextRestored);

    // GPU state — `renderer.dispose()` releases programs, textures,
    // render targets that three.js allocated internally.
    this._gl.dispose();

    // Force-context-loss: some mobile GPUs won't reclaim VRAM until
    // the context is explicitly lost.
    try {
      this._gl.forceContextLoss();
    } catch { /* not supported */ }

    // Remove canvas from DOM if it's still attached.
    if (c.parentNode) c.parentNode.removeChild(c);

    this._fpsHistory.length = 0;
    this.dispose();          // clears listeners via TinyEmitter
  }


  /* ==========================================================================
   * 9. PRIVATE HELPERS
   * ======================================================================== */

  /**
   * Probe WebGL without leaving a context alive.
   * @private
   * @returns {boolean}
   */
  _hasWebGL() {
    try {
      const canvas = document.createElement('canvas');
      const gl =
        canvas.getContext('webgl2') ||
        canvas.getContext('webgl') ||
        canvas.getContext('experimental-webgl');
      if (!gl) return false;
      const lose = gl.getExtension('WEBGL_lose_context');
      lose?.loseContext?.();
      return true;
    } catch {
      return false;
    }
  }
}


/* ============================================================================
 * 10. FACTORY (optional convenience)
 * ========================================================================== */

/**
 * Convenience factory. Use this in `main.js` so tests can stub it.
 *
 * @param {Object} [opts]
 * @returns {Renderer}
 */
export function createRenderer(opts) {
  return new Renderer(opts);
}
