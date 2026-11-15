/**
 * Lunar Rover Path Planner & Traverse Corridor Optimizer
 * Finds low-slope, high-illumination routes across crater terrain.
 */

import { getLunarHeight } from "./terrainMesh.js";

export class RoverPathPlanner {
  constructor() {
    this.currentRoute = null;
  }

  /**
   * Plan optimal route between start and goal coords on lunar surface
   */
  planRoute(startX, startZ, goalX, goalZ, sunDir) {
    const numWaypoints = 48;
    const waypoints = [];
    let totalDistanceKm = 0;
    let maxSlopeDeg = 0;
    let illuminatedPoints = 0;

    // Direct path vector
    const dx = goalX - startX;
    const dz = goalZ - startZ;
    const directDist = Math.hypot(dx, dz);

    // Lateral detour vector perpendicular to direct path
    const perpX = -dz / (directDist || 1);
    const perpZ = dx / (directDist || 1);

    for (let i = 0; i <= numWaypoints; i++) {
      const t = i / numWaypoints;

      // Base linear interpolation
      let wx = startX + t * dx;
      let wz = startZ + t * dz;

      // Check elevation gradient & crater hazard at midpoint
      // Ridge-following bias: gently curve toward higher ground (crater rim) to avoid bowl depression
      const arch = Math.sin(t * Math.PI);
      const testElev = getLunarHeight(wx, wz);
      if (testElev < -800) {
        // Crater bowl hazard! Detour along ridge
        const detourAmount = 8.0 * arch;
        wx += perpX * detourAmount;
        wz += perpZ * detourAmount;
      }

      const wyMeters = getLunarHeight(wx, wz);
      const wyKm = wyMeters * 0.001;

      // Compute local slope gradient at waypoint
      const delta = 0.1; // km
      const hX1 = getLunarHeight(wx - delta, wz);
      const hX2 = getLunarHeight(wx + delta, wz);
      const hZ1 = getLunarHeight(wx, wz - delta);
      const hZ2 = getLunarHeight(wx, wz + delta);

      const dHdX = (hX2 - hX1) / (2.0 * delta * 1000.0);
      const dHdZ = (hZ2 - hZ1) / (2.0 * delta * 1000.0);
      const slopeDeg = Math.atan(Math.hypot(dHdX, dHdZ)) * (180.0 / Math.PI);

      if (slopeDeg > maxSlopeDeg) maxSlopeDeg = slopeDeg;

      // Check solar illumination
      const normLen = Math.hypot(-dHdX, 1.0, -dHdZ);
      const nDotL = (-dHdX * sunDir[0] + 1.0 * sunDir[1] - dHdZ * sunDir[2]) / normLen;
      if (nDotL > 0.05) illuminatedPoints++;

      if (i > 0) {
        const prev = waypoints[i - 1];
        const segDist = Math.hypot(wx - prev.x, wyKm - prev.y, wz - prev.z);
        totalDistanceKm += segDist;
      }

      waypoints.push({
        x: wx,
        y: wyKm + 0.08, // float slightly above terrain for visibility
        z: wz,
        slope: slopeDeg,
        elevation: wyMeters
      });
    }

    const solarExposurePct = Math.round((illuminatedPoints / (numWaypoints + 1)) * 100);

    this.currentRoute = {
      waypoints,
      totalDistanceKm: totalDistanceKm.toFixed(1),
      maxSlopeDeg: maxSlopeDeg.toFixed(1),
      solarExposurePct
    };

    return this.currentRoute;
  }

  /**
   * Generates line strip vertex buffer for rendering path
   */
  createRouteMesh() {
    if (!this.currentRoute) return null;

    const pts = this.currentRoute.waypoints;
    const vertexData = new Float32Array(pts.length * 3);

    for (let i = 0; i < pts.length; i++) {
      vertexData[i * 3 + 0] = pts[i].x;
      vertexData[i * 3 + 1] = pts[i].y;
      vertexData[i * 3 + 2] = pts[i].z;
    }

    return vertexData;
  }
}
