/**
 * WebGPU Hardware Initialization & Render/Compute Pipeline Orchestration
 */

import { terrainWGSL } from "../shaders/terrain.wgsl.js";
import { skyboxWGSL } from "../shaders/skybox.wgsl.js";
import { hazardComputeWGSL } from "../shaders/hazardCompute.wgsl.js";

export class WebGPUContext {
  constructor(canvas) {
    this.canvas = canvas;
    this.adapter = null;
    this.device = null;
    this.context = null;
    this.format = null;
    this.depthFormat = 'depth24plus';
    this.depthTexture = null;

    // Pipelines
    this.terrainPipeline = null;
    this.skyboxPipeline = null;
    this.hazardComputePipeline = null;

    // Status
    this.isSupported = false;
    this.adapterInfo = {};
  }

  async initialize() {
    if (!navigator.gpu) {
      throw new Error("WebGPU is not supported by your current browser. Please use Chrome 113+, Edge 113+, or enable WebGPU flags.");
    }

    this.adapter = await navigator.gpu.requestAdapter({
      powerPreference: 'high-performance'
    });

    if (!this.adapter) {
      throw new Error("No suitable WebGPU adapter found on your graphics card.");
    }

    // Inspect adapter info
    if (this.adapter.info) {
      this.adapterInfo = {
        vendor: this.adapter.info.vendor || 'Unknown',
        architecture: this.adapter.info.architecture || 'DirectX/Metal/Vulkan',
        description: this.adapter.info.description || 'Hardware Accelerated'
      };
    } else {
      this.adapterInfo = {
        vendor: 'Graphics Hardware',
        architecture: 'WebGPU Core',
        description: 'Standard Adapter'
      };
    }

    this.device = await this.adapter.requestDevice({
      requiredFeatures: [],
      requiredLimits: {
        maxStorageBufferBindingSize: Math.min(this.adapter.limits.maxStorageBufferBindingSize, 128 * 1024 * 1024)
      }
    });

    this.device.onuncapturederror = (event) => {
      console.error('[WebGPU Uncaptured Error]:', event.error.message || event.error);
    };

    this.device.lost.then((info) => {
      console.warn(`[WebGPU] Device was lost: ${info.message}`);
    });

    this.context = this.canvas.getContext('webgpu');
    this.format = navigator.gpu.getPreferredCanvasFormat();

    this.configureCanvas();
    this.createDepthTexture();
    await this.createPipelines();

    this.isSupported = true;
    return this.adapterInfo;
  }

  configureCanvas() {
    const width = Math.floor(this.canvas.clientWidth * window.devicePixelRatio) || 1280;
    const height = Math.floor(this.canvas.clientHeight * window.devicePixelRatio) || 720;
    this.canvas.width = width;
    this.canvas.height = height;

    this.context.configure({
      device: this.device,
      format: this.format,
      alphaMode: 'opaque'
    });
  }

  createDepthTexture() {
    if (this.depthTexture) {
      this.depthTexture.destroy();
    }
    this.depthTexture = this.device.createTexture({
      size: [this.canvas.width, this.canvas.height, 1],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });
  }

  resize() {
    if (!this.device) return;
    this.configureCanvas();
    this.createDepthTexture();
  }

  async createPipelines() {
    // 1. Terrain Render Pipeline
    const terrainShaderModule = this.device.createShaderModule({
      label: 'Lunar Terrain WGSL',
      code: terrainWGSL
    });

    // Check compilation diagnostics
    const compInfo = await terrainShaderModule.getCompilationInfo();
    for (const msg of compInfo.messages) {
      if (msg.type === 'error') {
        console.error(`[WGSL Compilation Error]: ${msg.message} at line ${msg.lineNum}:${msg.linePos}`);
        throw new Error(`WGSL Compilation Error: ${msg.message} (L${msg.lineNum}:P${msg.linePos})`);
      }
    }

    // Vertex layout matching createTerrainMesh (stride: 12 floats = 48 bytes)
    const vertexBufferLayout = {
      arrayStride: 12 * 4,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, // position
        { shaderLocation: 1, offset: 3 * 4, format: 'float32x3' }, // normal
        { shaderLocation: 2, offset: 6 * 4, format: 'float32x2' }, // uv
        { shaderLocation: 3, offset: 8 * 4, format: 'float32' }, // slope
        { shaderLocation: 4, offset: 9 * 4, format: 'float32' }, // elevation
        { shaderLocation: 5, offset: 10 * 4, format: 'float32' }, // curvature
        { shaderLocation: 6, offset: 11 * 4, format: 'float32' } // hazard
      ]
    };

    this.terrainPipeline = await this.device.createRenderPipelineAsync({
      label: 'Terrain Pipeline',
      layout: 'auto',
      vertex: {
        module: terrainShaderModule,
        entryPoint: 'vs_main',
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module: terrainShaderModule,
        entryPoint: 'fs_main',
        targets: [{ format: this.format }]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none'
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: true,
        depthCompare: 'less'
      }
    });

    // 2. Skybox Render Pipeline
    const skyboxShaderModule = this.device.createShaderModule({
      label: 'Space Skybox WGSL',
      code: skyboxWGSL
    });

    // Fullscreen quad layout
    const skyboxVertexLayout = {
      arrayStride: 5 * 4,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x3' }, // pos
        { shaderLocation: 1, offset: 3 * 4, format: 'float32x2' } // uv
      ]
    };

    this.skyboxPipeline = await this.device.createRenderPipelineAsync({
      label: 'Skybox Pipeline',
      layout: 'auto',
      vertex: {
        module: skyboxShaderModule,
        entryPoint: 'vs_sky',
        buffers: [skyboxVertexLayout]
      },
      fragment: {
        module: skyboxShaderModule,
        entryPoint: 'fs_sky',
        targets: [{ format: this.format }]
      },
      primitive: {
        topology: 'triangle-list',
        cullMode: 'none'
      },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: 'less-equal'
      }
    });

    // 3. WebGPU Hazard Compute Pipeline
    const hazardComputeModule = this.device.createShaderModule({
      label: 'Hazard Compute WGSL',
      code: hazardComputeWGSL
    });

    this.hazardComputePipeline = await this.device.createComputePipelineAsync({
      label: 'Hazard Compute Pipeline',
      layout: 'auto',
      compute: {
        module: hazardComputeModule,
        entryPoint: 'cs_hazard_eval'
      }
    });
  }
}
