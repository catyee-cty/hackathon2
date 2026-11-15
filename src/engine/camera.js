/**
 * Camera System with Orbit, Surface Rover, and Tactical Top-Down Views
 * Supports smooth damping, target site fly-to animations, and terrain elevation tracking.
 */

import { Vec3, Mat4 } from "./math.js";
import { getLunarHeight } from "./terrainMesh.js";
import { getGlobalLunarElevation } from "./globeMesh.js";

export class LunarCamera {
  constructor(canvas) {
    this.canvas = canvas;

    // Camera modes: 'orbit' | 'surface' | 'topdown'
    this.mode = 'orbit';

    // World state
    this.target = Vec3.create(0, 0, 0); // focal point (km)
    this.position = Vec3.create(0, 45, 65); // camera pos (km)
    this.up = Vec3.create(0, 1, 0);

    // Orbit parameters
    this.distance = 70.0; // km
    this.yaw = 0.8; // radians
    this.pitch = 0.55; // radians (clamped to prevent gimbal lock)
    this.minDistance = 25.04;   // globe mode: allows close inspection of craters down to ~2.8km
    this.maxDistance = 300.0;
    this.globeMode = true;     // set false in site view to restore flat-terrain clamping
    this.globeRadius = 25.0;   // must match createGlobeMesh radius

    // Target damping
    this.targetYaw = this.yaw;
    this.targetPitch = this.pitch;
    this.targetDist = this.distance;
    this.targetPos = Vec3.create(0, 0, 0);

    // Rover surface state
    this.roverYaw = 0.0;
    this.roverPitch = 0.1;
    this.roverPos = Vec3.create(0, 0.05, 0);

    // Matrices
    this.viewMatrix = Mat4.create();
    this.projMatrix = Mat4.create();
    this.invViewProjMatrix = Mat4.create();
    this.viewProjMatrix = Mat4.create();

    // Fly-to animation state
    this.isTransitioning = false;
    this.transitionStart = 0;
    this.transitionDuration = 1800; // ms
    this.startState = null;
    this.targetState = null;

    // Interactive mouse / touch state
    this.isDragging = false;
    this.isPanning = false;
    this.lastMouseX = 0;
    this.lastMouseY = 0;

    this.bindEvents();
    this.updateMatrices();
  }

  bindEvents() {
    this.canvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.isPanning = (e.button === 2 || e.shiftKey);
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    });

    window.addEventListener('mouseup', () => {
      this.isDragging = false;
      this.isPanning = false;
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.lastMouseX;
      const dy = e.clientY - this.lastMouseY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;

      if (this.isPanning) {
        // Pan target position
        const panSpeed = this.distance * 0.0012;
        const forward = Vec3.create(
          Math.sin(this.yaw),
          0,
          Math.cos(this.yaw)
        );
        const right = Vec3.create(forward[2], 0, -forward[0]);

        this.target[0] -= right[0] * dx * panSpeed;
        this.target[2] -= right[2] * dx * panSpeed;
        this.target[0] += forward[0] * dy * panSpeed;
        this.target[2] += forward[2] * dy * panSpeed;
      } else {
        if (this.mode === 'surface') {
          // Surface first-person look
          this.roverYaw += dx * 0.004;
          this.roverPitch = Math.max(-0.6, Math.min(0.6, this.roverPitch - dy * 0.003));
        } else {
          // Orbit rotate
          this.targetYaw -= dx * 0.005;
          if (this.globeMode) {
            // Full spherical pitch from South Pole to North Pole
            this.targetPitch = Math.max(-Math.PI * 0.48, Math.min(Math.PI * 0.48, this.targetPitch + dy * 0.005));
          } else {
            // Site mode: stay above flat terrain
            this.targetPitch = Math.max(0.04, Math.min(Math.PI * 0.48, this.targetPitch + dy * 0.005));
          }
        }
      }
    });

    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (this.mode === 'surface') {
        // Move rover forward/backward
        const forward = Vec3.create(Math.sin(this.roverYaw), 0, Math.cos(this.roverYaw));
        const moveStep = -Math.sign(e.deltaY) * 0.4; // km
        this.roverPos[0] += forward[0] * moveStep;
        this.roverPos[2] += forward[2] * moveStep;
      } else {
        // Smooth exponential zoom — faster when far, finer when close
        const distAboveSurface = Math.max(0.1, this.targetDist - this.globeRadius);
        const speedScale = Math.max(0.0006, Math.min(0.003, distAboveSurface * 0.00018));
        const zoomFactor = Math.exp(e.deltaY * speedScale);
        this.targetDist = Math.max(this.minDistance, Math.min(this.maxDistance, this.targetDist * zoomFactor));
      }
    }, { passive: false });

    // Prevent context menu on canvas
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  setMode(newMode) {
    this.mode = newMode;
    if (newMode === 'topdown') {
      this.targetPitch = Math.PI * 0.46;
      this.targetDist = Math.max(this.targetDist, 75.0);
    } else if (newMode === 'surface') {
      // Snap rover position to current orbit target
      this.roverPos[0] = this.target[0];
      this.roverPos[2] = this.target[2];
    } else if (newMode === 'orbit') {
      this.targetPitch = 0.5;
    }
  }

  flyToSite(site) {
    this.isTransitioning = true;
    this.transitionStart = performance.now();

    const targetX = site.targetOffset ? site.targetOffset[0] * 50.0 : 0.0;
    const targetZ = site.targetOffset ? site.targetOffset[1] * 50.0 : 0.0;

    this.startState = {
      target: [...this.target],
      yaw: this.yaw,
      pitch: this.pitch,
      dist: this.distance
    };

    this.targetState = {
      target: [targetX, 0, targetZ],
      yaw: this.yaw + 0.6,
      pitch: (this.mode === 'topdown') ? Math.PI * 0.46 : 0.42,
      dist: Math.max(site.craterRadius * 1.8, 25.0)
    };
  }

  /**
   * Smoothly rotate and center the 3D globe on target Latitude / Longitude
   */
  flyToGlobeLatLon(latDeg, lonDeg) {
    this.isTransitioning = true;
    this.transitionStart = performance.now();

    const lonRad = (lonDeg * Math.PI) / 180.0;
    const latRad = (latDeg * Math.PI) / 180.0;

    this.startState = {
      target: [...this.target],
      yaw: this.yaw,
      pitch: this.pitch,
      dist: this.distance
    };

    // Calculate spherical yaw & pitch to look directly at that face of the Moon
    this.targetState = {
      target: [0, 0, 0],
      yaw: lonRad,
      pitch: Math.max(-1.4, Math.min(1.4, latRad)),
      dist: Math.max(38.0, Math.min(90.0, this.distance))
    };
  }

  update(deltaTime = 0.016) {
    // Handle transition animation
    if (this.isTransitioning) {
      const now = performance.now();
      const elapsed = now - this.transitionStart;
      let t = Math.min(1.0, elapsed / this.transitionDuration);
      // Smooth cubic easeInOut
      t = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

      this.target[0] = this.startState.target[0] + (this.targetState.target[0] - this.startState.target[0]) * t;
      this.target[2] = this.startState.target[2] + (this.targetState.target[2] - this.startState.target[2]) * t;
      this.targetYaw = this.startState.yaw + (this.targetState.yaw - this.startState.yaw) * t;
      this.targetPitch = this.startState.pitch + (this.targetState.pitch - this.startState.pitch) * t;
      this.targetDist = this.startState.dist + (this.targetState.dist - this.startState.dist) * t;

      if (elapsed >= this.transitionDuration) {
        this.isTransitioning = false;
      }
    }

    // Smooth camera damping
    const damp = Math.min(1.0, deltaTime * 12.0);
    this.yaw += (this.targetYaw - this.yaw) * damp;
    this.pitch += (this.targetPitch - this.pitch) * damp;
    this.distance += (this.targetDist - this.distance) * damp;

    // Calculate eye position based on mode
    if (this.mode === 'surface') {
      // Get terrain height at rover location
      const surfaceElevM = getLunarHeight(this.roverPos[0], this.roverPos[2]);
      const surfaceElevKm = surfaceElevM * 0.001;
      this.roverPos[1] = surfaceElevKm + 0.003; // Rover mast height ~3 meters

      Vec3.copy(this.position, this.roverPos);

      // Target point looking in rover yaw direction
      const forward = Vec3.create(
        Math.sin(this.roverYaw) * Math.cos(this.roverPitch),
        Math.sin(this.roverPitch),
        Math.cos(this.roverYaw) * Math.cos(this.roverPitch)
      );
      Vec3.add(this.target, this.position, forward);
    } else {
      // Orbit / Top-down mode
      const cy = Math.cos(this.pitch);
      const sy = Math.sin(this.pitch);
      const cx = Math.cos(this.yaw);
      const sx = Math.sin(this.yaw);

      this.position[0] = this.target[0] + this.distance * cy * sx;
      this.position[1] = this.target[1] + this.distance * sy;
      this.position[2] = this.target[2] + this.distance * cy * cx;

      if (this.globeMode) {
        // Globe mode: dynamically calculate local terrain surface under camera
        const camLen = Math.hypot(this.position[0], this.position[1], this.position[2]);
        const latRad = Math.asin(Math.max(-1.0, Math.min(1.0, this.position[1] / Math.max(0.001, camLen))));
        const lonRad = Math.atan2(this.position[0], this.position[2]);
        const latDeg = latRad * (180.0 / Math.PI);
        const lonDeg = lonRad * (180.0 / Math.PI);
        const localElevMeters = getGlobalLunarElevation(latDeg, lonDeg);
        const localSurfaceR = this.globeRadius + (localElevMeters * 0.001 / 1737.4) * (this.globeRadius * 2.2);
        const minR = Math.max(this.globeRadius + 0.02, localSurfaceR + 0.035); // ~2.4km safe clearance above local terrain
        if (camLen < minR) {
          const scale = minR / camLen;
          this.position[0] *= scale;
          this.position[1] *= scale;
          this.position[2] *= scale;
        }
      } else {
        // Site/regional mode: keep orbit camera above flat terrain
        const terrainElevAtCam = getLunarHeight(this.position[0], this.position[2]) * 0.001;
        if (this.position[1] < terrainElevAtCam + 1.2) {
          this.position[1] = terrainElevAtCam + 1.2;
        }
      }
    }

    this.updateMatrices();
  }

  updateMatrices() {
    const width = this.canvas.clientWidth || 800;
    const height = this.canvas.clientHeight || 600;
    const aspect = width / height;

    const fov = (this.mode === 'surface') ? 70 * (Math.PI / 180) : 50 * (Math.PI / 180);
    // Adaptive near clip: tighten at low altitude to maximize depth buffer precision
    const distAbove = Math.max(0.05, this.distance - this.globeRadius);
    const nearClip  = Math.min(0.05, Math.max(0.001, distAbove * 0.002));
    const farClip   = Math.max(800.0, this.distance * 20.0);
    Mat4.perspective(this.projMatrix, fov, aspect, nearClip, farClip);
    Mat4.lookAt(this.viewMatrix, this.position, this.target, this.up);

    // Compute view-projection and its inverse for skybox raycasting
    Mat4.multiply(this.viewProjMatrix, this.projMatrix, this.viewMatrix);
    Mat4.invert(this.invViewProjMatrix, this.viewProjMatrix);
  }
}
