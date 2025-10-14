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

// ============================================================================
// NOISE FUNCTIONS - Simplex noise and FBM for organic blob generation
// ============================================================================

// 2D Simplex noise base (pseudo-Perlin for simplicity)
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

float noise2D(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // Smoothstep interpolation
    
    float n0 = hash(i);
    float n1 = hash(i + vec2(1.0, 0.0));
    float n2 = hash(i + vec2(0.0, 1.0));
    float n3 = hash(i + vec2(1.0, 1.0));
    
    float nx0 = mix(n0, n1, f.x);
    float nx1 = mix(n2, n3, f.x);
    return mix(nx0, nx1, f.y);
}

// 3D noise by combining 2D noise with time/z offset
float noise3D(vec3 p) {
    float n1 = noise2D(p.xy);
    float n2 = noise2D(p.xy + vec2(123.456, 789.012));
    return mix(n1, n2, sin(p.z) * 0.5 + 0.5);
}

// Multi-octave FBM (Fractional Brownian Motion) for rich detail
float fbm(vec3 p, int octaves, float persistence, float lacunarity) {
    float total = 0.0;
    float amplitude = 1.0;
    float maxValue = 0.0;
    
    for (int i = 0; i < 8; i++) {  // Max 8 iterations (adjust for performance)
        if (i >= octaves) break;
        
        total += noise3D(p) * amplitude;
        maxValue += amplitude;
        amplitude *= persistence;
        p *= lacunarity;
    }
    
    return total / maxValue;
}

// Ridged noise for sharp, vein-like lava flows
float ridgedNoise(vec3 p) {
    float n = fbm(p, 4, 0.5, 2.0);
    return 1.0 - abs(n) * 2.0;  // Sharp ridges
}

// Curl noise for organic swirling motion
vec3 curlNoise(vec3 p) {
    float eps = 0.1;
    
    // Sample noise at nearby points for gradient
    float n1 = noise3D(p + vec3(eps, 0.0, 0.0));
    float n2 = noise3D(p - vec3(eps, 0.0, 0.0));
    float n3 = noise3D(p + vec3(0.0, eps, 0.0));
    float n4 = noise3D(p - vec3(0.0, eps, 0.0));
    float n5 = noise3D(p + vec3(0.0, 0.0, eps));
    float n6 = noise3D(p - vec3(0.0, 0.0, eps));
    
    // Calculate curl
    vec3 curl;
    curl.x = (n4 - n3) - (n6 - n5);
    curl.y = (n6 - n5) - (n2 - n1);
    curl.z = (n2 - n1) - (n4 - n3);
    
    return curl * 0.5 / eps;
}

// Enhanced organic blob with curl influence
float organicBlob(vec2 p, float time) {
    vec3 pos = vec3(p * u_blobScale, time * 0.15);
    
    // Base shape with curl influence
    vec3 curl = curlNoise(pos * 1.5);
    pos.xy += curl.xy * 0.3; // Swirl the coordinates
    
    float base = ridgedNoise(pos);
    
    // Add secondary swirling detail
    vec3 detailPos = vec3(p * u_detailScale, time * 0.3 + 100.0);
    vec3 detailCurl = curlNoise(detailPos);
    detailPos.xy += detailCurl.xy * 0.1;
    
    float detail = fbm(detailPos, 3, 0.6, 2.0);
    
    return base + detail * 0.2;
}

// Multi-layer blob system for depth
float multiLayerBlob(vec2 p, float time) {
    // Layer 1: Large, slow-moving blobs (background)
    float layer1 = organicBlob(p * 0.8, time * 0.3) * 0.8;
    
    // Layer 2: Medium blobs (main content)
    float layer2 = organicBlob(p * 1.2, time * 0.5) * 1.0;
    
    // Layer 3: Small, fast details (foreground)
    float layer3 = organicBlob(p * 2.0, time * 0.8) * 0.4;
    
    // Combine layers with different thresholds
    float blob1 = smoothstep(0.3, 0.6, layer1 + 0.5);
    float blob2 = smoothstep(0.4, 0.7, layer2 + 0.5);
    float blob3 = smoothstep(0.5, 0.8, layer3 + 0.5);
    
    // Blend layers (foreground over background)
    return max(blob1, max(blob2, blob3));
}

// Bubble effect for small spark details
float bubbleEffect(vec2 p, float time) {
    vec3 bubblePos = vec3(p * 8.0, time * 2.0);
    float bubbles = fbm(bubblePos, 2, 0.7, 3.0);
    
    // Only show bright spots
    float bubbleMask = smoothstep(0.7, 0.9, bubbles);
    
    // Make bubbles move upward faster
    bubbleMask *= (0.8 + 0.4 * sin(time * 10.0 + p.x * 20.0));
    
    return bubbleMask * 0.3;
}

// Heat distortion effect
vec2 heatDistortion(vec2 p, float time) {
    float distortion = sin(p.x * 15.0 + time * 4.0) * 
                      sin(p.y * 12.0 + time * 3.5) * 0.003;
    return vec2(distortion, distortion * 0.7);
}

// ============================================================================
// COLOR & GRADIENT FUNCTIONS
// ============================================================================

// Enhanced lava gradient with deeper color palette and multi-frequency pulsation
vec3 lavaGradient(float v, float glowStrength) {
    // Deep magma colors with more variation
    vec3 deepMagma = vec3(0.15, 0.02, 0.0);
    vec3 darkRed = vec3(0.4, 0.08, 0.01);
    vec3 orange = vec3(1.0, 0.3, 0.05);
    vec3 brightOrange = vec3(1.0, 0.5, 0.1);
    vec3 yellow = vec3(1.0, 0.8, 0.3);
    vec3 whiteHot = vec3(1.0, 0.95, 0.8);
    
    vec3 color;
    if (v < 0.3) {
        color = mix(deepMagma, darkRed, v * 3.33);
    } else if (v < 0.5) {
        color = mix(darkRed, orange, (v - 0.3) * 5.0);
    } else if (v < 0.7) {
        color = mix(orange, brightOrange, (v - 0.5) * 5.0);
    } else if (v < 0.9) {
        color = mix(brightOrange, yellow, (v - 0.7) * 5.0);
    } else {
        color = mix(yellow, whiteHot, (v - 0.9) * 10.0);
    }
    
    // Multi-frequency pulsation for more organic feel
    float slowPulse = 0.5 + 0.5 * sin(u_time * 2.0);
    float fastPulse = 0.7 + 0.3 * sin(u_time * 8.0);
    float glow = pow(v, 4.0) * slowPulse * fastPulse * glowStrength;
    
    return color + whiteHot * glow;
}

// ============================================================================
// MAIN FRAGMENT SHADER
// ============================================================================

void main() {
    // Normalize screen coordinates [0, resolution] -> [0, 1]
    // y=0 at bottom, y=1 at top (matches UI coordinates)
    vec2 uv = gl_FragCoord.xy / u_resolution;
    
    // Aspect ratio correction (non-square screens)
    vec2 ratio = u_resolution / min(u_resolution.x, u_resolution.y);
    vec2 p = (uv - 0.5) * ratio;
    
    // ========================================================================
    // HEAT DISTORTION - Subtle wavering effect
    // ========================================================================
    
    p += heatDistortion(p, u_time);
    
    // ========================================================================
    // MOUSE INTERACTION - Enhanced with multiple effects
    // ========================================================================
    
    vec2 toMouse = u_mouse - uv;
    float mouseDist = length(toMouse);
    
    if (mouseDist < 0.3) {
        float strength = u_mouseStrength;
        
        // 1. Push away from mouse (repulsion)
        float push = strength * (0.3 - mouseDist) / 0.3;
        p -= toMouse * push * 0.5;
        
        // 2. Swirl around mouse
        float swirl = strength * (0.3 - mouseDist) / 0.3;
        float angle = swirl * 2.0 * sin(u_time * 4.0);
        mat2 rotation = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
        vec2 offset = p - (u_mouse - 0.5) * ratio;
        p = (u_mouse - 0.5) * ratio + rotation * offset;
        
        // 3. Ripple effect
        float ripple = sin(mouseDist * 20.0 - u_time * 8.0) * strength;
        p += normalize(toMouse) * ripple * 0.02;
    }
    
    // ========================================================================
    // RISING EFFECT - Blobs appear to rise upward seamlessly
    // ========================================================================
    
    // Offset y by time, looping every 2 units for seamless repeat
    //p.y -= mod(u_time * u_riseSpeed, 2.0);
    
    // ========================================================================
    // MULTI-LAYER BLOB GENERATION - Enhanced depth and detail
    // ========================================================================
    
    float lava_mask = multiLayerBlob(p, u_time);
    
    // Add bubble details for sparkle effect
    lava_mask += bubbleEffect(p, u_time);
    
    // Vertical fade with curve for natural falloff
    float verticalFade = pow(1.0 - uv.y, 0.7);
    lava_mask *= (0.5 + verticalFade * 0.5);
    
    // ========================================================================
    // COLORING & OUTPUT
    // ========================================================================
    
    vec3 color = lavaGradient(lava_mask, u_glowStrength);
    
    // Subtle vignette for focus
    float vignette = 1.0 - length(uv - 0.5) * 0.3;
    color *= vignette;
    
    // Final output with slight saturation boost
    gl_FragColor = vec4(color * 1.05, 1.0);
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
