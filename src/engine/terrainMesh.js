/**
 * High-Density Terrain Mesh Generator with LOLA DEM Crater Synthesis
 * Produces vertex buffers, index buffers, normals, and elevation attributes for WebGPU rendering.
 */

// Improved multi-octave simplex/Perlin-style noise for realistic lunar topography
function hash(x, y) {
  let h = (Math.imul(x, 374761393) ^ Math.imul(y, 668265263)) >>> 0;
  h = (h ^ (h >> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return (h ^ (h >> 16)) / 4294967296.0;
}

function noise2D(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;

  // Smooth quintic interpolation: 6t^5 - 15t^4 + 10t^3
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);

  const n00 = hash(ix, iy) * 2 - 1;
  const n10 = hash(ix + 1, iy) * 2 - 1;
  const n01 = hash(ix, iy + 1) * 2 - 1;
  const n11 = hash(ix + 1, iy + 1) * 2 - 1;

  const nx0 = n00 + ux * (n10 - n00);
  const nx1 = n01 + ux * (n11 - n01);
  return nx0 + uy * (nx1 - nx0);
}

function fbm(x, y, octaves = 5) {
  let val = 0.0;
  let amp = 0.5;
  let freq = 1.0;
  for (let i = 0; i < octaves; i++) {
    val += amp * noise2D(x * freq, y * freq);
    freq *= 2.05;
    amp *= 0.48;
  }
  return val;
}

/**
 * Crater Impact Profile with Rim and Central Peak
 * r: distance to crater center
 * R: crater radius
 * depth: crater bowl depth
 */
function craterProfile(dist, radius, depth) {
  const normDist = dist / radius;
  if (normDist > 2.5) return 0;

  // Interior bowl: parabolic depression
  if (normDist <= 1.0) {
    const bowl = -depth * (1.0 - Math.pow(normDist, 2.0));
    // Central peak for large impact structures
    const peak = (radius > 12.0) ? (depth * 0.38 * Math.exp(-Math.pow(normDist / 0.18, 2.0))) : 0;
    return bowl + peak;
  }

  // Raised crater rim and ejecta blanket: exponential decay outside rim
  const rimHeight = depth * 0.26;
  const rimWidth = 0.45;
  const ejecta = rimHeight * Math.exp(-Math.pow((normDist - 1.0) / rimWidth, 2.0));
  return ejecta;
}

/**
 * Procedural Lunar DEM Elevation Function (returns height in meters)
 */
export function getLunarHeight(worldX, worldZ, siteParams = null) {
  // Base highland undulating terrain (-3000m to +3000m)
  let elevation = fbm(worldX * 0.012, worldZ * 0.012, 6) * 1600.0;
  elevation += fbm(worldX * 0.045, worldZ * 0.045, 4) * 450.0;
  elevation += fbm(worldX * 0.18, worldZ * 0.18, 3) * 80.0;

  // Site-specific focal crater structure (e.g., Shackleton or selected target)
  const focalX = siteParams?.targetOffset?.[0] ? siteParams.targetOffset[0] * 50.0 : 0.0;
  const focalZ = siteParams?.targetOffset?.[1] ? siteParams.targetOffset[1] * 50.0 : 0.0;
  const focalRadius = siteParams?.craterRadius || 22.0;
  const focalDepth = Math.min(focalRadius * 160.0, 4200.0);

  const dFocal = Math.hypot(worldX - focalX, worldZ - focalZ);
  elevation += craterProfile(dFocal, focalRadius, focalDepth);

  // Distribution of secondary and tertiary impact craters
  const secondaryCraters = [
    { x: -28.0, z: 22.0, r: 8.5, d: 900.0 },
    { x: 34.0, z: -18.0, r: 12.0, d: 1400.0 },
    { x: 15.0, z: 32.0, r: 6.0, d: 650.0 },
    { x: -38.0, z: -25.0, r: 14.0, d: 1600.0 },
    { x: -5.0, z: -35.0, r: 7.5, d: 750.0 },
    { x: 42.0, z: 28.0, r: 9.0, d: 1050.0 }
  ];

  for (const c of secondaryCraters) {
    const d = Math.hypot(worldX - c.x, worldZ - c.z);
    elevation += craterProfile(d, c.r, c.d);
  }

  // Micro-craters / regolith pitting
  const microNoise = noise2D(worldX * 0.8, worldZ * 0.8);
  if (microNoise < -0.45) {
    elevation -= Math.abs(microNoise + 0.45) * 60.0;
  }

  return elevation;
}

/**
 * Generate a dense terrain grid mesh
 * size: geographic extent in km (e.g. 100km x 100km)
 * resolution: grid vertices per side (e.g. 256)
 */
export function createTerrainMesh(size = 90.0, resolution = 256, site = null) {
  const vertexCount = resolution * resolution;
  const indexCount = (resolution - 1) * (resolution - 1) * 6;

  // Stride: 12 floats per vertex
  // [pos.xyz (3), norm.xyz (3), uv.xy (2), slope (1), elevation (1), curvature (1), hazard (1)]
  const stride = 12;
  const vertices = new Float32Array(vertexCount * stride);
  const indices = new Uint32Array(indexCount);

  const halfSize = size / 2.0;
  const step = size / (resolution - 1);

  // Height cache for fast normal calculation
  const heightCache = new Float32Array(vertexCount);
  let minElev = 999999, maxElev = -999999;

  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const idx = z * resolution + x;
      const wx = -halfSize + x * step;
      const wz = -halfSize + z * step;
      const h = getLunarHeight(wx, wz, site);
      heightCache[idx] = h;
      if (h < minElev) minElev = h;
      if (h > maxElev) maxElev = h;
    }
  }

  // Compute positions, normals, slopes, and hazard ratings
  for (let z = 0; z < resolution; z++) {
    for (let x = 0; x < resolution; x++) {
      const idx = z * resolution + x;
      const vIdx = idx * stride;

      const wx = -halfSize + x * step;
      const wz = -halfSize + z * step;
      const wy = heightCache[idx];

      // Central differences for high-precision normal & slope
      const xLeft = (x > 0) ? heightCache[z * resolution + (x - 1)] : wy;
      const xRight = (x < resolution - 1) ? heightCache[z * resolution + (x + 1)] : wy;
      const zUp = (z > 0) ? heightCache[(z - 1) * resolution + x] : wy;
      const zDown = (z < resolution - 1) ? heightCache[(z + 1) * resolution + x] : wy;

      const dx = (xRight - xLeft) / (2.0 * step * 1000.0); // convert km step to meters
      const dz = (zDown - zUp) / (2.0 * step * 1000.0);

      // Normal = normalize(-dh/dx, 1, -dh/dz)
      const nx = -dx;
      const ny = 1.0;
      const nz = -dz;
      const nLen = Math.hypot(nx, ny, nz);
      const normX = nx / nLen;
      const normY = ny / nLen;
      const normZ = nz / nLen;

      // Slope angle in degrees (angle from vertical (0,1,0))
      // dot(norm, (0,1,0)) = normY
      const slopeRad = Math.acos(Math.max(0.0, Math.min(1.0, normY)));
      const slopeDeg = slopeRad * (180.0 / Math.PI);

      // Local curvature / roughness
      const curvature = Math.abs(xRight + xLeft + zDown + zUp - 4.0 * wy) / 100.0;

      // Lander Hazard Score (0 = ultra safe, 1 = dangerous tip risk)
      // Steepness > 15° or high roughness creates hazardous landing zones
      let hazardScore = Math.min(1.0, slopeDeg / 18.0);
      hazardScore = Math.max(hazardScore, Math.min(1.0, curvature * 0.4));

      // [0..2] pos.xyz (scale elevation down to kilometers for render space)
      vertices[vIdx + 0] = wx;
      vertices[vIdx + 1] = wy * 0.001; // km units
      vertices[vIdx + 2] = wz;

      // [3..5] normal.xyz
      vertices[vIdx + 3] = normX;
      vertices[vIdx + 4] = normY;
      vertices[vIdx + 5] = normZ;

      // [6..7] uv.xy (0 to 1)
      vertices[vIdx + 6] = x / (resolution - 1);
      vertices[vIdx + 7] = z / (resolution - 1);

      // [8] slope (degrees)
      vertices[vIdx + 8] = slopeDeg;

      // [9] elevation (meters)
      vertices[vIdx + 9] = wy;

      // [10] curvature: packed as 255000 + curvature*10 to preserve curvature info
      // while ensuring unpackSlot returns 255 (no-slot sentinel) for site mesh
      // Shader: slot = int(val/1000) → 255 = no atlas slot → use global texture
      vertices[vIdx + 10] = 255000.0 + curvature * 10.0;

      // [11] hazard score (0 to 1)
      vertices[vIdx + 11] = hazardScore;
    }
  }

  // Generate triangle strip / quad indices
  let iIdx = 0;
  for (let z = 0; z < resolution - 1; z++) {
    for (let x = 0; x < resolution - 1; x++) {
      const topLeft = z * resolution + x;
      const topRight = topLeft + 1;
      const bottomLeft = (z + 1) * resolution + x;
      const bottomRight = bottomLeft + 1;

      // First triangle
      indices[iIdx++] = topLeft;
      indices[iIdx++] = bottomLeft;
      indices[iIdx++] = topRight;

      // Second triangle
      indices[iIdx++] = topRight;
      indices[iIdx++] = bottomLeft;
      indices[iIdx++] = bottomRight;
    }
  }

  return {
    vertices,
    indices,
    stride,
    vertexCount,
    indexCount,
    minElev,
    maxElev,
    size,
    resolution
  };
}
