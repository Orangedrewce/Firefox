(function(window, document, THREE, RAPIER){
    'use strict';

//runtime debug flag structure
const DEBUG_FLAGS = {
    perf: false,          // toggle frequent perf logs
    trackGen: false,      // toggle per-segment generation logs
};

/* --- Error Handling Utilities --- */
class GameError extends Error {
    constructor(message, context = 'general', data = null){
        super(message);
        this.name = 'GameError';
        this.context = context;
        this.data = data;
        this.timestamp = performance.now();
        // Ensure V8 stack is captured for better diagnostics
        if (typeof Error !== 'undefined' && typeof Error.captureStackTrace === 'function') {
            Error.captureStackTrace(this, GameError);
        }
    }
}
// Simple de-dupe cache to avoid log spam
const _reportedErrorCache = new Map(); // key -> timestamp
function reportError(context, message, data, opts = {}){
    const err = message instanceof Error ? message : new GameError(String(message), context, data);
    const key = context + '|' + err.message + '|' + JSON.stringify(sanitizeContext(data));
    const now = performance.now();
    const last = _reportedErrorCache.get(key);
    const windowMs = opts.windowMs ?? 5000;
    if (!opts.force && last && (now - last) < windowMs) {
        return err; // suppress duplicate within window
    }
    _reportedErrorCache.set(key, now);
    try { logger?.logError?.(context, err); } catch {}
    try {
        GameLogger?.cleanup?.(`Error[${context}]: ${err.message}`);
        if (data) console.warn('Error context data:', sanitizeContext(data));
    } catch {}
    return err;
}
function sanitizeContext(ctx){
    if (!ctx || typeof ctx !== 'object') return ctx;
    const out = {};
    for (const [k,v] of Object.entries(ctx)){
        if (v == null) { 
            out[k]=v; 
            continue; 
        }
        if (typeof v === 'object'){
            if (Array.isArray(v)) { 
                out[k] = `[array len=${v.length}]`; 
            } else {
                // FIXED: Check if constructor exists before accessing name
                const constructorName = v.constructor?.name;
                if (constructorName && constructorName !== 'Object') {
                    out[k] = `[${constructorName}]`;
                } else {
                    const keys = Object.keys(v).slice(0,5);
                    out[k] = keys.join(',') + (Object.keys(v).length > 5 ? '…' : '');
                }
            }
        } else {
            out[k]=v;
        }
    }
    return out;
}

/* --- Configuration --- */

// Add to top of Game class or global config
const FLOAT_EPSILON = 0.001;

// Add to CONFIG object or create new CONSTANTS object
const VISUAL_CONSTANTS = {
    DASH_FOV_BOOST: 20,
    DASH_FOV_DURATION: 0.35,
    ENERGY_FAIL_ANIMATION_DURATION: 400, // ms
    SPIKE_COOLDOWN: 1.0, // seconds
    CAMERA_FOV_PULSE_CURVE: Math.PI,
    LAVA_SPLASH_OFFSET: 0.2,
    CRUMBLE_VISUAL_SCALE: 0.95,
    DEBUG_UPDATE_INTERVAL: 16, // ms (60fps)
};

const CONFIG = {
    moveSpeed: 6.0,
    sprintMultiplier: 2.75,    // sprint speed boost
    accelGround: 30, //
    decelGround: 20, // smoothing deceleration when releasing input
    accelAir: 8, //
    airControlMultiplier: 20, //

    //Quick Jump for a short spacebar tap
    quickJump: {
        cost: 5, // energy cost
        verticalForce: 11, // vertical force
        tapThreshold: 0.2, // max time between press and release to count as a tap
    },

    //Air Dash configuration
    airDash: {
        // Direct mapping: force = staminaUsed * forceMultiplier
        forceMultiplier: .3, // horizontal force per energy used
        downwardVelocityCap: -5, // Caps falling speed during a dash
    },

    chargeLeap: {
        maxChargeTime: 1.5, // seconds to reach max charge
        staminaDrainPerSecond: 50, // energy drained per second while charging
        minChargeEnergy: 5, // minimum energy to perform a charge
        minVertical: 6, // minimum vertical force at min charge
        maxVertical: 20, // max vertical force at max charge
        minForward: 6, // minimum forward force at min charge
        maxForward: 30, // max forward force at max charge
        horizontalMultiplierUsesCamera: true // if false, use player facing
    },

    player: {
        height: 0.8,  // half-height for capsule
        radius: 0.30, // radius for capsule
        mass: 80, // kg
        maxHealth: 100, // max health
        maxSprint: 100,         // energy capacity
        sprintDrainRate: 0,     // no drain for infinite sprint
        sprintRegenRate: 60,    // energy per second
        sprintRegenDelay: 0.75  // seconds after sprinting stops
    },
    camera: { 
        fov:85, near:0.1, far:350, 
        distance:6, height:2.5, 
    sensitivityX:0.2, sensitivityY:0.2, 
        clampY:0.8, smoothing: 0.01, 
        lookAtHeightOffset: 0.8,
        zoomMinDistance: 2,
        zoomMaxDistance: 15,
        zoomSpeed: 0.5
    },
    physics: { timestep:1/60, gravity:{ x:0, y:-9.81*2, z:0 } },
    lava: {
        surfaceY: -50,        // visual plane Y
        thickness: 0.5,       // collider thickness
        killOnContact: true,  // auto-death when touched
        halfSize: 5000,       // half-size of collider plane (matches 10000 visual plane)
        // Collider offset relative to the visual lava plane. Negative values place the
        // physics sensor slightly below the visual plane so it will 'engulf' the
        // player and track a few units earlier than the visible lava. Default: -2
        colliderOffset: -2
    },
    risingLava: {
        // Lava starts at this world height (same as existing lava)
        START_HEIGHT: -50, 
        
        // Speed at which the lava rises per second (e.g., 0.5 units/second)
        RISE_SPEED: 0.05, 
        
        // Color for the lava material (e.g., a bright, emissive red/orange)
        COLOR: 0xff4500, 
        
        // Intensity of the lava's glowing effect (if using an emissive material)
        EMISSIVE_INTENSITY: 0.8,
    },
    jump: { coyoteTime:0.15, bufferTime:0.15, minGroundTime:0.05 }, // coyote still used for starting a charge
    animation: { crossFadeDuration:0.2 },
    track: {
        segmentLength: 20,
        segmentWidth: 10,
        segmentsToGenerateAhead: 8,
        segmentsToKeepBehind: 4,
        spikeSpacing: 1.5
    },
    movement: {
        rotationSpeed: 4,
        airTurnMultiplier: 0.2, // legacy simple scalar (kept for backward compatibility)
        // --- Fine Control Additions ---
        airTurn: {             // progressive air rotation control
            start: 0.35,       // initial fraction of ground turn speed right after leaving ground
            end: 0.55,         // fraction reached after rampTime airborne
            rampTime: 0.6,     // seconds until we reach 'end'
            exponent: .5      // easing exponent ( >1 slower start, <1 faster start )
        },
        sprintTurnMultiplier: 2.0,     // optional boost (or reduction) while sprinting
        backwardTurnMultiplier: 0.85,  // turning while holding S only
        dashTurnMultiplier: 0.4,       // turning while in DashState
        maxAirSpeedMultiplier: 1.2,
    }
    ,gameplay: {
        teeterProbability: 0.45,
        horizontalObstacleProbability: 0.7,
        quickJumpCost: 5, //quick jump energy cost
        minDashEnergy: 10, // Minimum energy required to perform a dash
        spikeDamage: 25,
    }
};

// Keep an immutable baseline for per-level overrides
const BASE_CONFIG = structuredClone(CONFIG);

function deepMerge(target, source){
    for (const k in source){
        // Guard against prototype pollution
        if (k === '__proto__' || k === 'prototype' || k === 'constructor') continue;
        if (source[k] && typeof source[k] === 'object' && !Array.isArray(source[k])){
            if (!target[k] || typeof target[k] !== 'object') target[k] = {};
            deepMerge(target[k], source[k]);
        } else {
            target[k] = source[k];
        }
    }
    return target;
}

// Update instruction energy costs now that CONFIG is defined
function updateInstructionCosts(options = {}) {
    const { retries = 3, intervalMs = 300, silent = false } = options;
    try {
        const quickJumpRegex = /Quick Jump \(.*?energy\)/i;
        const containers = [
            document.getElementById('controls-section'),
            document.getElementById('instructions')
        ].filter(Boolean);

        if (containers.length === 0) {
            // If DOM not ready yet, retry a limited number of times without throwing
            if (retries > 0) {
                setTimeout(() => updateInstructionCosts({ retries: retries - 1, intervalMs, silent }), intervalMs);
            } else if (!silent) {
                GameLogger.lifecycle('Instruction cost update skipped (containers not found).');
            }
            return;
        }
        // Update all relevant containers
        containers.forEach(root => {
            root.querySelectorAll('p').forEach(p => {
                if (quickJumpRegex.test(p.innerHTML)) {
                    p.innerHTML = p.innerHTML.replace(quickJumpRegex, `Quick Jump (${CONFIG.quickJump.cost} energy)`);
                }
                
            });
        });

        // Verification step
        const instr = document.getElementById('instructions');
        if (instr) {
            const ok = instr.innerHTML.includes(`${CONFIG.quickJump.cost} energy`);
            if (!ok && retries > 0) {
                setTimeout(() => updateInstructionCosts({ retries: retries - 1, intervalMs, silent }), intervalMs);
            } else if (!ok && !silent) {
                GameLogger.lifecycle('Instruction quick jump cost not verified after retries.');
            }
        }
    } catch (e) {
        if (retries > 0) {
            setTimeout(() => updateInstructionCosts({ retries: retries - 1, intervalMs, silent }), intervalMs);
        } else if (!silent) {
            GameLogger.lifecycle('Instruction cost update aborted after errors.', { error: e?.message });
        }
    }
}

/* --- Level Definitions & Save System --- */
const LEVELS = [
    { 
        id:'classic', 
        name:'Easy', 
        description:'No tilting platforms, some spikes', 
        difficulty:'Easy', 
        unlocked:true, 
        type:'horizontal', 
        config:{ 
            moveSpeed:6.0, 
            sprintMultiplier:2.5,
            track: {
                segmentLength: 20, // standard length
                segmentWidth: 10, // standard width
                noTilt: true, // no tilting platforms
                spikeChance: 0.6  // 60% of platforms have spikes
            }
        } 
    },
    { 
        id:'translate', 
        name:'Translate', 
        description:'Jump across moving platforms', 
        difficulty:'Hard', 
        unlocked:true, 
        type:'horizontal', 
        config:{ 
            moveSpeed: 6.0, 
            sprintMultiplier: 2.0,
            track: {
                segmentLength: 20,
                segmentWidth: 10,
                noTilt: true,
                spikeChance: 0.0,
                platformSpacing: 30
            },
            movingPlatformConfig: {
                staticSpawnPlatforms: 1,     // First platform is always static
                // Note: purposefully omitting TranslateZ to keep movement simple to read
                movementTypes: [
                    'TranslateX',              // Left-right (ONLY)
                    'TranslateY',              // Up-down (ONLY)
                    'RotateX',                 // Pitch/tilt around X axis
                    'RotateZ',                 // Roll/tilt around Z axis
                    'RotateXFree',             // Continuous slow pitch (no clamps)
                    'RotateZFree',             // Continuous slow roll (no clamps)
                    'SpinCW',                  // Spin clockwise (Y-axis)
                    'SpinCCW'                  // Spin counter-clockwise (Y-axis)
                ],
                // Single-run uniformization (when triggered, all platforms use the same type)
                uniformTypeChance: 0.10,      // 10% chance to make all platforms a single type (adjust as needed)
                uniformType: 'random',        // 'random' = pick from movementTypes; or set a specific type string to force that type
                // Movement ranges/speeds
                maxDisplacementX: 6.0,        // ±6 units
                maxDisplacementY: 6.0,        // ±6 units
                maxDisplacementZ: 0.0,        // No Z translation by design
                rotationSpeed: 40,            // deg/sec for oscillating axes and spin
                translationSpeed: 20,        // translation speed (u/s) for TranslateX/Y
                pauseAtExtents: 1.5,          // pause in seconds when reaching ends
                platformCount: 10,
                scorePerPlatform: 1,
                // Carry tuning: how player inherits platform motion (Translate-only)
                inheritLinearCarry: 1,          // 0..1 fraction of platform linear motion
                inheritSpinAngularCarry: 0.6,     // 0..1 fraction for spin (Y-axis) ω×r tangential carry
                inheritTiltAngularCarry: 0.0,     // 0..1 fraction for tilt (RotateX/Z) ω×r (0 disables sideways shove)
                carryEnableGroundDelay: 0.08,     // seconds after landing before carry activates
                maxCarrySpeed: 8                  // clamp horizontal carry magnitude (u/s)
            }
        } 
    },
    { 
        id:'hinged', 
        name:'Medium', 
        description:'Only static platforms have spikes', 
        difficulty:'Medium', 
        unlocked:true, 
        type:'horizontal', 
        config:{ 
            moveSpeed:5.5, 
            sprintMultiplier:2.3,
            track: {
                segmentLength: 20,
                segmentWidth: 10,
                moderateTilt: true,  // Tilting platforms
                tiltChance: 0.4,      // 40% chance of tilt
                spikeChance: 0.75     // 75% chance of spikes
            },
            gameplay: {
                teeterProbability: 0.4  // matches tiltChance
            }
        } 
    },
    { 
        id:'chaotic', 
        name:'Chaotic', 
        description:'Static platforms and Multi axis platforms have spikes', 
        difficulty:'Hard', 
        unlocked:true, 
        type:'horizontal', 
        config:{ 
            moveSpeed:5.0, 
            sprintMultiplier:2.0,
            track: {
                segmentLength: 20,
                segmentWidth: 8,
                chaoticMode: true,    // extreme variation
                allTeeter: true,      // Most platforms tilt
                spikeChance: 0.8      // 80% chance of spikes
            },
            gameplay: {
                teeterProbability: 0.8  // 80% of platforms tilt
            }
        } 
    },
    { 
        id:'crumble', 
        name:'Newton', 
        description:'Crumble platforms, don\'t stop moving!', 
        difficulty:'Hard', 
        unlocked:true, 
        type:'horizontal', 
        config:{ 
            moveSpeed:6.5, 
            sprintMultiplier:2.5,
            track: {
                segmentLength: 20,
                segmentWidth: 10,
                noTilt: true,
                spikeChance: 0,
                crumbleMode: true,
                crumbleChance: 1.0
            },
            crumble: {
                delay: 1.0,
                fallDuration: 2.5,
                warningColor: 0xFF6600,
                crumbleColor: 0x884400
            }
        } 
    },
    { 
        id:'rising_lava', 
        name:'Rising Lava', 
        description:'Survive the rising lava!', 
        difficulty:'Expert', 
        unlocked:true, 
        type:'horizontal', 
        config:{ 
            moveSpeed: 6.0, 
            sprintMultiplier: 2.0,
            track: {
                segmentLength: 20,
                segmentWidth: 10,
                noTilt: true,
                spikeChance: 0.0,
                platformSpacing: 30
            },
            movingPlatformConfig: {
                staticSpawnPlatforms: 1,     // First platform is always static
                // Note: purposefully omitting TranslateZ to keep movement simple to read
                movementTypes: [
                    'TranslateX',              // Left-right (ONLY)
                    'TranslateY',              // Up-down (ONLY)
                    'RotateX',                 // Pitch/tilt around X axis
                    'RotateZ',                 // Roll/tilt around Z axis
                    'RotateXFree',             // Continuous slow pitch (no clamps)
                    'RotateZFree',             // Continuous slow roll (no clamps)
                    'SpinCW',                  // Spin clockwise (Y-axis)
                    'SpinCCW'                  // Spin counter-clockwise (Y-axis)
                ],
                // Single-run uniformization (when triggered, all platforms use the same type)
                uniformTypeChance: 0.10,      // 10% chance to make all platforms a single type (adjust as needed)
                uniformType: 'random',        // 'random' = pick from movementTypes; or set a specific type string to force that type
                // Movement ranges/speeds
                maxDisplacementX: 6.0,        // ±6 units
                maxDisplacementY: 6.0,        // ±5 units
                maxDisplacementZ: 0.0,        // No Z translation by design
                rotationSpeed: 40,            // deg/sec for oscillating axes and spin
                translationSpeed: 20,        // translation speed (u/s) for TranslateX/Y
                pauseAtExtents: 1.5,          // pause in seconds when reaching ends
                platformCount: 10,
                scorePerPlatform: 1,
                // Carry tuning: how player inherits platform motion (Translate-only)
                inheritLinearCarry: 1,          // 0..1 fraction of platform linear motion
                inheritSpinAngularCarry: 0.6,     // 0..1 fraction for spin (Y-axis) ω×r tangential carry
                inheritTiltAngularCarry: 0.0,     // 0..1 fraction for tilt (RotateX/Z) ω×r (0 disables sideways shove)
                carryEnableGroundDelay: 0.08,     // seconds after landing before carry activates
                maxCarrySpeed: 8                  // clamp horizontal carry magnitude (u/s)
            }
        } 
    },
    { 
        id:'minimal', 
        name:'Dev Room', 
        description:'Soon to be sandbox mode', 
        difficulty:'N/a', 
        unlocked:true, 
        type:'horizontal', 
        config:{ 
            moveSpeed:6.0, 
            track:{ segmentWidth:5 }, 
            sandbox:true 
        } 
    }
];

// Global feature flag to disable spiral map logic entirely

class GameSaveManager {
    constructor(){ this.storageKey='lavaRunner_save'; }
    getSaveData(){
        try {
            const data = localStorage.getItem(this.storageKey);
            if (!data) return { unlockedLevels:['classic'], levelScores:{}, totalPlaytime:0 };
            try { return JSON.parse(data); }
            catch { return { unlockedLevels:['classic'], levelScores:{}, totalPlaytime:0 }; }
        } catch {
            // localStorage may be unavailable (sandbox/iframe) — return safe defaults
            return { unlockedLevels:['classic'], levelScores:{}, totalPlaytime:0 };
        }
    }
    saveLevelScore(levelId, score){
        const data = this.getSaveData();
        const oldScore = data.levelScores[levelId] || 0;
        if (!data.levelScores[levelId] || score > data.levelScores[levelId]){
            data.levelScores[levelId] = score;
            try { localStorage.setItem(this.storageKey, JSON.stringify(data)); } catch {}
            try {
                GameLogger.score(`New high score on ${levelId}: ${oldScore} -> ${score} (+${score - oldScore})`, {
                    isFirstScore: !oldScore,
                    improvement: oldScore > 0 ? (((score - oldScore) / oldScore) * 100).toFixed(1) + '%' : 'N/A'
                });
            } catch {}
        } else {
            try { GameLogger.score(`Score on ${levelId}: ${score} (best: ${data.levelScores[levelId]})`); } catch {}
        }
    }
    unlockLevel(levelId){
        const data = this.getSaveData();
        if (!data.unlockedLevels.includes(levelId)){
            data.unlockedLevels.push(levelId);
            try { localStorage.setItem(this.storageKey, JSON.stringify(data)); } catch {}
        }
    }
    isLevelUnlocked(levelId){
        try { return this.getSaveData().unlockedLevels.includes(levelId); }
        catch { return levelId === 'classic'; }
    }
    getBestScore(levelId){
        try { return this.getSaveData().levelScores[levelId] || 0; }
        catch { return 0; }
    }
    // Wipe all saved data (localStorage keys) and reinitialize defaults
    resetAllData(){
        try {
            console.log('[GameSaveManager] Resetting all save data...');
            // Remove save and settings keys
            localStorage.removeItem(this.storageKey);
            try { localStorage.removeItem('lavaRunner_settings'); } catch {}
            // Recreate a clean default save so code expecting a save still works
            const defaults = { unlockedLevels:['classic'], levelScores:{}, totalPlaytime:0 };
            localStorage.setItem(this.storageKey, JSON.stringify(defaults));
            console.log('[GameSaveManager] Save data reset complete.');
            // Emit an event in case UI wants to listen
            try { window.dispatchEvent(new CustomEvent('lavaRunner:saveReset')); } catch {}
            return true;
        } catch(e){
            console.error('[GameSaveManager] Failed to reset save data', e);
            return false;
        }
    }
}
const saveManager=new GameSaveManager();

/* --- Enhanced Logging System (adds console interception, input history, export) --- */
class LogManager {
    constructor(){
        this.logs = [];
        this.maxLogs = 100;
        this.listeners = [];
        this.inputHistory = [];
        this.maxInputHistory = 50;
        this.errorCount = 0;
        this.warningCount = 0;
        this._setupConsoleInterception();
        window.addEventListener('error', (e) => this.logError('Unhandled Error', e.error || e.message));
        window.addEventListener('unhandledrejection', (e) => this.logError('Unhandled Promise Rejection', e.reason));
    }

    _setupConsoleInterception(){
        const originalConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
        console.log = (...args) => { this._addLog('INFO', args); originalConsole.log(...args); };
        console.warn = (...args) => { this._addLog('WARN', args); this.warningCount++; originalConsole.warn(...args); };
        console.error = (...args) => { this._addLog('ERROR', args); this.errorCount++; originalConsole.error(...args); };
    }

    _addLog(level, args){
        const log = {
            level,
            message: args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '),
            timestamp: performance.now(),
            // Capture stack traces for ERROR and WARN so we can trace deprecation warnings
            stackTrace: (level === 'ERROR' || level === 'WARN') ? new Error().stack : null
        };
        this.logs.push(log);
        if (this.logs.length > this.maxLogs) this.logs.shift();
        this.listeners.forEach(fn => { try { fn(log); } catch {} });
    }

    logInput(action, data = {}){
        const entry = { action, data, timestamp: performance.now(), playerState: this._capturePlayerState() };
        this.inputHistory.push(entry);
        if (this.inputHistory.length > this.maxInputHistory) this.inputHistory.shift();
    }

    _capturePlayerState(){
        if (!window.gameInstance?.playerController) return null;
        const pc = window.gameInstance.playerController;
        try {
            return {
                state: pc.fsm?.current?.constructor?.name || 'Unknown',
                position: pc.currentTranslation ? { x: pc.currentTranslation.x.toFixed(2), y: pc.currentTranslation.y.toFixed(2), z: pc.currentTranslation.z.toFixed(2) } : null,
                velocity: pc.body ? (()=>{ try { return pc.body.linvel(); } catch { return null; } })() : null,
                health: pc.health,
                energy: pc.sprint,
                isGrounded: pc.isGrounded
            };
        } catch { return null; }
    }

    logError(context, error){
        console.error(`[${context}]`, error);
        const recentInputs = this.inputHistory.slice(-5);
        console.error('Recent inputs:', recentInputs);
    }

    exportLogs(){
        return { logs:this.logs, inputHistory:this.inputHistory, errorCount:this.errorCount, warningCount:this.warningCount, timestamp:new Date().toISOString() };
    }

    downloadLogs(){
        const data=this.exportLogs();
        const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a'); a.href=url; a.download=`game-logs-${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
    }
}

// Create and expose global logger (module scope -> window) so HTML buttons can call it
const logger = new LogManager();
window.logger = logger;

// Debug panel helpers
function updateDebugPanel(){
    const content = document.getElementById('log-content');
    if (!content) return;
    const logs = logger.logs.slice(-100);
    content.innerHTML = logs.map(log => {
        const color = { INFO: '#0f0', WARN: '#ff0', ERROR: '#f00' }[log.level] || '#0f0';
        return `<div style="color:${color}; margin-bottom:6px;">[${(log.timestamp/1000).toFixed(2)}s] ${escapeHtml(log.message)}</div>`;
    }).join('');
    content.scrollTop = content.scrollHeight;
}

function escapeHtml(str){ return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

document.addEventListener('keydown', (e)=>{
    if (e.code === 'KeyL' && e.shiftKey){
        GameLogger.input('Hotkey: Shift+L (toggle debug panel)');
        const panel = document.getElementById('debug-panel');
        if (!panel) return;
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
        updateDebugPanel();
    }
});

document.getElementById('download-logs')?.addEventListener('click', ()=> {
    GameLogger.input('Click: Download logs button');
    logger.downloadLogs();
});
document.getElementById('close-debug')?.addEventListener('click', ()=> { 
    GameLogger.input('Click: Close debug panel button');
    document.getElementById('debug-panel').style.display='none'; 
});

setInterval(()=>{ const panel=document.getElementById('debug-panel'); if (panel && panel.style.display !== 'none') updateDebugPanel(); }, 1000);

// Ensure instruction cost text is updated after module runs & DOM exists
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', updateInstructionCosts, { once:true });
} else {
    updateInstructionCosts();
}

/* --- Particle System --- */
class ParticleSystem {
    constructor(scene) {
        this.scene = scene;
        this.particles = [];
        this.pool = [];
        this.maxParticles = 200;
        this.maxPoolSize = 100; // Limit pool size to prevent runaway memory
        this.geometry = new THREE.SphereGeometry(0.1, 4, 4); // Low-poly sphere for better appearance
        this.geometry._isSharedGeometry = true; // Tag geometry for potential future use
    }

    getParticle() {
        // Try to reuse from pool
        let particle = this.pool.pop();

        // Validate pooled particle
        if (particle) {
            try {
                const mesh = particle.mesh;
                const invalid = !mesh || !mesh.material || !mesh.geometry;
                if (invalid) {
                    reportError('particle_system', 'Corrupted particle in pool, creating new one', { 
                        hasMesh: !!mesh, 
                        hasMaterial: !!(mesh?.material), 
                        hasGeometry: !!(mesh?.geometry) 
                    });
                    
                    // CRITICAL FIX: Fully dispose corrupted particle before creating new
                    if (mesh) {
                        try {
                            if (mesh.material && !mesh.material._disposed) {
                                if (Array.isArray(mesh.material)) {
                                    mesh.material.forEach(m => { try { m.dispose(); } catch {} });
                                } else {
                                    mesh.material.dispose();
                                }
                            }
                            if (mesh.parent) {
                                mesh.parent.remove(mesh);
                            }
                        } catch (e) {
                            reportError('particle_system', 'Error disposing corrupted particle', e);
                        }
                    }
                    particle = null;
                } else {
                    // If somehow attached to a different parent, detach it; pooled particles should be detached
                    if (mesh.parent && mesh.parent !== this.scene) {
                        try { 
                            mesh.parent.remove(mesh); 
                        } catch(e) { 
                            reportError('particle_system', 'Failed to detach pooled particle from parent', e);
                        }
                    }
                    // Ensure material wasn't disposed while pooled
                    if (mesh.material && mesh.material._disposed) {
                        particle = null;
                    } else {
                        mesh.visible = true;
                    }
                }
            } catch (e) {
                reportError('particle_system', 'Error validating pooled particle', e);
                particle = null;
            }
        }

        // Create new particle if needed
        if (!particle) {
            const material = new THREE.MeshBasicMaterial({ transparent: true });
            // Tag material to avoid double-dispose
            material._isSharedMaterial = false;
            const mesh = new THREE.Mesh(this.geometry, material);
            // Initial properties
            particle = {
                mesh,
                velocity: new THREE.Vector3(),
                age: 0,
                lifetime: 1,
                gravity: 3.0,
                startScale: 1.0,
                endScale: 0.1,
                dustEffect: false,
            };
        }
        return particle;
    }

    emit(options) {
        const count = options.count || 10;
        
        // FIXED: Check capacity BEFORE loop and limit actual spawn count
        const availableSlots = this.maxParticles - this.particles.length;
        if (availableSlots <= 0) {
            GameLogger.perf('Particle system at capacity, skipping emit');
            return; // Early return if no capacity
        }
        
        const actualCount = Math.min(count, availableSlots); // FIXED: Cap to available slots
        
        const position = options.position || new THREE.Vector3();
        const color = options.color || new THREE.Color(0xffffff);
        const lifetime = options.lifetime || 1.0;
        const speed = options.speed || 2.0;
        const spread = options.spread || new THREE.Vector3(1, 1, 1);
        const dustEffect = options.dustEffect || false;

        for (let i = 0; i < actualCount; i++) { // FIXED: Use actualCount
            const p = this.getParticle();
            
            if (dustEffect) {
                p.mesh.material.color.set(color);
                p.mesh.material.opacity = 0.6;
                p.mesh.scale.setScalar(options.startScale || 0.15);
            } else {
                p.mesh.material.color.set(color);
                p.mesh.material.opacity = 1.0;
                p.mesh.scale.setScalar(options.startScale || 1.0);
            }

            p.mesh.position.copy(position);

            if (dustEffect) {
                p.velocity.set(
                    (Math.random() - 0.5) * spread.x * 0.5,
                    Math.random() * spread.y * 0.3,
                    (Math.random() - 0.5) * spread.z * 0.5
                ).normalize().multiplyScalar(speed * (0.3 + Math.random() * 0.4));
            } else {
                p.velocity.set(
                    (Math.random() - 0.5) * spread.x,
                    (Math.random() - 0.5) * spread.y,
                    (Math.random() - 0.5) * spread.z
                ).normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.5));
            }

            p.age = 0;
            p.lifetime = lifetime * (0.75 + Math.random() * 0.5);
            p.endScale = options.endScale || (dustEffect ? 0.02 : 0.1);
            p.startScale = p.mesh.scale.x;
            p.gravity = dustEffect ? 1.5 : (options.gravity !== undefined ? options.gravity : 3.0);
            p.dustEffect = dustEffect;

            this.scene.add(p.mesh);
            this.particles.push(p);
        }
    }

    //  Ketchup splatter effect helper (light / medium / heavy)
    emitKetchup(position, intensity = 'medium') {
        const intensityConfig = {
            light:  { count: 15, speed: 4, spread: 2, lifetime: 0.8, scale: 0.3 },
            medium: { count: 30, speed: 6, spread: 3, lifetime: 1.2, scale: 0.4 },
            heavy:  { count: 60, speed: 8, spread: 4, lifetime: 1.5, scale: 0.5 }
        };
        const cfg = intensityConfig[intensity] || intensityConfig.medium;

        // Core dark red splatter (heavier gravity)
        this.emit({
            position: position.clone(),
            count: cfg.count,
            color: new THREE.Color(0x8B0000),
            speed: cfg.speed,
            lifetime: cfg.lifetime,
            spread: new THREE.Vector3(cfg.spread, cfg.spread * 0.5, cfg.spread),
            startScale: cfg.scale,
            endScale: 0.05,
            gravity: 5.0
        });

        // Lighter mist layer for depth
        this.emit({
            position: position.clone(),
            count: Math.floor(cfg.count * 0.5),
            color: new THREE.Color(0xCD5C5C),
            speed: cfg.speed * 0.6,
            lifetime: cfg.lifetime * 0.7,
            spread: new THREE.Vector3(cfg.spread * 1.2, cfg.spread * 0.6, cfg.spread * 1.2),
            startScale: cfg.scale * 0.7,
            endScale: 0.02,
            gravity: 3.0
        });

        GameLogger.action(`Ketchup splatter (${intensity})`, {
            x: position.x.toFixed(2),
            y: position.y.toFixed(2),
            z: position.z.toFixed(2)
        });
    }


    update(dt) {
        // Early return if no particles to update
        if (this.particles.length === 0) return;
        
        for (let i = this.particles.length - 1; i >= 0; i--) {
            const p = this.particles[i];
            p.age += dt; // Update particle age

            if (p.age >= p.lifetime) {
                this.scene.remove(p.mesh);
                // Only return to pool if under limit
                if (this.pool.length < this.maxPoolSize) {
                    this.pool.push(p);
                } else {
                    // Dispose and discard to cap memory
                    if (p.mesh?.material && !p.mesh.material._disposed) {
                        try { p.mesh.material.dispose(); p.mesh.material._disposed = true; } catch(e) { console.warn('Material dispose error:', e); }
                    }
                }
                this.particles.splice(i, 1);
                continue;
            }

            p.mesh.position.addScaledVector(p.velocity, dt);
            p.velocity.y -= (p.gravity ?? 3.0) * dt;

            const t = p.age / p.lifetime;
            if (p.dustEffect) {
                // Dust particles fade and shrink more gradually
                p.mesh.material.opacity = 0.6 * (1.0 - t);
                const scale = p.startScale + (p.endScale - p.startScale) * (t * 0.7);
                p.mesh.scale.setScalar(scale);
            } else {
                // Regular particles
                p.mesh.material.opacity = 1.0 - t;
                const scale = p.startScale + (p.endScale - p.startScale) * t;
                p.mesh.scale.setScalar(scale);
            }
        }
    }

    destroy() {
        // Idempotent destroy to prevent double-dispose errors
        if (this._destroyed) return;
        this._destroyed = true;

        // Remove all active particles from scene
        this.particles.forEach(p => { if (p.mesh && p.mesh.parent) { this.scene.remove(p.mesh); } });
        // Remove pooled particles from scene (if any were left in scene)
        this.pool.forEach(p => { if (p.mesh && p.mesh.parent) { this.scene.remove(p.mesh); } });

        // Dispose of the shared geometry ONCE
        if (this.geometry && !this.geometry._disposed) {
            try { this.geometry.dispose(); this.geometry._disposed = true; } catch(e) { console.warn('Geometry dispose error:', e); }
        }

        const disposeMat = (mat) => {
            if (!mat || mat._isSharedMaterial || mat._disposed) return;
            try { mat.dispose(); mat._disposed = true; } catch(e) { console.warn('Material dispose error:', e); }
        };

        // Dispose all unique materials (one per particle)
        this.particles.forEach(p => { if (p.mesh && p.mesh.material) disposeMat(p.mesh.material); });
        this.pool.forEach(p => { if (p.mesh && p.mesh.material) disposeMat(p.mesh.material); });

        // Clear arrays
        this.particles.length = 0;
        this.pool.length = 0;
        console.log('✅ ParticleSystem destroyed and cleaned up');
    }

} 

/* --- Audio Manager (Procedural SFX) --- */
class AudioManager {
    constructor(settings) {
        this.settings = settings;
        this.audioContext = null;
        this.compressor = null;
        this.masterGain = null; // Add master gain for volume control
        
        // Add backup beep properties
        this.backupBeepAudio = null; // HTMLAudioElement for backup beep
        this.backupBeepLoaded = true; // Assume true to avoid blocking if loading fails
        this.backupBeepPlaying = false; // Track if beep is currently playing
        this.backupBeepStartTime = 0; // When S key was pressed
        this.backupBeepDelay = 500; // 0.5 seconds in milliseconds
        this.backupBeepTimeout = null; // Timeout ID for delayed beep start

        // Lava hurt loop properties (user-provided MP3)
        this.lavaHurtAudio = null; // HTMLAudioElement for looping lava hurt
        this.lavaHurtLoaded = false;
        this.lavaHurtPlaying = false;
        
        if (typeof AudioContext !== 'undefined') {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                this._setupCompressor();
                this._loadBackupBeep();
                // Load lava hurt audio (looped) in parallel with backup beep
                this._loadLavaHurt();
                // Install an autoplay unlock to satisfy browser policies for HTMLAudio
                this._installAutoplayUnlock();
            } catch {}
        }
    }

    _resumeAudioContext() {
        // Resume Web Audio API context if suspended (browser autoplay policy)
        if (this.audioContext && this.audioContext.state === 'suspended') {
            try {
                this.audioContext.resume().then(() => {
                    console.log('✅ Web Audio API context resumed');
                }).catch(e => {
                    console.warn('Failed to resume audio context:', e);
                });
            } catch (e) {
                console.warn('Error resuming audio context:', e);
            }
        }
    }

    _setupCompressor() {
        if (!this.audioContext) return;
        
        // Create compressor
        this.compressor = this.audioContext.createDynamicsCompressor();
        // Professional compression settings to prevent clipping and 'glue' sounds
        this.compressor.threshold.setValueAtTime(-24, this.audioContext.currentTime);
        this.compressor.knee.setValueAtTime(30, this.audioContext.currentTime);
        this.compressor.ratio.setValueAtTime(12, this.audioContext.currentTime);
        this.compressor.attack.setValueAtTime(0.003, this.audioContext.currentTime);
        this.compressor.release.setValueAtTime(0.25, this.audioContext.currentTime);
        
        // Create master gain node for volume control
        this.masterGain = this.audioContext.createGain();
        
        // Set initial volume
        const initialVolume = (this.settings.masterVolume ?? 0.7) * (this.settings.sfxVolume ?? 0.8);
        this.masterGain.gain.setValueAtTime(
            Math.max(0, Math.min(1, initialVolume)), 
            this.audioContext.currentTime
        );
        
        // Connect: compressor -> masterGain -> destination
        this.compressor.connect(this.masterGain);
        this.masterGain.connect(this.audioContext.destination);
    }

    _loadBackupBeep() {
        console.log('🎵 Attempting to load backup beep audio...');
        try {
            this.backupBeepAudio = new Audio('./backing-up-beepwav-14889.mp3');
            this.backupBeepAudio.loop = true;
            this.backupBeepAudio.preload = 'auto';
            
            this.backupBeepAudio.addEventListener('canplaythrough', () => {
                this.backupBeepLoaded = true;
                console.log('🎵 Backup beep audio loaded successfully');
            });
            
            this.backupBeepAudio.addEventListener('error', (e) => {
                console.warn('🎵 Failed to load backup beep audio:', e);
                console.warn('🎵 Audio error details:', this.backupBeepAudio.error);
            });
            
            this.backupBeepAudio.addEventListener('loadstart', () => {
                console.log('🎵 Backup beep audio loading started...');
            });
            
        } catch (e) {
            console.warn('🎵 Failed to initialize backup beep audio:', e);
        }
    }

    _loadLavaHurt() {
        console.log('🎵 Attempting to load lava hurt loop audio...');
        try {
            // Prefer a predeclared HTML <audio> element if present
            const el = document.getElementById('audio-lava-hurt');
            if (el && el instanceof HTMLAudioElement) {
                this.lavaHurtAudio = el;
                console.log('🎵 Using existing <audio id="audio-lava-hurt"> element');
            } else {
                // Fallback: create a new Audio instance
                this.lavaHurtAudio = new Audio('./Player Fire Hurt (Nr. 3 Minecraft Sound) - Sound Effect for editing.mp3');
            }
            this.lavaHurtAudio.loop = true;
            this.lavaHurtAudio.preload = 'auto';
            try { this.lavaHurtAudio.crossOrigin = 'anonymous'; } catch {}

            this.lavaHurtAudio.addEventListener('canplaythrough', () => {
                this.lavaHurtLoaded = true;
                console.log('🎵 Lava hurt audio loaded successfully');
            });

            this.lavaHurtAudio.addEventListener('error', (e) => {
                console.warn('🎵 Failed to load lava hurt audio:', e);
                console.warn('🎵 Audio error details:', this.lavaHurtAudio.error);
            });

            this.lavaHurtAudio.addEventListener('loadstart', () => {
                console.log('🎵 Lava hurt audio loading started...');
            });

            // Additional readiness signals
            this.lavaHurtAudio.addEventListener('canplay', () => {
                this.lavaHurtLoaded = true;
                console.log('🎵 Lava hurt audio canplay (ready)');
            });
            this.lavaHurtAudio.addEventListener('loadeddata', () => {
                console.log('🎵 Lava hurt audio loadeddata');
            });
            try { this.lavaHurtAudio.load?.(); } catch {}
        } catch (e) {
            console.warn('🎵 Failed to initialize lava hurt audio:', e);
        }
    }

    _installAutoplayUnlock(){
        const unlock = async () => {
            try {
                console.log('🎵 Autoplay unlock: attempting to prime HTMLAudio elements');
                if (this.lavaHurtAudio) {
                    const wasMuted = this.lavaHurtAudio.muted;
                    this.lavaHurtAudio.muted = true;
                    try { await this.lavaHurtAudio.play(); } catch {}
                    try { this.lavaHurtAudio.pause(); } catch {}
                    try { this.lavaHurtAudio.currentTime = 0; } catch {}
                    this.lavaHurtAudio.muted = wasMuted;
                }
                console.log('🎵 Autoplay unlock: priming complete');
            } catch (e) {
                console.warn('🎵 Autoplay unlock failed:', e);
            } finally {
                try { window.removeEventListener('pointerdown', unlock); } catch {}
                try { window.removeEventListener('keydown', unlock); } catch {}
            }
        };
        try { window.addEventListener('pointerdown', unlock, { once:true }); } catch {}
        try { window.addEventListener('keydown', unlock, { once:true }); } catch {}
    }

    startLavaHurtLoop() {
        // Start the looping lava hurt sound (used when player touches lava)
        try {
            console.log('🎵 startLavaHurtLoop called', { hasAudio: !!this.lavaHurtAudio, loaded: this.lavaHurtLoaded, playing: this.lavaHurtPlaying });
            if (!this.lavaHurtAudio || !this.lavaHurtLoaded) {
                console.log('🎵 Lava hurt audio not ready yet');
                return;
            }

            // Prevent starting if already playing
            if (this.lavaHurtPlaying) return;

            // Respect unified menus / pause / game state if available
            const unifiedMenu = document.getElementById('unified-menu');
            const pauseMenu = document.getElementById('pause-menu');
            const gameOver = document.getElementById('game-over');
            const unifiedVisible = unifiedMenu && getComputedStyle(unifiedMenu).display === 'flex';
            const pauseVisible = pauseMenu && getComputedStyle(pauseMenu).display === 'flex';
            const gameOverVisible = gameOver && getComputedStyle(gameOver).display === 'block';
            if (unifiedVisible || pauseVisible || gameOverVisible) {
                console.log('🎵 Menu visible, blocking lava hurt loop start');
                return;
            }

            // Set volume based on settings
            const masterVol = this.settings.masterVolume ?? 0.7;
            const sfxVol = this.settings.sfxVolume ?? 0.8;
            const volume = Math.max(0, Math.min(1, masterVol * sfxVol * 0.9));
            this.lavaHurtAudio.volume = volume;
            this.lavaHurtAudio.currentTime = 0;
            const p = this.lavaHurtAudio.play();
            if (p && typeof p.catch === 'function') p.catch(e => console.warn('🎵 lavaHurtAudio.play() rejected:', e));
            this.lavaHurtPlaying = true;
            console.log('🎵 Lava hurt loop started at volume:', volume);
            GameLogger.lifecycle('Lava hurt loop started');
        } catch (e) {
            console.warn('🎵 Failed to start lava hurt loop:', e);
        }
    }

    stopLavaHurtLoop() {
        try {
            if (this.lavaHurtPlaying && this.lavaHurtAudio) {
                this.lavaHurtAudio.pause();
                this.lavaHurtAudio.currentTime = 0;
                this.lavaHurtPlaying = false;
                console.log('🎵 Lava hurt loop stopped');
                GameLogger.lifecycle('Lava hurt loop stopped');
            }
        } catch (e) {
            console.warn('🎵 Failed to stop lava hurt loop:', e);
        }
    }

    startBackupBeep() {
        console.log('🎵 startBackupBeep called');
        
        // Check if forklift noise is disabled in settings or checkbox
        const checkbox = document.getElementById('forklift-noise');
        if (checkbox && !checkbox.checked) {
            console.log('🎵 Forklift noise disabled via checkbox');
            return;
        }

        if (!this.backupBeepLoaded || this.backupBeepPlaying) {
            console.log('🎵 Backup beep not loaded or already playing:', { loaded: this.backupBeepLoaded, playing: this.backupBeepPlaying });
            return;
        }

        // Use window.gameInstance for game reference
        const gameInstance = window.gameInstance;
        if (!gameInstance || !gameInstance.running || gameInstance.isPaused) {
            console.log('🎵 Game state invalid:', { gameExists: !!gameInstance, running: gameInstance?.running, paused: gameInstance?.isPaused });
            return;
        }

        // Check if player is dead
        const playerController = gameInstance.playerController;
        if (!playerController || playerController.fsm.current instanceof DeadState) {
            console.log('🎵 Player state invalid:', { playerExists: !!playerController, isDead: playerController?.fsm.current instanceof DeadState });
            return;
        }
        
        // Check if any menus are visible
        const unifiedMenu = document.getElementById('unified-menu');
        const pauseMenu = document.getElementById('pause-menu');
        const gameOver = document.getElementById('game-over');
        
    const unifiedVisible = unifiedMenu && getComputedStyle(unifiedMenu).display === 'flex';
    const pauseVisible = pauseMenu && getComputedStyle(pauseMenu).display === 'flex';
    const gameOverVisible = gameOver && getComputedStyle(gameOver).display === 'block';
        
        if (unifiedVisible || pauseVisible || gameOverVisible) {
            console.log('🎵 Menu visible, blocking beep:', { unified: unifiedVisible, pause: pauseVisible, gameOver: gameOverVisible });
            return;
        }
        
        console.log('🎵 All checks passed, starting backup beep timer...');
        
        // Clear any existing timeout
        if (this.backupBeepTimeout) {
            clearTimeout(this.backupBeepTimeout);
            this.backupBeepTimeout = null;
        }
        
        // Record when S key was pressed
        this.backupBeepStartTime = performance.now();
        
        // Set timeout to start beeping after 0.5 seconds
        this.backupBeepTimeout = setTimeout(() => {
            console.log('🎵 Backup beep timeout triggered, checking game state again...');
            
            // Double-check game state when timeout executes
            const gameNow = window.gameInstance;
            if (!gameNow || !gameNow.running || gameNow.isPaused) {
                console.log('🎵 Game state changed during timeout:', { gameExists: !!gameNow, running: gameNow?.running, paused: gameNow?.isPaused });
                return;
            }
            
            const playerNow = gameNow.playerController;
            if (!playerNow || playerNow.fsm.current instanceof DeadState) {
                console.log('🎵 Player state changed during timeout:', { playerExists: !!playerNow, isDead: playerNow?.fsm.current instanceof DeadState });
                return;
            }
            
            if (this.backupBeepAudio && this.backupBeepLoaded) {
                try {
                    // Set volume based on current settings
                    const masterVol = this.settings.masterVolume ?? 0.7;
                    const sfxVol = this.settings.sfxVolume ?? 0.8;
                    const volume = Math.max(0, Math.min(1, masterVol * sfxVol * 0.6)); // 60% of max
                    this.backupBeepAudio.volume = volume;
                    this.backupBeepAudio.currentTime = 0;
                    console.log('[DEBUG] About to play backup beep:', {
                        src: this.backupBeepAudio.src,
                        volume: this.backupBeepAudio.volume,
                        readyState: this.backupBeepAudio.readyState,
                        paused: this.backupBeepAudio.paused,
                        ended: this.backupBeepAudio.ended
                    });
                    const playPromise = this.backupBeepAudio.play();
                    if (playPromise && typeof playPromise.catch === 'function') {
                        playPromise.catch(e => {
                            console.warn('[DEBUG] backupBeepAudio.play() rejected:', e);
                        });
                    }
                    this.backupBeepPlaying = true;
                    console.log('🎵 Backup beep started successfully!');
                } catch (e) {
                    console.warn('Failed to play backup beep:', e);
                }
            } else {
                console.log('🎵 Audio not ready:', { audioExists: !!this.backupBeepAudio, loaded: this.backupBeepLoaded });
            }
        }, this.backupBeepDelay);
    }

    stopBackupBeep() {
        console.log('🎵 stopBackupBeep called');
        
        // Clear the timeout if S key is released before 0.5 seconds
        if (this.backupBeepTimeout) {
            console.log('🎵 Clearing backup beep timeout');
            clearTimeout(this.backupBeepTimeout);
            this.backupBeepTimeout = null;
        }
        
        // Stop the audio if it's playing
        if (this.backupBeepPlaying && this.backupBeepAudio) {
            try {
                this.backupBeepAudio.pause();
                this.backupBeepAudio.currentTime = 0;
                this.backupBeepPlaying = false;
                console.log('🎵 Backup beep stopped successfully');
            } catch (e) {
                console.warn('Failed to stop backup beep:', e);
            }
        } else {
            console.log('🎵 Backup beep was not playing');
        }
    }

    // Improved playSound method with proper master volume control
    playSound(type) {
        if (!this.audioContext || !this.compressor || !this.masterGain) return;
        if (window.gameInstance && performance.now() < window.gameInstance.audioMuteUntil) return;
        
        // Check if volume is effectively zero
        const masterVol = this.settings.masterVolume ?? 0.7;
        const sfxVol = this.settings.sfxVolume ?? 0.8;
        if (masterVol <= 0 || sfxVol <= 0) return;
        
        // All sounds will connect to the compressor (which feeds to masterGain)
        const outputNode = this.compressor; 
        
        // Use normalized volume (1.0) since master volume is controlled by masterGain
        const normalizedVolume = 1.0;
        
        switch(type) {
            case 'jump': 
                return this._gentleJump(normalizedVolume * 0.4, outputNode);
            case 'dash': 
                return this._energySwoosh(normalizedVolume * 0.3, outputNode);
            case 'damage': 
                return this._softImpact(normalizedVolume * 0.25, outputNode);
            case 'land': 
                return this._gentleLanding(normalizedVolume * 0.2, outputNode);
        }
    }

    // --- SFX GENERATION METHODS ---

    _gentleJump(volume, outputNode) {
        const ctx = this.audioContext;
        const now = ctx.currentTime;
        
        // Soft ascending tone
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(300, now);
        oscillator.frequency.exponentialRampToValueAtTime(600, now + 0.15);
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(volume, now + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
        
        oscillator.connect(gainNode);
        gainNode.connect(outputNode); // Connect to compressor
        
        oscillator.start(now);
        oscillator.stop(now + 0.25);
    }

    _energySwoosh(volume, outputNode) {
        const ctx = this.audioContext;
        const now = ctx.currentTime;
        
        // Gentle whoosh with filter sweep
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        
        oscillator.type = 'sawtooth';
        oscillator.frequency.setValueAtTime(150, now);
        oscillator.frequency.exponentialRampToValueAtTime(80, now + 0.3);
        
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(800, now);
        filter.frequency.exponentialRampToValueAtTime(200, now + 0.3);
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(volume, now + 0.05);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        
        oscillator.connect(filter);
        filter.connect(gainNode);
        gainNode.connect(outputNode); // Connect to compressor
        
        oscillator.start(now);
        oscillator.stop(now + 0.4);
    }
    
    // Placeholder for damage sound, connected to compressor
    _softImpact(volume, outputNode) {
        const ctx = this.audioContext;
        const now = ctx.currentTime;
        
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();
        
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(100, now);
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(volume, now + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        
        oscillator.connect(gainNode);
        gainNode.connect(outputNode); // Connect to compressor
        
        oscillator.start(now);
        oscillator.stop(now + 0.2);
    }

    _gentleLanding(volume, outputNode) {
        const ctx = this.audioContext;
        const now = ctx.currentTime;
        
        // Layer 1: Soft impact
        const impact = ctx.createOscillator();
        const impactGain = ctx.createGain();
        impact.type = 'sine';
        impact.frequency.setValueAtTime(120, now);
        impact.frequency.exponentialRampToValueAtTime(80, now + 0.1);
        impactGain.gain.setValueAtTime(0, now);
        impactGain.gain.linearRampToValueAtTime(volume * 0.7, now + 0.01);
        impactGain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        
        // Layer 2: Subtle scrape/settle (Filtered noise)
        const scrape = ctx.createBufferSource();
        const scrapeGain = ctx.createGain();
        
        // Create gentle noise buffer
        const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) {
            // Gentle filtered noise
            data[i] = (Math.random() * 2 - 1) * 0.3;
        }
        scrape.buffer = buffer;
        scrapeGain.gain.setValueAtTime(0, now);
        scrapeGain.gain.linearRampToValueAtTime(volume * 0.3, now + 0.02);
        scrapeGain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
        
        impact.connect(impactGain);
        scrape.connect(scrapeGain);
        impactGain.connect(outputNode); // Connect to compressor
        scrapeGain.connect(outputNode); // Connect to compressor
        
        impact.start(now);
        scrape.start(now);
        impact.stop(now + 0.15);
        scrape.stop(now + 0.1);
    }
    
    // Add a method to update master volume at runtime
    updateMasterVolume(masterVol, sfxVol) {
        if (!this.audioContext || !this.masterGain) return;
        
        const combinedVolume = Math.max(0, Math.min(1, (masterVol ?? 0.7) * (sfxVol ?? 0.8)));
        
        try {
            // Update the master gain with smooth transition
            this.masterGain.gain.linearRampToValueAtTime(
                combinedVolume, 
                this.audioContext.currentTime + 0.1
            );
            
            // Update backup beep volume if playing
            if (this.backupBeepAudio && this.backupBeepPlaying) {
                const backupVolume = Math.max(0, Math.min(1, (masterVol ?? 0.7) * (sfxVol ?? 0.8) * 0.6));
                this.backupBeepAudio.volume = backupVolume;
            }

            // Update lava hurt loop volume if playing
            if (this.lavaHurtAudio && this.lavaHurtPlaying) {
                const lavaVol = Math.max(0, Math.min(1, (masterVol ?? 0.7) * (sfxVol ?? 0.8) * 0.9));
                this.lavaHurtAudio.volume = lavaVol;
            }
            
            // Update internal settings
            this.settings.masterVolume = masterVol ?? this.settings.masterVolume;
            this.settings.sfxVolume = sfxVol ?? this.settings.sfxVolume;
            
            console.log('🎵 AudioManager master volume updated:', combinedVolume);
        } catch(e) {
            console.warn('Failed to update AudioManager master volume:', e);
        }
    }
}

/* --- AmbientAudio Class --- */
class AmbientAudio {
    constructor(settings) {
        this.settings = settings;
        this.audioContext = null;
    this.ambientSources = [];
    this.lavaRumbleGainNode = null;
    this.lavaRumbleFilter = null;
        
        if (typeof AudioContext !== 'undefined') {
            try {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
                // Ambient audio disabled per request
            } catch(e) {
                console.warn('Ambient audio not supported');
            }
        }
    }
    
    _setupAmbience() {
        // Disabled
    }
    
    _createLavaRumble() { /* disabled */ }

    // Drive lava rumble based on shader time/proximity (0..1 intensity)
    setLavaIntensity(intensity) { /* disabled */ }
    
    _createWindLayer() { /* disabled */ }

    _createDistantEvents() { /* disabled */ }
}

/* --- Menu Keyboard Navigator --- */
class MenuNavigator {
    constructor(){
        this.currentMenu=null; this.focusable=[]; this.index=0;
        this._boundOnKey = e=>this.onKey(e);
        document.addEventListener('keydown', this._boundOnKey);
    }
    onKey(e){ if(!this.currentMenu) return; switch(e.code){ case 'ArrowUp': case 'KeyW': e.preventDefault(); this.move(-1); break; case 'ArrowDown': case 'KeyS': e.preventDefault(); this.move(1); break; case 'Enter': case 'Space': e.preventDefault(); this.activate(); break; } }
    setMenu(id){
        console.log(`[MenuNavigation] Setting active menu: ${id}`);
        this.currentMenu=document.getElementById(id);
        if(!this.currentMenu) {
            console.warn(`[MenuNavigation] Menu element not found: ${id}`);
            return;
        }
        this.focusable=Array.from(this.currentMenu.querySelectorAll('button:not([disabled]), input, a'));
        this.index=0;
        console.log(`[MenuNavigation] Found ${this.focusable.length} focusable elements in menu ${id}`);
        this.updateFocus();
    }
    clear(){
        console.log('[MenuNavigation] Clearing menu navigation');
        this.currentMenu=null;
        this.focusable=[];
        this.index=0;
    }
    move(d){
        if(!this.focusable.length) {
            console.warn('[MenuNavigation] No focusable elements to navigate');
            return;
        }
        this.index=(this.index + d + this.focusable.length)%this.focusable.length;
        console.log(`[MenuNavigation] Moved focus to index ${this.index} (${d > 0 ? 'down' : 'up'})`);
        this.updateFocus();
    }
    updateFocus(){
        this.focusable.forEach(el=>{
            el.style.outline='';
            el.style.transform='';
        });
        const cur=this.focusable[this.index];
        if (cur){
            cur.style.outline='3px solid #e67e22';
            cur.style.transform='scale(1.05)';
            cur.focus({preventScroll:true});
            console.log(`[MenuNavigation] Focused element: ${cur.tagName}[${cur.id || cur.className || cur.textContent?.trim()}]`);
        }
    }
    activate(){
        if(!this.focusable.length) {
            console.warn('[MenuNavigation] No focusable elements to activate');
            return;
        }
        const element = this.focusable[this.index];
        console.log(`[MenuNavigation] Activating element: ${element.tagName}[${element.id || element.className || element.textContent?.trim()}]`);
        this.focusable[this.index].click();
    }
    destroy(){
        if (this._boundOnKey){
            document.removeEventListener('keydown', this._boundOnKey);
            this._boundOnKey = null;
        }
        this.clear();
    }
}
const menuNavigator = new MenuNavigator();


/* --- Enums & Logging --- */
const STATES = { IDLE:'idle', WALK:'walk', CHARGE:'charge', LEAP:'leap', FALL:'fall', DASH:'dash', DEAD:'dead' }; // Added DASH state
const ANIM_MAP = { idle:'survey', walk:'walk', run:'run', jump:'jump', fall:'fall', dead:'survey', charge:'survey', dash:'run' }; // Added dash mapping (using run anim)
const LOG_LEVELS = { INFO:'INFO', WARN:'WARN', ERROR:'ERROR' };
const log = (lvl,msg,data='') => console.log(`[${lvl}] ${msg}`, data);

/* --- Base State Class --- */
class State { constructor(controller){ this.controller=controller; } enter(){} update(){} exit(){} }

/* --- Idle & Walk --- */
class IdleState extends State {
    enter(){ this.controller.playAnimation(ANIM_MAP.idle); }
    update(input){
        // Use wasPressed to ensure quick taps before first physics step are captured
        if (input.wasPressed('KeyQ')) {
            this.controller.performDash();
            return; // Prioritize dash
        }
        if (this.controller.canBeginCharge() && input.keys['Space']) {
            this.controller.fsm.setState(STATES.CHARGE); return;
        }
        
        const mv=this.controller.getMovementInput(input);
        
        // Check for mouse rotation movement
        let hasRotation = false;
        if (this.controller.game?.thirdPersonCamera) {
            const camera = this.controller.game.thirdPersonCamera;
            if (!this.controller._lastYaw) this.controller._lastYaw = camera.yaw || 0;
            const yawDelta = Math.abs(camera.yaw - this.controller._lastYaw);
            hasRotation = yawDelta > 0.002; // Threshold for detecting rotation
            this.controller._lastYaw = camera.yaw;
        }
        
        // Transition to walk state if there's movement OR rotation
        if (mv.lengthSq() > 0.01 || hasRotation) {
            this.controller.fsm.setState(STATES.WALK);
        }
    }
}
class WalkState extends State {
    enter(){ this.controller.playAnimation(ANIM_MAP.walk); }
    update(input){
        if (input.wasPressed('KeyQ')) {
            this.controller.performDash();
            return; // Prioritize dash
        }
        if (this.controller.canBeginCharge() && input.keys['Space']) {
            this.controller.fsm.setState(STATES.CHARGE); return;
        }
        
        const mv=this.controller.getMovementInput(input);
        
        // Check for mouse rotation movement
        let hasRotation = false;
        if (this.controller.game?.thirdPersonCamera) {
            const camera = this.controller.game.thirdPersonCamera;
            if (!this.controller._lastYaw) this.controller._lastYaw = camera.yaw || 0;
            const yawDelta = Math.abs(camera.yaw - this.controller._lastYaw);
            hasRotation = yawDelta > 0.002; // Threshold for detecting rotation
            this.controller._lastYaw = camera.yaw;
        }
        
        // Consider player as moving if there's keyboard input OR mouse rotation
        const isMoving = mv.lengthSq() > 0.01 || hasRotation;
        
        if (!isMoving) {
            this.controller.fsm.setState(STATES.IDLE);
        } else if (this.controller.isSprinting(input)) {
            // Run animation; reverse if moving backward
            const fwd = (input.keys['KeyW']?1:0) + (input.keys['KeyS']?-1:0);
            const sign = Math.sign(fwd) || 1; // default forward on rotation only
            const runScale = (CONFIG?.sprintMultiplier ?? CONFIG?.player?.sprintMultiplier ?? 1);
            this.controller.playAnimation(ANIM_MAP.run, sign * runScale);
        } else {
            // Walk animation; reverse if moving backward, forward for rotation only
            const fwd = (input.keys['KeyW']?1:0) + (input.keys['KeyS']?-1:0);
            const sign = Math.sign(fwd) || 1; // default forward for rotation
            this.controller.playAnimation(ANIM_MAP.walk, sign * 1);
        }
    }
}

/* ---  Charge State --- */
class ChargeState extends State {
    // New properties to manage state and ground check
    previousState = null;
    startedGrounded = false;
    
    enter(previousState){
        this.previousState = previousState;
        this.startedGrounded = this.controller.isGrounded;
        
        this.controller.playAnimation(ANIM_MAP.charge, 0.8);
        this.chargeTime = 0;
        this.energyConsumed = 0;
        this.startEnergy = this.controller.sprint; // snapshot
        this.maxPossibleEnergy = Math.min(
            this.startEnergy,
            CONFIG.chargeLeap.staminaDrainPerSecond * CONFIG.chargeLeap.maxChargeTime
        );
        this.controller.uiManager?.setChargePreview(0);
        GameLogger.charge('Charge started.');
    }
    update(input, dt){
            // ------------------------------------------------------------------
            // CANCELLATION LOGIC: Check if player leaves the ground while charging
            // ------------------------------------------------------------------
            // FIX: Add a check for coyoteTime. Only cancel if truly airborne.
            if (this.startedGrounded && !this.controller.isGrounded && this.controller.coyoteTime <= 0) {
                console.log("Charge canceled: Player left the ground after coyote time.");
                // FIXED: Refund consumed energy when canceling
                if (this.energyConsumed > 0) {
                    const refund = this.energyConsumed;
                    this.controller.sprint = Math.min(
                        CONFIG.player.maxSprint,
                        this.controller.sprint + refund
                    );
                    this.controller.uiManager?.updateSprint(
                        this.controller.sprint, 
                        CONFIG.player.maxSprint
                    );
                    GameLogger.charge(`Charge canceled - refunded ${refund.toFixed(1)} energy`);
                }
                this.controller.fsm.setState(STATES.FALL); 
                return; // Exit update early
            }
            // ------------------------------------------------------------------

            // Play walk animation while charging
            if (input.keys['Space']) {
                // If S is also held, play inverse walk
                const sign = input.keys['KeyS'] ? -1 : 1;
                this.controller.playAnimation(ANIM_MAP.walk, sign);
            }

            // Abort if left the valid window (fell off ground early and no coyote)
            if (!input.keys['Space']) {
                this.launch(); return;
            }
            if (!this.controller.isGrounded && this.controller.coyoteTime <= 0 && this.chargeTime === 0) {
                // If they pressed in air and never validly started, cancel
                GameLogger.charge('Charge cancelled (not grounded).');
                // FIXED: Refund energy on invalid charge attempt
                if (this.energyConsumed > 0) {
                    this.controller.sprint = Math.min(
                        CONFIG.player.maxSprint,
                        this.controller.sprint + this.energyConsumed
                    );
                    this.controller.uiManager?.updateSprint(
                        this.controller.sprint, 
                        CONFIG.player.maxSprint
                    );
                }
                this.controller.uiManager?.setChargePreview(0);
                this.controller.fsm.setState(STATES.FALL); return;
            }

            // Drain energy while holding
            if (this.chargeTime < CONFIG.chargeLeap.maxChargeTime && this.controller.sprint > 0) {
                const drain = CONFIG.chargeLeap.staminaDrainPerSecond * dt;
                const actual = Math.min(drain, this.controller.sprint);
                this.controller.consumeStamina(actual);
                this.energyConsumed += actual;
                this.chargeTime += dt;
            }

            // Update preview percent
            const percent = this.maxPossibleEnergy > 0 ? (this.energyConsumed / this.maxPossibleEnergy) : 0;
            this.controller.uiManager?.setChargePreview(percent);

            // Auto launch if out of energy or time
            if (this.controller.sprint <= 0 || this.chargeTime >= CONFIG.chargeLeap.maxChargeTime) {
                this.launch(); return;
            }
        }

    launch(){
        const jumpPosition = this.controller.model.position.clone();
        jumpPosition.y -= CONFIG.player.height; // Emit from feet
        
        // Check if the press was a quick tap
        if (this.chargeTime < CONFIG.quickJump.tapThreshold) {
            // First, refund the tiny amount of energy that was consumed while charging for a split second.
            this.controller.sprint = Math.min(
                CONFIG.player.maxSprint,
                this.controller.sprint + this.energyConsumed
            );

            // check if there's enough energy for the quick jump.
            if (this.controller.sprint >= CONFIG.quickJump.cost) {
                GameLogger.action('Quick Jump performed.');
                this.controller.consumeStamina(CONFIG.quickJump.cost);
                const currentVel = this.controller.body.linvel();
                const jumpForce = CONFIG.quickJump.verticalForce;
                // If on a falling platform, apply reaction impulse and make jump relative to platform velocity
                if (this.controller.onFallingPlatform && this.controller.fallingPlatformBody) {
                    try {
                        const platformVel = this.controller.fallingPlatformBody.linvel();
                        const platformMass = this.controller.fallingPlatformBody.mass?.() || 1000;
                        const playerMass = CONFIG.player.mass;
                        const reaction = (jumpForce * playerMass) / platformMass;
                        this.controller.fallingPlatformBody.applyImpulse({ x:0, y:-reaction*0.5, z:0 }, true);
                        this.controller.body.setLinvel({ x: currentVel.x, y: platformVel.y + jumpForce, z: currentVel.z }, true);
                    } catch(e) {
                        // Fallback normal quick jump
                        this.controller.body.setLinvel({ x: currentVel.x, y: jumpForce, z: currentVel.z }, true);
                    }
                } else {
                    // Normal quick jump
                    this.controller.body.setLinvel({ x: currentVel.x, y: jumpForce, z: currentVel.z }, true);
                }
                this.controller.game.audioManager?.playSound('jump');
                this.controller.game.particleSystem?.emit({
                    position: jumpPosition,
                    count: 20, color: new THREE.Color(0xeeeeee), speed: 3, lifetime: 0.8,
                    spread: new THREE.Vector3(2, 0.5, 2), startScale: 0.4, endScale: 0.05,
                });
                this.controller.fsm.setState(STATES.LEAP);
            } else {
                GameLogger.charge('Quick jump failed (not enough energy).');
                this.controller.uiManager?.showEnergyInsufficient('Quick Jump');
                // Not enough energy for a quick jump, so do nothing.
                this.controller.uiManager?.updateSprint(this.controller.sprint, CONFIG.player.maxSprint);
                this.controller.fsm.setState(this.controller.isGrounded ? STATES.IDLE : STATES.FALL);
            }
            return; // Exit here since we've handled the tap.
        }


        // If the player held for a bit but not enough to meet the minimum charge, refund and cancel.
        if (this.energyConsumed > 0 && this.energyConsumed < CONFIG.chargeLeap.minChargeEnergy) {
            GameLogger.charge('Charge fizzled (not held long enough). Refunding energy.');
            this.controller.sprint = Math.min(
                CONFIG.player.maxSprint,
                this.controller.sprint + this.energyConsumed
            );
            this.controller.uiManager?.updateSprint(this.controller.sprint, CONFIG.player.maxSprint);
            this.controller.fsm.setState(STATES.IDLE);
            return;
        }

        const pct = this.maxPossibleEnergy > 0
            ? Math.min(1, this.energyConsumed / this.maxPossibleEnergy)
            : 0;

        const vMin=CONFIG.chargeLeap.minVertical, vMax=CONFIG.chargeLeap.maxVertical;
        const hMin=CONFIG.chargeLeap.minForward, hMax=CONFIG.chargeLeap.maxForward;
        const vY = vMin + (vMax - vMin) * pct;
        const hF = hMin + (hMax - hMin) * pct;

        // Direction - Optimized to only get camera direction when needed.
        const { chargeCamDir, chargeFlatDir } = this.controller._reusable;
        let dir;
        if (CONFIG.chargeLeap.horizontalMultiplierUsesCamera) {
            this.controller.game.camera.getWorldDirection(chargeCamDir);
            dir = chargeFlatDir.set(chargeCamDir.x, 0, chargeCamDir.z).normalize();
        } else {
            // Use model facing instead
            dir = new THREE.Vector3(0,0,1).applyQuaternion(this.controller.model.quaternion).normalize();
        }

        GameLogger.charge(`Leap launched! Power: ${(pct * 100).toFixed(0)}%`, { vertical: vY.toFixed(2), horizontal: hF.toFixed(2) });

        const currentVel = this.controller.body.linvel();
        if (this.controller.onFallingPlatform && this.controller.fallingPlatformBody) {
            try {
                const platformVel = this.controller.fallingPlatformBody.linvel();
                const platformMass = this.controller.fallingPlatformBody.mass?.() || 1000;
                const playerMass = CONFIG.player.mass;
                const reaction = (vY * playerMass) / platformMass;
                // Apply some opposite impulse including a fraction of horizontal
                this.controller.fallingPlatformBody.applyImpulse({ x: -dir.x * hF * 0.3, y: -reaction*0.5, z: -dir.z * hF * 0.3 }, true);
                // Set player velocity relative to platform
                this.controller.body.setLinvel({ x: currentVel.x + dir.x * hF, y: platformVel.y + vY, z: currentVel.z + dir.z * hF }, true);
            } catch(e) {
                // Fallback to normal
                this.controller.body.setLinvel({ x: currentVel.x + dir.x * hF, y: vY, z: currentVel.z + dir.z * hF }, true);
            }
        } else {
            this.controller.body.setLinvel({ x: currentVel.x + dir.x * hF, y: vY, z: currentVel.z + dir.z * hF }, true);
        }
        this.controller.game.audioManager?.playSound('jump');

        this.controller.game.particleSystem?.emit({
            position: jumpPosition,
            count: 20 + Math.floor(pct * 30), // More particles for bigger jumps
            color: new THREE.Color(0xffaa55), speed: 4, lifetime: 1.0,
            spread: new THREE.Vector3(2.5, 0.5, 2.5), startScale: 0.5, endScale: 0.05,
        });

        this.controller.uiManager?.setChargePreview(0);
        this.controller.fsm.setState(STATES.LEAP);
    }

    exit(){
        this.controller.uiManager?.setChargePreview(0);
    }
}

/* ---  Leap (ascending / midair after launch) --- */
class LeapState extends State {
    enter(){ this.controller.playAnimation(ANIM_MAP.jump, 1.2); } // UPDATED ANIMATION
    update(input, dt){
        if (input.wasPressed('KeyQ')) {
            this.controller.performDash();
            return; // Prevent fall check same frame
        }
        if (this.controller.body.linvel().y < 0) {
            this.controller.fsm.setState(STATES.FALL);
        }
    }
}

/* --- Fall State --- */
/* --- Fall State --- */
class FallState extends State {
    // Intentionally using the 'run' animation mid-air for a stylized flailing effect during descent
    enter(){ this.controller.playAnimation(ANIM_MAP.fall, 1.0); }
    update(input, dt){
        if (input.wasPressed('KeyQ')) {
            this.controller.performDash();
            return;
        }
        // Add small stability delay to avoid state thrashing on flicker contact
        // FIXED: Use epsilon for float comparison
        const groundTimeThreshold = 0.05;
        if (this.controller.isGrounded && 
            this.controller.groundTime > (groundTimeThreshold - FLOAT_EPSILON)){
            // Determine platform color for dust
            let platformColor = new THREE.Color(0x888888); // default gray
            const seg = this.controller.currentGroundSegment;
            if (seg?.threeMeshes?.[0]){
                const platformMesh = seg.threeMeshes[0];
                const mat = platformMesh.material;
                if (mat?.color){
                    platformColor = mat.color.clone();
                    // Lighten slightly for visibility
                    platformColor.r = Math.min(1, platformColor.r * 1.5);
                    platformColor.g = Math.min(1, platformColor.g * 1.5);
                    platformColor.b = Math.min(1, platformColor.b * 1.5);
                }
            }

            // Landing dust particles with platform color
            const landPosition = this.controller.model.position.clone();
            landPosition.y -= CONFIG.player.height;
            this.controller.game.particleSystem?.emit({
                position: landPosition,
                count: 25,
                color: platformColor,
                speed: 2,
                lifetime: 1.2,
                spread: new THREE.Vector3(4, 1, 4),
                startScale: 0.2,
                endScale: 0.01,
                dustEffect: true
            });

            const mv=this.controller.getMovementInput(this.controller.inputManager);
            this.controller.fsm.setState(mv.lengthSq()>0.01 ? STATES.WALK : STATES.IDLE);
        }
    }
}


/* ---  Dash State (tank-style, model-forward) --- */
class DashState extends State {
    enter(prevState, params = {}) {
        this.controller.playAnimation(ANIM_MAP.dash, 1.5);
        this.dashTimer = 0;
        this.dashDuration = 0.2;
        const used = Math.max(
            CONFIG.gameplay.minDashEnergy,
            Math.min(params.staminaUsed ?? CONFIG.gameplay.minDashEnergy, CONFIG.player.maxSprint)
        );
        this.staminaUsed = used;
        this._executeDash();
    }
    _executeDash() {
        const { forceMultiplier, downwardVelocityCap } = CONFIG.airDash;
        const input = this.controller.inputManager;
        const force = this.staminaUsed * forceMultiplier;
        const forwardDir = new THREE.Vector3(0,0,1).applyQuaternion(this.controller.model.quaternion).normalize();
        // Backward dash if ONLY S is held
        let dashDirection = forwardDir.clone();
        if (input.keys['KeyS'] && !input.keys['KeyW']) dashDirection.multiplyScalar(-1);
        const currentVel = this.controller.body.linvel();
        this.controller.body.setLinvel({
            x: dashDirection.x * force,
            y: this.controller.isGrounded ? 0 : Math.max(currentVel.y, downwardVelocityCap),
            z: dashDirection.z * force
        }, true);
        this.controller.game.triggerDashEffect(force);
        logger?.logInput('dash_executed', {
            direction: { x: dashDirection.x.toFixed(2), z: dashDirection.z.toFixed(2) },
            wasGrounded: this.controller.isGrounded,
            inputUsed: true,
            staminaUsed: this.staminaUsed,
            force: force.toFixed(2)
        });
    }
    update(input, dt) {
        this.dashTimer += dt;
        this.controller.game.particleSystem?.emit({
            position: this.controller.model.position,
            count: 3,
            color: new THREE.Color(0x55c8ff),
            speed: 0.1,
            lifetime: 0.4,
            spread: new THREE.Vector3(0.5, 0.5, 0.5),
            startScale: 0.2,
            endScale: 0.01,
        });
        if (this.dashTimer >= this.dashDuration) {
            if (!this.controller.isGrounded) {
                if (this.controller.body.linvel().y > 0) this.controller.fsm.setState(STATES.LEAP, 'dash_complete_ascending');
                else this.controller.fsm.setState(STATES.FALL, 'dash_complete_falling');
            } else {
                // Decide between walk/idle based on current move key (W/S) being held
                if (this.controller.inputManager.keys['KeyW'] || this.controller.inputManager.keys['KeyS']) this.controller.fsm.setState(STATES.WALK, 'dash_complete_move');
                else this.controller.fsm.setState(STATES.IDLE, 'dash_complete_idle');
            }
        }
    }
    exit() { /* end dash effects */ }
}

/* --- Dead State --- */
class DeadState extends State {
    enter(){
        //  let physics handle the fall
        
        if (this.controller.model){
            this.controller.model.rotation.set(0,0,0);
            this.controller.model.rotateZ(Math.PI/2); // Tip over
        }
        this.controller.currentAnimation?.clip?.stop?.();
        
        // Store death start time for smooth interpolation
        this.deathStartTime = performance.now();
        this.deathStartY = this.controller.model?.position.y || 0;
        
        if (window.menuManager && window.menuManager.currentLevel){
            const score = this.controller.game.score;
            if (score>0) saveManager.saveLevelScore(window.menuManager.currentLevel.id, score);
        }
    }
    update(input, dt){ 
        // Let the body continue falling naturally with physics
        // The render loop will smoothly interpolate the visual position
    }
}
/* --- FSM --- */
class EnhancedFSM {
    constructor(controller, logManager){
        this.controller = controller;
        this.logger = logManager || null;
        this._states = {};
        this._current = null;
        this._stateHistory = [];
        this._maxHistory = 10;
        this._currentKey = null; // track enum/state key (e.g., 'idle')
        // Key-based transition table (enum keys, not class names)
        this._validTransitions = {
            [STATES.IDLE]:   [STATES.WALK, STATES.CHARGE, STATES.FALL, STATES.DASH, STATES.DEAD],
            [STATES.WALK]:   [STATES.IDLE, STATES.CHARGE, STATES.FALL, STATES.DASH, STATES.DEAD],
            [STATES.CHARGE]: [STATES.LEAP, STATES.IDLE, STATES.FALL, STATES.DEAD],
            [STATES.LEAP]:   [STATES.FALL, STATES.DASH, STATES.IDLE, STATES.DEAD],
            [STATES.FALL]:   [STATES.IDLE, STATES.WALK, STATES.DASH, STATES.DEAD],
            [STATES.DASH]:   [STATES.IDLE, STATES.WALK, STATES.LEAP, STATES.FALL, STATES.DEAD],
            [STATES.DEAD]:   [STATES.IDLE]
        };
    }
    addState(name, cls){ this._states[name] = cls; }
    setState(name, params = {}){
        const stateClass = this._states[name];
        if (!stateClass){
            this.logger?.logError('FSM', new Error(`Invalid state key: ${name}`));
            return false;
        }
        if (this._currentKey === name) return false;
        let reason = '';
        if (typeof params === 'string'){ reason = params; params = { reason }; }
        else if (params && typeof params === 'object'){ reason = params.reason || ''; }
        if (!this._canTransitionKey(this._currentKey, name)){
            const prevLabel = this._currentKey || 'null';
            this.logger?.logError('FSM', new Error(`Invalid transition: ${prevLabel} -> ${name} (reason: ${reason})`));
            return false;
        }
        try {
            const prevKey = this._currentKey;
            // Capture context before transition
            const context = {
                prevState: prevKey,
                newState: name,
                reason: reason || 'none',
                isGrounded: !!this.controller.isGrounded,
                energy: typeof this.controller.sprint === 'number' ? this.controller.sprint.toFixed(1) : undefined,
                health: typeof this.controller.health === 'number' ? this.controller.health.toFixed(1) : undefined
            };
            try {
                const vel = this.controller.body?.linvel?.();
                if (vel) context.velocity = { y: vel.y.toFixed(2), horizontal: Math.hypot(vel.x, vel.z).toFixed(2) };
            } catch {}
            this._current?.exit();
            this._current = new stateClass(this.controller);
            this._currentKey = name;
            // Pass params object to new state's enter if it accepts it
            try { this._current.enter(prevKey, params); }
            catch { this._current.enter(prevKey); }
            GameLogger.fsm(`${prevKey || 'null'} -> ${name}${reason ? ` (${reason})` : ''}`, context);
            this._stateHistory.push({ state:name, timestamp:performance.now(), reason, context });
            if (this._stateHistory.length > this._maxHistory) this._stateHistory.shift();
            return true;
        } catch(error){
            this.logger?.logError('FSM Transition', error);
            this._recoverToSafeState();
            return false;
        }
    }
    _canTransitionKey(fromKey, toKey){
        if (!fromKey) return true; // initial transition allowed
        const allowed = this._validTransitions[fromKey] || [];
        return allowed.includes(toKey);
    }
    _recoverToSafeState(){
        try {
            // Clean up previous state resources
            if (this._current) {
                try { this._current.exit(); } catch(e) { console.warn('Error exiting previous state:', e); }
            }
            
            if (this._states[STATES.IDLE]) {
                this._current = new this._states[STATES.IDLE](this.controller);
                this._currentKey = STATES.IDLE;
                this._current.enter(null);
                this.logger?.logError('FSM Recovery', new Error('Recovered to idle state'));
            }
        } catch(error){ this.logger?.logError('FSM Recovery Failed', error); }
    }
    update(dt, input){
        try { this._current?.update(input, dt); } catch(error){ this.logger?.logError('FSM Update', error); }
    }
    get current(){ return this._current; }
    getStateHistory(){ return this._stateHistory; }
}

/* --- Character Controller --- */
class CharacterController {
    constructor(scene, world, rapier, debug, inputManager, uiManager, game){
        this.scene=scene; this.world=world; this.rapier=rapier; this.debug=debug;
        this.inputManager=inputManager; this.uiManager=uiManager; this.game=game;
        this.model=null; this.mixer=null; this.animations={}; this.body=null;
        this.isGrounded=false; this.coyoteTime=0; this.groundTime=0;
        this.prevTranslation=new THREE.Vector3();
        this.currentTranslation=new THREE.Vector3();
        this.cfg = game?.cfg || CONFIG; 
        this.health=this.cfg.player.maxHealth;
        this.sprint=this.cfg.player.maxSprint;
        this.sprintRegenTimer=0;

        this._reusable={
            moveDir:new THREE.Vector3(), targetVel:new THREE.Vector3(), currentXZ:new THREE.Vector3(),
            camWorldDir:new THREE.Vector3(), flatCamDir:new THREE.Vector3(),
            moveQuat:new THREE.Quaternion(), modelQuat:new THREE.Quaternion(),
            forward:new THREE.Vector3(0,0,-1), rotationAxis:new THREE.Vector3(0,1,0),
            airControl:new THREE.Vector3(),
            // Reusable vectors for ChargeState.launch() to avoid GC
            chargeCamDir: new THREE.Vector3(),
            chargeFlatDir: new THREE.Vector3(),
        };
    // Energy logging/coalescing state to avoid spam
    this._consumingActive = false; // true while input-driven consumption is ongoing
    this._consumptionAccumulator = 0; // total consumed during current hold
    this._consumptionStartValue = 0;

    this._regenActive = false; // true while regeneration is actively restoring energy
    this._regenAccumulator = 0; // total regained during current regen window
    this._regenStartValue = 0;
        // Centralized per-frame camera directions (computed once per fixedUpdate)
        this.frameCamDir = new THREE.Vector3();      // full world direction
        this.frameFlatCamDir = new THREE.Vector3();  // flattened & normalized
        this._groundCheckShape = new rapier.Capsule(this.cfg.player.height, this.cfg.player.radius);
        this._setupFSM();
        // Platform effect state (spiral tower)
        this.activeSpeedMods = [];
        this.currentSpeedMultiplier = 1.0;
        this.currentGroundSegment = null; // Track which platform we're on
        // Falling platform interaction
        this.onFallingPlatform = false;
        this.fallingPlatformBody = null;
        
        // Respawn synchronization flag
        this._respawnInProgress = false;
        
        // Animation state tracking for duplicate prevention
        this._animationsReady = false;

        // Visual effect state
        this._isCharred = false;           // True when lava char effect applied
        this._sharedCharMaterial = null;   // Lazily created shared black material
    }

    async loadModel(){
        const loader=new GLTFLoader();
        const url='https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Models/master/2.0/Fox/glTF-Binary/Fox.glb';
        
        try {
            const gltf=await loader.loadAsync(url);
            this.model=gltf.scene;
            this.model.scale.setScalar(0.025);

            this.model.traverse(m=>{
                if (m.isMesh){
                    m.castShadow=true;
                }
            });

            this.scene.add(this.model);
            this.mixer=new THREE.AnimationMixer(this.model);
            
            // FIXED: Track loading state
            this._animationsReady = false;
            
            gltf.animations.forEach(a=>{
                const n=a.name.toLowerCase();
                if (['walk','run','survey','jump','fall'].includes(n))
                    this.animations[n]={ clip:this.mixer.clipAction(a), name:n };
            });
            
            // Fallbacks
            if (!this.animations['jump']) this.animations['jump']=this.animations['run']||this.animations['survey']||this.animations['walk'];
            if (!this.animations['fall']) this.animations['fall']=this.animations['run']||this.animations['survey']||this.animations['walk'];

            // FIXED: Verify animations are properly loaded before marking as ready
            const requiredAnims = ['walk', 'run', 'survey', 'jump', 'fall'];
            const loadedAnims = requiredAnims.filter(name => this.animations[name] && this.animations[name].clip);
            if (loadedAnims.length === 0) {
                throw new Error('No animations could be loaded from the model');
            }
            
            // FIXED: Mark animations as ready only after verification
            this._animationsReady = true;
            GameLogger.lifecycle(`Character animations loaded successfully (${loadedAnims.length}/${requiredAnims.length} required animations)`);
            
            this.fsm.setState(STATES.IDLE);
            
        } catch(error) {
            // FIXED: Handle loading failures gracefully
            reportError('model_load', 'Failed to load character model', error);
            this._animationsReady = false;
            throw error; // Re-throw so init() can handle
        }
    }

    createPhysicsBody(){
        const start={x:0,y:5,z:0};
        const bodyDesc=this.rapier.RigidBodyDesc.dynamic()
            .setTranslation(start.x,start.y,start.z)
            .setCanSleep(false);
        this.body=this.world.createRigidBody(bodyDesc);
        const colliderDesc=this.rapier.ColliderDesc.capsule(CONFIG.player.height, CONFIG.player.radius)
            .setMass(CONFIG.player.mass)
            .setFriction(0);
        this.world.createCollider(colliderDesc, this.body);
        this.body.lockRotations(true,true);
        this.currentTranslation.set(start.x,start.y,start.z);
        this.prevTranslation.copy(this.currentTranslation);
        this.debug?.addCollider(this.body.collider(0), this.model);
    }

    _setupFSM(){
        this.fsm=new EnhancedFSM(this, logger);
        // Register using enum keys for consistency
        this.fsm.addState(STATES.IDLE, IdleState);
        this.fsm.addState(STATES.WALK, WalkState);
        this.fsm.addState(STATES.CHARGE, ChargeState);
        this.fsm.addState(STATES.LEAP, LeapState);
        this.fsm.addState(STATES.FALL, FallState);
        this.fsm.addState(STATES.DASH, DashState);
        this.fsm.addState(STATES.DEAD, DeadState);
    }

    playAnimation(name, speed=1){
        try {
            // Guard: wait until animations are ready
            if (!this._animationsReady) {
                GameLogger.player('Animation playback skipped - animations not ready yet');
                return;
            }
            
            // Prevent animation changes during death or respawn
            if (this._respawnInProgress || this.fsm.current instanceof DeadState) {
                return;
            }

            const anim = this.animations[name];
            if (!anim) { GameLogger.player(`Animation '${name}' not found`); return; }
            
            // Skip if already playing the exact same animation with same speed (within epsilon)
            if (this.currentAnimation?.name === name) {
                const action = this.currentAnimation.clip;
                const currentSpeed = action?.timeScale ?? 1;
                const speedDiff = Math.abs(currentSpeed - speed);
                
                // If speed difference is negligible, skip the update
                if (speedDiff < 0.01) {
                    return;
                }
            }

            // Continue current animation with updated speed (including reverse)
            if (this.currentAnimation?.name === name){
                const action = this.currentAnimation.clip;
                const prevSign = Math.sign(action.timeScale);
                const nextSign = Math.sign(speed);
                if (prevSign !== nextSign && speed < 0) {
                    // On reverse, jump to the end so it immediately runs backward
                    let dur = 1;
                    try {
                        if (typeof action.getClip === 'function') dur = action.getClip().duration ?? 1;
                        else if (action._clip && typeof action._clip.duration === 'number') dur = action._clip.duration;
                    } catch {}
                    action.time = Math.max(0, dur - 0.001);
                } else if (prevSign !== nextSign && speed > 0) {
                    // On switching back to forward, jump to the start
                    action.time = 0.001;
                }
                action.timeScale = speed;
                action.enabled = true;
                if (typeof action.setLoop === 'function') action.setLoop(THREE.LoopRepeat, Infinity);
                // Normalize weight handling across three versions
                if ('setEffectiveWeight' in action) action.setEffectiveWeight(1);
                if ('weight' in action) action.weight = 1;
                action.paused = false;
                if (typeof action.play === 'function') action.play();
                return;
            }

            // Switch to a new animation action
            const prev = this.currentAnimation;
            
            // CRITICAL FIX: Stop all actions before starting new one to prevent overlaps
            if (this.mixer) {
                try {
                    this.mixer.stopAllAction();
                } catch (e) {
                    reportError('animation', 'Failed to stop all actions', e);
                }
            }
            
            this.currentAnimation = anim;
            const action = anim.clip;

            action.enabled = true;
            if (typeof action.setLoop === 'function') action.setLoop(THREE.LoopRepeat, Infinity);
            if ('setEffectiveWeight' in action) action.setEffectiveWeight(1);
            if ('weight' in action) action.weight = 1;

            action.timeScale = speed;
            if (speed < 0) {
                // Start near the end for immediate reverse motion
                action.reset();
                let dur = 1;
                try {
                    if (typeof action.getClip === 'function') dur = action.getClip().duration ?? 1;
                    else if (action._clip && typeof action._clip.duration === 'number') dur = action._clip.duration;
                } catch {}
                action.time = Math.max(0, dur - 0.001);
                action.play();
            } else {
                action.reset().play();
            }

            // Use warp=true for smoother cross-fade time scaling
            if (prev && prev.clip !== action) prev.clip.crossFadeTo(action, CONFIG.animation.crossFadeDuration, true);
        } catch (e) {
            reportError('animation_play', 'Failed to play animation', e, { oncePerKey: 'animation_play' });
        }
    }

    getMovementInput(input){
        const { moveDir }=this._reusable;
        let x=0,z=0;
        if (input.keys['KeyW']) z-=1;
        if (input.keys['KeyS']) z+=1;
        //if (input.keys['KeyA']) x-=1;
        //if (input.keys['KeyD']) x+=1;
        if (!x && !z) return moveDir.set(0,0,0);
        return moveDir.set(x,0,z).normalize();
    }

    isSprinting(input){ return !!input.keys['ShiftLeft']; } // infinite

    consumeStamina(amount){
        const before = this.sprint;
        this.sprint = Math.max(0, this.sprint - amount);
        this.sprintRegenTimer = 0;
        this.uiManager?.updateSprint(this.sprint, CONFIG.player.maxSprint);

        // Determine reason for consumption (best-effort)
        let reason = 'other';
        try {
            if (this.inputManager?.keys['ShiftLeft']) reason = 'sprint';
            else if (this.fsm?.current && this.fsm.current.constructor && this.fsm.current.constructor.name === 'ChargeState') reason = 'charge';
        } catch {}

        // Coalesce frequent consume calls: log only at start of input-driven consumption
        try {
            if (!this._consumingActive) {
                this._consumingActive = true;
                this._consumptionAccumulator = 0;
                this._consumptionStartValue = before;
                GameLogger.player(`Energy consumption started: ${before.toFixed(1)}`, { reason });
            }
            this._consumptionAccumulator += (before - this.sprint);
        } catch {}
    }

    addSpeedModifier(multiplier, duration){
        if (!isFinite(multiplier) || multiplier<=0) return;
        this.activeSpeedMods.push({ multiplier, timeLeft: duration });
    }
    _updateSpeedModifiers(dt){
        if (!this.activeSpeedMods.length){ this.currentSpeedMultiplier=1; return; }
        let total=1; for (const mod of this.activeSpeedMods){ mod.timeLeft -= dt; if (mod.timeLeft>0){ total*=mod.multiplier; } }
        this.activeSpeedMods = this.activeSpeedMods.filter(m=>m.timeLeft>0);
        // Clamp runaway stacking
        this.currentSpeedMultiplier = Math.min(5, total);
    }
    restoreDashEnergy(amount){
        const before=this.sprint; this.sprint=Math.min(CONFIG.player.maxSprint, this.sprint + amount); if (this.sprint!==before) this.uiManager?.updateSprint(this.sprint, CONFIG.player.maxSprint);
    }
    applyBounceImpulse(vec){
        if (!this.body) return; const vel=this.body.linvel(); if (vel.y < vec.y){ this.body.setLinvel({ x:vel.x, y:vec.y, z:vel.z }, true); }
    }
    addExternalVelocity(vec){ if (!this.body) return; const vel=this.body.linvel(); this.body.setLinvel({ x:vel.x + vec.x, y:vel.y, z:vel.z + vec.z }, true); }
    applyLateralForce(fx,fz,dt){ if (!this.body) return; const vel=this.body.linvel(); this.body.setLinvel({ x:vel.x + fx*dt, y:vel.y, z:vel.z + fz*dt }, true); }

    _finalizeConsumptionLog() {
        if (!this._consumingActive) return;
        const endVal = this.sprint;
        try {
            GameLogger.player(`Energy consumption ended: ${this._consumptionStartValue.toFixed(1)} -> ${endVal.toFixed(1)} (-${this._consumptionAccumulator.toFixed(1)})`);
        } catch {}
        this._consumingActive = false;
        this._consumptionAccumulator = 0;
    }

    _isActuallyConsuming() {
        const sprintKey = this.inputManager?.keys['ShiftLeft'];
        const inCharge = this.fsm?.current instanceof ChargeState;
        return !!sprintKey || !!inCharge;
    }

    updateSprint(dt){
        // ONLY regenerate when grounded
        if (this.isGrounded) {
            this.sprintRegenTimer += dt;
            if (this.sprintRegenTimer >= CONFIG.player.sprintRegenDelay){
                const before = this.sprint;
                const added = Math.min(
                    CONFIG.player.maxSprint - this.sprint,
                    CONFIG.player.sprintRegenRate * dt
                );
                this.sprint = Math.min(CONFIG.player.maxSprint, this.sprint + added);
                if (this.sprint !== before) {
                    this.uiManager?.updateSprint(this.sprint, CONFIG.player.maxSprint);
                    try {
                        // Start coalescing regen logging
                        if (!this._regenActive) {
                            this._regenActive = true;
                            this._regenAccumulator = 0;
                            this._regenStartValue = before;
                            GameLogger.player(`Energy regen started: ${before.toFixed(1)}`);
                        }
                        this._regenAccumulator += (this.sprint - before);
                    } catch {}
                }
            }
        } else {
            // If we were regenerating but left grounded, finalize regen log
            if (this._regenActive) {
                try {
                    const endVal = this.sprint;
                    GameLogger.player(`Energy regen ended: ${this._regenStartValue.toFixed(1)} -> ${endVal.toFixed(1)} (+${this._regenAccumulator.toFixed(1)})`);
                } catch {}
                this._regenActive = false;
                this._regenAccumulator = 0;
            }
        }
        // No else block needed - simply don't regenerate when airborne
    }

    takeDamage(amount){
        if (this.fsm.current instanceof DeadState) return;
        this.health=Math.max(0, this.health - amount);
        this.uiManager?.updateHealth(this.health, CONFIG.player.maxHealth);
        this.game.audioManager?.playSound('damage');
        GameLogger.player(`Took damage: ${amount}, new health: ${this.health}`);
        // Medium splatter on non-lethal damage
        if (this.health > 0 && this.game?.particleSystem && this.model && this.game.settings.particles){
            const splatPos = this.model.position.clone();
            splatPos.y -= CONFIG.player.height * 0.2;
            this.game.particleSystem.emitKetchup(splatPos, 'medium');
        }
        if (this.health<=0) this.die('damage');
    }

    die(reason = 'unknown'){
        // Stop run timer first
        this.game.stopTimer?.();
        GameLogger.death(`Player died. Reason: ${reason}`);
        // Ensure backup beep is stopped immediately on death
        try { this.game?.audioManager?.stopBackupBeep?.(); } catch {}
        
        // Heavy splatter on death
        if (this.game?.particleSystem && this.model && this.game.settings.particles){
            const splatPos = this.model.position.clone();
            splatPos.y -= CONFIG.player.height * 0.2;
            this.game.particleSystem.emitKetchup(splatPos, 'heavy');
        }
        
        // Present final score + time immediately
        const formattedTime = this.game._formatTime ? this.game._formatTime(this.game.elapsedTime) : '00:00.000';
        this.uiManager?.showGameOver(this.game.score, formattedTime);
        
        // Add slight damping for smoother death fall
        if (this.body) {
            this.body.setLinearDamping(0.3); // Gentle air resistance
            this.body.setAngularDamping(2.0); // Prevent spinning
        }
        
        this.fsm.setState(STATES.DEAD);
    }

    teleportTo(position) {
        this.body.setTranslation(position, true);
        this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        this.currentTranslation.set(position.x, position.y, position.z);
        this.prevTranslation.copy(this.currentTranslation);
        this.fsm.setState(STATES.IDLE); // Reset state to idle after teleport
        if (this.game?.thirdPersonCamera?.forceSnap) this.game.thirdPersonCamera.forceSnap();
    }

    respawn() {
        // Prevent multiple simultaneous respawns
        if (this._respawnInProgress) {
            console.warn('Respawn already in progress, ignoring duplicate call');
            return;
        }
        this._respawnInProgress = true;
        
        GameLogger.lifecycle('Player respawning.');
        this.uiManager?.hideGameOver();

    // Ensure any looping lava hurt audio is stopped on respawn
    try { this.game?.audioManager?.stopLavaHurtLoop?.(); } catch(e) { try { this.audioManager?.stopLavaHurtLoop?.(); } catch{} }

        // Restore original materials/colors if we were charred by lava
        try { this.restoreOriginalMaterials?.(); } catch {}

        // Reset core stats
        this.health = CONFIG.player.maxHealth;
        this.sprint = CONFIG.player.maxSprint;

        // Clear any active speed boosts on respawn to prevent super speed bug
        this.activeSpeedMods = [];
        this.currentSpeedMultiplier = 1.0;

        // Finalize any ongoing energy/regen logging and clear accumulators
        try { this._finalizeConsumptionLog?.(); } catch (e) { /* ignore */ }
        this._consumingActive = false;
        this._consumptionAccumulator = 0;
        this._consumptionStartValue = 0;

        this._regenActive = false;
        this._regenAccumulator = 0;
        this._regenStartValue = 0;
        this.sprintRegenTimer = 0;

        // Clear transient input state to avoid immediate re-triggering actions on respawn
        try {
            if (this.inputManager) {
                this.inputManager.keys = {};
                this.inputManager.keysPressed = {};
                if (this.inputManager.keysPressedThisFrame && typeof this.inputManager.keysPressedThisFrame.clear === 'function') {
                    this.inputManager.keysPressedThisFrame.clear();
                }
                this.inputManager.keyPressTimes = {};
                // Call end frame update to ensure input buffers are cleared
                this.inputManager.endFrameUpdate?.();
            }
        } catch (e) { 
            reportError('respawn_input_clear', 'Failed to clear input state during respawn', e);
        }

        // Ensure physics body is fully reset BEFORE level setup
        if (this.body) {
            try {
                this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
                this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
                this.body.resetForces(true);
                this.body.resetTorques(true);
            } catch (e) {
                reportError('respawn_physics_reset', 'Failed to reset physics body during respawn', e);
            }
        }

        // Centralized level/start logic (rebuild track, reposition player, etc.)
        this.game._setupLevelStart();

        // Ensure controller FSM and visuals are in a sane idle state
        try {
            if (this.fsm && typeof this.fsm.setState === 'function') this.fsm.setState(STATES.IDLE);
            if (this.model && this.model.rotation && typeof this.playAnimation === 'function') {
                if (this.model.rotation.set) this.model.rotation.set(0, 0, 0);
                this.playAnimation(ANIM_MAP.idle, 1);
            }
        } catch (e) { 
            reportError('respawn_state_reset', 'Failed to reset FSM/animation state during respawn', e);
        }

        // Update UI
        this.uiManager?.updateHealth(this.health, this.cfg.player.maxHealth);
        this.uiManager?.updateSprint(this.sprint, this.cfg.player.maxSprint);
        
        // Release respawn lock
        this._respawnInProgress = false;
    }

    // Apply an all-black material to the fox model to simulate charring
    applyCharredLook() {
        if (!this.model || this._isCharred) return;
        try {
            if (!this._sharedCharMaterial) {
                // Use a standard material with skinning so SkinnedMesh animation keeps working
                this._sharedCharMaterial = new THREE.MeshStandardMaterial({
                    color: 0x000000,
                    emissive: 0x000000,
                    roughness: 1,
                    metalness: 0,
                    skinning: true
                });
                // Tag as shared so any broad cleanup code won't dispose it inadvertently
                this._sharedCharMaterial._isSharedMaterial = true;
                this._sharedCharMaterial.name = 'CharredSharedMaterial';
            }
            const sharedMat = this._sharedCharMaterial;
            this.model.traverse(obj => {
                if (!obj || !obj.isMesh) return;
                // Save original material once so we can restore later
                if (obj.userData && obj.userData._origMaterial === undefined) {
                    obj.userData._origMaterial = obj.material;
                }
                // Replace material with shared black material
                obj.material = sharedMat;
            });
            this._isCharred = true;
        } catch (e) { reportError('char_effect_apply', 'Failed to apply charred look', e); }
    }

    // Restore the fox model's original materials after death/respawn
    restoreOriginalMaterials() {
        if (!this.model || !this._isCharred) return;
        try {
            this.model.traverse(obj => {
                if (!obj || !obj.isMesh) return;
                const orig = obj.userData?._origMaterial;
                if (orig !== undefined) {
                    obj.material = orig;
                    try { delete obj.userData._origMaterial; } catch {}
                }
            });
        } catch (e) { reportError('char_effect_restore', 'Failed to restore original materials', e); }
        this._isCharred = false;
    }

    resetPlayerOrientation() {
        // Reset player model to original orientation (facing forward, no tilt)
        try {
            if (this.model && this.model.rotation && this.model.rotation.set) {
                this.model.rotation.set(0, 0, 0);
            }
        } catch (e) { /* ignore */ }
    }

    canBeginCharge(){
        // Require enough energy for at least the cheapest jump (quick tap)
        if (this.sprint < this.cfg.quickJump.cost) return false;
        return (this.isGrounded && this.groundTime > this.cfg.jump.minGroundTime) || this.coyoteTime > 0;
    }

    performDash() {
        if (this.sprint < CONFIG.gameplay.minDashEnergy) {
            GameLogger.action('Dash failed: insufficient_energy');
            this.uiManager?.showEnergyInsufficient('Dash');
            logger?.logInput('dash_failed', { reason:'insufficient_energy', energy:this.sprint });
            return false;
        }
        const staminaToConsume = this.sprint;
        this.consumeStamina(staminaToConsume); // Consume ALL remaining energy
        this.fsm.setState(STATES.DASH, { reason:'dash_initiated', staminaUsed: staminaToConsume });
        this.game.triggerDashEffect(staminaToConsume);
        this.game.audioManager?.playSound('dash');
        GameLogger.action('Dash successful.');
        return true;
    }

    checkGrounded(){
        const origin=this.body.translation();
        const hit=this.world.castShape(
            origin,
            this.body.rotation(),
            {x:0,y:-1,z:0},
            this._groundCheckShape,
            0.15,
            true
        );
        const was=this.isGrounded;
        const hitGround = !!hit;
        this.isGrounded = hitGround;

        // Reset falling-platform flags each check
        this.onFallingPlatform = false;
        this.fallingPlatformBody = null;

        if (hitGround && hit.collider){
            try {
                const hitBody = hit.collider.parent();
                // FIXED: Validate hitBody before accessing properties
                if (hitBody){
                    const segments = window.gameInstance?.trackSegments || [];
                    let matched = null;
                    for (const segment of segments){
                        // FIXED: Add null checks before handle comparison
                        if (!segment?.rapierBody) continue;
                        
                        // FIXED: Wrap handle comparison in try-catch
                        try {
                            if (segment.rapierBody.handle === hitBody.handle) {
                                matched = segment;
                                break;
                            }
                        } catch(e) {
                            // Handle was invalidated, skip this segment
                            continue;
                        }
                    }
                    this.currentGroundSegment = matched;
                    
                    // Falling platform logic for crumble mode
                    if (matched && this.game?.cfg?.track?.crumbleMode && (matched.isCrumblePlatform || matched.threeMeshes?.[0]?.userData?.isCrumblePlatform)){
                        const mesh = matched.threeMeshes?.[0];
                        if (mesh) {
                            // FIXED: Validate body before calling isDynamic
                            const isBodyDynamic = matched.rapierBody && 
                                (typeof matched.rapierBody.isDynamic === 'function') && 
                                matched.rapierBody.isDynamic();
                                
                            if (mesh.userData.crumbleState === this.game.CrumbleState.FALLING && isBodyDynamic){
                                this.onFallingPlatform = true;
                                this.fallingPlatformBody = matched.rapierBody;
                            } else if (mesh.userData.crumbleState === this.game.CrumbleState.STABLE) {
                                this.game.startCrumble(matched);
                            }
                        }
                    }
                }
            } catch(e) {
                // FIXED: Catch any physics engine errors gracefully
                reportError('ground_check', 'Error during ground segment matching', e);
                this.currentGroundSegment = null;
            }
        } else {
            this.currentGroundSegment = null;
        }

        // Stable/relative-ground checks
        if (hitGround) {
            // FIXED: Validate bodies before velocity access
            if (this.onFallingPlatform && this.fallingPlatformBody) {
                try {
                    // FIXED: Check if bodies are still valid
                    if (!this.body || !this.fallingPlatformBody) {
                        this.isGrounded = false;
                    } else {
                        const pv = this.body.linvel();
                        const fv = this.fallingPlatformBody.linvel();
                        const relY = Math.abs(pv.y - fv.y);
                        if (relY < 3.0) {
                            if (!was) {
                                this.isGrounded = true;
                                this.groundTime = 0;
                                this.game.audioManager?.playSound('land');
                            }
                        }
                    }
                } catch(e) {
                    // Body was removed mid-check
                    this.isGrounded = false;
                    this.onFallingPlatform = false;
                    this.fallingPlatformBody = null;
                }
            } else {
                if (!was) { 
                    this.groundTime=0; this.game.audioManager?.playSound('land'); 
                    try {
                        const seg = this.currentGroundSegment;
                        const vel = this.body?.linvel?.();
                        GameLogger.collision(`Landed${seg?.index != null ? ` on platform ${seg.index}` : ''}`, {
                            impactSpeed: vel ? Math.abs(vel.y).toFixed(2) : undefined,
                            platformType: seg ? (seg.dynamic ? 'dynamic' : 'static') : undefined,
                            isCrumble: !!seg?.isCrumblePlatform
                        });
                    } catch {}
                }
            }
        }
        if (was && !this.isGrounded) this.coyoteTime=CONFIG.jump.coyoteTime;
    }

    fixedUpdate(dt){
        if (!this.body || !this.model) return;
        this.prevTranslation.copy(this.currentTranslation);

        if (this.fsm.current instanceof DeadState){
            // Still update FSM for any state logic
            this.fsm.update(dt, this.inputManager);
            
            // Update translation for smooth interpolation
            const tr = this.body.translation();
            this.currentTranslation.set(tr.x, tr.y, tr.z);
            
            // Physics continues to apply gravity naturally
            // No need to manipulate velocity here
            
            return;
        }

        // Death fall check (skip in sandbox mode)
        // Removed arbitrary fall death; lava collider now manages kill-on-contact.

        // Timers
    if (this.coyoteTime > 0) this.coyoteTime -= dt;

        // Ground check BEFORE increment groundTime
        this.checkGrounded();
        if (this.isGrounded) this.groundTime += dt;
    // Airborne elapsed tracking for fine rotation control
    if (this.isGrounded) this.airElapsed = 0; else this.airElapsed = (this.airElapsed || 0) + dt;

        // FSM update first (charge may modify velocities)
        this.fsm.update(dt, this.inputManager);

        // FIX: Replace the existing try-catch block for consumption logging
        if (this._consumingActive && !this._isActuallyConsuming()) {
            this._finalizeConsumptionLog();
        }

        // Mouse-look movement: W/S forward/back relative to model facing (A/D unused)
        if (!(this.fsm.current instanceof ChargeState) && !(this.fsm.current instanceof DashState)) {
            const { targetVel, currentXZ, forward } = this._reusable;
            const { moveSpeed, sprintMultiplier, accelGround, decelGround } = CONFIG;
            const input = this.inputManager;
            const vel = this.body.linvel();
            currentXZ.set(vel.x, 0, vel.z);

            // Move intent (W/S forward/back only)
            let moveForward = 0;
            if (input.keys['KeyW']) moveForward = 1;
            if (input.keys['KeyS']) moveForward = -1;

            if ((moveForward !== 0) && !this.game.timerRunning && !this.game.cfg.sandbox) {
                this.game.startTimer();
            }

            // Calculate movement direction relative to player facing
            forward.set(0, 0, 1).applyQuaternion(this.model.quaternion).normalize();

            const sprinting = this.isSprinting(input);
            const speed = moveSpeed * (sprinting ? sprintMultiplier : 1);

            targetVel.copy(forward).multiplyScalar(speed * moveForward);

            if (this.isGrounded) {
                if (moveForward !== 0) {
                    const lerp = 1 - Math.exp(-accelGround * dt);
                    currentXZ.lerp(targetVel, lerp);
                } else {
                    const lerp = 1 - Math.exp(-decelGround * dt);
                    currentXZ.lerp(new THREE.Vector3(0, 0, 0), lerp);
                }
            } else {
                currentXZ.multiplyScalar(0.998);
            }
            this.body.setLinvel({ x: currentXZ.x, y: vel.y, z: currentXZ.z }, true);

            // Inherit kinematic platform motion while grounded on Translate level
            try {
                if (this.isGrounded && this.game?.currentLevel?.id === 'translate'){
                    const mp = this.game.cfg?.movingPlatformConfig || {};
                    const enableDelay = Math.max(0, Number(mp.carryEnableGroundDelay) || 0);
                    if (this.groundTime >= enableDelay) {
                        const seg = this.currentGroundSegment;
                        if (seg?.rapierBody?.isKinematic?.() && seg._moveType && seg._moveType !== 'Static'){
                            const cfgLin = Math.max(0, Math.min(1, Number(mp.inheritLinearCarry ?? 0.9)));
                            const cfgSpin = Math.max(0, Math.min(1, Number(mp.inheritSpinAngularCarry ?? 0.6)));
                            const cfgTilt = Math.max(0, Math.min(1, Number(mp.inheritTiltAngularCarry ?? 0.0)));
                            const maxCarry = Math.max(0, Number(mp.maxCarrySpeed ?? 8));

                            const carry = seg._kinVel || { x:0, y:0, z:0 };
                            let addX = carry.x * cfgLin;
                            let addY = carry.y * cfgLin;
                            let addZ = carry.z * cfgLin;
            if (seg._moveType === 'TranslateY') {
                addY *= 0.15; // Only inherit 15% of vertical motion (tweak as needed)
            }

                            // Existing rotational logic retained (working well):
                            // ω × r with logarithmic attenuation to reduce edge shove
                            if (seg._kinAngVel && seg._angAxis) {
                                const isSpin = (seg._moveType === 'SpinCW' || seg._moveType === 'SpinCCW');
                                const scale = isSpin ? cfgSpin : cfgTilt;
                                if (scale > 0) {
                                    const axis = (seg._angAxis.clone?.() ? seg._angAxis.clone() : new THREE.Vector3(seg._angAxis.x, seg._angAxis.y, seg._angAxis.z)).normalize();
                                    const playerPos = this.body.translation();
                                    const platPos = seg.rapierBody.translation();
                                    const r = new THREE.Vector3(playerPos.x - platPos.x, 0, playerPos.z - platPos.z);
                                    const radialDist = Math.hypot(r.x, r.z);
                                    const logDen = Math.max(1, Math.log2(1 + radialDist));
                                    const attenuation = 1 / logDen;
                                    const wVec = axis.multiplyScalar(seg._kinAngVel);
                                    const t = new THREE.Vector3().copy(wVec).cross(r).multiplyScalar(scale * attenuation);
                                    addX += t.x;
                                    addZ += t.z;
                                }
                            }

                            // Clamp horizontal carry magnitude
                            const hmag = Math.hypot(addX, addZ);
                            if (maxCarry > 0 && hmag > maxCarry) {
                                const s = maxCarry / hmag;
                                addX *= s; addZ *= s;
                            }

                            const curV = this.body.linvel();
                            this.body.setLinvel({
                                x: curV.x + addX,
                                y: curV.y + addY,
                                z: curV.z + addZ
                            }, true);
                        }
                    }
                }
            } catch {}

            // Animation selection handled in WalkState.update()
        }

        // Regen happens if not charging or dashing
        if (!(this.fsm.current instanceof ChargeState) && !(this.fsm.current instanceof DashState)) {
            this.updateSprint(dt);
        }

        // If we're not regenerating and regen flag is active (no longer grounded/regening), flush regen log
        try {
            if (this._regenActive && (!this.isGrounded || this.sprint >= CONFIG.player.maxSprint)) {
                const endVal = this.sprint;
                GameLogger.player(`Energy regen ended: ${this._regenStartValue.toFixed(1)} -> ${endVal.toFixed(1)} (+${this._regenAccumulator.toFixed(1)})`);
                this._regenActive = false;
                this._regenAccumulator = 0;
            }
        } catch {}

        // Update platform speed modifiers after movement to reduce perceived pop (dt already passed)
        this._updateSpeedModifiers(dt);

        // Update interpolation anchor
        const tr=this.body.translation();
        this.currentTranslation.set(tr.x,tr.y,tr.z);
    }

    update(dt, alpha){
        this.mixer?.update(dt);
        this.debug?.update(this.body?.linvel?.(), this.fsm.current, this.currentTranslation);

        if (this.fsm.current instanceof DeadState){
            // Smooth interpolation even when dead
            const interp = this.prevTranslation.clone().lerp(this.currentTranslation, alpha);
            const modelY = interp.y - (CONFIG.player.height + CONFIG.player.radius);
            
            // Apply the tipped-over rotation
            this.model.position.set(interp.x, modelY, interp.z);
            
            // Keep the death rotation (don't reset it)
            // The rotation was set in DeadState.enter() and should persist
            
            return;
        }

        const interp=this.prevTranslation.clone().lerp(this.currentTranslation, alpha);
        const modelY=interp.y - (CONFIG.player.height + CONFIG.player.radius);
        this.model.position.set(interp.x, modelY, interp.z);
    }

    // Handles dash input on frames where no physics step occurred (prevents missed dashes at high FPS)
    processImmediateDash(){
        const input = this.inputManager;
        if (!input) return;
        if (input.wasPressed('KeyQ')){
            // Disallow during charge, dash, or dead states (mirrors fixedUpdate state gating)
            if (this.fsm.current instanceof ChargeState) return;
            if (this.fsm.current instanceof DashState) return;
            if (this.fsm.current instanceof DeadState) return;
            this.performDash();
        }
    }
}

/* ---  Input Manager (wraps logging + hold durations) --- */
class EnhancedInputManager {
    constructor(logManager){
        this.keys = {};
        this.keysPressed = {};
        this.keysPressedThisFrame = new Set();
        this.logger = logManager || null;
        this.keyHoldTimes = {};
        this.keyPressTimes = {};
        
        // Input buffering to prevent loss during high-load frames
        this.inputQueue = [];
        this.maxQueueSize = 10;
        this.inputQueueTimeout = 100; // ms to keep inputs in queue
        
        // Track frame-skip input recovery
        this._missedInputs = 0;

        this._onKeyDown = e => {
            if (e.repeat) return;
            
            try {
                const wasPressed = this.keys[e.code];
                this.keys[e.code] = true;
                
                if (!wasPressed) {
                    this.keysPressed[e.code] = true;
                    this.keysPressedThisFrame.add(e.code);
                    this.keyPressTimes[e.code] = performance.now();
                    
                    // Add to input queue for recovery if frames are dropped
                    this._queueInput({
                        type: 'keydown',
                        code: e.code,
                        timestamp: performance.now()
                    });
                    
                    this.logger?.logInput('key_down', { key: e.code, modifiers: { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey } });
                    GameLogger.input(`Key down: ${e.code}`);
                    
                    // CRITICAL FIX: Resume audio context on first user interaction
                    if (window.gameInstance?.audioManager) {
                        try {
                            window.gameInstance.audioManager._resumeAudioContext?.();
                        } catch (e) {
                            // Audio context resume failed, continue anyway
                        }
                    }
                    
                    // Resume THREE.js audio context on first input
                    if (window.gameInstance) {
                        try {
                            window.gameInstance._resumeThreeAudioContextOnce?.();
                        } catch (e) {
                            // THREE audio context resume failed, continue anyway
                        }
                    }
                    
                    // Start backup beep when S is pressed
                    if (e.code === 'KeyS' && window.gameInstance?.audioManager) {
                        console.log('🎵 S key pressed, attempting to start backup beep...');
                        window.gameInstance.audioManager.startBackupBeep();
                    }
                }
            } catch (error) {
                reportError('input_manager', 'Error processing keydown event', error);
            }
        };

        this._onKeyUp = e => {
            this.keys[e.code] = false;
            if (this.keyPressTimes[e.code]){
                const duration = performance.now() - this.keyPressTimes[e.code];
                this.logger?.logInput('key_up', { key: e.code, holdDuration: duration.toFixed(2) + 'ms' });
                GameLogger.input(`Key up: ${e.code} (held for ${duration.toFixed(0)}ms)`);
                delete this.keyPressTimes[e.code];
            }
            
            // Stop backup beep when S is released
            if (e.code === 'KeyS' && window.gameInstance?.audioManager) {
                console.log('🎵 S key released, stopping backup beep...');
                window.gameInstance.audioManager.stopBackupBeep();
            }
        };

        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
    }
    
    _queueInput(input) {
        // Add input to queue with timestamp
        this.inputQueue.push(input);
        
        // Limit queue size
        if (this.inputQueue.length > this.maxQueueSize) {
            this.inputQueue.shift();
        }
    }
    
    _processInputQueue() {
        // Clean up old inputs from queue
        const now = performance.now();
        this.inputQueue = this.inputQueue.filter(input => 
            now - input.timestamp < this.inputQueueTimeout
        );
    }
    
    // Recovery method for missed inputs (called during frame-skip recovery)
    recoverMissedInputs() {
        const recovered = this.inputQueue.filter(input => {
            // Check if input wasn't processed (still in pressed state)
            if (input.type === 'keydown' && !this.keysPressed[input.code]) {
                return true;
            }
            return false;
        });
        
        if (recovered.length > 0) {
            this._missedInputs += recovered.length;
            GameLogger.input(`Recovered ${recovered.length} missed inputs (total: ${this._missedInputs})`);
        }
        
        return recovered;
    }

    wasPressed(keyCode){ return this.keysPressedThisFrame.has(keyCode); }
    getHoldDuration(keyCode){ if (!this.keys[keyCode] || !this.keyPressTimes[keyCode]) return 0; return performance.now() - this.keyPressTimes[keyCode]; }
    endFrameUpdate(){ 
        this.keysPressed = {}; 
        this.keysPressedThisFrame.clear(); 
        this._processInputQueue(); // Clean up old queued inputs
    }
    destroy(){ 
        try {
            document.removeEventListener('keydown', this._onKeyDown); 
            document.removeEventListener('keyup', this._onKeyUp);
            this.inputQueue = [];
            this.keys = {};
            this.keysPressed = {};
            this.keysPressedThisFrame.clear();
        } catch (error) {
            reportError('input_manager', 'Error during input manager cleanup', error);
        }
    }
}

// Backwards-compatible, keep legacy InputManager name as a thin wrapper around EnhancedInputManager
class InputManager extends EnhancedInputManager { constructor(){ super(logger); } }

/* ---  Character-Relative ThirdPersonCamera (no pointer lock) --- */
/* --- Mouse Look ThirdPersonCamera --- */
class ThirdPersonCamera {
    constructor(camera, target) {
        this.camera = camera;
        this.target = target;
        this._currentPosition = new THREE.Vector3();
        this._currentLookat = new THREE.Vector3();
        
        // Mouse look state
        this.yaw = 0;   // Horizontal rotation (Y-axis)
        this.pitch = 0; // Vertical rotation (X-axis)
        this.isLocked = false;
        
        // Distance/zoom state
        this.baseHeight = 5;
        this.distance = 12;
        this.targetDistance = this.distance;
        this.currentDistance = 0;
        this.zoomSmoothing = 0.15;
        
        // Mouse sensitivity from config (updates via settings listeners)
        this.sensitivity = {
            x: CONFIG.camera.sensitivityX || 0.2,
            y: CONFIG.camera.sensitivityY || 0.2
        };
        // Invert pitch option (loaded from Game settings if available later)
        this.invertPitch = !!(window.gameInstance?.settings?.invertPitch);
        
        // Bind mouse events
        this._onMouseMove = (e) => this.onMouseMove(e);
        this._onWheel = (e) => this.onWheel(e);
        this._onPointerLockChange = () => this.onPointerLockChange();
        // Cache canvas for targeted pointer lock re-entry during gameplay
        this._canvas = document.getElementById('three-canvas');
        this._onCanvasClick = () => {
            // Only attempt to lock while game is running and not paused
            const gi = window.gameInstance;
            const canLock = gi?.running && !gi?.isPaused;
            if (!this.isLocked && canLock && this._canvas?.requestPointerLock) {
                try { this._canvas.requestPointerLock(); } catch {}
            }
        };
        
    document.addEventListener('mousemove', this._onMouseMove);
        window.addEventListener('wheel', this._onWheel, { passive: true });
        document.addEventListener('pointerlockchange', this._onPointerLockChange);
    // Re-lock pointer only when user clicks the canvas during gameplay
    if (this._canvas) this._canvas.addEventListener('click', this._onCanvasClick);
        
        GameLogger.lifecycle('ThirdPersonCamera initialized (mouse look).');
        // Initialize lock state in case pointer was already locked before camera creation
        this.onPointerLockChange();
    }
    
    onPointerLockChange() {
        // Consider locked if either the canvas or body holds the lock
        const ple = document.pointerLockElement;
        this.isLocked = !!ple && (ple === this._canvas || ple === document.body);
        // Show/hide pointer lock hint
        const hint = document.getElementById('pointerLockHint');
        if (this.isLocked) {
            if (hint) {
                hint.style.display = 'block';
                clearTimeout(hint._hideTimeout);
                hint._hideTimeout = setTimeout(() => { hint.style.display = 'none'; }, 4000);
            }
        } else {
            if (hint) {
                hint.style.display = 'none';
                clearTimeout(hint._hideTimeout);
            }
        }
        console.log(`🖱️ Pointer lock: ${this.isLocked ? 'ACTIVE' : 'INACTIVE'}`);
        try {
            GameLogger.input(`Pointer lock: ${this.isLocked ? 'ACQUIRED' : 'RELEASED'}`, {
                element: ple?.id || ple?.tagName || 'none',
                yaw: typeof this.yaw === 'number' ? this.yaw.toFixed(2) : undefined,
                pitch: typeof this.pitch === 'number' ? this.pitch.toFixed(2) : undefined
            });
        } catch {}
    }
    
    onMouseMove(e) {
        if (!this.isLocked) return;
        
    // Apply mouse movement to yaw/pitch
    const deltaX = e.movementX || 0;
    let deltaY = e.movementY || 0;
    if (this.invertPitch) deltaY = -deltaY;
        
    this.yaw -= deltaX * this.sensitivity.x * 0.001;
    this.pitch -= deltaY * this.sensitivity.y * 0.001;
        
        // Clamp pitch to prevent camera flip
        const maxPitch = Math.PI / 3; // 60 degrees up/down
        this.pitch = Math.max(-maxPitch, Math.min(maxPitch, this.pitch));
        
        // Apply rotation to player model (yaw only)
        if (this.target) {
            this.target.rotation.y = this.yaw;
        }
    }
    
    onWheel(e) {
        const dir = Math.sign(e.deltaY);
        if (dir === 0) return;
        const oldDistance = this.targetDistance;
        const step = (CONFIG.camera?.zoomSpeed ?? 0.5) * dir;
        this.targetDistance = Math.max(
            CONFIG.camera?.zoomMinDistance ?? 2,
            Math.min(CONFIG.camera?.zoomMaxDistance ?? 30, this.targetDistance + step)
        );
        try {
            if (typeof oldDistance === 'number') {
                GameLogger.input(`Camera zoom: ${oldDistance.toFixed(1)} -> ${this.targetDistance.toFixed(1)}`);
            }
        } catch {}
    }
    
    _calculateIdealOffset() {
        const distLerp = 1 - Math.pow(0.001, (performance.now() % 16.67) / 1000);
        this.distance += (this.targetDistance - this.distance) * Math.min(this.zoomSmoothing, distLerp + this.zoomSmoothing);
        
        // Camera offset based on yaw and pitch
        const offsetX = Math.sin(this.yaw) * Math.cos(this.pitch) * this.distance;
        const offsetY = this.baseHeight + Math.sin(this.pitch) * this.distance;
        const offsetZ = Math.cos(this.yaw) * Math.cos(this.pitch) * this.distance;
        
        const idealOffset = new THREE.Vector3(-offsetX, offsetY, -offsetZ);
        
        if (this.target) {
            idealOffset.add(this.target.position);
        }
        return idealOffset;
    }
    
    _calculateIdealLookat() {
        if (!this.target) return new THREE.Vector3();
        
        
        const lookAheadDist = 5; // Look slightly ahead of the player based on yaw
        const lookOffset = new THREE.Vector3(
            Math.sin(this.yaw) * lookAheadDist,
            2,
            Math.cos(this.yaw) * lookAheadDist
        );
        
        return this.target.position.clone().add(lookOffset);
    }
    
    update(dt) {
        if (!this.target) return;
        const idealOffset = this._calculateIdealOffset();
        const idealLookat = this._calculateIdealLookat();
        const t = 1.0 - Math.pow(0.001, dt);
        this._currentPosition.lerp(idealOffset, t);
        this._currentLookat.lerp(idealLookat, t);
        this.camera.position.copy(this._currentPosition);
        this.camera.lookAt(this._currentLookat);
        this.currentDistance = this.camera.position.distanceTo(this.target.position);
    }
    
    forceSnap() {
        if (!this.target) return;
        this._currentPosition.copy(this._calculateIdealOffset());
        this._currentLookat.copy(this._calculateIdealLookat());
        this.camera.position.copy(this._currentPosition);
        this.camera.lookAt(this._currentLookat);
        this.currentDistance = this.camera.position.distanceTo(this.target.position);
    }
    
    destroy() {
        document.removeEventListener('mousemove', this._onMouseMove);
        window.removeEventListener('wheel', this._onWheel);
        document.removeEventListener('pointerlockchange', this._onPointerLockChange);
        if (this._canvas && this._onCanvasClick) this._canvas.removeEventListener('click', this._onCanvasClick);
        if (this.isLocked) {
            try { document.exitPointerLock(); } catch {}
        }
    }
}

/* --- UI Manager --- */
class UIManager {
    constructor(){
        this.healthFill=document.getElementById('health-fill');
        this.healthText=document.getElementById('health-text');
        this.sprintFill=document.getElementById('sprint-fill');
        this.sprintText=document.getElementById('sprint-text');
        this.chargePreview=document.getElementById('charge-preview');
        this.gameOver=document.getElementById('game-over');
        this.scoreDisplay=document.getElementById('score-display');
        this.sprintBarContainer=document.getElementById('sprint-bar-container');
        this.gameUI = document.getElementById('game-ui');
        this._energyFailAnimating=false;
        this._gameOverKeyHandler = (e) => this.handleGameOverKey(e);
    }
    updateHealth(cur,max){
        this.healthFill.style.width=(cur/max*100)+'%';
        this.healthText.textContent=`${Math.ceil(cur)} / ${max}`;
    }
    updateSprint(cur,max){
        this.sprintFill.style.width=(cur/max*100)+'%';
        this.sprintText.textContent=`${Math.ceil(cur)} / ${max}`;
    }
    setChargePreview(pct){ if (!this.chargePreview) return; this.chargePreview.style.width=(pct*100)+'%'; }
    updateScore(score){ this.scoreDisplay.textContent=`SCORE: ${score}`; }
    handleGameOverKey(e){
        if (this.gameOver.style.display !== 'block') return;
        if (e.code === 'KeyR') {
            e.preventDefault();
            if (window.gameInstance?.playerController) {
                window.gameInstance.playerController.respawn();
            }
        } else if (e.code === 'KeyM') {
            e.preventDefault();
            if (window.gameInstance) {
                window.gameInstance.returnToMenuFromPause();
            }
        }
    }
    showGameOver(score, finalTimeText){
        this.gameOver.style.display='block';
        
        // Stop backup beep when player dies
        if (window.gameInstance?.audioManager?.backupBeepPlaying) {
            window.gameInstance.audioManager.stopBackupBeep();
        }
        
        // HIDE GAME UI (health/energy bars)
        if (this.gameUI) this.gameUI.style.display='none';
        
        if (this.scoreDisplay) this.scoreDisplay.style.display='none';
        
        const finalScore=document.getElementById('final-score');
        if (finalScore) finalScore.textContent=`Score: ${score}`;
        const finalTime=document.getElementById('final-time');
        if (finalTime) finalTime.textContent=`Time: ${finalTimeText}`;
        
        // Set up button event listeners
        const retryBtn = document.getElementById('btn-retry-death');
        const menuBtn = document.getElementById('btn-menu-death');
        
        if (retryBtn) {
            retryBtn.onclick = () => {
                if (window.gameInstance?.playerController) {
                    window.gameInstance.playerController.respawn();
                }
            };
        }
        
        if (menuBtn) {
            menuBtn.onclick = () => {
                if (window.gameInstance) {
                    window.gameInstance.returnToMenuFromPause();
                }
            };
        }
        
        // Set up menu navigation for game over screen
        if (window.menuNavigation) {
            window.menuNavigation.setActiveMenu('game-over');
        }
        
        // Add keyboard shortcuts for R (respawn) and M (main menu)
        document.addEventListener('keydown', this._gameOverKeyHandler);
    }
    hideGameOver(){
        // Remove keyboard shortcuts
        document.removeEventListener('keydown', this._gameOverKeyHandler);
        
        this.gameOver.style.display='none';
        
        // SHOW GAME UI (health/energy bars)
        if (this.gameUI) this.gameUI.style.display='block';
        
        // Show score/timer unless sandbox mode
        const isSandbox = window.gameInstance?.cfg?.sandbox;
        if (this.scoreDisplay && !isSandbox) this.scoreDisplay.style.display='block';
        
        const timeDisplay = document.getElementById('time-display');
        if (timeDisplay && !isSandbox) timeDisplay.style.display='block';
    }
    updateDashStatus(isReady){
        if (!this.sprintBarContainer) return;
        if (isReady) this.sprintBarContainer.classList.add('dash-ready');
        else this.sprintBarContainer.classList.remove('dash-ready');
    }
    showEnergyInsufficient(actionName='Action'){
        if (!this.sprintBarContainer || this._energyFailAnimating) return;
        this._energyFailAnimating=true;
        this.sprintBarContainer.classList.add('energy-fail');
        GameLogger.action(`${actionName} failed - insufficient energy`);
        setTimeout(()=>{
            this.sprintBarContainer.classList.remove('energy-fail');
            this._energyFailAnimating=false;
        },400);
    }
}

/* --- Debug --- */
class Debug {
    constructor(scene, rapier){
        this.scene=scene; 
        this.rapier=rapier; 
        this.active=false;
        this.overlay=document.getElementById('debug-overlay');
        this.colliderMesh=null;
        this.damageZoneMeshes=[];
        this._debugUpdateInterval = null; //interval handle
        
        document.addEventListener('keydown', e=>{ if (e.code==='KeyF') this.toggle(); });
        // Off-VSync sample trigger
        document.addEventListener('keydown', e=>{
            if (!this.active) return;
            if (e.code === 'KeyO'){
                const game = window.gameInstance;
                if (game && !game._offVSyncSampling){
                    game.requestOffVSyncSample();
                }
            }
        });
    }
    toggle(){
        this.active=!this.active;
        this.overlay.style.display=this.active?'block':'none';
        if (this.colliderMesh) this.colliderMesh.visible=this.active;
        this.damageZoneMeshes.forEach(m=> m.visible=this.active);
        
        try { 
            window.gameInstance?.setPlatformColliderDebug(this.active);
            
            if (this.active) {
                // Start continuous updates
                this._startDebugMeshUpdates();
            } else {
                // Stop continuous updates and cleanup
                this._stopDebugMeshUpdates();
            }
        } catch {}
    }
    
    //  Start continuous debug mesh position updates
    _startDebugMeshUpdates() {
        // Clear any existing interval
        if (this._debugUpdateInterval) {
            clearInterval(this._debugUpdateInterval);
        }
        
        // Update at 60fps (every ~16ms)
        this._debugUpdateInterval = setInterval(() => {
            if (!this.active || !window.gameInstance?.trackSegments) return;
            
            // Check if debug panel is actually visible
            const debugPanel = document.getElementById('debug-panel');
            if (!debugPanel || debugPanel.style.display === 'none') return;
            
            window.gameInstance.trackSegments.forEach(seg => {
                if (seg?._debugMesh && seg.rapierBody) {
                    try {
                        const pos = seg.rapierBody.translation();
                        const rot = seg.rapierBody.rotation();
                        seg._debugMesh.position.set(pos.x, pos.y, pos.z);
                        seg._debugMesh.quaternion.set(rot.x, rot.y, rot.z, rot.w);
                    } catch(e) {}
                }
            });
        }, 16); // ~60fps
    }
    
    //Stop continuous updates
    _stopDebugMeshUpdates() {
        if (this._debugUpdateInterval) {
            clearInterval(this._debugUpdateInterval);
            this._debugUpdateInterval = null;
        }
    }
    
    addCollider(collider, model){
        if (!collider || !model?.parent) {
            reportError('debug', 'Cannot add collider: missing collider or model parent', {
                hasCollider: !!collider,
                hasModel: !!model,
                hasParent: !!model?.parent
            });
            return;
        }
        const shape=collider.shape;
        let geo;
        if (shape?.type===this.rapier.ShapeType.Capsule){
            const radius=shape.radius;
            const height=shape.halfHeight*2;
            geo=new THREE.CapsuleGeometry(radius,height,8,16);
        } else {
            geo=new THREE.SphereGeometry(0.5);
        }
        const mat=new THREE.MeshBasicMaterial({ wireframe:true, color:0x00ff00 });
        this.colliderMesh=new THREE.Mesh(geo, mat);
        this.colliderMesh.visible=this.active;
        model.parent.add(this.colliderMesh);
    }
    update(vel,state,pos){
        if (!this.active) return;
        if (!pos) return;
        const pc = window.gameInstance?.playerController;
        const camInst = window.gameInstance?.thirdPersonCamera;
        const game = window.gameInstance;
        this.overlay.innerHTML=
            `State: ${state?state.constructor.name:'N/A'}<br>`+
            `Pos: ${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}<br>`+
            (vel?`Vel: ${vel.x.toFixed(2)}, ${vel.y.toFixed(2)}, ${vel.z.toFixed(2)}<br>`:'')+
            (pc?`Energy: ${pc.sprint.toFixed(0)}/${CONFIG.player.maxSprint}<br>`:'')+
            (pc?`Dash Ready ≥${CONFIG.gameplay.minDashEnergy}: ${pc.sprint >= CONFIG.gameplay.minDashEnergy}<br>`:'')+
            (camInst?`Cam Zoom: ${camInst.currentDistance.toFixed(2)}<br>`:'')+
            (pc?`Grounded: ${pc.isGrounded}<br>`:'')+
            (game?`Spikes(damageZones): ${game.damageZones ? game.damageZones.length : 0}<br>`:'')+
            (game?`Render FPS: ${game.smoothedFps ? game.smoothedFps.toFixed(1) : '0'}<br>`:'')+
            (game?`Frame Work ms: ${game.smoothedWorkMs ? game.smoothedWorkMs.toFixed(2) : '0.00'}<br>`:'')+
            (game?`CPU Headroom@60Hz: ${game.headroomPct60 != null ? game.headroomPct60.toFixed(1)+'%' : 'N/A'}<br>`:'')+
            (game?`Theoretical Max FPS (last sample): ${game.theoreticalFps ? game.theoreticalFps.toFixed(1) : 'N/A'}<br>`:'')+
            (game? (game._offVSyncSampling?`<span style=\"color:#fa5;\">Sampling off-VSync... please wait</span><br>`:`Press O to run off-VSync sample<br>`) :'')+
            `<br><span style="color:#aaa;">Platform Colors:</span><br>`+
            `<span style="color:#888;">█ Static (gray)</span><br>`+
            `<span style="color:#99aacc;">█ X-axis tilt (charcoal-blue)</span><br>`+
            `<span style="color:#ccaa88;">█ Z-axis tilt (tan)</span><br>`+
            `<span style=\"color:#6cf;\">(rAF vsync-limited; work ms & headroom show engine capacity)</span>`;
        if (this.colliderMesh){
            this.colliderMesh.position.set(pos.x,pos.y,pos.z);
        }
    }
}

/* --- Menu Manager --- */
class MenuManager {
    constructor(){
        this.menu = document.getElementById('unified-menu');
        this.navButtons = document.querySelectorAll('.nav-btn');
        this.menuSections = document.querySelectorAll('.menu-section');
        this.currentLevel = null;
        this.selectedLevelId = 'classic';
        this.menuContext = 'main'; // 'main' | 'pause'
        
        console.log('[MenuManager] Initialized', {
            menuFound: !!this.menu,
            navButtonCount: this.navButtons.length,
            sectionCount: this.menuSections.length
        });
        
        this.setupEventListeners();
        // Track section timings
        this._currentSection = 'play-section';
        this._sectionEnterTime = performance.now();
        this.renderLevelCards();
    }
    
    setupEventListeners(){
        GameLogger.action('Setup unified menu listeners');
        console.log('[MenuManager] Setting up event listeners');
        // Back to Game when opened from pause
        const backBtn = document.getElementById('btn-back-to-pause');
        if (backBtn){
            backBtn.addEventListener('click', ()=>{
                if (this.menuContext !== 'pause') return;
                this.menu.style.display='none';
                const pm = document.getElementById('pause-menu');
                if (pm){ pm.style.display='flex'; menuNavigator.setMenu('pause-menu'); }
            });
        }

        // ESC inside unified menu returns to pause overlay if opened from pause
        document.addEventListener('keydown', (e)=>{
            if (e.code !== 'Escape') return;
            const isUnifiedVisible = this.menu && this.menu.style.display === 'flex';
            if (isUnifiedVisible && this.menuContext === 'pause'){
                e.preventDefault();
                document.getElementById('btn-back-to-pause')?.click();
            }
        });
        
        // Navigation between sections
        this.navButtons.forEach(button => {
            button.addEventListener('click', () => {
                const targetSection = button.getAttribute('data-section');
                this.showSection(targetSection);
            });
        });
        
        // Settings sliders - wire to game settings
        const setupSlider = (sliderId, valueId, isPercent = false, decimals = 0) => {
            const slider = document.getElementById(sliderId);
            const valueDisplay = document.getElementById(valueId);
            
            console.log(`[MenuManager] Setting up slider: ${sliderId}`, { found: !!slider, hasDisplay: !!valueDisplay });
            
            if (slider && valueDisplay) {
                slider.addEventListener('input', () => {
                    const val = parseFloat(slider.value);
                    if (isPercent) {
                        valueDisplay.textContent = `${Math.round(val)}%`;
                    } else {
                        valueDisplay.textContent = val.toFixed(decimals);
                    }
                    
                    console.log(`[MenuManager] Slider ${sliderId} changed to:`, val);
                    
                    // Update game settings if instance exists
                    if (window.gameInstance) {
                        const game = window.gameInstance;
                        console.log(`[MenuManager] Updating game settings for ${sliderId}`);
                        
                        switch(sliderId) {
                            case 'sens-x':
                                if (game.updateCameraSettings) {
                                    game.updateCameraSettings(val, undefined, undefined);
                                } else {
                                    // Fallback for old code
                                    game.settings.cameraSensitivityX = val;
                                    CONFIG.camera.sensitivityX = val;
                                    if (game.thirdPersonCamera) game.thirdPersonCamera.sensitivity.x = val;
                                }
                                break;
                            case 'sens-y':
                                if (game.updateCameraSettings) {
                                    game.updateCameraSettings(undefined, val, undefined);
                                } else {
                                    // Fallback
                                    game.settings.cameraSensitivityY = val;
                                    CONFIG.camera.sensitivityY = val;
                                    if (game.thirdPersonCamera) game.thirdPersonCamera.sensitivity.y = val;
                                }
                                break;
                            case 'vol-master':
                                game.settings.masterVolume = val / 100;
                                game._updateAudioVolumes?.();
                                game.saveSettings?.();
                                break;
                            case 'vol-music':
                                game.settings.musicVolume = val / 100;
                                game._updateAudioVolumes?.();
                                game.saveSettings?.();
                                break;
                            case 'vol-sfx':
                                game.settings.sfxVolume = val / 100;
                                game._updateAudioVolumes?.();
                                game.saveSettings?.();
                                break;
                        }
                        game.saveSettings();
                    } else {
                        // No game instance yet - update CONFIG directly so it's ready when game starts
                        console.log(`[MenuManager] No game instance, updating CONFIG for ${sliderId}`);
                        
                        switch(sliderId) {
                            case 'sens-x':
                                CONFIG.camera.sensitivityX = val;
                                // Save to localStorage directly
                                const settings = JSON.parse(localStorage.getItem('lavaRunner_settings') || '{}');
                                settings.cameraSensitivityX = val;
                                localStorage.setItem('lavaRunner_settings', JSON.stringify(settings));
                                console.log(`[MenuManager] Saved sensitivity X to localStorage:`, val);
                                break;
                            case 'sens-y':
                                CONFIG.camera.sensitivityY = val;
                                const settings2 = JSON.parse(localStorage.getItem('lavaRunner_settings') || '{}');
                                settings2.cameraSensitivityY = val;
                                localStorage.setItem('lavaRunner_settings', JSON.stringify(settings2));
                                console.log(`[MenuManager] Saved sensitivity Y to localStorage:`, val);
                                break;
                            case 'vol-master':
                                const settings3 = JSON.parse(localStorage.getItem('lavaRunner_settings') || '{}');
                                settings3.masterVolume = val / 100;
                                localStorage.setItem('lavaRunner_settings', JSON.stringify(settings3));
                                break;
                            case 'vol-music':
                                const settings4 = JSON.parse(localStorage.getItem('lavaRunner_settings') || '{}');
                                settings4.musicVolume = val / 100;
                                localStorage.setItem('lavaRunner_settings', JSON.stringify(settings4));
                                break;
                            case 'vol-sfx':
                                const settings5 = JSON.parse(localStorage.getItem('lavaRunner_settings') || '{}');
                                settings5.sfxVolume = val / 100;
                                localStorage.setItem('lavaRunner_settings', JSON.stringify(settings5));
                                break;
                        }
                    }
                });
            } else {
                console.warn(`[MenuManager] Could not find slider or display for ${sliderId}`);
            }
        };
        
        setupSlider('sens-x', 'sens-x-value', false, 2);
        setupSlider('sens-y', 'sens-y-value', false, 2);
        setupSlider('vol-master', 'vol-master-value', true);
        setupSlider('vol-music', 'vol-music-value', true);
        setupSlider('vol-sfx', 'vol-sfx-value', true);
        
        // Graphics settings checkboxes
        const setupCheckbox = (checkboxId, settingName) => {
            const checkbox = document.getElementById(checkboxId);
            if (checkbox) {
                checkbox.addEventListener('change', (e) => {
                    if (window.gameInstance) {
                        const game = window.gameInstance;
                        game.settings[settingName] = e.target.checked;
                        // If toggling forklift-noise, always stop the beep to reset state
                        if (settingName === 'forkliftNoise' && game.audioManager && typeof game.audioManager.stopBackupBeep === 'function') {
                            game.audioManager.stopBackupBeep();
                        }
                        // Apply settings immediately
                        switch(settingName) {
                            case 'shadows':
                                if (game.renderer) game.renderer.shadowMap.enabled = e.target.checked;
                                break;
                            case 'particles':
                                // Particle setting handled by game
                                break;
                            case 'fog':
                                if (game.scene) {
                                    game.scene.fog = e.target.checked ? new THREE.Fog(0x1a0800, 50, 250) : null;
                                }
                                break;
                        }
                        game.saveSettings();
                    } else {
                        // Save to localStorage for when game starts
                        const settings = JSON.parse(localStorage.getItem('lavaRunner_settings') || '{}');
                        settings[settingName] = e.target.checked;
                        localStorage.setItem('lavaRunner_settings', JSON.stringify(settings));
                        console.log(`[MenuManager] Saved ${settingName} to localStorage:`, e.target.checked);
                    }
                });
            }
        };
        
        setupCheckbox('setting-shadows', 'shadows');
        setupCheckbox('setting-particles', 'particles');
        setupCheckbox('setting-fog', 'fog');
        setupCheckbox('forklift-noise', 'forkliftNoise');
        
        // Invert pitch checkbox
        const invertPitchCheckbox = document.getElementById('invert-pitch');
        if (invertPitchCheckbox) {
            invertPitchCheckbox.addEventListener('change', (e) => {
                if (window.gameInstance) {
                    const game = window.gameInstance;
                    game.settings.invertPitch = e.target.checked;
                    if (game.thirdPersonCamera) {
                        game.thirdPersonCamera.invertPitch = e.target.checked;
                    }
                    game.saveSettings();
                } else {
                    // Save to localStorage for when game starts
                    const settings = JSON.parse(localStorage.getItem('lavaRunner_settings') || '{}');
                    settings.invertPitch = e.target.checked;
                    localStorage.setItem('lavaRunner_settings', JSON.stringify(settings));
                    console.log(`[MenuManager] Saved invertPitch to localStorage:`, e.target.checked);
                }
            });
        }
        
        // Reset data button
        const resetBtn = document.getElementById('btn-reset-data');
        const resetConfirm = document.getElementById('reset-confirm-text');
        let resetClickCount = 0;
        // Ensure UI updates immediately when save is reset elsewhere
        window.addEventListener('lavaRunner:saveReset', () => {
            try { this.loadSettingsFromStorage(); } catch {}
            try { this.renderLevelCards(); } catch {}
        });
        
        if (resetBtn && resetConfirm) {
            resetBtn.addEventListener('click', () => {
                resetClickCount++;
                if (resetClickCount === 1) {
                    resetConfirm.style.display = 'block';
                    setTimeout(() => {
                        resetClickCount = 0;
                        resetConfirm.style.display = 'none';
                    }, 3000);
                } else if (resetClickCount === 2) {
                    // Actually reset
                    try {
                        const ok = saveManager.resetAllData();
                        resetConfirm.textContent = ok ? 'Data reset complete!' : 'Data reset failed';
                    } catch (e) {
                        console.error('Reset failed', e);
                        resetConfirm.textContent = 'Data reset failed';
                    }
                    resetConfirm.style.color = '#2ecc71';
                    setTimeout(() => {
                        resetClickCount = 0;
                        resetConfirm.style.display = 'none';
                        resetConfirm.textContent = 'Click again to confirm';
                        resetConfirm.style.color = '#e74c3c';
                    }, 2000);
                    this.renderLevelCards();
                }
            });
        }
    }
    
    showSection(sectionId){
        // Update nav buttons
        this.navButtons.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-section') === sectionId);
        });
        
        // Show target section
        this.menuSections.forEach(section => {
            section.classList.toggle('active', section.id === sectionId);
        });
        
        // Populate settings when switching to settings section
        if (sectionId === 'settings-section') {
            if (window.gameInstance) {
                window.gameInstance.populateSettings();
            } else {
                // Load from localStorage if no game instance
                this.loadSettingsFromStorage();
            }
        }
        
        const now = performance.now();
        try {
            const timeInSection = Math.round(now - (this._sectionEnterTime || now));
            GameLogger.action(`Menu navigation: ${this._currentSection} -> ${sectionId}`, { timeSpent: `${timeInSection}ms` });
        } catch {}
        this._currentSection = sectionId;
        this._sectionEnterTime = now;
    }
    
    loadSettingsFromStorage(){
        console.log('[MenuManager] Loading settings from localStorage (lavaRunner_settings)');
        let settings = JSON.parse(localStorage.getItem('lavaRunner_settings') || 'null');
        if (!settings) {
            // Migrate legacy key once if present
            const legacy = localStorage.getItem('gameSettings');
            if (legacy) {
                try { localStorage.setItem('lavaRunner_settings', legacy); } catch {}
                settings = JSON.parse(legacy || '{}');
            } else {
                settings = {};
            }
        }
        
        // Update sliders
        if (settings.cameraSensitivityX !== undefined) {
            const slider = document.getElementById('sens-x');
            const display = document.getElementById('sens-x-value');
            if (slider) slider.value = settings.cameraSensitivityX;
            if (display) display.textContent = (settings.cameraSensitivityX || 0.25).toFixed(3);
            CONFIG.camera.sensitivityX = settings.cameraSensitivityX;
        }
        if (settings.cameraSensitivityY !== undefined) {
            const slider = document.getElementById('sens-y');
            const display = document.getElementById('sens-y-value');
            if (slider) slider.value = settings.cameraSensitivityY;
            if (display) display.textContent = (settings.cameraSensitivityY || 0.25).toFixed(3);
            CONFIG.camera.sensitivityY = settings.cameraSensitivityY;
        }
        
        // Update volume sliders
        if (settings.masterVolume !== undefined) {
            const slider = document.getElementById('vol-master');
            const display = document.getElementById('vol-master-value');
            const val = Math.round(settings.masterVolume * 100);
            if (slider) slider.value = val;
            if (display) display.textContent = `${val}%`;
        }
        if (settings.musicVolume !== undefined) {
            const slider = document.getElementById('vol-music');
            const display = document.getElementById('vol-music-value');
            const val = Math.round(settings.musicVolume * 100);
            if (slider) slider.value = val;
            if (display) display.textContent = `${val}%`;
        }
        if (settings.sfxVolume !== undefined) {
            const slider = document.getElementById('vol-sfx');
            const display = document.getElementById('vol-sfx-value');
            const val = Math.round(settings.sfxVolume * 100);
            if (slider) slider.value = val;
            if (display) display.textContent = `${val}%`;
        }
        
        // Update checkboxes
        const shadowsCheckbox = document.getElementById('setting-shadows');
        if (shadowsCheckbox && settings.shadows !== undefined) shadowsCheckbox.checked = settings.shadows;
        
        const particlesCheckbox = document.getElementById('setting-particles');
        if (particlesCheckbox && settings.particles !== undefined) particlesCheckbox.checked = settings.particles;
        
        const fogCheckbox = document.getElementById('setting-fog');
        if (fogCheckbox && settings.fog !== undefined) fogCheckbox.checked = settings.fog;
        
        const invertCheckbox = document.getElementById('invert-pitch');
        if (invertCheckbox && settings.invertPitch !== undefined) invertCheckbox.checked = settings.invertPitch;
        
        const forkliftCheckbox = document.getElementById('forklift-noise');
        if (forkliftCheckbox && settings.forkliftNoise !== undefined) forkliftCheckbox.checked = settings.forkliftNoise;
        
        console.log('[MenuManager] Settings loaded from storage:', settings);
    }
    
    showMainMenu(opts={}){
        // opts: { fromPause?: boolean, sectionId?: string }
        this.menuContext = opts.fromPause ? 'pause' : 'main';
        this.menu.style.display = 'flex';
        this.showSection(opts.sectionId || 'play-section');
        document.body.style.cursor = 'default';
        
        // Initialize settings if game instance exists, otherwise load from storage
        if (window.gameInstance) {
            window.gameInstance.populateSettings();
        } else {
            this.loadSettingsFromStorage();
        }

        // Toggle back-to-game button depending on context
        const backBtn = document.getElementById('btn-back-to-pause');
        if (backBtn) backBtn.style.display = this.menuContext === 'pause' ? 'inline-block' : 'none';
    }
    
    hideAllMenus(){
        this.menu.style.display = 'none';
    }
    
    renderLevelCards(){
        const grid = document.getElementById('level-grid');
        if (!grid) return;
        grid.innerHTML = '';
        
        LEVELS.forEach(level => {
            const unlocked = level.unlocked || saveManager.isLevelUnlocked(level.id);
            const best = saveManager.getBestScore(level.id);
            
            const card = document.createElement('div');
            card.className = 'difficulty-card';
            card.setAttribute('data-level', level.id);
            
            if (!unlocked) {
                card.style.opacity = '0.5';
                card.style.cursor = 'not-allowed';
            }
            
            card.innerHTML = `
                <h3>${level.name}</h3>
                <p>${level.description}</p>
                <p class="difficulty">Difficulty: ${level.difficulty}</p>
                ${unlocked ? `<p class="best-score">Best: ${best}</p>` : `<p style="color:#e74c3c;">🔒 LOCKED</p>`}
            `;
            
            if (unlocked) {
                card.addEventListener('click', () => {
                    // Remove selection from all
                    document.querySelectorAll('.difficulty-card').forEach(c => {
                        c.style.borderColor = 'rgba(255,255,255,0.3)';
                        c.style.boxShadow = '';
                    });
                    
                    // Highlight selected
                    card.style.borderColor = '#e67e22';
                    card.style.boxShadow = '0 0 20px rgba(230,126,34,0.6)';
                    
                    this.selectedLevelId = level.id;
                    GameLogger.action(`Selected level: ${level.id}`);
                    
                    // Start game immediately on click
                    this.startGame(level.id);
                });
            }
            
            grid.appendChild(card);
        });
    }
    
    startGame(levelId){
        console.log(`[MenuTransition] Starting game for level: ${levelId}`);
        this.currentLevel = LEVELS.find(l => l.id === levelId);
        if (!this.currentLevel) { 
            reportError('menu', `Level not found: ${levelId}`); 
            return; 
        }

        // Ensure paused overlay is hidden and game not paused
        try {
            const pm = document.getElementById('pause-menu');
            if (pm) pm.style.display = 'none';
            if (window.gameInstance) window.gameInstance.isPaused = false;
        } catch {}

        try {
            const level = this.currentLevel;
            const bestScore = saveManager.getBestScore(levelId);
            GameLogger.lifecycle(`Starting level: ${levelId}`, {
                difficulty: level?.difficulty,
                bestScore,
                settings: {
                    sensX: window.gameInstance?.settings?.cameraSensitivityX || CONFIG.camera.sensitivityX,
                    sensY: window.gameInstance?.settings?.cameraSensitivityY || CONFIG.camera.sensitivityY
                }
            });
        } catch {}
        
        this.hideAllMenus();
        window.runtimeConfig = deepMerge(structuredClone(BASE_CONFIG), this.currentLevel.config || {});
        
        // Start the game, then request pointer lock as soon as canvas is visible
        setTimeout(() => {
            try {
                const canvas = document.getElementById('three-canvas');
                if (canvas && canvas.requestPointerLock) {
                    canvas.requestPointerLock();
                }
            } catch(e) { console.warn('Pointer lock request failed:', e); }
        }, 100);

        try {
            if (window.gameInstance){
                const prevSandbox = !!window.gameInstance.cfg?.sandbox;
                const nextSandbox = !!window.runtimeConfig?.sandbox;
                
                if (prevSandbox !== nextSandbox){
                    console.log(`[MenuTransition] Switching sandbox mode (${prevSandbox} -> ${nextSandbox}), reinitializing game instance`);
                    GameLogger.lifecycle(`Switching environment mode (sandbox ${prevSandbox} -> ${nextSandbox}). Reinitializing.`);
                    try { 
                        window.gameInstance.cleanup(); 
                    } catch(e){ 
                        reportError('cleanup','Failed during mode switch cleanup', e); 
                    }
                    window.pendingLevel = this.currentLevel;
                    window.gameInstance = new Game();
                } else {
                    window.gameInstance.startLevel(this.currentLevel);
                }
            } else {
                console.log('[MenuTransition] Creating new game instance');
                window.pendingLevel = this.currentLevel;
                window.gameInstance = new Game();
            }
        } catch(e){
            reportError('menu_transition', 'Failed to start level', e);
        }
    }
    
    returnToMenu(){
        GameLogger.action('Return to unified menu');
        
        // Capture score before cleanup so we can optionally save it
        let prevScore = null;
        try { prevScore = (window.gameInstance && Number.isFinite(window.gameInstance.score)) ? window.gameInstance.score : null; } catch {}
        
        // Reset player orientation before showing menu
        if (window.gameInstance?.playerController) {
            window.gameInstance.playerController.resetPlayerOrientation();
        }
        
        // Ensure any running game is fully cleaned up when returning to main menu
        try {
            if (window.gameInstance) {
                try { window.gameInstance.cleanup(); } catch(e){ reportError('cleanup','Failed during returnToMenu cleanup', e); }
                // Drop reference so a new Game() will be created on next start
                window.gameInstance = null;
            }
        } catch {}
        
        this.showMainMenu();
        
        // HIDE GAME UI ELEMENTS
        const gameUI = document.getElementById('game-ui');
        const scoreDisplay = document.getElementById('score-display');
        const timeDisplay = document.getElementById('time-display');
        const gameOver = document.getElementById('game-over');
        
        if (gameUI) gameUI.style.display = 'none';
        if (scoreDisplay) scoreDisplay.style.display = 'none';
        if (timeDisplay) timeDisplay.style.display = 'none';
        if (gameOver) gameOver.style.display = 'none';
        
        // Save best score using captured value (if any)
        if (this.currentLevel && Number.isFinite(prevScore) && prevScore > 0) {
            try { saveManager.saveLevelScore(this.currentLevel.id, prevScore); } catch {}
        }
        
        this.renderLevelCards();
        GameLogger.action('Game UI elements hidden');
    }
}
const menuManager=new MenuManager();
window.menuManager=menuManager;

// Add segment pooling to reduce GC
class SegmentPool {
    constructor() {
        this.pool = [];
        this.maxPoolSize = 20;
    }
    
    getSegment() {
        return this.pool.pop() || this.createSegment();
    }
    
    returnSegment(segment) {
        if (this.pool.length < this.maxPoolSize) {
            this.resetSegment(segment);
            this.pool.push(segment);
        } else {
            this.destroySegment(segment);
        }
    }
    
    createSegment() {
        // Return a fresh segment object
        return {
            index: 0, x: 0, z: 0, height: 0, rotation: 0,
            threeMeshes: [], rapierBody: null, dynamic: false, damageZones: [],
            rapierHingeBody: null, rapierJoint: null
        };
    }
    
    resetSegment(segment) {
        // Reset properties for reuse
        segment.index = 0;
        segment.x = 0;
        segment.z = 0;
        segment.height = 0;
        segment.rotation = 0;
        segment.threeMeshes.length = 0;
        segment.rapierBody = null;
        segment.dynamic = false;
        segment.damageZones.length = 0;
        segment.rapierHingeBody = null;
        segment.rapierJoint = null;
        // Clear any transient fields used by special levels (e.g., 'translate')
        // to ensure complete isolation across modes when segments are reused.
        segment._moveType = null;
        segment._origin = null;
        segment._angle = 0;
        segment._dir = 0;
        segment._pause = 0;
        segment._extentX = undefined;
        segment._extentY = undefined;
        segment._spdT = undefined;
        segment._spdR = undefined;
    segment._spdRFree = undefined;
        segment._rotLimitXDeg = undefined;
        segment._rotLimitZDeg = undefined;
        // Ensure crumble flag does not leak across runs
        segment.isCrumblePlatform = false;
    }
    
    destroySegment(segment) {
        // Dispose of resources if not pooling
        segment.threeMeshes?.forEach(mesh => {
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
        });
        // Rapier bodies are disposed in despawnSegment
    }
}

class Game {
    constructor(){
        GameLogger.lifecycle('Instance created.');
        // Active runtime configuration (per level); default to base
        this.cfg = window.runtimeConfig ? structuredClone(window.runtimeConfig) : structuredClone(BASE_CONFIG);
        this.lastFrameTime=0;
        this.accumulator=0;
        this.baseFov = this.cfg.camera.fov;
        this.dashFovBoost = VISUAL_CONSTANTS.DASH_FOV_BOOST;//
        this.dashFovTimer = 0;
        this.dashFovDuration = VISUAL_CONSTANTS.DASH_FOV_DURATION;
    this.lastDashForce = 0;
        this.score = 0;
        this.running = false; // gameplay running flag
        this.currentLevel=null;
        // Pause & settings system additions
        this.isPaused=false;
        this.pausedTime=0;
        this.levelGoal=50; // can be varied per level later
        this.levelCompleted=false;
        this._settingsListenersAttached=false;
        this.segmentPool = new SegmentPool();
        // Performance logging
        this.frameCount = 0;
        this.lastPerfLogTime = 0;
    // FPS capping (0 = uncapped)
    this.maxFps = 0;
    this.lastFrameRenderTime = 0;
        // Timer system
        this.timerElement = document.getElementById('time-display');
        this.timerRunning = false;
        this.startTime = 0;       // performance.now() when started
        this.elapsedTime = 0;      // ms cached
        this.pauseStartTime = 0;   // timestamp at pause to adjust elapsed
        this.totalPausedTime = 0;  // accumulated paused time to prevent drift
        this._cachedPlayerPos = null; // For segment search optimization
        this.settings={
            cameraSensitivityX: CONFIG.camera.sensitivityX || 0.2,
            cameraSensitivityY: CONFIG.camera.sensitivityY || 0.2,
            invertPitch: true,
            masterVolume:0.8,
            musicVolume:0.4,
            sfxVolume:0.6,
            shadows:true,
            particles:true,
            fog:true,
            forkliftNoise:true
        };
        this.loadSettings();
    this.audioManager=new AudioManager(this.settings);
    // THREE.js audio system
    this.audioListener = null;       // THREE.AudioListener (attached to camera)
    this.audioLoader = null;         // THREE.AudioLoader
    this.lavaAudio = null;           // THREE.Audio for looping lava
    this.stoneSlideBuffer = null;    // AudioBuffer for crumble one-shot
    // Legacy HTML5 bgm instance (kept for back-compat but unused once THREE audio is active)
    this.bgmAudio = null;
    
    // Add lava loop state tracking
    this.lavaLoopPlaying = false;
    this.lavaLoopLoaded = false;
    this.audioInitialized = false;
    this.lavaMesh = null;
    this.risingLavaUniforms = null;
    this.currentLavaHeight = CONFIG.risingLava.START_HEIGHT;
    this.risingLavaActive = false;
    // Instance-local rising lava speed to avoid mutating global CONFIG at runtime
    this._risingLavaSpeed = (this.cfg?.risingLava?.RISE_SPEED) ?? CONFIG.risingLava.RISE_SPEED;
        this.setupPauseListeners();
        // Quick hotkeys (restart & menu) integrated separately
    this._boundHotkeys = e => this._hotkeys(e);
    document.addEventListener('keydown', this._boundHotkeys);
        window.addEventListener('beforeunload', () => this.cleanup());
        // ---- CRUMBLE SYSTEM STATE ----
        this.CrumbleState = {
            STABLE: 'stable',
            WARNING: 'warning',
            FALLING: 'falling',
            DESTROYED: 'destroyed'
        };
        this.activeCrumblePlatforms = new Set();
        
        // Error recovery state
        this._consecutiveErrors = 0;
        this._crumbleSegmentMap = new Map();
        this.crumbleTimers = new Map();
    // Flag to indicate cleanup is underway to avoid late-frame events triggering after exit
    this._isCleaningUp = false;
        // --- NEW: Custom Rock Generator Setup ---
        this._perm = new Array(512); // Perlin Noise permutation table
        this._initNoisePermutation();
        
        // Stores the color being used for the current segment mesh generation
        this.currentBaseColor = new THREE.Color(0.15, 0.15, 0.15); 
        // ---------------------------------------
        // If a level was pre-selected before instance creation
        if (window.pendingLevel){
            this.init(window.pendingLevel).then(()=>{
                // Auto-start once assets are ready
                this.startLevel(window.pendingLevel);
            });
        }
    }

    // --- Background Music Management (Looped MP3) ---
    _updateBgmForMode(){
        // Non-sandbox maps should have the lava loop; sandbox should be quiet
        const shouldPlay = !this.cfg?.sandbox;
        if (shouldPlay) {
            this._ensureLavaLoopPlaying();
        } else {
            this._stopLavaLoop();
        }
    }
    
    _ensureLavaLoopPlaying(){
        if (!this.lavaLoopLoaded || !this.lavaAudio) {
            console.log('🎵 Lava loop not ready yet');
            return;
        }
        
        if (this.lavaLoopPlaying) {
            console.log('🎵 Lava loop already playing');
            return;
        }
        
        try {
            // Resume audio context if needed
            this._resumeThreeAudioContextOnce();
            
            // FIXED: Use current settings and respect master volume
            const masterVol = this.settings.masterVolume ?? 0.7;
            const musicVol = this.settings.musicVolume ?? 0.8;
            const ambientVolume = masterVol * musicVol * 0.3; // 30% of max for ambient effect
            
            // Don't start if master volume is 0
            if (masterVol <= 0) {
                console.log('🎵 Lava loop not started - master volume is 0');
                this.lavaLoopPlaying = true; // Mark as "should be playing" for when volume returns
                return;
            }
            
            this.lavaAudio.setVolume(Math.max(0, Math.min(1, ambientVolume)));
            
            // Start playing
            this.lavaAudio.play();
            this.lavaLoopPlaying = true;
            console.log('🎵 Lava loop started at volume:', ambientVolume);
            
            GameLogger.lifecycle('Lava ambient loop started');
        } catch(e) {
            console.warn('Failed to start lava loop:', e);
        }
    }

    _stopLavaLoop(){
        if (!this.lavaAudio || !this.lavaLoopPlaying) return;
        
        try {
            if (this.lavaAudio.isPlaying) {
                this.lavaAudio.stop();
            }
            this.lavaLoopPlaying = false;
            console.log('🎵 Lava loop stopped');
            GameLogger.lifecycle('Lava ambient loop stopped');
        } catch(e) {
            console.warn('Failed to stop lava loop:', e);
        }
    }
    
    _ensureBgmPlaying(){
        try {
            // Prefer THREE audio if available
            if (this.lavaAudio) {
                // FIXED: Use consistent volume calculation with master volume check
                const masterVol = this.settings.masterVolume ?? 0.7;
                const musicVol = this.settings.musicVolume ?? 0.8;
                const vol = Math.max(0, Math.min(1, masterVol * musicVol * 0.3)); // Match lava loop calculation
                
                this.lavaAudio.setVolume(vol);
                
                // Don't play if master volume is 0
                if (masterVol <= 0) {
                    if (this.lavaAudio.isPlaying) {
                        this.lavaAudio.pause();
                    }
                    return;
                }
                
                if (!this.lavaAudio.isPlaying) this.lavaAudio.play();
                return;
            }
            // Fallback: legacy HTML5 if THREE audio not ready yet
            if (!this.bgmAudio) {
                const masterVol = this.settings.masterVolume ?? 0.7;
                const musicVol = this.settings.musicVolume ?? 0.8;
                
                // Don't create audio if master volume is 0
                if (masterVol <= 0) return;
                
                const audio = new Audio('lava-loop-3-28887.wav'); // Updated file path
                audio.loop = true;
                audio.volume = Math.max(0, Math.min(1, masterVol * musicVol * 0.3)); // Consistent calculation
                audio.play().catch(()=>{});
                this.bgmAudio = audio;
            } else if (this.bgmAudio.paused) {
                const masterVol = this.settings.masterVolume ?? 0.7;
                if (masterVol > 0) {
                    this.bgmAudio.play().catch(()=>{});
                }
            }
        } catch {}
    }
    _stopBgm(){
        try {
            if (this.lavaAudio && this.lavaAudio.isPlaying) {
                this.lavaAudio.stop();
            }
        } catch {}
        try {
            if (this.bgmAudio) {
                this.bgmAudio.pause();
                this.bgmAudio.currentTime = 0;
            }
        } catch {}
    }

    // --- THREE.Audio helpers ---
    _loadAudio(filePath, onBuffer, onError = null){
        if (!this.audioLoader) return;
        
        console.log(`🎵 Loading audio: ${filePath}`);
        
        try {
            this.audioLoader.load(
                filePath,
                (buffer) => {
                    console.log(`✅ Audio loaded: ${filePath}`);
                    onBuffer(buffer);
                },
                (progress) => {
                    // Log loading progress for large files
                    if (progress.total > 0) {
                        const percent = (progress.loaded / progress.total * 100).toFixed(0);
                        console.log(`🎵 Loading ${filePath}: ${percent}%`);
                    }
                },
                (error) => {
                    console.warn(`❌ Failed to load audio: ${filePath}`, error);
                    if (onError) onError(error);
                }
            );
        } catch(e) { 
            console.warn('Audio load threw:', e);
            if (onError) onError(e);
        }
    }
    _loadGameAudio(){
        if (!this.audioLoader) return;
        
        // Load stone slide effect (try WAV first, fallback to MP3)
        this._loadAudio('./stone-slide-sound-effects-322794_taXzSSlN.wav', (buffer) => {
            this.stoneSlideBuffer = buffer;
            console.log('🎵 Stone slide audio loaded (WAV)');
            GameLogger.lifecycle('Stone slide audio loaded (WAV)');
        }, () => {
            // Fallback to MP3 if WAV fails
            this._loadAudio('./stone-slide-sound-effects-322794_taXzSSlN.mp3', (buffer) => {
                this.stoneSlideBuffer = buffer;
                console.log('🎵 Stone slide audio loaded (MP3 fallback)');
                GameLogger.lifecycle('Stone slide audio loaded (MP3 fallback)');
            });
        });
        
        // Load looping lava BGM
        this._loadAudio('./lava-loop-3-28887.wav', (buffer) => {
            try {
                console.log('🎵 Lava loop audio loaded successfully');
                
                // Create the audio object
                this.lavaAudio = new THREE.Audio(this.audioListener);
                this.lavaAudio.setBuffer(buffer);
                this.lavaAudio.setLoop(true);
                this.lavaAudio.setVolume(0.3);
                
                this.lavaLoopLoaded = true;
                
                // Start immediately on non-sandbox levels (independent of running timing)
                if (!this.cfg?.sandbox) {
                    this._ensureLavaLoopPlaying();
                }
                
                GameLogger.lifecycle('Lava loop audio initialized');
                
                // If a legacy HTML5 fallback is playing, prefer THREE and stop fallback
                try { 
                    if (this.bgmAudio && !this.bgmAudio.paused) { 
                        this.bgmAudio.pause(); 
                        this.bgmAudio.currentTime = 0; 
                    } 
                } catch{}
            } catch(e){ 
                console.warn('Failed to init lava audio', e); 
            }
        });
    }
    _resumeThreeAudioContextOnce(){
        if (!this.audioListener?.context) return;
        const ctx = this.audioListener.context;
        
        if (ctx.state === 'suspended') {
            try { 
                ctx.resume().then(() => {
                    console.log('🎵 Audio context resumed');
                }).catch(e => {
                    console.warn('Failed to resume audio context:', e);
                }); 
            } catch(e) {
                console.warn('Failed to resume audio context:', e);
            }
        }
    }

    // --- Stone Slide Effect (for crumble platforms) ---
    _playCrumbleEffect() {
        if (!this.stoneSlideBuffer) {
            console.warn('🎵 Stone slide buffer not loaded yet');
            return;
        }
        
        try {
            // Resume audio context if needed
            this._resumeThreeAudioContextOnce();
            
            // Create a new Audio object for this one-shot effect
            const sound = new THREE.Audio(this.audioListener);
            sound.setBuffer(this.stoneSlideBuffer);
            sound.setLoop(false);
            
            // Set volume based on current settings - USE CURRENT SETTINGS, NOT CACHED
            const masterVol = this.settings?.masterVolume || 0.7;
            const sfxVol = this.settings?.sfxVolume || 0.8;
            const finalVolume = masterVol * sfxVol * 0.6; // 60% of max for stone effect
            sound.setVolume(finalVolume);
            
            sound.play();
            console.log('🎵 Stone slide effect played at volume:', finalVolume);
            
            // Clean up after playing to save memory
            sound.onEnded = () => {
                try {
                    sound.disconnect();
                } catch(e) {
                    console.warn('Error cleaning up stone slide audio:', e);
                }
            };
            
            GameLogger.gameplay('Stone slide SFX triggered');
        } catch(e) {
            console.warn('Failed to play stone slide effect:', e);
        }
    }

    // Add this function to the same class:
    _initNoisePermutation() {
        const perm = [];
        for (let i = 0; i < 256; i++) perm[i] = i;
        // Shuffle the array using Fisher-Yates
        for (let i = 255; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [perm[i], perm[j]] = [perm[j], perm[i]];
        }
        // Duplicate the array for wrapping (Perlin Noise requirement)
        for (let i = 0; i < 512; i++) this._perm[i] = perm[i & 255];
    }

    // Perform an off-VSync performance sample to estimate theoretical max FPS
    requestOffVSyncSample(){
        if (this._offVSyncSampling) return;
        if (!this.scene || !this.renderer) return;
        this._offVSyncSampling = true;
        const iterations = 200; // enough for a stable average
        const step = CONFIG.physics.timestep;
        const start = performance.now();
        // Save transient values we mutate
        const savedLastFrameTime = this.lastFrameTime;
        const savedAccumulator = this.accumulator;
        const savedElapsed = this.elapsedTime;
        try {
            for (let i=0;i<iterations;i++){
                // Simulate a fixed small dt (we don't want gameplay to progress excessively)
                // Use a micro dt equal to typical frame interval (1/120) so logic branches mimic real frames.
                const simDt = 1/240; // smaller to reduce large leaps
                // Physics sub-stepping mimic
                this.accumulator += simDt;
                while (this.accumulator >= step){
                    this.world.step();
                    this.playerController?.fixedUpdate(step);
                    if (!this.cfg.sandbox) this.checkDamageAndScore(step); else this.checkSandboxHazards(step);
                    this.accumulator -= step;
                }
                const alpha = this.accumulator / step;
                this.playerController?.update(simDt, alpha);
                this.thirdPersonCamera?.update(simDt);
                this.updateCameraEffects(simDt);
                this.particleSystem?.update(simDt);
                this.renderer.render(this.scene, this.camera);
            }
            const end = performance.now();
            const totalMs = end - start;
            const avgMs = totalMs / iterations;
            this.theoreticalFps = 1000 / Math.max(0.0001, avgMs);
            GameLogger.perf(`Off-VSync sample complete: ${this.theoreticalFps.toFixed(1)} FPS (avg ${avgMs.toFixed(3)} ms)`);
        } catch (e){
            reportError('perf_sample', 'Off-VSync sample failed', e);
        } finally {
            // Restore timing values so normal loop not disrupted
            this.lastFrameTime = savedLastFrameTime;
            this.accumulator = savedAccumulator;
            this.elapsedTime = savedElapsed;
            this._offVSyncSampling = false;
        }
    }

    async init(level){
        GameLogger.lifecycle('Initializing game systems...');
        if (!level) level=LEVELS[0];
        this.currentLevel=level;
        // Refresh cfg in case a pending level override was staged earlier
        this.cfg = window.runtimeConfig ? structuredClone(window.runtimeConfig) : structuredClone(BASE_CONFIG);
        try {
            validateConfig(); // Check config for obvious errors first
            // Platform chances normalization removed (spiral mode deleted)
            this.scene=new THREE.Scene();
            if (this.cfg.sandbox){
                // Sandbox: bright sky, no fog
                this.scene.background=new THREE.Color(0x87CEEB);
                this.scene.fog=null;
            } else {
                // Original lava ambience
                this.scene.background=new THREE.Color(0x1a0800);
                this.scene.fog=new THREE.Fog(0x1a0800, 50, 250);
            }
            if (this.cfg.sandbox){
                // Large free-roam ground plane with procedural color variation via shader
                const groundSize=2000;
                const groundGeo=new THREE.PlaneGeometry(groundSize, groundSize);
                const groundMat=new THREE.ShaderMaterial({
                    uniforms:{
                        color1:{ value:new THREE.Color(0x4F7942) }, // dark green
                        color2:{ value:new THREE.Color(0x6B8E23) }  // olive
                    },
                    vertexShader:`
                        varying vec3 vWorldPosition;
                        void main(){
                            vec4 worldPosition = modelMatrix * vec4(position, 1.0);
                            vWorldPosition = worldPosition.xyz;
                            gl_Position = projectionMatrix * viewMatrix * worldPosition;
                        }
                    `,
                    fragmentShader:`
                        varying vec3 vWorldPosition;
                        uniform vec3 color1; uniform vec3 color2;
                        float rand(vec2 n){ return fract(sin(dot(n, vec2(12.9898,4.1414))) * 43758.5453); }
                        void main(){
                            float noise = rand(vWorldPosition.xz * 0.1);
                            vec3 finalColor = mix(color1, color2, noise);
                            gl_FragColor = vec4(finalColor, 1.0);
                        }
                    `,
                });
                const ground=new THREE.Mesh(groundGeo, groundMat);
                ground.rotation.x=-Math.PI/2;
                ground.position.y=0;
                ground.receiveShadow=true;
                this.scene.add(ground);
            } else {
                // Infinite-looking lava plane (shader-based, slow black/orange)
                const lavaGeometry = new THREE.PlaneGeometry(10000, 10000, 150, 150);

                // Load textures to emulate Babylon's LavaMaterial look
                const texLoader = new THREE.TextureLoader();
                const noiseTex = texLoader.load('https://threejs.org/examples/textures/lava/cloud.png');
                const diffuseTex = texLoader.load('https://threejs.org/examples/textures/lava/lavatile.jpg');
                // Texture params
                [noiseTex, diffuseTex].forEach(t => {
                    if (!t) return;
                    t.wrapS = t.wrapT = THREE.RepeatWrapping;
                    t.minFilter = THREE.LinearMipmapLinearFilter;
                    t.magFilter = THREE.LinearFilter;
                });

                // Shader uniforms (black + oranges) + textures
                this.lavaUniforms = {
                    uTime:   { value: 0.0 },
                    uColor1: { value: new THREE.Color(0x000000) }, // black crust
                    uColor2: { value: new THREE.Color(0xff4500) }, // deep orange
                    uColor3: { value: new THREE.Color(0xff6a00) }, // hot orange
                    tNoise:  { value: noiseTex },
                    tDiffuse:{ value: diffuseTex }
                };

                const lavaMaterial = new THREE.ShaderMaterial({
                    uniforms: this.lavaUniforms,
                    vertexShader: `
                        uniform float uTime;
                        varying vec2 vUv;
                        varying vec2 vWorldXZ;
                        void main() {
                            vUv = uv;
                            // Compute world position to drive infinite noise in fragment
                            vec4 worldPos = modelMatrix * vec4(position, 1.0);
                            vWorldXZ = worldPos.xz;

                            // Super-slow, subtle waves (vertex displacement only)
                            float waveSpeed = 0.5;
                            float waveStrength = 0.25;
                            float displacement = sin(position.x * 1.2 + uTime * waveSpeed) * waveStrength;
                            displacement += cos(position.z * 1.0 + uTime * waveSpeed * 0.7) * waveStrength * 0.5;
                            vec3 newPosition = position;
                            newPosition.y += displacement;
                            gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
                        }
                    `,
                    fragmentShader: `
                        uniform float uTime;
                        uniform sampler2D tNoise;
                        uniform sampler2D tDiffuse;
                        uniform vec3 uColor1; // black
                        uniform vec3 uColor2; // deep orange
                        uniform vec3 uColor3; // hot orange
                        varying vec2 vUv;
                        varying vec2 vWorldXZ;

                        // Helpers
                        float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
                        mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

                        void main(){
                            // World-space basis. Lower scale => larger features, less obvious tiling
                            vec2 w = vWorldXZ * 0.008;

                            // Slightly faster (still slow) opposing scrolls to ensure visible motion
                            vec2 s1 = vec2(uTime * 0.020, 0.0);
                            vec2 s2 = vec2(0.0, -uTime * 0.017);
                            vec2 s3 = vec2(-uTime * 0.012, uTime * 0.008);

                            // Domain warping via blended noise samples
                            vec2 nA = texture2D(tNoise, w * 0.6 + s1).rg;
                            vec2 nB = texture2D(tNoise, w * 1.3 + s2).rb;
                            vec2 nMix = (nA + nB) * 0.5; // 0..1
                            vec2 warp = (nMix - 0.5) * 0.9; // -0.45..0.45

                            // Time-varying small rotations per layer (subtle swirl)
                            float a1 = sin(uTime * 0.12) * 0.12;
                            float a2 = cos(uTime * 0.09) * 0.15;
                            mat2 r1 = rot(a1);
                            mat2 r2 = rot(a2);

                            // Two differently scaled, rotated, and warped UV layers
                            vec2 uv1 = r1 * (w * 1.15 + warp * 0.7) + s1 * 0.35;
                            vec2 uv2 = r2 * (w * 1.85 - warp * 0.5) + s2 * 0.30;

                            vec3 tex1 = texture2D(tDiffuse, uv1).rgb;
                            vec3 tex2 = texture2D(tDiffuse, uv2).rgb;

                            // Combine layers to break repetition
                            vec3 base = mix(tex1, tex2, 0.5);

                            // Additional soft modulation using a third noise sample
                            float nM = texture2D(tNoise, w * 0.9 + s3).r; // 0..1
                            float intensity = luma(base);
                            intensity *= mix(0.85, 1.15, nM); // slight variance

                            // Map to black/orange palette (tuned thresholds for contrast)
                            float t1 = smoothstep(0.28, 0.58, intensity);
                            float t2 = smoothstep(0.58, 0.80, intensity);
                            vec3 col = mix(uColor1, uColor2, t1);
                            col = mix(col, uColor3, t2);

                            gl_FragColor = vec4(col, 1.0);
                        }
                    `,
                    depthWrite: true,
                    side: THREE.DoubleSide
                });

                this.lavaMesh = new THREE.Mesh(lavaGeometry, lavaMaterial);
                this.lavaMesh.rotation.x = -Math.PI / 2;
                this.lavaMesh.position.y = CONFIG.lava.surfaceY;
                this.lavaMesh.receiveShadow = true;
                this.scene.add(this.lavaMesh);
            }
            
            this.camera=new THREE.PerspectiveCamera(
                this.cfg.camera.fov,
                window.innerWidth / window.innerHeight,
                this.cfg.camera.near,
                this.cfg.camera.far
            );
            // --- THREE audio setup ---
            try {
                this.audioListener = new THREE.AudioListener();
                this.camera.add(this.audioListener);
                this.audioLoader = new THREE.AudioLoader();
                this.audioInitialized = true;
                this._loadGameAudio();
                // Try to resume audio context on first user interaction
                const resumeOnce = ()=>{ this._resumeThreeAudioContextOnce(); window.removeEventListener('pointerdown', resumeOnce); window.removeEventListener('keydown', resumeOnce); };
                window.addEventListener('pointerdown', resumeOnce, { once:true });
                window.addEventListener('keydown', resumeOnce, { once:true });
                console.log('🎵 Audio system initialized');
                GameLogger.lifecycle('Audio system initialized');
            } catch(e) {
                console.warn('Failed to initialize audio system:', e);
            }
            const canvas=document.getElementById('three-canvas');
            this.renderer=new THREE.WebGLRenderer({ canvas, antialias:true });
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.renderer.shadowMap.enabled=true;
            // Improve lava texture quality at grazing angles
            try {
                const aniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy?.() || 4);
                if (this.lavaUniforms?.tNoise?.value) this.lavaUniforms.tNoise.value.anisotropy = aniso;
                if (this.lavaUniforms?.tDiffuse?.value) this.lavaUniforms.tDiffuse.value.anisotropy = aniso;
            } catch {}
            
            this.particleSystem = new ParticleSystem(this.scene);

            this.setupLighting();
            await RAPIER.init();
            this.world=new RAPIER.World(CONFIG.physics.gravity);
            // Sandbox physics ground (after world init)
            if (this.cfg.sandbox){
                const groundBodyDesc=RAPIER.RigidBodyDesc.fixed().setTranslation(0,-0.1,0);
                const groundBody=this.world.createRigidBody(groundBodyDesc);
                const groundColliderDesc=RAPIER.ColliderDesc.cuboid(1000,0.1,1000); // half-extents for 2000 plane
                this.world.createCollider(groundColliderDesc, groundBody);
                // Build additional sandbox playground objects
                this._buildSandboxEnvironment();
            }
            // Create global lava sensor collider (not in sandbox only, used anywhere we have lava plane)
            try {
                const lv = CONFIG.lava;
                if (!this.cfg.sandbox) {
                    const lavaBodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(0, lv.surfaceY - lv.thickness/2, 0);
                    this._lavaBody = this.world.createRigidBody(lavaBodyDesc);
                    const lavaColliderDesc = RAPIER.ColliderDesc.cuboid(lv.halfSize, lv.thickness/2, lv.halfSize)
                        .setSensor(true);
                    this._lavaCollider = this.world.createCollider(lavaColliderDesc, this._lavaBody);
                    GameLogger.lava('Lava sensor collider initialized.');
                }
            } catch(e){
                reportError('lava_setup','Failed to create lava collider', e);
            }
            this.debug=new Debug(this.scene, RAPIER);
            // Expose globally so logger can snapshot player state
            window.gameInstance = this;
            this.inputManager=new InputManager();
            this.uiManager=new UIManager();
            this.playerController=new CharacterController(
                this.scene, this.world, RAPIER, this.debug,
                this.inputManager, this.uiManager, this
            );

            this.resetGame();
            
            // FIXED: Await model loading completion
            await this.playerController.loadModel();
            
            // FIXED: Only create physics after model is ready
            this.playerController.createPhysicsBody();
        // Initialize platform runtime arrays
        this._spiralPlatformTempVec = new THREE.Vector3();
            this.uiManager.updateHealth(this.cfg.player.maxHealth, this.cfg.player.maxHealth);
            this.uiManager.updateSprint(this.cfg.player.maxSprint, this.cfg.player.maxSprint);
            this.thirdPersonCamera=new ThirdPersonCamera(this.camera, this.playerController.model);
            // Initialize camera yaw from current player rotation
            try { this.thirdPersonCamera.yaw = this.playerController.model.rotation.y || 0; } catch {}
            this.lastFrameTime=performance.now();
        GameLogger.lifecycle('Initialization complete.');
        // Prime a zero-delta physics step so early key taps (like an immediate dash) aren't lost before first animate loop
        try { this.playerController?.fixedUpdate(0); } catch {}
        // Do not start animate loop until a level start requested
    } catch(e){
        reportError('init', 'Initialization failed',  e);
        
        // FIXED: Show specific error for model loading failures
        const errorMsg = e.message?.includes('model') || e.message?.includes('glTF')
            ? 'Failed to load character model. Please check your internet connection.'
            : 'Failed to load game assets.';
            
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);color:white;background:rgba(0,0,0,0.9);padding:30px;border:2px solid red;border-radius:8px;font-family:sans-serif;text-align:center;';
        overlay.innerHTML = `<h2>Error</h2><p>${errorMsg}</p><p>Please refresh the page to try again.</p>`;
        document.body.appendChild(overlay);
        return; // Halt execution
    }

        window.addEventListener('resize', ()=>this.onResize());
    }
    startLevel(level){
        if (level) this.currentLevel=level;
        GameLogger.lifecycle(`Starting level: ${level.id}`);
        if (!this.scene){
            // Not yet initialized
            this.init(level).then(()=>{
                this.running=true; this.lastFrameTime=performance.now(); this.animate();
            });
            return;
        }
        // Refresh cfg if a new runtimeConfig was prepared by menu
        this.cfg = window.runtimeConfig ? structuredClone(window.runtimeConfig) : structuredClone(BASE_CONFIG);
    // If we are already initialized and sandbox mode toggled, rebuild environment on the fly
        const currentlySandbox = !!this.scene && !!this.sandboxDynamicObjects; // heuristic
        const wantsSandbox = !!this.cfg.sandbox;
        if (wantsSandbox && !currentlySandbox){
            GameLogger.lifecycle('Entering sandbox mid-session: constructing playground.');
            try { this._clearSandboxEnvironment?.(); } catch {}
            try { this._buildSandboxEnvironment(); } catch(e){ reportError('sandbox_build','Failed to build sandbox mid-session', e); }
        } else if (!wantsSandbox && currentlySandbox){
            GameLogger.lifecycle('Leaving sandbox mid-session: removing playground objects.');
            try { this._clearSandboxEnvironment?.(); } catch(e){ reportError('sandbox_cleanup','Failed to clear sandbox objects', e); }
        }
    // Ensure background music reflects current mode
    this._updateBgmForMode();
    this._setupLevelStart();
        this.running=true;
        this.lastFrameTime=performance.now();
        const inst=document.getElementById('instructions'); if (inst) inst.style.display='none';
        if (!this._animating){ this.animate(); }
        // Hide cursor during gameplay session
        document.body.style.cursor='none';
    }
    /**
     * Internal helper: prepares a playable state (track, spawn position, score reset).
     * Used by both initial level start and player respawn to avoid duplication.
     */
    _setupLevelStart(){
        GameLogger.action('Setup level start');
        
        // Clear prior procedural content
        this.resetGame();

        // Ensure game over screen is hidden when starting a new level
        this.uiManager?.hideGameOver();

        // Translate level: one-time per run uniform type roll
        if (this.currentLevel?.id === 'translate') {
            const mpCfg = this.cfg?.movingPlatformConfig || {};
            const chance = Number(mpCfg.uniformTypeChance);
            if (Number.isFinite(chance) && chance > 0) {
                const hit = Math.random() < Math.min(1, Math.max(0, chance));
                if (hit) {
                    // Determine uniform type: explicit or random from allowed list
                    let uType = mpCfg.uniformType || 'random';
                    if (uType === 'random') {
                        const allowed = Array.isArray(mpCfg.movementTypes) && mpCfg.movementTypes.length>0
                            ? mpCfg.movementTypes.slice()
                            : ['TranslateX','TranslateY','RotateX','RotateZ','RotateXFree','RotateZFree','SpinCW','SpinCCW'];
                        uType = allowed[Math.floor(Math.random() * allowed.length)];
                    }
                    this.translateUniformType = uType;
                } else {
                    this.translateUniformType = null;
                }
                GameLogger.track(`Translate uniform type roll`, { hit, type: this.translateUniformType || 'none' });
            } else {
                this.translateUniformType = null;
            }
        } else {
            this.translateUniformType = null;
        }
        
        // Generate initial forward buffer of segments (not for sandbox)
        if (!this.cfg.sandbox){
            this.updateTrack();
        }
        
        // Determine spawn point from first segment (fallback to default)
        let startPos = { x: 0, y: 5, z: 0 };
        if (this.trackSegments.length > 0){
            const firstSegment = this.trackSegments[0];
            const segmentPos = firstSegment.threeMeshes[0].position;
            startPos = { x: segmentPos.x, y: segmentPos.y + 5, z: segmentPos.z };
            GameLogger.action(`Spawn position determined from track: ${JSON.stringify(startPos)}`);
        }
        
        if (this.playerController){
            this.playerController.teleportTo(startPos);
            // Ensure player is oriented correctly like on game init
            this.playerController.resetPlayerOrientation();
        }

        // Ensure all crumble platforms are in standby state
        if (this.cfg?.track?.crumbleMode) {
            this.resetCrumblePlatforms();
        }
        
        this.score = 0;
        this.uiManager?.updateScore(0);
        
        // SHOW GAME UI ELEMENTS
        const gameUI = document.getElementById('game-ui');
        const scoreDisplay = document.getElementById('score-display');
        const timeDisplay = document.getElementById('time-display');
        
        if (gameUI) gameUI.style.display = 'block';
        
        // Show/hide score and timer based on sandbox mode
        if (this.cfg.sandbox){
            if (scoreDisplay) scoreDisplay.style.display = 'none';
            if (timeDisplay) timeDisplay.style.display = 'none';
        } else {
            if (scoreDisplay) scoreDisplay.style.display = 'block';
            if (timeDisplay) timeDisplay.style.display = 'block';
        }
        
        // Reset timer display and state
        this.timerRunning = false;
        this.elapsedTime = 0;
        if (this.timerElement) {
            this.timerElement.textContent = '00:00.000';
        }
        
        // Delay audio playback for first seconds of a fresh start
        this.audioMuteUntil = performance.now() + 2000; // ms
        
        // Call in game initialization (e.g., in _setupLevelStart() or constructor)
        if (this.currentLevel?.id === 'rising_lava') {
            this.createRisingLava();
            this.currentLavaHeight = CONFIG.risingLava.START_HEIGHT;
            // Reset instance-local rising lava speed each run for fairness
            this._risingLavaSpeed = (this.cfg?.risingLava?.RISE_SPEED) ?? CONFIG.risingLava.RISE_SPEED;
            this.risingLavaActive = true;
        } else {
            this.risingLavaActive = false;
            // Ensure regular lava mesh exists for non-sandbox, non-rising-lava levels
            if (!this.cfg.sandbox && !this.lavaMesh) {
                // Recreate the regular lava mesh if it was removed by rising lava
                const lavaGeometry = new THREE.PlaneGeometry(10000, 10000, 150, 150);
                
                // Load textures to emulate Babylon's LavaMaterial look
                const texLoader = new THREE.TextureLoader();
                const noiseTex = texLoader.load('https://threejs.org/examples/textures/lava/cloud.png');
                const diffuseTex = texLoader.load('https://threejs.org/examples/textures/lava/lavatile.jpg');
                // Texture params
                [noiseTex, diffuseTex].forEach(t => {
                    if (!t) return;
                    t.wrapS = t.wrapT = THREE.RepeatWrapping;
                    t.minFilter = THREE.LinearMipmapLinearFilter;
                    t.magFilter = THREE.LinearFilter;
                });

                // Shader uniforms (black + oranges) + textures
                this.lavaUniforms = {
                    uTime:   { value: 0.0 },
                    uColor1: { value: new THREE.Color(0x000000) }, // black crust
                    uColor2: { value: new THREE.Color(0xff4500) }, // deep orange
                    uColor3: { value: new THREE.Color(0xff6a00) }, // hot orange
                    tNoise:  { value: noiseTex },
                    tDiffuse:{ value: diffuseTex }
                };

                const lavaMaterial = new THREE.ShaderMaterial({
                    uniforms: this.lavaUniforms,
                    vertexShader: `
                        uniform float uTime;
                        varying vec2 vUv;
                        varying vec2 vWorldXZ;
                        void main() {
                            vUv = uv;
                            // Compute world position to drive infinite noise in fragment
                            vec4 worldPos = modelMatrix * vec4(position, 1.0);
                            vWorldXZ = worldPos.xz;

                            // Super-slow, subtle waves (vertex displacement only)
                            float waveSpeed = 0.5;
                            float waveStrength = 0.25;
                            float displacement = sin(position.x * 1.2 + uTime * waveSpeed) * waveStrength;
                            displacement += cos(position.z * 1.0 + uTime * waveSpeed * 0.7) * waveStrength * 0.5;
                            vec3 newPosition = position;
                            newPosition.y += displacement;
                            gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
                        }
                    `,
                    fragmentShader: `
                        uniform float uTime;
                        uniform sampler2D tNoise;
                        uniform sampler2D tDiffuse;
                        uniform vec3 uColor1; // black
                        uniform vec3 uColor2; // deep orange
                        uniform vec3 uColor3; // hot orange
                        varying vec2 vUv;
                        varying vec2 vWorldXZ;

                        // Helpers
                        float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
                        mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

                        void main(){
                            // World-space basis. Lower scale => larger features, less obvious tiling
                            vec2 w = vWorldXZ * 0.008;

                            // Slightly faster (still slow) opposing scrolls to ensure visible motion
                            vec2 s1 = vec2(uTime * 0.020, 0.0);
                            vec2 s2 = vec2(0.0, -uTime * 0.017);
                            vec2 s3 = vec2(-uTime * 0.012, uTime * 0.008);

                            // Domain warping via blended noise samples
                            vec2 nA = texture2D(tNoise, w * 0.6 + s1).rg;
                            vec2 nB = texture2D(tNoise, w * 1.3 + s2).rb;
                            vec2 nMix = (nA + nB) * 0.5; // 0..1
                            vec2 warp = (nMix - 0.5) * 0.9; // -0.45..0.45

                            // Time-varying small rotations per layer (subtle swirl)
                            float a1 = sin(uTime * 0.12) * 0.12;
                            float a2 = cos(uTime * 0.09) * 0.15;
                            mat2 r1 = rot(a1);
                            mat2 r2 = rot(a2);

                            // Two differently scaled, rotated, and warped UV layers
                            vec2 uv1 = r1 * (w * 1.15 + warp * 0.7) + s1 * 0.35;
                            vec2 uv2 = r2 * (w * 1.85 - warp * 0.5) + s2 * 0.30;

                            vec3 tex1 = texture2D(tDiffuse, uv1).rgb;
                            vec3 tex2 = texture2D(tDiffuse, uv2).rgb;

                            // Combine layers to break repetition
                            vec3 base = mix(tex1, tex2, 0.5);

                            // Additional soft modulation using a third noise sample
                            float nM = texture2D(tNoise, w * 0.9 + s3).r; // 0..1
                            float intensity = luma(base);
                            intensity *= mix(0.85, 1.15, nM); // slight variance

                            // Map to black/orange palette (tuned thresholds for contrast)
                            float t1 = smoothstep(0.28, 0.58, intensity);
                            float t2 = smoothstep(0.58, 0.80, intensity);
                            vec3 col = mix(uColor1, uColor2, t1);
                            col = mix(col, uColor3, t2);

                            gl_FragColor = vec4(col, 1.0);
                        }
                    `,
                    depthWrite: true,
                    side: THREE.DoubleSide
                });

                this.lavaMesh = new THREE.Mesh(lavaGeometry, lavaMaterial);
                this.lavaMesh.rotation.x = -Math.PI / 2;
                this.lavaMesh.position.y = CONFIG.lava.surfaceY;
                this.lavaMesh.receiveShadow = true;
                this.scene.add(this.lavaMesh);

                // Set texture anisotropy for better quality
                try {
                    const aniso = Math.min(8, this.renderer?.capabilities?.getMaxAnisotropy?.() || 4);
                    if (this.lavaUniforms.tNoise?.value) this.lavaUniforms.tNoise.value.anisotropy = aniso;
                    if (this.lavaUniforms.tDiffuse?.value) this.lavaUniforms.tDiffuse.value.anisotropy = aniso;
                } catch {}
                
                GameLogger.lava('Regular lava mesh recreated for non-rising-lava level');
            }
        }
        
        GameLogger.action('Game UI elements shown');
    }
    // ===== Pause System =====
    togglePause(){
        console.log(`[GameMenu] Toggle pause: ${this.isPaused ? 'resume' : 'pause'}`);
        GameLogger.action(`Toggle pause: ${this.isPaused ? 'resume' : 'pause'}`);
        this.isPaused ? this.resumeGame() : this.pauseGame(true);
    }
    pauseGame(showMenu=true){
        console.log(`[GameMenu] Pausing game (showMenu: ${showMenu})`);
        if (this.isPaused || !this.running) return;
        GameLogger.action(`Pause game (showMenu: ${showMenu})`);
        this.isPaused=true;
        
        // Stop backup beep when pausing
        if (this.audioManager?.backupBeepPlaying) {
            this.audioManager.stopBackupBeep();
        }
        // Stop lava hurt loop when pausing
        try { this.audioManager?.stopLavaHurtLoop(); } catch(e){}
        // Stop lava ambient loop when paused
        this._stopLavaLoop();
        
        // FIXED: Capture elapsed time at pause moment
        if (this.timerRunning) {
            this.elapsedTime = (performance.now() - this.startTime) - this.totalPausedTime;
            this.pauseStartTime = performance.now(); // Track when pause began
        }

        document.body.style.cursor='default';

        if (showMenu){
            const pm=document.getElementById('pause-menu');
            if (pm){
                pm.style.display='flex';
                menuNavigator.setMenu('pause-menu');
                console.log('[GameMenu] Pause menu displayed');
                GameLogger.action('Pause menu displayed');
            }
        }
        try { if (this.thirdPersonCamera?.isLocked) document.exitPointerLock(); } catch {}
        GameLogger.lifecycle('Game paused.');
        logger?.logInput('game_paused',{ score:this.score, elapsedTime: this.elapsedTime });
    }
    resumeGame(){
        console.log('[GameMenu] Resuming game');
        if (!this.isPaused) return;
        GameLogger.action('Resume game');
        
        // Resume lava loop when unpaused (if not sandbox)
        this._updateBgmForMode();
        
        // FIXED: Accumulate total paused time instead of adjusting startTime multiple times
        if (this.timerRunning) {
            const pauseDuration = performance.now() - this.pauseStartTime;
            this.totalPausedTime += pauseDuration; // Accumulate to prevent drift
            GameLogger.lifecycle(`Resumed - pause duration: ${pauseDuration.toFixed(0)}ms, total paused: ${this.totalPausedTime.toFixed(0)}ms`);
        }
        
        this.isPaused=false;
        const pm=document.getElementById('pause-menu');
        if (pm) pm.style.display='none';
        menuNavigator.clear();
        
        // FIXED: Update lastFrameTime to prevent dt spike
        this.lastFrameTime = performance.now();
        
        // Request pointer lock when resuming, like level selection
        setTimeout(() => {
            try {
                const canvas = document.getElementById('three-canvas');
                if (canvas && canvas.requestPointerLock) {
                    canvas.requestPointerLock();
                }
            } catch(e) { console.warn('Pointer lock request failed:', e); }
        }, 100);
        
        logger?.logInput('game_resumed',{ pauseDuration: this.pauseStartTime ? Math.round(performance.now() - this.pauseStartTime) : 0 });
        document.body.style.cursor='none';
    }
    restartFromPause(){
        console.log('[GameMenu] Restarting from pause menu');
        GameLogger.action('Restart from pause menu');
        this.isPaused=false; const pm=document.getElementById('pause-menu'); if (pm) pm.style.display='none'; menuNavigator.clear();
        this.playerController?.respawn();
    // pointer lock removed
    }
    returnToMenuFromPause(){
        console.log('[GameMenu] Returning to main menu from pause');
        GameLogger.action('Return to menu from pause');
        this.isPaused=false; 
        const pm=document.getElementById('pause-menu'); 
        if (pm) pm.style.display='none';
        menuNavigator.clear();
        
        // Reset player orientation to original state
        this.playerController?.resetPlayerOrientation();
        
        // Stop backup beep when returning to menu
        if (this.audioManager?.backupBeepPlaying) {
            this.audioManager.stopBackupBeep();
        }
        // Stop lava hurt loop when returning to menu
        try { this.audioManager?.stopLavaHurtLoop(); } catch(e){}
        
        // Fully cleanup game to ensure nothing runs in background
        try { this.cleanup(); } catch(e){ reportError('cleanup','Failed during returnToMenuFromPause cleanup', e); }
        // Drop global reference so new sessions create a fresh Game()
        try { if (window.gameInstance === this) window.gameInstance = null; } catch {}

        // Ensure pointer lock is released
        try { if (this.thirdPersonCamera?.isLocked) document.exitPointerLock(); } catch {}
        // Stop lava loop when returning to menu
        this._stopLavaLoop();
        window.menuManager?.returnToMenu?.();
    }

    returnToMenuFromGameOver() {
        console.log('[GameMenu] Returning to menu from game over');
        GameLogger.action('Return to menu from game over');
        this.running = false;
        this.isPaused = false;

        // Stop backup beep when returning to menu from game over
        if (this.audioManager?.backupBeepPlaying) {
            this.audioManager.stopBackupBeep();
        }
        // Stop lava hurt loop when returning to menu from game over
        try { this.audioManager?.stopLavaHurtLoop(); } catch(e){}

        if (this.playerController) {
            // Manually hide the UI here to ensure it's gone before the menu shows up.
            this.playerController.uiManager?.hideGameOver();

            this.playerController.health = this.cfg.player.maxHealth;
            this.playerController.sprint = this.cfg.player.maxSprint;
            this.playerController.uiManager?.updateHealth(this.playerController.health, this.cfg.player.maxHealth);
            this.playerController.uiManager?.updateSprint(this.playerController.sprint, this.cfg.player.maxSprint);
            this.playerController.fsm.setState(STATES.IDLE); // This will also call hideGameOver in exit(), which is fine.
        }

        // Stop lava loop on game over return
        this._stopLavaLoop();
        // Fully cleanup game to ensure nothing runs in background
        try { this.cleanup(); } catch(e){ reportError('cleanup','Failed during returnToMenuFromGameOver cleanup', e); }
        // Drop global reference so new sessions create a fresh Game()
        try { if (window.gameInstance === this) window.gameInstance = null; } catch {}
        window.menuManager?.returnToMenu();
    }

    showSettings(){
        // Settings are now in unified menu - this function is deprecated
        console.log('[GameMenu] Settings now in unified menu');
        GameLogger.action('Settings accessed via unified menu');
        document.body.style.cursor='default';
    }
    setupPauseListeners(){
        if (this._pauseListenersAttached) return; this._pauseListenersAttached=true;
        
        // --- FIX: Centralized and context-aware Escape key handling ---
        // Bound escape handler (stored so it can be removed on cleanup)
        this._onEscapeKey = (e) => {
            if (e.code !== 'Escape') return;

            const pauseMenu = document.getElementById('pause-menu');
            const unifiedMenu = document.getElementById('unified-menu');
            // If unified menu is open, don't handle escape (let menu handle its own navigation)
            if (unifiedMenu && getComputedStyle(unifiedMenu).display === 'flex') {
                return;
            }

            // If the game is running (not in a pre-game menu), toggle pause/resume.
            if (this.running){
                e.preventDefault();
                const isDead = this.playerController?.fsm?.current instanceof DeadState;
                if (!isDead){
                    GameLogger.input('Escape key: Toggle pause');
                    this.togglePause();
                }
            }
        };
        document.addEventListener('keydown', this._onEscapeKey);

        // store references to button handlers so they can be removed later
        const _btnResume = document.getElementById('btn-resume');
        if (_btnResume){
            this._btnResumeHandler = () => { GameLogger.input('Click: Resume button'); this.resumeGame(); };
            _btnResume.addEventListener('click', this._btnResumeHandler);
        }
        const _btnRestart = document.getElementById('btn-restart-pause');
        if (_btnRestart){
            this._btnRestartHandler = () => { GameLogger.input('Click: Restart button (pause menu)'); this.restartFromPause(); };
            _btnRestart.addEventListener('click', this._btnRestartHandler);
        }
        // Open unified settings while paused
        document.getElementById('btn-settings-pause')?.addEventListener('click', ()=>{
            console.log('[GameMenu] Settings button clicked (pause menu)');
            GameLogger.input('Click: Settings button (pause menu)');
            const pm=document.getElementById('pause-menu');
            if (pm) pm.style.display='none';
            // Open unified menu in pause context and direct to settings
            try {
                if (window.menuManager?.showMainMenu) {
                    window.menuManager.showMainMenu({ fromPause: true, sectionId: 'settings-section' });
                } else {
                    window.menuManager?.showMainMenu?.();
                    window.menuManager?.showSection?.('settings-section');
                }
                // Show back-to-game button explicitly if available
                const backBtn = document.getElementById('btn-back-to-pause');
                if (backBtn) backBtn.style.display = 'inline-block';
            } catch{}
        });
        document.getElementById('btn-menu-pause')?.addEventListener('click', ()=>{
            console.log('[GameMenu] Menu button clicked (pause menu)');
            GameLogger.input('Click: Menu button (pause menu)');
            this.returnToMenuFromPause();
        });
        // Settings menu back button removed - settings now in unified menu
    }
    populateSettings(){
        GameLogger.action('Populate settings values');
        const set=(id,val)=>{ const el=document.getElementById(id); if (el) el.value=val; };
        const txt=(id,val)=>{ const el=document.getElementById(id); if (el) el.textContent=val; };
        set('sens-x', this.settings.cameraSensitivityX); txt('sens-x-value', this.settings.cameraSensitivityX.toFixed(3));
        set('sens-y', this.settings.cameraSensitivityY); txt('sens-y-value', this.settings.cameraSensitivityY.toFixed(3));
    const inv=document.getElementById('invert-pitch'); if (inv) inv.checked=!!this.settings.invertPitch;
    const forklift=document.getElementById('forklift-noise'); if (forklift) forklift.checked=!!this.settings.forkliftNoise;
        set('vol-master', Math.round(this.settings.masterVolume*100)); txt('vol-master-value', Math.round(this.settings.masterVolume*100)+'%');
        set('vol-music', Math.round(this.settings.musicVolume*100)); txt('vol-music-value', Math.round(this.settings.musicVolume*100)+'%');
        set('vol-sfx', Math.round(this.settings.sfxVolume*100)); txt('vol-sfx-value', Math.round(this.settings.sfxVolume*100)+'%');
        ['setting-shadows','setting-particles','setting-fog'].forEach(id=>{ const el=document.getElementById(id); if (el){ el.checked=this.settings[id.split('setting-')[1]] ?? true; }});
        this.setupSettingsListeners();
    }
    setupSettingsListeners(){
        if (this._settingsListenersAttached) return; this._settingsListenersAttached=true;
        this._settingsListeners = [];
        const on=(id,ev,fn)=>{ const el=document.getElementById(id); if (el){ el.addEventListener(ev,fn); this._settingsListeners.push({ el, ev, fn }); } };
    on('sens-x','input',e=>{ const v=parseFloat(e.target.value); this.updateCameraSettings(v, undefined, undefined); document.getElementById('sens-x-value').textContent=v.toFixed(3); });
    on('sens-y','input',e=>{ const v=parseFloat(e.target.value); this.updateCameraSettings(undefined, v, undefined); document.getElementById('sens-y-value').textContent=v.toFixed(3); });
    on('invert-pitch','change',e=>{ this.updateCameraSettings(undefined, undefined, !!e.target.checked); });
    on('vol-master','input',e=>{ const v=parseInt(e.target.value)/100; this.settings.masterVolume=v; document.getElementById('vol-master-value').textContent=Math.round(v*100)+'%'; this._updateAudioVolumes(); });
    on('vol-music','input',e=>{ const v=parseInt(e.target.value)/100; this.settings.musicVolume=v; document.getElementById('vol-music-value').textContent=Math.round(v*100)+'%'; this._updateAudioVolumes(); });
    on('vol-sfx','input',e=>{ const v=parseInt(e.target.value)/100; this.settings.sfxVolume=v; document.getElementById('vol-sfx-value').textContent=Math.round(v*100)+'%'; this._updateAudioVolumes(); this.saveSettings(); });
        on('setting-shadows','change',e=>{ this.settings.shadows=e.target.checked; if (this.renderer) this.renderer.shadowMap.enabled=e.target.checked; });
        on('setting-particles','change',e=>{ this.settings.particles=e.target.checked; });
        on('setting-fog','change',e=>{ this.settings.fog=e.target.checked; if (this.scene){ this.scene.fog = e.target.checked ? new THREE.Fog(0x1a0800,50,250) : null; } });
        
        // Data reset with confirmation
        let resetClickCount = 0;
        let resetTimeout = null;
        on('btn-reset-data', 'click', () => {
            const confirmText = document.getElementById('reset-confirm-text');
            resetClickCount++;
            
            if (resetClickCount === 1) {
                // First click - show confirmation
                if (confirmText) confirmText.style.display = 'block';
                GameLogger.action('Reset data - awaiting confirmation');
                
                // Reset counter after 3 seconds
                resetTimeout = setTimeout(() => {
                    resetClickCount = 0;
                    if (confirmText) confirmText.style.display = 'none';
                }, 3000);
            } else if (resetClickCount === 2) {
                // Second click - actually reset
                clearTimeout(resetTimeout);
                resetClickCount = 0;
                if (confirmText) confirmText.style.display = 'none';
                
                GameLogger.action('Reset data confirmed - clearing all save data');
                
                // Clear localStorage
                try {
                    localStorage.removeItem('lavaRunner_save');
                    localStorage.removeItem('lavaRunner_settings');
                    console.log('✅ All save data cleared');
                    
                    // Show success message
                    alert('All data has been reset! The page will now reload.');
                    
                    // Reload page to reset everything
                    window.location.reload();
                } catch (e) {
                    console.error('Failed to reset data:', e);
                    alert('Failed to reset data. Please try again.');
                }
            }
        });
    }
    saveSettings(){ 
        GameLogger.action('Save settings to localStorage');
        try { 
            localStorage.setItem('lavaRunner_settings', JSON.stringify(this.settings)); 
            logger?.logInput('settings_saved', this.settings); 
        } catch(e){ 
            GameLogger.action('Settings save failed'); 
            console.warn('Settings save failed', e); 
        } 
    }
    // Centralized method to update camera settings and synchronize all references
    updateCameraSettings(sensitivityX, sensitivityY, invertPitch) {
        if (sensitivityX !== undefined) {
            this.settings.cameraSensitivityX = sensitivityX;
            CONFIG.camera.sensitivityX = sensitivityX;
            if (this.thirdPersonCamera) {
                this.thirdPersonCamera.sensitivity.x = sensitivityX;
            }
        }
        if (sensitivityY !== undefined) {
            this.settings.cameraSensitivityY = sensitivityY;
            CONFIG.camera.sensitivityY = sensitivityY;
            if (this.thirdPersonCamera) {
                this.thirdPersonCamera.sensitivity.y = sensitivityY;
            }
        }
        if (invertPitch !== undefined) {
            this.settings.invertPitch = invertPitch;
            if (this.thirdPersonCamera) {
                this.thirdPersonCamera.invertPitch = invertPitch;
            }
        }
        GameLogger.action('Camera settings updated', { sensitivityX, sensitivityY, invertPitch });
    }
    _updateAudioVolumes(){
        const masterVol = this.settings.masterVolume ?? 0.7;
        const musicVol = this.settings.musicVolume ?? 0.8;
        const sfxVol = this.settings.sfxVolume ?? 0.8;
        
        try {
            // Update lava loop volume (ambient music) - FIXED: Always update if playing
            if (this.lavaAudio) {
                const ambientVolume = masterVol * musicVol * 0.3; // 30% for ambient
                this.lavaAudio.setVolume(Math.max(0, Math.min(1, ambientVolume)));
                
                // CRITICAL FIX: If master volume is 0, pause the audio to ensure silence
                if (masterVol <= 0) {
                    if (this.lavaAudio.isPlaying) {
                        this.lavaAudio.pause();
                        this.lavaLoopPlaying = false;
                        console.log('🎵 Lava loop paused due to master volume = 0');
                    }
                } else {
                    // Resume if it was paused due to volume and should be playing
                    if (!this.lavaAudio.isPlaying && this.lavaLoopPlaying) {
                        this.lavaAudio.play();
                        console.log('🎵 Lava loop resumed');
                    }
                }
            }
            
            // Legacy BGM support (if any)
            if (this.bgmAudio) {
                const bgmVolume = masterVol * musicVol;
                this.bgmAudio.volume = Math.max(0, Math.min(1, bgmVolume));
                
                // Also pause/resume legacy audio for master volume 0
                if (masterVol <= 0) {
                    if (!this.bgmAudio.paused) {
                        this.bgmAudio.pause();
                        console.log('🎵 Legacy BGM paused due to master volume = 0');
                    }
                } else {
                    if (this.bgmAudio.paused && this.lavaLoopPlaying) {
                        this.bgmAudio.play().catch(() => {});
                        console.log('🎵 Legacy BGM resumed');
                    }
                }
            }
            
            // Update AudioManager volumes for procedural SFX
            if (this.audioManager) {
                // Use the new centralized method for better control
                this.audioManager.updateMasterVolume(masterVol, sfxVol);
            }
            
            // Update any existing stone slide audio instances
            if (this.stoneSlideAudio && this.stoneSlideAudio.isPlaying) {
                const stoneVolume = masterVol * sfxVol * 0.4; // Stone slide at 40% of SFX volume
                this.stoneSlideAudio.setVolume(Math.max(0, Math.min(1, stoneVolume)));
            }
            
            console.log('🎵 Audio volumes updated:', { 
                master: masterVol, 
                music: musicVol, 
                sfx: sfxVol,
                effective_music: masterVol * musicVol,
                effective_sfx: masterVol * sfxVol,
                lava_playing: this.lavaAudio?.isPlaying ?? false
            });
            
        } catch(e) {
            console.warn('Failed to update audio volumes:', e);
        }
    }
    loadSettings(){
        GameLogger.action('Load settings from localStorage');
        try {
            const saved = localStorage.getItem('lavaRunner_settings');
            if (!saved) {
                GameLogger.action('No saved settings found, using defaults');
                return;
            }
            const parsed = JSON.parse(saved);
            this.settings = { ...this.settings, ...(parsed || {}) };
            // Update camera settings using centralized method
            this.updateCameraSettings(
                this.settings.cameraSensitivityX,
                this.settings.cameraSensitivityY,
                this.settings.invertPitch
            );
            // Back-compat: migrate legacy invertYaw -> invertPitch if present
            if (this.settings.invertYaw !== undefined && this.settings.invertPitch === undefined) {
                this.settings.invertPitch = !!this.settings.invertYaw;
                delete this.settings.invertYaw;
            }
            // If camera already exists, apply loaded invertPitch
            if (this.thirdPersonCamera) this.thirdPersonCamera.invertPitch = !!this.settings.invertPitch;
            GameLogger.action('Settings loaded successfully');
        } catch(e){
            GameLogger.action('Failed to load settings, using defaults');
            console.warn('Failed to load settings', e);
        }
    }
    // ===== Level Completion =====
    checkLevelCompletion(){ if (this.levelCompleted) return; if (this.score >= this.levelGoal){ this.levelCompleted=true; this.onLevelComplete(); } }
    onLevelComplete(){
        console.log(`[GameMenu] Level complete! Final score: ${this.score}`);
        GameLogger.lifecycle(`Level complete! Final score: ${this.score}`);
        this.pauseGame(false); const existing=document.getElementById('level-complete-overlay'); if (existing) existing.remove(); const overlay=document.createElement('div'); overlay.id='level-complete-overlay'; overlay.className='screen-overlay'; overlay.style.display='flex'; overlay.innerHTML=`<div class="menu-container"><h1 class="screen-title" style="color:#2ecc71;">LEVEL COMPLETE!</h1><p style="color:#fff; font-size:28px;">Final Score: ${this.score}</p><p style="color:#3498db; font-size:24px; margin:20px 0;">Best: ${(typeof saveManager!=='undefined' && this.currentLevel)? saveManager.getBestScore(this.currentLevel.id): this.score}</p><button id="btn-next-level" class="btn btn-primary btn-large">NEXT LEVEL</button><button id="btn-retry-level" class="btn btn-secondary btn-medium">RETRY</button><button id="btn-menu-complete" class="btn btn-alt btn-medium">MAIN MENU</button></div>`; (document.getElementById('dynamic-overlays')||document.body).appendChild(overlay); if (typeof LEVELS!=='undefined' && this.currentLevel){ const idx=LEVELS.findIndex(l=>l.id===this.currentLevel.id); if (idx>=0 && idx<LEVELS.length-1){ const next=LEVELS[idx+1]; saveManager?.unlockLevel?.(next.id); } saveManager?.saveLevelScore?.(this.currentLevel.id, this.score); }
        document.getElementById('btn-next-level')?.addEventListener('click',()=>{ 
            console.log('[GameMenu] Next level button clicked');
            GameLogger.input('Click: Next level button');
            overlay.remove(); 
            this.startNextLevel(); 
        });
        document.getElementById('btn-retry-level')?.addEventListener('click',()=>{ 
            console.log('[GameMenu] Retry level button clicked');
            GameLogger.input('Click: Retry level button');
            overlay.remove(); 
            this.levelCompleted=false; 
            this.restartFromPause(); 
        });
        document.getElementById('btn-menu-complete')?.addEventListener('click',()=>{ 
            console.log('[GameMenu] Main menu button clicked (level complete)');
            GameLogger.input('Click: Menu button (level complete)');
            overlay.remove(); 
            this.returnToMenuFromPause(); 
        });
        menuNavigator.setMenu('level-complete-overlay');
    }
    startNextLevel(){ 
        console.log('[GameMenu] Starting next level');
        GameLogger.action('Start next level');
        if (typeof LEVELS==='undefined' || !this.currentLevel){ 
            console.warn('[GameMenu] No levels defined or current level, returning to menu');
            GameLogger.action('No levels defined or current level, returning to menu');
            this.returnToMenuFromPause(); 
            return; 
        } 
        const idx=LEVELS.findIndex(l=>l.id===this.currentLevel.id); 
        if (idx>=0 && idx<LEVELS.length-1){ 
            const next=LEVELS[idx+1]; 
            console.log(`[GameMenu] Loading next level: ${next.id}`);
            GameLogger.action(`Loading next level: ${next.id}`);
            window.menuManager?.startGame?.(next.id); 
        } else { 
            console.log('[GameMenu] All levels complete!');
            GameLogger.action('All levels complete!');
            alert('All levels complete!'); 
            this.returnToMenuFromPause(); 
        } 
    }
    _hotkeys(e){
        if (!this.running) return;
        const pc=this.playerController; if (!pc) return;
        if (e.code==='KeyR'){
            e.preventDefault();
            GameLogger.input('Hotkey: R (restart level)');
            // Immediate full restart always, regardless of dead/paused
            this.restartLevel();
            return;
        }
        if (e.code==='KeyM' && e.shiftKey){ 
            e.preventDefault(); 
            GameLogger.input('Hotkey: Shift+M (return to menu)');
            this.returnToMenuFromPause(); 
        }
    }

    setupLighting(){
        this.scene.add(new THREE.AmbientLight(0xffffff,0.7));
        const hemi=new THREE.HemisphereLight(0xffffff, 0x994020, 1.0); // Sky, Lava-ish ground, Intensity
        this.scene.add(hemi);
        const dir=new THREE.DirectionalLight(0xffffff,1.5);
        dir.position.set(5,10,7.5);
        dir.castShadow=true;
        dir.shadow.mapSize.set(2048,2048);
        dir.shadow.camera.near=0.5;
        dir.shadow.camera.far=500;
        dir.shadow.bias=-0.0001;
        dir.shadow.normalBias=0.05;
        // Sandbox: widen shadow camera & raise light to cover large plane
        if (this.cfg?.sandbox){
            dir.position.set(0,50,0);
            dir.target.position.set(0,0,0);
            const shadowArea=100;
            dir.shadow.camera.left=-shadowArea;
            dir.shadow.camera.right=shadowArea;
            dir.shadow.camera.top=shadowArea;
            dir.shadow.camera.bottom=-shadowArea;
            dir.shadow.camera.far=200;
            this.scene.add(dir.target);
        }
        this.scene.add(dir);
    }

    // ===== CRUMBLE SYSTEM =====
    startCrumble(segment) {
        if (!this.cfg?.track?.crumbleMode) return;
        if (!segment?.isCrumblePlatform || !segment.threeMeshes?.[0]) return;
        const mesh = segment.threeMeshes[0];
        if (mesh.userData.crumbleState && mesh.userData.crumbleState !== this.CrumbleState.STABLE) return;

        const cfg = this.cfg.crumble || { delay:1.0, fallDuration:2.5, warningColor:0xFF6600, crumbleColor:0x884400 };

        console.log(`� Platform ${segment.index} - player touched, starting crumble`);

        try {
            GameLogger.track(`Crumble initiated: platform ${segment.index}`, {
                state: 'WARNING',
                delay: this.cfg.crumble?.delay,
                playerPos: this.playerController?.currentTranslation
            });
        } catch {}
        // FIXED: Clear any existing timer for this segment
        if (this.crumbleTimers.has(segment.index)) {
            clearTimeout(this.crumbleTimers.get(segment.index));
        }

    mesh.userData.crumbleState = this.CrumbleState.WARNING;
        mesh.userData.warningTimer = 0;
        mesh.userData.segmentIndex = segment.index;
        mesh.userData.originalColor = mesh.userData.originalColor || mesh.material.color.clone();
        mesh.material.color.setHex(cfg.warningColor);

    // Play the stone slide effect when the timer starts
    this._playCrumbleEffect?.();

        const delayTimer = setTimeout(() => {
            console.log(`🔻 Platform ${segment.index} - starting fall to lava`);
            try {
                GameLogger.track(`Crumble falling: platform ${segment.index}`, {
                    state: 'FALLING',
                    warningDuration: mesh.userData.warningTimer
                });
            } catch {}
            mesh.userData.crumbleState = this.CrumbleState.FALLING;
            mesh.material.color.setHex(cfg.crumbleColor);
            this._convertPlatformToDynamic(segment);
            // FIXED: Remove timer from map after execution
            this.crumbleTimers.delete(segment.index);
        }, (this.cfg.crumble?.delay ?? 1.0) * 1000);

        this.crumbleTimers.set(segment.index, delayTimer);
    }

    _playCrumbleEffect(){
        try {
            if (!this.stoneSlideBuffer || !this.audioListener) return;
            const oneShot = new THREE.Audio(this.audioListener);
            oneShot.setBuffer(this.stoneSlideBuffer);
            const vol = Math.max(0, Math.min(1, (this.settings.masterVolume ?? 0.8) * (this.settings.sfxVolume ?? 0.6)));
            oneShot.setVolume(vol);
            oneShot.setLoop(false);
            oneShot.play();
            // Cleanup after playback ends (best-effort)
            const src = oneShot.source;
            if (src && 'onended' in src) {
                src.onended = ()=>{ try { oneShot.stop(); oneShot.disconnect?.(); } catch{} };
            }
        } catch{}
    }

    updateCrumblePlatforms(dt) {
        if (!this.cfg?.track?.crumbleMode) return;
        // Warning dust puffs during warning state
        for (const seg of this.trackSegments) {
            if (!seg?.isCrumblePlatform) continue;
            const mesh = seg.threeMeshes?.[0];
            if (!mesh) continue;
            if (mesh.userData.crumbleState === this.CrumbleState.WARNING) {
                mesh.userData.warningTimer = (mesh.userData.warningTimer || 0) + dt;
                // Emit small dust hints while warning
                if (this.particleSystem && (mesh.userData.warningTimer % 0.1) < dt) {
                    const width = this.cfg.track.segmentWidth; const length = this.cfg.track.segmentLength;
                    const localX = (Math.random() - 0.5) * width * 0.8; const localZ = (Math.random() - 0.5) * length * 0.8;
                    const particlePos = new THREE.Vector3(localX, 0.3, localZ);
                    particlePos.applyQuaternion(mesh.quaternion); particlePos.add(mesh.position);
                    this.particleSystem.emit({ position: particlePos, count: 2, color: new THREE.Color(0.28,0.22,0.15), speed: 1.5, lifetime: 0.8, spread: new THREE.Vector3(0.5,2,0.5), startScale: 0.1, endScale: 0.02, dustEffect: true, gravity: -1.0 });
                }
            } else if (mesh.userData.crumbleState === this.CrumbleState.FALLING) {
                // Apply a small torque once to add visual tumble
                if (!mesh.userData._tumbled && seg.rapierBody?.isDynamic?.()) {
                    try {
                        seg.rapierBody.applyTorqueImpulse({ x:(Math.random()*2-1)*0.3, y:(Math.random()*2-1)*0.1, z:(Math.random()*2-1)*0.3 }, true);
                        mesh.userData._tumbled = true;
                    } catch {}
                }
                // Destroy when reaching lava
                const lavaY = CONFIG.lava.surfaceY || -50;
                let posY = mesh.position.y;
                try { if (seg.rapierBody) posY = seg.rapierBody.translation().y; } catch {}
                if (posY <= lavaY) {
                    this._destroyFallenPlatform(seg);
                }
            }
        }
    }

    resetCrumblePlatforms() {
        console.log('🔄 Resetting all crumble platforms to standby');
        this.crumbleTimers.forEach(t => clearTimeout(t));
        this.crumbleTimers.clear();
        if (!this.trackSegments) return;
        for (const segment of this.trackSegments) {
            if (!segment?.isCrumblePlatform) continue;
            const mesh = segment.threeMeshes?.[0];
            if (!mesh) continue;
            // Reset visual state
            mesh.visible = true;
            if (segment.height != null) mesh.position.y = segment.height;
            mesh.rotation.x = 0; mesh.rotation.z = 0;
            if (mesh.userData.originalColor) mesh.material.color.copy(mesh.userData.originalColor);
            mesh.userData.crumbleState = this.CrumbleState.STABLE;
            // Rebuild fixed body + collider fresh (simpler and robust)
            // Remove any existing falling/dynamic bodies and colliders
            try { if (mesh.userData.rapierCollider) { this.world.removeCollider(mesh.userData.rapierCollider); mesh.userData.rapierCollider=null; } } catch {}
            try { if (segment.rapierBody) { this.world.removeRigidBody(segment.rapierBody); segment.rapierBody=null; } } catch {}
            try { if (segment.rapierJoint) { this.world.removeImpulseJoint(segment.rapierJoint); segment.rapierJoint=null; } } catch {}
            try { if (segment.rapierHingeBody) { this.world.removeRigidBody(segment.rapierHingeBody); segment.rapierHingeBody=null; } } catch {}
            // Create a new fixed body and collider
            const q = mesh.quaternion; const W = this.cfg.track.segmentWidth/2; const L = this.cfg.track.segmentLength/2;
            const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(mesh.position.x, mesh.position.y, mesh.position.z).setRotation({x:q.x,y:q.y,z:q.z,w:q.w});
            const rb = this.world.createRigidBody(bodyDesc);
            const col = RAPIER.ColliderDesc.cuboid(W, 0.25, L);
            const collider = this.world.createCollider(col, rb);
            segment.rapierBody = rb;
            mesh.userData.rapierCollider = collider;
            mesh.userData.colliderRemoved = false;
            mesh.userData._tumbled = false;
            segment.dynamic = false;
        }
    }

    // Convert a crumble platform into a dynamic rigid body so it can fall and be interacted with
    _convertPlatformToDynamic(segment) {
        const mesh = segment?.threeMeshes?.[0];
        if (!mesh) return;
        // Remove any existing joint/hinge
        try { if (segment.rapierJoint) { this.world.removeImpulseJoint(segment.rapierJoint); segment.rapierJoint = null; } } catch {}
        try { if (segment.rapierHingeBody) { this.world.removeRigidBody(segment.rapierHingeBody); segment.rapierHingeBody = null; } } catch {}
        // Remove old collider and body
        try { if (mesh.userData.rapierCollider) { this.world.removeCollider(mesh.userData.rapierCollider); mesh.userData.rapierCollider = null; } } catch {}
        try { if (segment.rapierBody) { this.world.removeRigidBody(segment.rapierBody); segment.rapierBody = null; } } catch {}
        // Create dynamic body at current transform
        const q = mesh.quaternion; const W = this.cfg.track.segmentWidth/2; const L = this.cfg.track.segmentLength/2;
        const rbDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
            .setRotation({x:q.x,y:q.y,z:q.z,w:q.w})
            .setLinearDamping(0.05)
            .setAngularDamping(1.5);
        const rb = this.world.createRigidBody(rbDesc);
        let colDesc = RAPIER.ColliderDesc.cuboid(W, 0.25, L);
        const density = this.cfg.crumble?.platformDensity ?? 2.0; // kg/m^3 arbitrary game units
        try { colDesc = colDesc.setDensity(density); } catch {}
        const collider = this.world.createCollider(colDesc, rb);
        segment.rapierBody = rb;
        mesh.userData.rapierCollider = collider;
        mesh.userData.colliderRemoved = false;
        mesh.userData._tumbled = false;
        segment.dynamic = true;
        // Give a tiny initial push down to ensure separation
        try { rb.applyImpulse({x:0,y:-0.01,z:0}, true); } catch {}
    }

    // Remove physics and mark platform destroyed when it reaches lava
    _destroyFallenPlatform(segment) {
        const mesh = segment?.threeMeshes?.[0]; 
        if (!mesh) return;
        if (mesh.userData.crumbleState !== this.CrumbleState.FALLING) return;
        const lavaY = CONFIG.lava.surfaceY || -50;
        const splashOffset = VISUAL_CONSTANTS.LAVA_SPLASH_OFFSET;
        
        console.log(`💥 Platform ${segment.index} - destroyed by lava`);
        try {
            const finalY = segment?.rapierBody?.translation?.().y ?? mesh.position?.y;
            GameLogger.track(`Crumble destroyed: platform ${segment.index}`, {
                state: 'DESTROYED',
                finalY,
                lavaY: CONFIG.lava.surfaceY
            });
        } catch {}
        
        // FIXED: Clear timer if platform destroyed early
        if (this.crumbleTimers.has(segment.index)) {
            clearTimeout(this.crumbleTimers.get(segment.index));
            this.crumbleTimers.delete(segment.index);
        }
        
        // Emit lava destruction particles
        if (this.particleSystem) {
            this.particleSystem.emit({
                position: new THREE.Vector3(mesh.position.x, lavaY + splashOffset, mesh.position.z),
                count: 40, color: new THREE.Color(0xff4500), speed: 6, lifetime: 1.5,
                spread: new THREE.Vector3(5,8,5), startScale: 0.4, endScale: 0.05, gravity: 2.0
            });
        }
        
        // Remove physics
        try { if (mesh.userData.rapierCollider) { this.world.removeCollider(mesh.userData.rapierCollider); mesh.userData.rapierCollider=null; } } catch {}
        try { if (segment.rapierBody) { this.world.removeRigidBody(segment.rapierBody); segment.rapierBody=null; } } catch {}
        mesh.visible = false;
        mesh.userData.crumbleState = this.CrumbleState.DESTROYED;
    }

    isValidBody(body) {
        if (!body) return false;
        try {
            // Try multiple validation checks - some invalid bodies might not throw on translation()
            body.translation(); // Primary check
            body.rotation();    // Additional check for rotation validity
            body.linvel();      // Check linear velocity
            return body.isEnabled?.() !== false; // Check if body is enabled (if method exists)
        } catch {
            return false;
        }
    }

    resetGame(){
    GameLogger.action('Reset game state');
    try { this.audioManager?.stopLavaHurtLoop?.(); } catch {}
    // Force spike geometry to be recreated with the correct shape
    this._sharedSpikeGeometry = null;
        // Reset crumble platforms to standby
        if (this.cfg?.track?.crumbleMode) {
            this.resetCrumblePlatforms();
        }
        // Clean up rising lava
        if (this.lavaMesh) {
            this.scene.remove(this.lavaMesh);
            this.lavaMesh.geometry.dispose();
            this.lavaMesh.material.dispose();
            this.lavaMesh = null;
        }
        this.risingLavaUniforms = null;
        this.currentLavaHeight = CONFIG.risingLava.START_HEIGHT;
        this.risingLavaActive = false;
        
        // Reset regular lava position (if it exists and is not the rising lava mesh)
        if (this.lavaMesh) {
            this.lavaMesh.position.y = CONFIG.lava.surfaceY;
        }
        if (this.trackSegments){
            this.trackSegments.forEach(s=> this.despawnSegment(s));
        }
        if (this.debug?.damageZoneMeshes){
            this.debug.damageZoneMeshes.forEach(m=> this.scene.remove(m));
            this.debug.damageZoneMeshes.length=0;
        }
        this.trackSegments=[];
        this.damageZones=[];
        this.obstacleSections=[];
        this.playerSegmentIndex=0;
        this.score=0;
        GameLogger.action('Game state reset complete');
    }

    updateTrack(){
        // Sync meshes to physics for any dynamic rigid body (teeters or crumble-falling)
        this.trackSegments.forEach(seg=>{
            if (!seg?.rapierBody) return;
            if (seg.rapierBody?.isDynamic?.()){
                const b = seg.rapierBody;
                const pos = b.translation();
                const rot = b.rotation();
                seg.threeMeshes[0].position.set(pos.x, pos.y, pos.z);
                seg.threeMeshes[0].quaternion.set(rot.x, rot.y, rot.z, rot.w);
            }
            // Rotating platform logic removed
        });

        // Isolated moving platform animation for 'translate' level only
        if (this.currentLevel?.id === 'translate'){
            const mp = this.cfg?.movingPlatformConfig || {};
            const moveSpeed = Number(mp.translationSpeed) || 2.5;
            const rotSpeedDeg = Number(mp.rotationSpeed) || 90;
            const rotSpeed = rotSpeedDeg * Math.PI / 180; // rad/sec
            const pauseTime = Math.max(0, Number(mp.pauseAtExtents) || 0);
            const baseMaxX = Math.abs(Number(mp.maxDisplacementX) ?? 6.0);
            const baseMaxY = Math.abs(Number(mp.maxDisplacementY) ?? 5.0);
            const maxZ = Math.abs(Number(mp.maxDisplacementZ) ?? 0.0); // not used intentionally

            for (const seg of this.trackSegments){
                if (!seg?.rapierBody || !seg._moveType || seg._moveType==='Static') continue;
                const body = seg.rapierBody;
                // Only drive kinematic bodies; skip fixed/dynamic
                if (!body.isKinematic?.()) continue;
                const dtk = CONFIG.physics.timestep;
                if (seg._pause > 0){ seg._pause = Math.max(0, seg._pause - dtk); }

                const origin = seg._origin || { x:0,y:0,z:0 };
                const cur = body.translation();
                // Reset per-step kinematic velocity outputs
                seg._kinVel = seg._kinVel || { x:0, y:0, z:0 };
                seg._kinVel.x = seg._kinVel.y = seg._kinVel.z = 0;
                seg._kinAngVel = 0; // rad/s
                seg._angAxis = null; // world axis (THREE.Vector3)
                const yawNow = seg.threeMeshes?.[0]?.rotation?.y || 0;

                const setPosRot = (x,y,z, rotEuler) => {
                    try {
                        // Compute linear kinematic velocity before move
                        const vx = (x - cur.x) / dtk;
                        const vy = (y - cur.y) / dtk;
                        const vz = (z - cur.z) / dtk;
                        seg._kinVel.x = isFinite(vx) ? vx : 0;
                        seg._kinVel.y = isFinite(vy) ? vy : 0;
                        seg._kinVel.z = isFinite(vz) ? vz : 0;

                        body.setNextKinematicTranslation({ x, y, z });
                        let meshQuat = null;
                        if (rotEuler){
                            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotEuler.x||0, rotEuler.y||0, rotEuler.z||0));
                            body.setNextKinematicRotation({ x:q.x, y:q.y, z:q.z, w:q.w });
                            meshQuat = q;
                        }
                        // Mirror target immediately onto mesh for visual continuity
                        seg.threeMeshes[0].position.set(x,y,z);
                        if (meshQuat){ seg.threeMeshes[0].quaternion.copy(meshQuat); }
                    } catch {}
                };

                const type = seg._moveType;
                if (type === 'TranslateX' && seg._pause === 0){
                    const extentX = Number.isFinite(seg._extentX) ? seg._extentX : baseMaxX;
                    const spd = (Number.isFinite(seg._spdT) ? seg._spdT : 1.0) * moveSpeed;
                    const next = cur.x + seg._dir * spd * dtk;
                    const nextOffset = next - origin.x;
                    if (Math.abs(nextOffset) > extentX){ seg._dir *= -1; seg._pause = pauseTime; }
                    const clamped = origin.x + Math.max(-extentX, Math.min(extentX, nextOffset));
                    setPosRot(clamped, cur.y, cur.z);
                } else if (type === 'TranslateY' && seg._pause === 0){
                    const extentY = Number.isFinite(seg._extentY) ? seg._extentY : baseMaxY;
                    const spd = (Number.isFinite(seg._spdT) ? seg._spdT : 1.0) * moveSpeed;
                    const next = cur.y + seg._dir * spd * dtk;
                    const nextOffset = next - origin.y;
                    if (Math.abs(nextOffset) > extentY){ seg._dir *= -1; seg._pause = pauseTime; }
                    const clamped = origin.y + Math.max(-extentY, Math.min(extentY, nextOffset));
                    setPosRot(cur.x, clamped, cur.z);
                } else if (type === 'RotateX'){
                    // Oscillate pitch around X with pause at extremes
                    const prevAngle = seg._angle || 0;
                    if (seg._pause === 0){
                        const spd = (Number.isFinite(seg._spdR) ? seg._spdR : 1.0) * rotSpeed;
                        seg._angle = (seg._angle || 0) + seg._dir * spd * dtk;
                        const limit = (Number.isFinite(seg._rotLimitXDeg) ? seg._rotLimitXDeg : (mp.maxRotateAngleXDeg ? mp.maxRotateAngleXDeg : 25)) * Math.PI/180;
                        if (Math.abs(seg._angle) > limit){ seg._dir *= -1; seg._pause = pauseTime; seg._angle = Math.max(-limit, Math.min(limit, seg._angle)); }
                    }
                    // Angular velocity and world axis for carry (ω × r)
                    const dAng = (seg._angle || 0) - (prevAngle || 0);
                    seg._kinAngVel = isFinite(dAng / dtk) ? dAng / dtk : 0;
                    seg._angAxis = new THREE.Vector3(1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0), yawNow);
                    setPosRot(origin.x + (cur.x - origin.x), origin.y + (cur.y - origin.y), origin.z + (cur.z - origin.z), { x: seg._angle, y: 0, z: 0 });
                } else if (type === 'RotateZ'){
                    const prevAngle = seg._angle || 0;
                    if (seg._pause === 0){
                        const spd = (Number.isFinite(seg._spdR) ? seg._spdR : 1.0) * rotSpeed;
                        seg._angle = (seg._angle || 0) + seg._dir * spd * dtk;
                        const limit = (Number.isFinite(seg._rotLimitZDeg) ? seg._rotLimitZDeg : (mp.maxRotateAngleZDeg ? mp.maxRotateAngleZDeg : 25)) * Math.PI/180;
                        if (Math.abs(seg._angle) > limit){ seg._dir *= -1; seg._pause = pauseTime; seg._angle = Math.max(-limit, Math.min(limit, seg._angle)); }
                    }
                    const dAng = (seg._angle || 0) - (prevAngle || 0);
                    seg._kinAngVel = isFinite(dAng / dtk) ? dAng / dtk : 0;
                    seg._angAxis = new THREE.Vector3(0,0,1).applyAxisAngle(new THREE.Vector3(0,1,0), yawNow);
                    setPosRot(cur.x, cur.y, cur.z, { x: 0, y: 0, z: seg._angle });
                } else if (type === 'RotateXFree'){
                    // Continuous slow pitch around X, no clamps, no pausing
                    const prevAngle = seg._angle || 0;
                    const base = (Number.isFinite(seg._spdRFree) ? seg._spdRFree : 0.5); // slower than normal
                    const spd = base * rotSpeed;
                    seg._angle = (seg._angle || 0) + seg._dir * spd * dtk;
                    const dAng = (seg._angle || 0) - (prevAngle || 0);
                    seg._kinAngVel = isFinite(dAng / dtk) ? dAng / dtk : 0;
                    seg._angAxis = new THREE.Vector3(1,0,0).applyAxisAngle(new THREE.Vector3(0,1,0), yawNow);
                    setPosRot(origin.x + (cur.x - origin.x), origin.y + (cur.y - origin.y), origin.z + (cur.z - origin.z), { x: seg._angle, y: 0, z: 0 });
                } else if (type === 'RotateZFree'){
                    const prevAngle = seg._angle || 0;
                    const base = (Number.isFinite(seg._spdRFree) ? seg._spdRFree : 0.5);
                    const spd = base * rotSpeed;
                    seg._angle = (seg._angle || 0) + seg._dir * spd * dtk;
                    const dAng = (seg._angle || 0) - (prevAngle || 0);
                    seg._kinAngVel = isFinite(dAng / dtk) ? dAng / dtk : 0;
                    seg._angAxis = new THREE.Vector3(0,0,1).applyAxisAngle(new THREE.Vector3(0,1,0), yawNow);
                    setPosRot(cur.x, cur.y, cur.z, { x: 0, y: 0, z: seg._angle });
                } else if (type === 'SpinCW' || type === 'SpinCCW'){
                    const dir = type === 'SpinCW' ? -1 : 1; // CW negative yaw in right-handed Y-up
                    const spd = (Number.isFinite(seg._spdR) ? seg._spdR : 1.0) * rotSpeed;
                    seg._kinAngVel = dir * spd;
                    seg._angAxis = new THREE.Vector3(0,1,0);
                    seg._angle = (seg._angle || 0) + seg._kinAngVel * dtk;
                    setPosRot(cur.x, cur.y, cur.z, { x: 0, y: seg._angle, z: 0 });
                }
            }
        }

    if (!this.playerController?.body || !this.world) return;
        
        // FIXED: Cache player position and throttle search
        const now = performance.now();
        const searchThrottleMs = 100; // Only search every 100ms
        
        if (!this._lastSegmentSearch || (now - this._lastSegmentSearch) > searchThrottleMs) {
            this._lastSegmentSearch = now;
            
            // Reuse existing vector or create once
            if (!this._cachedPlayerPos) {
                this._cachedPlayerPos = { x: 0, y: 0, z: 0 };
            }
            
            const pos = this.playerController.body.translation();
            this._cachedPlayerPos.x = pos.x;
            this._cachedPlayerPos.y = pos.y;
            this._cachedPlayerPos.z = pos.z;
            
            const searchStart = Math.max(0, this.playerSegmentIndex - 3);
            const searchEnd = Math.min(this.trackSegments.length, this.playerSegmentIndex + 4);

            let closest=Infinity, newIndex=this.playerSegmentIndex;
            for (let i = searchStart; i < searchEnd; i++){
                const seg=this.trackSegments[i];
                if (!seg) continue;
                const dx=this._cachedPlayerPos.x - seg.x;
                const dz=this._cachedPlayerPos.z - seg.z;
                const d2=dx*dx+dz*dz;
                if (d2<closest){ closest=d2; newIndex=i; }
            }
            this.playerSegmentIndex=newIndex;
        }

        // Generate new segments if needed
        const desiredSegmentCount = this.playerSegmentIndex + CONFIG.track.segmentsToGenerateAhead;
        while (this.trackSegments.length < desiredSegmentCount) {
            const lastSegment = this.trackSegments.length > 0 ? this.trackSegments[this.trackSegments.length - 1] : null;
            this.generateSegment(lastSegment);
        }

        // Despawn old segments
        const despawnCount = this.playerSegmentIndex - CONFIG.track.segmentsToKeepBehind;
        if (despawnCount > 0) {
            const segmentsToDespawn = this.trackSegments.splice(0, despawnCount);
            segmentsToDespawn.forEach(seg => {
                if (seg) this.despawnSegment(seg);
            });
            // Adjust player's current segment index to match the new array
            this.playerSegmentIndex -= despawnCount;
            // Compact dynamic arrays only when we actually removed segments
            this.compactDynamicArrays();
        }
    }

    //  Compacts / prunes dynamic arrays to avoid unbounded growth.
    compactDynamicArrays(){
        // Prune damage zones more aggressively
        if (this.damageZones) {
            const beforeCount = this.damageZones.length;
            
            // CRITICAL FIX: Strengthen filter condition to prevent unbounded growth
            // Remove zones with invalid/destroyed bodies
            this.damageZones = this.damageZones.filter(z => {
                if (!z || z._removed) return false;
                
                // Validate platform body exists and is valid
                if (!z.platformBody) return false;
                
                try {
                    // Check if body is valid using isValidBody
                    if (!this.isValidBody(z.platformBody)) return false;
                    
                    // Additional check: ensure body handle is still accessible
                    const handle = z.platformBody.handle;
                    if (handle === undefined || handle === null) return false;
                    
                    return true;
                } catch (e) {
                    // Body handle access failed - body was destroyed
                    return false;
                }
            });
            
            const removedCount = beforeCount - this.damageZones.length;
            if (removedCount > 0) {
                GameLogger.cleanup(`Pruned ${removedCount} stale damage zones`);
            }
        }
        
        // Prune obstacle sections
        if (this.obstacleSections) {
            const minKeepIndex = this.playerSegmentIndex - 5;
            const beforeCount = this.obstacleSections.length;
            
            this.obstacleSections = this.obstacleSections.filter(sec => 
                sec && !sec.passed && sec.index >= minKeepIndex
            );
            
            const removedCount = beforeCount - this.obstacleSections.length;
            if (removedCount > 0) {
                GameLogger.cleanup(`Pruned ${removedCount} old obstacle sections`);
            }
        }
    }

    generateSegment(prevSegment){ // prevSegment may be null for first segment
        const { segmentLength, segmentWidth } = CONFIG.track; // Local copies for brevity
        const prev = prevSegment || { x: 0, z: 0, height: 0, rotation: 0, index: -1 }; // Default first segment
        const index = prev.index + 1; // New segment index
        let turn = 0, dH = 0, nextRotation, nextHeight, nextX, nextZ; // Defaults

        { // Horizontal logic with mode-specific generation
            const r = Math.random();
            if (index > 2) {
                // Turning
                if (r < 0.2) turn = -Math.PI / 8;
                else if (r < 0.4) turn = Math.PI / 8;
                
                // Height variation based on mode
                if (this.cfg.track?.chaoticMode) {
                    // Hard: Extreme height changes
                    if (r < 0.5) dH = Math.random() * 1 + 2;  // Jump up 1-4 units
                    else if (r < 0.7) dH = -(Math.random() * 6 + 6); // Drop down 6-12 units
                    else if (r < 0.85) dH = Math.random() * 1 - 2;   // Moderate variation -2 to +2
                } else if (this.cfg.track?.moderateTilt) {
                    // Medium: Moderate height changes
                    if (r < 0.5) dH = Math.random() * 2 + 1;  // Jump up 1-4 units
                    else if (r < 0.65) dH = -(Math.random() * 2 + 0.5); // Drop down 0.5-2.5 units
                    else if (r < 0.75) dH = Math.random() * 2 - 1;   // Small variation -1 to +1
                } else if (this.cfg.track?.noTilt) {
                    // Easy: Gentle, flowing height changes for running
                    if (r < 0.5) dH = Math.random() * 0 + 0.0;  // No upward jumps
                    else if (r < 0.65) dH = -(Math.random() * 5 + 5); // Drop down 5-10 units
                    else if (r < 0.75) dH = Math.random() * 1 - 0.5;   // Tiny variation -0.5 to +0.5
                } else {
                    // DEFAULT: Original behavior
                    if (r < 0.5) dH = 3;
                    else if (r < 0.6) dH = -2;
                }
            }
            nextRotation = prev.rotation + turn;
            
            // Height limits based on mode
            let minHeight, maxHeight;
            if (this.cfg.track?.chaoticMode) {
                minHeight = -20; maxHeight = 10;  // Wide range
            } else if (this.cfg.track?.noTilt) {
                minHeight = -5; maxHeight = 10;   // Gentle range
            } else {
                minHeight = -15; maxHeight = 20;  // Default range
            }
            nextHeight = Math.max(minHeight, Math.min(maxHeight, prev.height + dH));
        }
        // Calculate next position based on previous segment's position and rotation
        // Support optional platform spacing override for special levels (e.g., 'translate')
        const spacing = (this.currentLevel?.id === 'translate' && Number.isFinite(this.cfg?.track?.platformSpacing))
            ? this.cfg.track.platformSpacing
            : segmentLength;
        const forward = new THREE.Vector3(0, 0, spacing).applyAxisAngle(new THREE.Vector3(0, 1, 0), prev.rotation); // Direction vector
        nextX = prev.x + forward.x; // New position
        nextZ = prev.z + forward.z; // New position

        const segment = this.segmentPool.getSegment(); // Reuse from pool if possible
        segment.index = index; // Assign index
        segment.x = nextX; // Position
        segment.z = nextZ; // Position
        segment.height = nextHeight; // Height
        segment.rotation = nextRotation; // Rotation
    
        // Determine platform type first (needed for color)
        let isTeeter = false;
        let tiltAxis = null; // Will be 'x' or 'z' or null
        
        if (this.cfg.track?.noTilt) {
            isTeeter = false;
        } else if (this.cfg.track?.allTeeter) {
            isTeeter = index > 3;
            if (isTeeter) {
                tiltAxis = Math.random() < 0.5 ? 'x' : 'z';
            }
        } else if (this.cfg.track?.moderateTilt) {
            const tiltChance = this.cfg.track.tiltChance || 0.4;
            isTeeter = index > 3 && Math.random() < tiltChance;
            if (isTeeter) {
                tiltAxis = Math.random() < 0.5 ? 'x' : 'z';
            }
        } else {
            // DEFAULT: Use gameplay probability
            isTeeter = index > 3 && Math.random() < (this.cfg.gameplay?.teeterProbability ?? CONFIG.gameplay.teeterProbability);
            if (isTeeter) {
                tiltAxis = Math.random() < 0.5 ? 'x' : 'z';
            }
        }
        
        // COLOR-CODED MATERIALS based on platform type
        let baseColor;
        if (!isTeeter) {
            // Static platforms - default gray
            baseColor = new THREE.Color(0.15, 0.15, 0.15);
        } else if (tiltAxis === 'x') {
            // X-axis tilt (side-to-side) - charcoal with blue tint
            baseColor = new THREE.Color(0.12, 0.12, 0.16); // Subtle blue tint
        } else if (tiltAxis === 'z') {
            // Z-axis tilt (end-to-end) - tan/brown
            baseColor = new THREE.Color(0.18, 0.15, 0.10); // Tan/brown
        }
        
        // --- NEW INTEGRATION POINT ---
        // Set the base color as a property so the geometry/color helper can access it.
        this.currentBaseColor = baseColor;
        
        // Create custom rock geometry with proper rock-like structure
        const geo = this._createRockGeometry(segmentWidth, segmentLength, 0.5);
        const mat = this._createRockMaterial(baseColor);
        
    const avgY = (prev.height + nextHeight) / 2;

    const mesh = new THREE.Mesh(geo, mat);
    // Position & orient using the new rotation so segments smoothly curve
     if (!this._tempHalfVec) this._tempHalfVec = new THREE.Vector3();
     const halfVec = this._tempHalfVec.set(0, 0, segmentLength/2).applyAxisAngle(new THREE.Vector3(0,1,0), nextRotation);
     mesh.position.set(prev.x + halfVec.x, avgY, prev.z + halfVec.z);
         mesh.rotation.y = nextRotation;
         mesh.receiveShadow=true;
         this.scene.add(mesh);
         segment.threeMeshes.push(mesh);
         // Store base/original colors for FX like dust or crumble
         mesh.userData.originalColor = baseColor.clone();

        // Platform variants removed

    if (isTeeter){
            segment.dynamic=true;
            const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(0, mesh.rotation.y, 0));
            
            let hingeOffsetZ = 0;
            let hingeAxis = tiltAxis === 'x' ? {x:1,y:0,z:0} : {x:0,y:0,z:1};
            // Normalize hinge axis to avoid Rapier errors due to magnitude
            const len = Math.hypot(hingeAxis.x || 0, hingeAxis.y || 0, hingeAxis.z || 0);
            if (!Number.isFinite(len) || len < 1e-6) {
                hingeAxis = { x: 0, y: 0, z: 1 };
            } else if (Math.abs(len - 1) > 1e-6) {
                hingeAxis = { x: hingeAxis.x/len, y: hingeAxis.y/len, z: hingeAxis.z/len };
            }
            
            const hingeWorldPos = mesh.position.clone().add(
                new THREE.Vector3(0, 0, hingeOffsetZ).applyQuaternion(q)
            );
            
            const bodyDesc=RAPIER.RigidBodyDesc.dynamic()
                .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
                .setRotation({x:q.x,y:q.y,z:q.z,w:q.w})
                .setAngularDamping(2.0);
            const rb=this.world.createRigidBody(bodyDesc);
            const col=RAPIER.ColliderDesc.cuboid(segmentWidth/2,0.25,segmentLength/2);
            const collider = this.world.createCollider(col, rb);
            mesh.userData.rapierCollider = collider;
            segment.rapierBody=rb;

            const hingeDesc=RAPIER.RigidBodyDesc.fixed()
                .setTranslation(hingeWorldPos.x, hingeWorldPos.y - 0.5, hingeWorldPos.z);
            const hinge=this.world.createRigidBody(hingeDesc);
            
            // Validate axis and create joint defensively to avoid Rapier type errors
            const safeAxis = (hingeAxis && Number.isFinite(hingeAxis.x) && Number.isFinite(hingeAxis.y) && Number.isFinite(hingeAxis.z))
                ? hingeAxis : { x: 0, y: 0, z: 1 };
            try {
                const joint = RAPIER.JointData.revolute(
                    { x: 0, y: 0, z: hingeOffsetZ }, // anchor1
                    { x: 0, y: 0, z: 0 },            // anchor2
                    safeAxis                         // axis
                );
                segment.rapierJoint = this.world.createImpulseJoint(joint, rb, hinge, true);
                segment.rapierHingeBody = hinge;
            } catch (e) {
                reportError('joint_create', 'Failed to create revolute joint for teeter platform; falling back to fixed', e);
                // Remove dynamic body and hinge, recreate as fixed platform to keep game playable
                try { if (rb) this.world.removeRigidBody(rb); } catch {}
                try { if (hinge) this.world.removeRigidBody(hinge); } catch {}
                const qf = mesh.quaternion;
                const fixedDesc = RAPIER.RigidBodyDesc.fixed()
                    .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
                    .setRotation({ x: qf.x, y: qf.y, z: qf.z, w: qf.w });
                const rbFixed = this.world.createRigidBody(fixedDesc);
                const colFixed = RAPIER.ColliderDesc.cuboid(segmentWidth/2, 0.25, segmentLength/2);
                this.world.createCollider(colFixed, rbFixed);
                segment.rapierBody = rbFixed;
                segment.dynamic = false;
            }
            segment.hingeOffsetZ = hingeOffsetZ; // Store for spike balancing
            segment.hingeAxis = hingeAxis;       // Store axis info
            segment.tiltType = tiltAxis; // Store for debugging
            
            console.log(`🎨 Platform ${segment.index}: ${tiltAxis}-axis tilt (${tiltAxis === 'x' ? 'charcoal-blue' : 'tan'})`);
        } else {
            const q=mesh.quaternion;
            // For the Translate level, create kinematic platforms with simple movement types
            if (this.currentLevel?.id === 'translate') {
                const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
                    .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
                    .setRotation({x:q.x,y:q.y,z:q.z,w:q.w});
                const rb = this.world.createRigidBody(bodyDesc);
                const col = RAPIER.ColliderDesc.cuboid(segmentWidth/2,0.25,segmentLength/2)
                    .setFriction(2.0); 
                const collider = this.world.createCollider(col, rb);
                mesh.userData.rapierCollider = collider;
                segment.rapierBody = rb;

                // Assign movement type/state except for initial safe static platforms
                const mpCfg = this.cfg?.movingPlatformConfig || {};
                const staticCount = Math.max(0, Number(mpCfg.staticSpawnPlatforms) || 0);
                if (index < staticCount) {
                    segment._moveType = 'Static';
                } else {
                    // If a uniform type was rolled for this run, force it
                    if (this.translateUniformType) {
                        segment._moveType = this.translateUniformType;
                    } else {
                    const allowed = Array.isArray(mpCfg.movementTypes) && mpCfg.movementTypes.length>0
                        ? mpCfg.movementTypes.slice()
                        : ['TranslateX','TranslateY','RotateX','RotateZ','RotateXFree','RotateZFree','SpinCW','SpinCCW'];
                    // Ensure this segment's movement differs from the previous one for variety
                    const prevMove = prevSegment?._moveType;
                    let pick = allowed[Math.floor(Math.random()*allowed.length)];
                    if (allowed.length > 1 && prevMove) {
                        let tries = 0;
                        while (pick === prevMove && tries < 4) { // a few attempts to avoid repetition
                            pick = allowed[Math.floor(Math.random()*allowed.length)];
                            tries++;
                        }
                    }
                    segment._moveType = pick;
                    }
                }
                // Initialize movement runtime state
                segment._origin = { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z };
                segment._angle = 0;        // radians
                // Randomize direction and speeds/limits for a "cacophony" feel
                const randSign = () => (Math.random() < 0.5 ? -1 : 1);
                segment._dir = randSign(); // 1 or -1 for oscillation
                segment._pause = 0;        // countdown at extents
                const baseMaxX = Math.abs(Number(mpCfg.maxDisplacementX) ?? 6.0) || 6.0;
                const baseMaxY = Math.abs(Number(mpCfg.maxDisplacementY) ?? 5.0) || 5.0;
                // Per-segment translation extents (60%-100% of base)
                segment._extentX = baseMaxX * (0.6 + Math.random() * 0.4);
                segment._extentY = baseMaxY * (0.6 + Math.random() * 0.4);
                // Per-segment speed multipliers (0.85x - 1.25x)
                segment._spdT = 0.85 + Math.random() * 0.4; // translation speed factor
                segment._spdR = 0.85 + Math.random() * 0.4; // rotation speed factor (used by most types)
                // Per-segment rotation limits (in degrees) around default 25° (or config overrides) ±30%
                const baseXDeg = (mpCfg.maxRotateAngleXDeg ? mpCfg.maxRotateAngleXDeg : 25);
                const baseZDeg = (mpCfg.maxRotateAngleZDeg ? mpCfg.maxRotateAngleZDeg : 25);
                segment._rotLimitXDeg = Math.max(10, Math.min(45, baseXDeg * (0.7 + Math.random()*0.6)));
                segment._rotLimitZDeg = Math.max(10, Math.min(45, baseZDeg * (0.7 + Math.random()*0.6)));

                // Randomize initial conditions per type (apply immediately for smooth start)
                const pauseTime = Math.max(0, Number(mpCfg.pauseAtExtents) || 0);
                const typeNow = segment._moveType;
                try {
                    if (typeNow === 'TranslateX'){
                        // Slight random starting offset within extent
                        const offs = (Math.random()*2 - 1) * segment._extentX * 0.8;
                        const nx = segment._origin.x + offs;
                        rb.setNextKinematicTranslation({ x: nx, y: segment._origin.y, z: segment._origin.z });
                        mesh.position.set(nx, segment._origin.y, segment._origin.z);
                        // Optional initial pause
                        if (Math.random() < 0.25) segment._pause = Math.random() * pauseTime;
                    } else if (typeNow === 'TranslateY'){
                        const offs = (Math.random()*2 - 1) * segment._extentY * 0.8;
                        const ny = segment._origin.y + offs;
                        rb.setNextKinematicTranslation({ x: segment._origin.x, y: ny, z: segment._origin.z });
                        mesh.position.set(segment._origin.x, ny, segment._origin.z);
                        if (Math.random() < 0.25) segment._pause = Math.random() * pauseTime;
                    } else if (typeNow === 'RotateX'){
                        // Random initial tilt within limit
                        segment._angle = (Math.random()*2 - 1) * (segment._rotLimitXDeg * Math.PI/180);
                        const qApply = new THREE.Quaternion().setFromEuler(new THREE.Euler(segment._angle, 0, 0));
                        const qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, mesh.rotation.y, 0));
                        const qFinal = qBase.multiply(qApply);
                        rb.setNextKinematicRotation({ x:qFinal.x, y:qFinal.y, z:qFinal.z, w:qFinal.w });
                        mesh.quaternion.copy(qFinal);
                        if (Math.random() < 0.25) segment._pause = Math.random() * pauseTime;
                    } else if (typeNow === 'RotateZ'){
                        segment._angle = (Math.random()*2 - 1) * (segment._rotLimitZDeg * Math.PI/180);
                        const qApply = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, segment._angle));
                        const qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, mesh.rotation.y, 0));
                        const qFinal = qBase.multiply(qApply);
                        rb.setNextKinematicRotation({ x:qFinal.x, y:qFinal.y, z:qFinal.z, w:qFinal.w });
                        mesh.quaternion.copy(qFinal);
                        if (Math.random() < 0.25) segment._pause = Math.random() * pauseTime;
                    } else if (typeNow === 'RotateXFree'){
                        // Start at a random pitch; will rotate continuously without clamps
                        segment._angle = (Math.random()*2 - 1) * Math.PI; // any angle
                        const qApply = new THREE.Quaternion().setFromEuler(new THREE.Euler(segment._angle, 0, 0));
                        const qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, mesh.rotation.y, 0));
                        const qFinal = qBase.multiply(qApply);
                        rb.setNextKinematicRotation({ x:qFinal.x, y:qFinal.y, z:qFinal.z, w:qFinal.w });
                        mesh.quaternion.copy(qFinal);
                        // Use a slower dedicated free-rotation speed factor
                        segment._spdRFree = 0.35 + Math.random() * 0.25; // ~0.35x-0.6x of base rotSpeed
                    } else if (typeNow === 'RotateZFree'){
                        segment._angle = (Math.random()*2 - 1) * Math.PI;
                        const qApply = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, segment._angle));
                        const qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, mesh.rotation.y, 0));
                        const qFinal = qBase.multiply(qApply);
                        rb.setNextKinematicRotation({ x:qFinal.x, y:qFinal.y, z:qFinal.z, w:qFinal.w });
                        mesh.quaternion.copy(qFinal);
                        segment._spdRFree = 0.35 + Math.random() * 0.25;
                    } else if (typeNow === 'SpinCW' || typeNow === 'SpinCCW'){
                        // Random initial yaw so neighbors look distinct; keep spin direction dictated by type
                        segment._angle = Math.random() * Math.PI * 2;
                        const qApply = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, segment._angle, 0));
                        const qBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, mesh.rotation.y, 0));
                        const qFinal = qBase.multiply(qApply);
                        rb.setNextKinematicRotation({ x:qFinal.x, y:qFinal.y, z:qFinal.z, w:qFinal.w });
                        mesh.quaternion.copy(qFinal);
                        if (Math.random() < 0.15) segment._pause = Math.random() * pauseTime;
                    }
                } catch {}
                segment.dynamic = false;   // kinematic, not dynamic
            } else {
                const bodyDesc=RAPIER.RigidBodyDesc.fixed()
                    .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
                    .setRotation({x:q.x,y:q.y,z:q.z,w:q.w});
                const rb=this.world.createRigidBody(bodyDesc);
                const col=RAPIER.ColliderDesc.cuboid(segmentWidth/2,0.25,segmentLength/2);
                const collider = this.world.createCollider(col, rb);
                mesh.userData.rapierCollider = collider;
                segment.rapierBody=rb;
                
                console.log(`🎨 Platform ${segment.index}: static (gray)`);
            }
        }

        // Note: Original code had a "rotating platform" option which is not implemented here.
        // If needed, it can be reintroduced with appropriate logic.
    if (false) { 
            segment.dynamic = false; // Not truly dynamic in Rapier
            
            const q = mesh.quaternion;
            const bodyDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
                .setTranslation(mesh.position.x, mesh.position.y, mesh.position.z)
                .setRotation({x: q.x, y: q.y, z: q.z, w: q.w});
            const rb = this.world.createRigidBody(bodyDesc);
            
            const col = RAPIER.ColliderDesc.cuboid(segmentWidth/2, 0.25, segmentLength/2);
            this.world.createCollider(col, rb);
            segment.rapierBody = rb;
        }

        // Debug platform collider mesh (lazy) - only when debug mode is active
        if (this._platformColliderDebugActive) this._createPlatformDebugMesh(segment);

        // Mark as crumble platform when mode active, but keep an initial safe buffer
        if (this.cfg?.track?.crumbleMode) {
            const crumbleSafeBuffer = this.cfg.track?.crumbleSafeBuffer ?? 2; // default: first 4 segments safe
            if (index > crumbleSafeBuffer) {
                const chance = this.cfg.track.crumbleChance ?? 1.0;
                const isCrumble = Math.random() < chance;
                if (isCrumble) {
                    segment.isCrumblePlatform = true;
                    mesh.userData.isCrumblePlatform = true;
                    mesh.userData.crumbleState = this.CrumbleState?.STABLE || 'stable';
                    mesh.userData.originalPosition = mesh.position.clone();
                    mesh.userData.originalColor = mesh.userData.originalColor || mesh.material.color.clone();
                    // Slight color variation to hint unstable ground
                    mesh.material.color.multiplyScalar(0.95);
                } else {
                    segment.isCrumblePlatform = false;
                    mesh.userData.isCrumblePlatform = false;
                    mesh.userData.crumbleState = this.CrumbleState?.STABLE || 'stable';
                    mesh.userData.originalPosition = mesh.userData.originalPosition || mesh.position.clone();
                    mesh.userData.originalColor = mesh.userData.originalColor || mesh.material.color.clone();
                }
            } else {
                // Within safe buffer: never crumble
                segment.isCrumblePlatform = false;
                mesh.userData.isCrumblePlatform = false;
                mesh.userData.crumbleState = this.CrumbleState?.STABLE || 'stable';
                mesh.userData.originalPosition = mesh.userData.originalPosition || mesh.position.clone();
                mesh.userData.originalColor = mesh.userData.originalColor || mesh.material.color.clone();
            }
        }

        // Determine spike spawning based on mode
        let shouldSpawnSpikes = false;
        if (index > 2) {
            const spikeChance = this.cfg.track?.spikeChance ?? CONFIG.gameplay.horizontalObstacleProbability;
            shouldSpawnSpikes = Math.random() < spikeChance;
        }

        // Medium (hinged) level rule: no spikes on tilting/teeter platforms
        // Keep spikes only on static platforms for this level
        if (this.currentLevel?.id === 'hinged' && isTeeter) {
            shouldSpawnSpikes = false;
        }

        if (shouldSpawnSpikes){
            const midX=(prev.x + nextX)/2;
            const midZ=(prev.z + nextZ)/2;
            const midH=(prev.height + nextHeight)/2;
            this.obstacleSections.push({
                position:new THREE.Vector3(midX, midH, midZ),
                passed:false,
                hadContact:false,
                index:this.obstacleSections.length
            });
            const zones=this.createSpikeRow(midX, midZ, midH, nextRotation, segment);
            zones.forEach(z=>{
                this.damageZones.push(z);
                segment.damageZones.push(z);
            });
        }
        if (DEBUG_FLAGS.trackGen) {
            GameLogger.track(`Generated segment ${index}`, { type: isTeeter ? 'teeter' : 'static', obstacles: segment.damageZones.length > 0 });
        }
        this.trackSegments.push(segment);
        // Platform count scoring
        this.score += 1;
        this.uiManager?.updateScore(this.score);
    }

    // Choose platform type according to probabilities (spiral only)
    // Removed platform variant logic

    despawnSegment(segment){
        if (!segment) { reportError('physics', 'despawnSegment called with null/undefined'); return; }
        GameLogger.track(`Despawned segment ${segment.index}`);
        
        // FIXED: Clear crumble timer when segment despawns
        if (this.crumbleTimers.has(segment.index)) {
            clearTimeout(this.crumbleTimers.get(segment.index));
            this.crumbleTimers.delete(segment.index);
        }
        
        // Remove any debug visualization immediately so F toggle doesn't show ghosts
        if (segment._debugMesh){
            this.scene.remove(segment._debugMesh);
            try { segment._debugMesh.geometry?.dispose?.(); } catch{}
            try { segment._debugMesh.material?.dispose?.(); } catch{}
            segment._debugMesh=null;
        }
        if (segment._spikeDebug){
            for (const m of segment._spikeDebug){
                try { m.parent?.remove(m); } catch{}
                try { m.geometry?.dispose?.(); } catch{}
                try { m.material?.dispose?.(); } catch{}
            }
            segment._spikeDebug=null;
        }
        // Remove meshes but respect shared spike resources (spike material & geometry are shared globally)
        segment.threeMeshes.forEach(m=> {
            this.scene.remove(m);
            if (m.geometry && !m._isSharedGeometry) { try { m.geometry.dispose(); } catch(e){ reportError('cleanup','Geometry dispose failed',{ error:e.message }); } }
            if (m.material){
                const mats = Array.isArray(m.material)? m.material : [m.material];
                mats.forEach(mat=>{ if (!mat._isSharedMaterial) { try { mat.dispose(); } catch(e){ reportError('cleanup','Material dispose failed',{ error:e.message }); } } });
            }
        });
        if (segment.damageZones){
            segment.damageZones.forEach(z=> { z.platformBody=null; z._removed=true; });
        }
        const isAlreadyRemovedError = (e) => {
            if (!e?.message) return false; const msg = e.message.toLowerCase();
            return msg.includes('not found') || msg.includes('already removed') || msg.includes('invalid handle');
        };
        // Remove joint first
        if (segment.rapierJoint != null) {
            try { this.world.removeImpulseJoint(segment.rapierJoint, true); } catch (e) { if (!isAlreadyRemovedError(e)) reportError('physics','Failed to remove impulse joint',{ error:e.message, segment:segment.index }); }
        }
        if (segment.rapierHingeBody) {
            try { this.world.removeRigidBody(segment.rapierHingeBody); } catch (e) { if (!isAlreadyRemovedError(e)) reportError('physics','Failed to remove hinge body',{ error:e.message, segment:segment.index }); }
        }
        if (segment.rapierBody){
            try { this.world.removeRigidBody(segment.rapierBody); } catch (e) { if (!isAlreadyRemovedError(e)) reportError('physics','Failed to remove main body',{ error:e.message, segment:segment.index }); }
        }
        this.segmentPool.returnSegment(segment);
    }

    createSpikeRow(x,z,height,rotation,segment){
        const { segmentWidth, segmentLength, spikeSpacing }=CONFIG.track;
        const baseR=0.35;
        const spikeH=1.0;
        
        // Initialize shared resources if not already done
        if (!this._sharedSpikeMaterial){
            this._sharedSpikeMaterial = new THREE.MeshStandardMaterial({
                color: 0xffffff,      // Pure white for chrome
                roughness: 0.0,       // Perfectly smooth
                metalness: 1.0,       // Fully metallic
                envMapIntensity: 1.0  // Use environment reflections if available
            });
            this._sharedSpikeMaterial._isSharedMaterial = true;
        }
        if (!this._sharedSpikeGeometry){
            // Use CylinderGeometry to match the cylindrical hitbox. Small top radius for spiky look.
            this._sharedSpikeGeometry = new THREE.CylinderGeometry(0.05, baseR, spikeH, 8);
            this._sharedSpikeGeometry._isSharedGeometry = true;
        }
        const mat=this._sharedSpikeMaterial;
        const geo=this._sharedSpikeGeometry;
        const zones=[];

        // Mode-specific spike pattern selection
        let spikePositions = [];
        if (this.cfg.track?.noTilt) {
            
            const patternType = Math.random(); // Randomly choose pattern
            if (patternType < 0.5) { // 50% chance for line pattern
                // LINE PATTERN - straight across middle
                const lineCount = Math.floor(Math.random() * 3) + 3; // 3-5 spikes
                for (let i = 0; i < lineCount; i++) { // Evenly spaced
                    const t = (i / (lineCount - 1)) - 0.5; // -0.5 to 0.5
                    spikePositions.push({ // Straight line along width
                        x: t * (segmentWidth * 0.7), // 70% of width
                        z: 0  // Centered
                    }); 
                }
            } else {
                // CLUSTERED - single cluster on one side
                const clusterCount = Math.floor(Math.random() * 2) + 2; // 2-3 spikes
                const side = Math.random() < 0.5 ? -1 : 1; // Left or right side
                const clusterX = side * (segmentWidth * 0.3); // 30% from center
                for (let i = 0; i < clusterCount; i++) { // Randomly jittered
                    spikePositions.push({ // Clustered on one side
                        x: clusterX + (Math.random() - 0.5) * 1.5, // Jitter within 1.5 units
                        z: (Math.random() - 0.5) * 2 // Spread along length
                    });
                }
            }
        } else {
            // DEFAULT / CHAOTIC / HINGED: More complex patterns
            const isTeeter = segment.dynamic; // Teeter platforms need balanced patterns
            const hingeOffsetZ = segment.hingeOffsetZ || 0; // Use stored hinge offset
            const hingeAxis = segment.hingeAxis || {x:1,y:0,z:0}; // Default to x-axis if missing
            
            // Random spike pattern selection
            const patternType = Math.random();
            
            if (patternType < 0.3) {
                // SYMMETRIC PAIRS - balanced for teeter platforms
                const pairCount = Math.floor(Math.random() * 2) + 2; // 2-3 pairs
                for (let i = 0; i < pairCount; i++) { // Randomly placed pairs
                    const xOff = (Math.random() - 0.5) * (segmentWidth - 2); // Avoid edges
                    const zOff = (Math.random() - 0.5) * (segmentLength - 2); // Avoid edges
                    spikePositions.push({x: xOff, z: zOff}); // One spike
                    spikePositions.push({x: -xOff, z: -zOff}); // Mirror pair
                }
            } else if (patternType < 0.6) {
                // CLUSTERED - random cluster on one side
                const clusterCount = Math.floor(Math.random() * 4) + 3; // 3-6 spikes
                const clusterCenterX = (Math.random() - 0.5) * (segmentWidth * 0.6); // Within 60% of width
                const clusterCenterZ = (Math.random() - 0.5) * (segmentLength * 0.6); // Within 60% of length
                for (let i = 0; i < clusterCount; i++) { // Randomly jittered
                    spikePositions.push({ // Clustered around center
                        x: clusterCenterX + (Math.random() - 0.5) * 2, // Jitter within 2 units
                        z: clusterCenterZ + (Math.random() - 0.5) * 2 // Jitter within 2 units
                    });
                }
            } else if (patternType < 0.8) {
                // LINE PATTERN - diagonal or straight
                const lineCount = Math.floor(Math.random() * 4) + 4; // 4-7 spikes
                const isDiagonal = Math.random() < 0.5; // 50% diagonal vs straight
                for (let i = 0; i < lineCount; i++) { // Evenly spaced
                    const t = (i / (lineCount - 1)) - 0.5; // -0.5 to 0.5
                    if (isDiagonal) { // Diagonal line
                        spikePositions.push({ // Diagonal across platform
                            x: t * (segmentWidth * 0.8), // 80% of width
                            z: t * (segmentLength * 0.8) // 80% of length
                        });
                    } else {
                        // Straight line along width
                        spikePositions.push({ // Straight line
                            x: t * (segmentWidth * 0.8), // 80% of width
                            z: (Math.random() - 0.5) * 2 // Random z within 2 units
                        });
                    }
                }
            } else {
                // RANDOM SCATTER
                const scatterCount = Math.floor(Math.random() * 5) + 3; // 3-7 spikes
                for (let i = 0; i < scatterCount; i++) { // Fully random positions
                    spikePositions.push({ // Randomly scattered
                        x: (Math.random() - 0.5) * (segmentWidth - 1), // Avoid edges
                        z: (Math.random() - 0.5) * (segmentLength - 1) // Avoid edges
                    });
                }
            }
        }
        
        // Transform spike positions according to platform rotation & position
        for (const pos of spikePositions) { // pos is local to platform center
            const local = new THREE.Vector3(pos.x, 0.25 + spikeH/2, pos.z); // 0.25 above platform surface
            const spike = new THREE.Mesh(geo, mat); // Reuse shared geometry & material
            segment.threeMeshes[0].add(spike); // Attach to platform mesh for easier management
            spike.position.copy(local); // Local position
            spike.castShadow = true; // Cast shadow
            
            // Rotate around platform center
            spike.rotation.y = Math.random() * Math.PI * 2; // Random rotation for variety
            // --- Debug: Add cylinder, not sphere, for spike collider ---
            if (this._platformColliderDebugActive) {
                const dbg = new THREE.Mesh(
                    new THREE.CylinderGeometry(baseR, baseR, spikeH, 12, 1, true),
                    new THREE.MeshBasicMaterial({ wireframe: true, color: 0xff3333, opacity: 0.8, transparent: true })
                );
                dbg.position.copy(local); // Local position
                dbg.rotation.x = 0; // Align cylinder vertically (Y axis)
                segment.threeMeshes[0].add(dbg); // Attach to platform mesh
                if (!segment._spikeDebug) segment._spikeDebug = [];
                segment._spikeDebug.push(dbg);
                if (!this._debugMeshes) this._debugMeshes = [];
                this._debugMeshes.push(dbg);
            }
            // Create damage zone
            zones.push({
                platformBody: segment.rapierBody, // Associate with platform body
                localOffset: local.clone(), // Local position relative to platform
                radius: baseR, // Collision radius
                height: spikeH, // Height for vertical checks
                damage: CONFIG.gameplay.spikeDamage, // Damage amount
                cooldown: 0, // No cooldown between hits
                parentSection: this.obstacleSections.length - 1, // Link to obstacle section
                _removed:false // Not removed
            });
        }
        
        return zones;
    }
    // Debug visualization of platform colliders
    setPlatformColliderDebug(active){
        this._platformColliderDebugActive = active; // Store state
        // --- Clean up all debug meshes fully ---
        if (!active) {
            if (this._debugMeshes) {
                for (const mesh of this._debugMeshes) {
                    if (mesh.parent) mesh.parent.remove(mesh);
                    if (mesh.geometry) mesh.geometry.dispose();
                    if (mesh.material) {
                        if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
                        else mesh.material.dispose();
                    }
                }
                this._debugMeshes.length = 0;
            }
            if (this.trackSegments) {
                for (const seg of this.trackSegments) {
                    if (seg._spikeDebug) {
                        for (const mesh of seg._spikeDebug) {
                            if (mesh.parent) mesh.parent.remove(mesh);
                            if (mesh.geometry) mesh.geometry.dispose();
                            if (mesh.material) {
                                if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
                                else mesh.material.dispose();
                            }
                        }
                        seg._spikeDebug = [];
                    }
                    if (seg._debugMesh) {
                        if (seg._debugMesh.parent) seg._debugMesh.parent.remove(seg._debugMesh);
                        if (seg._debugMesh.geometry) seg._debugMesh.geometry.dispose();
                        if (seg._debugMesh.material) {
                            if (Array.isArray(seg._debugMesh.material)) seg._debugMesh.material.forEach(m => m.dispose());
                            else seg._debugMesh.material.dispose();
                        }
                        seg._debugMesh = null;
                    }
                }
            }
            this.compactDynamicArrays?.();
            return;
        }
        if (this.trackSegments) {
            for (const seg of this.trackSegments) {
                if (!seg) continue;
                if (!seg.rapierBody) continue;
                if (!seg._debugMesh) this._createPlatformDebugMesh(seg);
                this._ensureSpikeDebug(seg);
            }
        }
    }
    // Ensure spike debug meshes exist for a segment
    _ensureSpikeDebug(seg){ //
        if (!this._platformColliderDebugActive) return;
        if (!seg?.damageZones || !seg.threeMeshes?.length) return;
        if (!seg._spikeDebug) seg._spikeDebug = [];
        const parentMesh = seg.threeMeshes[0];
        // Remove any old debug meshes
        for (const mesh of seg._spikeDebug) {
            if (mesh.parent) mesh.parent.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) {
                if (Array.isArray(mesh.material)) mesh.material.forEach(m => m.dispose());
                else mesh.material.dispose();
            }
        }
        seg._spikeDebug = [];
        if (!this._debugMeshes) this._debugMeshes = [];
        // Add new debug meshes for each spike
        for (const zone of seg.damageZones) {
            if (!zone || zone._removed) continue;
            const baseR = zone.radius || 0.35;
            const spikeH = zone.height || 1.0;
            const local = zone.localOffset ? zone.localOffset.clone() : new THREE.Vector3(0, 0.75, 0);
            const dbg = new THREE.Mesh(
                new THREE.CylinderGeometry(baseR, baseR, spikeH, 12, 1, true),
                new THREE.MeshBasicMaterial({ wireframe: true, color: 0xff3333, opacity: 0.8, transparent: true })
            );
            dbg.position.copy(local); // Local position
            dbg.rotation.x = 0; // Align cylinder vertically (Y axis)
            parentMesh.add(dbg); // Attach to platform mesh
            seg._spikeDebug.push(dbg); // Store in segment  
            this._debugMeshes.push(dbg); // Store globally for cleanup
        }
    }
    // Create a wireframe box to visualize the platform collider
    _createPlatformDebugMesh(seg){ // Defensive
        if (!seg?.rapierBody) return; if (seg._debugMesh) return; // Only one debug mesh
        let geo=new THREE.BoxGeometry(CONFIG.track.segmentWidth,0.5,CONFIG.track.segmentLength); // Box slightly thicker than collider
        const mat=new THREE.MeshBasicMaterial({ wireframe:true, color:0x00ffff }); // Cyan wireframe
        const dbg=new THREE.Mesh(geo, mat); // Create mesh
        dbg.position.copy(seg.threeMeshes[0].position); // Match platform position
        dbg.rotation.copy(seg.threeMeshes[0].rotation); // Match platform rotation
        this.scene.add(dbg); // Add to scene
        seg._debugMesh=dbg; // Store reference
    }
    // Check for player damage from nearby spikes and handle scoring
    checkDamageAndScore(dt){ // Defensive
        if (!this.playerController?.body) return; // Defensive
        const playerPos = this.playerController.body.translation(); // Current player position
        const playerSegment = this.playerSegmentIndex; // Current segment index
        const start = Math.max(0, playerSegment - 1); // Check one segment behind
        const end = Math.min(this.trackSegments.length, playerSegment + 4); // And three ahead
        
        for (let i = start; i < end; i++) { // Loop through relevant segments
            const seg = this.trackSegments[i]; // Defensive
            if (!seg?.damageZones) continue; // No damage zones
            
            this._checkSegmentDamageZones(seg, playerPos, dt); // Check damage zones in segment
        }

        // Scoring - removed, now based on platform count
        // this.obstacleSections.forEach(section=>{
        //     if (!section || section.passed) return;
        //     const to=section.position.clone().sub(this.playerController.currentTranslation);
        //     if (to.lengthSq() < (CONFIG.track.segmentLength**2)){
        //         const forward=new THREE.Vector3(0,0,1).applyQuaternion(this.playerController.model.quaternion);
        //         if (to.dot(forward)<0){
        //             if (!section.hadContact){
        //                 this.score=(this.score||0)+1;
        //                 this.uiManager.updateScore(this.score);
        //                 GameLogger.score(`Score increased to: ${this.score}`);
        //                 this.checkLevelCompletion();
        //             }
        //             section.passed=true;
        //         }
        //     }
        // });
    }

    _checkSegmentDamageZones(segment, playerPos, dt){ // Defensive
        const tempQ = new THREE.Quaternion(); // Reusable quaternion
        const maxCheckDistSq = Math.pow(CONFIG.track.segmentLength * 2, 2); // Broad-phase check distance squared

        segment.damageZones.forEach(zone=>{ // Defensive
            if (!zone || zone._removed || !zone.platformBody) return; // Skip removed zones
            if (this.playerController.fsm.current instanceof DeadState) return; // stop processing after death
            let pPos, pRot; // Platform position & rotation
            try {// Defensive
                pPos=zone.platformBody.translation(); // May throw if body removed
                pRot=zone.platformBody.rotation(); // May throw if body removed
            } catch { // Body likely removed
                zone._removed=true; return; // Mark as removed to skip in future
            }

            // Broad-phase distance check to avoid unnecessary calculations
            const pDx = playerPos.x - pPos.x; // X distance 
            const pDz = playerPos.z - pPos.z; // Z distance
            if (pDx*pDx + pDz*pDz > maxCheckDistSq) return;

            tempQ.set(pRot.x,pRot.y,pRot.z,pRot.w);
            // Reuse a lazily created vector for spike world position to cut allocations
            if (!this._tmpSpikePos) this._tmpSpikePos = new THREE.Vector3();
            const spikePos = this._tmpSpikePos.copy(zone.localOffset).applyQuaternion(tempQ).add(pPos);
            const dx=playerPos.x - spikePos.x;
            const dz=playerPos.z - spikePos.z;
            const d2=dx*dx+dz*dz;
            const combined=zone.radius + CONFIG.player.radius;
            if (d2 < combined*combined){
                const playerBottom = playerPos.y - (CONFIG.player.height + CONFIG.player.radius);
                const spikeBottom = spikePos.y - zone.height/2;
                if (playerBottom < spikeBottom + zone.height){
                    if (zone.cooldown<=0){
                        GameLogger.collision('Player hit a spike!');
                        this.playerController.takeDamage(zone.damage);
                        zone.cooldown=1.0;
                        const sec=this.obstacleSections[zone.parentSection];
                        if (sec) sec.hadContact=true;
                    }
                }
            }
            if (zone.cooldown>0) zone.cooldown -= dt;
        });
    }

    //  Handles camera effects like the FOV pulse for the dash
    updateCameraEffects(dt) {
        let needsUpdate = false;
        if (this.dashFovTimer > 0) {
            this.dashFovTimer = Math.max(0, this.dashFovTimer - dt);
            const progress = 1.0 - (this.dashFovTimer / VISUAL_CONSTANTS.DASH_FOV_DURATION);
            const pulse = Math.sin(progress * VISUAL_CONSTANTS.CAMERA_FOV_PULSE_CURVE);
            const maxPossibleForce = CONFIG.player.maxSprint * CONFIG.airDash.forceMultiplier;
            const forcePct = maxPossibleForce > 0 ? Math.min(1, this.lastDashForce / maxPossibleForce) : 0;
            const scaledBoost = VISUAL_CONSTANTS.DASH_FOV_BOOST * forcePct;
            this.camera.fov = this.baseFov + pulse * scaledBoost;
            needsUpdate = true;
        } else {
            if (this.camera.fov !== this.baseFov) {
                 this.camera.fov = this.baseFov;
                 needsUpdate = true;
            }
        }
        if (needsUpdate) {
            this.camera.updateProjectionMatrix();
        }
    }
    
    // Can be called by other classes to trigger camera effects
    triggerDashEffect(force = 0) {
        this.dashFovTimer = this.dashFovDuration;
        this.lastDashForce = force;
    }

    // ===== Timer API =====
    startTimer(){
        if (this.timerRunning || this.cfg?.sandbox) return;
        if (!this.timerElement) return;
        this.timerRunning = true;
        this.startTime = performance.now();
        this.elapsedTime = 0;
        this.totalPausedTime = 0; // Reset paused time accumulator
        GameLogger.lifecycle('Timer started.');
    }
    stopTimer(finalize=true){
        if (!this.timerRunning) return;
        this.elapsedTime = (performance.now() - this.startTime) - this.totalPausedTime;
        this.timerRunning = false;
        if (finalize && this.timerElement){
            this.timerElement.textContent = this._formatTime(this.elapsedTime);
        }
        GameLogger.lifecycle('Timer stopped at '+ this._formatTime(this.elapsedTime));
    }
    _formatTime(ms){
        if (!ms || !isFinite(ms)) return '00:00.000';
        
        const totalSeconds = Math.floor(ms / 1000);
        const minutes = String(Math.floor(totalSeconds / 60)).padStart(2,'0');
        const seconds = String(totalSeconds % 60).padStart(2,'0');
        const milliseconds = String(Math.floor(ms % 1000)).padStart(3,'0');
        return `${minutes}:${seconds}.${milliseconds}`;
    }

    animate(){
        if (!this.running || this._isCleaningUp) { this._animating=false; return; }
        this._animating=true;
        requestAnimationFrame(()=>this.animate());
        
        // Critical error recovery wrapper
        try {
            if (this.isPaused){
                // Stop backup beep if game is paused
                if (this.audioManager?.backupBeepPlaying) {
                    this.audioManager.stopBackupBeep();
                }
                this.renderer.render(this.scene, this.camera);
                return;
            }
            
            // Check if backup beep should be stopped due to invalid game state
            if (this.audioManager?.backupBeepPlaying) {
                const playerController = this.playerController;
                if (!playerController || playerController.fsm.current instanceof DeadState) {
                    this.audioManager.stopBackupBeep();
                }
            }
            
            // Main loop timing
            const now=performance.now();
            const dt=(now - this.lastFrameTime)/1000;
            this.lastFrameTime=now;
            
            // Clamp dt to prevent spiral of death on frame skips
            const clampedDt = Math.min(dt, 0.1); // Max 100ms per frame
            if (dt > 0.05) { // Log significant frame skips (>50ms)
                GameLogger.perf(`Frame skip detected: ${(dt * 1000).toFixed(1)}ms`);
                // Attempt to recover any missed inputs during frame skip
                this.inputManager?.recoverMissedInputs?.();
            }

        // FPS calculation
        if (!this._fpsInitialized){
            this.smoothedFps = 1 / Math.max(dt, 1e-6);
            this._fpsInitialized = true;
        } else {
            const instFps = 1 / Math.max(dt, 1e-6);
            const smoothing = 0.1; // 0..1 (higher = more responsive)
            this.smoothedFps = this.smoothedFps + (instFps - this.smoothedFps) * smoothing;
        }
        // Measure frame work time (physics + render) to estimate engine headroom
        const workStart = performance.now();

        // Performance logging
        this.frameCount++;
       if (now - this.lastPerfLogTime > 1000) {
           if (DEBUG_FLAGS.perf) GameLogger.perf(`FPS: ${this.frameCount}`);
             this.frameCount = 0;
             this.lastPerfLogTime = now;
        }

        // Update crumble platforms before physics step
        if (this.cfg?.track?.crumbleMode) { // Only if crumble mode active
            this.updateCrumblePlatforms(clampedDt); // Update crumble states
        }

        this.accumulator += clampedDt; // For fixed timestep
        const step=CONFIG.physics.timestep; // Fixed physics timestep
        let stepsThisFrame = 0; // Count physics steps this frame
        while (this.accumulator >= step){ // Fixed timestep loop
            this.world.step(); // Rapier physics step
            this.playerController?.fixedUpdate(step); // Player fixed update
            // Spiral platform system removed; clear ground segment ref
            if (this.playerController) this.playerController.currentGroundSegment = null; // Clear each step to avoid stale refs
            if (this.cfg.sandbox) this.checkSandboxHazards(step); // Sandbox hazards
            this.checkDamageAndScore(step); // Check spike damage
            this.accumulator -= step; // Decrease accumulator
            stepsThisFrame++; // Increment step count
        }
        // Drive lava shader time and keep plane/collider centered on the player so it feels infinite
        if (this.lavaUniforms) this.lavaUniforms.uTime.value = now * 0.001; // seconds
        // Keep lava plane/collider roughly centered on the player XZ so it feels infinite
        if (this.lavaMesh) {
            try {
                const p = this.playerController?.body ? this.playerController.body.translation() : null;
                if (p) { this.lavaMesh.position.x = p.x; this.lavaMesh.position.z = p.z; }
            } catch {}
        }
        if (this._lavaBody) {
            try {
                const p = this.playerController?.body ? (()=>{ try { return this.playerController.body.translation(); } catch{return null;} })() : null;
                const lv = CONFIG.lava;
                const offset = Number.isFinite(lv.colliderOffset) ? lv.colliderOffset : 0;
                const targetY = (this.currentLavaHeight ?? lv.surfaceY) + offset - (lv.thickness/2 || 0);
                const newX = p ? p.x : (this._lavaBody.translation()?.x ?? 0);
                const newZ = p ? p.z : (this._lavaBody.translation()?.z ?? 0);
                this._lavaBody.setTranslation({ x: newX, y: targetY, z: newZ }, true);
            } catch {}
        }
        // Lava contact check
        const inMainMenu = window.menuManager && window.menuManager.menu && window.menuManager.menu.style.display === 'flex' && window.menuManager.menuContext === 'main';
    if (!inMainMenu && !this._isCleaningUp && this.running && CONFIG.lava.killOnContact && this._lavaCollider && this.playerController && !(this.playerController.fsm.current instanceof DeadState)){ // Only if enabled and player alive
            try {
                const playerBody = this.playerController.body; // Defensive
                if (playerBody){ // Defensive
                    const pos = playerBody.translation(); // Current player position
                    // Simple Y-level check against lava surface
                    const playerBottom = pos.y - (CONFIG.player.height + CONFIG.player.radius); // Player bottom Y
                    if (playerBottom <= CONFIG.lava.surfaceY + 0.05){ // Small tolerance
                        // Contact with lava detected
                        console.log('[LAVA] Contact detected', { playerBottom, surfaceY: CONFIG.lava.surfaceY, t: Math.round(performance.now()) });
                        GameLogger.lava('Player touched lava - death'); // Log event
                        // Start looping lava hurt audio (user provided MP3) and play impact SFX
                        try { this.audioManager?.startLavaHurtLoop(); } catch(e){}
                        // Apply visual: char the fox on contact
                        try { this.playerController?.applyCharredLook?.(); } catch{}
                        this.audioManager?.playSound('damage'); // Play damage sound
                        this.playerController.die('lava'); // Trigger death
                    }
                }
            } catch(e) { // Defensive
                reportError('lava_contact','Failed during lava contact check', e); // Log error
            }
        }
        // Add to animate() method, after physics loop and before rendering
        // Let the rising lava continue regardless of player death so the world 'goes on'
        if (this.risingLavaActive && this.lavaMesh && !this._isCleaningUp && this.running) {
            this.updateRisingLava(clampedDt);
            // Do not trigger death notifications while the main unified menu is visible (not pause menu)
            const inMainMenuCollision = window.menuManager && window.menuManager.menu && window.menuManager.menu.style.display === 'flex' && window.menuManager.menuContext === 'main';
            if (!inMainMenuCollision) this.checkRisingLavaCollision();
        }
        // Allow immediate dash if no physics steps occurred (e.g. tab out)
        if (stepsThisFrame === 0){ // No physics steps this frame
            this.playerController?.processImmediateDash(); // Allow immediate dash
        }
        const alpha=this.accumulator / step; // For interpolation
    this.playerController?.update(clampedDt, alpha); // Pass dt and alpha for smoothing
    this.thirdPersonCamera?.update(clampedDt); // Update camera
        this.updateCameraEffects(clampedDt); // Camera effects like FOV pulse
        this.particleSystem?.update(clampedDt); // Particle system update
        if (this.cfg.sandbox && this.sandboxDynamicObjects){ // Move dynamic sandbox objects
            for (const obj of this.sandboxDynamicObjects){ // Defensive
                if (!obj?.body || !obj?.mesh) continue; // Defensive
                const pos=obj.body.translation(); // Get position
                const rot=obj.body.rotation(); // Get rotation
                obj.mesh.position.set(pos.x,pos.y,pos.z); // Update mesh position
                obj.mesh.quaternion.set(rot.x,rot.y,rot.z,rot.w); // Update mesh rotation
            }
        }
        if (!this.cfg.sandbox){ // Only update track in normal mode
            this.updateTrack(); // Track management
        }
        this.renderer.render(this.scene, this.camera); // Render scene
        const workEnd = performance.now(); // End of work timing
        const workMs = workEnd - workStart; // Work duration
        if (!this._workInitialized){ // First frame init
            this.smoothedWorkMs = workMs; // Initialize
            this._workInitialized = true; // Mark initialized
        } else { // Smooth work time
            const wS = 0.15; // Smoothing factor
            this.smoothedWorkMs = this.smoothedWorkMs + (workMs - this.smoothedWorkMs) * wS; // Smooth
        }
        // Estimate headroom based on 60fps ideal frame budget (16.6667ms)
        if (this.smoothedWorkMs){
            const budget60 = 16.6667;
            this.headroomPct60 = Math.max(-100, Math.min(100, (1 - (this.smoothedWorkMs / budget60)) * 100));
            if (this.headroomPct60 < -20 && !this._perfWarningSent) {
                try {
                    GameLogger.perf(`Performance warning: ${this.headroomPct60.toFixed(1)}% headroom`, {
                        workMs: this.smoothedWorkMs.toFixed(2),
                        fps: this.smoothedFps?.toFixed?.(1),
                        particles: this.particleSystem?.particles?.length,
                        segments: this.trackSegments?.length
                    });
                } catch {}
                this._perfWarningSent = true;
                setTimeout(() => { this._perfWarningSent = false; }, 5000);
            }
        }

        // Timer update
        if (this.timerRunning && !this.isPaused) { // Only if running and not paused
            this.elapsedTime = (performance.now() - this.startTime) - this.totalPausedTime;// Update elapsed time
            if (this.timerElement) { // Update display
                this.timerElement.textContent = this._formatTime(this.elapsedTime); // Format time
            }
        }
        
        // Progressive difficulty

        
        // UI Status Updates
        const dashReady = this.playerController && this.playerController.sprint >= CONFIG.gameplay.minDashEnergy;
        this.uiManager.updateDashStatus(dashReady);
        
        this.inputManager.endFrameUpdate(); // Reset single-press keys
        
        } catch (error) {
            // Critical error recovery in main game loop
            reportError('game_loop', 'Critical error in game loop, attempting recovery', error);
            
            // Attempt to continue running if possible
            try {
                // Ensure renderer still works
                this.renderer?.render?.(this.scene, this.camera);
                
                // Clear any stuck states
                if (this.playerController) {
                    this.playerController._respawnInProgress = false;
                }
                
                // If error is catastrophic, pause the game
                if (this._consecutiveErrors > 5) {
                    console.error('Too many consecutive errors, pausing game for safety');
                    this.pauseGame(true);
                    this._consecutiveErrors = 0;
                } else {
                    this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
                }
            } catch (recoveryError) {
                reportError('game_loop', 'Failed to recover from game loop error', recoveryError);
                this.running = false;
            }
        }
    }

    onResize(){
        this.camera.aspect=window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    cleanup() {
        GameLogger.cleanup('Cleaning up game instance.');
        this.running = false;
        this._isCleaningUp = true;

    // Stop and cleanup audio
    try { this.audioManager?.stopLavaHurtLoop?.(); } catch {}
    this._stopLavaLoop();
        
        if (this.lavaAudio) {
            try {
                this.lavaAudio.disconnect();
                this.lavaAudio = null;
            } catch(e) {
                console.warn('Error cleaning up lava audio:', e);
            }
        }

        if (this.audioListener) {
            try {
                this.audioListener.clear();
                this.audioListener = null;
            } catch(e) {
                console.warn('Error cleaning up audio listener:', e);
            }
        }

        this.audioInitialized = false;
        this.lavaLoopLoaded = false;
        this.stoneSlideBuffer = null;

        // Destroy managers
        this.inputManager?.destroy();
        this.thirdPersonCamera?.destroy();

        // Properly destroy particle system
        if (this.particleSystem) {
            try { this.particleSystem.destroy(); } catch {}
            this.particleSystem = null;
        }

        if (this.debugUpdateInterval) clearInterval(this.debugUpdateInterval);
        
        // Add to cleanup() method
        if (this.lavaMesh) {
            this.scene.remove(this.lavaMesh);
            this.lavaMesh.geometry.dispose();
            this.lavaMesh.material.dispose();
            this.lavaMesh = null;
        }
        
        // Clean up shared spike resources (dispose ONCE)
        if (this._sharedSpikeGeometry && !this._sharedSpikeGeometry._disposed) {
            try {
                this._sharedSpikeGeometry.dispose();
                this._sharedSpikeGeometry._disposed = true;
            } catch(e) {
                console.warn('Error disposing shared spike geometry:', e);
            }
        }
        if (this._sharedSpikeMaterial && !this._sharedSpikeMaterial._disposed) {
            try {
                this._sharedSpikeMaterial.dispose();
                this._sharedSpikeMaterial._disposed = true;
            } catch(e) {
                console.warn('Error disposing shared spike material:', e);
            }
        }
        
        // Clear all crumble timers
        if (this.crumbleTimers) {
            this.crumbleTimers.forEach(timer => {
                try { clearTimeout(timer); } catch {}
            });
            this.crumbleTimers.clear();
        }
        
        // Clear rising lava update interval
        if (this.risingLavaUpdateInterval) {
            clearInterval(this.risingLavaUpdateInterval);
            this.risingLavaUpdateInterval = null;
        }
        
        // Dispose Three.js resources (skip shared materials/geometries)
        this.scene?.traverse(obj => {
            if (obj.geometry && !obj.geometry._isSharedGeometry) {
                try { obj.geometry.dispose(); } catch {}
            }
            if (obj.material) {
                if (Array.isArray(obj.material)) {
                    obj.material.forEach(m => { try { if (!m._isSharedMaterial) m.dispose(); } catch {} });
                } else {
                    try { if (!obj.material._isSharedMaterial) obj.material.dispose(); } catch {}
                }
            }
        });
        
        // Clear intervals
        if (this._debugUpdateInterval) clearInterval(this._debugUpdateInterval);
        
        // Remove settings listeners
        if (this._settingsListeners){
            this._settingsListeners.forEach(rec => {
                try { rec.el.removeEventListener(rec.ev, rec.fn); } catch {}
            });
            this._settingsListeners.length = 0;
        }
        // Remove bound top-level listeners created during setup so they don't leak
        try {
            if (this._boundHotkeys) {
                document.removeEventListener('keydown', this._boundHotkeys);
                this._boundHotkeys = null;
            }
            if (this._onEscapeKey) {
                document.removeEventListener('keydown', this._onEscapeKey);
                this._onEscapeKey = null;
            }
            if (this._btnResumeHandler) {
                const b = document.getElementById('btn-resume'); if (b) b.removeEventListener('click', this._btnResumeHandler);
                this._btnResumeHandler = null;
            }
            if (this._btnRestartHandler) {
                const b2 = document.getElementById('btn-restart-pause'); if (b2) b2.removeEventListener('click', this._btnRestartHandler);
                this._btnRestartHandler = null;
            }
        } catch(e) { console.warn('Error removing top-level listeners during cleanup', e); }
        
        // Destroy menu navigator
        try { menuNavigator?.destroy?.(); } catch {}
        this._isCleaningUp = false;
    }

    // Fully restart current level (environment + player) on R
    restartLevel(){
        if (!this.currentLevel) return;
        GameLogger.action('Restart level requested');
        GameLogger.lifecycle('Restarting level via R.');
        // Stop lava-hurt loop on restart to avoid lingering audio
        try { this.audioManager?.stopLavaHurtLoop?.(); } catch {}
        if (this.cfg?.sandbox){
            this._clearSandboxEnvironment();
            // Rebuild sandbox props after clearing
            this._buildSandboxEnvironment();
        }
    // Re-run level start logic (includes crumble reset)
        this._setupLevelStart();
        // Reset player stats
        if (this.playerController){
            this.playerController.health = this.cfg.player.maxHealth;
            this.playerController.sprint = this.cfg.player.maxSprint;
            this.playerController.uiManager?.updateHealth(this.playerController.health, this.cfg.player.maxHealth);
            this.playerController.uiManager?.updateSprint(this.playerController.sprint, this.cfg.player.maxSprint);
            this.playerController.fsm.setState(STATES.IDLE);
            if (this.playerController.model){
                this.playerController.model.rotation.set(0,0,0); // clear death tilt
            }
            this.playerController.playAnimation(ANIM_MAP.idle, 1);
            // Ensure game over UI is hidden after restart
            this.playerController.uiManager?.hideGameOver();
        }
        // Add to restartLevel() method
        if (this.currentLevel?.id === 'rising_lava' && this.lavaMesh) {
            this.currentLavaHeight = CONFIG.risingLava.START_HEIGHT;
            this.lavaMesh.position.y = this.currentLavaHeight;
        }
        if (this.currentLevel?.id === 'rising_lava' && this.risingLavaUniforms) {
            this.risingLavaUniforms.uTime.value = 0.0;
        }
        if (this.currentLevel?.id === 'rising_lava') {
            // Reset instance-local rising lava speed on restart
            this._risingLavaSpeed = (this.cfg?.risingLava?.RISE_SPEED) ?? CONFIG.risingLava.RISE_SPEED;
            this.risingLavaActive = true;
        } else {
            this.risingLavaActive = false;
        }
        // Re-hide cursor for active gameplay
        document.body.style.cursor='none';
    }

    createRisingLava() {
        // Clean up any existing lava mesh
        if (this.lavaMesh) {
            this.scene.remove(this.lavaMesh);
            this.lavaMesh.geometry.dispose();
            this.lavaMesh.material.dispose();
            this.lavaMesh = null;
        }
        
        // 1. Geometry: A large, flat plane (e.g., 1000 units wide and long)
        // The geometry should be large enough to cover the entire playable area.
        const geometry = new THREE.PlaneGeometry(1000, 1000, 10, 10);
        
        // 2. Material: Use the same shader material as the existing lava
        // Create separate uniforms for the rising lava to avoid conflicts
        const risingLavaUniforms = {
            uTime:   { value: 0.0 },
            uColor1: { value: new THREE.Color(0x000000) }, // black crust
            uColor2: { value: new THREE.Color(0xff4500) }, // deep orange
            uColor3: { value: new THREE.Color(0xff6a00) }, // hot orange
            tNoise:  { value: this.lavaUniforms?.tNoise?.value || null },
            tDiffuse:{ value: this.lavaUniforms?.tDiffuse?.value || null }
        };

        const material = new THREE.ShaderMaterial({
            uniforms: risingLavaUniforms,
            vertexShader: `
                uniform float uTime;
                varying vec2 vUv;
                varying vec2 vWorldXZ;
                void main() {
                    vUv = uv;
                    // Compute world position to drive infinite noise in fragment
                    vec4 worldPos = modelMatrix * vec4(position, 1.0);
                    vWorldXZ = worldPos.xz;

                    // Super-slow, subtle waves (vertex displacement only)
                    float waveSpeed = 0.5;
                    float waveStrength = 0.25;
                    float displacement = sin(position.x * 1.2 + uTime * waveSpeed) * waveStrength;
                    displacement += cos(position.z * 1.0 + uTime * waveSpeed * 0.7) * waveStrength * 0.5;
                    vec3 newPosition = position;
                    newPosition.y += displacement;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
                }
            `,
            fragmentShader: `
                uniform float uTime;
                uniform sampler2D tNoise;
                uniform sampler2D tDiffuse;
                uniform vec3 uColor1; // black
                uniform vec3 uColor2; // deep orange
                uniform vec3 uColor3; // hot orange
                varying vec2 vUv;
                varying vec2 vWorldXZ;

                // Helpers
                float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
                mat2 rot(float a){ float s=sin(a), c=cos(a); return mat2(c,-s,s,c); }

                void main(){
                    // World-space basis. Lower scale => larger features, less obvious tiling
                    vec2 w = vWorldXZ * 0.008;

                    // Slightly faster (still slow) opposing scrolls to ensure visible motion
                    vec2 s1 = vec2(uTime * 0.020, 0.0);
                    vec2 s2 = vec2(0.0, -uTime * 0.017);
                    vec2 s3 = vec2(-uTime * 0.012, uTime * 0.008);

                    // Domain warping via blended noise samples
                    vec2 nA = texture2D(tNoise, w * 0.6 + s1).rg;
                    vec2 nB = texture2D(tNoise, w * 1.3 + s2).rb;
                    vec2 nMix = (nA + nB) * 0.5; // 0..1
                    vec2 warp = (nMix - 0.5) * 0.9; // -0.45..0.45

                    // Time-varying small rotations per layer (subtle swirl)
                    float a1 = sin(uTime * 0.12) * 0.12;
                    float a2 = cos(uTime * 0.09) * 0.15;
                    mat2 r1 = rot(a1);
                    mat2 r2 = rot(a2);

                    // Two differently scaled, rotated, and warped UV layers
                    vec2 uv1 = r1 * (w * 1.15 + warp * 0.7) + s1 * 0.35;
                    vec2 uv2 = r2 * (w * 1.85 - warp * 0.5) + s2 * 0.30;

                    vec3 tex1 = texture2D(tDiffuse, uv1).rgb;
                    vec3 tex2 = texture2D(tDiffuse, uv2).rgb;

                    // Combine layers to break repetition
                    vec3 base = mix(tex1, tex2, 0.5);

                    // Additional soft modulation using a third noise sample
                    float nM = texture2D(tNoise, w * 0.9 + s3).r; // 0..1
                    float intensity = luma(base);
                    intensity *= mix(0.85, 1.15, nM); // slight variance

                    // Map to black/orange palette (tuned thresholds for contrast)
                    float t1 = smoothstep(0.28, 0.58, intensity);
                    float t2 = smoothstep(0.58, 0.80, intensity);
                    vec3 col = mix(uColor1, uColor2, t1);
                    col = mix(col, uColor3, t2);

                    gl_FragColor = vec4(col, 1.0);
                }
            `,
            depthWrite: true,
            side: THREE.DoubleSide
        });
        
        // 3. Mesh: Combine geometry and material
        this.lavaMesh = new THREE.Mesh(geometry, material);
        
        // 4. Orientation: Rotate the plane to be flat on the XZ axis (instead of XY)
        this.lavaMesh.rotation.x = -Math.PI / 2;
        
        // 5. Position: Set the starting height (same as existing lava)
        this.lavaMesh.position.y = CONFIG.risingLava.START_HEIGHT;
        
        // 6. Add to Scene: Add the lava object to your main game scene
        this.scene.add(this.lavaMesh);
        
        // Store the uniforms for animation
        this.risingLavaUniforms = risingLavaUniforms;
        
        // Set texture anisotropy for better quality
        try {
            const aniso = Math.min(8, this.renderer?.capabilities?.getMaxAnisotropy?.() || 4);
            if (risingLavaUniforms.tNoise?.value) risingLavaUniforms.tNoise.value.anisotropy = aniso;
            if (risingLavaUniforms.tDiffuse?.value) risingLavaUniforms.tDiffuse.value.anisotropy = aniso;
        } catch {}
        
        this.risingLavaActive = true;
        GameLogger.lava('Rising lava mesh created at height: ' + CONFIG.risingLava.START_HEIGHT);
    }

    updateRisingLava(dt) {
        // Update shader time for animation
        if (this.risingLavaUniforms) {
            this.risingLavaUniforms.uTime.value += dt;
        }
        
        // Rise continuously until player dies
    // Calculate how much to raise the lava this frame (distance = speed * time)
    const riseAmount = this._risingLavaSpeed * dt;
        
        // Update the tracked height and the 3D object's position
        this.currentLavaHeight += riseAmount;
        this.lavaMesh.position.y = this.currentLavaHeight;
        
    // Optional: Increase the rise speed over time to make the game harder
    // NOTE: modify instance-local speed only; do NOT mutate CONFIG
    this._risingLavaSpeed += 0.05 * dt;
        
        // Log periodically for debugging
        if (Math.floor(this.currentLavaHeight) % 5 === 0 && DEBUG_FLAGS.trackGen) {
            GameLogger.lava(`Rising lava height: ${this.currentLavaHeight.toFixed(2)}`);
        }
    }

    checkRisingLavaCollision() {
        // Assuming 'playerController.body' is your player rigid body and its 'translation().y' is the vertical coordinate.
        // The player's actual "feet" or bottom boundary might be slightly below translation().y, 
        // so you might need a small tolerance (e.g., -0.1).
        if (!this.playerController?.body) return;

        // Don't check collision if player is already dead
        if (this.playerController.fsm.current instanceof DeadState) return;

        const playerPos = this.playerController.body.translation();
        const playerBottomY = playerPos.y - (CONFIG.player.height + CONFIG.player.radius); 

        if (playerBottomY <= this.currentLavaHeight) {
            // Player has touched the lava! Trigger game over.
            GameLogger.lava("GAME OVER: Player fell into the rising lava!");
            
            // Call your existing game over function (e.g., player death)
            try { this.audioManager?.startLavaHurtLoop(); } catch{}
            try { this.playerController?.applyCharredLook?.(); } catch{}
            this.playerController.die('rising_lava');
            
            // Optional: Implement a brief 'sinking' effect by disabling player control 
            // and letting the player's y-position drop below the lava level slightly before stopping.
        }
    }

    // Remove sandbox playground objects & physics bodies
    _clearSandboxEnvironment(){
        if (!this.sandboxDynamicObjects || !this.world) { this.sandboxDynamicObjects = []; return; }
        for (const obj of this.sandboxDynamicObjects){
            if (!obj) continue;
            try { if (obj.mesh) this.scene.remove(obj.mesh); } catch {}
            try { if (obj.body) this.world.removeRigidBody(obj.body); } catch {}
        }
        this.sandboxDynamicObjects.length = 0;
    }

    // Build physics playground objects for sandbox mode
    _buildSandboxEnvironment(){
        this.sandboxDynamicObjects = [];
        this.sandboxHazards = [];
        const scene=this.scene; const world=this.world; const rapier=RAPIER;
        const addDynamic=(mesh, body)=>{ this.sandboxDynamicObjects.push({ mesh, body }); };
        const createPhysicsObject=(geometry, material, bodyDesc, colliderDesc)=>{
            const mesh=new THREE.Mesh(geometry, material);
            mesh.castShadow=true; mesh.receiveShadow=true;
            const body=world.createRigidBody(bodyDesc);
            world.createCollider(colliderDesc, body);
            scene.add(mesh);
            if (body.isDynamic()) addDynamic(mesh, body); else { // static objects need initial transform
                const tr=body.translation(); const rt=body.rotation();
                mesh.position.set(tr.x,tr.y,tr.z);
                mesh.quaternion.set(rt.x,rt.y,rt.z,rt.w);
            }
            return { mesh, body };
        };

        // 1. Static ramp
        const rampGeo=new THREE.BoxGeometry(10,1,30);
        const rampMat=new THREE.MeshStandardMaterial({ color:0x666666, roughness:0.9 });
        const rampAngle=0.3; // radians
        const halfRamp=rampAngle/2; const sinHalfRamp=Math.sin(halfRamp); const cosHalfRamp=Math.cos(halfRamp);
        const rampQuat={ x:0, y:0, z:sinHalfRamp, w:cosHalfRamp }; // rotate around Z
        const rampBodyDesc=rapier.RigidBodyDesc.fixed().setTranslation(20,4,0).setRotation(rampQuat);
        const rampColliderDesc=rapier.ColliderDesc.cuboid(5,0.5,15);
        const ramp=createPhysicsObject(rampGeo, rampMat, rampBodyDesc, rampColliderDesc);
        ramp.mesh.rotation.z=0.3; // match visual

        // 2. Dynamic balls
        const ballGeo=new THREE.SphereGeometry(1.5,32,32);
        const ballMat=new THREE.MeshStandardMaterial({ color:0x3498db, roughness:0.4, metalness:0.2 });
        for (let i=0;i<5;i++){
            const ballBodyDesc=rapier.RigidBodyDesc.dynamic().setTranslation(-10 + i*4, 10, 15).setLinvel(0,-5,0);
            const ballColliderDesc=rapier.ColliderDesc.ball(1.5).setDensity(0.5);
            createPhysicsObject(ballGeo, ballMat, ballBodyDesc, ballColliderDesc);
        }

        // 3. Dynamic spike (single big cone)
        if (!this._sharedSpikeMaterial) this._sharedSpikeMaterial=new THREE.MeshStandardMaterial({ 
            color: 0x8B4513,     // Rusty brown color
            emissive: 0x2F1B14,  // Dark rusty brown emissive
            roughness: 0.9,      // High roughness for texture
            metalness: 0.7       // Some metallic properties for rust
        });
        if (!this._sharedSpikeGeometry) this._sharedSpikeGeometry=new THREE.ConeGeometry(0.5,1.2,8); // radius, height, radialSegments
        const spikeBodyDesc=rapier.RigidBodyDesc.dynamic().setTranslation(-20,5,-10); // Start above ground
        const spikeColliderDesc=rapier.ColliderDesc.cone(0.6,0.5).setDensity(2.0); // height, radius
        const spikeObj=createPhysicsObject(this._sharedSpikeGeometry, this._sharedSpikeMaterial, spikeBodyDesc, spikeColliderDesc);
        this.sandboxHazards.push({ type:'spike', body: spikeObj.body, mesh: spikeObj.mesh, radius:0.5, halfHeight:0.6, cooldown:0 }); // For damage detection

        // 4. Floating tilt platform with revolute joint
        const tiltGeo=new THREE.BoxGeometry(20,0.5,8);
        const tiltMat=new THREE.MeshStandardMaterial({ color:0xe67e22 });
        const tiltMesh=new THREE.Mesh(tiltGeo, tiltMat); tiltMesh.castShadow=true; tiltMesh.receiveShadow=true; scene.add(tiltMesh);
        const tiltBodyDesc=rapier.RigidBodyDesc.dynamic().setTranslation(0,10,-25).setAngularDamping(1.0);
        const tiltBody=world.createRigidBody(tiltBodyDesc);
        const tiltCollider=rapier.ColliderDesc.cuboid(10,0.25,4); world.createCollider(tiltCollider, tiltBody);
        const hingeBodyDesc=rapier.RigidBodyDesc.fixed().setTranslation(0,10,-25);
        const hingeBody=world.createRigidBody(hingeBodyDesc);
        try {
            const joint = rapier.JointData.revolute(
                { x: 0, y: 0, z: 0 }, // anchor1
                { x: 0, y: 0, z: 0 }, // anchor2
                { x: 0, y: 0, z: 1 }  // axis
            );
            world.createImpulseJoint(joint, tiltBody, hingeBody, true);
            // Only track as dynamic if joint successfully created
            addDynamic(tiltMesh, tiltBody);
        } catch (e) {
            reportError('sandbox_joint', 'Failed to create sandbox revolute joint; continuing without hinge', e);
            // Make it a fixed platform instead so it doesn't fall
            try {
                if (tiltBody) world.removeRigidBody(tiltBody);
            } catch {}
            const fixedDesc = rapier.RigidBodyDesc.fixed().setTranslation(0,10,-25);
            const fixedBody = world.createRigidBody(fixedDesc);
            const fixedCol = rapier.ColliderDesc.cuboid(10,0.25,4);
            world.createCollider(fixedCol, fixedBody);
            // Sync mesh to fixed body pose once
            try {
                const tr = fixedBody.translation();
                const rt = fixedBody.rotation();
                tiltMesh.position.set(tr.x, tr.y, tr.z);
                tiltMesh.quaternion.set(rt.x, rt.y, rt.z, rt.w);
            } catch {}
        }
    }

    // Damage detection for sandbox hazards (simplified separate path)
    checkSandboxHazards(dt){
        if (!this.sandboxHazards || !this.playerController?.body) return;
        const playerPos=this.playerController.body.translation();
        const playerBottomY = playerPos.y - (CONFIG.player.height + CONFIG.player.radius);
        for (const hz of this.sandboxHazards){
            if (!hz || !hz.body) continue;
            if (hz.cooldown>0){ hz.cooldown-=dt; continue; }
            const pos=hz.body.translation();
            const dx=playerPos.x - pos.x; const dz=playerPos.z - pos.z; const d2=dx*dx+dz*dz;
            const combined=(hz.radius + CONFIG.player.radius);
            if (d2 < combined*combined){
                // Vertical overlap check
                const spikeTop = pos.y + hz.halfHeight;
                if (playerBottomY < spikeTop){
                    this.playerController.takeDamage(25); // reuse spikeDamage baseline
                    hz.cooldown=1.0; // 1s cooldown
                }
            }
        }
    }

    _createRockGeometry(width, length, height) {
        const segmentsX = Math.max(8, Math.floor(width * 3)); // More segments for detailed rock
        const segmentsZ = Math.max(8, Math.floor(length * 3));
        const segmentsY = 3; // Fewer vertical segments
        
        const geo = new THREE.BoxGeometry(width, height, length, segmentsX, segmentsY, segmentsZ);
        
        const positionAttribute = geo.getAttribute('position');
        const originalPositions = new Float32Array(positionAttribute.array);
        
        // Add color attribute array
        const colors = [];
        
        // Apply rock-like displacement and color variation
        for (let i = 0; i < positionAttribute.count; i++) {
            const x = originalPositions[i * 3];
            const y = originalPositions[i * 3 + 1];
            const z = originalPositions[i * 3 + 2];
            
            // 1. Color variation
            const vertexColor = this._getRockColorVariation(x, y, z, width, length, height);
            colors.push(vertexColor.r, vertexColor.g, vertexColor.b);
            
            // 2. Displacement: Only displace top faces and upper sides
            if (y > height * 0.4) { 
                const displacement = this._getRockDisplacement(x, y, z, width, length, height);
                
                // Apply displacement
                positionAttribute.setXYZ(
                    i,
                    x + displacement.x,
                    y + displacement.y, 
                    z + displacement.z
                );
            }
        }
        
        geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); // Apply vertex colors
        positionAttribute.needsUpdate = true;
        geo.computeVertexNormals(); // Recalculate for proper lighting on displaced geometry
        
        return geo;
    }

    _createRockMaterial(baseColor) {
        return new THREE.MeshStandardMaterial({
            color: baseColor,
            roughness: 0.8,      // Slightly less rough to catch more specular highlights
            metalness: 0.1,      // Add a tiny bit of metallic sheen
            flatShading: false,  // Smooth shading for rock
            vertexColors: true,  // Tells the material to use the colors set in the geometry
        });
    }


    _getRockDisplacement(x, y, z, width, length, height) {
        // Multiple layers of noise for realistic rock texture
        const scale1 = 2.5;  // Large rock formations
        const scale2 = 8.0;  // Medium details 
        const scale3 = 20.0; // Small cracks and details
        
        const nx = x / width;
        const nz = z / length;
        
        // Fractional Brownian Motion for natural rock look
        let noise = 0;
        noise += this._fbm(nx * scale1, nz * scale1) * 0.5;  // Large features
        noise += this._fbm(nx * scale2, nz * scale2) * 0.3;  // Medium details
        noise += this._fbm(nx * scale3, nz * scale3) * 0.2;  // Small details
        
        // Scale displacement based on position (more on top, less on sides)
        const topFactor = Math.max(0, (y - height * 0.3) / (height * 0.7));
        const sideFactor = 1.0 - Math.abs(x) / (width * 0.5);
        const endFactor = 1.0 - Math.abs(z) / (length * 0.5);
        
        const verticalScale = 0.15 * topFactor;
        const horizontalScale = 0.08 * (1.0 - topFactor) * Math.min(sideFactor, endFactor);
        
        return {
            x: (Math.sin(noise * 5.0) * horizontalScale),
            y: noise * verticalScale,
            z: (Math.cos(noise * 5.0) * horizontalScale)
        };
    }


    _getRockColorVariation(x, y, z, width, length, height) {
        const baseColor = this.currentBaseColor; // Access the color set in generateSegment
        
        // Color variation based on position and noise
        const nx = x / width;
        const nz = z / length;
        
        // Use FBM for a noisy, mineral-like variation
        const noise = this._fbm(nx * 15.0, nz * 15.0, 3, 0.3);
        
        let variation;
        // Determine variation based on the base color (the platform type)
        if (baseColor.r > 0.17) { // Tan/Brown rock (Z-tilt)
            variation = { r: 0.9 + noise * 0.15, g: 0.8 + noise * 0.1, b: 0.7 + noise * 0.1 };
        } else if (baseColor.b > 0.15) { // Blue-tinted rock (X-tilt)
            variation = { r: 0.8 + noise * 0.15, g: 0.8 + noise * 0.15, b: 1.0 + noise * 0.1 };
        } else {
            // Gray/Static rock
            variation = { r: 0.9 + noise * 0.2, g: 0.9 + noise * 0.15, b: 0.9 + noise * 0.1 };
        }
        
        // Darken based on noise (crevices are darker)
        const darkenFactor = 0.7 + noise * 0.3;
        
        return new THREE.Color(
            baseColor.r * variation.r * darkenFactor,
            baseColor.g * variation.g * darkenFactor, 
            baseColor.b * variation.b * darkenFactor
        );
    }

    // --- PERLIN NOISE HELPER FUNCTIONS ---

    _fbm(x, z, octaves = 4, persistence = 0.5) {
        let total = 0;
        let frequency = 1;
        let amplitude = 1;
        let maxValue = 0;
        
        for (let i = 0; i < octaves; i++) {
            total += this._ridgedNoise(x * frequency, z * frequency) * amplitude;
            maxValue += amplitude;
            amplitude *= persistence;
            frequency *= 2;
        }
        
        return total / maxValue;
    }

    _ridgedNoise(x, z) {
        // Ridged multi-fractal noise for sharp rock features
        const value = Math.abs(this._simpleNoise(x, z));
        return 1.0 - 2.0 * value;
    }

    _simpleNoise(x, z) {
        // Simple 2D Perlin-like noise function
        const X = Math.floor(x) & 255;
        const Z = Math.floor(z) & 255;
        
        x -= Math.floor(x);
        z -= Math.floor(z);
        
        const u = this._fade(x);
        const v = this._fade(z);
        
        const A = this._perm[X] + Z;
        const B = this._perm[X + 1] + Z;
        
        return this._lerp(
            v,
            this._lerp(u, this._grad(this._perm[A], x, z), this._grad(this._perm[B], x - 1, z)),
            this._lerp(u, this._grad(this._perm[A + 1], x, z - 1), this._grad(this._perm[B + 1], x - 1, z - 1))
        );
    }

    // Noise helper functions
    _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
    _lerp(t, a, b) { return a + t * (b - a); }
    _grad(hash, x, z) {
        const h = hash & 15;
        const u = h < 8 ? x : z;
        const v = h < 4 ? z : h === 12 || h === 14 ? x : 0;
        return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
    }
}
function validateConfig() {
    if (CONFIG.chargeLeap.maxChargeTime <= 0) {
        throw new Error('CONFIG: chargeLeap.maxChargeTime must be positive.');
    }
    if (CONFIG.track.segmentsToKeepBehind <= 0) {
        console.warn('CONFIG: track.segmentsToKeepBehind should be positive to avoid visual pop-in.');
    }
}

// Defer game creation until a level is chosen
window.gameInstance = window.gameInstance || null;
// Menu visible on load

// Expose a minimal public API while preserving backward-compatible globals
try {
    window.Foxrunner = window.Foxrunner || {};
    // Factory to create a fresh game instance
    window.Foxrunner.createGame = function(opts){
        if (opts?.levelId) {
            const level = (typeof LEVELS !== 'undefined') ? LEVELS.find(l => l.id === opts.levelId) : null;
            if (level) window.pendingLevel = level;
        }
        return new Game();
    };
    // Convenience starter
    window.Foxrunner.startLevel = function(levelId){
        try { window.menuManager?.startGame?.(levelId); } catch {}
    };

    // Preserve a few globals for legacy code that expects them
    try { window.menuManager = window.menuManager || menuManager; } catch {}
    try { window.logger = window.logger || (typeof GameLogger !== 'undefined' ? GameLogger : null); } catch {}
    try { window.LEVELS = window.LEVELS || LEVELS; } catch {}
    try { window.CONFIG = window.CONFIG || CONFIG; } catch {}
} catch(e){ console.warn('IIFE export failed', e); }

})(window, document, window.THREE, window.RAPIER);
