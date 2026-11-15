/**
 * High-Performance Fallback 3D Canvas / WebGL Renderer
 * Activates seamlessly if WebGPU is disabled or unsupported in the client browser.
 * Renders realistic shaded lunar DEM, slope analysis, solar angles, and route planning.
 */

import { getLunarHeight } from "./terrainMesh.js";

export class FallbackRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.resize();
  }

  resize() {
    this.width = this.canvas.width = Math.floor(this.canvas.clientWidth * (window.devicePixelRatio || 1));
    this.height = this.canvas.height = Math.floor(this.canvas.clientHeight * (window.devicePixelRatio || 1));
  }

  render(app, sunDir) {
    const ctx = this.ctx;
    if (!ctx) return;

    const w = this.width;
    const h = this.height;

    // Clear space background
    ctx.fillStyle = '#07090e';
    ctx.fillRect(0, 0, w, h);

    // Draw background starfield
    ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
    for (let i = 0; i < 70; i++) {
      const sx = (Math.sin(i * 997.1) * 0.5 + 0.5) * w;
      const sy = (Math.cos(i * 331.7) * 0.5 + 0.5) * (h * 0.6);
      const r = (i % 3 === 0) ? 1.5 : 0.8;
      ctx.fillRect(sx, sy, r, r);
    }

    // Draw Planet Earth in top-left
    const earthX = w * 0.18;
    const earthY = h * 0.22;
    const earthR = 36;
    const earthGrad = ctx.createRadialGradient(earthX - 10, earthY - 10, 5, earthX, earthY, earthR);
    earthGrad.addColorStop(0, '#60a5fa');
    earthGrad.addColorStop(0.7, '#1d4ed8');
    earthGrad.addColorStop(1, '#091e42');
    ctx.beginPath();
    ctx.arc(earthX, earthY, earthR, 0, Math.PI * 2);
    ctx.fillStyle = earthGrad;
    ctx.fill();

    // Atmosphere halo
    ctx.beginPath();
    ctx.arc(earthX, earthY, earthR + 4, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(59, 130, 246, 0.35)';
    ctx.lineWidth = 3;
    ctx.stroke();

    // If in WHOLE GLOBE MODE: Render 3D Spherical Moon Globe
    if (app.viewTarget === 'globe') {
      const globeX = w * 0.5;
      const globeY = h * 0.52;
      const globeRadius = Math.min(w, h) * 0.32 * (55.0 / app.camera.distance);

      ctx.save();
      ctx.beginPath();
      ctx.arc(globeX, globeY, globeRadius, 0, Math.PI * 2);
      ctx.clip();

      // Draw Global Moon Texture if available
      if (app.currentTileBitmap) {
        ctx.drawImage(app.currentTileBitmap, globeX - globeRadius, globeY - globeRadius, globeRadius * 2, globeRadius * 2);
      } else {
        ctx.fillStyle = '#2b2d35';
        ctx.fillRect(globeX - globeRadius, globeY - globeRadius, globeRadius * 2, globeRadius * 2);
      }

      // Dynamic Solar Shadow / Terminator across the globe
      const sunGrad = ctx.createLinearGradient(
        globeX - sunDir[0] * globeRadius,
        globeY - sunDir[1] * globeRadius,
        globeX + sunDir[0] * globeRadius,
        globeY + sunDir[1] * globeRadius
      );
      sunGrad.addColorStop(0, 'rgba(0, 0, 0, 0.94)');
      sunGrad.addColorStop(0.5, 'rgba(0, 0, 0, 0.45)');
      sunGrad.addColorStop(1, 'rgba(255, 255, 255, 0.1)');
      ctx.fillStyle = sunGrad;
      ctx.fillRect(globeX - globeRadius, globeY - globeRadius, globeRadius * 2, globeRadius * 2);

      ctx.restore();

      // Atmospheric limb / sharp vacuum horizon edge
      ctx.beginPath();
      ctx.arc(globeX, globeY, globeRadius, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.6)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Render Landing Site Beacons on the Globe
      for (const site of app.sites || []) {
        const latRad = (site.lat * Math.PI) / 180;
        const lonRad = ((site.lon - (app.camera.yaw * 180 / Math.PI)) * Math.PI) / 180;

        // Front-facing check
        if (Math.cos(lonRad) > 0) {
          const pinX = globeX + Math.sin(lonRad) * Math.cos(latRad) * globeRadius;
          const pinY = globeY - Math.sin(latRad) * globeRadius;

          ctx.beginPath();
          ctx.arc(pinX, pinY, 4, 0, Math.PI * 2);
          ctx.fillStyle = (site.id === app.selectedSite.id) ? '#ffaa00' : '#00e5ff';
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.font = '9px monospace';
          ctx.fillText(site.name.split(' ')[0], pinX + 6, pinY + 3);
        }
      }
      return;
    }

    // 2.5D Isometric / Perspective Terrain Mesh Wire & Shaded Polygons
    const cam = app.camera;
    const gridSize = 48; // fast software grid
    const extent = 75.0; // km
    const step = (extent * 2.0) / gridSize;

    const cx = w * 0.5;
    const cy = h * 0.58;
    const scale = Math.min(w, h) * 0.014 * (85.0 / cam.distance);

    const cosY = Math.cos(cam.yaw);
    const sinY = Math.sin(cam.yaw);
    const cosP = Math.cos(cam.pitch);
    const sinP = Math.sin(cam.pitch);

    // Project 3D point (wx, wyKm, wz) to screen (sx, sy)
    const project = (wx, wyKm, wz) => {
      // Translate relative to target
      const dx = wx - cam.target[0];
      const dy = wyKm - cam.target[1];
      const dz = wz - cam.target[2];

      // Rotate Yaw
      const rx = dx * cosY - dz * sinY;
      const rz = dx * sinY + dz * cosY;

      // Rotate Pitch
      const ry = dy * cosP - rz * sinP;
      const rdepth = dy * sinP + rz * cosP;

      const px = cx + rx * scale;
      const py = cy - ry * scale;
      return { x: px, y: py, depth: rdepth };
    };

    // Render terrain grid lines / shaded quads
    ctx.lineWidth = 1;
    for (let gz = 0; gz < gridSize - 1; gz += 2) {
      for (let gx = 0; gx < gridSize - 1; gx += 2) {
        const wx0 = -extent + gx * step;
        const wz0 = -extent + gz * step;
        const wx1 = wx0 + step * 2;
        const wz1 = wz0 + step * 2;

        const h00M = getLunarHeight(wx0, wz0, app.selectedSite);
        const h10M = getLunarHeight(wx1, wz0, app.selectedSite);
        const h01M = getLunarHeight(wx0, wz1, app.selectedSite);
        const h11M = getLunarHeight(wx1, wz1, app.selectedSite);

        const p00 = project(wx0, h00M * 0.001, wz0);
        const p10 = project(wx1, h10M * 0.001, wz0);
        const p11 = project(wx1, h11M * 0.001, wz1);
        const p01 = project(wx0, h01M * 0.001, wz1);

        // Calculate slope and normal
        const dX = (h10M - h00M) / (step * 2000.0);
        const dZ = (h01M - h00M) / (step * 2000.0);
        const slopeDeg = Math.atan(Math.hypot(dX, dZ)) * (180.0 / Math.PI);

        const normLen = Math.hypot(-dX, 1.0, -dZ);
        const nx = -dX / normLen;
        const ny = 1.0 / normLen;
        const nz = -dZ / normLen;
        const nDotL = Math.max(0.0, nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2]);

        // Color based on shading mode
        let fill = 'rgb(35, 38, 45)';
        if (app.shadingMode === 1) { // Slope
          if (slopeDeg < 5) fill = `rgba(16, 185, 129, ${0.4 + nDotL * 0.5})`;
          else if (slopeDeg < 12) fill = `rgba(245, 158, 11, ${0.4 + nDotL * 0.5})`;
          else fill = `rgba(239, 68, 68, ${0.4 + nDotL * 0.5})`;
        } else if (app.shadingMode === 2) { // Hypsometric DEM
          const t = Math.max(0, Math.min(1, (h00M + 4000) / 8000));
          const hue = (1.0 - t) * 240;
          fill = `hsl(${hue}, 85%, ${30 + nDotL * 30}%)`;
        } else if (app.shadingMode === 3) { // Solar
          if (nDotL > 0.05) fill = `rgba(255, 230, 160, ${0.5 + nDotL * 0.5})`;
          else fill = 'rgba(12, 35, 75, 0.85)';
        } else if (app.shadingMode === 4) { // Hazard
          if (slopeDeg < 5) fill = `rgba(16, 185, 129, ${0.6 + nDotL * 0.3})`;
          else if (slopeDeg < 14) fill = `rgba(234, 179, 8, ${0.6 + nDotL * 0.3})`;
          else fill = `rgba(239, 68, 68, ${0.7 + nDotL * 0.3})`;
        } else {
          // PBR regolith approximation
          const luma = Math.floor(18 + nDotL * 155);
          fill = `rgb(${luma}, ${luma}, ${Math.floor(luma * 1.03)})`;
        }

        ctx.beginPath();
        ctx.moveTo(p00.x, p00.y);
        ctx.lineTo(p10.x, p10.y);
        ctx.lineTo(p11.x, p11.y);
        ctx.lineTo(p01.x, p01.y);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();

        if (app.wireframeEnabled) {
          ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
          ctx.stroke();
        }
      }
    }

    // Render planned rover traverse path if available
    if (app.pathPlanner && app.pathPlanner.currentRoute) {
      const wpts = app.pathPlanner.currentRoute.waypoints;
      ctx.beginPath();
      for (let i = 0; i < wpts.length; i++) {
        const pt = project(wpts[i].x, wpts[i].y, wpts[i].z);
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 3;
      ctx.shadowColor = '#00e5ff';
      ctx.shadowBlur = 10;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // Render Real NASA Tile Picture-in-Picture Radar overlay if active
    if (app.useRealNasaTile && app.currentTileBitmap) {
      const pipSize = 110;
      const pipX = w - pipSize - 370;
      const pipY = 72;

      ctx.save();
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1;
      ctx.strokeRect(pipX - 1, pipY - 1, pipSize + 2, pipSize + 2);
      ctx.drawImage(app.currentTileBitmap, pipX, pipY, pipSize, pipSize);

      ctx.fillStyle = 'rgba(7, 9, 14, 0.75)';
      ctx.fillRect(pipX, pipY + pipSize - 16, pipSize, 16);
      ctx.fillStyle = '#00e5ff';
      ctx.font = '8px monospace';
      ctx.fillText('NASA LRO TILE', pipX + 4, pipY + pipSize - 5);
      ctx.restore();
    }
  }
}
