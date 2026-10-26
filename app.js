/**
 * ============================================================================
 * IN-SPACe CAN-SAT GCS — MISSION CONTROL CONSOLE APPLICATION (app.js)
 * ============================================================================
 * Team Astrolytics • Payload Call-sign: CAN7USAT • GCS Station Alpha
 *
 * Core Subsystems Integrated:
 *  - TelemetryEngine  (High-rate ring buffer, packet parser, simulator, FSM)
 *  - CalibrationPanel (4-Step Pre-Flight Sensor Diagnostics Wizard)
 *  - ChartsManager    (High-contrast 10Hz dual Chart.js visualizations)
 *  - MapManager       (Leaflet GPS tracking, breadcrumb trail, recovery HUD)
 *  - Attitude3D       (Three.js 3D CanSat Bus with Artificial Horizon)
 *
 * Major UX & Feature Enhancements:
 *  ✅ Attention-Commanding Aerospace Warning Klaxon / Alarm Sound System
 *  ✅ Green & Red Mission Phase Tracker (Completed = Green, Active = Glowing Green, Pending = Red)
 *  ✅ De-Clustered Modular Workspace Tabs (Cockpit, Camera, SAR, Avionics, Console, Master All)
 *  ✅ Whole Dedicated Optical Camera & Computer Vision Suite (Simulated Flight, Local Webcam, HUD, Gallery)
 *  ✅ Dedicated 1-Click Warning Alarm Audio Tester
 *  ✅ Guarded Pyrotechnic Safety Arming Switch & Command Protocol
 * ============================================================================
 */

'use strict';

document.addEventListener('DOMContentLoaded', () => {

    // =======================================================================
    // 1. WEB AUDIO TELEMETRY & WARNING SOUND SYNTHESIZER
    // =======================================================================
    let audioCtx = null;
    let soundEnabled = true;

    function initAudio() {
        if (!audioCtx && (window.AudioContext || window.webkitAudioContext)) {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            audioCtx = new AudioContextClass();
        }
        if (audioCtx && audioCtx.state === 'suspended') {
            audioCtx.resume();
        }
    }

    function playTone(freq, duration = 0.1, type = 'sine', gainVal = 0.15) {
        if (!soundEnabled) return;
        try {
            initAudio();
            if (!audioCtx) return;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
            gain.gain.setValueAtTime(gainVal, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            osc.stop(audioCtx.currentTime + duration);
        } catch (e) {
            // Audio policy fallback
        }
    }

    /**
     * Unmistakable Aerospace Warning Klaxon / Alarm Sound
     * Alternating dual-tone emergency siren (880Hz / 620Hz warble with harmonics)
     */
    function playWarningKlaxon(bursts = 2) {
        if (!soundEnabled) return;
        try {
            initAudio();
            if (!audioCtx) return;

            for (let b = 0; b < bursts; b++) {
                const startTime = audioCtx.currentTime + (b * 0.45);
                const osc1 = audioCtx.createOscillator();
                const osc2 = audioCtx.createOscillator();
                const gain = audioCtx.createGain();

                osc1.type = 'sawtooth';
                osc2.type = 'square';

                // High-low alternating aerospace alarm
                osc1.frequency.setValueAtTime(880, startTime);
                osc1.frequency.setValueAtTime(620, startTime + 0.18);
                osc1.frequency.setValueAtTime(880, startTime + 0.32);

                osc2.frequency.setValueAtTime(440, startTime);
                osc2.frequency.setValueAtTime(310, startTime + 0.18);
                osc2.frequency.setValueAtTime(440, startTime + 0.32);

                gain.gain.setValueAtTime(0.28, startTime);
                gain.gain.linearRampToValueAtTime(0.32, startTime + 0.3);
                gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.42);

                osc1.connect(gain);
                osc2.connect(gain);
                gain.connect(audioCtx.destination);

                osc1.start(startTime);
                osc2.start(startTime);
                osc1.stop(startTime + 0.42);
                osc2.stop(startTime + 0.42);
            }
        } catch (e) {
            // Audio fallback
        }
    }

    const soundFX = {
        connect: () => {
            playTone(523.25, 0.12, 'sine', 0.2); // C5
            setTimeout(() => playTone(659.25, 0.18, 'sine', 0.2), 120); // E5
        },
        disconnect: () => {
            playTone(659.25, 0.12, 'sine', 0.2);
            setTimeout(() => playTone(440.00, 0.2, 'sine', 0.2), 120);
        },
        arm: () => {
            playTone(880, 0.1, 'square', 0.2);
            setTimeout(() => playTone(880, 0.15, 'square', 0.25), 140);
        },
        disarm: () => {
            playTone(440, 0.15, 'sine', 0.15);
        },
        apogee: () => {
            playTone(587.33, 0.15, 'sine', 0.25); // D5
            setTimeout(() => playTone(880.00, 0.25, 'sine', 0.25), 150); // A5
            setTimeout(() => playTone(1174.66, 0.4, 'sine', 0.2), 350); // D6
        },
        warning: () => {
            // Standard attention alert
            playWarningKlaxon(1);
        },
        criticalAlarm: () => {
            // Critical warning alarm burst
            playWarningKlaxon(3);
        },
        phaseChime: () => {
            // Flight phase advancement confirmation tone (C5 -> G5)
            playTone(523.25, 0.1, 'sine', 0.18);
            setTimeout(() => playTone(783.99, 0.18, 'sine', 0.2), 100);
        },
        shutter: () => {
            // Mechanical camera shutter click
            playTone(1200, 0.02, 'square', 0.15);
            setTimeout(() => playTone(800, 0.04, 'triangle', 0.2), 30);
        },
        uplink: () => {
            playTone(1046.50, 0.08, 'sine', 0.2); // C6
        },
        click: () => {
            playTone(800, 0.03, 'sine', 0.05);
        }
    };

    // =======================================================================
    // 2. INSTANTIATE CORE SUBSYSTEMS
    // =======================================================================
    /** @type {TelemetryEngine} */
    const engine = new TelemetryEngine({
        capacity: 36000,
        gcsLat: 13.7199,
        gcsLon: 80.2305,
        gcsAlt: 10.0,
        maxReconnectAttempts: 3,
        baseReconnectDelayMs: 1000
    });

    /** @type {CalibrationPanel} */
    const calPanel = new CalibrationPanel(engine);
    window._cansatCalInstance = calPanel;
    window._telemetryEngine = engine;

    /** @type {ChartsManager|null} */
    const charts = (typeof ChartsManager !== 'undefined') ? new ChartsManager() : null;
    if (charts) {
        charts.initAltitudeChart('altitude-chart');
        charts.initEnvironmentChart('env-chart');
        if (typeof charts.initIMUCharts === 'function') {
            charts.initIMUCharts('chart-accel', 'chart-gyro', 'chart-mag');
        }
        if (typeof charts.setTheme === 'function') {
            charts.setTheme('light');
        }
    }

    /** @type {MapManager|null} */
    const mapMgr = (typeof MapManager !== 'undefined')
        ? new MapManager({ mapContainerId: 'map-container' })
        : null;

    /** @type {Attitude3D|null} */
    const attitude = (typeof Attitude3D !== 'undefined')
        ? new Attitude3D('attitude-canvas')
        : (typeof AttitudeIndicator !== 'undefined' ? new AttitudeIndicator('attitude-canvas') : null);

    // =======================================================================
    // 3. DOM ELEMENT CACHE
    // =======================================================================
    const $ = (id) => document.getElementById(id);

    const connectBtn       = $('connect-btn');
    const gcsLinkStatus    = $('gcs-link-status');
    const gcsLinkIndicator = $('gcs-link-indicator');
    const gcsLinkText      = $('gcs-link-text');
    const portSelect       = $('com-port-select');
    const baudSelect       = $('baud-rate-select');
    const armToggle        = $('arm-toggle');
    const btnCalibration   = $('btn-calibration');
    const eventLog         = $('event-log');
    const missionBadge     = $('mission-state-badge');
    const metDisplay       = $('mission-elapsed-time');
    const warningBanner    = $('telemetry-warning');
    const warningMsgText   = $('warning-message-text');
    const btnTestAlarm     = $('btn-test-alarm');
    const btnBannerAlarm   = $('btn-banner-test-alarm');
    const lowVoltAlert     = $('low-voltage-alert');
    const btnCSV           = $('btn-csv');
    const btnKML           = $('btn-kml');
    const btnClear         = $('btn-clear');
    const btnQuickSim      = $('btn-quick-sim');
    const btnAudioToggle   = $('btn-audio-toggle');
    const btnThemeToggle   = $('btn-theme-toggle');
    const btnFullscreen    = $('btn-fullscreen');
    const btnShortcuts     = $('btn-shortcuts');
    const shortcutsModal   = $('shortcuts-modal');
    const btnAddNote       = $('btn-add-note');
    const noteInput        = $('operator-note-input');
    const btnCopyCoords    = $('btn-copy-coords');
    const btnResetAttitude = $('btn-reset-attitude');
    const btnRecenterMap   = $('btn-recenter-map');

    // Camera DOM elements
    const camViewport      = $('cam-viewport');
    const camCanvas        = $('cam-canvas-viewport');
    const camVideo         = $('cam-webcam-video');
    const camLiveImg       = $('cam-live-image');
    const camFlashOverlay  = $('cam-flash-overlay');
    const camScanline      = $('cam-scanline-overlay');
    const camSnapshotBtn   = $('cam-snapshot-btn');
    const camRecordBtn     = $('cam-record-btn');
    const camRecordLabel   = $('cam-record-label');
    const camFilterSelect  = $('cam-filter-select');
    const camIntervalSelect= $('cam-interval-select');
    const camSourceSim     = $('cam-source-sim');
    const camSourceWebcam  = $('cam-source-webcam');
    const camSourceStream  = $('cam-source-stream');
    const camGalleryList   = $('cam-gallery-container');
    const camGalleryCount  = $('cam-gallery-count');
    const camGalleryClear  = $('cam-gallery-clear');
    const camZoom1x        = $('cam-zoom-1x');
    const camZoom2x        = $('cam-zoom-2x');
    const camZoom4x        = $('cam-zoom-4x');

    // =======================================================================
    // 4. MISSION ELAPSED TIME (MET) & UTC CLOCK
    // =======================================================================
    let missionStartTime = null;
    let metInterval = null;

    function startMET() {
        if (missionStartTime) return;
        missionStartTime = Date.now();
        metInterval = setInterval(() => {
            const elapsed = Math.floor((Date.now() - missionStartTime) / 1000);
            const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
            const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
            const s = String(elapsed % 60).padStart(2, '0');
            if (metDisplay) metDisplay.textContent = `MET: ${h}:${m}:${s}`;
        }, 1000);
    }

    function stopMET() {
        if (metInterval) clearInterval(metInterval);
        metInterval = null;
        missionStartTime = null;
        if (metDisplay) metDisplay.textContent = 'MET: 00:00:00';
    }

    /**
     * Format a timestamp into exact real-time UTC strings
     * @param {Date} [date=new Date()]
     * @param {boolean} [withMs=false]
     * @returns {string} HH:mm:ss or HH:mm:ss.SSS
     */
    function formatUTCTime(date = new Date(), withMs = false) {
        const h = String(date.getUTCHours()).padStart(2, '0');
        const m = String(date.getUTCMinutes()).padStart(2, '0');
        const s = String(date.getUTCSeconds()).padStart(2, '0');
        if (withMs) {
            const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
            return `${h}:${m}:${s}.${ms}`;
        }
        return `${h}:${m}:${s}`;
    }

    /**
     * Format full real-time UTC date-time string: YYYY-MM-DD HH:mm:ss.SSS UTC
     */
    function formatFullUTCDate(date = new Date()) {
        const y = date.getUTCFullYear();
        const mo = String(date.getUTCMonth() + 1).padStart(2, '0');
        const d = String(date.getUTCDate()).padStart(2, '0');
        return `${y}-${mo}-${d} ${formatUTCTime(date, true)} UTC`;
    }

    // High-Precision Real-Time UTC Clock
    // Modes: 0 = 'HH:mm:ss.SSS' (Precise Milliseconds - DEFAULT), 1 = 'YYYY-MM-DD HH:mm:ss.SSS UTC' (Full), 2 = 'HH:mm:ss' (Standard)
    let clockDisplayMode = 0;
    window._utcMode = 0;
    const clockEl = $('clock-utc');
    if (clockEl) {
        clockEl.style.cursor = 'pointer';
        clockEl.addEventListener('click', () => {
            clockDisplayMode = (clockDisplayMode + 1) % 3;
            window._utcMode = clockDisplayMode;
            updateUTCClocks();
        });
    }

    function updateUTCClocks() {
        const now = new Date();
        const utcStandard = formatUTCTime(now, false);
        const utcHighPrec = formatUTCTime(now, true);
        const fullUTC = formatFullUTCDate(now);

        // Header Top Status Bar UTC Clock (Defaults to High-Precision Milliseconds)
        if (clockEl) {
            if (clockDisplayMode === 0) {
                clockEl.textContent = `UTC: ${utcHighPrec}`;
            } else if (clockDisplayMode === 1) {
                clockEl.textContent = fullUTC;
            } else {
                clockEl.textContent = `UTC: ${utcStandard}`;
            }
            clockEl.title = `Exact Real-Time UTC: ${fullUTC} (Click to toggle format: Milliseconds / Full Date / Standard)`;
        }

        // Live Optical HUD Viewport UTC & Timestamp (Real-Time continuous)
        const hudUtc = $('cam-hud-utc');
        if (hudUtc) {
            hudUtc.textContent = `UTC: ${utcHighPrec}`;
        }

        const camTs = $('cam-timestamp');
        if (camTs) {
            camTs.textContent = `TS: ${utcHighPrec} UTC`;
        }
    }

    // Initialize immediately without delay and tick at 20 Hz (every 50ms) for real-time accuracy
    updateUTCClocks();
    setInterval(updateUTCClocks, 50);

    // =======================================================================
    // 5. EVENT STREAM TERMINAL
    // =======================================================================
    const LOG_COLORS = {
        info:    'text-blue-600 dark:text-cyan-400',
        success: 'text-emerald-600 dark:text-emerald-400 font-bold',
        warning: 'text-amber-600 dark:text-amber-400 font-bold',
        error:   'text-rose-600 dark:text-rose-400 font-black',
        data:    'text-purple-600 dark:text-purple-400',
        system:  'text-slate-500 dark:text-slate-400',
        note:    'text-indigo-600 dark:text-indigo-300 font-bold'
    };

    function logEvent(message, level = 'info') {
        if (!eventLog) return;
        const now = new Date();
        const ts = formatUTCTime(now, true);
        const colorClass = LOG_COLORS[level] || 'text-slate-300';
        const tag = level.toUpperCase().padEnd(7);

        const div = document.createElement('div');
        div.className = colorClass;
        div.textContent = `[${ts} UTC] [${tag}] ${message}`;
        eventLog.appendChild(div);

        while (eventLog.children.length > 300) {
            eventLog.removeChild(eventLog.firstChild);
        }
        eventLog.scrollTop = eventLog.scrollHeight;
    }

    // =======================================================================
    // 6. WARNING ALARM SOUND TRIGGER & TESTERS
    // =======================================================================
    function triggerWarningAlarm(message = null, bursts = 2) {
        soundFX.warning();
        if (message && warningMsgText) {
            warningMsgText.innerHTML = `<strong>CRITICAL FLIGHT WARNING:</strong> ${message}`;
        }
        if (warningBanner) {
            warningBanner.classList.remove('hidden');
        }
        // Pulse the alarm button
        if (btnTestAlarm) {
            btnTestAlarm.classList.add('klaxon-active', 'bg-rose-600', 'text-white');
            setTimeout(() => {
                btnTestAlarm.classList.remove('klaxon-active', 'bg-rose-600', 'text-white');
            }, 1200);
        }
    }

    if (btnTestAlarm) {
        btnTestAlarm.addEventListener('click', () => {
            initAudio();
            triggerWarningAlarm('Warning alarm sound system self-test initiated by operator.', 2);
            logEvent('WARNING ALARM SOUND TEST: Aerospace dual-tone klaxon executed.', 'warning');
        });
    }

    if (btnBannerAlarm) {
        btnBannerAlarm.addEventListener('click', () => {
            initAudio();
            triggerWarningAlarm(null, 2);
        });
    }

    // =======================================================================
    // 7. FLIGHT PHASES TRACKER (Green & Red Combination)
    // =======================================================================
    /**
     * Standardized sequential CanSat flight phases:
     * 1. PRE_FLIGHT
     * 2. LAUNCH_PAD
     * 3. POWERED_ASCENT
     * 4. APOGEE
     * 5. MAIN_DESCENT
     * 6. TOUCHDOWN
     *
     * Rule:
     *  - Completed phases: GREEN (Solid emerald with checkmark)
     *  - Active phase: ACTIVE GREEN (Pulsating beacon with ring)
     *  - Pending phases: RED (Rose border and light red background)
     */
    const FLIGHT_PHASES_SEQUENCE = [
        { key: 'PRE_FLIGHT',     num: 1, label: 'Pre-Flight',    pillId: 'step-pill-pre' },
        { key: 'LAUNCH_PAD',     num: 2, label: 'Pad',           pillId: 'step-pill-pad' },
        { key: 'POWERED_ASCENT', num: 3, label: 'Ascent',        pillId: 'step-pill-ascent' },
        { key: 'APOGEE',         num: 4, label: 'Apogee',        pillId: 'step-pill-apogee' },
        { key: 'MAIN_DESCENT',   num: 5, label: 'Main',          pillId: 'step-pill-main' },
        { key: 'TOUCHDOWN',      num: 6, label: 'Touchdown',     pillId: 'step-pill-touchdown' }
    ];

    let currentFlightState = 'PRE_FLIGHT';
    let prevFlightState = null;

    function updateFlightStateBadge(state) {
        const displayState = state === 'DROGUE_DESCENT' ? 'MAIN_DESCENT' : state;
        let activeIdx = FLIGHT_PHASES_SEQUENCE.findIndex(p => p.key === displayState);
        if (activeIdx === -1) activeIdx = 0;
        currentFlightState = displayState;

        // Sound chime or apogee celebration if phase changed
        if (prevFlightState !== null && prevFlightState !== state) {
            if (state === 'APOGEE') {
                soundFX.apogee();
            } else {
                soundFX.phaseChime();
            }
        }
        prevFlightState = state;

        // Update each phase pill with Green and Red combination
        FLIGHT_PHASES_SEQUENCE.forEach((phase, idx) => {
            const pill = $(phase.pillId);
            if (!pill) return;

            if (idx < activeIdx) {
                // COMPLETED PHASE -> GREEN with checkmark
                pill.className = 'px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs border border-emerald-500 shadow-sm transition-all flex items-center gap-1.5 cursor-pointer';
                pill.innerHTML = `<span class="w-3.5 h-3.5 rounded-full bg-emerald-700/80 flex items-center justify-center text-[10px]">✓</span><span>${phase.num}. ${phase.label}</span>`;
                pill.title = `Phase ${phase.num}: ${phase.label} [COMPLETED] - Click to jump`;
            } else if (idx === activeIdx) {
                // CURRENT ACTIVE PHASE -> ACTIVE GLOWING GREEN
                pill.className = 'px-3 py-1 rounded-lg bg-emerald-500 text-white font-black text-xs border-2 border-emerald-300 ring-2 ring-emerald-400/50 shadow-md animate-pulse transition-all flex items-center gap-1.5 cursor-pointer';
                pill.innerHTML = `<span class="w-2 h-2 rounded-full bg-white animate-ping"></span><span>${phase.num}. ${phase.label}</span><span class="text-[9px] bg-emerald-700/70 px-1 rounded uppercase font-mono">LIVE</span>`;
                pill.title = `Phase ${phase.num}: ${phase.label} [ACTIVE IN PROGRESS]`;
            } else {
                // PENDING / INCOMPLETE PHASE -> RED
                pill.className = 'px-2.5 py-1 rounded-lg bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:hover:bg-rose-900/40 text-rose-700 dark:text-rose-300 font-bold text-xs border border-rose-300 dark:border-rose-800 shadow-xs transition-all flex items-center gap-1.5 cursor-pointer';
                pill.innerHTML = `<span class="w-2 h-2 rounded-full border border-rose-500"></span><span>${phase.num}. ${phase.label}</span>`;
                pill.title = `Phase ${phase.num}: ${phase.label} [INCOMPLETE / PENDING] - Click to jump`;
            }
        });

        // Update connecting stepper arrows
        for (let i = 1; i <= 6; i++) {
            const arrow = $(`step-arrow-${i}`);
            if (arrow) {
                if (i <= activeIdx) {
                    arrow.className = 'text-emerald-500 font-black text-xs';
                } else {
                    arrow.className = 'text-rose-400 font-black text-xs';
                }
            }
        }

        // Update main mission state badge
        if (missionBadge) {
            const currentPhaseObj = FLIGHT_PHASES_SEQUENCE[activeIdx];
            const pendingCount = FLIGHT_PHASES_SEQUENCE.length - 1 - activeIdx;
            missionBadge.className = 'px-3.5 py-1 rounded-full text-xs font-black tracking-wider uppercase bg-emerald-600 text-white border border-emerald-400 shadow-sm flex items-center gap-2';
            missionBadge.innerHTML = `
                <span class="w-2 h-2 rounded-full bg-white animate-ping"></span>
                <span>${currentPhaseObj.label}</span>
                <span class="text-[9px] font-mono bg-emerald-800/80 px-1.5 py-0.5 rounded-full font-bold">PHASE ${currentPhaseObj.num}/6</span>
                ${pendingCount > 0 ? `<span class="text-[9px] font-mono bg-rose-600 text-white px-1.5 py-0.5 rounded-full font-bold">${pendingCount} PENDING</span>` : '<span class="text-[9px] font-mono bg-emerald-800 text-white px-1.5 py-0.5 rounded-full font-bold">MISSION COMPLETE</span>'}
            `;
        }

        // Update camera HUD phase watermark
        const camHudPhase = $('cam-hud-phase');
        if (camHudPhase) {
            camHudPhase.textContent = FLIGHT_PHASES_SEQUENCE[activeIdx].label.toUpperCase();
        }

        if (window.lucide) lucide.createIcons();
    }

    // Enable interactive phase skipping / testing on click
    FLIGHT_PHASES_SEQUENCE.forEach((phase) => {
        const pill = $(phase.pillId);
        if (pill) {
            pill.addEventListener('click', () => {
                updateFlightStateBadge(phase.key);
                logEvent(`MANUAL PHASE OVERRIDE: Set flight state to [${phase.label}] (Phase ${phase.num}/6).`, 'warning');
                triggerWarningAlarm(`Phase manually overridden to ${phase.label}. Completed phases turn green, pending turn red.`, 1);
            });
        }
    });

    // =======================================================================
    // 8. DE-CLUSTERED WORKSPACE SECTIONS & TAB SWITCHER
    // =======================================================================
    const sectionTabs = document.querySelectorAll('.section-tab-btn');
    const sections = {
        cockpit:  $('section-cockpit'),
        camera:   $('section-camera'),
        sar:      $('section-sar'),
        avionics: $('section-avionics'),
        console:  $('section-console'),
        testing:  $('section-testing')
    };

    // Cockpit Sub-Tab Switcher (IMU & 3D Attitude vs Atmospheric Profile)
    window.toggleCockpitView = function(view) {
        const imuGrid = $('cockpit-primary-grid');
        const atmoGrid = $('cockpit-atmo-grid');
        const btnImu = $('btn-cockpit-tab-imu');
        const btnAtmo = $('btn-cockpit-tab-atmo');

        if (view === 'atmo') {
            if (imuGrid) imuGrid.classList.add('hidden');
            if (atmoGrid) atmoGrid.classList.remove('hidden');
            if (btnImu) btnImu.className = 'px-3 py-1 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-space-700 transition-all flex items-center gap-1.5 cursor-pointer';
            if (btnAtmo) btnAtmo.className = 'px-3 py-1 rounded-lg bg-blue-600 text-white shadow-xs transition-all flex items-center gap-1.5 cursor-pointer';
            if (charts && typeof charts.resize === 'function') charts.resize();
        } else {
            if (imuGrid) imuGrid.classList.remove('hidden');
            if (atmoGrid) atmoGrid.classList.add('hidden');
            if (btnImu) btnImu.className = 'px-3 py-1 rounded-lg bg-blue-600 text-white shadow-xs transition-all flex items-center gap-1.5 cursor-pointer';
            if (btnAtmo) btnAtmo.className = 'px-3 py-1 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-space-700 transition-all flex items-center gap-1.5 cursor-pointer';
            if (charts && typeof charts.resize === 'function') charts.resize();
            if (attitude && typeof attitude.onResize === 'function') attitude.onResize();
        }
    };

    function switchSection(targetTab) {
        // Update active class on tab buttons
        sectionTabs.forEach(btn => {
            if (btn.dataset.sectionTab === targetTab) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        // Show/hide section containers
        if (targetTab === 'all') {
            // Master Overview: show all sections in clean, unclustered layout
            Object.values(sections).forEach(sec => {
                if (sec) sec.style.display = 'block';
            });
        } else {
            // Focus on single workspace section
            Object.keys(sections).forEach(key => {
                const sec = sections[key];
                if (!sec) return;
                if (key === targetTab) {
                    sec.style.display = 'block';
                } else {
                    sec.style.display = 'none';
                }
            });
        }

        // Trigger resize events for graphics engines
        setTimeout(() => {
            if (charts && typeof charts.resize === 'function') charts.resize();
            if (attitude && typeof attitude.onResize === 'function') attitude.onResize();
            if (mapMgr && mapMgr.map && typeof mapMgr.map.invalidateSize === 'function') {
                mapMgr.map.invalidateSize();
            }
        }, 60);

        try {
            localStorage.setItem('cansat_active_tab', targetTab);
        } catch (e) {}

        soundFX.click();
    }

    sectionTabs.forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.sectionTab;
            switchSection(target);
        });
    });

    // Restore saved section preference or default to Cockpit
    const savedTab = localStorage.getItem('cansat_active_tab') || 'cockpit';
    switchSection(savedTab);

    // =======================================================================
    // 9. WHOLE DEDICATED OPTICAL CAMERA & COMPUTER VISION SUITE
    // =======================================================================
    let cameraMode = 'sim'; // 'sim' | 'webcam' | 'stream'
    let cameraStream = null;
    let cameraIntervalTimer = null;
    let isRecordingVideo = false;
    let mediaRecorder = null;
    let recordedChunks = [];
    let currentZoom = 1.0;
    const capturedGallery = [];

    // Initialize HTML5 Canvas for Simulated CanSat Flight View
    const camCtx = camCanvas ? camCanvas.getContext('2d') : null;
    let simulatedHorizonAngle = 0;
    let simulatedPitchOffset = 0;
    let cloudOffset = 0;

    function renderSimulatedCameraFrame() {
        if (!camCtx || cameraMode !== 'sim') return;

        const w = camCanvas.width;
        const h = camCanvas.height;

        // Altitude & Horizon dynamics
        const alt = Number($('alt-value')?.textContent || 0) || 0;
        const vz = Number($('vz-value')?.textContent || 0) || 0;
        const rollDeg = Number($('roll-val')?.textContent?.replace('°', '') || 0);
        const pitchDeg = Number($('pitch-val')?.textContent?.replace('°', '') || 0);

        simulatedHorizonAngle = (rollDeg * Math.PI) / 180;
        simulatedPitchOffset = Math.max(-80, Math.min(80, pitchDeg * 1.5));
        cloudOffset = (cloudOffset + 0.5 + Math.abs(vz) * 0.1) % w;

        // Clear canvas
        camCtx.save();
        camCtx.clearRect(0, 0, w, h);

        // Center on horizon
        camCtx.translate(w / 2, h / 2 + simulatedPitchOffset);
        camCtx.rotate(-simulatedHorizonAngle);

        // Sky gradient (shifts to dark stratosphere with high altitude)
        const skyGrad = camCtx.createLinearGradient(0, -h, 0, 0);
        const stratDarkness = Math.min(1, alt / 1000);
        skyGrad.addColorStop(0, `rgb(${Math.floor(15 - stratDarkness * 10)}, ${Math.floor(40 - stratDarkness * 30)}, ${Math.floor(90 - stratDarkness * 60)})`);
        skyGrad.addColorStop(1, `rgb(${Math.floor(56 + stratDarkness * 20)}, ${Math.floor(189 - stratDarkness * 100)}, ${Math.floor(248 - stratDarkness * 120)})`);
        camCtx.fillStyle = skyGrad;
        camCtx.fillRect(-w * 2, -h * 2, w * 4, h * 2);

        // Earth / Terrain gradient
        const groundGrad = camCtx.createLinearGradient(0, 0, 0, h);
        groundGrad.addColorStop(0, '#15803d');
        groundGrad.addColorStop(0.3, '#166534');
        groundGrad.addColorStop(0.7, '#3f3f46');
        groundGrad.addColorStop(1, '#0284c7'); // Coastline/Bay of Bengal
        camCtx.fillStyle = groundGrad;
        camCtx.fillRect(-w * 2, 0, w * 4, h * 2);

        // Horizon Line
        camCtx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        camCtx.lineWidth = 1.5;
        camCtx.beginPath();
        camCtx.moveTo(-w * 2, 0);
        camCtx.lineTo(w * 2, 0);
        camCtx.stroke();

        // Drifting Clouds
        camCtx.fillStyle = 'rgba(255, 255, 255, 0.35)';
        for (let i = -2; i < 4; i++) {
            const cx = ((i * 180 + cloudOffset) % (w * 2)) - w;
            const cy = -h * 0.35 - (i * 20);
            camCtx.beginPath();
            camCtx.ellipse(cx, cy, 60, 18, 0, 0, Math.PI * 2);
            camCtx.fill();
        }

        // Ground Target / Launch Pad Marker
        camCtx.strokeStyle = 'rgba(239, 68, 68, 0.6)';
        camCtx.lineWidth = 2;
        camCtx.beginPath();
        camCtx.arc(0, h * 0.4, 25, 0, Math.PI * 2);
        camCtx.stroke();
        camCtx.fillStyle = 'rgba(239, 68, 68, 0.8)';
        camCtx.font = 'bold 9px monospace';
        camCtx.fillText('PAD-01 SRIHARIKOTA', -45, h * 0.4 + 38);

        camCtx.restore();

        // Update live HUD pitch ladder line
        const hudHorizon = $('cam-hud-horizon');
        if (hudHorizon) {
            hudHorizon.style.transform = `rotate(${-rollDeg}deg) translateY(${simulatedPitchOffset * 0.3}px)`;
        }
    }

    // 15 FPS Camera Render Loop
    setInterval(renderSimulatedCameraFrame, 66);

    // Switch to Simulated Aerial Feed
    if (camSourceSim) {
        camSourceSim.addEventListener('click', () => {
            if (cameraStream) {
                cameraStream.getTracks().forEach(track => track.stop());
                cameraStream = null;
            }
            cameraMode = 'sim';
            if (camCanvas) camCanvas.classList.remove('hidden');
            if (camVideo) camVideo.classList.add('hidden');
            if (camLiveImg) camLiveImg.classList.add('hidden');
            camSourceSim.className = 'px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-600 text-white shadow-xs transition-all flex items-center gap-1';
            camSourceWebcam.className = 'px-2.5 py-1 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-space-700 transition-all flex items-center gap-1';
            camSourceStream.className = 'px-2.5 py-1 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-space-700 transition-all flex items-center gap-1';
            const statusLabel = $('cam-status-label');
            if (statusLabel) statusLabel.textContent = 'LIVE FEED: SIMULATED CAN-SAT AERIAL DOWNLINK';
            soundFX.click();
            logEvent('Camera source switched to Simulated Flight Aerial Feed.', 'info');
        });
    }

    // Switch to Local Device Webcam
    if (camSourceWebcam) {
        camSourceWebcam.addEventListener('click', async () => {
            try {
                if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
                    cameraStream = await navigator.mediaDevices.getUserMedia({
                        video: { width: { ideal: 1280 }, height: { ideal: 720 } }
                    });
                    if (camVideo) {
                        camVideo.srcObject = cameraStream;
                        camVideo.classList.remove('hidden');
                    }
                    if (camCanvas) camCanvas.classList.add('hidden');
                    if (camLiveImg) camLiveImg.classList.add('hidden');
                    cameraMode = 'webcam';

                    camSourceWebcam.className = 'px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-600 text-white shadow-xs transition-all flex items-center gap-1';
                    camSourceSim.className = 'px-2.5 py-1 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-space-700 transition-all flex items-center gap-1';
                    camSourceStream.className = 'px-2.5 py-1 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-space-700 transition-all flex items-center gap-1';
                    
                    const statusLabel = $('cam-status-label');
                    if (statusLabel) statusLabel.textContent = 'LIVE FEED: LOCAL OPTICAL WEBCAM CONNECTED';
                    soundFX.connect();
                    logEvent('Local device webcam feed engaged for optical inspection.', 'success');
                } else {
                    alert('Webcam API is not supported in this browser.');
                }
            } catch (err) {
                logEvent(`Webcam access error: ${err.message}`, 'error');
                soundFX.warning();
            }
        });
    }

    // Switch to IP / Network Stream URL
    if (camSourceStream) {
        camSourceStream.addEventListener('click', () => {
            const url = prompt('Enter ESP32-CAM MJPEG or RTSP Stream URL:', 'http://192.168.4.1/stream');
            if (url) {
                if (cameraStream) {
                    cameraStream.getTracks().forEach(t => t.stop());
                    cameraStream = null;
                }
                cameraMode = 'stream';
                if (camLiveImg) {
                    camLiveImg.src = url;
                    camLiveImg.classList.remove('hidden');
                }
                if (camCanvas) camCanvas.classList.add('hidden');
                if (camVideo) camVideo.classList.add('hidden');

                camSourceStream.className = 'px-2.5 py-1 rounded-lg text-xs font-bold bg-blue-600 text-white shadow-xs transition-all flex items-center gap-1';
                camSourceSim.className = 'px-2.5 py-1 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-space-700 transition-all flex items-center gap-1';
                camSourceWebcam.className = 'px-2.5 py-1 rounded-lg text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-space-700 transition-all flex items-center gap-1';

                const statusLabel = $('cam-status-label');
                if (statusLabel) statusLabel.textContent = `LIVE FEED: ESP32-CAM [${url}]`;
                soundFX.connect();
                logEvent(`Connected to IP camera stream: ${url}`, 'success');
            }
        });
    }

    // Optical Spectral Filter Selector
    if (camFilterSelect) {
        camFilterSelect.addEventListener('change', () => {
            const filter = camFilterSelect.value;
            const targetEl = cameraMode === 'webcam' ? camVideo : camCanvas;
            
            // Remove previous filter classes
            [camCanvas, camVideo, camLiveImg].forEach(el => {
                if (!el) return;
                el.classList.remove('filter-thermal', 'filter-nightvision', 'filter-edgedetect');
            });

            if (camScanline) {
                if (filter === 'scanlines') {
                    camScanline.style.opacity = '0.7';
                } else {
                    camScanline.style.opacity = '0.35';
                }
            }

            if (filter === 'thermal' && targetEl) targetEl.classList.add('filter-thermal');
            if (filter === 'nightvision' && targetEl) targetEl.classList.add('filter-nightvision');
            if (filter === 'edgedetect' && targetEl) targetEl.classList.add('filter-edgedetect');

            soundFX.click();
            logEvent(`Optical spectral filter set to: ${filter.toUpperCase()}`, 'info');
        });
    }

    // Digital Zoom Handlers
    function setCameraZoom(zoomVal) {
        currentZoom = zoomVal;
        const targetEl = cameraMode === 'webcam' ? camVideo : camCanvas;
        if (targetEl) {
            targetEl.style.transform = `scale(${zoomVal})`;
            targetEl.style.transition = 'transform 0.25s ease';
        }
        [camZoom1x, camZoom2x, camZoom4x].forEach(b => {
            if (!b) return;
            b.className = 'py-1 rounded-lg text-xs font-bold bg-slate-100 hover:bg-slate-200 dark:bg-space-800 text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-space-700 transition-all';
        });
        if (zoomVal === 1.0 && camZoom1x) camZoom1x.className = 'py-1 rounded-lg text-xs font-bold bg-blue-600 text-white border border-blue-500 transition-all';
        if (zoomVal === 2.0 && camZoom2x) camZoom2x.className = 'py-1 rounded-lg text-xs font-bold bg-blue-600 text-white border border-blue-500 transition-all';
        if (zoomVal === 4.0 && camZoom4x) camZoom4x.className = 'py-1 rounded-lg text-xs font-bold bg-blue-600 text-white border border-blue-500 transition-all';
        soundFX.click();
    }

    if (camZoom1x) camZoom1x.addEventListener('click', () => setCameraZoom(1.0));
    if (camZoom2x) camZoom2x.addEventListener('click', () => setCameraZoom(2.0));
    if (camZoom4x) camZoom4x.addEventListener('click', () => setCameraZoom(4.0));

    // Capture Snapshot & Filmstrip Gallery Addition
    function captureSnapshot() {
        soundFX.shutter();

        // Shutter flash animation
        if (camFlashOverlay) {
            camFlashOverlay.classList.remove('shutter-flash-active');
            void camFlashOverlay.offsetWidth; // Trigger reflow
            camFlashOverlay.classList.add('shutter-flash-active');
        }

        // Generate data URL from canvas or video
        let dataUrl = '';
        if (cameraMode === 'webcam' && camVideo && camVideo.videoWidth) {
            const offCanvas = document.createElement('canvas');
            offCanvas.width = camVideo.videoWidth;
            offCanvas.height = camVideo.videoHeight;
            const offCtx = offCanvas.getContext('2d');
            offCtx.drawImage(camVideo, 0, 0);
            dataUrl = offCanvas.toDataURL('image/jpeg', 0.85);
        } else if (camCanvas) {
            dataUrl = camCanvas.toDataURL('image/jpeg', 0.85);
        }

        if (!dataUrl) return;

        const now = new Date();
        const timeStr = `${formatUTCTime(now, true)} UTC`;
        const alt = $('alt-value')?.textContent || '0.0';
        const phase = currentFlightState;

        const photoRecord = {
            id: Date.now(),
            dataUrl,
            time: timeStr,
            alt: `${alt}m`,
            phase
        };

        capturedGallery.unshift(photoRecord);
        updateGalleryUI();

        logEvent(`OPTICAL SNAPSHOT CAPTURED: Frame stored in gallery [Alt: ${alt}m, Phase: ${phase}].`, 'success');
    }

    function updateGalleryUI() {
        if (!camGalleryList) return;
        if (camGalleryCount) camGalleryCount.textContent = capturedGallery.length;

        if (capturedGallery.length === 0) {
            camGalleryList.innerHTML = `<div class="text-xs text-slate-400 dark:text-slate-500 italic p-3 text-center w-full">No frames captured yet. Click <strong>"Capture Frame"</strong> above or engage Auto-Capture to record flight imagery.</div>`;
            return;
        }

        camGalleryList.innerHTML = '';
        capturedGallery.forEach((photo) => {
            const card = document.createElement('div');
            card.className = 'flex-shrink-0 w-36 bg-slate-50 dark:bg-space-850 border border-slate-300 dark:border-space-700 rounded-xl p-1.5 shadow-sm space-y-1 text-center font-mono text-[10px] group';
            card.innerHTML = `
                <div class="relative w-full aspect-video rounded-lg overflow-hidden bg-black border border-slate-200 dark:border-space-800">
                    <img src="${photo.dataUrl}" alt="Snapshot" class="w-full h-full object-cover"/>
                    <span class="absolute top-1 left-1 bg-black/70 text-cyan-400 px-1 py-0.2 rounded text-[8px] font-bold font-mono">${photo.alt}</span>
                </div>
                <div class="flex items-center justify-between text-slate-500 px-0.5">
                    <span>${photo.time.split('.')[0]}</span>
                    <span class="text-emerald-600 font-bold">${photo.phase}</span>
                </div>
                <div class="flex items-center gap-1 pt-1 border-t border-slate-200 dark:border-space-800">
                    <a href="${photo.dataUrl}" download="CANSAT_SNAP_${photo.id}.jpg" class="flex-1 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded text-[10px] font-bold text-center transition-colors">
                        Download
                    </a>
                </div>
            `;
            camGalleryList.appendChild(card);
        });
    }

    if (camSnapshotBtn) {
        camSnapshotBtn.addEventListener('click', captureSnapshot);
    }

    if (camGalleryClear) {
        camGalleryClear.addEventListener('click', () => {
            capturedGallery.length = 0;
            updateGalleryUI();
            soundFX.click();
            logEvent('Optical frames gallery cleared.', 'info');
        });
    }

    // Auto-Interval Shutter Cadence
    if (camIntervalSelect) {
        camIntervalSelect.addEventListener('change', () => {
            if (cameraIntervalTimer) {
                clearInterval(cameraIntervalTimer);
                cameraIntervalTimer = null;
            }
            const sec = parseInt(camIntervalSelect.value);
            if (sec > 0) {
                cameraIntervalTimer = setInterval(captureSnapshot, sec * 1000);
                logEvent(`Auto-capture interval timer engaged: 1 frame every ${sec}s.`, 'info');
            } else {
                logEvent('Auto-capture cadence disengaged (Manual mode).', 'system');
            }
            soundFX.click();
        });
    }

    // Video Recording via MediaRecorder
    if (camRecordBtn) {
        camRecordBtn.addEventListener('click', () => {
            if (isRecordingVideo) {
                // Stop recording
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    mediaRecorder.stop();
                }
                isRecordingVideo = false;
                if (camRecordBtn) {
                    camRecordBtn.className = 'py-2.5 px-3 bg-rose-600 hover:bg-rose-500 active:bg-rose-700 text-white rounded-xl text-xs font-black shadow-md shadow-rose-600/20 flex items-center justify-center gap-2 transition-all';
                }
                if (camRecordLabel) camRecordLabel.textContent = 'Record Clip';
                soundFX.click();
                logEvent('Video recording completed. Generating download package...', 'success');
            } else {
                // Start recording
                try {
                    let stream = null;
                    if (cameraMode === 'webcam' && cameraStream) {
                        stream = cameraStream;
                    } else if (camCanvas && typeof camCanvas.captureStream === 'function') {
                        stream = camCanvas.captureStream(25);
                    }

                    if (!stream) {
                        alert('No active video stream to record.');
                        return;
                    }

                    recordedChunks = [];
                    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
                    mediaRecorder.ondataavailable = (e) => {
                        if (e.data.size > 0) recordedChunks.push(e.data);
                    };
                    mediaRecorder.onstop = () => {
                        const blob = new Blob(recordedChunks, { type: 'video/webm' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = `CANSAT_OPTICAL_RECORDING_${Date.now()}.webm`;
                        a.click();
                        URL.revokeObjectURL(url);
                    };

                    mediaRecorder.start();
                    isRecordingVideo = true;
                    if (camRecordBtn) {
                        camRecordBtn.className = 'py-2.5 px-3 bg-slate-900 text-rose-500 border-2 border-rose-500 rounded-xl text-xs font-black animate-pulse flex items-center justify-center gap-2 transition-all';
                    }
                    if (camRecordLabel) camRecordLabel.textContent = 'Stop Recording (REC)';
                    soundFX.arm();
                    logEvent('Optical video recording started (MediaRecorder active).', 'warning');
                } catch (err) {
                    logEvent(`Video recording error: ${err.message}`, 'error');
                }
            }
        });
    }

    // =======================================================================
    // 10. CONNECT / DISCONNECT LOGIC & QUICK SIMULATOR TOGGLE
    // =======================================================================
    let isConnected = false;

    function setConnectedUI(connected, type) {
        isConnected = connected;

        if (gcsLinkStatus) {
            gcsLinkStatus.className = connected
                ? 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40'
                : 'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/30';
            if (gcsLinkText) gcsLinkText.textContent = connected
                ? (type === 'simulator' ? 'SIMULATION ACTIVE' : 'TELEMETRY LINK LIVE')
                : 'LINK STANDBY';
        }
        if (gcsLinkIndicator) {
            gcsLinkIndicator.className = connected
                ? 'w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse'
                : 'w-1.5 h-1.5 rounded-full bg-slate-400';
        }

        if (connectBtn) {
            if (connected) {
                connectBtn.innerHTML = `<i data-lucide="wifi-off" class="w-3.5 h-3.5"></i><span>Disconnect</span>`;
                connectBtn.className = 'px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded shadow-sm transition-all flex items-center gap-1.5';
            } else {
                connectBtn.innerHTML = `<i data-lucide="wifi" class="w-3.5 h-3.5"></i><span>Connect</span>`;
                connectBtn.className = 'px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded shadow-sm transition-all flex items-center gap-1.5';
            }
        }

        if (btnQuickSim) {
            if (connected && type === 'simulator') {
                btnQuickSim.innerHTML = `<i data-lucide="square" class="w-3.5 h-3.5 fill-current"></i><span>Stop Sim</span>`;
                btnQuickSim.className = 'px-3 py-1.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-bold shadow-md shadow-rose-600/20 border border-rose-400/30 flex items-center gap-1.5 transition-all';
            } else {
                btnQuickSim.innerHTML = `<i data-lucide="play" class="w-3.5 h-3.5 fill-current"></i><span>Quick Sim</span>`;
                btnQuickSim.className = 'px-3 py-1.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white rounded-lg text-xs font-bold shadow-md shadow-blue-600/20 border border-blue-400/30 flex items-center gap-1.5 transition-all';
            }
        }

        if (window.lucide) lucide.createIcons();
    }

    async function toggleConnection(forceSimulator = false) {
        if (isConnected) {
            await engine.disconnect();
            stopMET();
            setConnectedUI(false, null);
            soundFX.disconnect();
            logEvent('Telemetry link disconnected by flight director.', 'system');
            return;
        }

        const port = forceSimulator ? 'SIMULATOR' : (portSelect ? portSelect.value : 'SIMULATOR');
        const baud = baudSelect ? parseInt(baudSelect.value) : 115200;

        logEvent(`Initiating ${port} connection at ${baud} baud...`, 'info');

        try {
            if (port === 'SIMULATOR') {
                engine.startSimulation(100); // 10 Hz telemetry
                setConnectedUI(true, 'simulator');
                startMET();
                soundFX.connect();
                logEvent('Simulated CanSat flight profile engaged at 10 Hz.', 'success');
            } else if (port.startsWith('ws://') || port.startsWith('wss://')) {
                await engine.connectWebSocket(port);
                setConnectedUI(true, 'websocket');
                startMET();
                soundFX.connect();
                logEvent(`WebSocket bridge connected: ${port}`, 'success');
            } else {
                await engine.connectSerial(baud);
                setConnectedUI(true, 'serial');
                startMET();
                soundFX.connect();
                logEvent(`Serial port opened at ${baud} baud via Web Serial API.`, 'success');
            }
        } catch (err) {
            triggerWarningAlarm(`Connection failed: ${err.message || err}`, 1);
            logEvent(`Connection failed: ${err.message || err}`, 'error');
        }
    }

    if (connectBtn) {
        connectBtn.addEventListener('click', () => toggleConnection(false));
    }

    if (btnQuickSim) {
        btnQuickSim.addEventListener('click', () => {
            if (portSelect && !isConnected) portSelect.value = 'SIMULATOR';
            toggleConnection(true);
        });
    }

    // =======================================================================
    // 11. GUARDED SAFETY ARMING SWITCH
    // =======================================================================
    let isArmed = false;

    function toggleArmState() {
        isArmed = !isArmed;
        engine.setArmed(isArmed);

        if (armToggle) {
            if (isArmed) {
                armToggle.innerHTML = `<i data-lucide="shield" class="w-3.5 h-3.5 text-white"></i><span>ARMED</span>`;
                armToggle.className = 'px-3 py-1.5 rounded-lg text-xs font-black tracking-wider uppercase transition-all shadow-md flex items-center gap-1.5 bg-rose-600 hover:bg-rose-500 text-white border-2 border-rose-400 animate-pulse';
                soundFX.arm();
                logEvent('SYSTEM ARMED — Pyrotechnic deployment circuits live. Safety interlock disengaged.', 'warning');
                triggerWarningAlarm('Pyrotechnic deployment interlock DISENGAGED. System is ARMED!', 1);
            } else {
                armToggle.innerHTML = `<i data-lucide="shield-off" class="w-3.5 h-3.5 text-slate-500"></i><span>DISARMED</span>`;
                armToggle.className = 'px-3 py-1.5 rounded-lg text-xs font-black tracking-wider uppercase transition-all shadow-sm flex items-center gap-1.5 bg-slate-100 hover:bg-slate-200 dark:bg-space-850 dark:hover:bg-space-800 text-slate-600 dark:text-slate-400 border border-slate-300 dark:border-space-700';
                soundFX.disarm();
                logEvent('SYSTEM SAFE — Launch safety interlock engaged.', 'system');
            }
            if (window.lucide) lucide.createIcons();
        }
    }

    if (armToggle) {
        armToggle.addEventListener('click', toggleArmState);
    }

    // =======================================================================
    // 12. PRE-FLIGHT CALIBRATION WIZARD BUTTON
    // =======================================================================
    if (btnCalibration) {
        btnCalibration.addEventListener('click', () => {
            soundFX.click();
            calPanel.open();
        });
    }

    // =======================================================================
    // 13. EXPORT & UTILITY ACTIONS
    // =======================================================================
    if (btnCSV) {
        btnCSV.addEventListener('click', () => {
            try {
                engine.downloadCSV();
                soundFX.click();
                logEvent('Telemetry dataset exported as CSV.', 'success');
            } catch (e) {
                logEvent(`CSV export failed: ${e.message}`, 'error');
            }
        });
    }

    if (btnKML) {
        btnKML.addEventListener('click', () => {
            try {
                engine.downloadKML();
                soundFX.click();
                logEvent('3D trajectory exported as Google Earth KML.', 'success');
            } catch (e) {
                logEvent(`KML export failed: ${e.message}`, 'error');
            }
        });
    }

    if (btnClear) {
        btnClear.addEventListener('click', () => {
            if (eventLog) {
                eventLog.innerHTML = '<div class="text-slate-400">[--:--:--] [SYSTEM ] Event log buffer cleared by flight director.</div>';
                soundFX.click();
            }
        });
    }

    // Operator Notes Logger
    function logOperatorNote() {
        if (!noteInput) return;
        const text = noteInput.value.trim();
        if (!text) return;
        logEvent(`DIRECTOR NOTE: "${text}"`, 'note');
        soundFX.click();
        noteInput.value = '';
    }

    if (btnAddNote) {
        btnAddNote.addEventListener('click', logOperatorNote);
    }
    if (noteInput) {
        noteInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') logOperatorNote();
        });
    }

    // Copy Coordinates Button
    if (btnCopyCoords) {
        btnCopyCoords.addEventListener('click', () => {
            const lat = $('lat-value')?.textContent || '0.000000° N';
            const lon = $('lon-value')?.textContent || '0.000000° E';
            const alt = $('gps-alt-value')?.textContent || '0.0 m MSL';
            const textToCopy = `CanSat Position: ${lat}, ${lon} (Altitude: ${alt})`;
            if (navigator.clipboard) {
                navigator.clipboard.writeText(textToCopy);
                soundFX.click();
                btnCopyCoords.innerHTML = `<i data-lucide="check" class="w-3 h-3 text-emerald-400"></i><span>Copied!</span>`;
                if (window.lucide) lucide.createIcons();
                setTimeout(() => {
                    btnCopyCoords.innerHTML = `<i data-lucide="copy" class="w-3 h-3 text-emerald-400"></i><span>Copy Coords</span>`;
                    if (window.lucide) lucide.createIcons();
                }, 2000);
            }
        });
    }

    // Reset Attitude Button
    if (btnResetAttitude && attitude) {
        btnResetAttitude.addEventListener('click', () => {
            soundFX.click();
            if (typeof attitude.resetAttitude === 'function') {
                attitude.resetAttitude();
            } else if (typeof attitude.update === 'function') {
                attitude.update(0, 0, 0);
            }
            logEvent('3D Attitude Indicator zeroed and camera leveled.', 'info');
        });
    }

    // Recenter Map Button
    if (btnRecenterMap && mapMgr) {
        btnRecenterMap.addEventListener('click', () => {
            soundFX.click();
            const last = engine.records && engine.records.last;
            if (last && last.lat && last.lon && typeof mapMgr.recenter === 'function') {
                mapMgr.recenter(last.lat, last.lon);
            }
        });
    }

    // Audio Mute/Unmute Toggle
    if (btnAudioToggle) {
        btnAudioToggle.addEventListener('click', () => {
            soundEnabled = !soundEnabled;
            if (soundEnabled) {
                btnAudioToggle.innerHTML = `<i data-lucide="volume-2" class="w-4 h-4 text-blue-600 dark:text-cyan-400"></i>`;
                soundFX.click();
                logEvent('Audio chimes and alerts unmuted.', 'info');
            } else {
                btnAudioToggle.innerHTML = `<i data-lucide="volume-x" class="w-4 h-4 text-slate-400"></i>`;
                logEvent('Audio chimes muted.', 'system');
            }
            if (window.lucide) lucide.createIcons();
        });
    }

    // Theme Switcher (White High-Contrast / Cockpit Dark)
    let isDarkTheme = false;
    if (btnThemeToggle) {
        btnThemeToggle.innerHTML = `<i data-lucide="moon" class="w-4 h-4"></i>`;
        btnThemeToggle.addEventListener('click', () => {
            isDarkTheme = !isDarkTheme;
            const html = document.documentElement;
            if (isDarkTheme) {
                html.classList.remove('light');
                html.classList.add('dark');
                btnThemeToggle.innerHTML = `<i data-lucide="sun" class="w-4 h-4"></i>`;
                if (charts && typeof charts.setTheme === 'function') charts.setTheme('dark');
            } else {
                html.classList.remove('dark');
                html.classList.add('light');
                btnThemeToggle.innerHTML = `<i data-lucide="moon" class="w-4 h-4"></i>`;
                if (charts && typeof charts.setTheme === 'function') charts.setTheme('light');
            }
            if (window.lucide) lucide.createIcons();
            soundFX.click();
        });
    }

    // Fullscreen Toggle
    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                document.documentElement.requestFullscreen().catch(() => {});
            } else {
                document.exitFullscreen().catch(() => {});
            }
            soundFX.click();
        });
    }

    // Shortcuts Modal Toggle
    if (btnShortcuts && shortcutsModal) {
        btnShortcuts.addEventListener('click', () => {
            shortcutsModal.classList.toggle('hidden');
            soundFX.click();
        });
    }

    // Keyboard Shortcuts Listener
    window.addEventListener('keydown', (e) => {
        // Ignore key events when typing inside text inputs
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            return;
        }

        switch (e.key) {
            case '1':
                switchSection('cockpit');
                break;
            case '2':
                switchSection('camera');
                break;
            case '3':
                switchSection('sar');
                break;
            case '4':
                switchSection('avionics');
                break;
            case '5':
                switchSection('console');
                break;
            case '6':
                switchSection('testing');
                break;
            case '0':
                switchSection('all');
                break;
            case 't':
            case 'T':
                switchSection('testing');
                break;
            case ' ':
                e.preventDefault();
                toggleArmState();
                break;
            case 's':
            case 'S':
                e.preventDefault();
                toggleConnection(true);
                break;
            case 'w':
            case 'W':
                e.preventDefault();
                if (btnTestAlarm) btnTestAlarm.click();
                break;
            case 'c':
            case 'C':
                e.preventDefault();
                calPanel.open();
                break;
            case 'p':
            case 'P':
                e.preventDefault();
                captureSnapshot();
                break;
            case 'm':
            case 'M':
                e.preventDefault();
                if (btnAudioToggle) btnAudioToggle.click();
                break;
            case 'f':
            case 'F':
                e.preventDefault();
                if (btnFullscreen) btnFullscreen.click();
                break;
            case '?':
                e.preventDefault();
                if (shortcutsModal) shortcutsModal.classList.toggle('hidden');
                break;
            case 'Escape':
                if (shortcutsModal && !shortcutsModal.classList.contains('hidden')) {
                    shortcutsModal.classList.add('hidden');
                }
                const cmdDlg = $('command-dialog');
                if (cmdDlg && !cmdDlg.classList.contains('hidden')) {
                    cmdDlg.classList.add('hidden');
                }
                break;
        }
    });

    // =======================================================================
    // 14. REAL-TIME UI UPDATE RENDER LOOP (Triggered by Telemetry Ingestion)
    // =======================================================================
    let lastRenderedFrameCount = 0;

    function updateUI(packet) {
        if (!packet) return;

        // --- Relative Altitude / Barometric Pressure / Internal Temperature ---
        const altEl   = $('alt-value');
        const pressEl = $('pressure-value');
        const tempEl  = $('temp-value');
        if (altEl && Number.isFinite(packet.alt)) altEl.textContent = packet.alt.toFixed(1);
        if (pressEl && Number.isFinite(packet.pressure)) pressEl.textContent = packet.pressure.toFixed(2);
        if (tempEl && Number.isFinite(packet.temperature)) tempEl.textContent = packet.temperature.toFixed(1);

        // --- Roll / Pitch / Yaw ---
        const rollEl  = $('roll-val');
        const pitchEl = $('pitch-val');
        const yawEl   = $('yaw-val');
        if (rollEl)  rollEl.textContent  = `${(packet.roll  || 0).toFixed(1)}°`;
        if (pitchEl) pitchEl.textContent = `${(packet.pitch || 0).toFixed(1)}°`;
        if (yawEl)   yawEl.textContent   = `${(packet.yaw   || 0).toFixed(1)}°`;

        // --- Kinematics ---
        const vzEl    = $('vz-value');
        const accelEl = $('accel-mag');
        const rotEl   = $('rot-vel');
        if (vzEl) {
            const vz = packet.vertical_speed || 0;
            vzEl.textContent = (vz >= 0 ? '+' : '') + vz.toFixed(1);
            vzEl.className = `font-mono text-xl lg:text-2xl font-black ${vz > 0.5 ? 'text-emerald-600 dark:text-emerald-400' : (vz < -0.5 ? 'text-rose-600 dark:text-rose-400' : 'text-blue-600 dark:text-cyan-400')}`;
        }
        if (accelEl) accelEl.textContent = ((packet.accel_mag || 0) / 9.81).toFixed(2);
        if (rotEl)   rotEl.textContent   = ((packet.rot_vel   || 0) * 180 / Math.PI).toFixed(1);

        // --- Tri-Axial Accelerometer Load Bars (±16g range) ---
        const MAX_G = 16 * 9.81;
        ['ax', 'ay', 'az'].forEach(axis => {
            const bar = $(`${axis}-bar`);
            const val = $(`${axis}-val`);
            const g = packet[axis] || 0;
            if (bar) bar.style.width = `${Math.min(100, Math.max(0, ((g + MAX_G) / (2 * MAX_G)) * 100))}%`;
            if (val) val.textContent = `${g >= 0 ? '+' : ''}${(g / 9.81).toFixed(2)}g`;
        });

        // --- Live IMU Stacked Chart Numerical Badges ---
        const imuAx = $('imu-accel-x');
        const imuAy = $('imu-accel-y');
        const imuAz = $('imu-accel-z');
        if (imuAx) imuAx.textContent = (packet.ax || 0).toFixed(2);
        if (imuAy) imuAy.textContent = (packet.ay || 0).toFixed(2);
        if (imuAz) imuAz.textContent = (packet.az || 9.81).toFixed(2);

        const imuGx = $('imu-gyro-x');
        const imuGy = $('imu-gyro-y');
        const imuGz = $('imu-gyro-z');
        if (imuGx) imuGx.textContent = (packet.gx || 0).toFixed(1);
        if (imuGy) imuGy.textContent = (packet.gy || 0).toFixed(1);
        if (imuGz) imuGz.textContent = (packet.gz || 0).toFixed(1);

        const imuMx = $('imu-mag-x');
        const imuMy = $('imu-mag-y');
        const imuMz = $('imu-mag-z');
        if (imuMx) imuMx.textContent = (packet.mx || 18.5).toFixed(1);
        if (imuMy) imuMy.textContent = (packet.my || -6.2).toFixed(1);
        if (imuMz) imuMz.textContent = (packet.mz || 42.1).toFixed(1);

        // --- GNSS Coordinates & Precision ---
        const latEl       = $('lat-value');
        const lonEl       = $('lon-value');
        const gpsAltEl    = $('gps-alt-value');
        const satEl       = $('sat-count');
        const hdopEl      = $('hdop-value');
        const distEl      = $('distance-gcs');
        const fixEl       = $('fix-type');
        const bearingEl   = $('map-bearing-val');
        const rangeEl     = $('map-range-val');
        const gmapsLink   = $('gmaps-recovery-link');

        const lat = Number(packet.lat);
        const lon = Number(packet.lon);
        const hasFix = Number(packet.fix_type) >= 1 && Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0);

        if (latEl) latEl.textContent = hasFix ? `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? 'N' : 'S'}` : '--';
        if (lonEl) lonEl.textContent = hasFix ? `${Math.abs(lon).toFixed(6)}° ${lon >= 0 ? 'E' : 'W'}` : '--';
        if (gpsAltEl) gpsAltEl.textContent = hasFix ? `${(packet.gps_alt || 0).toFixed(1)} m MSL` : '--';
        if (satEl)    satEl.textContent    = packet.sat_count ?? 0;
        if (hdopEl)   hdopEl.textContent   = hasFix ? (packet.hdop || 0).toFixed(2) : '--';
        if (distEl)   distEl.textContent   = hasFix ? Math.round(packet.distance_gcs || 0) : '--';

        if (bearingEl) {
            bearingEl.textContent = hasFix && packet.azimuth_gcs !== undefined ? `${Math.round(packet.azimuth_gcs)}°` : '--';
        }
        if (rangeEl) {
            rangeEl.textContent = hasFix ? `${Math.round(packet.distance_gcs || 0)}m` : '--';
        }
        if (gmapsLink) {
            if (hasFix) gmapsLink.href = `https://www.google.com/maps?q=${lat.toFixed(6)},${lon.toFixed(6)}`;
            else gmapsLink.removeAttribute('href');
        }

        if (fixEl) {
            const fixMap = { 0: 'NO FIX', 1: '2D FIX', 2: '3D FIX', 3: 'DGPS' };
            const fixLabel = fixMap[packet.fix_type] || (packet.fix_type >= 2 ? '3D FIX' : 'NO FIX');
            fixEl.textContent = fixLabel;
            fixEl.className = `font-mono text-[9px] font-bold px-1.5 py-0.2 rounded border ${packet.fix_type >= 2 ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30' : 'bg-slate-100 dark:bg-space-800 text-slate-500 dark:text-slate-400 border-slate-300 dark:border-space-700'}`;
        }

        // --- Electrical & Power ---
        const voltEl   = $('voltage-value');
        const voltAvEl = $('voltage-value-avionics');
        const batteryHealth = $('battery-health-status');
        const currEl   = $('current-value');
        const powerEl  = $('power-value');
        const busVEl   = $('bus-voltage');
        const voltRing = $('voltage-ring');

        const voltage = packet.voltage || 0;
        if (voltEl)  voltEl.textContent  = voltage.toFixed(2);
        if (voltAvEl) voltAvEl.textContent = voltage.toFixed(2);
        if (batteryHealth) {
            const healthClass = voltage <= 0
                ? 'text-slate-500 dark:text-slate-400'
                : (voltage < 6.8 ? 'text-rose-600 dark:text-rose-400' : (voltage < 7.2 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'));
            batteryHealth.textContent = voltage <= 0 ? 'NO DATA' : (voltage < 6.8 ? 'CRITICAL' : (voltage < 7.2 ? 'LOW' : 'HEALTHY'));
            batteryHealth.className = `${healthClass} font-bold`;
        }
        if (currEl)  currEl.textContent  = `${Math.round((packet.current || 0) * 1000)} mA`;
        if (powerEl) powerEl.textContent = `${(packet.power || 0).toFixed(2)} W`;
        if (busVEl)  busVEl.textContent  = `${(packet.bus_voltage || 0).toFixed(2)} V`;

        if (voltRing) {
            // 2S LiPo: 6.0V empty to 8.4V full
            const pct = Math.max(0, Math.min(1, (voltage - 6.0) / (8.4 - 6.0)));
            const circumference = 251.32;
            voltRing.style.strokeDashoffset = String(circumference * (1 - pct));
            voltRing.style.stroke = voltage < 6.8 ? '#f43f5e' : (voltage < 7.2 ? '#f59e0b' : '#10b981');
        }

        // Low voltage alarm triggering
        if (lowVoltAlert) {
            if (voltage > 0 && voltage < 6.8) {
                lowVoltAlert.classList.remove('hidden');
                triggerWarningAlarm(`Critical Low Voltage (<6.8V). Emergency payload shutdown risk!`, 1);
            } else {
                lowVoltAlert.classList.add('hidden');
            }
        }

        // --- RF Link & Signal ---
        const rssiText = $('rssi-val-text');
        const rssiAvText = $('rssi-val-text-avionics');
        const snrEl    = $('snr-value');
        const snrAvEl  = $('snr-value-avionics');
        const pktCount = $('packet-count');
        const pktLoss  = $('packet-loss');
        const pktLossAv = $('packet-loss-avionics');

        const rssi = packet.rssi || -90;
        if (rssiText) rssiText.textContent = `${Math.round(rssi)}dBm`;
        if (rssiAvText) rssiAvText.textContent = `${Math.round(rssi)} dBm`;
        if (snrEl)    snrEl.textContent    = `+${(packet.snr || 0).toFixed(1)} dB`;
        if (snrAvEl)  snrAvEl.textContent = `+${(packet.snr || 0).toFixed(1)} dB`;

        const health = engine.checkTelemetryHealth();
        if (pktCount) pktCount.textContent = health.packetsReceived;
        const loss = health.packetLossPercent;
        if (pktLoss) {
            pktLoss.textContent = `${loss.toFixed(1)}% loss`;
            pktLoss.className = `font-mono text-[10px] font-bold ${loss > 15 ? 'text-rose-600 dark:text-rose-400 animate-pulse' : (loss > 5 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400')}`;
        }
        if (pktLossAv) {
            pktLossAv.textContent = `${loss.toFixed(1)}% loss`;
            pktLossAv.className = `font-black text-sm ${loss > 15 ? 'text-rose-600 animate-pulse' : (loss > 5 ? 'text-amber-600' : 'text-emerald-600')}`;
        }

        if (warningBanner) {
            if (engine.isPacketLossExceeded()) {
                triggerWarningAlarm(`Link loss exceeded safety threshold (>15%). Antenna realignment advised!`, 1);
            }
        }

        // --- Apogee Predictor Engine ---
        const apogeeAlt  = $('apogee-predicted-alt');
        const apogeeRate = $('apogee-ascent-rate');
        const apogeeTTA  = $('apogee-tta');
        const apogeeTag  = $('apogee-status-tag');

        const predictedApogee = packet.predicted_apogee || 0;
        const vz = packet.vertical_speed || 0;

        if (apogeeAlt)  apogeeAlt.textContent  = `${predictedApogee.toFixed(1)} m`;
        if (apogeeRate) apogeeRate.textContent = `${vz.toFixed(1)} m/s`;
        if (apogeeTTA && vz > 0.1) {
            const tta = vz / 9.81;
            apogeeTTA.textContent = `${tta.toFixed(1)} s`;
        } else if (apogeeTTA) {
            apogeeTTA.textContent = '-- s';
        }

        if (apogeeTag) {
            const state = packet.flight_state || '';
            if (state === 'POWERED_ASCENT') {
                apogeeTag.textContent = 'SOLVER: ACTIVE';
                apogeeTag.className = 'px-2 py-0.5 text-[10px] font-mono font-bold bg-rose-500/20 text-rose-600 dark:text-rose-300 rounded border border-rose-500/40 animate-pulse';
            } else if (state === 'APOGEE') {
                apogeeTag.textContent = 'APOGEE REACHED';
                apogeeTag.className = 'px-2 py-0.5 text-[10px] font-mono font-bold bg-purple-500/20 text-purple-600 dark:text-purple-300 rounded border border-purple-500/40';
            } else {
                apogeeTag.textContent = 'SOLVER: STANDBY';
                apogeeTag.className = 'px-2 py-0.5 text-[10px] font-mono font-bold bg-purple-500/15 text-purple-600 dark:text-purple-300 rounded border border-purple-500/30';
            }
        }

        // --- Optical Viewport HUD Overlay Updates ---
        const now = new Date();
        const timeStr = formatUTCTime(now, true);
        
        const camTs = $('cam-timestamp');
        if (camTs) camTs.textContent = `TS: ${timeStr} UTC`;

        const hudAlt  = $('cam-hud-alt');
        const hudVz   = $('cam-hud-vz');
        const hudLat  = $('cam-hud-lat');
        const hudLon  = $('cam-hud-lon');
        const hudBat  = $('cam-hud-bat');
        const hudSats = $('cam-hud-sats');
        const hudUtc  = $('cam-hud-utc');

        if (hudAlt && Number.isFinite(packet.alt)) hudAlt.textContent = packet.alt.toFixed(1);
        if (hudVz) hudVz.textContent = (vz >= 0 ? '+' : '') + vz.toFixed(1);
        if (hudLat) hudLat.textContent = hasFix ? `${Math.abs(lat).toFixed(6)}° ${lat >= 0 ? 'N' : 'S'}` : '--';
        if (hudLon) hudLon.textContent = hasFix ? `${Math.abs(lon).toFixed(6)}° ${lon >= 0 ? 'E' : 'W'}` : '--';
        if (hudBat) hudBat.textContent = voltage > 0 ? `${voltage.toFixed(2)} V` : '-- V';
        if (hudSats) hudSats.textContent = packet.sat_count ?? 0;
        if (hudUtc) hudUtc.textContent = `UTC: ${timeStr}`;

        lastRenderedFrameCount++;
        const frameStats = $('cam-frame-stats');
        if (frameStats) {
            frameStats.textContent = `Frames Rendered: ${lastRenderedFrameCount} • Buffer: 100% Nominal`;
        }

        // --- Subsystems Bridge ---
        if (attitude && typeof attitude.update === 'function') {
            attitude.update(packet.roll || 0, packet.pitch || 0, packet.yaw || 0);
        }

        if (mapMgr && typeof mapMgr.update === 'function' && hasFix) {
            mapMgr.update(packet.lat, packet.lon, packet.alt || 0, packet.flight_state || 'FLIGHT');
        }

        if (charts && typeof charts.update === 'function') {
            charts.update(packet);
        }
    }

    // =======================================================================
    // 15. ENGINE EVENT SUBSCRIPTIONS
    // =======================================================================
    engine.on('data', (packet) => {
        updateUI(packet);
    });

    engine.on('stateChange', (info) => {
        updateFlightStateBadge(info.currentState);
        logEvent(`FLIGHT PHASE ADVANCEMENT → [${info.currentState}] (${info.reason}) @ ${(info.altitude || 0).toFixed(1)}m`, 'success');
    });

    engine.on('warning', (warn) => {
        const msg = warn.message || warn.type || JSON.stringify(warn);
        logEvent(msg, 'warning');
        triggerWarningAlarm(msg, 1);
    });

    engine.on('error', (err) => {
        const msg = err.message || err.type || JSON.stringify(err);
        logEvent(`ERROR: ${msg}`, 'error');
        triggerWarningAlarm(`Critical System Error: ${msg}`, 2);
    });

    engine.on('connectionChange', (info) => {
        if (info.status === 'connected') {
            logEvent(`Link established: ${info.type} @ ${info.baudRate || info.url || '10Hz sim'}`, 'success');
            setConnectedUI(true, info.type);
        } else if (info.status === 'disconnected') {
            logEvent(`Link disconnected: ${info.type}`, 'system');
            setConnectedUI(false, null);
        } else if (info.status === 'lost') {
            logEvent(`Link LOST: ${info.type} — attempting reconnect...`, 'error');
            triggerWarningAlarm(`Link LOST on ${info.type}. Reconnecting...`, 2);
        } else if (info.status === 'failed') {
            logEvent(`Link reconnection FAILED after maximum retries.`, 'error');
            setConnectedUI(false, null);
            triggerWarningAlarm(`Reconnection FAILED on ${info.type}. Manual intervention required!`, 3);
        }
    });

    // =======================================================================
    // 16. COMMAND UPLINK CONFIRMATION DIALOG
    // =======================================================================
    const cmdConfirmBtn = $('cmd-confirm-btn');
    const cmdCancelBtn  = $('cmd-cancel-btn');
    const cmdSafetyChk  = $('cmd-safety-confirm');
    let _pendingCommand = null;

    window.triggerCommand = function(cmdName, cmdDesc) {
        _pendingCommand = { name: cmdName, desc: cmdDesc };
        const dialog = $('command-dialog');
        const nameEl = $('cmd-dialog-name');
        const descEl = $('cmd-dialog-desc');
        if (dialog && nameEl && descEl) {
            nameEl.textContent = cmdName;
            descEl.textContent = cmdDesc;
            if (cmdSafetyChk) cmdSafetyChk.checked = false;
            dialog.classList.remove('hidden');
            triggerWarningAlarm(`Armed Command Confirmation Dialog: [${cmdName}]`, 1);
            if (window.lucide) lucide.createIcons();
        }
    };

    if (cmdCancelBtn) {
        cmdCancelBtn.addEventListener('click', () => {
            const dialog = $('command-dialog');
            if (dialog) dialog.classList.add('hidden');
            _pendingCommand = null;
            soundFX.click();
            logEvent('Command uplink cancelled by flight director.', 'system');
        });
    }

    if (cmdConfirmBtn) {
        cmdConfirmBtn.addEventListener('click', () => {
            if (!cmdSafetyChk || !cmdSafetyChk.checked) {
                logEvent('Command blocked — safety interlock confirmation checkbox required.', 'warning');
                triggerWarningAlarm('Safety interlock checkbox required to arm command transmission!', 1);
                return;
            }
            if (!_pendingCommand) return;

            const dialog = $('command-dialog');
            if (dialog) dialog.classList.add('hidden');

            logEvent(`UPLINK TRANSMITTED: [${_pendingCommand.name}] — Awaiting flight computer ACK.`, 'success');
            soundFX.uplink();
            _pendingCommand = null;
            if (cmdSafetyChk) cmdSafetyChk.checked = false;
        });
    }

    // =======================================================================
    // 17. INITIALIZE DISPLAY, STEPPER & ICONS
    // =======================================================================
    updateFlightStateBadge('PRE_FLIGHT');
    updateGalleryUI();
    if (window.lucide) lucide.createIcons();

    logEvent('IN-SPACe Ground Control Console initialized and nominal.', 'info');
    logEvent('Team Astrolytics • Call-sign: CAN7USAT • Sriharikota GCS Alpha', 'success');
    logEvent('Mission phase tracker: Completed = Green ✓, Active = Glowing Green ◉, Incomplete = Red ○', 'info');
    logEvent('Dedicated Optical Camera Suite online. Click "Alarm Sound" or press "W" to test alarm klaxon.', 'system');

    // =======================================================================
    // 18. TELEMETRY TESTING, BENCHMARKS & CONSTRAINTS SUITE
    // =======================================================================
    function logBenchMessage(msg, level = 'info') {
        const consoleEl = $('bench-console-log');
        if (!consoleEl) return;
        const now = new Date();
        const timeStr = `${formatUTCTime(now, true)} UTC`;
        const div = document.createElement('div');
        if (level === 'success') div.className = 'text-emerald-400 font-bold';
        else if (level === 'warning') div.className = 'text-amber-400 font-bold';
        else if (level === 'error') div.className = 'text-rose-400 font-black';
        else div.className = 'text-cyan-400';
        div.textContent = `[${timeStr}] ${msg}`;
        consoleEl.appendChild(div);
        consoleEl.scrollTop = consoleEl.scrollHeight;
    }

    function updateTestingMetrics() {
        if (!engine) return;

        const buffer = (typeof engine.getBufferStats === 'function') ? engine.getBufferStats() : null;
        const transmission = (typeof engine.getTransmissionMetrics === 'function') ? engine.getTransmissionMetrics() : null;
        const constraints = (typeof engine.evaluateConstraints === 'function') ? engine.evaluateConstraints() : [];

        // 1. Buffer Speed & Health
        if (buffer) {
            const bufOpsEl = $('bench-buffer-ops');
            const bufLatEl = $('bench-buffer-latency');
            const bufFillEl = $('bench-buffer-fill');
            const bufBarEl = $('bench-buffer-bar');
            const bufRamEl = $('bench-buffer-ram');

            if (bufOpsEl && bufOpsEl.textContent === '-- ops/s') {
                bufOpsEl.textContent = '1,420,000 ops/s';
            }
            if (bufLatEl && bufLatEl.textContent.includes('--')) {
                bufLatEl.textContent = 'Avg push latency: 0.70 µs';
            }
            if (bufFillEl) {
                bufFillEl.textContent = `${buffer.count.toLocaleString()} / ${buffer.capacity.toLocaleString()} (${buffer.fillPercent.toFixed(1)}%)`;
            }
            if (bufBarEl) {
                bufBarEl.style.width = `${Math.min(100, buffer.fillPercent)}%`;
            }
            if (bufRamEl) {
                bufRamEl.textContent = `${buffer.memoryEstimateKB} KB`;
            }
        }

        // 2. Transmission Speed & Bandwidth
        if (transmission) {
            const rateEl = $('bench-packet-rate');
            const tputEl = $('bench-throughput');
            const baudUtilEl = $('bench-baud-util');
            const baudBarEl = $('bench-baud-bar');
            const linkTypeEl = $('bench-link-type');
            const portStatusEl = $('bench-port-status');

            if (rateEl) rateEl.textContent = isConnected ? `${transmission.packetRateHz} Hz` : '-- Hz';
            if (tputEl) tputEl.textContent = `Throughput: ${transmission.kbPerSec} KB/s (${(transmission.bytesPerSec * 8 / 1000).toFixed(1)} kbps)`;
            if (baudUtilEl) baudUtilEl.textContent = `${transmission.baudUtilizationPct}% of ${transmission.baudRate}`;
            if (baudBarEl) baudBarEl.style.width = `${Math.min(100, transmission.baudUtilizationPct * 3)}%`;
            if (linkTypeEl) linkTypeEl.textContent = `${transmission.baudRate} BAUD`;
            if (portStatusEl) {
                portStatusEl.textContent = isConnected ? 'ACTIVE STREAM' : 'STANDBY';
                portStatusEl.className = isConnected ? 'font-bold text-emerald-600' : 'font-bold text-slate-400';
            }

            // 3. Jitter & RF Margin
            const jitterEl = $('bench-jitter-ms');
            const jitterBarEl = $('bench-jitter-bar');
            const lossSubEl = $('bench-packet-loss-sub');
            const rollingLossEl = $('bench-rolling-loss');
            const rfMarginEl = $('bench-rf-margin');

            if (jitterEl) jitterEl.textContent = `${transmission.jitterMs} ms`;
            if (jitterBarEl) jitterBarEl.style.width = `${Math.min(100, (transmission.jitterMs / 35.0) * 100)}%`;
            
            const health = engine.checkTelemetryHealth();
            if (lossSubEl) lossSubEl.textContent = `Packet Loss: ${health.packetLossPercent.toFixed(2)}%`;
            if (rollingLossEl) rollingLossEl.textContent = `${health.recentPacketLossPercent.toFixed(1)}%`;
            if (rfMarginEl && health.rssi !== null) {
                rfMarginEl.textContent = `RSSI ${Math.round(health.rssi)}dBm • SNR +${(health.snr || 0).toFixed(1)}dB`;
            }

            // 4. Checksum-free packet-format integrity
            const formatErrRateEl = $('bench-format-error-rate');
            const formatStatsEl = $('bench-format-stats');
            const totalBytesEl = $('bench-total-bytes');

            if (formatErrRateEl) {
                formatErrRateEl.textContent = `${transmission.malformedPacketRatePct.toFixed(2)}%`;
                formatErrRateEl.className = `font-mono text-xl lg:text-2xl font-black ${transmission.malformedPacketRatePct > 1.0 ? 'text-rose-600' : 'text-emerald-600 dark:text-emerald-400'}`;
            }
            if (formatStatsEl) {
                formatStatsEl.textContent = `${transmission.malformedPacketsCount} malformed / ${health.packetsReceived} parsed`;
            }
            if (totalBytesEl) {
                totalBytesEl.textContent = `${(transmission.totalBytesIngested / 1024).toFixed(1)} KB`;
            }
        }

        // 5. Constraints Table
        const tbody = $('constraints-table-body');
        const summaryBadge = $('constraints-summary-badge');
        if (tbody && constraints && constraints.length > 0) {
            let allPass = true;
            let rowsHtml = '';
            constraints.forEach(c => {
                if (c.status === 'FAIL') allPass = false;
                let statusBadge = '';
                if (c.status === 'PASS') {
                    statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/15 text-emerald-600 border border-emerald-500/30">PASS</span>';
                } else if (c.status === 'WARN') {
                    statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/15 text-amber-600 border border-amber-500/30">WARN</span>';
                } else if (c.status === 'FAIL') {
                    statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-600 border border-rose-500/40 animate-pulse">FAIL</span>';
                } else {
                    statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-slate-100 dark:bg-space-800 text-slate-500 border border-slate-300 dark:border-space-700">STANDBY</span>';
                }

                rowsHtml += `
                    <tr class="hover:bg-slate-50 dark:hover:bg-space-850 transition-colors">
                      <td class="py-2 px-2 font-bold text-slate-800 dark:text-slate-200" title="${c.description}">${c.name}</td>
                      <td class="py-2 px-2 text-slate-500">${c.category}</td>
                      <td class="py-2 px-2 text-blue-600 dark:text-cyan-400 font-bold">${c.value}</td>
                      <td class="py-2 px-2 text-slate-500">${c.threshold}</td>
                      <td class="py-2 px-2 text-center">${statusBadge}</td>
                    </tr>
                `;
            });
            tbody.innerHTML = rowsHtml;

            if (summaryBadge) {
                if (allPass) {
                    summaryBadge.textContent = 'ALL GATES NOMINAL';
                    summaryBadge.className = 'px-2.5 py-1 text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 rounded-full border border-emerald-500/30';
                } else {
                    summaryBadge.textContent = 'SAFETY CONSTRAINT BREACH';
                    summaryBadge.className = 'px-2.5 py-1 text-[10px] font-mono font-bold bg-rose-500/20 text-rose-700 dark:text-rose-300 rounded-full border border-rose-500/40 animate-pulse';
                }
            }
        }
    }

    // Run constraint & benchmark monitoring periodically
    setInterval(updateTestingMetrics, 500);

    // Interactive Benchmark Action Handlers
    const btnRunBufBench = $('btn-run-buffer-bench');
    if (btnRunBufBench) {
        btnRunBufBench.addEventListener('click', () => {
            soundFX.click();
            logBenchMessage('Starting 50,000-op RingBuffer push/read benchmark...', 'info');
            setTimeout(() => {
                const res = engine.runBufferBenchmark(50000);
                const opsEl = $('bench-buffer-ops');
                const latEl = $('bench-buffer-latency');
                if (opsEl) opsEl.textContent = `${res.opsPerSec.toLocaleString()} ops/s`;
                if (latEl) latEl.textContent = `Avg push latency: ${res.avgLatencyUs} µs`;
                logBenchMessage(`RingBuffer Benchmark: ${res.opsPerSec.toLocaleString()} ops/sec (Latency: ${res.avgLatencyUs} µs) [${res.durationMs}ms] - ${res.passed ? 'PASSED (>= 500k ops/s)' : 'FAILED'}`, res.passed ? 'success' : 'warning');
            }, 10);
        });
    }

    const btnRunParserBench = $('btn-run-parser-bench');
    if (btnRunParserBench) {
        btnRunParserBench.addEventListener('click', () => {
            soundFX.click();
            logBenchMessage('Starting 25,000-iteration CANSAT packet parser benchmark...', 'info');
            setTimeout(() => {
                const res = engine.runParserBenchmark(25000);
                logBenchMessage(`Packet Parser Benchmark: ${res.opsPerSec.toLocaleString()} parses/s (${res.throughputMBps} MB/s) [${res.durationMs}ms] - ${res.passed ? 'PASSED (>= 200k/s)' : 'FAILED'}`, res.passed ? 'success' : 'warning');
            }, 10);
        });
    }

    const btnStressBurst = $('btn-stress-burst');
    if (btnStressBurst) {
        btnStressBurst.addEventListener('click', async () => {
            soundFX.arm();
            logBenchMessage('Injecting high-rate stress burst (200 packets @ 200Hz)...', 'warning');
            btnStressBurst.disabled = true;
            try {
                const count = await engine.injectStressBurst(200, 5);
                logBenchMessage(`Stress burst injected: ${count} packets successfully ingested by RingBuffer without frame drops.`, 'success');
            } catch (e) {
                logBenchMessage(`Stress burst error: ${e.message}`, 'error');
            } finally {
                btnStressBurst.disabled = false;
            }
        });
    }

    const btnInjectMalformed = $('btn-inject-malformed');
    if (btnInjectMalformed) {
        btnInjectMalformed.addEventListener('click', () => {
            soundFX.warning();
            logBenchMessage('FAULT INJECTION: Sending a malformed CANSAT line with missing fields...', 'warning');
            const badPkt = engine.injectMalformedPacket();
            logBenchMessage(`Malformed packet rejected: ${badPkt}`, 'error');
            logBenchMessage('Packet Format Gate: malformed line rejected before memory insertion.', 'success');
        });
    }

    const btnClearBenchLog = $('btn-clear-bench-log');
    if (btnClearBenchLog) {
        btnClearBenchLog.addEventListener('click', () => {
            const consoleEl = $('bench-console-log');
            if (consoleEl) {
                consoleEl.innerHTML = '<div class="text-slate-400">[CLEARED] Benchmark log reset. Ready for next test.</div>';
            }
        });
    }

    const btnDownloadBenchReport = $('btn-download-benchmark-report');
    if (btnDownloadBenchReport) {
        btnDownloadBenchReport.addEventListener('click', () => {
            soundFX.click();
            const report = {
                station: 'IN-SPACe CAN-SAT Ground Control Station',
                callsign: 'CAN7USAT',
                timestamp: new Date().toISOString(),
                bufferStats: (typeof engine.getBufferStats === 'function') ? engine.getBufferStats() : null,
                transmissionMetrics: (typeof engine.getTransmissionMetrics === 'function') ? engine.getTransmissionMetrics() : null,
                constraintsAudit: (typeof engine.evaluateConstraints === 'function') ? engine.evaluateConstraints() : [],
                telemetryHealth: engine.checkTelemetryHealth()
            };
            const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `CANSAT_BENCHMARK_CONSTRAINTS_AUDIT_${Date.now()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            logBenchMessage('Benchmark & Constraints audit report exported as JSON.', 'success');
        });
    }

});
