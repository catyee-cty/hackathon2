/**
 * WebGPU WGSL Shaders for Lunar Site Navigator Terrain Rendering
 * Features Hapke/Lommel-Seeliger regolith reflectance, dynamic solar angles,
 * slope hazard analysis, LOLA DEM hypsometric tinting, and PSR shadow detection.
 */

export const terrainWGSL = /* wgsl */ `
struct Uniforms {
  modelViewMatrix: mat4x4<f32>,
  projectionMatrix: mat4x4<f32>,
  sunDirection: vec3<f32>,
  sunElevationDeg: f32,
  cameraPos: vec3<f32>,
  shadingMode: u32,
  earthshineEnabled: u32,
  time: f32,
  wireframeMode: u32,
  useNasaTile: u32,
  isGlobeMode: u32,
  minSunlight: f32,
  minEarthVis: f32,
  maxSlope: f32,
  maxDarkness: f32,
  locationMappingEnabled: u32,
  targetSiteLat: f32,
  targetSiteLon: f32,
  targetSiteStatus: u32,
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;
// Binding 1: global equirectangular mosaic (1024×512, used at LOD 0-3)
@group(0) @binding(1) var globalTexture: texture_2d<f32>;
@group(0) @binding(2) var tileSampler: sampler;
// Binding 3: 2048×2048 atlas of 512×512 per-tile slots (LOD 4-6)
@group(0) @binding(3) var atlasTexture: texture_2d<f32>;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) uv: vec2<f32>,       // local tile UV [0,1] for atlas sampling
  @location(3) slope: f32,
  @location(4) elevation: f32,
  @location(5) curvature: f32,      // packed: atlasSlot*1000 + lodLevel
  @location(6) hazard: f32,
};

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) worldNormal: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) slope: f32,
  @location(4) elevation: f32,
  @location(5) curvature: f32,
  @location(6) hazard: f32,
  @location(7) viewDir: vec3<f32>,
  @location(8) globalUV: vec2<f32>, // equirectangular UV for global mosaic
};

@vertex
fn vs_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.worldPos = in.position;
  out.worldNormal = normalize(in.normal);
  out.uv = in.uv;
  out.slope = in.slope;
  out.elevation = in.elevation;
  out.curvature = in.curvature;
  out.hazard = in.hazard;

  // Equirectangular UV for globe mode vs flat texture coordinates for regional site mode
  if (u.isGlobeMode == 1u) {
    let normP = normalize(in.position);
    let lon = atan2(normP.x, normP.z);
    let lat = asin(clamp(normP.y, -1.0, 1.0));
    out.globalUV = vec2<f32>((lon + 3.14159265) / 6.2831853, (1.5707963 - lat) / 3.14159265);
  } else {
    out.globalUV = in.uv;
  }

  let viewPos = u.modelViewMatrix * vec4<f32>(in.position, 1.0);
  out.clipPosition = u.projectionMatrix * viewPos;
  out.viewDir = normalize(u.cameraPos - in.position);

  return out;
}

// ── Real-time GPU Procedural Regolith Synthesis Functions ──

fn hash31(p: vec3<f32>) -> f32 {
  let q = fract(p * 0.1031);
  let dotQ = dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * dotQ);
}

fn noise3D(p: vec3<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);

  let n000 = hash31(i + vec3<f32>(0.0, 0.0, 0.0));
  let n100 = hash31(i + vec3<f32>(1.0, 0.0, 0.0));
  let n010 = hash31(i + vec3<f32>(0.0, 1.0, 0.0));
  let n110 = hash31(i + vec3<f32>(1.0, 1.0, 0.0));
  let n001 = hash31(i + vec3<f32>(0.0, 0.0, 1.0));
  let n101 = hash31(i + vec3<f32>(1.0, 0.0, 1.0));
  let n011 = hash31(i + vec3<f32>(0.0, 1.0, 1.0));
  let n111 = hash31(i + vec3<f32>(1.0, 1.0, 1.0));

  let x0 = mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y);
  let x1 = mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y);
  return mix(x0, x1, u.z);
}

fn fbm3D(p: vec3<f32>) -> f32 {
  var v = 0.0;
  var a = 0.5;
  var pos = p;
  for (var i = 0u; i < 4u; i = i + 1u) {
    v = v + a * noise3D(pos);
    a = a * 0.5;
    pos = pos * 2.15;
  }
  return v;
}

// Unpack slot index from curvature channel
fn unpackSlot(curvature: f32) -> i32 {
  let slot = i32(curvature / 1000.0);
  if (slot >= 255) { return -1; }
  return slot;
}

fn unpackLod(curvature: f32) -> f32 {
  return curvature - f32(i32(curvature / 1000.0)) * 1000.0;
}

// Compute atlas UV for a given slot and local tile UV (16x16 grid = 256 slots)
fn atlasUV(slot: i32, localUV: vec2<f32>) -> vec2<f32> {
  let col = f32(slot % 16);
  let row = f32(slot / 16);
  return vec2<f32>(
    (col + clamp(localUV.x, 0.002, 0.998)) / 16.0,
    (row + clamp(localUV.y, 0.002, 0.998)) / 16.0
  );
}

// Sample best available texture for this fragment
// LOD-blend: at tile boundaries, cross-fade atlas → global to hide seams
fn sampleTileColor(in: VertexOutput) -> vec3<f32> {
  let slot = unpackSlot(in.curvature);

  let globalCol = textureSampleLevel(globalTexture, tileSampler, in.globalUV, 0.0).rgb;

  if (slot >= 0 && slot < 256) {
    let aUV = atlasUV(slot, in.uv);
    let atlasCol = textureSampleLevel(atlasTexture, tileSampler, aUV, 0.0).rgb;
    let bright = max(atlasCol.r, max(atlasCol.g, atlasCol.b));
    if (bright > 0.01) {
      // Soft LOD blend at tile UV edges to hide seams (fade atlas → global near tile border)
      let edgeU = min(in.uv.x, 1.0 - in.uv.x);
      let edgeV = min(in.uv.y, 1.0 - in.uv.y);
      let edgeFade = smoothstep(0.0, 0.025, min(edgeU, edgeV));
      return mix(globalCol, atlasCol, edgeFade);
    }
  }

  return globalCol;
}

// Color palette mapping helper
fn jetColormap(t: f32) -> vec3<f32> {
  let val = clamp(t, 0.0, 1.0);
  let r = clamp(1.5 - abs(val * 4.0 - 3.0), 0.0, 1.0);
  let g = clamp(1.5 - abs(val * 4.0 - 2.0), 0.0, 1.0);
  let b = clamp(1.5 - abs(val * 4.0 - 1.0), 0.0, 1.0);
  return vec3<f32>(r, g, b);
}

// Lunar Regolith Hapke / Lommel-Seeliger scattering model
fn calculateLunarPBR(normal: vec3<f32>, viewDir: vec3<f32>, sunDir: vec3<f32>, elev: f32, in: VertexOutput) -> vec3<f32> {
  let lodLevel = unpackLod(in.curvature);
  let lodBlend = smoothstep(1.5, 5.5, lodLevel);
  let closeBlend = smoothstep(3.5, 6.0, lodLevel);

  // ── Procedural Micro-Normal Perturbation at Max Zoom ──
  // Adds physical surface micro-roughness that catches grazing sunlight (only computed at close range)
  var N = normal;
  if (lodBlend > 0.01) {
    let bumpFreq = 20.0 + lodLevel * 15.0;
    let bumpStrength = 0.07 * lodBlend;
    let np1 = noise3D(in.worldPos * bumpFreq);
    let np2 = noise3D((in.worldPos + vec3<f32>(0.012, 0.0, 0.0)) * bumpFreq);
    let np3 = noise3D((in.worldPos + vec3<f32>(0.0, 0.012, 0.0)) * bumpFreq);
    let dNx = (np2 - np1) * bumpStrength;
    let dNy = (np3 - np1) * bumpStrength;
    N = normalize(normal + vec3<f32>(dNx, dNy, -(dNx + dNy) * 0.5));
  }

  let mu0 = max(dot(N, sunDir), 0.0); // Cosine of solar incidence
  let mu = max(dot(N, viewDir), 0.001); // Cosine of emission

  // Phase angle g
  let cosG = clamp(dot(sunDir, viewDir), -1.0, 1.0);
  let phaseAngle = acos(cosG);

  // Lommel-Seeliger function: prominent in porous powdery dust like lunar regolith
  var lommelSeeliger = 0.0;
  if (mu0 > 0.0001) {
    lommelSeeliger = mu0 / (mu0 + mu);
  }

  // Lunar Opposition Surge (retro-reflection spike at low phase angles)
  let h = 0.06; // Opposition surge width parameter for lunar regolith
  let B0 = 1.6; // Surge amplitude
  let oppositionSurge = 1.0 + B0 / (1.0 + (phaseAngle / h));

  // ── NASA Lunar Material Composition ──
  // Base regolith albedo: dark mare basalt (-2500m) vs bright anorthosite highlands (+3000m)
  let albedoBlend = smoothstep(-2400.0, 2800.0, elev);
  // Mare: 0.085 (titanium basalt) | Highlands: 0.245 (feldspathic anorthosite)
  var regolithColor = mix(vec3<f32>(0.09, 0.092, 0.096), vec3<f32>(0.24, 0.245, 0.255), albedoBlend);

  // Fresh exposed rock on steep slopes (>14°) from downslope mass wasting
  let slopeFreshness = smoothstep(12.0, 24.0, in.slope) * 0.08;
  regolithColor += vec3<f32>(slopeFreshness);

  // Sample real NASA satellite tile imagery or atlas tile
  let slot = unpackSlot(in.curvature);
  if (u.useNasaTile == 1u) {
    let sampledTile = sampleTileColor(in);
    let tileLum = max(sampledTile.r, max(sampledTile.g, sampledTile.b));
    if (tileLum > 0.01) {
      if (slot >= 0) {
        // High-res dedicated per-tile texture
        regolithColor = mix(regolithColor, sampledTile, 0.75);
      } else {
        // Global mosaic background
        regolithColor = mix(regolithColor, sampledTile, 0.55);
      }
    }
  }

  // ── High-Fidelity Procedural Regolith & Multi-Scale Crater Synthesis Everywhere on the Planet ──
  // Guarantees every visible tile has rich, sharp impact craters, raised rims, and micro-texture
  if (lodBlend > 0.01) {
    let p1 = in.worldPos * (22.0 + lodLevel * 12.0);
    let p2 = in.worldPos * (65.0 + lodLevel * 30.0);
    let p3 = in.worldPos * (180.0 + lodLevel * 70.0);

    let c1 = noise3D(p1);
    let c2 = noise3D(p2);
    let c3 = noise3D(p3);

    // Multi-scale impact crater bowls (dark floors) with bright raised rims
    var craterMod = 1.0;
    if (c1 < 0.26) {
      craterMod *= (0.64 + c1 * 1.4); // Major crater bowl
    } else if (c1 < 0.34) {
      craterMod *= (1.0 + (0.34 - c1) * 3.0); // Major crater raised rim
    }

    if (c2 < 0.24) {
      craterMod *= (0.72 + c2 * 1.16); // Secondary crater bowl
    } else if (c2 < 0.31) {
      craterMod *= (1.0 + (0.31 - c2) * 2.4); // Secondary crater raised rim
    }

    if (closeBlend > 0.01) {
      if (c3 < 0.22) {
        craterMod *= (0.80 + c3 * 0.90); // Micro-crater bowl
      } else if (c3 < 0.28) {
        craterMod *= (1.0 + (0.28 - c3) * 2.1); // Micro-crater raised rim
      }
    }

    // Physical powdery regolith grain texture
    let microGrain = (noise3D(p1 * 2.1) * 0.55 + noise3D(p2 * 1.7) * 0.45 - 0.5) * 0.32 * lodBlend;

    let totalMod = clamp(craterMod + microGrain, 0.40, 1.70);
    regolithColor = regolithColor * mix(1.0, totalMod, lodBlend);
  }

  // Fresh crater ejecta bright rays (long bright streaks emanating from major craters)
  let rayNoise = noise3D(in.worldPos * 3.8) * 0.65 + noise3D(in.worldPos * 8.5) * 0.35;
  if (rayNoise > 0.66) {
    let ejectaGlint = (rayNoise - 0.66) * 0.40;
    regolithColor += vec3<f32>(ejectaGlint);
  }

  // Direct sun diffuse
  let sunColor = vec3<f32>(1.0, 0.98, 0.93) * 3.4;
  var directLight = regolithColor * lommelSeeliger * oppositionSurge * sunColor;

  // Earthshine: visible blue-white radiance illuminating near-side dark terrain & polar cold traps
  if (u.earthshineEnabled == 1u) {
    let earthDir = normalize(vec3<f32>(0.0, 0.15, 1.0));
    let earthMu = max(dot(N, earthDir), 0.0);
    let earthshineColor = vec3<f32>(0.14, 0.24, 0.42);
    directLight += earthshineColor * earthMu * regolithColor * 1.8;
  }

  // Deep space ambient radiation / starlight / coronal haze (ensures night side is cleanly discernable)
  directLight += regolithColor * 0.055;

  return directLight;
}

// ── Surface Distance & Projected 3D Landing Zone Reticle Functions ──────────

// Spherical 3D geodesic distance on lunar sphere (R = 1737.4 km)
fn siteUnitVector(latDeg: f32, lonDeg: f32) -> vec3<f32> {
  let latRad = latDeg * (3.14159265 / 180.0);
  let lonRad = lonDeg * (3.14159265 / 180.0);
  let cosLat = cos(latRad);
  return vec3<f32>(cosLat * sin(lonRad), sin(latRad), cosLat * cos(lonRad));
}

fn globeGeodesicDistKm(normP: vec3<f32>, siteDir: vec3<f32>) -> f32 {
  let dotVal = clamp(dot(normP, siteDir), -1.0, 1.0);
  return acos(dotVal) * 1737.4;
}

// Draw a tactical holographic landing reticle footprint on lunar terrain
fn renderSiteReticle(distKm: f32, color: vec3<f32>, isTargeted: u32, timeSec: f32) -> vec3<f32> {
  var glow = vec3<f32>(0.0);
  if (distKm > 60.0) { return glow; }

  // 1. Broad site beacon halo (visible from orbital altitude)
  let halo = smoothstep(12.0, 0.0, distKm) * 0.45;

  // 2. Outer tactical boundary ring (20 km radius)
  let ring1 = smoothstep(2.0, 0.0, abs(distKm - 20.0)) * 0.85;

  // 3. Inner touchdown boundary circle (7 km radius)
  let ring2 = smoothstep(1.4, 0.0, abs(distKm - 7.0)) * 0.95;

  // 4. Central landing beacon dot
  let beacon = smoothstep(3.0, 0.0, distKm) * (1.2 + 0.3 * sin(timeSec * 5.0));

  glow = (halo + ring1 + ring2 + beacon) * color;

  // 5. Dynamic radar pulse wave for the active targeted candidate
  if (isTargeted == 1u) {
    let wave = fract(timeSec * 0.85 - distKm * 0.035);
    let wavePulse = smoothstep(0.12, 0.0, abs(wave - 0.5)) * exp(-distKm * 0.035);
    glow += wavePulse * vec3<f32>(0.0, 0.95, 1.0) * 1.3;
  }

  return glow;
}

// Location Mapping & Suitability Overlay for Normal PBR Moon Viewer
fn applyLocationMappingOverlay(pbrColor: vec3<f32>, in: VertexOutput) -> vec3<f32> {
  var latDeg = 0.0;
  var lonDeg = 0.0;
  var normP = vec3<f32>(0.0, -1.0, 0.0);

  if (u.isGlobeMode == 1u) {
    normP = normalize(in.worldPos);
    let lon = atan2(normP.x, normP.z);
    let lat = asin(clamp(normP.y, -1.0, 1.0));
    latDeg = lat * (180.0 / 3.14159265);
    lonDeg = lon * (180.0 / 3.14159265);
  } else {
    let kmPerDeg = 30.32;
    let dLatDeg = -in.worldPos.z / kmPerDeg;
    let cosLat = max(0.015, cos(u.targetSiteLat * (3.14159265 / 180.0)));
    let dLonDeg = in.worldPos.x / (kmPerDeg * cosLat);
    latDeg = u.targetSiteLat + dLatDeg;
    lonDeg = u.targetSiteLon + dLonDeg;
  }

  var outColor = pbrColor;

  // 1. Earth visibility model (DTE comms line-of-sight)
  let latRad = latDeg * (3.14159265 / 180.0);
  let lonRad = lonDeg * (3.14159265 / 180.0);
  var earthVis = max(0.0, cos(lonRad) * cos(latRad));
  if (latDeg < -82.0) {
    let elevNorm = clamp((in.elevation + 2000.0) / 7000.0, 0.0, 1.0);
    earthVis = clamp(0.40 + elevNorm * 0.55, 0.0, 1.0);
  }
  let earthVisPct = earthVis * 100.0;

  // 2. Solar illumination availability model
  var sunPct = 50.0;
  if (latDeg < -80.0) {
    let elevNorm = clamp((in.elevation + 4000.0) / 9000.0, 0.0, 1.0);
    sunPct = clamp(15.0 + elevNorm * 80.0, 0.0, 95.0);
  } else if (latDeg > 80.0) {
    let elevNorm = clamp((in.elevation + 4000.0) / 9000.0, 0.0, 1.0);
    sunPct = clamp(15.0 + elevNorm * 80.0, 0.0, 95.0);
  }

  let slope = in.slope;

  // 3. Maximum continuous darkness (hours)
  var darknessHrs = 354.0;
  if (latDeg < -80.0) {
    darknessHrs = clamp(354.0 - (sunPct / 95.0) * 320.0, 18.0, 354.0);
  }

  let slopePassed = slope <= u.maxSlope;
  let sunPassed = sunPct >= u.minSunlight;
  let earthPassed = earthVisPct >= u.minEarthVis;
  let darknessPassed = darknessHrs <= u.maxDarkness;

  // A. Holographic Suitability Wash on PBR Surface
  if (slopePassed && sunPassed && earthPassed && darknessPassed) {
    // Prime suitable touchdown zone: Glowing iridescent emerald wash
    let slopeBonus = 1.0 - (slope / max(u.maxSlope, 1.0));
    let aura = mix(vec3<f32>(0.06, 0.95, 0.48), vec3<f32>(0.0, 1.0, 0.85), slopeBonus);
    outColor = mix(outColor, outColor * 1.25 + aura * 0.45, 0.35);

    // Subtle holographic coordinate grid lines over suitable areas
    let gridX = abs(fract(in.worldPos.x * 0.4) - 0.5);
    let gridZ = abs(fract(in.worldPos.z * 0.4) - 0.5);
    if (gridX < 0.025 || gridZ < 0.025) {
      outColor += aura * 0.25;
    }
  } else if (!slopePassed && slope > u.maxSlope * 1.2) {
    // Slope hazard: subtle amber contour warning on steep crater cliffs
    outColor = mix(outColor, outColor + vec3<f32>(0.45, 0.20, 0.02), 0.20);
  } else if (!earthPassed) {
    // Comms shadow: subtle cool deep-space tint
    outColor = mix(outColor, outColor * vec3<f32>(0.75, 0.82, 1.15), 0.20);
  }

  // B. Projected 3D Landing Reticles for Key Candidate Sites
  if (u.isGlobeMode == 1u) {
    // 1. Shackleton Connecting Ridge (-89.9°, 0.0°)
    let dShackleton = globeGeodesicDistKm(normP, siteUnitVector(-89.9, 0.0));
    outColor += renderSiteReticle(dShackleton, vec3<f32>(0.06, 1.0, 0.55), 0u, u.time);

    // 2. Malapert Mountain Massif (-86.0°, 2.7°)
    let dMalapert = globeGeodesicDistKm(normP, siteUnitVector(-86.0, 2.7));
    outColor += renderSiteReticle(dMalapert, vec3<f32>(0.06, 1.0, 0.55), 0u, u.time);

    // 3. Mons Mouton (-84.8°, 31.0°)
    let dMouton = globeGeodesicDistKm(normP, siteUnitVector(-84.8, 31.0));
    outColor += renderSiteReticle(dMouton, vec3<f32>(0.06, 1.0, 0.55), 0u, u.time);

    // 4. Nobile Crater Rim 1 (-85.2°, 53.5°)
    let dNobile = globeGeodesicDistKm(normP, siteUnitVector(-85.2, 53.5));
    outColor += renderSiteReticle(dNobile, vec3<f32>(0.06, 1.0, 0.55), 0u, u.time);

    // 5. Apollo 11 Mare Tranquillitatis (0.67°, 23.47°)
    let dApollo11 = globeGeodesicDistKm(normP, siteUnitVector(0.67, 23.47));
    outColor += renderSiteReticle(dApollo11, vec3<f32>(0.0, 0.85, 1.0), 0u, u.time);

    // 6. Active Target Candidate Site
    let dTarget = globeGeodesicDistKm(normP, siteUnitVector(u.targetSiteLat, u.targetSiteLon));
    var targetColor = vec3<f32>(0.06, 1.0, 0.55); // Green if qualified
    if (u.targetSiteStatus == 1u) {
      targetColor = vec3<f32>(1.0, 0.75, 0.1); // Amber if marginal
    } else if (u.targetSiteStatus == 2u) {
      targetColor = vec3<f32>(1.0, 0.15, 0.15); // Red if excluded
    }
    outColor += renderSiteReticle(dTarget, targetColor, 1u, u.time);
  } else {
    // Regional Site Mode: Active target is centered on mesh
    let dTarget = length(in.worldPos.xz);
    var targetColor = vec3<f32>(0.06, 1.0, 0.55);
    if (u.targetSiteStatus == 1u) {
      targetColor = vec3<f32>(1.0, 0.75, 0.1);
    } else if (u.targetSiteStatus == 2u) {
      targetColor = vec3<f32>(1.0, 0.15, 0.15);
    }
    outColor += renderSiteReticle(dTarget, targetColor, 1u, u.time);
  }

  return outColor;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let N = normalize(in.worldNormal);
  let V = normalize(in.viewDir);
  let L = normalize(u.sunDirection);

  var finalColor = vec3<f32>(0.0);

  // Mode 0: Realistic Lunar Regolith PBR
  if (u.shadingMode == 0u) {
    finalColor = calculateLunarPBR(N, V, L, in.elevation, in);
    // Location Mapping & Suitability Overlay for Normal PBR Moon Viewer
    if (u.locationMappingEnabled == 1u) {
      finalColor = applyLocationMappingOverlay(finalColor, in);
    }
  }
  // Mode 1: Slope Hazard Analysis (Green < 5°, Yellow 5-12°, Red > 15°)
  else if (u.shadingMode == 1u) {
    let slope = in.slope;
    if (slope < 5.0) {
      // Safe (Green to Cyan)
      let t = slope / 5.0;
      finalColor = mix(vec3<f32>(0.06, 0.85, 0.45), vec3<f32>(0.1, 0.9, 0.8), t);
    } else if (slope < 12.0) {
      // Moderate Caution (Yellow to Amber)
      let t = (slope - 5.0) / 7.0;
      finalColor = mix(vec3<f32>(0.95, 0.8, 0.1), vec3<f32>(1.0, 0.5, 0.05), t);
    } else if (slope < 20.0) {
      // Severe Hazard (Orange to Red)
      let t = (slope - 12.0) / 8.0;
      finalColor = mix(vec3<f32>(1.0, 0.35, 0.05), vec3<f32>(0.9, 0.1, 0.1), t);
    } else {
      // Extreme Hazard (Deep Crimson)
      finalColor = vec3<f32>(0.65, 0.02, 0.08);
    }

    // Overlay subtle relief shading for 3D depth perception
    let nDotL = max(dot(N, L), 0.0) * 0.45 + 0.55;
    finalColor *= nDotL;
  }
  // Mode 2: Hypsometric LOLA DEM Contours (-6000m to +6000m)
  else if (u.shadingMode == 2u) {
    var demColor = vec3<f32>(0.0);
    if (u.useNasaTile == 1u) {
      demColor = sampleTileColor(in);
      let lum = max(demColor.r, max(demColor.g, demColor.b));
      if (lum < 0.01) {
        let t = clamp((in.elevation + 4500.0) / 9500.0, 0.0, 1.0);
        demColor = jetColormap(t);
      }
    } else {
      let t = clamp((in.elevation + 4500.0) / 9500.0, 0.0, 1.0);
      demColor = jetColormap(t);
    }

    // Isoline contour bands every 250m
    let contourDist = abs(fract(in.elevation / 250.0) - 0.5) * 2.0;
    if (contourDist < 0.12) {
      demColor = mix(demColor, vec3<f32>(1.0), 0.6);
    }

    let nDotL = max(dot(N, L), 0.0) * 0.4 + 0.6;
    finalColor = demColor * nDotL;
  }
  // Mode 3: Solar Illumination & South Pole PSRs
  else if (u.shadingMode == 3u) {
    let nDotL = dot(N, L);
    if (nDotL > 0.02) {
      // Direct sunlight (Sun-exposed peak)
      let intensity = smoothstep(0.02, 0.5, nDotL);
      finalColor = mix(vec3<f32>(0.9, 0.75, 0.3), vec3<f32>(1.0, 0.95, 0.8), intensity);
    } else {
      // Permanently Shadowed Region (Cold cryo-trap)
      finalColor = vec3<f32>(0.05, 0.18, 0.38);
    }
  }
  // Mode 4: Lander Hazard Heatmap (Composite slope + curvature)
  else if (u.shadingMode == 4u) {
    let score = in.hazard;
    if (score < 0.28) {
      // Prime Safe Touchdown Zone
      finalColor = vec3<f32>(0.08, 0.9, 0.45);
    } else if (score < 0.6) {
      // Elevated Landing Risk
      finalColor = vec3<f32>(0.95, 0.75, 0.1);
    } else {
      // Landing Exclusion Zone
      finalColor = vec3<f32>(0.95, 0.15, 0.15);
    }

    // Grid landing pattern overlay
    let gridX = abs(fract(in.worldPos.x * 0.5) - 0.5);
    let gridZ = abs(fract(in.worldPos.z * 0.5) - 0.5);
    if (gridX < 0.03 || gridZ < 0.03) {
      finalColor = mix(finalColor, vec3<f32>(1.0), 0.35);
    }

    let nDotL = max(dot(N, L), 0.0) * 0.35 + 0.65;
    finalColor *= nDotL;
  }
  // Mode 5: Surface Normals
  else if (u.shadingMode == 5u) {
    finalColor = N * 0.5 + vec3<f32>(0.5);
  }
  // Mode 6: Quadtree Tile LOD Visualizer
  else if (u.shadingMode == 6u) {
    let lod = unpackLod(in.curvature);
    if (lod < 0.5) {
      finalColor = vec3<f32>(0.12, 0.35, 0.95); // LOD 0: Deep Blue
    } else if (lod < 1.5) {
      finalColor = vec3<f32>(0.05, 0.8, 0.85);  // LOD 1: Cyan
    } else if (lod < 2.5) {
      finalColor = vec3<f32>(0.15, 0.85, 0.25); // LOD 2: Green
    } else if (lod < 3.5) {
      finalColor = vec3<f32>(0.95, 0.85, 0.1);  // LOD 3: Yellow
    } else if (lod < 4.5) {
      finalColor = vec3<f32>(1.0, 0.5, 0.05);   // LOD 4: Orange
    } else if (lod < 5.5) {
      finalColor = vec3<f32>(0.95, 0.15, 0.2);  // LOD 5: Red
    } else {
      finalColor = vec3<f32>(1.0, 0.0, 0.8);    // LOD 6: Magenta (Max Resolution)
    }

    // Show atlas slot occupation as brightness tint
    let slot = unpackSlot(in.curvature);
    if (slot >= 0) {
      finalColor = mix(finalColor, vec3<f32>(1.0), 0.2); // brighter = textured
    }

    // Render chunk borders
    let uvChunk = abs(fract(in.uv * 32.0) - vec2<f32>(0.5));
    if (uvChunk.x > 0.46 || uvChunk.y > 0.46) {
      finalColor = mix(finalColor, vec3<f32>(1.0), 0.7);
    }
    finalColor *= (max(dot(N, L), 0.0) * 0.35 + 0.65);
  }
  // Mode 7: Colour-Coded Mission Suitability Map
  else if (u.shadingMode == 7u) {
    let normP = normalize(in.worldPos);
    let lon = atan2(normP.x, normP.z);
    let lat = asin(clamp(normP.y, -1.0, 1.0));
    let latDeg = lat * (180.0 / 3.14159265);

    // 1. Earth visibility model (Direct-to-Earth line-of-sight)
    var earthVis = max(0.0, cos(lon) * cos(lat));
    if (latDeg < -82.0) {
      let elevNorm = clamp((in.elevation + 2000.0) / 7000.0, 0.0, 1.0);
      earthVis = clamp(0.40 + elevNorm * 0.55, 0.0, 1.0);
    }
    let earthVisPct = earthVis * 100.0;

    // 2. Solar illumination availability model
    var sunPct = 50.0;
    if (latDeg < -80.0) {
      let elevNorm = clamp((in.elevation + 4000.0) / 9000.0, 0.0, 1.0);
      sunPct = clamp(15.0 + elevNorm * 80.0, 0.0, 95.0);
    } else if (latDeg > 80.0) {
      let elevNorm = clamp((in.elevation + 4000.0) / 9000.0, 0.0, 1.0);
      sunPct = clamp(15.0 + elevNorm * 80.0, 0.0, 95.0);
    }

    // 3. Terrain slope
    let slope = in.slope;

    // 4. Maximum continuous darkness (hours)
    var darknessHrs = 354.0;
    if (latDeg < -80.0) {
      darknessHrs = clamp(354.0 - (sunPct / 95.0) * 320.0, 18.0, 354.0);
    }

    let slopePassed = slope <= u.maxSlope;
    let sunPassed = sunPct >= u.minSunlight;
    let earthPassed = earthVisPct >= u.minEarthVis;
    let darknessPassed = darknessHrs <= u.maxDarkness;

    if (slopePassed && sunPassed && earthPassed && darknessPassed) {
      // PRIME QUALIFIED LANDING ZONE: High-contrast Glowing Emerald Green
      let slopeBonus = 1.0 - (slope / max(u.maxSlope, 1.0));
      let sunBonus = (sunPct - u.minSunlight) / max(100.0 - u.minSunlight, 1.0);
      finalColor = mix(vec3<f32>(0.06, 0.88, 0.48), vec3<f32>(0.0, 1.0, 0.85), clamp(slopeBonus * 0.5 + sunBonus * 0.5, 0.0, 1.0));
    } else if (!earthPassed) {
      // DISQUALIFIED: NO EARTH VISIBILITY / COMMS BLACKOUT SHADOW (Deep Space Navy Blue)
      finalColor = vec3<f32>(0.07, 0.10, 0.24);
    } else if (!slopePassed && (!sunPassed || !darknessPassed)) {
      // SEVERE MULTI-HAZARD EXCLUSION ZONE (Crimson Red)
      finalColor = vec3<f32>(0.88, 0.08, 0.12);
    } else if (!slopePassed) {
      // VIOLATION: SLOPE EXCEEDS LANDER LIMIT (Safety Hazard: Amber-Orange)
      finalColor = vec3<f32>(0.96, 0.48, 0.06);
    } else {
      // VIOLATION: INSUFFICIENT SUNLIGHT / EXCESSIVE DARKNESS (Cryo Risk Blue)
      finalColor = vec3<f32>(0.22, 0.45, 0.88);
    }

    // Landing grid overlay for spatial reference
    let gridX = abs(fract(in.worldPos.x * 0.2) - 0.5);
    let gridZ = abs(fract(in.worldPos.z * 0.2) - 0.5);
    if (gridX < 0.02 || gridZ < 0.02) {
      finalColor = mix(finalColor, vec3<f32>(1.0), 0.30);
    }

    let nDotL = max(dot(N, L), 0.0) * 0.35 + 0.65;
    finalColor *= nDotL;
  }

  // Wireframe contour overlay if toggled
  if (u.wireframeMode == 1u) {
    let uvGrid = abs(fract(in.globalUV * 128.0) - vec2<f32>(0.5));
    if (uvGrid.x < 0.04 || uvGrid.y < 0.04) {
      finalColor = mix(finalColor, vec3<f32>(0.0, 0.9, 1.0), 0.75);
    }
  }

  return vec4<f32>(finalColor, 1.0);
}
`;
