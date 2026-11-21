/**
 * @file    src/core/Camera.js
 * @module  core/Camera
 *
 * @desc    First-person camera controller. Owns the THREE.PerspectiveCamera
 *          instance, its local offset within the player capsule, and all
 *          view-space feedback (head-bob, FOV kick, shake).
 *
 *          Scene-graph placement:
 *
 *              player (THREE.Object3D)
 *              ├── position: capsule center, moves via Physics
 *              ├── rotation.y: yaw (turned by mouse / touch)
 *              └── camera (THREE.PerspectiveCamera)
 *                  ├── position: (0, -EYE_OFFSET, 0) + bob + shake
 *                  └── rotation.x: pitch (clamped)
 *
 *          Why is the camera a CHILD of player?
 *            1. Physics only moves one object (player).
 *            2. Yaw and pitch are decoupled — no gimbal-lock math.
 *            3. Head-bob is a LOCAL offset — never touches world position.
 *
 *          Non-scope:
 *            · yaw/pitch input parsing  → player/Controls.js
 *            · player position          → player/Physics.js
 *            · raycasting from camera   → systems/InteractionSystem.js
 *            · world rendering          → core/Renderer.js
 */

import * as THREE from 'three';
import { CAMERA, PHYSICS, SPAWN, QUALITY, BUILD } from '../config.js';
import { LAYERS } from './Scene.js';


/* ============================================================================
 * 0. CONSTANTS
 * ========================================================================== */

/**
 * Head-bob tuning. These values are the result of play-testing — small
 * enough to not feel nauseating, large enough to be perceptible.
 *
 *   AMP_Y     vertical bob amplitude, metres
 *   AMP_X     lateral sway amplitude, metres
 *   FREQ      phase rate, rad/s (during walk)
 *   FREQ_RUN  phase rate, rad/s (during run)
 */
const BOB = Object.freeze({
  AMP_Y: 0.018,
  AMP_X: 0.012,
  AMP_Y_RUN: 0.035,
  AMP_X_RUN: 0.022,
  FREQ: 8.5,
  FREQ_RUN: 11.0,
  /** Time constant (seconds) for smooth fade in/out. */
  SMOOTHING: 0.12,
});

/**
 * FOV-kick tuning.
 *
 *   DELTA_RUN    degrees added when running
 *   SMOOTH_RATE  exponential smoothing, 1/s (higher = snappier)
 */
const FOV_KICK = Object.freeze({
  DELTA_RUN: 6.0,
  SMOOTH_RATE: 8.0,
});

/**
 * Shake impulse tuning.
 *
 *   DEFAULT_FREQ     Hz of the shake oscillation
 *   DEFAULT_DECAY    exponential decay rate, 1/s
 *   LAND_MULTIPLIER  converts impact velocity → shake magnitude
 *   LAND_MAX         maximum amplitude, metres
 *   KICK_DEFAULT     default magnitude for `camera.kick()` calls
 */
const SHAKE = Object.freeze({
  DEFAULT_FREQ: 22,
  DEFAULT_DECAY: 12,
  LAND_MULTIPLIER: 0.012,
  LAND_MAX: 0.08,
  KICK_DEFAULT: 0.03,
});

/** Below this magnitude, we snap shake to zero (avoids sub-pixel jitter). */
const SHAKE_EPSILON = 0.0005;

/** FOV-change threshold to trigger updateProjectionMatrix (expensive). */
const FOV_EPSILON = 0.02;

/** Reusable world-up vector for cross products. */
const WORLD_UP = new THREE.Vector3(0, 1, 0);


/* ============================================================================
 * 1. CAMERA CLASS
 * ========================================================================== */

export class GameCamera {
  /**
   * @param {THREE.Object3D} player  capsule root — camera becomes its child
   * @param {Object}  [opts]
   * @param {Object}  [opts.renderer]  Renderer instance; if given, we
   *                                    auto-subscribe to its 'resize' event.
   * @param {boolean} [opts.bob=true]  Head-bob enabled by default.
   * @param {boolean} [opts.fovKick=true]  FOV kick enabled by default.
   * @param {boolean} [opts.shake=true]    Impulse shake enabled by default.
   */
  constructor(player, opts = {}) {
    if (!player || !player.isObject3D) {
      throw new TypeError('[GameCamera] constructor requires a THREE.Object3D player');
    }
    if (!player.parent && !player.children) {
      // Silently tolerated — player may be added to scene after.
    }

    /* ---- 1.1 The camera itself -------------------------------------- */
    /** @type {THREE.PerspectiveCamera} */
    this._camera = new THREE.PerspectiveCamera(
      CAMERA.FOV,
      this._computeAspect(),
      CAMERA.NEAR,
      CAMERA.FAR,
    );
    this._camera.name = 'PlayerCamera';

    // YXZ order is non-negotiable for FPS cameras. Yaw first, then pitch.
    // Without it, yaw would be applied after pitch and the horizon
    // would visibly tilt when looking up/down.
    this._camera.rotation.order = 'YXZ';

    /* ---- 1.2 Layer setup -------------------------------------------- */
    // DEFAULT   — the world (walls, furniture, floor) — visible
    // SKY       — the skybox — visible (needed for background)
    // GLASS     — transparent surfaces — visible (rendered after opaques)
    // RAYCAST_ONLY — colliders — NOT visible (but raycasters can hit them)
    this._camera.layers.enable(LAYERS.DEFAULT);
    this._camera.layers.enable(LAYERS.SKY);
    this._camera.layers.enable(LAYERS.GLASS);
    // Explicitly NOT enabling RAYCAST_ONLY — collider hulls must be invisible.

    /* ---- 1.3 Attach to player --------------------------------------- */
    this._player = player;

    /** Base local offset (eye position within capsule). */
    this._baseLocalPos = new THREE.Vector3(0, -PHYSICS.EYE_OFFSET, 0);

    /** Current bob offset — accumulated into position each frame. */
    this._bobOffsetX = 0;
    this._bobOffsetY = 0;
    this._bobPhase = 0;
    this._bobStrength = 0;   // 0…1, fades in/out on movement start/stop

    /** Current shake offset — accumulated into position each frame. */
    this._shakeOffsetX = 0;
    this._shakeOffsetY = 0;
    this._shakeMagnitude = 0;
    this._shakeTime = 0;
    this._shakeFreq = SHAKE.DEFAULT_FREQ;
    this._shakeDecay = SHAKE.DEFAULT_DECAY;

    player.add(this._camera);
    this._camera.position.copy(this._baseLocalPos);

    /* ---- 1.4 FOV state ---------------------------------------------- */
    this._baseFov = CAMERA.FOV;
    this._currentFov = CAMERA.FOV;
    this._targetFov = CAMERA.FOV;

    /* ---- 1.5 Accessibility ------------------------------------------ */
    // Motion-sensitive users should not experience head-bob or FOV kick.
    // We honor prefers-reduced-motion and also expose explicit setters.
    const prefersReducedMotion =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;

    this._bobEnabled = opts.bob ?? !prefersReducedMotion;
    this._fovKickEnabled = opts.fovKick ?? !prefersReducedMotion;
    this._shakeEnabled = opts.shake ?? true;

    /* ---- 1.6 Resize subscription ------------------------------------ */
    /** @type {(() => void) | null} */
    this._unsubscribeResize = null;

    if (opts.renderer) {
      this._unsubscribeResize = opts.renderer.on('resize', ({ width, height }) => {
        this.resize(width, height);
      });
    }

    /* ---- 1.7 Scratch vectors (avoid allocations in hot path) -------- */
    this._tmpVec3 = new THREE.Vector3();
    this._aimNdc = new THREE.Vector2(0, 0);   // screen center

    /* ---- 1.8 Dev log ------------------------------------------------ */
    if (BUILD.dev) {
      // eslint-disable-next-line no-console
      console.info(
        `%c[Camera] fov=${CAMERA.FOV} near=${CAMERA.NEAR} far=${CAMERA.FAR} ` +
        `bob=${this._bobEnabled ? 'on' : 'off'} fovKick=${this._fovKickEnabled ? 'on' : 'off'}`,
        'color:#4a7fff;font-weight:600',
      );
    }
  }


  /* ==========================================================================
   * 2. GETTERS
   * ======================================================================== */

  /** @returns {THREE.PerspectiveCamera} the raw three.js camera */
  get three() { return this._camera; }

  /** @returns {number} degrees, base value (no kick applied) */
  get baseFov() { return this._baseFov; }

  /** @returns {number} degrees, current interpolated value */
  get currentFov() { return this._currentFov; }

  /** @returns {THREE.Object3D} the parent player object */
  get player() { return this._player; }


  /* ==========================================================================
   * 3. YAW / PITCH CONTROL
   * ======================================================================== */

  /** @param {number} rad */
  setYaw(rad) { this._player.rotation.y = rad; }

  /** @param {number} rad */
  addYaw(rad) { this._player.rotation.y += rad; }

  /** @returns {number} radians */
  getYaw() { return this._player.rotation.y; }

  /**
   * Set pitch, clamped to the safe range.
   * @param {number} rad
   */
  setPitch(rad) {
    this._camera.rotation.x = THREE.MathUtils.clamp(
      rad,
      -CAMERA.PITCH_LIMIT,
      CAMERA.PITCH_LIMIT,
    );
  }

  /**
   * Add pitch, clamped. Returns the amount actually applied (which may
   * be less than requested if we hit the limit).
   *
   * @param {number} rad
   * @returns {number}
   */
  addPitch(rad) {
    const before = this._camera.rotation.x;
    this.setPitch(before + rad);
    return this._camera.rotation.x - before;
  }

  /** @returns {number} radians */
  getPitch() { return this._camera.rotation.x; }

  /**
   * Reset yaw and pitch to spawn defaults.
   */
  resetOrientation() {
    this._player.rotation.y = SPAWN.YAW;
    this._camera.rotation.x = 0;
  }


  /* ==========================================================================
   * 4. DIRECTION VECTORS
   * ======================================================================== */

  /**
   * Full 3D forward (includes pitch). This is what the interaction
   * raycaster uses.
   *
   * @param {THREE.Vector3} [out]
   * @returns {THREE.Vector3}
   */
  getForward(out = new THREE.Vector3()) {
    this._camera.getWorldDirection(out);
    return out;
  }

  /**
   * Horizontal forward — projected to XZ plane, normalized.
   * This is what physics movement uses (walking is always horizontal,
   * even when looking up).
   *
   * @param {THREE.Vector3} [out]
   * @returns {THREE.Vector3}
   */
  getForwardHorizontal(out = new THREE.Vector3()) {
    this._camera.getWorldDirection(out);
    out.y = 0;
    const len = out.length();
    if (len > 1e-5) out.multiplyScalar(1 / len);
    else out.set(0, 0, -1);   // looking straight up/down — fall back to -Z
    return out;
  }

  /**
   * Horizontal right vector — perpendicular to forward, on XZ plane.
   * Used by physics for strafing.
   *
   * @param {THREE.Vector3} [out]
   * @returns {THREE.Vector3}
   */
  getRightHorizontal(out = new THREE.Vector3()) {
    this.getForwardHorizontal(out);
    out.cross(WORLD_UP);   // forward × up = right
    return out;
  }

  /**
   * World position of the camera (eye level).
   * @param {THREE.Vector3} [out]
   * @returns {THREE.Vector3}
   */
  getWorldPosition(out = new THREE.Vector3()) {
    return this._camera.getWorldPosition(out);
  }

  /**
   * Convenience: prepare a raycaster to shoot from screen center.
   *
   * @param {THREE.Raycaster} raycaster
   * @param {number} [far] override raycaster.far
   * @returns {THREE.Raycaster}
   */
  setupRaycaster(raycaster, far) {
    raycaster.setFromCamera(this._aimNdc, this._camera);
    if (far !== undefined) raycaster.far = far;
    return raycaster;
  }


  /* ==========================================================================
   * 5. FEEDBACK — KICK / LAND
   * ======================================================================== */

  /**
   * Short, decaying shake. Use for interactions: door slam, glass crack,
   * unexpected bump. Positive magnitude pushes down-then-up (feels like
   * impact). Negative pushes up-then-down (feels like jolt).
   *
   * @param {number} [magnitude]  peak offset, metres. Default 0.03.
   * @param {number} [freq]       oscillation Hz. Default 22.
   * @param {number} [decay]      exponential decay, 1/s. Default 12.
   */
  kick(magnitude = SHAKE.KICK_DEFAULT, freq = SHAKE.DEFAULT_FREQ, decay = SHAKE.DEFAULT_DECAY) {
    if (!this._shakeEnabled) return;
    // Take whichever is stronger — stacking shakes should feel punchy, not additive.
    this._shakeMagnitude = Math.max(this._shakeMagnitude, Math.abs(magnitude));
    this._shakeFreq = freq;
    this._shakeDecay = decay;
    this._shakeTime = 0;
  }

  /**
   * Landing impact. Call when player transitions from air to ground.
   * Impact strength should be the vertical velocity magnitude just before
   * landing (positive number, m/s).
   *
   * @param {number} impactSpeed  m/s (e.g. 6 for a normal jump landing)
   */
  land(impactSpeed) {
    if (!this._shakeEnabled) return;
    if (impactSpeed < 1.5) return;   // ignore trivial bumps (step-down)
    const magnitude = Math.min(
      impactSpeed * SHAKE.LAND_MULTIPLIER,
      SHAKE.LAND_MAX,
    );
    // Landing is a DOWNWARD kick — negative sign inverts sine phase.
    this.kick(-magnitude, 30, 10);
  }

  /**
   * Enable/disable impulse shake at runtime (accessibility).
   * @param {boolean} enabled
   */
  setShakeEnabled(enabled) {
    this._shakeEnabled = enabled;
    if (!enabled) {
      this._shakeMagnitude = 0;
      this._shakeOffsetX = 0;
      this._shakeOffsetY = 0;
    }
  }

  /**
   * Enable/disable head-bob at runtime (accessibility).
   * @param {boolean} enabled
   */
  setBobEnabled(enabled) {
    this._bobEnabled = enabled;
    if (!enabled) {
      this._bobOffsetX = 0;
      this._bobOffsetY = 0;
      this._bobStrength = 0;
      this._bobPhase = 0;
    }
  }

  /**
   * Enable/disable FOV kick at runtime (accessibility).
   * @param {boolean} enabled
   */
  setFovKickEnabled(enabled) {
    this._fovKickEnabled = enabled;
    if (!enabled) this._targetFov = this._baseFov;
  }


  /* ==========================================================================
   * 6. FOV
   * ======================================================================== */

  /**
   * Change the base FOV (e.g. settings menu, zoom, cinematic).
   * Kick will resume from the new base on the next frame.
   *
   * @param {number} fov degrees
   */
  setBaseFov(fov) {
    this._baseFov = THREE.MathUtils.clamp(fov, 30, 120);
    this._targetFov = this._baseFov;
  }


  /* ==========================================================================
   * 7. RESIZE
   * ======================================================================== */

  /**
   * @param {number} w CSS pixels
   * @param {number} h CSS pixels
   */
  resize(w, h) {
    if (!w || !h) return;
    const aspect = w / h;
    if (Math.abs(this._camera.aspect - aspect) < 1e-4) return;

    this._camera.aspect = aspect;
    this._camera.updateProjectionMatrix();
  }

  /**
   * @private
   * @returns {number}
   */
  _computeAspect() {
    if (typeof window === 'undefined') return 16 / 9;
    return window.innerWidth / Math.max(1, window.innerHeight);
  }


  /* ==========================================================================
   * 8. FRAME UPDATE
   * ======================================================================== */

  /**
   * Called once per frame from main.js. Advances FOV smoothing, head-bob,
   * and shake decay, then composes the camera's local position.
   *
   * @param {number} delta  seconds since last frame (already clamped to ≤0.1)
   * @param {Object} state
   * @param {boolean} state.isMoving  player is moving horizontally
   * @param {boolean} state.isRunning player is running
   * @param {boolean} state.onGround  player is on the ground
   */
  update(delta, state) {
    this._updateFov(delta, state);
    this._updateBob(delta, state);
    this._updateShake(delta);

    // Compose final local position: base + bob + shake.
    // We NEVER touch rotation — pitch/yaw are controlled by input only.
    this._camera.position.set(
      this._baseLocalPos.x + this._bobOffsetX + this._shakeOffsetX,
      this._baseLocalPos.y + this._bobOffsetY + this._shakeOffsetY,
      this._baseLocalPos.z,
    );
  }

  /**
   * @private
   */
  _updateFov(delta, state) {
    if (!this._fovKickEnabled) {
      this._targetFov = this._baseFov;
    } else {
      const running = state.isMoving && state.isRunning && state.onGround;
      this._targetFov = this._baseFov + (running ? FOV_KICK.DELTA_RUN : 0);
    }

    // Exponential smoothing — frame-rate independent.
    const t = 1 - Math.exp(-FOV_KICK.SMOOTH_RATE * delta);
    this._currentFov += (this._targetFov - this._currentFov) * t;

    // Only recompile the projection matrix if the change is visually relevant.
    // updateProjectionMatrix() is not free — it recomputes the projection
    // matrix and forces shaders that read it to refresh uniforms.
    if (Math.abs(this._currentFov - this._camera.fov) > FOV_EPSILON) {
      this._camera.fov = this._currentFov;
      this._camera.updateProjectionMatrix();
    }
  }

  /**
   * @private
   */
  _updateBob(delta, state) {
    const shouldBob = this._bobEnabled && state.isMoving && state.onGround;

    // Smoothly fade the strength toward 1 (moving) or 0 (idle).
    const targetStrength = shouldBob ? 1 : 0;
    const smoothing = 1 - Math.exp(-delta / BOB.SMOOTHING);
    this._bobStrength += (targetStrength - this._bobStrength) * smoothing;

    if (this._bobStrength < 0.001 && !shouldBob) {
      this._bobOffsetX = 0;
      this._bobOffsetY = 0;
      this._bobPhase = 0;
      return;
    }

    const isRun = state.isRunning;
    const freq = isRun ? BOB.FREQ_RUN : BOB.FREQ;
    const ampY = isRun ? BOB.AMP_Y_RUN : BOB.AMP_Y;
    const ampX = isRun ? BOB.AMP_X_RUN : BOB.AMP_X;

    this._bobPhase += freq * delta;

    // Vertical bob at double frequency (each footfall = one dip).
    // Lateral sway at base frequency (body shifts left-right once per step).
    this._bobOffsetY = Math.sin(this._bobPhase * 2) * ampY * this._bobStrength;
    this._bobOffsetX = Math.cos(this._bobPhase) * ampX * this._bobStrength;
  }

  /**
   * @private
   */
  _updateShake(delta) {
    if (this._shakeMagnitude < SHAKE_EPSILON) {
      this._shakeMagnitude = 0;
      this._shakeOffsetX = 0;
      this._shakeOffsetY = 0;
      return;
    }

    this._shakeTime += delta;
    this._shakeMagnitude *= Math.exp(-this._shakeDecay * delta);

    const t = this._shakeTime;
    const omega = this._shakeFreq * Math.PI * 2;
    // Y and X oscillate out of phase — produces a circular shake
    // that feels like a shock, not a vibration.
    this._shakeOffsetY = Math.sin(t * omega) * this._shakeMagnitude;
    this._shakeOffsetX = Math.cos(t * omega * 0.7) * this._shakeMagnitude * 0.55;
  }


  /* ==========================================================================
   * 9. DISPOSE
   * ======================================================================== */

  /**
   * Detach camera from player, unsubscribe from renderer, release refs.
   * After this call the instance is unusable.
   */
  dispose() {
    if (this._unsubscribeResize) {
      this._unsubscribeResize();
      this._unsubscribeResize = null;
    }
    if (this._camera.parent) {
      this._camera.parent.remove(this._camera);
    }
    // Cameras don't own GPU resources — no dispose() on THREE.PerspectiveCamera.
    this._player = null;
    this._tmpVec3 = null;
    this._aimNdc = null;
  }
}


/* ============================================================================
 * 10. FACTORY
 * ========================================================================== */

/**
 * @param {THREE.Object3D} player
 * @param {Object} [opts]
 * @returns {GameCamera}
 */
export function createCamera(player, opts) {
  return new GameCamera(player, opts);
}
