/**
 * Tile Material Cache — Per-Tile Texture Manager for Multi-Level LOD
 *
 * Priority hierarchy for each tile:
 *   1. NASA LRO WAC WMTS (LOD 0-5)   — real photographic imagery, CORS-enabled
 *   2. NASA LOLA shade WMTS (LOD 0-4) — elevation colour shading fallback
 *   3. Procedural regolith (any LOD)  — synthesized from LOLA elevation derivatives
 *
 * Atlas layout:
 *   4096×4096 RGBA texture → 16×16 grid of 256×256 tile slots (256 slots total)
 *   Slot index: row*16 + col (0-255)
 *   UV for slot s: origin = (col/16, row/16), size = (1/16, 1/16)
 */

import { generateProceduralRegolith } from "./proceduralRegolith.js";
import { NASA_TILE_SOURCES } from "./nasaTiles.js";

export const ATLAS_COLS = 16;
export const ATLAS_ROWS = 16;
export const ATLAS_SLOTS = ATLAS_COLS * ATLAS_ROWS; // 256 slots (covers all visible leaves)
export const TILE_PX = 256; // 256×256 px matching NASA standard
export const ATLAS_PX = ATLAS_COLS * TILE_PX; // 4096×4096

/** State enum for each tile slot */
export const TileState = Object.freeze({
  EMPTY:      "empty",
  PENDING:    "pending",
  NASA:       "nasa",
  PROCEDURAL: "procedural",
  ERROR:      "error"
});

export class TileMaterialCache {
  constructor() {
    // key → { state, bitmap, slotIndex, lodLevel }
    this.tiles = new Map();

    // Persistent key → slot index cache across node lifecycle
    this.slotCache = new Map();

    // Pool of free atlas slot indices
    this.freeSlots = Array.from({ length: ATLAS_SLOTS }, (_, i) => ATLAS_SLOTS - 1 - i);
    // Which tile key occupies each slot
    this.slotOwner = new Array(ATLAS_SLOTS).fill(null);

    // LRU eviction order (most recently used first)
    this.lruOrder = [];

    // Pending fetch promises, keyed by tile key
    this.pendingFetches = new Map();

    // Work queue for smooth rate-limited background processing
    this.workQueue = [];
    this.isProcessingQueue = false;

    // Callback when a tile texture is downloaded or synthesized and ready
    this.onTileReady = null;
  }

  /** Build a canonical tile key */
  static key(node) {
    return `${node.z}_${node.x}_${node.y}`;
  }

  /** Return existing entry or null */
  get(node) {
    return this.tiles.get(TileMaterialCache.key(node)) || null;
  }

  /** Return assigned slot for a node, if any */
  getSlot(node) {
    const k = TileMaterialCache.key(node);
    if (this.slotCache.has(k)) {
      return this.slotCache.get(k);
    }
    const entry = this.tiles.get(k);
    return (entry && entry.slotIndex >= 0) ? entry.slotIndex : -1;
  }

  /** Request a tile — starts rate-limited background load if not cached */
  request(node, { sunAzimuthDeg = 135, sunAltitudeDeg = 15, sourceId = "lro_wac" } = {}) {
    const k = TileMaterialCache.key(node);
    if (this.tiles.has(k)) {
      this._touchLru(k);
      const existing = this.tiles.get(k);
      if (this.slotCache.has(k)) {
        existing.slotIndex = this.slotCache.get(k);
      }
      return existing;
    }

    // Mark as pending immediately so we don't double-fetch
    const entry = { state: TileState.PENDING, bitmap: null, slotIndex: -1, lodLevel: node.z };
    this.tiles.set(k, entry);

    // Enqueue for smooth background synthesis
    this._enqueueFetch(node, k, entry, { sunAzimuthDeg, sunAltitudeDeg, sourceId });
    return entry;
  }

  _enqueueFetch(node, key, entry, options) {
    this.workQueue.push({ node, key, entry, options });
    this._processQueue();
  }

  async _processQueue() {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.workQueue.length > 0) {
      // Sort queue each pass: highest LOD (closest) first
      if (this.workQueue.length > 1) {
        this.workQueue.sort((a, b) => b.node.z - a.node.z);
      }

      // Process up to 3 tiles concurrently per batch for faster fill-in
      const batch = this.workQueue.splice(0, Math.min(3, this.workQueue.length));
      await Promise.all(batch.map(item =>
        this._fetchTile(item.node, item.key, item.entry, item.options)
      ));

      // Yield a brief slice to maintain frame rate
      if (this.workQueue.length > 0) {
        await new Promise(r => setTimeout(r, 2));
      }
    }

    this.isProcessingQueue = false;
  }

  async _fetchTile(node, key, entry, { sunAzimuthDeg, sunAltitudeDeg, sourceId }) {
    if (this.pendingFetches.has(key)) return;
    this.pendingFetches.set(key, true);

    let bitmap = null;
    let isNasa = false;

    try {
      bitmap = await this._tryNasaFetch(node, sourceId);
      isNasa = true;
    } catch (_) {
      // NASA fetch unavailable or offline — generate high-speed procedural regolith
      try {
        bitmap = await generateProceduralRegolith(node.bounds, node.z, sunAzimuthDeg, sunAltitudeDeg);
      } catch (err) {
        console.warn("[TileMaterialCache] Procedural generation failed:", err);
        entry.state = TileState.ERROR;
        this.pendingFetches.delete(key);
        return;
      }
    }

    // Acquire an atlas slot
    const slot = this._acquireSlot(key);
    entry.bitmap = bitmap;
    entry.slotIndex = slot;
    entry.state = isNasa ? TileState.NASA : TileState.PROCEDURAL;

    this.pendingFetches.delete(key);
    this._touchLru(key);

    if (this.onTileReady && slot >= 0) {
      this.onTileReady(node, entry);
    }
  }

  /**
   * Try to fetch real NASA WMTS tile for this LOD node.
   * Uses WAC mosaic (global, all zoom levels) first.
   */
  async _tryNasaFetch(node, sourceId) {
    const source = NASA_TILE_SOURCES.find(s => s.id === sourceId) || NASA_TILE_SOURCES[0];
    const zoom = Math.min(node.z, source.maxZoom);
    const url = source.getUrl(zoom, node.x, node.y);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1400);

    try {
      const res = await fetch(url, { mode: "cors", signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      return await createImageBitmap(blob);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  }

  /** Acquire a free atlas slot, evicting LRU if necessary */
  _acquireSlot(key) {
    if (this.freeSlots.length > 0) {
      const slot = this.freeSlots.pop();
      this.slotOwner[slot] = key;
      this.slotCache.set(key, slot);
      return slot;
    }

    // Evict least recently used slot
    for (let i = this.lruOrder.length - 1; i >= 0; i--) {
      const evictKey = this.lruOrder[i];
      if (evictKey === key) continue;
      const entry = this.tiles.get(evictKey);
      if (entry && entry.slotIndex >= 0 && entry.state !== TileState.PENDING) {
        const slot = entry.slotIndex;
        entry.slotIndex = -1;
        entry.state = TileState.EMPTY;
        this.slotOwner[slot] = key;
        this.slotCache.delete(evictKey);
        this.slotCache.set(key, slot);
        this.lruOrder.splice(i, 1);
        return slot;
      }
    }

    return -1;
  }

  _touchLru(key) {
    const idx = this.lruOrder.indexOf(key);
    if (idx !== -1) this.lruOrder.splice(idx, 1);
    this.lruOrder.unshift(key);
  }

  /** Mark tile slot as uploaded */
  markUploaded(node, slot) {
    const k = TileMaterialCache.key(node);
    const entry = this.tiles.get(k);
    if (entry) {
      entry.slotIndex = slot;
      this.slotOwner[slot] = k;
      this.slotCache.set(k, slot);
    }
  }

  /** Compute atlas UV offset for a slot */
  static slotUVOffset(slot) {
    const col = slot % ATLAS_COLS;
    const row = Math.floor(slot / ATLAS_COLS);
    return [col / ATLAS_COLS, row / ATLAS_ROWS];
  }
}
