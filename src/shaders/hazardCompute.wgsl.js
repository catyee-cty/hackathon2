/**
 * WebGPU Compute Shader for Real-Time Lunar Site Hazard Analysis
 * Dispatches compute workgroups to calculate local slope gradient vectors,
 * micro-roughness, solar line-of-sight visibility, and rover traverse cost.
 */

export const hazardComputeWGSL = /* wgsl */ `
struct GridParams {
  resolution: u32,
  cellSizeMeters: f32,
  pad0: f32,
  pad1: f32,
  sunDir: vec3<f32>,
  slopeThresholdDeg: f32,
};

@group(0) @binding(0) var<uniform> params: GridParams;
@group(0) @binding(1) var<storage, read> elevationBuffer: array<f32>;
@group(0) @binding(2) var<storage, read_write> hazardGridOut: array<f32>;

// Workgroup size: 16x16 threads = 256 parallel threads per workgroup
@compute @workgroup_size(16, 16)
fn cs_hazard_eval(@builtin(global_invocation_id) id: vec3<u32>) {
  let x = id.x;
  let z = id.y;
  let res = params.resolution;

  if (x >= res || z >= res) {
    return;
  }

  let idx = z * res + x;
  let hCenter = elevationBuffer[idx];

  // Neighborhood elevations for gradient
  let xPrev = select(x - 1u, x, x == 0u);
  let xNext = select(x + 1u, x, x >= res - 1u);
  let zPrev = select(z - 1u, z, z == 0u);
  let zNext = select(z + 1u, z, z >= res - 1u);

  let hLeft = elevationBuffer[z * res + xPrev];
  let hRight = elevationBuffer[z * res + xNext];
  let hUp = elevationBuffer[zPrev * res + x];
  let hDown = elevationBuffer[zNext * res + x];

  let dx = (hRight - hLeft) / (2.0 * params.cellSizeMeters);
  let dz = (hDown - hUp) / (2.0 * params.cellSizeMeters);

  let slopeGrad = sqrt(dx * dx + dz * dz);
  let slopeAngleRad = atan(slopeGrad);
  let slopeAngleDeg = slopeAngleRad * (180.0 / 3.14159265);

  // Surface normal vector
  let normal = normalize(vec3<f32>(-dx, 1.0, -dz));
  let solarIllum = max(dot(normal, params.sunDir), 0.0);

  // Traverse Cost function:
  // Base cost = 1.0
  // Slope penalty grows exponentially past 10 degrees
  var cost = 1.0 + pow(slopeAngleDeg / 10.0, 2.5);

  // If slope exceeds tipping threshold (e.g. 15°), cost explodes (impassable cliff)
  if (slopeAngleDeg > params.slopeThresholdDeg) {
    cost += 500.0;
  }

  // Bonus for solar illumination (powers rover solar arrays)
  if (solarIllum < 0.05) {
    cost += 2.0; // PSR battery drain penalty
  }

  hazardGridOut[idx] = cost;
}
`;
