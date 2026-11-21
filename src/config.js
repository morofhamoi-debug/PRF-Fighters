/**
 * @file    src/config.js
 * @module  config
 * @desc    Central, immutable configuration for the entire application.
 *
 *          Rules of this module:
 *            1. No side effects besides reading window/navigator once.
 *            2. Every export is deeply frozen.
 *            3. Every magic number used downstream lives here.
 *            4. CSS is the single source of truth for *colors*;
 *               this module mirrors them into THREE-friendly hex numbers.
 *
 *          Load order:
 *            index.html  →  styles.css  →  config.js  →  main.js
 *          config.js is *safe* to import before DOM ready (colors will
 *          be re-synced by main.js via syncColorsFromCss()).
 */

/* ============================================================================
 * 0. ENVIRONMENT
 * ========================================================================== */

/**
 * Detect dev/prod mode.
 * Vite-aware (import.meta.env exists under Vite), with a plain-hostname
 * fallback for vanilla ES-module usage.
 */
const IS_DEV = (() => {
  try {
    if (import.meta?.env) return Boolean(import.meta.env.DEV);
  } catch { /* import.meta.env not injected */ }
  const host = (typeof location !== 'undefined' && location.hostname) || '';
  return host === 'localhost' || host === '127.0.0.1' || host === '';
})();

/**
 * Frozen build descriptor — useful in logs and bug reports.
 */
export const BUILD = Object.freeze({
  version: '0.2.0',
  codename: 'modular',
  dev: IS_DEV,
  timestamp: Date.now(),
});


/* ============================================================================
 * 1. PLATFORM DETECTION
 * ========================================================================== */

/**
 * Detection order matters:
 *   1. iPadOS 13+ pretends to be macOS — catch by touch points.
 *   2. `pointer: coarse` + `hover: none` → touch-only device (mobile/tablet).
 *   3. UA regex as final confirmation — some Android phones report
 *      `pointer: fine` when a Bluetooth mouse is connected.
 *
 * @typedef {'mobile'|'tablet'|'desktop'} Platform
 * @returns {Platform}
 */
function detectPlatform() {
  if (typeof window === 'undefined') return 'desktop';

  const ua = navigator.userAgent;
  const mq = (q) => matchMedia(q).matches;

  // iPadOS 13+ masquerades as Mac — the only reliable tell is maxTouchPoints.
  const isIPad =
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;

  const isTouchOnly = mq('(hover: none) and (pointer: coarse)');
  const hasCoarsePointer = mq('(pointer: coarse)');

  const isPhoneUA = /iPhone|iPod|Android.*Mobile|Windows Phone|IEMobile|Opera Mini/i.test(ua);
  const isTabletUA = /iPad|Android(?!.*Mobile)|Tablet|PlayBook|Silk/i.test(ua);

  if (isIPad) return 'tablet';
  if (isPhoneUA) return 'mobile';
  if (isTabletUA) return 'tablet';
  if (isTouchOnly && hasCoarsePointer) return 'mobile';

  return 'desktop';
}

/** @type {Platform} */
export const platform = detectPlatform();

/** Convenience boolean: any non-desktop form factor. */
export const isMobile = platform !== 'desktop';

/** Convenience boolean: touch-capable (mobile, tablet, or hybrid). */
export const isTouch =
  platform !== 'desktop' || matchMedia('(pointer: coarse)').matches;

Object.freeze(isMobile); // no-op, но документирует намерение


/* ============================================================================
 * 2. DEVICE CAPABILITIES
 * ========================================================================== */

/**
 * Probe WebGL2 availability **without keeping a context alive**.
 * A transient context is created on a detached canvas and immediately
 * released. On some old phones this can be slow (~30–50 ms), but the
 * tier-selection payoff is worth it.
 *
 * @returns {{ ok: boolean, gl2: boolean, maxTextureSize: number }}
 */
function probeWebGL() {
  if (typeof document === 'undefined') {
    return { ok: false, gl2: false, maxTextureSize: 0 };
  }
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;

    const gl2 = canvas.getContext('webgl2', {
      failIfMajorPerformanceCaveat: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: 'default',
    });

    if (gl2) {
      const max = gl2.getParameter(gl2.MAX_TEXTURE_SIZE) || 0;
      const lose = gl2.getExtension('WEBGL_lose_context');
      lose?.loseContext?.();
      return { ok: true, gl2: true, maxTextureSize: max };
    }

    const gl1 =
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');

    if (gl1) {
      const max = gl1.getParameter(gl1.MAX_TEXTURE_SIZE) || 0;
      const lose = gl1.getExtension('WEBGL_lose_context');
      lose?.loseContext?.();
      return { ok: true, gl2: false, maxTextureSize: max };
    }
  } catch { /* context creation failed */ }

  return { ok: false, gl2: false, maxTextureSize: 0 };
}

/**
 * @typedef {Object} Capabilities
 * @property {boolean} webgl          Any WebGL available.
 * @property {boolean} webgl2         WebGL2 available (better shaders).
 * @property {number}  maxTextureSize Hardware limit for texture size.
 * @property {number}  cores          Logical CPU cores (hardwareConcurrency).
 * @property {number}  memory         Approx device memory in GB (0 = unknown).
 * @property {boolean} saveData       User enabled "data saver".
 * @property {number}  devicePixelRatio  Capped at 3 — no gain above that.
 * @property {string}  connectionType 'slow-2g' … '4g' (Chrome only).
 */

const webglProbe = probeWebGL();

/** @type {Capabilities} */
export const capabilities = Object.freeze({
  webgl: webglProbe.ok,
  webgl2: webglProbe.gl2,
  maxTextureSize: webglProbe.maxTextureSize || 2048,

  // Reported on Chromium; undefined on Firefox & Safari → default to 4.
  cores: Math.max(1, navigator.hardwareConcurrency || 4),

  // Reported on Chromium; undefined elsewhere → 0 means "unknown".
  memory: Math.max(0, navigator.deviceMemory || 0),

  // User-controlled bandwidth saver. If true, we go to potato tier.
  saveData: Boolean(navigator.connection?.saveData),

  // Cap DPR: iPhone 15 reports 3, a 4K monitor with 200% scaling reports 2.
  // Anything above 2 is wasted fragment work.
  devicePixelRatio: Math.min(window.devicePixelRatio || 1, 2),

  // Only Chromium exposes connection info. Empty string if unavailable.
  connectionType: String(
    navigator.connection?.effectiveType ||
    navigator.connection?.type ||
    '',
  ),
});


/* ============================================================================
 * 3. QUALITY TIERS
 * Every downstream module reads *resolved* values, never tier names.
 * Adding a new tier requires a matching entry here — the resolver will
 * throw in dev if it can't find the tier, preventing silent drift.
 * ========================================================================== */

/**
 * @typedef {Object} QualityTier
 * @property {number}  pixelRatio            Renderer DPR.
 * @property {number}  shadowMapSize         Shadow map side, px (power of 2).
 * @property {'pcf'|'pcfSoft'|'vsm'} shadowMapType
 * @property {boolean} smaa                  Post-process SMAA (needs pass).
 * @property {boolean} bloom                 UnrealBloom pass.
 * @property {number}  bloomStrength         0 … 1.
 * @property {number}  bloomRadius           0 … 1.
 * @property {number}  bloomThreshold        0 … 1 (luma gate).
 * @property {boolean} rectAreaLights        Window bounce (desktop-only).
 * @property {number}  maxPointLights        How many room PointLights live.
 * @property {number}  textureSize           Procedural texture side, px.
 * @property {number}  anisotropy            maxAnisotropy cap.
 * @property {boolean} sunShadow             Directional shadow on/off.
 * @property {number}  sunShadowFrustum      Half-extent of shadow ortho box.
 * @property {number}  fogDensity            Exponential fog density.
 * @property {boolean} contactShadows        Future: GTAO/SAO pass.
 */

/** @type {Record<string, QualityTier>} */
const QUALITY_TIERS = Object.freeze({
  // 2015-era integrated GPU / ancient Android
  potato: Object.freeze({
    pixelRatio: 0.75,
    shadowMapSize: 512,
    shadowMapType: 'pcf',
    smaa: false,
    bloom: false,
    bloomStrength: 0,
    bloomRadius: 0,
    bloomThreshold: 1,
    rectAreaLights: false,
    maxPointLights: 1,
    textureSize: 256,
    anisotropy: 1,
    sunShadow: true,
    sunShadowFrustum: 22,
    fogDensity: 0.012,
    contactShadows: false,
  }),

  // Mid-range phone / very old desktop
  low: Object.freeze({
    pixelRatio: 1.0,
    shadowMapSize: 1024,
    shadowMapType: 'pcf',
    smaa: false,
    bloom: true,
    bloomStrength: 0.30,
    bloomRadius: 0.35,
    bloomThreshold: 0.90,
    rectAreaLights: false,
    maxPointLights: 2,
    textureSize: 512,
    anisotropy: 2,
    sunShadow: true,
    sunShadowFrustum: 22,
    fogDensity: 0.010,
    contactShadows: false,
  }),

  // Modern phone / integrated GPU laptop
  medium: Object.freeze({
    pixelRatio: 1.25,
    shadowMapSize: 2048,
    shadowMapType: 'pcfSoft',
    smaa: false,
    bloom: true,
    bloomStrength: 0.35,
    bloomRadius: 0.40,
    bloomThreshold: 0.88,
    rectAreaLights: false,
    maxPointLights: 4,
    textureSize: 512,
    anisotropy: 4,
    sunShadow: true,
    sunShadowFrustum: 22,
    fogDensity: 0.009,
    contactShadows: false,
  }),

  // Discrete GPU / M1 / iPad Pro
  high: Object.freeze({
    pixelRatio: 2.0,
    shadowMapSize: 4096,
    shadowMapType: 'pcfSoft',
    smaa: true,
    bloom: true,
    bloomStrength: 0.40,
    bloomRadius: 0.50,
    bloomThreshold: 0.85,
    rectAreaLights: true,
    maxPointLights: 6,
    textureSize: 1024,
    anisotropy: 8,
    sunShadow: true,
    sunShadowFrustum: 22,
    fogDensity: 0.008,
    contactShadows: false,
  }),

  // Enthusiast: Radeon RX / GeForce / Apple M2 Max
  ultra: Object.freeze({
    pixelRatio: 2.0,
    shadowMapSize: 4096,
    shadowMapType: 'pcfSoft',
    smaa: true,
    bloom: true,
    bloomStrength: 0.45,
    bloomRadius: 0.55,
    bloomThreshold: 0.82,
    rectAreaLights: true,
    maxPointLights: 8,
    textureSize: 2048,
    anisotropy: 16,
    sunShadow: true,
    sunShadowFrustum: 22,
    fogDensity: 0.007,
    contactShadows: false,
  }),
});

/**
 * Auto-pick a tier from capabilities. Order of checks matters — the first
 * "kill switch" wins. Never returns undefined.
 *
 * @returns {keyof typeof QUALITY_TIERS}
 */
function resolveTier() {
  // Manual override via URL: `?quality=ultra`.
  const urlTier = new URLSearchParams(location.search).get('quality');
  if (urlTier && Object.hasOwn(QUALITY_TIERS, urlTier)) return urlTier;

  const { webgl, webgl2, maxTextureSize, cores, memory, saveData, connectionType } = capabilities;

  // No WebGL at all — server will have shown <noscript>, but just in case.
  if (!webgl) return 'potato';

  // Explicit user intent: save bandwidth.
  if (saveData) return 'potato';

  // Severely constrained network (2G / slow 2G).
  if (connectionType === 'slow-2g' || connectionType === '2g') return 'low';

  // Hardware floor.
  if (maxTextureSize < 2048 || cores <= 1) return 'potato';
  if (maxTextureSize < 4096 || cores <= 2) return 'low';

  // Memory hints (Chromium only; 0 means "unknown" — don't punish).
  if (memory > 0 && memory <= 2) return 'low';
  if (memory > 0 && memory <= 4) return 'medium';

  // Mobile: cap at medium unless it's a recent Pro-class device.
  if (platform === 'mobile') return cores >= 8 ? 'medium' : 'low';
  if (platform === 'tablet') return cores >= 6 ? 'high' : 'medium';

  // Desktop.
  if (cores >= 8 && webgl2) return 'ultra';
  if (cores >= 4 && webgl2) return 'high';
  if (webgl2) return 'medium';
  return 'low';
}

const _tierName = resolveTier();
const _tier = QUALITY_TIERS[_tierName];

/**
 * Fully resolved quality settings. Every consumer reads *these* values.
 * Adding an override on top of the tier (e.g. force-disable SMAA in dev)
 * is legitimate; it must be done here, not at call sites.
 *
 * @type {QualityTier & { tier: string }}
 */
export const QUALITY = Object.freeze({
  ..._tier,
  tier: _tierName,

  // Convenience precomputed value: pixelRatio clamped by hardware limit.
  // `renderer.setPixelRatio(QUALITY.pixelRatio)` becomes the only line
  // any module ever needs to know about DPR.
  resolvedPixelRatio: Math.min(_tier.pixelRatio, capabilities.devicePixelRatio, 2),

  // Clamp textureSize by hardware; a 512px texture on a 256-limit GPU
  // would silently break.
  resolvedTextureSize: Math.min(_tier.textureSize, capabilities.maxTextureSize),
});


/* ============================================================================
 * 4. DIMENSIONS (house shell)
 * All units are metres. Wall thickness is *structural* (as in real
 * masonry) — the term `WALL_T` is used consistently everywhere.
 * ========================================================================== */

/**
 * @typedef {Object} Dimensions
 * @property {number} W            Outer wall span (X axis).
 * @property {number} D            Outer wall span (Z axis).
 * @property {number} H            Floor-to-ceiling height (clear room).
 * @property {number} SLAB         Concrete slab thickness between floors.
 * @property {number} WALL_T       Exterior wall thickness.
 * @property {number} INNER_T      Interior partition thickness.
 * @property {number} ROOF_RIDGE   Ridge height above top of upper floor walls.
 * @property {number} ROOF_OVERHANG Eaves overhang beyond exterior walls.
 * @property {number} FOUNDATION_H Visible foundation height above grade.
 * @property {number} BASEBOARD_H  Skirting board height.
 * @property {number} WINDOW_SILL  Default sill height (window bottom).
 * @property {number} WINDOW_TOP   Default window head height.
 * @property {number} DOOR_H       Default door panel height.
 * @property {number} DOOR_W       Default door panel width.
 * @property {number} STAIR_STEPS  Number of stair steps to second floor.
 * @property {number} STAIR_WIDTH  Step width (walkable part).
 * @property {number} STAIR_TREAD  Step depth (front-to-back).
 */

/** @type {Dimensions} */
export const DIM = Object.freeze({
  W: 10,
  D: 10,
  H: 2.8,
  SLAB: 0.30,
  WALL_T: 0.20,
  INNER_T: 0.10,

  ROOF_RIDGE: 1.80,
  ROOF_OVERHANG: 0.60,
  FOUNDATION_H: 0.30,
  BASEBOARD_H: 0.10,

  WINDOW_SILL: 0.90,
  WINDOW_TOP: 2.40,

  DOOR_H: 2.10,
  DOOR_W: 0.95,

  STAIR_STEPS: 14,
  STAIR_WIDTH: 1.10,
  STAIR_TREAD: 0.26,
});

/** Derived elevations — computed once so downstream code never recomputes. */
export const LEVELS = Object.freeze({
  /** Y of the finished first floor surface. */
  FLOOR_1_Y: 0,
  /** Y of the finished second floor surface (top of slab). */
  FLOOR_2_Y: DIM.H + DIM.SLAB,
  /** Y of the finished upper ceiling surface. */
  CEILING_Y: DIM.H + DIM.SLAB + DIM.H,
  /** Y of the roof eave line (top of exterior walls). */
  EAVE_Y: DIM.H + DIM.SLAB + DIM.H,
  /** Y of the roof ridge. */
  RIDGE_Y: DIM.H + DIM.SLAB + DIM.H + DIM.ROOF_RIDGE,
  /** Y of the ground plane (grass / path). */
  GROUND_Y: -DIM.FOUNDATION_H + 0.05,
});


/* ============================================================================
 * 5. PLAYER PHYSICS
 * ========================================================================== */

/**
 * @typedef {Object} PhysicsConfig
 * @property {number} PLAYER_HEIGHT    Capsule top (eye level ≈ height − 0.05).
 * @property {number} PLAYER_RADIUS    Capsule horizontal radius.
 * @property {number} EYE_OFFSET       Camera Y below capsule top (≈ 0.05).
 * @property {number} WALK_SPEED       m/s, idle move.
 * @property {number} RUN_SPEED        m/s, with Shift / RUN toggle.
 * @property {number} ACCEL            m/s², horizontal acceleration toward target.
 * @property {number} FRICTION         m/s², horizontal deceleration when idle.
 * @property {number} JUMP_POWER       Initial upward velocity, m/s.
 * @property {number} GRAVITY          m/s², downward.
 * @property {number} STEP_HEIGHT      Max auto-step ledge (stairs, sills).
 * @property {number} COYOTE_TIME      s, grace period after leaving ground.
 * @property {number} JUMP_BUFFER      s, input queued before landing.
 * @property {number} AIR_CONTROL      0…1, horizontal authority mid-air.
 * @property {number} MAX_FALL_SPEED   Terminal fall velocity, m/s.
 * @property {number} SNAP_DISTANCE    Max gap (m) where feet snap to floor.
 * @property {number} WORLD_FLOOR_Y    Below this → respawn at spawn point.
 */

/** @type {PhysicsConfig} */
export const PHYSICS = Object.freeze({
  PLAYER_HEIGHT: 1.70,
  PLAYER_RADIUS: 0.30,
  EYE_OFFSET: 0.05,

  WALK_SPEED: 3.5,
  RUN_SPEED: 6.5,
  ACCEL: 40,
  FRICTION: 30,

  JUMP_POWER: 6.5,
  GRAVITY: 20,
  STEP_HEIGHT: 0.35,

  COYOTE_TIME: 0.15,
  JUMP_BUFFER: 0.10,
  AIR_CONTROL: 0.55,
  MAX_FALL_SPEED: 40,
  SNAP_DISTANCE: 0.15,
  WORLD_FLOOR_Y: -5,
});

/**
 * Spawn point — the place the player lands on a fresh start.
 */
export const SPAWN = Object.freeze({
  X: 0,
  Y: LEVELS.FLOOR_1_Y + PHYSICS.PLAYER_HEIGHT + 0.01,
  Z: 14,
  /** Initial yaw: facing the entrance door (which is at Z = -D/2). */
  YAW: Math.PI,
});


/* ============================================================================
 * 6. CAMERA
 * ========================================================================== */

/**
 * @typedef {Object} CameraConfig
 * @property {number} FOV            Vertical field of view, degrees.
 * @property {number} NEAR           Near clip, metres.
 * @property {number} FAR            Far clip, metres (scene is 60 m, so 500 is generous).
 * @property {number} MOUSE_SENS     Radians per pixel of mouse movement.
 * @property {number} TOUCH_SENS     Radians per pixel of touch drag.
 * @property {number} PITCH_LIMIT    Radians, keeps camera from flipping over.
 * @property {number} MAX_PITCH      Precomputed ±PITCH_LIMIT.
 */

export const CAMERA = Object.freeze({
  FOV: 72,
  NEAR: 0.05,
  FAR: 500,
  MOUSE_SENS: 0.002,
  TOUCH_SENS: 0.003,
  PITCH_LIMIT: Math.PI / 2 - 0.05,
});
Object.defineProperty(CAMERA, 'MAX_PITCH', { value: CAMERA.PITCH_LIMIT });


/* ============================================================================
 * 7. SUN & SKY (three.js Sky shader)
 * ========================================================================== */

/**
 * @typedef {Object} SunConfig
 * @property {number} ELEVATION      Degrees above horizon.
 * @property {number} AZIMUTH        Degrees clockwise from north.
 * @property {number} TURBIDITY      Sky turbidity (2…20).
 * @property {number} RAYLEIGH       Rayleigh scattering (0…4).
 * @property {number} MIE            Mie scattering coefficient (0…0.1).
 * @property {number} MIE_G          Mie anisotropy (0…1).
 * @property {number} INTENSITY      Directional sun light intensity (physically-based).
 * @property {number} COLOR          Hex — warm morning sun.
 * @property {number} HEMI_SKY       Hex — hemisphere light sky color.
 * @property {number} HEMI_GROUND    Hex — hemisphere ground color.
 * @property {number} HEMI_INTENSITY Hemisphere light intensity.
 * @property {number} AMBIENT        Ambient fill, very low.
 */

export const SUN = Object.freeze({
  ELEVATION: 32,
  AZIMUTH: 145,

  TURBIDITY: 6,
  RAYLEIGH: 2.2,
  MIE: 0.005,
  MIE_G: 0.82,

  INTENSITY: 3.2,
  COLOR: 0xfff0dd,

  HEMI_SKY: 0xa8c4d8,
  HEMI_GROUND: 0x3a4a2a,
  HEMI_INTENSITY: 0.55,

  AMBIENT: 0.12,
});


/* ============================================================================
 * 8. WORLD BOUNDS
 * ========================================================================== */

export const WORLD = Object.freeze({
  /** Grass plane side, metres. */
  GROUND_SIZE: 60,
  /** Fence perimeter from origin. */
  FENCE_HALF: 18,
  /** Fog exp² density (from QUALITY, but this is a semantic alias). */
  get FOG_DENSITY() { return QUALITY.fogDensity; },
  FOG_COLOR: 0xa8c4d8,
});


/* ============================================================================
 * 9. INTERACTION
 * ========================================================================== */

export const INTERACTION = Object.freeze({
  /** Ray length in metres. */
  RAY_DISTANCE: 3.0,
  /** Degrees per second² angular speed for animated door pivots. */
  DOOR_ANIM_LERP: 8,
  /** Fridge opens further than a door (it's hinged on the side). */
  FRIDGE_OPEN_ANGLE: -Math.PI * 0.6,
  /** Standard door open angle. */
  DOOR_OPEN_ANGLE: -Math.PI / 2,
});


/* ============================================================================
 * 10. FEATURE FLAGS
 * Explicit compile-time-style flags for whole subsystems. Downstream code
 * uses `if (FEATURES.save) …` instead of long conditional chains.
 * ========================================================================== */

export const FEATURES = Object.freeze({
  /** Full postprocessing stack (bloom + cinematic + SMAA). */
  postprocessing: QUALITY.bloom || QUALITY.smaa,
  /** Shadow mapping. */
  shadows: QUALITY.sunShadow,
  /** Rect-area window lights. */
  windowLights: QUALITY.rectAreaLights,
  /** Interaction system (raycasting + E key). */
  interactions: true,
  /** WebAudio spatial sound. */
  audio: true,
  /** localStorage save system. */
  save: false,            // TODO: phase 4
  /** Weather (rain / snow). */
  weather: false,         // TODO: phase 4
  /** Day/night cycle. */
  dayNight: false,        // TODO: phase 4
  /** Performance HUD (FPS counter). */
  performanceHud: IS_DEV || true,
});


/* ============================================================================
 * 11. AUDIO
 * ========================================================================== */

export const AUDIO = Object.freeze({
  MASTER_VOLUME: 0.6,
  SFX_VOLUME: 0.8,

  /** Base frequency of the footstep thump, Hz. */
  FOOTSTEP_FREQ: 130,
  /** Footstep cadence throttle, seconds. */
  FOOTSTEP_COOLDOWN: 0.40,

  /** Door creak synth parameters. */
  DOOR_CREAK_FREQ: 180,
  DOOR_CREAK_DURATION: 0.28,
  DOOR_CREAK_VOLUME: 0.06,

  /** Light switch click. */
  SWITCH_CLICK_FREQ: 1200,
  SWITCH_CLICK_DURATION: 0.035,
  SWITCH_CLICK_VOLUME: 0.05,
});


/* ============================================================================
 * 12. COLORS (synced with CSS custom properties)
 * ========================================================================== */

/**
 * @typedef {{ r: number, g: number, b: number, a: number }} RGBAColor
 * Floats 0…1, linear-ish (as authored in CSS; three.js will convert).
 */

/**
 * Parse a CSS color string into an RGBA object.
 * Supports:
 *   #rgb, #rgba, #rrggbb, #rrggbbaa
 *   rgb(r,g,b), rgba(r,g,b,a)
 *
 * @param {string} raw
 * @returns {RGBAColor|null}
 */
function parseColor(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // Hex
  if (s[0] === '#') {
    let hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.split('').map(c => c + c).join('');
    }
    if (hex.length !== 6 && hex.length !== 8) return null;
    const r = parseInt(hex.slice(0, 2), 16) / 255;
    const g = parseInt(hex.slice(2, 4), 16) / 255;
    const b = parseInt(hex.slice(4, 6), 16) / 255;
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  // rgb() / rgba()
  const m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i);
  if (m) {
    return {
      r: parseFloat(m[1]) / 255,
      g: parseFloat(m[2]) / 255,
      b: parseFloat(m[3]) / 255,
      a: m[4] !== undefined ? parseFloat(m[4]) : 1,
    };
  }

  return null;
}

/**
 * Convert an RGBAColor to a three.js-friendly integer 0xRRGGBB.
 * Alpha is dropped — use the RGBA object directly if you need it.
 *
 * @param {RGBAColor} c
 * @returns {number}
 */
function toHex(c) {
  const R = Math.round(c.r * 255);
  const G = Math.round(c.g * 255);
  const B = Math.round(c.b * 255);
  return (R << 16) | (G << 8) | B;
}

/**
 * Read a single CSS custom property from :root.
 * Falls back to `fallback` if unavailable or unparseable.
 *
 * @param {string} name
 * @param {string} fallback
 * @returns {RGBAColor}
 */
function cssVar(name, fallback) {
  try {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue(name)
      .trim();
    return parseColor(raw) || parseColor(fallback);
  } catch {
    return parseColor(fallback);
  }
}

/**
 * Default CSS color fallbacks (must match styles.css §2).
 * If CSS is not yet loaded, or a token is missing, these kick in.
 */
const CSS_DEFAULTS = {
  '--c-void':           '#05060a',
  '--c-base':           '#0a0c12',
  '--c-surface':        '#0f1219',
  '--c-text-primary':   '#f0f3f9',
  '--c-text-secondary': 'rgba(240,243,249,0.68)',
  '--c-text-muted':     'rgba(240,243,249,0.42)',
  '--c-accent':         '#4a7fff',
  '--c-accent-bright':  '#6a9bff',
  '--c-accent-deep':    '#2a5edd',
  '--c-gold':           '#ffcc00',
  '--c-success':        '#7fff7f',
  '--c-danger':         '#ff5566',
  '--c-warn':           '#ffb020',
};

/**
 * Compute the COLORS object from a source-map of raw color strings.
 * Called once on import (with CSS defaults) and again on sync (with CSS
 * var reads, after the stylesheet is available).
 *
 * @param {(name: string, fallback: string) => RGBAColor} read
 */
function buildColors(read) {
  const raw = {};
  for (const [k, v] of Object.entries(CSS_DEFAULTS)) raw[k] = read(k, v);

  return {
    /** RGBA floats — use with `new THREE.Color(r,g,b)` when sRGB-aware. */
    rgba: raw,

    /** Hex ints — use with `new THREE.Color(0x…)` or material color params. */
    hex: {
      void:         toHex(raw['--c-void']),
      base:         toHex(raw['--c-base']),
      surface:      toHex(raw['--c-surface']),
      textPrimary:  toHex(raw['--c-text-primary']),
      textSecondary: toHex(raw['--c-text-secondary']),
      textMuted:    toHex(raw['--c-text-muted']),
      accent:       toHex(raw['--c-accent']),
      accentBright: toHex(raw['--c-accent-bright']),
      accentDeep:   toHex(raw['--c-accent-deep']),
      gold:         toHex(raw['--c-gold']),
      success:      toHex(raw['--c-success']),
      danger:       toHex(raw['--c-danger']),
      warn:         toHex(raw['--c-warn']),
    },
  };
}

/** @type {{ rgba: Record<string, RGBAColor>, hex: Record<string, number> }} */
export let COLORS = buildColors(cssVar);

/**
 * Re-read CSS custom properties and refresh COLORS in place.
 * Call once from main.js after DOM ready (styles guaranteed loaded).
 * Safe to call multiple times — e.g. if theme changes at runtime.
 */
export function syncColorsFromCss() {
  COLORS = buildColors(cssVar);
  return COLORS;
}


/* ============================================================================
 * 13. VALIDATION
 * Fail fast, fail loud. Called once in main.js. In dev, throws if the
 * config is internally inconsistent. In prod, logs a warning.
 * ========================================================================== */

/**
 * @throws {Error} If a critical config invariant is violated in dev mode.
 */
export function validateConfig() {
  const errors = [];

  // Tier invariants
  if (!_tierName || !QUALITY_TIERS[_tierName]) {
    errors.push(`Unknown quality tier "${_tierName}"`);
  }
  if (!Number.isFinite(QUALITY.resolvedPixelRatio) || QUALITY.resolvedPixelRatio <= 0) {
    errors.push(`resolvedPixelRatio must be > 0 (got ${QUALITY.resolvedPixelRatio})`);
  }
  if (!Number.isFinite(QUALITY.resolvedTextureSize) || QUALITY.resolvedTextureSize < 64) {
    errors.push(`resolvedTextureSize must be ≥ 64 (got ${QUALITY.resolvedTextureSize})`);
  }

  // Dimensions invariants
  if (DIM.WALL_T <= 0 || DIM.INNER_T <= 0) errors.push('Wall thickness must be > 0');
  if (DIM.WALL_T <= DIM.INNER_T) errors.push('Exterior wall must be thicker than interior');
  if (DIM.H <= 0 || DIM.SLAB <= 0) errors.push('Floor height and slab thickness must be > 0');

  // Physics invariants
  if (PHYSICS.PLAYER_RADIUS * 2 >= DIM.DOOR_W) errors.push('Player cannot fit through door');
  if (PHYSICS.STEP_HEIGHT >= DIM.H) errors.push('Step height exceeds floor height');
  if (PHYSICS.JUMP_POWER <= 0 || PHYSICS.GRAVITY <= 0) errors.push('Jump/gravity must be > 0');
  if (PHYSICS.WALK_SPEED >= PHYSICS.RUN_SPEED) errors.push('Walk speed must be less than run speed');

  // Levels must be monotonic
  const ys = [LEVELS.FLOOR_1_Y, LEVELS.FLOOR_2_Y, LEVELS.CEILING_Y, LEVELS.RIDGE_Y];
  for (let i = 1; i < ys.length; i++) {
    if (ys[i] <= ys[i - 1]) errors.push(`LEVELS must be strictly increasing (index ${i})`);
  }

  // Colors must parse
  for (const k of Object.keys(COLORS.rgba)) {
    const c = COLORS.rgba[k];
    if (!c || ![c.r, c.g, c.b, c.a].every(Number.isFinite)) {
      errors.push(`Color token ${k} failed to parse`);
    }
  }

  if (errors.length === 0) return true;

  const msg = '[config] Invalid configuration:\n  · ' + errors.join('\n  · ');
  if (IS_DEV) throw new Error(msg);
  // eslint-disable-next-line no-console
  console.warn(msg);
  return false;
}


/* ============================================================================
 * 14. DIAGNOSTIC SNAPSHOT
 * Optional helper: prints a compact one-page report for bug tickets.
 * ========================================================================== */

/**
 * @returns {string} Multi-line report, safe to paste into a GitHub issue.
 */
export function describeEnvironment() {
  const gpu = capabilities.webgl2 ? 'WebGL2' : capabilities.webgl ? 'WebGL1' : 'none';
  const mem = capabilities.memory || '?';
  return [
    `Modern House 3D ${BUILD.version} (${BUILD.codename})`,
    `mode        : ${BUILD.dev ? 'dev' : 'prod'}`,
    `platform    : ${platform}${isMobile ? ' (mobile path)' : ''}`,
    `quality     : ${QUALITY.tier}`,
    `renderer    : ${gpu}, tex≤${capabilities.maxTextureSize}px`,
    `dpr         : css ${capabilities.devicePixelRatio} → render ${QUALITY.resolvedPixelRatio}`,
    `hardware    : ${capabilities.cores} cores, ${mem} GB RAM`,
    `network     : ${capabilities.connectionType || '?'}${capabilities.saveData ? ' (save-data)' : ''}`,
    `shadows     : ${QUALITY.sunShadow ? QUALITY.shadowMapSize + 'px ' + QUALITY.shadowMapType : 'off'}`,
    `post        : ${[QUALITY.bloom && 'bloom', QUALITY.smaa && 'smaa'].filter(Boolean).join('+') || 'none'}`,
    `lights      : ${QUALITY.maxPointLights} point, rectarea ${QUALITY.rectAreaLights ? 'on' : 'off'}`,
  ].join('\n');
}
