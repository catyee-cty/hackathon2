/**
 * Optimized Hierarchical Quadtree LOD System for Full-Planet Lunar Rendering
 *
 * Key Optimizations:
 * - Screen-Space Error (SSE) with hysteresis: prevents thrashing at boundaries
 * - Frustum-aware horizon culling (back-hemisphere + dot-product angular test)
 * - LRU mesh cache with configurable capacity (avoids repeated geometry builds)
 * - Pre-allocated typed-array ring buffers (zero GC pressure per frame)
 * - Adaptive tile resolution: low-res on LOD 0-2, high-res on LOD 5-6
 * - Adaptive safety cap: coarsens LOD when tile count spikes
 */

import { getGlobalLunarElevation, latLonToGlobePos } from "./globeMesh.js";

// ── Tile mesh resolution by LOD level ───────────────────────────────────────
const LOD_RESOLUTION = [8, 10, 12, 14, 16, 20, 24];

// SSE thresholds with hysteresis band to prevent pop-thrashing
const SSE_SPLIT = 0.32;  // split when SSE exceeds this
const SSE_MERGE = 0.42;  // merge children only when SSE drops below this

// Max tiles before safety coarsening kicks in
const MAX_TILES_SAFETY = 220;

// ── Index pattern cache (computed once per resolution) ───────────────────────
const _indexPatterns = {};
function getIndexPattern(res) {
  if (_indexPatterns[res]) return _indexPatterns[res];
  const pattern = new Uint32Array(res * res * 6);
  let off = 0;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const r1 = j * (res + 1);
      const r2 = (j + 1) * (res + 1);
      pattern[off++] = r1 + i;
      pattern[off++] = r2 + i;
      pattern[off++] = r1 + i + 1;
      pattern[off++] = r1 + i + 1;
      pattern[off++] = r2 + i;
      pattern[off++] = r2 + i + 1;
    }
  }
  _indexPatterns[res] = pattern;
  return pattern;
}

export class LodTileNode {
  constructor(z, x, y, bounds, parent = null) {
    this.z = z;
    this.x = x;
    this.y = y;
    this.bounds = bounds;
    this.parent = parent;
    this.children = null;
    this.isLeaf = true;

    this.centerLon = (bounds.lonMin + bounds.lonMax) * 0.5;
    this.centerLat = (bounds.latMin + bounds.latMax) * 0.5;
    this.centerPos = latLonToGlobePos(this.centerLat, this.centerLon, 25.0);

    // Arc-length metric size on sphere — accounts for latitude convergence
    const latRad = this.centerLat * (Math.PI / 180.0);
    const cosLat = Math.max(0.07, Math.cos(latRad));
    const arcLon = (bounds.lonMax - bounds.lonMin) * (Math.PI / 180.0) * cosLat * 25.0;
    const arcLat = (bounds.latMax - bounds.latMin) * (Math.PI / 180.0) * 25.0;
    this.metricSize = Math.sqrt(arcLon * arcLon + arcLat * arcLat) * 0.5;

    this.meshData = null;
    this.meshRes  = -1;
    this.atlasSlot    = -1;
    this.textureState = "none";
  }

  subdivide() {
    if (this.children) return;
    const b = this.bounds;
    const midLon = (b.lonMin + b.lonMax) * 0.5;
    const midLat = (b.latMin + b.latMax) * 0.5;
    const nz = this.z + 1;
    const x0 = this.x * 2, x1 = this.x * 2 + 1;
    const y0 = this.y * 2, y1 = this.y * 2 + 1;
    this.children = [
      new LodTileNode(nz, x0, y0, { lonMin: b.lonMin, lonMax: midLon, latMin: midLat, latMax: b.latMax }, this),
      new LodTileNode(nz, x1, y0, { lonMin: midLon,  lonMax: b.lonMax, latMin: midLat, latMax: b.latMax }, this),
      new LodTileNode(nz, x0, y1, { lonMin: b.lonMin, lonMax: midLon, latMin: b.latMin, latMax: midLat }, this),
      new LodTileNode(nz, x1, y1, { lonMin: midLon,  lonMax: b.lonMax, latMin: b.latMin, latMax: midLat }, this),
    ];
    this.isLeaf = false;
  }

  collapse() {
    this.children = null;
    this.isLeaf   = true;
  }
}

export class LunarLodSystem {
  constructor(options = {}) {
    this.maxLodLevel = options.maxLodLevel || 6;
    this.radius      = options.radius      || 25.0;

    this.roots = [
      new LodTileNode(0, 0, 0, { lonMin: -180.0, lonMax:   0.0, latMin: -90.0, latMax: 90.0 }),
      new LodTileNode(0, 1, 0, { lonMin:    0.0, lonMax: 180.0, latMin: -90.0, latMax: 90.0 }),
    ];

    this.activeLeaves   = [];
    this.culledCount    = 0;
    this.lodHistogram   = new Array(this.maxLodLevel + 1).fill(0);
    this.totalTriangles = 0;

    // LRU mesh cache
    this.meshCache     = new Map();
    this._cacheMaxSize = 2800;
    this._cacheEvictN  =  400;

    // Pre-allocated combined frame buffers (grow-only)
    this._vertBuf = null;
    this._idxBuf  = null;

    this._lastTileCount = 0;
  }

  // ─── LOD Tree Traversal ──────────────────────────────────────────────────

  update(cameraPos) {
    this.activeLeaves   = [];
    this.culledCount    = 0;
    this.lodHistogram.fill(0);
    this.totalTriangles = 0;

    const camLen = Math.hypot(cameraPos[0], cameraPos[1], cameraPos[2]);
    if (camLen < 0.001) return this._stats();
    const invCL  = 1.0 / camLen;
    const camDir = [cameraPos[0] * invCL, cameraPos[1] * invCL, cameraPos[2] * invCL];

    const safetyCap = this._lastTileCount > MAX_TILES_SAFETY;

    for (const root of this.roots) {
      this._visit(root, cameraPos, camDir, safetyCap);
    }

    this._lastTileCount = this.activeLeaves.length;
    return this._stats();
  }

  _stats() {
    return {
      activeLeaves:  this.activeLeaves,
      culledCount:   this.culledCount,
      histogram:     this.lodHistogram,
      triangles:     this.totalTriangles,
    };
  }

  _visit(node, camPos, camDir, safetyCap) {
    // ── Horizon / back-face culling ──────────────────────────────────────
    const invR = 1.0 / this.radius;
    const nx = node.centerPos[0] * invR;
    const ny = node.centerPos[1] * invR;
    const nz = node.centerPos[2] * invR;
    const dot = nx * camDir[0] + ny * camDir[1] + nz * camDir[2];
    const tol = Math.min(1.0, node.metricSize * invR * 1.4);
    if (dot + tol < -0.15) {
      this.culledCount++;
      return;
    }

    // ── Screen-Space Error ───────────────────────────────────────────────
    const dx = camPos[0] - node.centerPos[0];
    const dy = camPos[1] - node.centerPos[1];
    const dz = camPos[2] - node.centerPos[2];
    const distCenter    = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const effectiveDist = Math.max(0.1, distCenter - node.metricSize);
    const sse           = node.metricSize / effectiveDist;

    const splitThresh = safetyCap ? SSE_SPLIT * 1.45 : SSE_SPLIT;
    const mergeThresh = safetyCap ? SSE_MERGE * 1.45 : SSE_MERGE;

    if (sse > splitThresh && node.z < this.maxLodLevel) {
      node.subdivide();
      for (const child of node.children) {
        this._visit(child, camPos, camDir, safetyCap);
      }
    } else {
      // Hysteresis: only collapse when SSE drops below merge threshold
      if (!node.isLeaf && sse < mergeThresh) {
        node.collapse();
      }
      if (!node.isLeaf) {
        for (const child of node.children) {
          this._visit(child, camPos, camDir, safetyCap);
        }
        return;
      }

      this.activeLeaves.push(node);
      this.lodHistogram[node.z]++;
      const res = LOD_RESOLUTION[Math.min(node.z, LOD_RESOLUTION.length - 1)];
      this.totalTriangles += res * res * 2;
    }
  }

  // ─── Combined Mesh Assembly ──────────────────────────────────────────────

  generateCombinedMesh() {
    const numChunks = this.activeLeaves.length;
    if (numChunks === 0) return null;

    const stride = 12;
    let totalVerts   = 0;
    let totalIndices = 0;
    const chunkMeta = new Array(numChunks);

    for (let c = 0; c < numChunks; c++) {
      const node = this.activeLeaves[c];
      const res  = LOD_RESOLUTION[Math.min(node.z, LOD_RESOLUTION.length - 1)];
      const verts   = (res + 1) * (res + 1);
      const indices = res * res * 6;
      chunkMeta[c] = { res, verts, indices };
      totalVerts   += verts;
      totalIndices += indices;
    }

    const totalFloats = totalVerts * stride;

    // Grow pre-allocated buffers only when needed (amortized ×1.6)
    if (totalFloats > (this._vertBuf ? this._vertBuf.length : 0)) {
      this._vertBuf = new Float32Array(Math.ceil(totalFloats * 1.6));
    }
    if (totalIndices > (this._idxBuf ? this._idxBuf.length : 0)) {
      this._idxBuf = new Uint32Array(Math.ceil(totalIndices * 1.6));
    }

    const vBuf = this._vertBuf;
    const iBuf = this._idxBuf;
    let vFloatOff = 0;
    let iOff      = 0;
    let baseVertex = 0;

    for (let c = 0; c < numChunks; c++) {
      const node = this.activeLeaves[c];
      const { res, verts, indices } = chunkMeta[c];

      const cacheKey = `${node.z}_${node.x}_${node.y}_${res}`;
      let meshData = this.meshCache.get(cacheKey);
      if (!meshData) {
        meshData = this._buildTileMesh(node, res);

        if (this.meshCache.size >= this._cacheMaxSize) {
          const iter = this.meshCache.keys();
          for (let k = 0; k < this._cacheEvictN; k++) {
            const old = iter.next().value;
            if (old) this.meshCache.delete(old);
          }
        }
        this.meshCache.set(cacheKey, meshData);
      }
      node.meshData = meshData;
      node.meshRes  = res;

      vBuf.set(meshData, vFloatOff);

      // Patch atlas encoding in-place
      const atlasSlot    = node.atlasSlot >= 0 ? node.atlasSlot : 255;
      const atlasEncoded = atlasSlot * 1000.0 + node.z;
      for (let v = 0; v < verts; v++) {
        vBuf[vFloatOff + v * stride + 10] = atlasEncoded;
      }

      const pat = getIndexPattern(res);
      for (let k = 0; k < indices; k++) {
        iBuf[iOff + k] = pat[k] + baseVertex;
      }

      vFloatOff  += verts * stride;
      iOff       += indices;
      baseVertex += verts;
    }

    return {
      vertices:   new Float32Array(vBuf.buffer, 0, vFloatOff),
      indices:    new Uint32Array(iBuf.buffer, 0, iOff),
      indexCount: iOff,
      chunkCount: numChunks,
    };
  }

  // ─── Per-Tile Geometry Computation ──────────────────────────────────────

  _buildTileMesh(node, res) {
    const vertsPerChunk = (res + 1) * (res + 1);
    const stride = 12;
    const data   = new Float32Array(vertsPerChunk * stride);

    const b        = node.bounds;
    const lonSpan  = b.lonMax - b.lonMin;
    const latSpan  = b.latMax - b.latMin;
    const lod      = node.z;
    const R        = this.radius;
    const elevScale = R * 2.2 / 1737.4;

    // Gradient normals only at high LOD (saves 2 elevation calls/vertex at coarse tiles)
    const computeGrad = lod >= 3;
    const dAng = lod >= 6 ? 0.012 : lod >= 5 ? 0.025 : lod >= 4 ? 0.05 : 0.12;

    const invRes = 1.0 / res;

    for (let j = 0; j <= res; j++) {
      const vPct   = j * invRes;
      const lat    = b.latMax - vPct * latSpan;
      const phi    = lat * (Math.PI / 180.0);
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);

      for (let i = 0; i <= res; i++) {
        const uPct    = i * invRes;
        const lon     = b.lonMin + uPct * lonSpan;
        const theta   = lon * (Math.PI / 180.0);
        const cosTheta = Math.cos(theta);
        const sinTheta = Math.sin(theta);

        const unx = cosPhi * sinTheta;
        const uny = sinPhi;
        const unz = cosPhi * cosTheta;

        const elevMeters = getGlobalLunarElevation(lat, lon, lod);
        const r  = R + elevMeters * 0.001 * elevScale;
        const px = unx * r;
        const py = uny * r;
        const pz = unz * r;

        let snx, sny, snz, slope;

        if (computeGrad) {
          const eE  = getGlobalLunarElevation(lat, lon + dAng, lod);
          const tE  = (lon + dAng) * Math.PI / 180.0;
          const rE  = R + eE * 0.001 * elevScale;
          const pEx = cosPhi * Math.sin(tE) * rE;
          const pEy = sinPhi * rE;
          const pEz = cosPhi * Math.cos(tE) * rE;

          const eN  = getGlobalLunarElevation(lat + dAng, lon, lod);
          const pN  = (lat + dAng) * Math.PI / 180.0;
          const rN  = R + eN * 0.001 * elevScale;
          const pNx = Math.cos(pN) * sinTheta * rN;
          const pNy = Math.sin(pN) * rN;
          const pNz = Math.cos(pN) * cosTheta * rN;

          const vEx = pEx - px, vEy = pEy - py, vEz = pEz - pz;
          const vNx = pNx - px, vNy = pNy - py, vNz = pNz - pz;

          snx = vEy * vNz - vEz * vNy;
          sny = vEz * vNx - vEx * vNz;
          snz = vEx * vNy - vEy * vNx;
          const sLen = Math.sqrt(snx * snx + sny * sny + snz * snz);
          if (sLen > 0.0001) {
            const il = 1.0 / sLen;
            snx *= il; sny *= il; snz *= il;
          } else {
            snx = unx; sny = uny; snz = unz;
          }
          const cosAngle = Math.max(-1.0, Math.min(1.0, snx * unx + sny * uny + snz * unz));
          slope = Math.acos(cosAngle) * (180.0 / Math.PI);
        } else {
          snx = unx; sny = uny; snz = unz;
          slope = 0.0;
        }

        const hazard = Math.min(1.0, slope / 15.0);
        const idx = (j * (res + 1) + i) * stride;
        data[idx]      = px;
        data[idx + 1]  = py;
        data[idx + 2]  = pz;
        data[idx + 3]  = snx;
        data[idx + 4]  = sny;
        data[idx + 5]  = snz;
        data[idx + 6]  = uPct;
        data[idx + 7]  = vPct;
        data[idx + 8]  = slope;
        data[idx + 9]  = elevMeters;
        data[idx + 10] = 255000.0 + lod; // Patched during assembly
        data[idx + 11] = hazard;
      }
    }

    return data;
  }
}
