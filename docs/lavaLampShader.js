/**
 * Lava Lamp Shader - Interactive Background for Firefox Menu
 * Features: Rising blobs, mouse interaction, multi-octave FBM, ridged noise, pulsating glow
 */

// Import THREE from global scope (set by main module)
const THREE = window.THREE;

export const LAVA_LAMP_VERTEX_SHADER = `
void main() {
    gl_Position = vec4(position, 1.0);
}
`;

export const LAVA_LAMP_FRAGMENT_SHADER = `
precision highp float;

uniform float u_time;
uniform vec2 u_resolution;
uniform vec2 u_mouse;           // Normalized mouse position (0-1, y from bottom)
uniform float u_mouseStrength;  // Attraction intensity (0.1-1.0)
uniform float u_riseSpeed;      // Blob rising speed (0.05-0.3)
uniform float u_blobScale;      // Base blob size (0.5-3.0)
uniform float u_detailScale;    // Detail fineness (2.0-10.0)
uniform float u_glowStrength;   // Glow intensity (0.5-3.0)

void main() {
    vec2 fragCoord = gl_FragCoord.xy;
    vec2 iResolution = u_resolution;
    float iTime = u_time;
    
    // Mouse interaction
    vec2 uv = gl_FragCoord.xy / u_resolution;
    vec2 toMouse = u_mouse - uv;
    float mouseDist = length(toMouse);
    
    // Apply mouse distortion
    vec2 mouseOffset = vec2(0.0);
    if (mouseDist < 0.3) {
        float strength = u_mouseStrength;
        float influence = (0.3 - mouseDist) / 0.3;
        mouseOffset = toMouse * strength * influence * 50.0;
    }
    
    // Simple shader implementation
    vec2 col;
    float t = iTime * 0.1;
    vec2 coords = (fragCoord - iResolution.xy) / iResolution.y + vec2(t, t * 2.0);
    
    // Apply mouse offset to coordinates
    coords += mouseOffset * 0.01;
    
    float factor = 1.5;
    vec2 v1;
    
    for(int i = 0; i < 12; i++) {
        coords *= -factor * factor;
        v1 = coords.yx / factor;
        coords += sin(v1 + col + t * 10.0) / factor;
        col += vec2(sin(coords.x - coords.y + v1.x - col.y), sin(coords.y - coords.x + v1.y - col.x));
    }
    
    vec3 finalColor = vec3(col.x + 4.0, col.x - col.y / 2.0, col.x / 5.0) / 2.0;
    
    // Apply glow strength
    finalColor *= u_glowStrength;
    
    gl_FragColor = vec4(finalColor, 1.0);
}
`;

/**
 * LavaLampBackground - Creates an animated lava lamp shader background
 */
export class LavaLampBackground {
    constructor(containerId = 'unified-menu') {
        // Verify THREE.js is available
        if (!window.THREE) {
            throw new Error('THREE.js is not loaded. Make sure it is loaded before creating LavaLampBackground.');
        }
        
        this.THREE = window.THREE; // Store reference
        this.container = document.getElementById(containerId);
        this.canvas = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.mesh = null;
        this.uniforms = null;
        this.animationId = null;
        this.isAnimating = false;
        this.frameTimes = [];
        this.lastFrameTime = performance.now();
        this.qualityLevel = 1.0; // 0.5 = low, 1.0 = high
        
        if (!this.container) {
            console.warn(`Container "${containerId}" not found. Canvas will be added to body.`);
        }
        
        this.init();
    }
    
    init() {
        try {
            // MUST have container - don't allow fallback to body
            if (!this.container) {
                throw new Error(`Container not found! Lava lamp requires a valid container.`);
            }
            
            // Create canvas element
            this.canvas = document.createElement('canvas');
            this.canvas.id = 'lava-lamp-canvas';
            // Don't set z-index inline - let CSS handle it
            this.canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;';
            
            // Insert canvas as first child of menu container ONLY
            this.container.insertBefore(this.canvas, this.container.firstChild);
            
            console.log('✅ Lava lamp canvas inserted into', this.container.id);
            
        this.setupScene();
        this.setupEventListeners();
        this.setupPerformanceMonitoring();
    } catch (e) {
        console.error('Error during LavaLampBackground initialization:', e);
        throw e;
    }
}    setupScene() {
        const THREE = this.THREE; // Use local reference
        
        // Create Three.js scene
        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        
        // Create renderer
        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            antialias: true,
            alpha: false
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // Limit for performance
        this.renderer.setClearColor(0x1a0800); // Dark red background
        
        console.log('🎨 WebGL renderer created successfully');
        
        // Create shader uniforms
        this.uniforms = {
            u_time: { value: 0.0 },
            u_resolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
            u_mouse: { value: new THREE.Vector2(0.5, 0.5) },
            u_mouseStrength: { value: 0.3 },
            u_riseSpeed: { value: 0.08 },
            u_blobScale: { value: 1.8 },
            u_detailScale: { value: 5.0 },
            u_glowStrength: { value: 1.5 }
        };
        
        console.log('📐 Shader uniforms configured');
        
        // Create shader material
        const material = new THREE.ShaderMaterial({
            uniforms: this.uniforms,
            fragmentShader: LAVA_LAMP_FRAGMENT_SHADER,
            vertexShader: LAVA_LAMP_VERTEX_SHADER,
            depthWrite: false,
            depthTest: false
        });
        
        console.log('🎭 Shader material created');
        
        // Create fullscreen quad
        const geometry = new THREE.PlaneGeometry(2, 2);
        this.mesh = new THREE.Mesh(geometry, material);
        this.scene.add(this.mesh);
        
        console.log('✅ Scene setup complete');
    }
    
    setupEventListeners() {
        // Mouse interaction
        const updateMouse = (e) => {
            if (this.uniforms) {
                this.uniforms.u_mouse.value.x = e.clientX / window.innerWidth;
                this.uniforms.u_mouse.value.y = 1.0 - (e.clientY / window.innerHeight);
            }
        };
        
        window.addEventListener('mousemove', updateMouse);
        
        // Touch support for mobile
        window.addEventListener('touchmove', (e) => {
            if (e.touches.length > 0) {
                const touch = e.touches[0];
                updateMouse({ clientX: touch.clientX, clientY: touch.clientY });
            }
        });
        
        // Handle window resize
        window.addEventListener('resize', () => this.handleResize());
    }
    
    handleResize() {
        if (!this.renderer || !this.uniforms) return;
        
        const width = window.innerWidth;
        const height = window.innerHeight;
        
        this.renderer.setSize(width, height);
        this.uniforms.u_resolution.value.set(width, height);
    }
    
    setupPerformanceMonitoring() {
        // Monitor FPS and adjust quality dynamically
        setInterval(() => {
            if (this.frameTimes.length === 0) return;
            
            const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
            const currentFPS = 1000 / avgFrameTime;
            
            if (currentFPS < 45 && this.qualityLevel > 0.5) {
                this.qualityLevel = Math.max(0.5, this.qualityLevel - 0.1);
                this.applyQualitySettings();
                console.log(`📉 Lava lamp quality reduced to ${(this.qualityLevel * 100).toFixed(0)}%`);
            } else if (currentFPS > 55 && this.qualityLevel < 1.0) {
                this.qualityLevel = Math.min(1.0, this.qualityLevel + 0.1);
                this.applyQualitySettings();
                console.log(`📈 Lava lamp quality increased to ${(this.qualityLevel * 100).toFixed(0)}%`);
            }
            
            this.frameTimes = [];
        }, 1000);
    }
    
    applyQualitySettings() {
        if (!this.uniforms || !this.renderer) return;
        
        // Adjust detail scale based on quality level (3-10 range)
        this.uniforms.u_detailScale.value = 3.0 + (this.qualityLevel * 7.0);
        
        // Adjust pixel ratio
        const pixelRatio = this.qualityLevel > 0.8 ? 
            Math.min(window.devicePixelRatio, 2) : 1;
        this.renderer.setPixelRatio(pixelRatio);
    }
    
    isContainerVisible() {
        if (!this.container) return false;
        
        const rect = this.container.getBoundingClientRect();
        const isInViewport = (
            rect.top < window.innerHeight &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.right > 0
        );
        
        const isVisible = getComputedStyle(this.container).display !== 'none';
        
        return isInViewport && isVisible;
    }
    
    start() {
        if (this.isAnimating) return;
        
        this.isAnimating = true;
        this.animate();
        
        if (this.canvas) {
            this.canvas.style.display = 'block';
        }
    }
    
    stop() {
        this.isAnimating = false;
        
        if (this.animationId) {
            cancelAnimationFrame(this.animationId);
            this.animationId = null;
        }
        
        if (this.canvas) {
            this.canvas.style.display = 'none';
        }
    }
    
    animate() {
        if (!this.isAnimating) return;
        
        this.animationId = requestAnimationFrame(() => this.animate());
        
        // Only render if container is visible (performance optimization)
        if (this.isContainerVisible()) {
            // Track frame time for performance monitoring
            const currentTime = performance.now();
            if (this.frameTimes.length < 60) {
                this.frameTimes.push(currentTime - this.lastFrameTime);
            }
            this.lastFrameTime = currentTime;
            
            // Update time uniform
            if (this.uniforms) {
                this.uniforms.u_time.value += 0.016; // ~60fps
            }
            
            // Render scene
            if (this.renderer && this.scene && this.camera) {
                this.renderer.render(this.scene, this.camera);
            }
        }
    }
    
    updateSettings(settings = {}) {
        if (!this.uniforms) return;
        
        if (settings.mouseStrength !== undefined) {
            this.uniforms.u_mouseStrength.value = settings.mouseStrength;
        }
        if (settings.riseSpeed !== undefined) {
            this.uniforms.u_riseSpeed.value = settings.riseSpeed;
        }
        if (settings.blobScale !== undefined) {
            this.uniforms.u_blobScale.value = settings.blobScale;
        }
        if (settings.detailScale !== undefined) {
            this.uniforms.u_detailScale.value = settings.detailScale;
        }
        if (settings.glowStrength !== undefined) {
            this.uniforms.u_glowStrength.value = settings.glowStrength;
        }
    }
    
    getPresets() {
        return {
            calm: {
                mouseStrength: 0.2,
                riseSpeed: 0.05,
                blobScale: 1.5,
                detailScale: 4.0,
                glowStrength: 1.0
            },
            energetic: {
                mouseStrength: 0.6,
                riseSpeed: 0.15,
                blobScale: 2.2,
                detailScale: 8.0,
                glowStrength: 2.0
            },
            intense: {
                mouseStrength: 0.8,
                riseSpeed: 0.25,
                blobScale: 3.0,
                detailScale: 10.0,
                glowStrength: 3.0
            }
        };
    }
    
    applyPreset(presetName) {
        const presets = this.getPresets();
        if (presets[presetName]) {
            this.updateSettings(presets[presetName]);
            console.log(`🎨 Applied "${presetName}" preset to lava lamp`);
        } else {
            console.warn(`Preset "${presetName}" not found. Available: ${Object.keys(presets).join(', ')}`);
        }
    }
    
    destroy() {
        this.stop();
        
        // Clean up Three.js resources
        if (this.mesh) {
            this.mesh.geometry.dispose();
            this.mesh.material.dispose();
        }
        
        if (this.renderer) {
            this.renderer.dispose();
        }
        
        // Remove canvas
        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
        
        // Clear references
        this.canvas = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.mesh = null;
        this.uniforms = null;
    }
}
