/**
 * Main Application Orchestrator for Selene-GPU Lunar Site Navigator
 * Integrates WebGPU Pipelines, Terrain Geometry, Interactive Camera, Telemetry HUD, and Controls.
 * Max-resolution LOD: NASA WAC tiles (LOD 0-3) → NASA tiles + procedural regolith atlas (LOD 4-6)
 */

import { WebGPUContext } from "./engine/gpuContext.js";
import { createTerrainMesh, getLunarHeight } from "./engine/terrainMesh.js";
import { createGlobeMesh, getGlobalLunarElevation, latLonToGlobePos } from "./engine/globeMesh.js";
import { LunarLodSystem } from "./engine/lodSystem.js";
import { LunarCamera } from "./engine/camera.js";
import { LUNAR_SITES } from "./engine/lunarSites.js";
import { RoverPathPlanner } from "./engine/pathPlanner.js";
import { FallbackRenderer } from "./engine/fallbackRenderer.js";
import { NasaTileService, NASA_TILE_SOURCES } from "./engine/nasaTiles.js";
import { TileMaterialCache, ATLAS_COLS, ATLAS_ROWS, ATLAS_SLOTS, TILE_PX, ATLAS_PX, TileState } from "./engine/tileMaterialCache.js";
import { Vec3 } from "./engine/math.js";
import { MissionSiteScanner, DEFAULT_MISSION_REQUIREMENTS, MISSION_PRESETS } from "./engine/missionScanner.js";

class LunarApp {
  constructor() {
    this.canvas = document.getElementById('webgpu-canvas');
    this.gpuCtx = new WebGPUContext(this.canvas);
    this.camera = new LunarCamera(this.canvas);
    this.pathPlanner = new RoverPathPlanner();
    this.nasaTileService = new NasaTileService();
    this.missionScanner = new MissionSiteScanner();
    this.latestScanResults = null;
    this.locationMappingEnabled = true; // Location Mapping active on Normal PBR Viewer
    this.targetSiteLat = -89.9;
    this.targetSiteLon = 0.0;
    this.targetSiteStatus = 0; // 0: Prime, 1: Marginal, 2: Excluded
    this.tileCache = new TileMaterialCache();
    this.tileCache.onTileReady = (node, entry) => {
      if (this.viewTarget === 'globe' && entry.bitmap && entry.slotIndex >= 0 && this.gpuCtx.device) {
        this._uploadTileToAtlas(entry.bitmap, entry.slotIndex);
        node.atlasSlot = entry.slotIndex;
        // Update active leaf if it exists
        if (this.lodSystem && this.lodSystem.activeLeaves) {
          for (const leaf of this.lodSystem.activeLeaves) {
            if (leaf.z === node.z && leaf.x === node.x && leaf.y === node.y) {
              leaf.atlasSlot = entry.slotIndex;
            }
          }
        }
        const combined = this.lodSystem.generateCombinedMesh();
        if (combined && this.lodVertexBuffer) {
          if (combined.vertices.byteLength <= this.lodVertexBuffer.size && combined.indices.byteLength <= this.lodIndexBuffer.size) {
            this.gpuCtx.device.queue.writeBuffer(this.lodVertexBuffer, 0, combined.vertices);
            this.gpuCtx.device.queue.writeBuffer(this.lodIndexBuffer, 0, combined.indices);
            this.lodIndexCount = combined.indexCount;
          }
        }
      }
    };
    this.lodSystem = new LunarLodSystem({ radius: 25.0, maxLodLevel: 6 });
    this.fallbackRenderer = null;
    this.useFallback = false;

    // View Target: 'globe' | 'site'
    this.viewTarget = 'globe';
    this.sites = LUNAR_SITES;

    // Mission State
    this.selectedSite = LUNAR_SITES[0];
    this.shadingMode = 0;
    this.sunAzimuthDeg = 45.0;
    this.sunAltitudeDeg = 28.0;
    this.isSunAnimated = false;
    this.earthshineEnabled = true;
    this.wireframeEnabled = false;

    // NASA Real Tile Streamer State
    this.useRealNasaTile = true;
    this.currentTileSourceId = 'lro_wac';
    this.tileZoomLevel = 4;
    this.currentTileBitmap = null;

    // GPU Meshes & Buffers
    this.globeMesh = null;
    this.globeVertexBuffer = null;
    this.globeIndexBuffer = null;

    this.siteMesh = null;
    this.siteVertexBuffer = null;
    this.siteIndexBuffer = null;
    this.terrainMesh = null;

    // Dynamic Quadtree LOD Buffers
    this.lodVertexBuffer = null;
    this.lodIndexBuffer = null;
    this.lodIndexCount = 0;
    this.lastLodCamPos = [9999, 9999, 9999];

    this.vertexBuffer = null;
    this.indexBuffer = null;
    this.uniformBuffer = null;
    this.terrainBindGroup = null;

    // Global NASA mosaic texture (LOD 0-3, 1024×512)
    this.globalTexture = null;
    // Per-tile atlas texture (LOD 4-6, 2048×2048 → 4×4 grid of 512×512 slots)
    this.atlasTexture = null;
    this.tileSampler = null;

    // Track which atlas slots have been uploaded this frame
    this.pendingAtlasUploads = new Set(); // Set<slotIndex>

    this.skyboxVertexBuffer = null;
    this.skyboxUniformBuffer = null;
    this.skyboxBindGroup = null;

    // Compute Buffers
    this.computeParamBuffer = null;
    this.elevationStorageBuffer = null;
    this.hazardStorageBuffer = null;
    this.computeBindGroup = null;

    // Performance telemetry
    this.lastTime = performance.now();
    this.frameCount = 0;
    this.fpsTimer = 0;
    this.fpsEma = 60.0; // exponential moving average FPS

    this.init();
  }

  async init() {
    const statusEl = document.getElementById('engine-status');

    try {
      statusEl.textContent = 'DETECTING WEBGPU...';
      const info = await this.gpuCtx.initialize();
      statusEl.textContent = `WEBGPU READY (${info.vendor || 'ACTIVE'})`;
      statusEl.classList.remove('highlight');
      statusEl.style.color = 'var(--accent-green)';

      this.setupTerrainGeometry();
      this.setupSkyboxGeometry();
      this.setupComputeBuffers();
      this.setupUI();
      this.bindWindowEvents();
      this.updateLod();

      // Stream initial real NASA LRO global mosaic
      this.streamNasaTile(this.selectedSite);

      requestAnimationFrame((t) => this.renderLoop(t));
    } catch (err) {
      console.warn("[WebGPU Init Fallback Triggered]", err);
      this.useFallback = true;
      this.fallbackRenderer = new FallbackRenderer(this.canvas);

      statusEl.textContent = 'WEBGPU SIMULATION (FALLBACK)';
      statusEl.classList.remove('highlight');
      statusEl.style.color = 'var(--accent-amber)';

      this.setupUI();
      this.bindWindowEvents();
      this.updateLod();
      this.streamNasaTile(this.selectedSite);
      this.showFallbackDiagnostics(err.message);

      requestAnimationFrame((t) => this.renderLoop(t));
    }
  }

  setupTerrainGeometry() {
    const device = this.gpuCtx.device;

    // 1. Spherical Moon Globe Mesh (96 lat × 192 lon)
    this.globeMesh = createGlobeMesh(25.0, 96, 192);
    this.globeVertexBuffer = device.createBuffer({
      label: 'Globe Vertex Buffer',
      size: this.globeMesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(this.globeVertexBuffer, 0, this.globeMesh.vertices);

    this.globeIndexBuffer = device.createBuffer({
      label: 'Globe Index Buffer',
      size: this.globeMesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(this.globeIndexBuffer, 0, this.globeMesh.indices);

    // 2. Regional Crater Site Mesh (90km × 90km, 256×256)
    this.siteMesh = createTerrainMesh(90.0, 256, this.selectedSite);
    this.siteVertexBuffer = device.createBuffer({
      label: 'Site Vertex Buffer',
      size: this.siteMesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(this.siteVertexBuffer, 0, this.siteMesh.vertices);

    this.siteIndexBuffer = device.createBuffer({
      label: 'Site Index Buffer',
      size: this.siteMesh.indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(this.siteIndexBuffer, 0, this.siteMesh.indices);

    // 3. Dynamic Quadtree LOD Geometry Buffers (Generous capacity with auto-growth)
    this.lodVertexBuffer = device.createBuffer({
      label: 'LOD Dynamic Vertex Buffer',
      size: 32 * 1024 * 1024, // 32MB initial capacity (over 2,300 subdivided chunks)
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });

    this.lodIndexBuffer = device.createBuffer({
      label: 'LOD Dynamic Index Buffer',
      size: 16 * 1024 * 1024, // 16MB initial capacity
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });

    this.terrainMesh = (this.viewTarget === 'globe') ? this.globeMesh : this.siteMesh;

    // Uniform Buffer (256 bytes)
    this.uniformBuffer = device.createBuffer({
      label: 'Terrain Uniform Buffer',
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Global NASA mosaic texture (LOD 0-3): 1024×512 equirectangular
    this.globalTexture = device.createTexture({
      label: 'NASA Global Mosaic Texture',
      size: [1024, 512, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });

    // Per-tile Atlas texture (LOD 4-6): 2048×2048, 4×4 grid of 512×512 slots
    this.atlasTexture = device.createTexture({
      label: 'LOD Tile Atlas Texture',
      size: [ATLAS_PX, ATLAS_PX, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
    });

    // Shared linear sampler
    this.tileSampler = device.createSampler({
      label: 'Tile Sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge'
    });

    // Populate initial global & atlas textures with baseline regolith so Moon is never pitch black
    const initCanvas = document.createElement('canvas');
    initCanvas.width = 1024;
    initCanvas.height = 512;
    const initCtx = initCanvas.getContext('2d');
    initCtx.fillStyle = '#484d59';
    initCtx.fillRect(0, 0, 1024, 512);
    initCtx.fillStyle = '#1c1e26';
    initCtx.beginPath();
    initCtx.ellipse(450, 220, 140, 100, 0, 0, Math.PI * 2);
    initCtx.fill();
    initCtx.beginPath();
    initCtx.ellipse(560, 250, 80, 60, 0, 0, Math.PI * 2);
    initCtx.fill();
    createImageBitmap(initCanvas).then((bmp) => {
      if (this.globalTexture) {
        device.queue.copyExternalImageToTexture(
          { source: bmp },
          { texture: this.globalTexture },
          [1024, 512]
        );
      }
    });

    const atlasInitCanvas = document.createElement('canvas');
    atlasInitCanvas.width = 256;
    atlasInitCanvas.height = 256;
    const aCtx = atlasInitCanvas.getContext('2d');
    aCtx.fillStyle = '#3c404c';
    aCtx.fillRect(0, 0, 256, 256);
    createImageBitmap(atlasInitCanvas).then((bmp) => {
      if (this.atlasTexture) {
        for (let s = 0; s < ATLAS_SLOTS; s++) {
          this._uploadTileToAtlas(bmp, s);
        }
      }
    });

    this.rebuildTerrainBindGroup();
  }

  rebuildTerrainBindGroup() {
    if (!this.gpuCtx.device || !this.gpuCtx.terrainPipeline) return;
    if (!this.globalTexture || !this.atlasTexture || !this.tileSampler) return;

    this.terrainBindGroup = this.gpuCtx.device.createBindGroup({
      label: 'Terrain Bind Group',
      layout: this.gpuCtx.terrainPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.globalTexture.createView() },
        { binding: 2, resource: this.tileSampler },
        { binding: 3, resource: this.atlasTexture.createView() }
      ]
    });
  }

  setViewTarget(target) {
    this.viewTarget = target;
    const btnGlobe = document.getElementById('view-globe');
    const btnSite = document.getElementById('view-site');
    if (btnGlobe) btnGlobe.classList.toggle('active', target === 'globe');
    if (btnSite) btnSite.classList.toggle('active', target === 'site');

    this.terrainMesh = (target === 'globe') ? this.globeMesh : this.siteMesh;

    if (target === 'globe') {
      this.camera.globeMode = true;
      this.camera.minDistance = 25.04; // allows close zoom down to ~2.8km above surface
      this.camera.target[0] = 0;
      this.camera.target[1] = 0;
      this.camera.target[2] = 0;
      this.camera.targetDist = 60.0;
      this.camera.targetPitch = 0.2;
    } else {
      this.camera.globeMode = false;
      this.camera.minDistance = 3.0;
      this.camera.flyToSite(this.selectedSite);
    }

    this.streamNasaTile(this.selectedSite);
    this.updateLod();
  }

  updateLod() {
    if (!this.lodSystem) return;

    const stats = this.lodSystem.update(this.camera.position);

    const chunkEl = document.getElementById('lod-chunks');
    if (chunkEl) chunkEl.textContent = stats.activeLeaves.length;

    const culledEl = document.getElementById('lod-culled');
    if (culledEl) culledEl.textContent = `${stats.culledCount} tiles`;

    const triEl = document.getElementById('lod-triangles');
    if (triEl) triEl.textContent = stats.triangles.toLocaleString();

    // Find max active LOD depth
    let maxD = 0;
    for (let i = stats.histogram.length - 1; i >= 0; i--) {
      if (stats.histogram[i] > 0) { maxD = i; break; }
    }
    const maxDepthEl = document.getElementById('lod-max-depth');
    if (maxDepthEl) maxDepthEl.textContent = `LOD ${maxD}`;

    // Update distribution strip
    const stripEl = document.getElementById('lod-level-strip');
    if (stripEl) {
      stripEl.innerHTML = stats.histogram.map((count, lvl) =>
        `<span class="lod-badge b${lvl}">L${lvl}: ${count}</span>`
      ).join('');
    }

    // Build dynamic combined mesh and upload to GPU (with auto-growing buffers)
    const combined = this.lodSystem.generateCombinedMesh();
    if (combined && this.gpuCtx.device) {
      if (!this.lodVertexBuffer || combined.vertices.byteLength > this.lodVertexBuffer.size) {
        if (this.lodVertexBuffer) this.lodVertexBuffer.destroy();
        const newSize = Math.max(Math.ceil(combined.vertices.byteLength * 1.5), 32 * 1024 * 1024);
        this.lodVertexBuffer = this.gpuCtx.device.createBuffer({
          label: 'LOD Dynamic Vertex Buffer',
          size: newSize,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
        });
      }
      if (!this.lodIndexBuffer || combined.indices.byteLength > this.lodIndexBuffer.size) {
        if (this.lodIndexBuffer) this.lodIndexBuffer.destroy();
        const newSize = Math.max(Math.ceil(combined.indices.byteLength * 1.5), 16 * 1024 * 1024);
        this.lodIndexBuffer = this.gpuCtx.device.createBuffer({
          label: 'LOD Dynamic Index Buffer',
          size: newSize,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
        });
      }
      this.gpuCtx.device.queue.writeBuffer(this.lodVertexBuffer, 0, combined.vertices);
      this.gpuCtx.device.queue.writeBuffer(this.lodIndexBuffer, 0, combined.indices);
      this.lodIndexCount = combined.indexCount;
    }

    // ── Per-tile texture streaming ──────────────────────────────────────────
    // Request textures for all active leaves (high LOD tiles get per-tile atlas slots)
    if (this.gpuCtx.device && !this.useFallback) {
      let atlasDirty = false;
      let nasaCount = 0;
      let procCount = 0;

      // Sort leaves: highest LOD first (closest detail), then by distance
      const camPos = this.camera.position;
      const sortedLeaves = [...stats.activeLeaves].sort((a, b) => {
        if (b.z !== a.z) return b.z - a.z; // prefer high LOD
        const da = (a.centerPos[0] - camPos[0]) ** 2 + (a.centerPos[1] - camPos[1]) ** 2 + (a.centerPos[2] - camPos[2]) ** 2;
        const db = (b.centerPos[0] - camPos[0]) ** 2 + (b.centerPos[1] - camPos[1]) ** 2 + (b.centerPos[2] - camPos[2]) ** 2;
        return da - db;
      });

      // Limit atlas uploads per updateLod call to avoid GPU stall
      let uploadsThisFrame = 0;
      const MAX_UPLOADS_PER_FRAME = 4;

      for (const node of sortedLeaves) {
        // Stream per-tile textures at LOD 2+ (all detailed tiles)
        if (node.z < 2) continue;

        // Check if slot is already cached
        const cachedSlot = this.tileCache.getSlot(node);
        if (cachedSlot >= 0) {
          node.atlasSlot = cachedSlot;
        }

        const entry = this.tileCache.request(node, {
          sunAzimuthDeg: this.sunAzimuthDeg,
          sunAltitudeDeg: this.sunAltitudeDeg,
          sourceId: this.currentTileSourceId
        });

        // Count atlas stats
        if (entry) {
          if (entry.state === TileState.NASA) nasaCount++;
          if (entry.state === TileState.PROCEDURAL) procCount++;
        }

        // Rate-limited upload: only upload this frame if budget allows
        if (entry && entry.bitmap && entry.slotIndex >= 0 &&
            !this.pendingAtlasUploads.has(entry.slotIndex) &&
            uploadsThisFrame < MAX_UPLOADS_PER_FRAME) {
          this._uploadTileToAtlas(entry.bitmap, entry.slotIndex);
          node.atlasSlot = entry.slotIndex;
          this.pendingAtlasUploads.add(entry.slotIndex);
          atlasDirty = true;
          uploadsThisFrame++;
        } else if (entry && entry.slotIndex >= 0) {
          node.atlasSlot = entry.slotIndex;
        }
      }

      // Re-generate mesh if atlas slots changed (so curvature channel is updated)
      if (atlasDirty && combined) {
        const updated = this.lodSystem.generateCombinedMesh();
        if (updated && updated.vertices.byteLength <= this.lodVertexBuffer.size && updated.indices.byteLength <= this.lodIndexBuffer.size) {
          this.gpuCtx.device.queue.writeBuffer(this.lodVertexBuffer, 0, updated.vertices);
          this.gpuCtx.device.queue.writeBuffer(this.lodIndexBuffer, 0, updated.indices);
          this.lodIndexCount = updated.indexCount;
        }
      }

      // Update atlas HUD telemetry
      const nasaEl = document.getElementById('lod-atlas-nasa');
      if (nasaEl) nasaEl.textContent = `${nasaCount} NASA`;
      const procEl = document.getElementById('lod-atlas-proc');
      if (procEl) procEl.textContent = `${procCount} SYNTH`;
    }
  }

  /**
   * Upload a 512×512 ImageBitmap into atlas slot [col, row]
   */
  _uploadTileToAtlas(bitmap, slotIndex) {
    if (!this.gpuCtx.device || !this.atlasTexture) return;
    const col = slotIndex % ATLAS_COLS;
    const row = Math.floor(slotIndex / ATLAS_COLS);
    const originX = col * TILE_PX;
    const originY = row * TILE_PX;

    this.gpuCtx.device.queue.copyExternalImageToTexture(
      { source: bitmap },
      { texture: this.atlasTexture, origin: [originX, originY, 0] },
      [Math.min(bitmap.width, TILE_PX), Math.min(bitmap.height, TILE_PX)]
    );
  }

  async streamNasaTile(site) {
    const statusEl = document.getElementById('tile-status');
    if (statusEl) statusEl.textContent = 'STREAMING...';

    let result;
    if (this.viewTarget === 'globe') {
      result = await this.nasaTileService.fetchGlobalNasaMap(this.currentTileSourceId);
    } else {
      result = await this.nasaTileService.fetchTileForSite(
        site,
        this.currentTileSourceId,
        this.tileZoomLevel
      );
    }

    this.currentTileBitmap = result.bitmap;

    // Draw preview thumbnail
    const thumbCanvas = document.getElementById('tile-preview-canvas');
    if (thumbCanvas && result.bitmap) {
      const ctx = thumbCanvas.getContext('2d');
      ctx.drawImage(result.bitmap, 0, 0, thumbCanvas.width, thumbCanvas.height);
    }

    // Update HUD metadata
    const info = result.tileInfo || {
      coords: { z: 'GLOBAL', x: '360°', y: '180°', latMin: -90, latMax: 90 },
      source: result.source || NASA_TILE_SOURCES[0]
    };

    if (info) {
      const coordsEl = document.getElementById('tile-wmts-coords');
      if (coordsEl) coordsEl.textContent = (this.viewTarget === 'globe') ? 'GLOBAL 360° x 180°' : `Z:${info.coords.z} • X:${info.coords.x} • Y:${info.coords.y}`;
      const bboxEl = document.getElementById('tile-bbox-coords');
      if (bboxEl) bboxEl.textContent = (this.viewTarget === 'globe') ? 'FULL LUNAR SPHERE' : `${info.coords.latMin.toFixed(1)}° to ${info.coords.latMax.toFixed(1)}°`;
      const attrEl = document.getElementById('tile-source-attr');
      if (attrEl) attrEl.textContent = info.source ? info.source.attribution : 'NASA / GSFC / LROC';
    }

    if (statusEl) {
      statusEl.textContent = result.isFallback ? 'SYNTHETIC' : (result.fromCache ? 'CACHED' : 'NASA LIVE');
    }

    // Upload to global WebGPU texture (1024×512 equirectangular mosaic for LOD 0-3)
    if (this.gpuCtx.device && !this.useFallback && result.bitmap) {
      const bmp = result.bitmap;
      if (!this.globalTexture || this.globalTexture.width !== bmp.width || this.globalTexture.height !== bmp.height) {
        if (this.globalTexture) this.globalTexture.destroy();
        this.globalTexture = this.gpuCtx.device.createTexture({
          label: 'NASA Global Mosaic Texture',
          size: [bmp.width, bmp.height, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.rebuildTerrainBindGroup();
      }

      this.gpuCtx.device.queue.copyExternalImageToTexture(
        { source: bmp },
        { texture: this.globalTexture },
        [bmp.width, bmp.height]
      );
    }
  }

  setupSkyboxGeometry() {
    const device = this.gpuCtx.device;

    const quadVertices = new Float32Array([
      -1, -1, 0,  0, 1,
       1, -1, 0,  1, 1,
      -1,  1, 0,  0, 0,
      -1,  1, 0,  0, 0,
       1, -1, 0,  1, 1,
       1,  1, 0,  1, 0
    ]);

    this.skyboxVertexBuffer = device.createBuffer({
      label: 'Skybox Vertex Buffer',
      size: quadVertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(this.skyboxVertexBuffer, 0, quadVertices);

    this.skyboxUniformBuffer = device.createBuffer({
      label: 'Skybox Uniform Buffer',
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.skyboxBindGroup = device.createBindGroup({
      label: 'Skybox Bind Group',
      layout: this.gpuCtx.skyboxPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.skyboxUniformBuffer } }
      ]
    });
  }

  setupComputeBuffers() {
    const device = this.gpuCtx.device;
    const targetMesh = this.siteMesh || this.terrainMesh;
    const res = (targetMesh && targetMesh.resolution) ? targetMesh.resolution : 256;
    const numElements = res * res;

    const elevations = new Float32Array(numElements);
    for (let i = 0; i < numElements; i++) {
      elevations[i] = targetMesh.vertices[i * 12 + 9] || 0.0;
    }

    this.computeParamBuffer = device.createBuffer({
      label: 'Compute Params Buffer',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.elevationStorageBuffer = device.createBuffer({
      label: 'Elevation Storage Buffer',
      size: elevations.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
    });
    device.queue.writeBuffer(this.elevationStorageBuffer, 0, elevations);

    this.hazardStorageBuffer = device.createBuffer({
      label: 'Hazard Storage Buffer',
      size: numElements * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC
    });

    this.computeBindGroup = device.createBindGroup({
      label: 'Hazard Compute Bind Group',
      layout: this.gpuCtx.hazardComputePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.computeParamBuffer } },
        { binding: 1, resource: { buffer: this.elevationStorageBuffer } },
        { binding: 2, resource: { buffer: this.hazardStorageBuffer } }
      ]
    });
  }

  setupUI() {
    // View Switcher
    const btnGlobe = document.getElementById('view-globe');
    const btnSite = document.getElementById('view-site');
    if (btnGlobe) btnGlobe.addEventListener('click', () => this.setViewTarget('globe'));
    if (btnSite) btnSite.addEventListener('click', () => this.setViewTarget('site'));

    // NASA Tile Streamer Listeners
    const toggleRealNasa = document.getElementById('toggle-real-nasa');
    if (toggleRealNasa) {
      toggleRealNasa.addEventListener('change', (e) => {
        this.useRealNasaTile = e.target.checked;
      });
    }

    const nasaLayerSelect = document.getElementById('nasa-layer-select');
    if (nasaLayerSelect) {
      nasaLayerSelect.addEventListener('change', (e) => {
        this.currentTileSourceId = e.target.value;
        this.streamNasaTile(this.selectedSite);
      });
    }

    const tileZoomSlider = document.getElementById('tile-zoom-slider');
    const tileZoomVal = document.getElementById('tile-zoom-val');
    if (tileZoomSlider) {
      tileZoomSlider.addEventListener('input', (e) => {
        this.tileZoomLevel = parseInt(e.target.value, 10);
        if (tileZoomVal) tileZoomVal.textContent = `LEVEL ${this.tileZoomLevel}`;
        this.streamNasaTile(this.selectedSite);
      });
    }

    // Populate Target Landing Sites
    const siteListEl = document.getElementById('site-list');
    siteListEl.innerHTML = '';

    LUNAR_SITES.forEach((site) => {
      const item = document.createElement('div');
      item.className = `site-item ${site.id === this.selectedSite.id ? 'active' : ''}`;
      item.innerHTML = `
        <div class="site-title">${site.name}</div>
        <div class="site-details">
          <span>${site.lat.toFixed(1)}°, ${site.lon.toFixed(1)}° &bull; ${site.elevation > 0 ? '+' : ''}${site.elevation}m</span>
          <span class="site-tag">${site.type}</span>
        </div>
      `;
      item.addEventListener('click', () => this.switchSite(site));
      siteListEl.appendChild(item);
    });

    // Shading Mode Switcher
    const modeButtons = document.querySelectorAll('#shading-modes .mode-btn');
    modeButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        modeButtons.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.shadingMode = parseInt(btn.dataset.shaderMode, 10);
        this.updateLegend();
      });
    });

    // Solar Simulation Sliders
    const azSlider = document.getElementById('sun-azimuth');
    const azVal = document.getElementById('sun-azimuth-val');
    azSlider.addEventListener('input', (e) => {
      this.sunAzimuthDeg = parseFloat(e.target.value);
      azVal.textContent = `${this.sunAzimuthDeg.toFixed(0)}°`;
    });

    const altSlider = document.getElementById('sun-altitude');
    const altVal = document.getElementById('sun-altitude-val');
    altSlider.addEventListener('input', (e) => {
      this.sunAltitudeDeg = parseFloat(e.target.value);
      altVal.textContent = `${this.sunAltitudeDeg.toFixed(1)}°`;
    });

    // Checkbox toggles
    document.getElementById('animate-sun').addEventListener('change', (e) => {
      this.isSunAnimated = e.target.checked;
    });

    document.getElementById('earth-shine').addEventListener('change', (e) => {
      this.earthshineEnabled = e.target.checked;
    });

    // Camera mode buttons — select only within the camera mode btn-group
    const camBtnGroup = document.querySelectorAll('#cam-orbit, #cam-surface, #cam-topdown');
    camBtnGroup.forEach((btn) => {
      btn.addEventListener('click', () => {
        camBtnGroup.forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        this.camera.setMode(btn.dataset.mode);
      });
    });

    // Route Pathfinder
    document.getElementById('btn-plot-route').addEventListener('click', () => {
      this.solveRoverRoute();
    });

    document.getElementById('btn-clear-route').addEventListener('click', () => {
      document.getElementById('path-metrics').classList.add('hidden');
    });

    // Footer buttons
    const locMapBtn = document.getElementById('btn-location-mapping');
    const toggleLocMap = document.getElementById('toggle-location-mapping');

    const updateLocationMappingState = (enabled) => {
      this.locationMappingEnabled = enabled;
      if (locMapBtn) {
        locMapBtn.innerHTML = `&#x1F3AF; SITE RETICLES [${enabled ? 'ON' : 'OFF'}]`;
        locMapBtn.classList.toggle('active', enabled);
      }
      if (toggleLocMap) {
        toggleLocMap.checked = enabled;
      }
    };

    if (locMapBtn) {
      locMapBtn.addEventListener('click', () => {
        updateLocationMappingState(!this.locationMappingEnabled);
      });
    }

    if (toggleLocMap) {
      toggleLocMap.addEventListener('change', (e) => {
        updateLocationMappingState(e.target.checked);
      });
    }

    const wireframeBtn = document.getElementById('btn-wireframe');
    wireframeBtn.addEventListener('click', () => {
      this.wireframeEnabled = !this.wireframeEnabled;
      wireframeBtn.textContent = `WIREFRAME [${this.wireframeEnabled ? 'ON' : 'OFF'}]`;
      wireframeBtn.classList.toggle('active', this.wireframeEnabled);
    });

    document.getElementById('btn-reset-cam').addEventListener('click', () => {
      this.camera.targetDist = 65.0;
      this.camera.targetYaw = 0.8;
      this.camera.targetPitch = 0.5;
    });

    document.getElementById('btn-about').addEventListener('click', () => {
      this.showSpecsModal();
    });

    document.getElementById('modal-close').addEventListener('click', () => {
      document.getElementById('modal-container').classList.add('hidden');
    });

    this.updateSiteUI();
    this.updateLegend();
    this.setupMissionScannerUI();
  }

  switchSite(site) {
    this.selectedSite = site;
    this.targetSiteLat = site.lat;
    this.targetSiteLon = site.lon;
    this.targetSiteStatus = 0; // Standard catalog site: qualified status color

    const items = document.querySelectorAll('.site-item');
    items.forEach((el, idx) => {
      el.classList.toggle('active', LUNAR_SITES[idx].id === site.id);
    });

    if (this.viewTarget === 'globe') {
      this.camera.flyToGlobeLatLon(site.lat, site.lon);
    } else {
      this.camera.flyToSite(site);
    }

    if (!this.useFallback && this.viewTarget === 'site') {
      this.siteMesh = createTerrainMesh(90.0, 256, this.selectedSite);
      this.gpuCtx.device.queue.writeBuffer(this.siteVertexBuffer, 0, this.siteMesh.vertices);
      this.gpuCtx.device.queue.writeBuffer(this.siteIndexBuffer, 0, this.siteMesh.indices);
      this.terrainMesh = this.siteMesh;
      this.setupComputeBuffers();
    }

    this.updateSiteUI();
    this.streamNasaTile(site);
  }

  updateSiteUI() {
    const s = this.selectedSite;
    document.getElementById('telem-lat').textContent = `${Math.abs(s.lat).toFixed(2)}° ${s.lat < 0 ? 'S' : 'N'}`;
    document.getElementById('telem-lon').textContent = `${Math.abs(s.lon).toFixed(2)}° ${s.lon >= 0 ? 'E' : 'W'}`;
    document.getElementById('telem-elev').textContent = `${s.elevation > 0 ? '+' : ''}${s.elevation.toLocaleString()} m`;
    document.getElementById('telem-slope').textContent = `${s.avgSlope.toFixed(1)}° (${s.avgSlope < 6 ? 'SAFE' : 'MODERATE'})`;
    document.getElementById('telem-illum').textContent = `${s.peakIllumPct.toFixed(1)}%`;
    document.getElementById('target-coordinates').textContent = `${s.name.toUpperCase()} [${s.type.toUpperCase()}]`;
  }

  updateLegend() {
    const minEl = document.getElementById('legend-min');
    const maxEl = document.getElementById('legend-max');
    const gradEl = document.getElementById('legend-gradient');

    if (this.shadingMode === 1) {
      minEl.textContent = 'SAFE (<5°)';
      maxEl.textContent = 'HAZARD (>15°)';
      gradEl.style.background = 'linear-gradient(90deg, #10b981 0%, #ffaa00 50%, #ef4444 100%)';
    } else if (this.shadingMode === 2) {
      minEl.textContent = '-6,000 m (BASIN)';
      maxEl.textContent = '+6,000 m (MASSIF)';
      gradEl.style.background = 'linear-gradient(90deg, #0000ff 0%, #00ffff 25%, #00ff00 50%, #ffff00 75%, #ff0000 100%)';
    } else if (this.shadingMode === 3) {
      minEl.textContent = 'PSR (COLD-TRAP)';
      maxEl.textContent = 'DIRECT SUNLIGHT';
      gradEl.style.background = 'linear-gradient(90deg, #0c2b5c 0%, #3b82f6 30%, #ffcc44 70%, #ffffff 100%)';
    } else if (this.shadingMode === 4) {
      minEl.textContent = 'TOUCHDOWN ZONE';
      maxEl.textContent = 'EXCLUSION ZONE';
      gradEl.style.background = 'linear-gradient(90deg, #10b981 0%, #eab308 50%, #ef4444 100%)';
    } else if (this.shadingMode === 6) {
      minEl.textContent = 'LOD 0 (BLUE: COARSE)';
      maxEl.textContent = 'LOD 6 (MAGENTA: MAX-RES)';
      gradEl.style.background = 'linear-gradient(90deg, #1d4ed8 0%, #06b6d4 20%, #10b981 40%, #eab308 60%, #ef4444 80%, #d946ef 100%)';
    } else if (this.shadingMode === 7) {
      minEl.textContent = 'EXCLUDED (NO COMMS / HIGH SLOPE)';
      maxEl.textContent = 'PRIME QUALIFIED TOUCHDOWN';
      gradEl.style.background = 'linear-gradient(90deg, #070a14 0%, #ef4444 35%, #f59e0b 65%, #10b981 100%)';
    } else {
      minEl.textContent = 'MARE BASALT';
      maxEl.textContent = 'ANORTHOSITE HIGHLAND';
      gradEl.style.background = 'linear-gradient(90deg, #22252c 0%, #59616e 50%, #a4adb8 100%)';
    }
  }

  setupMissionScannerUI() {
    // 1. Tab Switcher (Sites Catalog vs Mission Scanner)
    const tabCatalog = document.getElementById('tab-site-catalog');
    const tabScanner = document.getElementById('tab-mission-scanner');
    const catalogSection = document.getElementById('catalog-section');
    const scannerSection = document.getElementById('scanner-section');

    if (tabCatalog && tabScanner) {
      tabCatalog.addEventListener('click', () => {
        tabCatalog.classList.add('active');
        tabScanner.classList.remove('active');
        if (catalogSection) catalogSection.classList.remove('hidden');
        if (scannerSection) scannerSection.classList.add('hidden');
      });

      tabScanner.addEventListener('click', () => {
        tabScanner.classList.add('active');
        tabCatalog.classList.remove('active');
        if (catalogSection) catalogSection.classList.add('hidden');
        if (scannerSection) scannerSection.classList.remove('hidden');
        this.runMissionScan();
      });
    }

    // 2. Sliders & Live Readouts
    const sliderSun = document.getElementById('slider-min-sun');
    const valSun = document.getElementById('val-min-sun');
    const sliderEarth = document.getElementById('slider-min-earth');
    const valEarth = document.getElementById('val-min-earth');
    const sliderSlope = document.getElementById('slider-max-slope');
    const valSlope = document.getElementById('val-max-slope');
    const sliderDarkness = document.getElementById('slider-max-darkness');
    const valDarkness = document.getElementById('val-max-darkness');

    const updateFromSliders = () => {
      const minSun = parseFloat(sliderSun.value);
      const minEarth = parseFloat(sliderEarth.value);
      const maxSlope = parseFloat(sliderSlope.value);
      const maxDark = parseFloat(sliderDarkness.value);

      if (valSun) valSun.textContent = `${minSun.toFixed(0)}%`;
      if (valEarth) valEarth.textContent = `${minEarth.toFixed(0)}%`;
      if (valSlope) valSlope.textContent = `${maxSlope.toFixed(1)}°`;
      if (valDarkness) valDarkness.textContent = `${maxDark.toFixed(0)} hrs`;

      this.missionScanner.setRequirements({
        minSunlightPct: minSun,
        minEarthVisPct: minEarth,
        maxSlopeDeg: maxSlope,
        maxContinuousDarknessHrs: maxDark
      });

      this.runMissionScan();
    };

    if (sliderSun) sliderSun.addEventListener('input', updateFromSliders);
    if (sliderEarth) sliderEarth.addEventListener('input', updateFromSliders);
    if (sliderSlope) sliderSlope.addEventListener('input', updateFromSliders);
    if (sliderDarkness) sliderDarkness.addEventListener('input', updateFromSliders);

    // 3. Mission Preset Selector
    const presetSelect = document.getElementById('mission-preset-select');
    if (presetSelect) {
      presetSelect.addEventListener('change', (e) => {
        const p = MISSION_PRESETS.find(x => x.id === e.target.value);
        if (p) {
          sliderSun.value = p.requirements.minSunlightPct;
          sliderEarth.value = p.requirements.minEarthVisPct;
          sliderSlope.value = p.requirements.maxSlopeDeg;
          sliderDarkness.value = p.requirements.maxContinuousDarknessHrs;
          updateFromSliders();
        }
      });
    }

    // 4. Scan Button
    const btnScan = document.getElementById('btn-run-scan');
    if (btnScan) {
      btnScan.addEventListener('click', () => {
        this.runMissionScan();
      });
    }

    // 5. Toggle PBR View vs Suitability Map Mode (Mode 7)
    const btnViewPbr = document.getElementById('btn-view-pbr');
    if (btnViewPbr) {
      btnViewPbr.addEventListener('click', () => {
        this.shadingMode = 0;
        this.locationMappingEnabled = true;
        const locMapBtn = document.getElementById('btn-location-mapping');
        if (locMapBtn) {
          locMapBtn.innerHTML = `&#x1F3AF; SITE RETICLES [ON]`;
          locMapBtn.classList.add('active');
        }
        const toggleLocMap = document.getElementById('toggle-location-mapping');
        if (toggleLocMap) toggleLocMap.checked = true;

        const modeButtons = document.querySelectorAll('#shading-modes .mode-btn');
        modeButtons.forEach((b) => {
          b.classList.toggle('active', parseInt(b.dataset.shaderMode, 10) === 0);
        });
        this.updateLegend();
      });
    }

    const btnSuitabilityMap = document.getElementById('btn-toggle-suitability-mode');
    if (btnSuitabilityMap) {
      btnSuitabilityMap.addEventListener('click', () => {
        this.shadingMode = 7;
        const modeButtons = document.querySelectorAll('#shading-modes .mode-btn');
        modeButtons.forEach((b) => {
          b.classList.toggle('active', parseInt(b.dataset.shaderMode, 10) === 7);
        });
        this.updateLegend();
      });
    }

    // 6. Export Mission Report Button
    const btnExport = document.getElementById('btn-export-report');
    if (btnExport) {
      btnExport.addEventListener('click', () => {
        this.showMissionReport();
      });
    }

    // Initial scan
    this.runMissionScan();
  }

  runMissionScan() {
    const results = this.missionScanner.scan();
    this.latestScanResults = results;

    // Update Stats Bar
    const statQ = document.getElementById('stat-qualified');
    const statM = document.getElementById('stat-marginal');
    const statE = document.getElementById('stat-excluded');
    if (statQ) statQ.textContent = `${results.stats.qualifiedCount} QUALIFIED`;
    if (statM) statM.textContent = `${results.stats.marginalCount} MARGINAL`;
    if (statE) statE.textContent = `${results.stats.disqualifiedCount} EXCLUDED`;

    // Render Ranked Candidates List
    this.renderRankedCandidates(results.rankedCandidates);
  }

  renderRankedCandidates(candidates) {
    const listEl = document.getElementById('ranked-candidates-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    candidates.forEach((cand) => {
      const card = document.createElement('div');
      const cardClass = cand.status === 'QUALIFIED' ? 'prime-candidate' : (cand.status === 'MARGINAL' ? 'marginal-candidate' : 'disqualified-candidate');
      card.className = `ranked-candidate-card ${cardClass}`;

      const slopePass = cand.criteriaCheck.slopePassed;
      const sunPass = cand.criteriaCheck.sunPassed;
      const earthPass = cand.criteriaCheck.earthPassed;
      const darkPass = cand.criteriaCheck.darknessPassed;

      let violationsHtml = '';
      if (cand.violations.length > 0) {
        violationsHtml = `<div class="violations-container">` +
          cand.violations.map(v => `<span class="violation-pill">&#x26A0; ${v}</span>`).join('') +
          `</div>`;
      }

      card.innerHTML = `
        <div class="candidate-header-row">
          <span class="candidate-rank-badge">#${cand.rank}</span>
          <span class="candidate-title" title="${cand.name}">${cand.name}</span>
          <span class="candidate-score-pill" style="background:${cand.statusColor}22; color:${cand.statusColor}; border:1px solid ${cand.statusColor}55;">
            ${cand.score}% &bull; ${cand.statusBadge}
          </span>
        </div>
        <div class="site-details" style="margin-bottom: 4px;">
          <span>${cand.zone} &bull; ${Math.abs(cand.lat).toFixed(1)}°${cand.lat < 0 ? 'S':'N'}, ${Math.abs(cand.lon).toFixed(1)}°${cand.lon >= 0 ? 'E':'W'}</span>
        </div>
        <div class="candidate-metrics-grid">
          <div class="metric-cell">
            <span class="k">SUNLIGHT</span>
            <span class="v ${sunPass ? 'passed' : 'failed'}">${cand.sunlightPct.toFixed(0)}%</span>
          </div>
          <div class="metric-cell">
            <span class="k">EARTH DTE</span>
            <span class="v ${earthPass ? 'passed' : 'failed'}">${cand.earthVisPct.toFixed(0)}%</span>
          </div>
          <div class="metric-cell">
            <span class="k">SLOPE</span>
            <span class="v ${slopePass ? 'passed' : 'failed'}">${cand.slopeDeg.toFixed(1)}°</span>
          </div>
          <div class="metric-cell">
            <span class="k">MAX DARK</span>
            <span class="v ${darkPass ? 'passed' : 'failed'}">${cand.continuousDarknessHrs.toFixed(0)}h</span>
          </div>
        </div>
        ${violationsHtml}
        <button class="btn-fly-candidate" data-lat="${cand.lat}" data-lon="${cand.lon}">
          &#x2316; TARGET & FLY TO CANDIDATE
        </button>
      `;

      card.querySelector('.btn-fly-candidate').addEventListener('click', (e) => {
        e.stopPropagation();
        this.flyToCandidate(cand);
      });

      card.addEventListener('click', () => {
        this.flyToCandidate(cand);
      });

      listEl.appendChild(card);
    });
  }

  flyToCandidate(cand) {
    this.targetSiteLat = cand.lat;
    this.targetSiteLon = cand.lon;
    this.targetSiteStatus = cand.status === 'QUALIFIED' ? 0 : (cand.status === 'MARGINAL' ? 1 : 2);

    // Switch to PBR + location mapping for best visual on fly-to
    this.shadingMode = 0;
    this.locationMappingEnabled = true;
    const locMapBtn = document.getElementById('btn-location-mapping');
    if (locMapBtn) {
      locMapBtn.innerHTML = `&#x1F3AF; SITE RETICLES [ON]`;
      locMapBtn.classList.add('active');
    }
    const toggleLocMap = document.getElementById('toggle-location-mapping');
    if (toggleLocMap) toggleLocMap.checked = true;

    // Update active shading mode button
    const modeButtons = document.querySelectorAll('#shading-modes .mode-btn');
    modeButtons.forEach((b) => {
      b.classList.toggle('active', parseInt(b.dataset.shaderMode, 10) === 0);
    });
    this.updateLegend();

    if (this.viewTarget === 'globe') {
      this.camera.flyToGlobeLatLon(cand.lat, cand.lon);
    } else {
      this.setViewTarget('globe');
      this.camera.flyToGlobeLatLon(cand.lat, cand.lon);
    }

    // Update telemetry
    document.getElementById('telem-lat').textContent = `${Math.abs(cand.lat).toFixed(2)}° ${cand.lat < 0 ? 'S' : 'N'}`;
    document.getElementById('telem-lon').textContent = `${Math.abs(cand.lon).toFixed(2)}° ${cand.lon >= 0 ? 'E' : 'W'}`;
    document.getElementById('telem-elev').textContent = `${cand.elevation > 0 ? '+' : ''}${cand.elevation.toLocaleString()} m`;
    document.getElementById('telem-slope').textContent = `${cand.slopeDeg.toFixed(1)}° (${cand.slopeDeg < 7 ? 'SAFE' : (cand.slopeDeg < 12 ? 'MODERATE' : 'HAZARD')})`;
    document.getElementById('telem-illum').textContent = `${cand.sunlightPct.toFixed(1)}%`;
    document.getElementById('target-coordinates').textContent = `${cand.name.toUpperCase()} [RANK #${cand.rank} &bull; ${cand.statusBadge}]`;
    const reticleText = document.getElementById('reticle-hud-text');
    if (reticleText) reticleText.textContent = `SITE #${cand.rank} LOCK [${cand.score}% SCORE]`;
  }

  showMissionReport() {
    const modal = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    const title = document.getElementById('modal-title');
    if (!modal || !content) return;

    const res = this.latestScanResults || this.missionScanner.scan();
    const req = res.requirements;

    title.textContent = 'NASA ARTEMIS // LANDING SITE CLEARANCE ASSESSMENT REPORT';

    const candidatesRows = res.rankedCandidates.slice(0, 12).map(c => `
      <tr style="border-bottom: 1px solid rgba(255,255,255,0.08);">
        <td style="padding: 6px; font-weight:700; color:var(--accent-cyan);">#${c.rank}</td>
        <td style="padding: 6px; font-weight:600;">${c.name}</td>
        <td style="padding: 6px; color:${c.criteriaCheck.sunPassed ? '#10b981' : '#ef4444'}; font-family:var(--font-mono);">${c.sunlightPct.toFixed(0)}%</td>
        <td style="padding: 6px; color:${c.criteriaCheck.earthPassed ? '#10b981' : '#ef4444'}; font-family:var(--font-mono);">${c.earthVisPct.toFixed(0)}%</td>
        <td style="padding: 6px; color:${c.criteriaCheck.slopePassed ? '#10b981' : '#ef4444'}; font-family:var(--font-mono);">${c.slopeDeg.toFixed(1)}°</td>
        <td style="padding: 6px; color:${c.criteriaCheck.darknessPassed ? '#10b981' : '#ef4444'}; font-family:var(--font-mono);">${c.continuousDarknessHrs.toFixed(0)}h</td>
        <td style="padding: 6px; font-weight:700; color:${c.statusColor}; font-family:var(--font-mono);">${c.score}%</td>
        <td style="padding: 6px;"><span style="color:${c.statusColor}; font-weight:700; font-size:10px;">${c.statusBadge}</span></td>
      </tr>
    `).join('');

    content.innerHTML = `
      <div style="margin-bottom: 14px;">
        <p><strong>MISSION ASSESSMENT SUMMARY</strong></p>
        <p style="color:var(--text-dim); font-size:11px;">Scanned ${res.stats.totalScanned} candidate lunar locations against multi-criteria flight safety constraints.</p>
      </div>

      <div style="display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:16px;">
        <div style="background:rgba(0,0,0,0.3); padding:8px; border-radius:4px;">
          <span style="font-size:9px; color:var(--text-dim); display:block;">MIN SUNLIGHT</span>
          <strong style="color:var(--accent-cyan);">${req.minSunlightPct}%</strong>
        </div>
        <div style="background:rgba(0,0,0,0.3); padding:8px; border-radius:4px;">
          <span style="font-size:9px; color:var(--text-dim); display:block;">MIN EARTH DTE</span>
          <strong style="color:var(--accent-cyan);">${req.minEarthVisPct}%</strong>
        </div>
        <div style="background:rgba(0,0,0,0.3); padding:8px; border-radius:4px;">
          <span style="font-size:9px; color:var(--text-dim); display:block;">MAX SLOPE</span>
          <strong style="color:var(--accent-amber);">${req.maxSlopeDeg}°</strong>
        </div>
        <div style="background:rgba(0,0,0,0.3); padding:8px; border-radius:4px;">
          <span style="font-size:9px; color:var(--text-dim); display:block;">MAX DARKNESS</span>
          <strong style="color:var(--accent-cyan);">${req.maxContinuousDarknessHrs} hrs</strong>
        </div>
      </div>

      <div style="margin-bottom:12px; display:flex; gap:8px;">
        <span style="background:rgba(16,185,129,0.2); color:#10b981; padding:4px 8px; border-radius:3px; font-weight:700; font-family:var(--font-mono);">
          ${res.stats.qualifiedCount} QUALIFIED SITES
        </span>
        <span style="background:rgba(245,158,11,0.2); color:#f59e0b; padding:4px 8px; border-radius:3px; font-weight:700; font-family:var(--font-mono);">
          ${res.stats.marginalCount} MARGINAL SITES
        </span>
        <span style="background:rgba(239,68,68,0.2); color:#ef4444; padding:4px 8px; border-radius:3px; font-weight:700; font-family:var(--font-mono);">
          ${res.stats.disqualifiedCount} EXCLUDED SITES
        </span>
      </div>

      <div style="max-height:280px; overflow-y:auto; border:1px solid rgba(255,255,255,0.08); border-radius:4px;">
        <table style="width:100%; border-collapse:collapse; font-size:11px; text-align:left;">
          <thead>
            <tr style="background:rgba(0,229,255,0.1); color:var(--accent-cyan); font-family:var(--font-hud);">
              <th style="padding:6px;">RANK</th>
              <th style="padding:6px;">SITE NAME</th>
              <th style="padding:6px;">SUN</th>
              <th style="padding:6px;">EARTH</th>
              <th style="padding:6px;">SLOPE</th>
              <th style="padding:6px;">DARK</th>
              <th style="padding:6px;">SCORE</th>
              <th style="padding:6px;">STATUS</th>
            </tr>
          </thead>
          <tbody>
            ${candidatesRows}
          </tbody>
        </table>
      </div>
    `;

    modal.classList.remove('hidden');
  }

  solveRoverRoute() {
    const sunAzRad = this.sunAzimuthDeg * (Math.PI / 180);
    const sunAltRad = this.sunAltitudeDeg * (Math.PI / 180);
    const sunDir = [
      Math.cos(sunAltRad) * Math.sin(sunAzRad),
      Math.sin(sunAltRad),
      Math.cos(sunAltRad) * Math.cos(sunAzRad)
    ];

    const route = this.pathPlanner.planRoute(-14.0, -12.0, 15.0, 16.0, sunDir);

    const metricsBox = document.getElementById('path-metrics');
    metricsBox.classList.remove('hidden');
    document.getElementById('metric-dist').textContent = `${route.totalDistanceKm} km`;

    const slopeEl = document.getElementById('metric-max-slope');
    slopeEl.textContent = `${route.maxSlopeDeg}° (${parseFloat(route.maxSlopeDeg) < 12 ? 'PASSED' : 'CAUTION'})`;
    slopeEl.className = parseFloat(route.maxSlopeDeg) < 12 ? 'safe' : 'highlight';

    document.getElementById('metric-sun-pct').textContent = `${route.solarExposurePct}%`;
  }

  bindWindowEvents() {
    window.addEventListener('resize', () => {
      if (this.useFallback && this.fallbackRenderer) {
        this.fallbackRenderer.resize();
      } else if (this.gpuCtx.device) {
        this.gpuCtx.resize();
      }
      this.camera.updateMatrices();
    });
  }

  showSpecsModal() {
    const modal = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    modal.classList.remove('hidden');

    content.innerHTML = `
      <p><strong>SELENE-GPU</strong> is an interactive WebGPU 3D terrain rendering and tactical site navigator engineered for Lunar missions (Artemis III, VIPER, and robotic landers).</p>

      <h3>Max-Resolution LOD Architecture</h3>
      <ul>
        <li><strong>LOD 0-3:</strong> NASA LRO WAC Global Mosaic (1024×512 equirectangular) — real 100m/px imagery</li>
        <li><strong>LOD 4-5:</strong> Per-tile NASA WMTS tiles fetched and packed into 2048×2048 atlas (4×4 grid, 16 slots)</li>
        <li><strong>LOD 6 (Max):</strong> Procedural regolith synthesized from LOLA elevation data — slope normals, Lommel-Seeliger diffuse, mare/highland albedo, fBm micro-roughness, Worley micro-crater pitting, ejecta bright streaks</li>
      </ul>

      <h3>Core WebGPU Architecture</h3>
      <ul>
        <li><strong>Hardware-Accelerated WGSL Shaders:</strong> Native WebGPU compute and render pipelines</li>
        <li><strong>Lommel-Seeliger & Hapke Regolith Reflectance:</strong> Physically-based lunar photometric models</li>
        <li><strong>Dynamic Quadtree LOD:</strong> 7 levels (0-6), horizon culling, 16×16 quads per chunk</li>
        <li><strong>WebGPU Hazard Compute Dispatch:</strong> 16×16 workgroup slope evaluation</li>
        <li><strong>Multi-Spectral Shading:</strong> PBR, slope, DEM, solar, hazard, normals, LOD heatmap</li>
      </ul>

      <h3>Adapter Diagnostics</h3>
      <p><strong>Architecture:</strong> ${this.gpuCtx.adapterInfo.architecture || 'WebGPU'}</p>
      <p><strong>GPU Vendor:</strong> ${this.gpuCtx.adapterInfo.vendor || 'Hardware'}</p>
      <p><strong>Canvas Format:</strong> ${this.gpuCtx.format}</p>
    `;
  }

  showFallbackDiagnostics(reason) {
    const modal = document.getElementById('modal-container');
    const content = document.getElementById('modal-content');
    modal.classList.remove('hidden');

    content.innerHTML = `
      <p style="color: var(--accent-amber); font-weight: 600;">WebGPU Hardware Acceleration Notice:</p>
      <p>${reason}</p>
      <h3>Recommended Action:</h3>
      <ul>
        <li>Open in <strong>Google Chrome 113+</strong> or <strong>Microsoft Edge 113+</strong>.</li>
        <li>In Chrome, ensure hardware acceleration is enabled at <code>chrome://settings/system</code>.</li>
        <li>You can also visit <code>chrome://flags/#enable-unsafe-webgpu</code> if your hardware is in evaluation mode.</li>
      </ul>
    `;
  }

  renderLoop(now) {
    const deltaTime = Math.min((now - this.lastTime) * 0.001, 0.1);
    this.lastTime = now;

    // FPS Counter — exponential moving average for smooth display
    this.frameCount++;
    this.fpsTimer += deltaTime;
    if (this.fpsTimer >= 0.25) {
      const rawFps = this.frameCount / this.fpsTimer;
      this.fpsEma = this.fpsEma * 0.8 + rawFps * 0.2;
      const fpsEl = document.getElementById('fps-counter');
      if (fpsEl) {
        fpsEl.textContent = this.fpsEma.toFixed(1);
        fpsEl.style.color = this.fpsEma >= 55 ? 'var(--accent-green)' : (this.fpsEma >= 30 ? 'var(--accent-amber)' : 'var(--accent-red)');
      }
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    // Solar Animation
    if (this.isSunAnimated) {
      this.sunAzimuthDeg = (this.sunAzimuthDeg + deltaTime * 14.0) % 360.0;
      document.getElementById('sun-azimuth').value = this.sunAzimuthDeg.toFixed(0);
      document.getElementById('sun-azimuth-val').textContent = `${this.sunAzimuthDeg.toFixed(0)}°`;
    }

    // Update Camera
    this.camera.update(deltaTime);

    // Update Quadtree Tile LOD every frame camera moves in Globe mode
    if (this.viewTarget === 'globe') {
      const camDx = this.camera.position[0] - this.lastLodCamPos[0];
      const camDy = this.camera.position[1] - this.lastLodCamPos[1];
      const camDz = this.camera.position[2] - this.lastLodCamPos[2];
      const camMovedSq = camDx * camDx + camDy * camDy + camDz * camDz;

      // Adaptive threshold: tighter (more responsive) when closer to surface
      const camDist = Math.hypot(
        this.camera.position[0],
        this.camera.position[1],
        this.camera.position[2]
      );
      const distAboveSurface = Math.max(0.05, camDist - 25.0);
      // Squared threshold (avoids sqrt each frame)
      const lodThreshSq = Math.pow(Math.max(0.015, distAboveSurface * 0.006), 2);

      if (camMovedSq > lodThreshSq) {
        this.lastLodCamPos[0] = this.camera.position[0];
        this.lastLodCamPos[1] = this.camera.position[1];
        this.lastLodCamPos[2] = this.camera.position[2];
        this.updateLod();
      }
    }

    // Compute Sun Direction Vector
    const azRad = this.sunAzimuthDeg * (Math.PI / 180);
    const altRad = this.sunAltitudeDeg * (Math.PI / 180);
    const sunDir = [
      Math.cos(altRad) * Math.sin(azRad),
      Math.sin(altRad),
      Math.cos(altRad) * Math.cos(azRad)
    ];

    document.getElementById('telem-sun-elev').textContent = `${this.sunAltitudeDeg.toFixed(1)}°`;

    // Render Frame
    this.renderFrame(now * 0.001, sunDir);

    requestAnimationFrame((t) => this.renderLoop(t));
  }

  renderFrame(timeSec, sunDir) {
    if (this.useFallback && this.fallbackRenderer) {
      const t0 = performance.now();
      this.fallbackRenderer.render(this, sunDir);
      const ms = (performance.now() - t0).toFixed(1);
      document.getElementById('gpu-time').textContent = `${ms} ms`;
      return;
    }

    const device = this.gpuCtx.device;
    if (!device || !this.gpuCtx.isSupported) return;

    const t0 = performance.now();

    // 1. Update Terrain Uniforms (256 bytes)
    const uniformArray = new ArrayBuffer(256);
    const floatView = new Float32Array(uniformArray);
    const uintView = new Uint32Array(uniformArray);

    floatView.set(this.camera.viewMatrix, 0);
    floatView.set(this.camera.projMatrix, 16);

    floatView[32] = sunDir[0];
    floatView[33] = sunDir[1];
    floatView[34] = sunDir[2];
    floatView[35] = this.sunAltitudeDeg;

    floatView[36] = this.camera.position[0];
    floatView[37] = this.camera.position[1];
    floatView[38] = this.camera.position[2];
    uintView[39] = this.shadingMode;

    uintView[40] = this.earthshineEnabled ? 1 : 0;
    floatView[41] = timeSec;
    uintView[42] = this.wireframeEnabled ? 1 : 0;
    uintView[43] = this.useRealNasaTile ? 1 : 0;
    uintView[44] = (this.viewTarget === 'globe') ? 1 : 0;

    // Mission requirements parameters for Suitability Map (Mode 7)
    const req = this.missionScanner.requirements;
    floatView[45] = req.minSunlightPct;
    floatView[46] = req.minEarthVisPct;
    floatView[47] = req.maxSlopeDeg;
    floatView[48] = req.maxContinuousDarknessHrs;

    // Location Mapping parameters for Normal PBR Moon Viewer
    uintView[49] = this.locationMappingEnabled ? 1 : 0;
    floatView[50] = this.targetSiteLat;
    floatView[51] = this.targetSiteLon;
    uintView[52] = this.targetSiteStatus;

    device.queue.writeBuffer(this.uniformBuffer, 0, uniformArray);

    // 2. Update Skybox Uniforms
    const skyUniformArray = new ArrayBuffer(96);
    const skyFloatView = new Float32Array(skyUniformArray);
    skyFloatView.set(this.camera.invViewProjMatrix, 0);
    skyFloatView[16] = sunDir[0];
    skyFloatView[17] = sunDir[1];
    skyFloatView[18] = sunDir[2];
    skyFloatView[19] = 0.0;
    skyFloatView[20] = timeSec;
    device.queue.writeBuffer(this.skyboxUniformBuffer, 0, skyUniformArray);

    // 3. Update Compute Uniforms
    const compArray = new ArrayBuffer(32);
    const compUint = new Uint32Array(compArray);
    const compFloat = new Float32Array(compArray);
    const compRes = (this.terrainMesh && this.terrainMesh.resolution) ? this.terrainMesh.resolution : 128;
    compUint[0] = compRes;
    compFloat[1] = 90000.0 / compRes;
    compFloat[2] = 0.0;
    compFloat[3] = 0.0;
    compFloat[4] = sunDir[0];
    compFloat[5] = sunDir[1];
    compFloat[6] = sunDir[2];
    compFloat[7] = 15.0;
    device.queue.writeBuffer(this.computeParamBuffer, 0, compArray);

    // 4. Begin GPU Command Encoding
    const commandEncoder = device.createCommandEncoder();

    // A. Compute Pass: Hazard evaluation
    const computePass = commandEncoder.beginComputePass({ label: 'Hazard Compute Pass' });
    computePass.setPipeline(this.gpuCtx.hazardComputePipeline);
    computePass.setBindGroup(0, this.computeBindGroup);
    const workgroups = Math.ceil(compRes / 16);
    computePass.dispatchWorkgroups(workgroups, workgroups);
    computePass.end();

    // B. Render Pass: Skybox & Terrain
    const currentTexture = this.gpuCtx.context.getCurrentTexture();
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: currentTexture.createView(),
          clearValue: { r: 0.002, g: 0.003, b: 0.006, a: 1.0 },
          loadOp: 'clear',
          storeOp: 'store'
        }
      ],
      depthStencilAttachment: {
        view: this.gpuCtx.depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: 'clear',
        depthStoreOp: 'store'
      }
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

    // Draw Skybox
    passEncoder.setPipeline(this.gpuCtx.skyboxPipeline);
    passEncoder.setBindGroup(0, this.skyboxBindGroup);
    passEncoder.setVertexBuffer(0, this.skyboxVertexBuffer);
    passEncoder.draw(6);

    // Draw Terrain or 3D Lunar Globe
    passEncoder.setPipeline(this.gpuCtx.terrainPipeline);
    passEncoder.setBindGroup(0, this.terrainBindGroup);

    if (this.viewTarget === 'globe') {
      if (this.lodVertexBuffer && this.lodIndexCount > 0) {
        passEncoder.setVertexBuffer(0, this.lodVertexBuffer);
        passEncoder.setIndexBuffer(this.lodIndexBuffer, 'uint32');
        passEncoder.drawIndexed(this.lodIndexCount);
      } else if (this.globeVertexBuffer) {
        passEncoder.setVertexBuffer(0, this.globeVertexBuffer);
        passEncoder.setIndexBuffer(this.globeIndexBuffer, 'uint32');
        passEncoder.drawIndexed(this.globeMesh.indexCount);
      }
    } else if (this.siteVertexBuffer) {
      passEncoder.setVertexBuffer(0, this.siteVertexBuffer);
      passEncoder.setIndexBuffer(this.siteIndexBuffer, 'uint32');
      passEncoder.drawIndexed(this.siteMesh.indexCount);
    }

    passEncoder.end();

    device.queue.submit([commandEncoder.finish()]);

    const gpuMs = (performance.now() - t0).toFixed(1);
    document.getElementById('gpu-time').textContent = `${gpuMs} ms`;
  }
}

// Boot application
window.addEventListener('DOMContentLoaded', () => {
  new LunarApp();
});
