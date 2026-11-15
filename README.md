# SELENE-GPU &bull; WebGPU Lunar Site Navigator & Rendering Engine

**SELENE-GPU** is an interactive, hardware-accelerated 3D Lunar Site Navigator and terrain rendering engine built natively with **WebGPU** and **WGSL** (WebGPU Shading Language) for modern web browsers.

Designed for lunar exploration initiatives (Artemis III, VIPER, CLPS commercial landers, and future lunar bases), SELENE-GPU provides mission planners and engineers with real-time terrain analysis, low-grazing solar illumination simulation, slope hazard evaluation, and tactical rover traverse pathfinding.

---

## Key Technical Features

### 1. True WebGPU Architecture & Real NASA Tile Streaming
* **Dynamic Quadtree Tile LOD Engine:** Hierarchical Quadtree algorithm that subdivides planetary chunks from Level 0 (global) to Level 4+ (crater-scale) based on camera proximity and screen-space error.
* **Horizon & Back-Face Occlusion Culling:** Dynamically culls tiles located on the far side of the Moon relative to the observer horizon, slashing triangle count and memory footprint by $>50\%$.
* **NASA Planetary Tile Streamer:** Directly queries and streams official **NASA Moon Trek WMTS** (Web Map Tile Service) and **LRO (Lunar Reconnaissance Orbiter)** satellite tiles.
* **Hardware-Accelerated Render Pipelines:** Native WGSL vertex and fragment shaders compiled directly to GPU bytecode (DirectX 12 / Metal / Vulkan).
* **Parallel WebGPU Compute Pipeline (`cs_hazard_eval`):** Dispatches $16 \times 16$ GPU workgroup threads to analyze digital elevation models (DEM), slope gradients, and landing hazard cost matrices in parallel.
* **Zero Dependency Core:** Pure modern ES modules without bulky third-party bundles; instant load times and lightweight execution.

### 2. Multi-Mode Tactical Shading (WGSL)
* **Mode 0: Realistic Lunar PBR:** Anorthosite highlands vs dark mare basalt with regolith backscatter.
* **Mode 1: Slope Hazard Analysis:** False-color heatmap (Safe $<5^\circ$, Caution $5-12^\circ$, Hazard $>15^\circ$).
* **Mode 2: Hypsometric LOLA DEM Contours:** Spectral elevation map from $-6,000\,\text{m}$ to $+6,000\,\text{m}$.
* **Mode 3: Solar Illumination & South Pole PSRs:** Direct sunlight vs cold Permanently Shadowed Regions.
* **Mode 4: Composite Lander Hazard Footprint:** Integrates slope, surface curvature, and touchdown obstacle risks.
* **Mode 5: Tangent Space Normals:** Geometric slope visualization.
* **Mode 6: Quadtree LOD Heatmap:** Real-time visual debugging of tile subdivision levels:
  * 🟦 **LOD 0 (Deep Blue):** Global coarse hemisphere ($> 110$ units)
  * 🩵 **LOD 1 (Cyan):** Regional continent ($65 - 110$ units)
  * 🟩 **LOD 2 (Green):** Basin overview ($38 - 65$ units)
  * 🟨 **LOD 3 (Yellow):** Crater rim structure ($20 - 38$ units)
  * 🟧 **LOD 4 (Orange / Red):** High-precision tactical surface ($< 20$ units)

### 2. Real NASA Datasets Supported
* **NASA LRO WAC Global Mosaic (Photo):** Real high-resolution photographic imagery from NASA's Lunar Reconnaissance Orbiter Camera (303 pixels/degree).
* **NASA LOLA Topography (Color):** Laser altimeter topographic elevation data mapped into GPU texture memory.
* **OpenPlanetaryMap / CARTO Moon Basemap:** Fast global XYZ Web Mercator satellite basemap.
* **Live Tile Telemetry & Inspector:** Displays tile matrix index `[Z, X, Y]`, geographic bounding box `[LatMin, LatMax, LonMin, LonMax]`, live thumbnail preview, and team attribution.

### 2. Physically-Based Lunar Regolith Shading (Hapke / Lommel-Seeliger)
* Unlike standard Lambertian surfaces, lunar dust (regolith) exhibits strong retro-reflective backscattering.
* **Lommel-Seeliger Scattering:** Formulated as $\frac{\mu_0}{\mu_0 + \mu}$ where $\mu_0 = \cos(i)$ and $\mu = \cos(e)$.
* **Opposition Surge:** Non-linear brightness spike as phase angle approaches zero, simulating porous powder shadow-hiding.
* **Earthshine Illumination:** Faint diffuse blue-white light illuminating the deep shadowed craters of the near side.

### 3. Multi-Mode Tactical Shading (WGSL)
* **Mode 0: Realistic Lunar PBR:** Anorthosite highlands vs dark mare basalt with regolith backscatter.
* **Mode 1: Slope Hazard Analysis:** False-color heatmap:
  * Safe ($< 5^\circ$): Green
  * Caution ($5^\circ - 12^\circ$): Yellow/Amber
  * Dangerous / Exclusion ($> 15^\circ$): Red/Crimson
* **Mode 2: Hypsometric LOLA DEM Contours:** Spectral elevation map from $-6,000\,\text{m}$ basin depths to $+6,000\,\text{m}$ massif summits, with 250m isoline contours.
* **Mode 3: Solar Illumination & South Pole PSRs:** Direct solar exposure vs cold Permanently Shadowed Regions (PSRs harboring water ice).
* **Mode 4: Composite Lander Hazard Footprint:** Integrates slope, surface curvature, and touchdown obstacle risks.
* **Mode 5: Tangent Space Normals:** Geometric slope visualization.

### 4. Interactive Solar Angle Simulator
* Precision Azimuth ($0^\circ - 360^\circ$) and Altitude ($-5^\circ$ to $+45^\circ$) controls.
* Simulates low-grazing solar conditions ($1^\circ - 2^\circ$) at the lunar South Pole, revealing dramatic shadows shifting across crater rims.
* Automated orbital diurnal time-lapse mode.

### 5. Curated Artemis & Historic Landing Sites
* **Shackleton Crater Rim:** Primary Artemis III landing zone with permanently sunlit rims and ice-trapping crater interior.
* **Malapert Mountain (Massif):** 5,000m peak with continuous line-of-sight to Earth and near-permanent solar power.
* **Nobile Crater Rim 1:** Rolling hills selected for the VIPER volatile prospecting rover.
* **Apollo 11 (Statio Tranquillitatis):** Historic first crewed touchdown on basalt mare plains.
* **Aristarchus Plateau:** High albedo volcanic anomaly and giant lava tube rille.
* **Tycho Crater:** 108-million-year-old impact structure with massive central peak.

### 6. Tactical Rover Path Planner
* Computes optimal traversal corridors avoiding impassable crater bowls and steep slopes ($> 15^\circ$).
* Calculates total distance (km), maximum slope grade, and percentage of solar power availability along the path.

---

## Quick Start & Running

Start a local HTTP server in this directory:

```bash
# Using Python 3 (pre-installed):
python3 -m http.server 8000
```

Then open your browser to:
[http://localhost:8000](http://localhost:8000)

### Browser Compatibility
* **Recommended:** Google Chrome 113+ or Microsoft Edge 113+ (WebGPU is enabled by default).
* **Safari:** Safari Technology Preview (with WebGPU feature flag enabled in Developer menu).
* **Firefox:** Firefox Nightly (with `dom.webgpu.enabled` set to true in `about:config`).
* **Built-in Fallback:** If your browser or environment does not support WebGPU, SELENE-GPU includes an interactive software 3D shaded DEM fallback renderer so you can test all features without interruption.

---

## Directory Structure
```
/Users/cat/hackathon/
  ├── index.html                 # Mission control UI and canvas setup
  ├── style.css                  # Retro-futuristic aerospace HUD styling
  ├── README.md                  # Project documentation
  └── src/
       ├── main.js               # Application orchestrator & animation loop
       ├── engine/
       │    ├── gpuContext.js    # WebGPU adapter, device, and pipeline builder
       │    ├── camera.js        # 6-DOF Orbit, Rover Surface, and Top-down camera
       │    ├── math.js          # Vec3, Mat4, perspective, and inverse view-proj math
       │    ├── terrainMesh.js   # LOLA DEM procedural crater synthesis & grid builder
       │    ├── lunarSites.js    # Curated Artemis III & Apollo site database
       │    ├── pathPlanner.js   # Terrain-aware rover routing & cost evaluation
       │    └── fallbackRenderer.js # Interactive Canvas fallback
       └── shaders/
            ├── terrain.wgsl.js  # Multi-mode PBR & slope hazard WGSL shaders
            ├── skybox.wgsl.js   # Deep space starfield, Milky Way, and Earth WGSL
            └── hazardCompute.wgsl.js # Parallel WebGPU compute shader for hazard maps
```
