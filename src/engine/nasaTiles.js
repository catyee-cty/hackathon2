/**
 * NASA Moon Trek & Planetary Tile Service Client
 * Fetches real LRO (Lunar Reconnaissance Orbiter) and LOLA (Laser Altimeter) tiles
 * Converts geographic coordinates (Lat/Lon) to WMTS / XYZ matrix indices.
 */

export const NASA_TILE_SOURCES = [
  {
    id: "lro_wac",
    name: "NASA LRO WAC Global Mosaic",
    description: "Real photographic imagery captured by Lunar Reconnaissance Orbiter Camera (303 pixels/degree).",
    type: "wmts_eq",
    attribution: "NASA / GSFC / Arizona State University (LROC)",
    format: "jpg",
    maxZoom: 7,
    getUrl: (z, x, y) => {
      // NASA Moon Trek Equirectangular WMTS pattern:
      // z corresponds to TileMatrix, x to TileCol, y to TileRow
      return `https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`;
    }
  },
  {
    id: "lola_shade",
    name: "NASA LOLA Color Shaded Topography",
    description: "Topographic digital elevation model derived from Lunar Orbiter Laser Altimeter tracks.",
    type: "wmts_eq",
    attribution: "NASA / GSFC / LOLA Science Team",
    format: "jpg",
    maxZoom: 6,
    getUrl: (z, x, y) => {
      return `https://trek.nasa.gov/tiles/Moon/EQ/LOLA_ClrShade_Global_128ppd_v04/1.0.0/default/default028mm/${z}/${y}/${x}.jpg`;
    }
  },
  {
    id: "opm_basemap",
    name: "OpenPlanetary NASA LRO Basemap",
    description: "High-speed CDN-cached Web Mercator XYZ tiles processed from NASA LRO missions.",
    type: "xyz_mercator",
    attribution: "OpenPlanetary / CARTO / NASA",
    format: "png",
    maxZoom: 7,
    getUrl: (z, x, y) => {
      return `https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named/opm-moon-basemap-v0-1/all/${z}/${x}/${y}.png`;
    }
  }
];

export class NasaTileService {
  constructor() {
    this.cache = new Map();
    this.currentTileInfo = null;
    this.globalTextureCache = new Map();
  }

  /**
   * Fetch Full Planetary Global Equirectangular Moon Map (360° x 180°)
   * Combines NASA Moon Trek global hemispheric tiles into a single 2:1 global panorama
   */
  async fetchGlobalNasaMap(sourceId = "lro_wac") {
    if (this.globalTextureCache.has(sourceId)) {
      return this.globalTextureCache.get(sourceId);
    }

    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    const source = NASA_TILE_SOURCES.find((s) => s.id === sourceId) || NASA_TILE_SOURCES[0];

    try {
      if (source.type === "xyz_mercator") {
        // Fetch Z=0 global tile
        const img = new Image();
        img.crossOrigin = "anonymous";
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
          img.src = source.getUrl(0, 0, 0);
        });
        ctx.drawImage(img, 0, 0, 1024, 512);
      } else {
        // Moon Trek EQ Matrix Level 0 has 2 tiles: (x=0: West, x=1: East)
        const loadTile = (x) => {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load tile x=${x}`));
            img.src = source.getUrl(0, x, 0);
          });
        };

        const [tileWest, tileEast] = await Promise.all([loadTile(0), loadTile(1)]);
        ctx.drawImage(tileWest, 0, 0, 512, 512);
        ctx.drawImage(tileEast, 512, 0, 512, 512);
      }

      const bitmap = await createImageBitmap(canvas);
      this.globalTextureCache.set(sourceId, { bitmap, isFallback: false, source });
      return { bitmap, isFallback: false, source };
    } catch (err) {
      console.warn(`[Global NASA Map] Network fetch failed (${err.message}). Generating high-fidelity procedural global Moon.`);
      const synthBitmap = await this.generateGlobalSyntheticMoon(sourceId);
      this.globalTextureCache.set(sourceId, { bitmap: synthBitmap, isFallback: true, source });
      return { bitmap: synthBitmap, isFallback: true, source };
    }
  }

  /**
   * Generates a high-fidelity global 360° x 180° equirectangular lunar map
   * featuring all major maria, highlands, and ray craters.
   */
  async generateGlobalSyntheticMoon(sourceId = "lro_wac") {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    const isAltimetry = sourceId === "lola_shade";

    // 1. Base Regolith tone
    if (isAltimetry) {
      const grad = ctx.createLinearGradient(0, 512, 0, 0);
      grad.addColorStop(0, "#082f49"); // South Pole SPA basin
      grad.addColorStop(0.3, "#0284c7");
      grad.addColorStop(0.5, "#10b981");
      grad.addColorStop(0.7, "#facc15");
      grad.addColorStop(1, "#dc2626"); // Far side highlands
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = "#2a2d36"; // Anorthosite highland base
    }
    ctx.fillRect(0, 0, 1024, 512);

    // 2. Near Side Basalt Maria (Dark volcanic plains: Lon -90° to +90° -> X 256 to 768)
    if (!isAltimetry) {
      ctx.fillStyle = "#16181f"; // Dark titanium-rich mare basalt

      // Oceanus Procellarum & Mare Imbrium
      ctx.beginPath();
      ctx.ellipse(440, 210, 120, 95, 0, 0, Math.PI * 2);
      ctx.fill();

      // Mare Serenitatis & Mare Tranquillitatis (Apollo 11)
      ctx.beginPath();
      ctx.ellipse(560, 235, 75, 60, -0.2, 0, Math.PI * 2);
      ctx.fill();

      // Mare Crisium
      ctx.beginPath();
      ctx.ellipse(660, 220, 42, 35, 0, 0, Math.PI * 2);
      ctx.fill();

      // Mare Nubium & Mare Humorum
      ctx.beginPath();
      ctx.ellipse(470, 310, 65, 50, 0.3, 0, Math.PI * 2);
      ctx.fill();

      // Mare Fecunditatis & Nectaris
      ctx.beginPath();
      ctx.ellipse(610, 290, 55, 45, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // LOLA Topographic Maria Lowlands
      ctx.fillStyle = "#0369a1";
      ctx.beginPath();
      ctx.ellipse(500, 240, 160, 100, 0, 0, Math.PI * 2);
      ctx.fill();

      // South Pole - Aitken Basin (Deepest impact depression: 53°S, 169°W -> X 31, Y 406)
      ctx.fillStyle = "#021c38";
      ctx.beginPath();
      ctx.ellipse(31, 406, 95, 70, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(1024 + 31, 406, 95, 70, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3. Tycho Crater Ray System (43.3°S, 11.2°W -> X 480, Y 379)
    const tychoX = 480;
    const tychoY = 379;
    ctx.strokeStyle = isAltimetry ? "#fef08a" : "rgba(220, 225, 235, 0.65)";
    ctx.lineWidth = 1.5;

    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const rayLen = 90 + (i % 3) * 60;
      ctx.beginPath();
      ctx.moveTo(tychoX, tychoY);
      ctx.lineTo(tychoX + Math.cos(angle) * rayLen, tychoY + Math.sin(angle) * rayLen);
      ctx.stroke();
    }

    // Tycho bright crater core
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(tychoX, tychoY, 5, 0, Math.PI * 2);
    ctx.fill();

    // 4. Copernicus Crater Rays (9.6°N, 20.1°W -> X 455, Y 228)
    const copX = 455;
    const copY = 228;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(copX, copY, 4, 0, Math.PI * 2);
    ctx.fill();

    // 5. Grid Equator & Meridian overlay
    ctx.strokeStyle = "rgba(0, 229, 255, 0.25)";
    ctx.lineWidth = 1;
    ctx.strokeRect(0, 0, 1024, 512);

    return await createImageBitmap(canvas);
  }

  /**
   * Convert Latitude & Longitude to Equirectangular (EQ) WMTS tile matrix coordinates
   * NASA Moon Trek EQ grid:
   * Longitude: -180 to +180
   * Latitude: -90 to +90
   * At zoom level z: columns = 2^(z+1), rows = 2^z
   */
  latLonToEqTile(lat, lon, zoom) {
    // Clamp coordinates
    const clampedLat = Math.max(-89.9, Math.min(89.9, lat));
    const clampedLon = Math.max(-180.0, Math.min(180.0, lon));

    // Number of columns and rows at this matrix level
    // In Moon Trek EQ default028mm:
    // Matrix 0: 2 cols x 1 row
    // Matrix 1: 4 cols x 2 rows
    // Matrix z: 2^(z+1) cols x 2^z rows
    const cols = Math.pow(2, zoom + 1);
    const rows = Math.pow(2, zoom);

    const normX = (clampedLon + 180.0) / 360.0;
    const normY = (90.0 - clampedLat) / 180.0;

    const x = Math.min(cols - 1, Math.max(0, Math.floor(normX * cols)));
    const y = Math.min(rows - 1, Math.max(0, Math.floor(normY * rows)));

    // Geographic bounding box of this tile
    const lonMin = -180.0 + (x / cols) * 360.0;
    const lonMax = -180.0 + ((x + 1) / cols) * 360.0;
    const latMax = 90.0 - (y / rows) * 180.0;
    const latMin = 90.0 - ((y + 1) / rows) * 180.0;

    return { z: zoom, x, y, lonMin, lonMax, latMin, latMax, cols, rows };
  }

  /**
   * Convert Lat/Lon to standard Web Mercator XYZ tile (for OPM basemap)
   */
  latLonToXyzTile(lat, lon, zoom) {
    const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
    const clampedLon = Math.max(-180.0, Math.min(180.0, lon));

    const n = Math.pow(2, zoom);
    const x = Math.floor(((clampedLon + 180) / 360) * n);
    const latRad = (clampedLat * Math.PI) / 180;
    const y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
    );

    return { z: zoom, x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
  }

  /**
   * Fetch Real NASA Tile for given site and layer
   * Returns ImageBitmap ready for WebGPU texture upload
   */
  async fetchTileForSite(site, sourceId = "lro_wac", zoom = 4) {
    const source = NASA_TILE_SOURCES.find((s) => s.id === sourceId) || NASA_TILE_SOURCES[0];
    const targetZoom = Math.min(zoom, source.maxZoom);

    let tileCoords;
    if (source.type === "xyz_mercator") {
      const xyz = this.latLonToXyzTile(site.lat, site.lon, targetZoom);
      tileCoords = { ...xyz, ...this.latLonToEqTile(site.lat, site.lon, targetZoom) };
    } else {
      tileCoords = this.latLonToEqTile(site.lat, site.lon, targetZoom);
    }

    const tileUrl = source.getUrl(tileCoords.z, tileCoords.x, tileCoords.y);
    const cacheKey = `${source.id}_${tileCoords.z}_${tileCoords.x}_${tileCoords.y}`;

    this.currentTileInfo = {
      source,
      coords: tileCoords,
      url: tileUrl,
      siteName: site.name
    };

    if (this.cache.has(cacheKey)) {
      return {
        bitmap: this.cache.get(cacheKey),
        tileInfo: this.currentTileInfo,
        fromCache: true
      };
    }

    try {
      // Fetch real NASA tile with CORS headers
      const res = await fetch(tileUrl, { mode: "cors" });
      if (!res.ok) {
        throw new Error(`NASA Server responded with HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const bitmap = await createImageBitmap(blob);

      this.cache.set(cacheKey, bitmap);
      return {
        bitmap,
        tileInfo: this.currentTileInfo,
        fromCache: false
      };
    } catch (err) {
      console.warn(`[NASA Tile Fetch] Could not reach endpoint (${tileUrl}): ${err.message}. Generating high-precision synthetic tile fallback.`);
      // Generate synthetic lunar calibration tile with crater markings
      const fallbackBitmap = await this.generateSyntheticTile(site, tileCoords, source);
      this.cache.set(cacheKey, fallbackBitmap);
      return {
        bitmap: fallbackBitmap,
        tileInfo: { ...this.currentTileInfo, isFallback: true },
        fromCache: false
      };
    }
  }

  /**
   * Generates a high-contrast lunar calibration tile if offline or NASA rate-limited
   */
  async generateSyntheticTile(site, coords, source) {
    const canvas = document.createElement("canvas");
    canvas.width = 512;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");

    // Lunar background regolith tone
    const isAltimetry = source.id === "lola_shade";
    if (isAltimetry) {
      const grad = ctx.createLinearGradient(0, 0, 512, 512);
      grad.addColorStop(0, "#1e3a8a");
      grad.addColorStop(0.3, "#0284c7");
      grad.addColorStop(0.6, "#10b981");
      grad.addColorStop(0.85, "#facc15");
      grad.addColorStop(1, "#dc2626");
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = "#333742";
    }
    ctx.fillRect(0, 0, 512, 512);

    // Draw simulated lunar impact craters
    ctx.strokeStyle = isAltimetry ? "rgba(255,255,255,0.7)" : "rgba(255, 255, 255, 0.45)";
    ctx.fillStyle = isAltimetry ? "rgba(0,0,0,0.3)" : "rgba(20, 22, 28, 0.8)";
    ctx.lineWidth = 3;

    // Center focal crater
    ctx.beginPath();
    ctx.arc(256, 256, 120, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Secondary craters
    const offsets = [
      [110, 120, 35],
      [380, 140, 48],
      [130, 390, 40],
      [390, 380, 55],
      [256, 100, 25]
    ];
    for (const [cx, cy, cr] of offsets) {
      ctx.beginPath();
      ctx.arc(cx, cy, cr, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Grid coordinates overlay
    ctx.strokeStyle = "rgba(0, 229, 255, 0.35)";
    ctx.lineWidth = 1;
    ctx.strokeRect(4, 4, 504, 504);

    // Stamp tile telemetry text
    ctx.fillStyle = "#00e5ff";
    ctx.font = "bold 16px monospace";
    ctx.fillText(`NASA LRO TILE [Z:${coords.z} X:${coords.x} Y:${coords.y}]`, 18, 36);
    ctx.fillStyle = "#ffffff";
    ctx.font = "14px monospace";
    ctx.fillText(`TARGET: ${site.name.toUpperCase()}`, 18, 60);
    ctx.fillText(`BOUNDS: ${coords.latMin.toFixed(1)}° to ${coords.latMax.toFixed(1)}°`, 18, 84);

    return await createImageBitmap(canvas);
  }
}
