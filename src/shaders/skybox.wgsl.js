/**
 * WebGPU WGSL Skybox Shader: Obsidian Deep Space, Multi-Magnitude Starfield,
 * Milky Way Dust Lanes, and Planet Earth in the Lunar Sky.
 */

export const skyboxWGSL = /* wgsl */ `
struct SkyUniforms {
  invViewProj: mat4x4<f32>,
  sunDirection: vec3<f32>,
  time: f32,
};

@group(0) @binding(0) var<uniform> skyU: SkyUniforms;

struct VertexInput {
  @location(0) position: vec3<f32>,
  @location(1) uv: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_sky(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.uv = in.uv;
  out.position = vec4<f32>(in.position.xy, 1.0, 1.0);
  return out;
}

fn hash1(n: f32) -> f32 {
  return fract(sin(n) * 43758.5453123);
}

// 3D Hash for deterministic star distribution
fn hash3(p: vec3<f32>) -> f32 {
  let q = 1103515245.0 * ((p / 1103515245.0) + vec3<f32>(hash1(p.x), hash1(p.y), hash1(p.z)));
  return fract(sin(dot(q, vec3<f32>(12.9898, 78.233, 45.164))) * 43758.5453);
}

@fragment
fn fs_sky(in: VertexOutput) -> @location(0) vec4<f32> {
  // Unproject screen UV to world ray direction
  let clipPos = vec4<f32>(in.uv.x * 2.0 - 1.0, 1.0 - in.uv.y * 2.0, 1.0, 1.0);
  let worldPos4 = skyU.invViewProj * clipPos;
  var rayDir = normalize(worldPos4.xyz);
  if (abs(worldPos4.w) > 0.0001) {
    rayDir = normalize(worldPos4.xyz / worldPos4.w);
  }

  // Deep obsidian space base with subtle cosmic gradient
  var color = vec3<f32>(0.003, 0.004, 0.008);

  // Procedural Milky Way galactic plane band
  let galacticLat = abs(rayDir.y * 0.7 + rayDir.x * 0.3);
  let milkyWay = exp(-galacticLat * 3.5) * 0.06;
  color += vec3<f32>(0.05, 0.07, 0.12) * milkyWay;

  // Multi-tier Starfield (Magnitude 1 to 6 stars)
  let starScale = 160.0;
  let starGrid = floor(rayDir * starScale);
  let starRand = hash3(starGrid);
  if (starRand > 0.978) {
    let starOffset = (fract(rayDir * starScale) - vec3<f32>(0.5)) * 2.0;
    let dist = length(starOffset);
    let brightness = pow(starRand, 32.0) * smoothstep(0.45, 0.0, dist);
    
    // Star color temperature (blue-white to warm amber)
    let starColor = mix(vec3<f32>(0.8, 0.9, 1.0), vec3<f32>(1.0, 0.85, 0.65), fract(starRand * 17.0));
    color += starColor * brightness * 2.2;
  }

  // Planet Earth in the Lunar Sky (fixed in lunar sky due to tidal locking)
  let earthDir = normalize(vec3<f32>(0.0, 0.25, 1.0));
  let dEarth = dot(rayDir, earthDir);
  let earthAngularRadius = 0.9995; // ~1.8 degrees angular size

  if (dEarth > earthAngularRadius) {
    let normDist = (dEarth - earthAngularRadius) / (1.0 - earthAngularRadius);
    let earthOcean = vec3<f32>(0.08, 0.35, 0.85);
    let earthClouds = vec3<f32>(0.92, 0.95, 1.0);
    let cloudPattern = sin(normDist * 32.0 + rayDir.x * 24.0) * 0.5 + 0.5;
    let surfaceEarth = mix(earthOcean, earthClouds, smoothstep(0.4, 0.8, cloudPattern));

    let earthSunDot = dot(earthDir, normalize(skyU.sunDirection));
    let earthPhase = clamp(earthSunDot * 1.2 + 0.4, 0.05, 1.0);
    let limbGlow = pow(1.0 - normDist, 2.5) * vec3<f32>(0.3, 0.6, 1.0) * 1.2;

    color = surfaceEarth * earthPhase + limbGlow;
  }

  // Brilliant Sun Disc & Corona
  let dSun = dot(rayDir, normalize(skyU.sunDirection));
  if (dSun > 0.9997) {
    color += vec3<f32>(10.0, 9.8, 9.0);
  } else if (dSun > 0.996) {
    let corona = pow((dSun - 0.996) / (0.9997 - 0.996), 3.5);
    color += vec3<f32>(1.6, 1.4, 1.1) * corona;
  }

  return vec4<f32>(color, 1.0);
}
`;
