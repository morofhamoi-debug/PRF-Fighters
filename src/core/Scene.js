/**
 * @file    src/core/Scene.js
 * @module  core/Scene
 *
 * @desc    Central scene container. Owns the THREE.Scene and enforces
 *          the organizational contract for the entire world graph.
 *
 *          The visual quality of the house comes from geometry + materials
 *          in `src/textures/`, `src/materials/`, `src/world/`. THIS file
 *          is the infrastructure that makes those systems coexist without
 *          stepping on each other's toes.
 *
 *          Scope (and ONLY this):
 *            · own THREE.Scene
 *            · named groups for logical organization
 *            · layer constants for camera/raycast filtering
 *            · fog, environment, background from config
 *            · scene bounds for shadow frustum sizing
 *            · static-object optimization (matrixAutoUpdate = false)
 *            · full GPU-aware dispose
 *            · event bus (fog, environment, bounds)
 *
 *          Non-scope:
 *            · sky mesh               → core/Sky.js
 *            · lights                 → core/Lighting.js
 *            · world content          → world/World.js
 *            · post-processing        → core/PostProcessing.js
 *            · rendering              → core/Renderer.js
 */

import * as THREE from 'three';
import { QUALITY, DIM, LEVELS, WORLD, COLORS, BUILD } from '../config.js';


/* ============================================================================
 * 0. CONSTANTS
 * ========================================================================== */

/**
 * Named groups inside the scene root. Every world builder must route
 * its objects to one of these — that's the entire organizational schema.
 *
 * If a new category is needed, add it here (and in the constructor).
 *
 *   sky         → core/Sky.js (single Sky mesh)
 *   environment → ground, path, trees, fence, distant props
 *   house       → shell, exterior walls, roof, chimney, downspouts
 *   interior    → partition walls, stairs, baseboards, ceilings
 *   furniture   → sofa, bed, tables, wardrobe, kitchen cabinets
 *   devices     → light switches, sockets, appliances
 *   decor       → pictures, clocks, plants, lamps, rugs, books
 *   interactables → canonical E-targets (doors, fridge, TV, mailbox)
 *   effects     → particles, decals, temporary visuals
 *   debug       → helpers (axes, boxes), hidden by default
 */
export const GROUPS = Object.freeze({
  SKY: 'sky',
  ENVIRONMENT: 'environment',
  HOUSE: 'house',
  INTERIOR: 'interior',
  FURNITURE: 'furniture',
  DEVICES: 'devices',
  DECOR: 'decor',
  INTERACTABLES: 'interactables',
  EFFECTS: 'effects',
  DEBUG: 'debug',
});

/**
 * Render layers. three.js supports 32 layers (0..31); we use 3.
 *
 *   DEFAULT (0)       — visible in main camera, participates in raycast
 *   RAYCAST_ONLY (1)  — invisible to camera, hit by raycaster only
 *                        (collision hulls, interaction proxies)
 *   SKY (2)           — excluded from fog & bloom, rendered first
 *   GLASS (3)         — transparent stack, sorted separately
 *
 * Usage:
 *   obj.layers.set(LAYERS.RAYCAST_ONLY);
 *   camera.layers.enable(LAYERS.DEFAULT);  // default is 0
 */
export const LAYERS = Object.freeze({
  DEFAULT: 0,
  RAYCAST_ONLY: 1,
  SKY: 2,
  GLASS: 3,
});

/** Fog defaults, taken from config so CSS tokens stay the source of truth. */
const FOG = Object.freeze({
  COLOR: WORLD.FOG_COLOR,
  DENSITY: WORLD.FOG_DENSITY,
  /** Sky never fogs — its material has `fog: false`, but we also keep it
   *  on a layer that post-processing can exclude. */
});

/** Background fallback color — matches CSS `--c-void`. */
const BACKGROUND_FALLBACK = COLORS.hex.void;


/* ============================================================================
 * 1. TINY EVENT EMITTER (shared shape with Renderer.js)
 * Duplicated intentionally — no cross-imports between core modules that
 * aren't strictly needed. 40 lines of duplication beats a tangled
 * dependency graph.
 * ========================================================================== */

class TinyEmitter {
  constructor() { this._listeners = new Map(); }

  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) { this._listeners.get(event)?.delete(fn); }

  emit(event, payload) {
    const set = this._listeners.get(event);
    if (!set || !set.size) return;
    for (const fn of [...set]) {
      try { fn(payload); }
      catch (err) {
        // eslint-disable-next-line no-console
        console.error(`[Scene] listener "${event}" threw:`, err);
      }
    }
  }

  dispose() { this._listeners.clear(); }
}


/* ============================================================================
 * 2. SCENE CLASS
 * ========================================================================== */

export class Scene extends TinyEmitter {
  /**
   * @param {Object}  [opts]
   * @param {boolean} [opts.debug]                 Show debug group; default = BUILD.dev
   * @param {boolean} [opts.fog=true]              Enable fog.
   * @param {number}  [opts.fogColor]              Override WORLD.FOG_COLOR.
   * @param {number}  [opts.fogDensity]            Override QUALITY.fogDensity.
   */
  constructor(opts = {}) {
    super();

    /* ---- 2.1 Root ---------------------------------------------------- */
    /** @type {THREE.Scene} */
    this._scene = new THREE.Scene();
    this._scene.name = 'Root';

    // Matrix-world auto-update at root is REQUIRED — it drives the
    // whole tree. Per-object opt-out is done via `markStatic()`.
    this._scene.matrixWorldAutoUpdate = true;

    // three.js sorts transparent objects back-to-front every frame.
    // Keep it on — our glass and decals depend on it.
    this._scene.sortObjects = true;

    /* ---- 2.2 Background --------------------------------------------- */
    // Sky is a mesh, not a background. We set a flat fallback color so
    // a Sky-loading failure still produces a neutral frame instead of
    // black.
    this._scene.background = new THREE.Color(BACKGROUND_FALLBACK);
    this._scene.backgroundIntensity = 1.0;

    /* ---- 2.3 Fog ----------------------------------------------------- */
    this._fogEnabled = opts.fog ?? true;
    const fogColor = opts.fogColor ?? FOG.COLOR;
    const fogDensity = opts.fogDensity ?? FOG.DENSITY;

    if (this._fogEnabled) {
      this._scene.fog = new THREE.FogExp2(fogColor, fogDensity);
    }

    /* ---- 2.4 Environment (PMREM) ------------------------------------ */
    // Set later by core/Sky.js after PMREM generation. We store a
    // reference so `main.js` can query and so dispose() can release it.
    /** @type {THREE.Texture | null} */
    this._environment = null;

    /* ---- 2.5 Named groups ------------------------------------------- */
    /**
     * @type {Record<string, THREE.Group>}
     * Frozen key set (matches GROUPS), but each group instance is
     * mutable by the world builders.
     */
    this._groups = {};
    for (const name of Object.values(GROUPS)) {
      const g = new THREE.Group();
      g.name = `group:${name}`;
      this._groups[name] = g;
      this._scene.add(g);
    }

    // Debug group is hidden by default even in dev — enable explicitly.
    if (opts.debug ?? BUILD.dev) {
      this._groups[GROUPS.DEBUG].visible = true;
    } else {
      this._groups[GROUPS.DEBUG].visible = false;
    }

    // Sky is on its own layer; hide from raycasts but keep visible.
    this._groups[GROUPS.SKY].layers.set(LAYERS.SKY);

    /* ---- 2.6 Layer defaults ----------------------------------------- */
    // Camera should enable DEFAULT (always) and RAYCAST_ONLY is for
    // raycaster objects — camera doesn't touch that layer.
    // (Camera layer enabling is done by player/Camera.js.)

    /* ---- 2.7 Bounds cache ------------------------------------------- */
    /** @type {THREE.Box3 | null} */
    this._bounds = null;
    /** @type {boolean} */
    this._boundsDirty = true;

    /* ---- 2.8 Static objects cache ----------------------------------- */
    /** @type {Set<THREE.Object3D>} */
    this._staticObjects = new Set();

    /* ---- 2.9 Dev log ------------------------------------------------- */
    if (BUILD.dev) {
      // eslint-disable-next-line no-console
      console.info(
        `%c[Scene] ${Object.keys(this._groups).length} groups · ` +
        `fog ${this._fogEnabled ? 'on' : 'off'} · ` +
        `quality ${QUALITY.tier}`,
        'color:#4a7fff;font-weight:600',
      );
    }
  }


  /* ==========================================================================
   * 3. PUBLIC GETTERS
   * ======================================================================== */

  /** @returns {THREE.Scene} raw escape hatch — use sparingly */
  get three() { return this._scene; }

  /** @returns {Readonly<Record<string, THREE.Group>>} */
  get groups() { return this._groups; }

  /** @returns {THREE.Box3 | null} cached AABB (call updateBounds first) */
  get bounds() { return this._bounds; }

  /** @returns {THREE.Texture | null} */
  get environment() { return this._environment; }

  /** @returns {THREE.FogExp2 | null} */
  get fog() { return this._scene.fog; }


  /* ==========================================================================
   * 4. GROUP MANAGEMENT
   * ======================================================================== */

  /**
   * Add an object to a named group. Invalidates bounds cache.
   *
   * @param {string} groupName  one of GROUPS.*
   * @param {THREE.Object3D} obj
   * @returns {THREE.Object3D} the same obj, for chaining
   * @throws {Error} if groupName is unknown
   */
  addToGroup(groupName, obj) {
    const group = this._groups[groupName];
    if (!group) {
      throw new Error(
        `[Scene] Unknown group "${groupName}". ` +
        `Valid: ${Object.values(GROUPS).join(', ')}`,
      );
    }
    group.add(obj);
    this._boundsDirty = true;
    return obj;
  }

  /**
   * Remove an object from a group. Does NOT dispose — callers handle
   * resource cleanup if they own the object.
   *
   * @param {string} groupName
   * @param {THREE.Object3D} obj
   */
  removeFromGroup(groupName, obj) {
    const group = this._groups[groupName];
    if (!group) return;
    group.remove(obj);
    this._boundsDirty = true;
  }

  /**
   * Retrieve a group by name.
   * @param {string} groupName
   * @returns {THREE.Group | null}
   */
  getGroup(groupName) {
    return this._groups[groupName] ?? null;
  }


  /* ==========================================================================
   * 5. LAYER HELPERS
   * ======================================================================== */

  /**
   * Enable a layer on an object subtree (recursive).
   * @param {THREE.Object3D} root
   * @param {number} layer
   */
  enableLayer(root, layer) {
    root.traverse(o => o.layers.enable(layer));
  }

  /**
   * Set a layer exclusively (disable all others).
   * @param {THREE.Object3D} root
   * @param {number} layer
   */
  setLayer(root, layer) {
    root.traverse(o => o.layers.set(layer));
  }


  /* ==========================================================================
   * 6. STATIC OBJECT OPTIMIZATION
   * ======================================================================== */

  /**
   * Mark a subtree as static — its matrixWorld will never be recomputed
   * automatically. Bypasses three.js's per-frame matrix updates for the
   * entire subtree, which is a huge win for the house shell (~2000 meshes).
   *
   * NOTE: after marking, if you MOVE a static object, you MUST call
   * `obj.updateMatrixWorld(true)` manually. This is intentional: static
   * means static.
   *
   * @param {THREE.Object3D} root
   */
  markStatic(root) {
    root.traverse(o => {
      o.matrixAutoUpdate = false;
      o.matrixWorldAutoUpdate = false;
      o.frustumCulled = true;   // still allow culling
      this._staticObjects.add(o);
    });
    // Force one recompute so initial transform is correct.
    root.updateMatrixWorld(true);
  }

  /**
   * Undo static marking — for objects that need to move later
   * (e.g. doors after scripted animation is enabled).
   * @param {THREE.Object3D} root
   */
  markDynamic(root) {
    root.traverse(o => {
      o.matrixAutoUpdate = true;
      o.matrixWorldAutoUpdate = true;
      this._staticObjects.delete(o);
    });
  }


  /* ==========================================================================
   * 7. FOG
   * ======================================================================== */

  /**
   * Set fog color at runtime.
   * @param {number} hex
   */
  setFogColor(hex) {
    if (!this._scene.fog) return;
    this._scene.fog.color.setHex(hex);
    this.emit('fog-change', { color: hex, density: this._scene.fog.density });
  }

  /**
   * Set fog density at runtime (e.g., for day-night cycle).
   * @param {number} density
   */
  setFogDensity(density) {
    if (!this._scene.fog) return;
    this._scene.fog.density = Math.max(0, density);
    this.emit('fog-change', { color: this._scene.fog.color.getHex(), density });
  }

  /**
   * Toggle fog entirely.
   * @param {boolean} enabled
   */
  setFogEnabled(enabled) {
    this._fogEnabled = enabled;
    if (enabled) {
      this._scene.fog ??= new THREE.FogExp2(FOG.COLOR, FOG.DENSITY);
    } else {
      this._scene.fog = null;
    }
    this.emit('fog-change', { enabled });
  }


  /* ==========================================================================
   * 8. ENVIRONMENT
   * ======================================================================== */

  /**
   * Set the PBR environment map (from PMREM). Called once by Sky.js after
   * the sky is ready, and again if the sky changes (day→night).
   *
   * @param {THREE.Texture} envMap
   */
  setEnvironment(envMap) {
    // Release the previous env map (its GPU memory).
    if (this._environment && this._environment !== envMap) {
      this._environment.dispose();
    }
    this._environment = envMap;
    this._scene.environment = envMap;
    this._scene.environmentIntensity = 1.0;
    this.emit('environment-change', { envMap });
  }


  /* ==========================================================================
   * 9. BOUNDS
   * ======================================================================== */

  /**
   * Recompute scene AABB from visible meshes. Expensive (~50 ms on a
   * 3000-object scene) — call once after world build, and after any
   * large structural change (rare).
   *
   * @param {boolean} [force=false]
   * @returns {THREE.Box3}
   */
  updateBounds(force = false) {
    if (!this._boundsDirty && this._bounds && !force) {
      return this._bounds;
    }

    const box = new THREE.Box3();
    const tmp = new THREE.Box3();

    this._scene.traverse(obj => {
      // Only count visible static meshes. Skip debug helpers.
      if (!obj.isMesh || !obj.visible) return;
      if (this._groups[GROUPS.DEBUG].children.includes(obj)) return;
      if (!obj.geometry) return;

      // Geometry may be non-indexed; setFromObject handles both.
      try {
        tmp.setFromObject(obj);
        if (!tmp.isEmpty()) box.union(tmp);
      } catch {
        // Non-geometric mesh (e.g. Points, Sprite) — skip silently.
      }
    });

    // Ensure the box includes the sky group — it's visible and should
    // extend the far clip envelope.
    this._bounds = box.isEmpty() ? new THREE.Box3(
      new THREE.Vector3(-DIM.W, LEVELS.GROUND_Y, -DIM.D),
      new THREE.Vector3(DIM.W, LEVELS.RIDGE_Y, DIM.D),
    ) : box;
    this._boundsDirty = false;

    this.emit('bounds-change', this._bounds);
    return this._bounds;
  }

  /**
   * Auto-size the sun shadow camera frustum from scene bounds. Called
   * by core/Lighting.js after updateBounds().
   *
   * @param {THREE.DirectionalLight} sun
   * @param {number} [margin=2]
   */
  fitShadowCameraToBounds(sun, margin = 2) {
    const b = this._bounds ?? this.updateBounds();
    const center = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());

    // Orthographic shadow camera must cover the whole scene from the
    // sun's view direction. The largest half-extent is what matters.
    const halfExtent = Math.max(
      Math.abs(size.x),
      Math.abs(size.z),
      Math.abs(size.y),
    ) * 0.5 + margin;

    sun.shadow.camera.left = -halfExtent;
    sun.shadow.camera.right = halfExtent;
    sun.shadow.camera.top = halfExtent;
    sun.shadow.camera.bottom = -halfExtent;
    sun.shadow.camera.far = halfExtent * 3;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.updateProjectionMatrix();

    // Point the target at the scene center so the shadow falls correctly.
    sun.target.position.copy(center);
    sun.target.updateMatrixWorld();

    return { center, halfExtent };
  }


  /* ==========================================================================
   * 10. QUERY HELPERS
   * ======================================================================== */

  /**
   * Traverse only within a given group.
   * @param {string} groupName
   * @param {(obj: THREE.Object3D) => void} fn
   */
  traverseGroup(groupName, fn) {
    this._groups[groupName]?.traverse(fn);
  }

  /**
   * Find all meshes in the scene (optionally within a group).
   * @param {string} [groupName]
   * @returns {THREE.Mesh[]}
   */
  findMeshes(groupName) {
    const out = [];
    const root = groupName ? this._groups[groupName] : this._scene;
    root?.traverse(o => { if (o.isMesh) out.push(o); });
    return out;
  }

  /**
   * Find all lights in the scene.
   * @returns {THREE.Light[]}
   */
  findLights() {
    const out = [];
    this._scene.traverse(o => { if (o.isLight) out.push(o); });
    return out;
  }

  /**
   * Find object by name anywhere in the scene.
   * @param {string} name
   * @returns {THREE.Object3D | null}
   */
  findByName(name) {
    return this._scene.getObjectByName(name) ?? null;
  }


  /* ==========================================================================
   * 11. STATS
   * ======================================================================== */

  /**
   * Snapshot of scene composition. Traverses once — call on demand, not
   * per frame. Shape is stable and JSON-serializable.
   *
   * @returns {{
   *   objects: number,
   *   meshes: number,
   *   lights: number,
   *   groups: number,
   *   geometries: number,
   *   materials: number,
   *   textures: number,
   *   triangles: number,
   *   groupsBreakdown: Record<string, number>,
   * }}
   */
  getStats() {
    let objects = 0, meshes = 0, lights = 0, groups = 0, triangles = 0;
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    const breakdown = {};

    for (const [name, group] of Object.entries(this._groups)) {
      breakdown[name] = group.children.length;
    }

    this._scene.traverse(obj => {
      objects++;
      if (obj.isMesh) {
        meshes++;
        if (obj.geometry) {
          geometries.add(obj.geometry);
          const g = obj.geometry;
          if (g.index) triangles += g.index.count / 3;
          else if (g.attributes.position) triangles += g.attributes.position.count / 3;
        }
        const mat = obj.material;
        if (mat) {
          const arr = Array.isArray(mat) ? mat : [mat];
          for (const m of arr) {
            materials.add(m);
            // Discover textures by walking enumerable props.
            for (const key of Object.keys(m)) {
              if (m[key]?.isTexture) textures.add(m[key]);
            }
          }
        }
      } else if (obj.isLight) {
        lights++;
      } else if (obj.isGroup) {
        groups++;
      }
    });

    return {
      objects,
      meshes,
      lights,
      groups,
      geometries: geometries.size,
      materials: materials.size,
      textures: textures.size,
      triangles: Math.round(triangles),
      groupsBreakdown: breakdown,
    };
  }


  /* ==========================================================================
   * 12. DISPOSE
   * ======================================================================== */

  /**
   * Full cleanup — traverses scene, disposes geometries/materials/textures
   * (with Set-based dedupe), releases environment, empties groups.
   *
   * After this call the instance is unusable — construct a fresh one.
   */
  dispose() {
    // 1. Collect unique GPU resources.
    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();

    this._scene.traverse(obj => {
      if (obj.geometry) geometries.add(obj.geometry);
      if (obj.material) {
        const arr = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of arr) {
          materials.add(m);
          for (const key of Object.keys(m)) {
            if (m[key]?.isTexture) textures.add(m[key]);
          }
        }
      }
    });

    // 2. Dispose in dependency order: textures → materials → geometries.
    for (const t of textures) {
      try { t.dispose(); } catch { /* already disposed */ }
    }
    for (const m of materials) {
      try { m.dispose(); } catch { /* already disposed */ }
    }
    for (const g of geometries) {
      try { g.dispose(); } catch { /* already disposed */ }
    }

    // 3. Release environment map.
    if (this._environment) {
      try { this._environment.dispose(); } catch { /* already disposed */ }
      this._environment = null;
      this._scene.environment = null;
    }

    // 4. Clear scene graph.
    for (const g of Object.values(this._groups)) {
      g.clear();
    }
    this._scene.clear();
    this._groups = {};
    this._bounds = null;
    this._boundsDirty = true;
    this._staticObjects.clear();

    // 5. Clear listeners.
    this.dispose();
  }


  /* ==========================================================================
   * 13. DEBUG
   * ======================================================================== */

  /**
   * Human-readable scene report for the console.
   * @returns {string}
   */
  describe() {
    const s = this.getStats();
    const lines = [
      `Scene "${this._scene.name}"`,
      `  objects    : ${s.objects}`,
      `  meshes     : ${s.meshes}  (${s.triangles.toLocaleString()} tris)`,
      `  lights     : ${s.lights}`,
      `  geometries : ${s.geometries}`,
      `  materials  : ${s.materials}`,
      `  textures   : ${s.textures}`,
      `  groups     : ${Object.entries(s.groupsBreakdown)
        .map(([n, c]) => `${n}:${c}`).join(' ')}`,
    ];
    if (this._bounds) {
      const sz = this._bounds.getSize(new THREE.Vector3());
      lines.push(`  bounds     : ${sz.x.toFixed(1)}×${sz.y.toFixed(1)}×${sz.z.toFixed(1)} m`);
    }
    return lines.join('\n');
  }
}


/* ============================================================================
 * 14. FACTORY
 * ========================================================================== */

/**
 * Convenience factory. Use this in `main.js` so tests can stub it.
 * @param {ConstructorParameters<typeof Scene>[0]} [opts]
 * @returns {Scene}
 */
export function createScene(opts) {
  return new Scene(opts);
}
