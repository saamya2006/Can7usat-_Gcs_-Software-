/**
 * ============================================================================
 * CanSat Ground Control Station (GCS) - 3D Attitude Indicator (Artificial Horizon)
 * High-Contrast Sunlight-Visible Outdoor Mission-Critical Dashboard Component
 * ============================================================================
 * 
 * Renders a real-time 3D wireframe representation of the CanSat responding to 
 * Roll, Pitch, and Yaw telemetry from the onboard 9-DOF IMU.
 * 
 * Technical Specifications:
 * - Engine: Three.js (UMD build: THREE global)
 * - Vehicle Model: Cylindrical CanSat body with #2563EB aerospace blue wireframe overlay
 * - Reference Axes: Attached to body (X = Red / Roll, Y = Green / Pitch, Z = Blue / Yaw)
 * - Artificial Horizon: Semi-transparent plane tilting opposite to Pitch/Roll
 *   * Sky: Light Blue (#DBEAFE)
 *   * Ground: Light Brown (#FDE68A)
 *   * Pitch ladder markings every 10° with solid positive bars & dashed negative bars
 *   * Roll indicator arc at the top with bank angle tick marks
 * - Compass Rose: Concentric horizontal ring around the model with N/S/E/W cardinal points,
 *   10° tick marks, degree headings, and real-time heading indicator arrow
 * - Spatial Grounding: High-contrast subtle ground grid in slate gray
 * - Performance: Throttled to 30 FPS, capped pixel ratio, minimal geometry, robust disposal
 * - Visual Styling: High-contrast pure white (#FFFFFF) background for outdoor sunlight readability
 */

(function () {
    'use strict';

    // ------------------------------------------------------------------------
    // CSS Styles for High-Contrast Outdoor Telemetry Overlays
    // ------------------------------------------------------------------------
    const ATTITUDE_STYLES_ID = 'cansat-attitude-indicator-styles';

    function injectAttitudeStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById(ATTITUDE_STYLES_ID)) return;

        const style = document.createElement('style');
        style.id = ATTITUDE_STYLES_ID;
        style.textContent = `
            .attitude-viewport-wrapper {
                position: relative;
                width: 100%;
                height: 100%;
                min-height: 280px;
                overflow: hidden;
                background-color: #ffffff;
                user-select: none;
                font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            }
            .attitude-canvas-element {
                display: block;
                width: 100%;
                height: 100%;
                outline: none;
            }
            .attitude-telemetry-badge {
                position: absolute;
                top: 10px;
                left: 10px;
                z-index: 10;
                background: rgba(255, 255, 255, 0.94);
                backdrop-filter: blur(4px);
                border: 1px solid #cbd5e1;
                border-radius: 6px;
                padding: 6px 10px;
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
                pointer-events: none;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
                font-size: 11px;
                line-height: 1.45;
                color: #0f172a;
            }
            .attitude-telemetry-badge .telemetry-row {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            .attitude-telemetry-badge .badge-label {
                font-weight: 700;
                letter-spacing: 0.04em;
                display: inline-block;
                width: 44px;
            }
            .attitude-telemetry-badge .val-roll { color: #dc2626; font-weight: 700; }
            .attitude-telemetry-badge .val-pitch { color: #059669; font-weight: 700; }
            .attitude-telemetry-badge .val-yaw { color: #2563eb; font-weight: 700; }

            .attitude-heading-badge {
                position: absolute;
                top: 10px;
                right: 10px;
                z-index: 10;
                background: rgba(255, 255, 255, 0.94);
                backdrop-filter: blur(4px);
                border: 1px solid #cbd5e1;
                border-radius: 6px;
                padding: 6px 12px;
                box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
                pointer-events: none;
                text-align: right;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
            }
            .attitude-heading-badge .heading-title {
                font-size: 9px;
                font-weight: 800;
                letter-spacing: 0.08em;
                color: #64748b;
                text-transform: uppercase;
            }
            .attitude-heading-badge .heading-val {
                font-size: 15px;
                font-weight: 800;
                color: #2563eb;
            }
            .attitude-heading-badge .heading-cardinal {
                font-size: 11px;
                font-weight: 700;
                color: #0f172a;
                margin-left: 4px;
            }

            .attitude-hud-crosshair {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: 48px;
                height: 48px;
                pointer-events: none;
                z-index: 5;
                opacity: 0.75;
            }
            .attitude-hud-crosshair svg {
                width: 100%;
                height: 100%;
                display: block;
            }

            .attitude-fps-tag {
                position: absolute;
                bottom: 8px;
                right: 8px;
                z-index: 10;
                background: rgba(255, 255, 255, 0.85);
                border: 1px solid #e2e8f0;
                border-radius: 4px;
                padding: 2px 6px;
                font-size: 9px;
                font-family: ui-monospace, monospace;
                font-weight: 700;
                color: #64748b;
                pointer-events: none;
            }
        `;
        document.head.appendChild(style);
    }

    // Auto-inject styles
    injectAttitudeStyles();

    /**
     * AttitudeIndicator Class
     * High-precision 3D Attitude Director Indicator (ADI) for Ground Control Stations.
     */
    class AttitudeIndicator {
        /**
         * @param {string|HTMLCanvasElement} canvasId Element ID of target canvas or canvas DOM element
         * @param {Object} [options] Configuration overrides
         */
        constructor(canvasId = 'attitude-canvas', options = {}) {
            this.canvasId = canvasId;
            this.canvas = typeof canvasId === 'string' ? document.getElementById(canvasId) : canvasId;

            // Merge options with mission-critical defaults
            this.options = Object.assign({
                targetFps: 30,                  // Fixed 30 FPS rendering to save CPU/GPU
                lerpFactor: 0.15,               // Smooth rotational interpolation
                wireframeColor: 0x2563EB,       // CanSat wireframe color (#2563EB aerospace blue)
                backgroundColor: 0xFFFFFF,      // High-contrast clean white background
                cylinderRadius: 0.95,           // Standard CanSat cylinder radius
                cylinderHeight: 2.9,            // Standard CanSat cylinder height
                bodyAxis: 'X',                  // Longitudinal axis: 'X' (aerospace standard)
                showAxes: true,                 // Show X/Y/Z coordinate axes
                showGrid: true,                 // Show ground reference grid
                showHorizon: true,              // Show semi-transparent artificial horizon plane
                showCompass: true,              // Show heading compass rose ring
                showHud: true,                  // Show digital overlay telemetry values
                cameraElevationDeg: 30,         // Camera elevation angle in degrees
                cameraDistance: 10.5,           // Distance from center
                cameraAzimuthDeg: 20            // Slight horizontal angle for full 3D perception
            }, options);

            // Attitude state tracking (degrees)
            this.targetAttitude = { roll: 0, pitch: 0, yaw: 0 };
            this.currentAttitude = { roll: 0, pitch: 0, yaw: 0 };

            // Animation and timing controls
            this.isRunning = false;
            this.animFrameId = null;
            this.lastRenderTime = 0;
            this.fpsInterval = 1000 / this.options.targetFps; // ~33.33ms

            // Three.js Core Objects
            this.renderer = null;
            this.scene = null;
            this.camera = null;

            // Scene Groups & Components
            this.cansatModel = null;
            this.coordinateCage = null;
            this.horizonContainer = null;
            this.horizonMesh = null;
            this.horizonTexture = null;
            this.compassRing = null;
            this.headingArrow = null;
            this.groundGrid = null;

            // Mouse interaction / orbit rotation
            this.isDragging = false;
            this.previousMousePosition = { x: 0, y: 0 };
            this.orbitAngles = { elevation: 28, azimuth: 45 };
            this.baseDistance = 11.0;

            // Telemetry overlay DOM references
            this.uiWrapper = null;
            this.telemetryBadgeEl = null;
            this.headingBadgeEl = null;
            this.fpsBadgeEl = null;

            // Resource disposal tracking
            this.disposables = {
                geometries: new Set(),
                materials: new Set(),
                textures: new Set()
            };

            // Bind methods for listeners & animation loop
            this._handleResize = this.onResize.bind(this);
            this._animateLoop = this.animate.bind(this);

            // Initialize if canvas already exists in DOM
            if (this.canvas) {
                this.init();
            } else if (typeof document !== 'undefined') {
                // Defer until DOM is ready
                const onDomReady = () => {
                    this.canvas = typeof this.canvasId === 'string' ? document.getElementById(this.canvasId) : this.canvasId;
                    if (this.canvas && !this.renderer) {
                        this.init();
                    }
                };
                if (document.readyState === 'loading') {
                    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
                } else {
                    // Microtask fallback
                    setTimeout(onDomReady, 0);
                }
            }
        }

        /**
         * Initialize Three.js scene, camera, renderer, lighting, and 3D subcomponents.
         */
        init() {
            // Guard against multiple initializations
            if (this.renderer) return;

            // Verify Three.js availability
            const THREE = window.THREE;
            if (!THREE) {
                console.error('[AttitudeIndicator] Three.js is not loaded. Please load three.min.js before initializing.');
                return;
            }

            // Verify canvas DOM node
            if (!this.canvas) {
                this.canvas = typeof this.canvasId === 'string' ? document.getElementById(this.canvasId) : this.canvasId;
            }

            if (!this.canvas) {
                console.warn(`[AttitudeIndicator] Canvas element '${this.canvasId}' not found in DOM.`);
                return;
            }

            // Setup UI Container wrapper for telemetry overlay
            this._setupDomOverlay();

            // 1. WebGL Renderer Setup
            this.renderer = new THREE.WebGLRenderer({
                canvas: this.canvas,
                antialias: true,
                alpha: false,
                powerPreference: 'default'
            });

            this.renderer.setClearColor(this.options.backgroundColor, 1.0);
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

            // Initial dimensions
            const width = this.canvas.clientWidth || this.canvas.width || 400;
            const height = this.canvas.clientHeight || this.canvas.height || 300;
            this.renderer.setSize(width, height, false);

            // 2. Three.js Scene Setup
            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(this.options.backgroundColor);

            // 3. Camera Setup: Positioned at 30° elevation angle looking at center
            this.camera = new THREE.PerspectiveCamera(46, width / Math.max(1, height), 0.1, 1000);
            this._updateCameraPosition();

            // 4. Lighting: Ambient + Directional Key & Fill for 3D depth perception
            this._setupLighting();

            // 5. Build 3D Components
            this._setupOrbitControls();
            this.createCoordinateCage();
            this.createCanSatModel();

            // 6. Bind Resize Handlers
            window.addEventListener('resize', this._handleResize);
            if (window.ResizeObserver && this.canvas.parentElement) {
                this.resizeObserver = new ResizeObserver(() => this.onResize());
                this.resizeObserver.observe(this.canvas.parentElement);
            }

            // 7. Start 30 FPS Render Loop
            this.isRunning = true;
            this.lastRenderTime = performance.now();
            this.animFrameId = requestAnimationFrame(this._animateLoop);
        }

        /**
         * Interactive mouse orbit rotation controls
         * @private
         */
        _setupOrbitControls() {
            if (!this.canvas) return;

            const onMouseDown = (e) => {
                this.isDragging = true;
                this.previousMousePosition = { x: e.clientX, y: e.clientY };
            };

            const onMouseMove = (e) => {
                if (!this.isDragging) return;
                const deltaX = e.clientX - this.previousMousePosition.x;
                const deltaY = e.clientY - this.previousMousePosition.y;

                this.orbitAngles.azimuth -= deltaX * 0.45;
                this.orbitAngles.elevation = Math.max(-80, Math.min(80, this.orbitAngles.elevation + deltaY * 0.45));

                this.previousMousePosition = { x: e.clientX, y: e.clientY };
                this._updateCameraPosition();
            };

            const onMouseUp = () => {
                this.isDragging = false;
            };

            const onWheel = (e) => {
                e.preventDefault();
                this.baseDistance = Math.max(5.0, Math.min(22.0, this.baseDistance + e.deltaY * 0.01));
                this._updateCameraPosition();
            };

            this.canvas.addEventListener('mousedown', onMouseDown);
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
            this.canvas.addEventListener('wheel', onWheel, { passive: false });

            // Touch support for mobile / tablets
            this.canvas.addEventListener('touchstart', (e) => {
                if (e.touches.length === 1) {
                    this.isDragging = true;
                    this.previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                }
            }, { passive: true });

            window.addEventListener('touchmove', (e) => {
                if (!this.isDragging || e.touches.length !== 1) return;
                const deltaX = e.touches[0].clientX - this.previousMousePosition.x;
                const deltaY = e.touches[0].clientY - this.previousMousePosition.y;

                this.orbitAngles.azimuth -= deltaX * 0.55;
                this.orbitAngles.elevation = Math.max(-80, Math.min(80, this.orbitAngles.elevation + deltaY * 0.55));

                this.previousMousePosition = { x: e.touches[0].clientX, y: e.touches[0].clientY };
                this._updateCameraPosition();
            }, { passive: true });

            window.addEventListener('touchend', () => {
                this.isDragging = false;
            });
        }

        /**
         * Reset 3D camera to optimal isometric perspective
         */
        resetView() {
            this.orbitAngles = { elevation: 28, azimuth: 45 };
            this.baseDistance = 11.0;
            this._updateCameraPosition();
        }

        /**
         * Set up camera at orbit elevation and azimuth angles looking at center (0, 0, 0).
         * @private
         */
        _updateCameraPosition() {
            if (!this.camera) return;

            const elevRad = (this.orbitAngles.elevation * Math.PI) / 180;
            const azimRad = (this.orbitAngles.azimuth * Math.PI) / 180;
            const dist = this.baseDistance;

            const x = dist * Math.cos(elevRad) * Math.sin(azimRad);
            const y = dist * Math.sin(elevRad);
            const z = dist * Math.cos(elevRad) * Math.cos(azimRad);

            this.camera.position.set(x, y, z);
            this.camera.lookAt(0, 0, 0);
        }

        /**
         * Ambient + Directional lighting for wireframe and solid core depth.
         * @private
         */
        _setupLighting() {
            const THREE = window.THREE;

            // Ambient light: soft neutral illumination
            const ambient = new THREE.AmbientLight(0xffffff, 0.90);
            this.scene.add(ambient);

            // Key directional light from upper-right
            const sunLight = new THREE.DirectionalLight(0xffffff, 0.85);
            sunLight.position.set(10, 15, 12);
            this.scene.add(sunLight);

            // Secondary cool fill light
            const fillLight = new THREE.DirectionalLight(0xdbeafe, 0.45);
            fillLight.position.set(-10, -8, -10);
            this.scene.add(fillLight);
        }

        /**
         * Helper: Create high-contrast text canvas sprite for 3D axis labels and ticks
         * @private
         */
        _createTextSprite(text, color = '#334155', fontSize = 28, scaleX = 1.2, scaleY = 0.35) {
            const THREE = window.THREE;
            const canvas = document.createElement('canvas');
            canvas.width = 256;
            canvas.height = 64;
            const ctx = canvas.getContext('2d');
            ctx.font = `bold ${fontSize}px sans-serif`;
            ctx.fillStyle = color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, 128, 32);

            const texture = new THREE.CanvasTexture(canvas);
            const mat = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
            const sprite = new THREE.Sprite(mat);
            sprite.scale.set(scaleX, scaleY, 1);
            this.disposables.materials.add(mat);
            this.disposables.textures.add(texture);
            return sprite;
        }

        /**
         * Create Real-Time 3D Attitude (Mahony AHRS) Coordinate Bounding Cage
         * Features:
         * - 3 orthogonal grid planes (-3 to +3 in X, Y, Z)
         * - Floor grid (XY plane at Z = -3)
         * - Back grid (XZ plane at Y = 3)
         * - Side grid (YZ plane at X = -3)
         * - Ticks: -3, -2, -1, 0, 1, 2, 3
         * - X (North) in RED, Y (East) in GREEN, Z (Up) in BLUE
         * @private
         */
        createCoordinateCage() {
            const THREE = window.THREE;
            this.coordinateCage = new THREE.Group();
            this.coordinateCage.name = 'MahonyAHRSCage';

            const min = -3.0;
            const max = 3.0;
            const gridColor = 0xb0bec5; // Slate gray grid lines
            const boxBorderColor = 0x475569; // Darker outer cage edges

            const lineMat = new THREE.LineBasicMaterial({
                color: gridColor,
                linewidth: 1,
                transparent: true,
                opacity: 0.65
            });
            this.disposables.materials.add(lineMat);

            const borderMat = new THREE.LineBasicMaterial({
                color: boxBorderColor,
                linewidth: 1.5,
                transparent: true,
                opacity: 0.90
            });
            this.disposables.materials.add(borderMat);

            const gridPoints = [];

            // 1. Floor Grid lines at Z = min (-3), spanning X and Y from -3 to +3
            for (let v = min; v <= max; v += 1) {
                // Lines parallel to Y
                gridPoints.push(new THREE.Vector3(v, min, min));
                gridPoints.push(new THREE.Vector3(v, max, min));
                // Lines parallel to X
                gridPoints.push(new THREE.Vector3(min, v, min));
                gridPoints.push(new THREE.Vector3(max, v, min));
            }

            // 2. Back-Left Grid lines at Y = max (+3), spanning X and Z from -3 to +3
            for (let v = min; v <= max; v += 1) {
                // Vertical lines along Z
                gridPoints.push(new THREE.Vector3(v, max, min));
                gridPoints.push(new THREE.Vector3(v, max, max));
                // Horizontal lines along X
                gridPoints.push(new THREE.Vector3(min, max, v));
                gridPoints.push(new THREE.Vector3(max, max, v));
            }

            // 3. Back-Right Grid lines at X = min (-3), spanning Y and Z from -3 to +3
            for (let v = min; v <= max; v += 1) {
                // Vertical lines along Z
                gridPoints.push(new THREE.Vector3(min, v, min));
                gridPoints.push(new THREE.Vector3(min, v, max));
                // Horizontal lines along Y
                gridPoints.push(new THREE.Vector3(min, min, v));
                gridPoints.push(new THREE.Vector3(min, max, v));
            }

            const gridGeo = new THREE.BufferGeometry().setFromPoints(gridPoints);
            this.disposables.geometries.add(gridGeo);
            const gridSegments = new THREE.LineSegments(gridGeo, lineMat);
            this.coordinateCage.add(gridSegments);

            // 4. Outer Boundary Frame
            const boxGeo = new THREE.BufferGeometry().setFromPoints([
                // Floor perimeter
                new THREE.Vector3(min, min, min), new THREE.Vector3(max, min, min),
                new THREE.Vector3(max, min, min), new THREE.Vector3(max, max, min),
                new THREE.Vector3(max, max, min), new THREE.Vector3(min, max, min),
                new THREE.Vector3(min, max, min), new THREE.Vector3(min, min, min),
                // Back vertical pillars
                new THREE.Vector3(min, max, min), new THREE.Vector3(min, max, max),
                new THREE.Vector3(max, max, min), new THREE.Vector3(max, max, max),
                new THREE.Vector3(min, min, min), new THREE.Vector3(min, min, max),
                // Top back edges
                new THREE.Vector3(min, max, max), new THREE.Vector3(max, max, max),
                new THREE.Vector3(min, min, max), new THREE.Vector3(min, max, max)
            ]);
            this.disposables.geometries.add(boxGeo);
            const boxLines = new THREE.LineSegments(boxGeo, borderMat);
            this.coordinateCage.add(boxLines);

            // 5. Numeric Tick Sprites (-3 to 3) on Floor Axes & Z Axis
            for (let i = min; i <= max; i += 1) {
                // X ticks along bottom front edge
                const xTick = this._createTextSprite(String(i), '#334155', 24, 0.7, 0.22);
                xTick.position.set(i, min - 0.45, min);
                this.coordinateCage.add(xTick);

                // Y ticks along bottom right edge
                const yTick = this._createTextSprite(String(i), '#334155', 24, 0.7, 0.22);
                yTick.position.set(max + 0.45, i, min);
                this.coordinateCage.add(yTick);

                // Z ticks along right vertical pillar
                const zTick = this._createTextSprite(String(i), '#334155', 24, 0.7, 0.22);
                zTick.position.set(max + 0.45, min, i);
                this.coordinateCage.add(zTick);
            }

            // 6. Major Axis Header Labels: X (North) in RED, Y (East) in GREEN, Z (Up) in BLUE
            const xLabel = this._createTextSprite('X (North)', '#dc2626', 32, 1.8, 0.45);
            xLabel.position.set(0, min - 0.95, min);
            this.coordinateCage.add(xLabel);

            const yLabel = this._createTextSprite('Y (East)', '#16a34a', 32, 1.8, 0.45);
            yLabel.position.set(max + 1.15, 0, min);
            this.coordinateCage.add(yLabel);

            const zLabel = this._createTextSprite('Z (Up)', '#2563eb', 32, 1.8, 0.45);
            zLabel.position.set(max + 1.15, min, 0.4);
            this.coordinateCage.add(zLabel);

            // Add coordinate cage to scene
            this.scene.add(this.coordinateCage);
        }

        /**
         * Create Real-Time Multi-Colored Faceted CanSat Cylinder
         * Matching the exact aerospace simulation visual from the reference image:
         * - Multi-faceted vertical cylinder (12 / 16 distinct colored vertical panel strips)
         * - Facet colors: Red, Blue, Green, Gray, Pink/Orange stripes
         * - Solid blue top lid, blue/gray bottom lid
         * - Sharp dark border outlines on each facet
         * - Red North ('N') and Green East ('E') cardinal pointer arrows at base
         */
        createCanSatModel() {
            const THREE = window.THREE;
            this.cansatModel = new THREE.Group();
            this.cansatModel.name = 'CanSatModel';

            const radius = 0.95;
            const height = 2.4;
            const numFacets = 16;
            const halfH = height / 2;

            // Alternating vibrant facet panel colors matching the image
            const facetColors = [
                0x2563eb, // Cobalt Blue
                0xef4444, // Coral Red
                0x10b981, // Emerald Green
                0x94a3b8, // Light Slate Gray
                0xf97316, // Orange
                0x3b82f6, // Sky Blue
                0xdc2626, // Crimson Red
                0x059669, // Forest Green
                0x64748b, // Darker Slate Gray
                0xf59e0b, // Amber Gold
                0x1d4ed8, // Deep Blue
                0xe11d48, // Rose Red
                0x2563eb, // Cobalt Blue
                0x10b981, // Green
                0xef4444, // Red
                0x94a3b8  // Gray
            ];

            // 1. Build individual vertical rectangular facet panels
            for (let i = 0; i < numFacets; i++) {
                const theta1 = (i / numFacets) * Math.PI * 2;
                const theta2 = ((i + 1) / numFacets) * Math.PI * 2;

                const x1 = radius * Math.cos(theta1);
                const y1 = radius * Math.sin(theta1);
                const x2 = radius * Math.cos(theta2);
                const y2 = radius * Math.sin(theta2);

                // Two triangles forming rectangular strip
                const panelGeo = new THREE.BufferGeometry();
                const vertices = new Float32Array([
                    x1, y1, -halfH,
                    x2, y2, -halfH,
                    x2, y2,  halfH,

                    x1, y1, -halfH,
                    x2, y2,  halfH,
                    x1, y1,  halfH
                ]);
                panelGeo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
                panelGeo.computeVertexNormals();
                this.disposables.geometries.add(panelGeo);

                const panelColor = facetColors[i % facetColors.length];
                const panelMat = new THREE.MeshStandardMaterial({
                    color: panelColor,
                    roughness: 0.35,
                    metalness: 0.15,
                    side: THREE.DoubleSide
                });
                this.disposables.materials.add(panelMat);

                const panelMesh = new THREE.Mesh(panelGeo, panelMat);
                this.cansatModel.add(panelMesh);
            }

            // 2. Top Circular End Cap (Solid Vibrant Sky Blue)
            const capGeo = new THREE.CircleGeometry(radius, numFacets);
            this.disposables.geometries.add(capGeo);

            const topCapMat = new THREE.MeshStandardMaterial({
                color: 0x0284c7, // Vibrant Sky Blue
                roughness: 0.25,
                metalness: 0.2,
                side: THREE.DoubleSide
            });
            this.disposables.materials.add(topCapMat);

            const topCap = new THREE.Mesh(capGeo, topCapMat);
            topCap.position.set(0, 0, halfH);
            this.cansatModel.add(topCap);

            // 3. Bottom Circular End Cap (Slate Blue)
            const bottomCapMat = new THREE.MeshStandardMaterial({
                color: 0x1e40af, // Deep Blue
                roughness: 0.3,
                metalness: 0.2,
                side: THREE.DoubleSide
            });
            this.disposables.materials.add(bottomCapMat);

            const bottomCap = new THREE.Mesh(capGeo, bottomCapMat);
            bottomCap.position.set(0, 0, -halfH);
            this.cansatModel.add(bottomCap);

            // 4. Sharp Dark Edge Outlines (Facet borders & rims)
            const edgesColor = 0x0f172a;
            const edgeMat = new THREE.LineBasicMaterial({
                color: edgesColor,
                linewidth: 1.5,
                transparent: true,
                opacity: 0.90
            });
            this.disposables.materials.add(edgeMat);

            // Vertical facet lines
            const edgePoints = [];
            for (let i = 0; i < numFacets; i++) {
                const theta = (i / numFacets) * Math.PI * 2;
                const x = radius * Math.cos(theta);
                const y = radius * Math.sin(theta);
                edgePoints.push(new THREE.Vector3(x, y, -halfH));
                edgePoints.push(new THREE.Vector3(x, y, halfH));
            }

            // Top and bottom circle rim loops
            for (let i = 0; i < numFacets; i++) {
                const t1 = (i / numFacets) * Math.PI * 2;
                const t2 = ((i + 1) / numFacets) * Math.PI * 2;
                // Top rim
                edgePoints.push(new THREE.Vector3(radius * Math.cos(t1), radius * Math.sin(t1), halfH));
                edgePoints.push(new THREE.Vector3(radius * Math.cos(t2), radius * Math.sin(t2), halfH));
                // Bottom rim
                edgePoints.push(new THREE.Vector3(radius * Math.cos(t1), radius * Math.sin(t1), -halfH));
                edgePoints.push(new THREE.Vector3(radius * Math.cos(t2), radius * Math.sin(t2), -halfH));
            }

            const edgesGeo = new THREE.BufferGeometry().setFromPoints(edgePoints);
            this.disposables.geometries.add(edgesGeo);
            const edgeSegments = new THREE.LineSegments(edgesGeo, edgeMat);
            this.cansatModel.add(edgeSegments);

            // 5. Cardinal Direction Pointer Arrows at Base:
            // Red arrow along X with 'N' (North)
            // Green arrow along Y with 'E' (East)
            this._addCardinalBaseArrows(radius, halfH);

            // Set Euler rotation order to ZYX (Yaw -> Pitch -> Roll)
            this.cansatModel.rotation.order = 'ZYX';

            this.scene.add(this.cansatModel);
        }

        /**
         * Add cardinal direction vectors (N = North in Red, E = East in Green)
         * @private
         */
        _addCardinalBaseArrows(radius, halfH) {
            const THREE = window.THREE;
            const arrowLen = radius + 0.95;
            const zLevel = -halfH - 0.05;

            // --- North Arrow (+X, Red) ---
            const northMat = new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2.5 });
            this.disposables.materials.add(northMat);

            const northLineGeo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, zLevel),
                new THREE.Vector3(arrowLen, 0, zLevel)
            ]);
            this.disposables.geometries.add(northLineGeo);
            const northLine = new THREE.Line(northLineGeo, northMat);
            this.cansatModel.add(northLine);

            // North arrowhead cone
            const coneMatN = new THREE.MeshBasicMaterial({ color: 0xef4444 });
            const coneGeoN = new THREE.ConeGeometry(0.12, 0.35, 12);
            this.disposables.materials.add(coneMatN);
            this.disposables.geometries.add(coneGeoN);
            const coneN = new THREE.Mesh(coneGeoN, coneMatN);
            coneN.position.set(arrowLen, 0, zLevel);
            coneN.rotation.z = -Math.PI / 2;
            this.cansatModel.add(coneN);

            // 'N' label sprite
            const nSprite = this._createTextSprite('N', '#ef4444', 32, 0.55, 0.28);
            nSprite.position.set(arrowLen + 0.35, 0, zLevel);
            this.cansatModel.add(nSprite);

            // --- East Arrow (+Y, Green) ---
            const eastMat = new THREE.LineBasicMaterial({ color: 0x10b981, linewidth: 2.5 });
            this.disposables.materials.add(eastMat);

            const eastLineGeo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, zLevel),
                new THREE.Vector3(0, arrowLen, zLevel)
            ]);
            this.disposables.geometries.add(eastLineGeo);
            const eastLine = new THREE.Line(eastLineGeo, eastMat);
            this.cansatModel.add(eastLine);

            // East arrowhead cone
            const coneMatE = new THREE.MeshBasicMaterial({ color: 0x10b981 });
            const coneGeoE = new THREE.ConeGeometry(0.12, 0.35, 12);
            this.disposables.materials.add(coneMatE);
            this.disposables.geometries.add(coneGeoE);
            const coneE = new THREE.Mesh(coneGeoE, coneMatE);
            coneE.position.set(0, arrowLen, zLevel);
            this.cansatModel.add(coneE);

            // 'E' label sprite
            const eSprite = this._createTextSprite('E', '#10b981', 32, 0.55, 0.28);
            eSprite.position.set(0, arrowLen + 0.35, zLevel);
            this.cansatModel.add(eSprite);
        }

        /**
         * Add structural end caps and payload bay divider rings.
         * @private
         */
        _addBulkheadRings(radius, height, color) {
            const THREE = window.THREE;
            const halfH = height / 2;
            const ringPositions = [-halfH, -halfH * 0.35, halfH * 0.35, halfH];

            const ringMat = new THREE.LineBasicMaterial({
                color: color,
                linewidth: 2,
                transparent: true,
                opacity: 0.85
            });
            this.disposables.materials.add(ringMat);

            ringPositions.forEach((pos) => {
                const ringGeo = new THREE.BufferGeometry();
                const points = [];
                const segments = 32;

                for (let i = 0; i <= segments; i++) {
                    const theta = (i / segments) * Math.PI * 2;
                    if (this.options.bodyAxis === 'X') {
                        points.push(new THREE.Vector3(pos, Math.cos(theta) * radius * 1.01, Math.sin(theta) * radius * 1.01));
                    } else {
                        points.push(new THREE.Vector3(Math.cos(theta) * radius * 1.01, pos, Math.sin(theta) * radius * 1.01));
                    }
                }

                ringGeo.setFromPoints(points);
                this.disposables.geometries.add(ringGeo);
                const ringLine = new THREE.Line(ringGeo, ringMat);
                this.cansatModel.add(ringLine);
            });
        }

        /**
         * Add nose telemetry antenna mast stub pointing along forward longitudinal axis.
         * @private
         */
        _addSensorMast(radius, height) {
            const THREE = window.THREE;
            const halfH = height / 2;
            const mastLength = 0.8;

            const mastGeo = new THREE.CylinderGeometry(0.03, 0.03, mastLength, 12);
            this.disposables.geometries.add(mastGeo);

            const mastMat = new THREE.MeshBasicMaterial({ color: 0x1e3a8a });
            this.disposables.materials.add(mastMat);

            const mastMesh = new THREE.Mesh(mastGeo, mastMat);
            if (this.options.bodyAxis === 'X') {
                mastGeo.rotateZ(-Math.PI / 2);
                mastMesh.position.set(halfH + mastLength / 2, 0, 0);
            } else {
                mastMesh.position.set(0, halfH + mastLength / 2, 0);
            }
            this.cansatModel.add(mastMesh);

            // Small red LED status tip at probe head
            const tipGeo = new THREE.SphereGeometry(0.07, 12, 12);
            this.disposables.geometries.add(tipGeo);
            const tipMat = new THREE.MeshBasicMaterial({ color: 0xdc2626 });
            this.disposables.materials.add(tipMat);
            const tipMesh = new THREE.Mesh(tipGeo, tipMat);
            if (this.options.bodyAxis === 'X') {
                tipMesh.position.set(halfH + mastLength, 0, 0);
            } else {
                tipMesh.position.set(0, halfH + mastLength, 0);
            }
            this.cansatModel.add(tipMesh);
        }

        /**
         * Add reference coordinate axes:
         * - X = Red (Longitudinal / Roll axis)
         * - Y = Green (Lateral / Pitch axis)
         * - Z = Blue (Vertical / Yaw axis)
         * @private
         */
        _createReferenceAxes() {
            const THREE = window.THREE;
            const axisLength = 2.4;
            const coneHeight = 0.35;
            const coneRadius = 0.1;

            const axesGroup = new THREE.Group();
            axesGroup.name = 'AttitudeReferenceAxes';

            const axisConfigs = [
                { dir: new THREE.Vector3(1, 0, 0), color: 0xef4444, label: '+X ROLL' },
                { dir: new THREE.Vector3(0, 1, 0), color: 0x10b981, label: '+Y PITCH' },
                { dir: new THREE.Vector3(0, 0, 1), color: 0x3b82f6, label: '+Z YAW' }
            ];

            axisConfigs.forEach((cfg) => {
                // Axis Line
                const lineGeo = new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(0, 0, 0),
                    cfg.dir.clone().multiplyScalar(axisLength)
                ]);
                this.disposables.geometries.add(lineGeo);

                const lineMat = new THREE.LineBasicMaterial({
                    color: cfg.color,
                    linewidth: 2,
                    transparent: true,
                    opacity: 0.95
                });
                this.disposables.materials.add(lineMat);
                const line = new THREE.Line(lineGeo, lineMat);
                axesGroup.add(line);

                // Cone Pointer
                const coneGeo = new THREE.ConeGeometry(coneRadius, coneHeight, 16);
                this.disposables.geometries.add(coneGeo);

                const coneMat = new THREE.MeshBasicMaterial({ color: cfg.color });
                this.disposables.materials.add(coneMat);

                const cone = new THREE.Mesh(coneGeo, coneMat);
                const conePos = cfg.dir.clone().multiplyScalar(axisLength + coneHeight / 2);
                cone.position.copy(conePos);

                // Orient cone along axis vector
                if (cfg.dir.x !== 0) cone.rotation.z = -Math.PI / 2 * cfg.dir.x;
                if (cfg.dir.z !== 0) cone.rotation.x = Math.PI / 2 * cfg.dir.z;

                axesGroup.add(cone);
            });

            this.cansatModel.add(axesGroup);
        }

        /**
         * Create Artificial Horizon Reference Plane.
         * Features:
         * - Semi-transparent circular ADI disk tilting opposite to roll and pitch
         * - Sky half: Light Blue (#DBEAFE)
         * - Ground half: Light Brown (#FDE68A)
         * - Horizon zero-pitch dividing line
         * - Pitch ladder markings every 10° (solid for positive, dashed for negative)
         * - Roll indicator arc at the top with degree ticks (0°, ±10°, ±20°, ±30°, ±45°, ±60°)
         */
        createHorizonReference() {
            const THREE = window.THREE;

            this.horizonContainer = new THREE.Group();
            this.horizonContainer.name = 'HorizonReferenceContainer';

            // Generate procedural canvas texture for the artificial horizon
            this.horizonTexture = this._generateHorizonTexture();
            this.disposables.textures.add(this.horizonTexture);

            // Plane Geometry: large circular ADI disk
            const radius = 6.2;
            const planeGeo = new THREE.CircleGeometry(radius, 64);
            this.disposables.geometries.add(planeGeo);

            const planeMat = new THREE.MeshBasicMaterial({
                map: this.horizonTexture,
                transparent: true,
                opacity: 0.65,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            this.disposables.materials.add(planeMat);

            this.horizonMesh = new THREE.Mesh(planeGeo, planeMat);
            this.horizonContainer.add(this.horizonMesh);

            // Outer bezel ring for high-contrast demarcation
            const bezelGeo = new THREE.RingGeometry(radius - 0.06, radius + 0.04, 64);
            this.disposables.geometries.add(bezelGeo);
            const bezelMat = new THREE.MeshBasicMaterial({
                color: 0x94a3b8,
                transparent: true,
                opacity: 0.8,
                side: THREE.DoubleSide
            });
            this.disposables.materials.add(bezelMat);
            const bezelMesh = new THREE.Mesh(bezelGeo, bezelMat);
            this.horizonContainer.add(bezelMesh);

            // Position container behind the CanSat model along camera look vector
            this._alignHorizonWithCamera();

            this.scene.add(this.horizonContainer);
        }

        /**
         * Procedural generator for artificial horizon canvas texture.
         * Creates crisp sky (#DBEAFE), ground (#FDE68A), pitch ladder, and roll indicator arc.
         * @private
         */
        _generateHorizonTexture() {
            const THREE = window.THREE;
            const size = 1024;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            const cx = size / 2;
            const cy = size / 2;

            // 1. Sky Half: Light Blue (#DBEAFE)
            ctx.fillStyle = '#dbeafe';
            ctx.fillRect(0, 0, size, cy);

            // 2. Ground Half: Light Brown (#FDE68A)
            ctx.fillStyle = '#fde68a';
            ctx.fillRect(0, cy, size, cy);

            // 3. Central Horizon Line (0° Pitch)
            ctx.strokeStyle = '#1e3a8a';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(0, cy);
            ctx.lineTo(size, cy);
            ctx.stroke();

            // Center aircraft reticle symbol: --- o ---
            ctx.fillStyle = '#1e3a8a';
            ctx.beginPath();
            ctx.arc(cx, cy, 6, 0, Math.PI * 2);
            ctx.fill();

            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.moveTo(cx - 70, cy);
            ctx.lineTo(cx - 20, cy);
            ctx.moveTo(cx + 20, cy);
            ctx.lineTo(cx + 70, cy);
            ctx.stroke();

            // 4. Pitch Ladder Markings Every 10° (-80° to +80°)
            // Pitch scale: 10° = 38 pixels
            const pxPerDeg = 3.8;
            ctx.font = 'bold 15px ui-monospace, Menlo, Monaco, Consolas, monospace';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            for (let deg = 10; deg <= 80; deg += 10) {
                // Positive Pitch (Sky half, above cy)
                const yPos = cy - (deg * pxPerDeg);
                const halfWidth = 75;
                const tickDown = 10;

                ctx.strokeStyle = '#1e40af';
                ctx.fillStyle = '#1e40af';
                ctx.lineWidth = 2.5;
                ctx.setLineDash([]);

                // Horizontal ladder bar with downward ticks (aviation standard: bars angle to horizon)
                ctx.beginPath();
                ctx.moveTo(cx - halfWidth, yPos + tickDown);
                ctx.lineTo(cx - halfWidth, yPos);
                ctx.lineTo(cx - 24, yPos);
                ctx.moveTo(cx + 24, yPos);
                ctx.lineTo(cx + halfWidth, yPos);
                ctx.lineTo(cx + halfWidth, yPos + tickDown);
                ctx.stroke();

                // Degree Numbers
                ctx.fillText(String(deg), cx - halfWidth - 20, yPos);
                ctx.fillText(String(deg), cx + halfWidth + 20, yPos);

                // 5° intermediate tick mark
                const yPos5 = cy - ((deg - 5) * pxPerDeg);
                ctx.beginPath();
                ctx.moveTo(cx - 30, yPos5);
                ctx.lineTo(cx - 16, yPos5);
                ctx.moveTo(cx + 16, yPos5);
                ctx.lineTo(cx + 30, yPos5);
                ctx.stroke();

                // Negative Pitch (Ground half, below cy)
                const yNeg = cy + (deg * pxPerDeg);
                const tickUp = 10;

                ctx.strokeStyle = '#78350f';
                ctx.fillStyle = '#78350f';
                ctx.lineWidth = 2.5;
                ctx.setLineDash([7, 5]); // Dashed line for negative pitch

                ctx.beginPath();
                ctx.moveTo(cx - halfWidth, yNeg - tickUp);
                ctx.lineTo(cx - halfWidth, yNeg);
                ctx.lineTo(cx - 24, yNeg);
                ctx.moveTo(cx + 24, yNeg);
                ctx.lineTo(cx + halfWidth, yNeg);
                ctx.lineTo(cx + halfWidth, yNeg - tickUp);
                ctx.stroke();
                ctx.setLineDash([]);

                // Degree Numbers
                ctx.fillText(`-${deg}`, cx - halfWidth - 24, yNeg);
                ctx.fillText(`-${deg}`, cx + halfWidth + 24, yNeg);

                // -5° intermediate tick mark
                const yNeg5 = cy + ((deg - 5) * pxPerDeg);
                ctx.beginPath();
                ctx.moveTo(cx - 30, yNeg5);
                ctx.lineTo(cx - 16, yNeg5);
                ctx.moveTo(cx + 16, yNeg5);
                ctx.lineTo(cx + 30, yNeg5);
                ctx.stroke();
            }

            // 5. Roll Indicator Arc at the Top (0°, ±10°, ±20°, ±30°, ±45°, ±60°)
            const arcRadius = 450;
            const startAngle = (-90 - 60) * Math.PI / 180;
            const endAngle = (-90 + 60) * Math.PI / 180;

            ctx.strokeStyle = '#0f172a';
            ctx.lineWidth = 3;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(cx, cy, arcRadius, startAngle, endAngle);
            ctx.stroke();

            // Zero-roll reference inverted triangle at 12 o'clock
            ctx.fillStyle = '#dc2626';
            ctx.beginPath();
            ctx.moveTo(cx, cy - arcRadius + 4);
            ctx.lineTo(cx - 10, cy - arcRadius - 16);
            ctx.lineTo(cx + 10, cy - arcRadius - 16);
            ctx.closePath();
            ctx.fill();

            // Bank angle tick marks
            const bankAngles = [-60, -45, -30, -20, -10, 10, 20, 30, 45, 60];
            bankAngles.forEach((b) => {
                const angleRad = (-90 + b) * Math.PI / 180;
                const isMajor = Math.abs(b) === 30 || Math.abs(b) === 60 || Math.abs(b) === 45;
                const tickLen = isMajor ? 18 : 10;

                const x1 = cx + Math.cos(angleRad) * arcRadius;
                const y1 = cy + Math.sin(angleRad) * arcRadius;
                const x2 = cx + Math.cos(angleRad) * (arcRadius + tickLen);
                const y2 = cy + Math.sin(angleRad) * (arcRadius + tickLen);

                ctx.strokeStyle = '#0f172a';
                ctx.lineWidth = isMajor ? 2.5 : 1.5;
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();

                if (isMajor) {
                    const tx = cx + Math.cos(angleRad) * (arcRadius + 30);
                    const ty = cy + Math.sin(angleRad) * (arcRadius + 30);
                    ctx.font = 'bold 13px ui-monospace, monospace';
                    ctx.fillStyle = '#1e293b';
                    ctx.fillText(String(Math.abs(b)), tx, ty);
                }
            });

            const texture = new THREE.CanvasTexture(canvas);
            texture.wrapS = THREE.ClampToEdgeWrapping;
            texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            return texture;
        }

        /**
         * Align artificial horizon plane directly behind origin, parallel to camera view plane.
         * @private
         */
        _alignHorizonWithCamera() {
            if (!this.horizonContainer || !this.camera) return;

            // Place 4 units behind center along camera gaze line
            const dir = this.camera.position.clone().normalize();
            this.horizonContainer.position.copy(dir.multiplyScalar(-4.2));
            this.horizonContainer.quaternion.copy(this.camera.quaternion);
        }

        /**
         * Create Compass Ring around the CanSat model.
         * Features:
         * - Horizontal circular ring with N/S/E/W markings
         * - Tick marks every 10°
         * - Real-time heading indicator arrow tracking CanSat Yaw
         */
        createCompassRing() {
            const THREE = window.THREE;

            this.compassRing = new THREE.Group();
            this.compassRing.name = 'CompassRoseRing';

            const innerRadius = 2.4;
            const outerRadius = 3.3;

            // Generate procedural canvas texture for compass card
            const compassTexture = this._generateCompassTexture();
            this.disposables.textures.add(compassTexture);

            // Ring geometry lying flat in horizontal plane
            const ringGeo = new THREE.RingGeometry(innerRadius, outerRadius, 72);
            ringGeo.rotateX(-Math.PI / 2);
            this.disposables.geometries.add(ringGeo);

            const ringMat = new THREE.MeshBasicMaterial({
                map: compassTexture,
                transparent: true,
                opacity: 0.92,
                side: THREE.DoubleSide
            });
            this.disposables.materials.add(ringMat);

            const ringMesh = new THREE.Mesh(ringGeo, ringMat);
            ringMesh.position.y = -2.2;
            this.compassRing.add(ringMesh);

            // Real-time Heading Indicator Arrow
            this.headingArrow = new THREE.Group();
            this.headingArrow.name = 'CurrentHeadingIndicatorArrow';
            this.headingArrow.position.y = -2.18;

            // Chevron pointer mesh at radius
            const arrowRadius = (innerRadius + outerRadius) / 2;
            const pointerGeo = new THREE.ConeGeometry(0.18, 0.45, 16);
            pointerGeo.rotateX(Math.PI / 2);
            pointerGeo.translate(0, 0, -arrowRadius);
            this.disposables.geometries.add(pointerGeo);

            const pointerMat = new THREE.MeshBasicMaterial({ color: 0x2563eb });
            this.disposables.materials.add(pointerMat);

            const pointerMesh = new THREE.Mesh(pointerGeo, pointerMat);
            this.headingArrow.add(pointerMesh);

            // Center heading line
            const lineGeo = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, -arrowRadius + 0.2)
            ]);
            this.disposables.geometries.add(lineGeo);
            const lineMat = new THREE.LineBasicMaterial({
                color: 0x2563eb,
                linewidth: 2,
                transparent: true,
                opacity: 0.8
            });
            this.disposables.materials.add(lineMat);
            const lineMesh = new THREE.Line(lineGeo, lineMat);
            this.headingArrow.add(lineMesh);

            this.compassRing.add(this.headingArrow);
            this.scene.add(this.compassRing);
        }

        /**
         * Procedural generator for compass rose texture.
         * Draws N (Red), S, E, W, intercardinals, and 10° tick marks.
         * @private
         */
        _generateCompassTexture() {
            const THREE = window.THREE;
            const size = 1024;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');

            const cx = size / 2;
            const cy = size / 2;
            const outerR = 490;
            const innerR = 360;

            // Clean background fill
            ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
            ctx.beginPath();
            ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
            ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
            ctx.fill();

            // Outer and inner border tracks
            ctx.strokeStyle = '#94a3b8';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
            ctx.stroke();

            // Concentric center track
            ctx.strokeStyle = '#cbd5e1';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.arc(cx, cy, (outerR + innerR) / 2, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Draw 10° tick marks & 30° major ticks
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            for (let deg = 0; deg < 360; deg += 5) {
                // In Three.js ring geometry, 0 deg texture corresponds to +X axis, -90 deg is -Z
                const rad = (deg - 90) * Math.PI / 180;
                const isCardinal = deg % 90 === 0;
                const isMajor = deg % 30 === 0;
                const isTen = deg % 10 === 0;

                const tickLength = isMajor ? 28 : (isTen ? 16 : 9);
                const x1 = cx + Math.cos(rad) * outerR;
                const y1 = cy + Math.sin(rad) * outerR;
                const x2 = cx + Math.cos(rad) * (outerR - tickLength);
                const y2 = cy + Math.sin(rad) * (outerR - tickLength);

                ctx.strokeStyle = isMajor ? '#0f172a' : '#64748b';
                ctx.lineWidth = isMajor ? 3 : (isTen ? 1.5 : 1);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(x2, y2);
                ctx.stroke();

                // Degree Numbers on 30° intervals (excluding cardinals)
                if (isMajor && !isCardinal) {
                    const textR = (outerR + innerR) / 2;
                    const tx = cx + Math.cos(rad) * textR;
                    const ty = cy + Math.sin(rad) * textR;
                    ctx.font = 'bold 22px ui-monospace, monospace';
                    ctx.fillStyle = '#475569';
                    ctx.fillText(String(deg).padStart(3, '0'), tx, ty);
                }
            }

            // Cardinal Letters
            const cardinals = [
                { label: 'N', deg: 0, color: '#dc2626', size: '36px' },   // Red North
                { label: 'E', deg: 90, color: '#0f172a', size: '34px' },
                { label: 'S', deg: 180, color: '#0f172a', size: '34px' },
                { label: 'W', deg: 270, color: '#0f172a', size: '34px' }
            ];

            cardinals.forEach((c) => {
                const rad = (c.deg - 90) * Math.PI / 180;
                const textR = (outerR + innerR) / 2;
                const tx = cx + Math.cos(rad) * textR;
                const ty = cy + Math.sin(rad) * textR;

                ctx.font = `800 ${c.size} -apple-system, sans-serif`;
                ctx.fillStyle = c.color;
                ctx.fillText(c.label, tx, ty);
            });

            // Intercardinal Points (NE, SE, SW, NW)
            const intercardinals = [
                { label: 'NE', deg: 45 },
                { label: 'SE', deg: 135 },
                { label: 'SW', deg: 225 },
                { label: 'NW', deg: 315 }
            ];

            intercardinals.forEach((c) => {
                const rad = (c.deg - 90) * Math.PI / 180;
                const textR = (outerR + innerR) / 2;
                const tx = cx + Math.cos(rad) * textR;
                const ty = cy + Math.sin(rad) * textR;

                ctx.font = 'bold 20px -apple-system, sans-serif';
                ctx.fillStyle = '#64748b';
                ctx.fillText(c.label, tx, ty);
            });

            const texture = new THREE.CanvasTexture(canvas);
            texture.minFilter = THREE.LinearFilter;
            texture.magFilter = THREE.LinearFilter;
            return texture;
        }

        /**
         * Setup digital telemetry HUD overlay badges on top of canvas.
         * @private
         */
        _setupDomOverlay() {
            if (typeof document === 'undefined') return;
            if (!this.canvas) return;

            const parent = this.canvas.parentElement;
            if (!parent) return;

            // Check if wrapper already created
            if (!parent.classList.contains('attitude-viewport-wrapper')) {
                parent.classList.add('attitude-viewport-wrapper');
            }
            this.uiWrapper = parent;

            // Remove existing overlay elements if re-initializing
            const existingTelemetry = parent.querySelector('.attitude-telemetry-badge');
            if (existingTelemetry) existingTelemetry.remove();
            const existingHeading = parent.querySelector('.attitude-heading-badge');
            if (existingHeading) existingHeading.remove();
            const existingCrosshair = parent.querySelector('.attitude-hud-crosshair');
            if (existingCrosshair) existingCrosshair.remove();
            const existingFps = parent.querySelector('.attitude-fps-tag');
            if (existingFps) existingFps.remove();

            if (!this.options.showHud) return;

            // 1. Digital Telemetry Badge (Roll, Pitch, Yaw)
            const badge = document.createElement('div');
            badge.className = 'attitude-telemetry-badge';
            badge.innerHTML = `
                <div class="telemetry-row">
                    <span class="badge-label">ROLL:</span>
                    <span class="val-roll">+00.0°</span>
                </div>
                <div class="telemetry-row">
                    <span class="badge-label">PITCH:</span>
                    <span class="val-pitch">+00.0°</span>
                </div>
                <div class="telemetry-row">
                    <span class="badge-label">YAW:</span>
                    <span class="val-yaw">000.0°</span>
                </div>
            `;
            parent.appendChild(badge);
            this.telemetryBadgeEl = badge;

            // 2. Heading Card Badge
            const headingBadge = document.createElement('div');
            headingBadge.className = 'attitude-heading-badge';
            headingBadge.innerHTML = `
                <div class="heading-title">Compass Heading</div>
                <div>
                    <span class="heading-val">000.0°</span>
                    <span class="heading-cardinal">N</span>
                </div>
            `;
            parent.appendChild(headingBadge);
            this.headingBadgeEl = headingBadge;

            // 3. Center Crosshair Reticle
            const crosshair = document.createElement('div');
            crosshair.className = 'attitude-hud-crosshair';
            crosshair.innerHTML = `
                <svg viewBox="0 0 48 48" fill="none" stroke="#2563eb" stroke-width="1.75">
                    <circle cx="24" cy="24" r="6" stroke="#2563eb" stroke-width="1.5" />
                    <line x1="2" y1="24" x2="14" y2="24" />
                    <line x1="34" y1="24" x2="46" y2="24" />
                    <line x1="24" y1="2" x2="24" y2="14" />
                    <line x1="24" y1="34" x2="24" y2="46" />
                </svg>
            `;
            parent.appendChild(crosshair);

            // 4. 30 FPS Performance Tag
            const fpsTag = document.createElement('div');
            fpsTag.className = 'attitude-fps-tag';
            fpsTag.textContent = '30 FPS | THREE.js';
            parent.appendChild(fpsTag);
            this.fpsBadgeEl = fpsTag;
        }

        /**
         * Update CanSat orientation with new telemetry angles.
         * 
         * @param {number} roll   Longitudinal rotation (X) in degrees (-180 to +180)
         * @param {number} pitch  Lateral rotation (Y) in degrees (-90 to +90)
         * @param {number} yaw    Vertical rotation (Z) in degrees (0 to 360)
         */
        updateAttitude(roll, pitch, yaw) {
            // Safe numeric parsing
            const r = typeof roll === 'number' ? roll : parseFloat(roll) || 0;
            const p = typeof pitch === 'number' ? pitch : parseFloat(pitch) || 0;
            const y = typeof yaw === 'number' ? yaw : parseFloat(yaw) || 0;

            // Update targets
            this.targetAttitude.roll = r;
            this.targetAttitude.pitch = Math.max(-90, Math.min(90, p));
            this.targetAttitude.yaw = ((y % 360) + 360) % 360;
        }

        /**
         * Alias for updateAttitude to support standard interface
         */
        update(roll, pitch, yaw) {
            return this.updateAttitude(roll, pitch, yaw);
        }

        /**
         * Interpolate current angles towards targets using lerp for visual smoothness.
         * Handles shortest angular distance wraparound for yaw (e.g. 355° -> 5°).
         * @private
         */
        _updateInterpolation() {
            const factor = this.options.lerpFactor;

            // Roll lerp
            this.currentAttitude.roll += (this.targetAttitude.roll - this.currentAttitude.roll) * factor;

            // Pitch lerp
            this.currentAttitude.pitch += (this.targetAttitude.pitch - this.currentAttitude.pitch) * factor;

            // Yaw lerp (shortest-path circular interpolation)
            let yawDiff = this.targetAttitude.yaw - this.currentAttitude.yaw;
            while (yawDiff > 180) yawDiff -= 360;
            while (yawDiff < -180) yawDiff += 360;

            this.currentAttitude.yaw += yawDiff * factor;
            this.currentAttitude.yaw = ((this.currentAttitude.yaw % 360) + 360) % 360;
        }

        /**
         * Main requestAnimationFrame animation loop throttled to 30 FPS.
         * @param {DOMHighResTimeStamp} [timestamp]
         */
        animate(timestamp) {
            if (!this.isRunning) return;

            this.animFrameId = requestAnimationFrame(this._animateLoop);

            if (!timestamp) timestamp = performance.now();
            const elapsed = timestamp - this.lastRenderTime;

            // Throttle to target FPS (30 FPS)
            if (elapsed >= this.fpsInterval) {
                this.lastRenderTime = timestamp - (elapsed % this.fpsInterval);

                // 1. Smoothly interpolate attitude
                this._updateInterpolation();

                // 2. Render scene
                this.render();
            }
        }

        /**
         * Render 3D scene and update overlays.
         */
        render() {
            if (!this.renderer || !this.scene || !this.camera) return;

            const THREE = window.THREE;
            const rollRad = (this.currentAttitude.roll * Math.PI) / 180;
            const pitchRad = (this.currentAttitude.pitch * Math.PI) / 180;
            const yawRad = (this.currentAttitude.yaw * Math.PI) / 180;

            // 1. Update CanSat Model Euler Rotation (ZYX Order)
            if (this.cansatModel) {
                this.cansatModel.rotation.set(rollRad, pitchRad, yawRad, 'ZYX');
            }

            // 2. Update Artificial Horizon Reference (Tilts opposite to roll/pitch)
            if (this.horizonMesh) {
                // Bank angle: rotate disk opposite to roll
                this.horizonMesh.rotation.z = -rollRad;

                // Pitch ladder: scroll vertical texture offset opposite to pitch
                if (this.horizonTexture) {
                    // Texture scaling: 10° = 38px on 1024px canvas -> 0.0371 offset per 10°
                    const pitchOffset = -(this.currentAttitude.pitch / 10) * (38 / 1024);
                    this.horizonTexture.offset.y = pitchOffset;
                }
            }

            // 3. Update Compass Rose Heading Arrow
            if (this.headingArrow) {
                // Rotate arrow to point along vehicle's yaw heading
                this.headingArrow.rotation.y = -yawRad;
            }

            // 4. Update DOM HUD Overlay Values
            if (this.telemetryBadgeEl) {
                this._updateTelemetryDom();
            }

            // 5. Render Three.js Scene
            this.renderer.render(this.scene, this.camera);
        }

        /**
         * Update digital readout badges in DOM.
         * @private
         */
        _updateTelemetryDom() {
            const roll = this.currentAttitude.roll;
            const pitch = this.currentAttitude.pitch;
            const yaw = this.currentAttitude.yaw;

            const formatSigned = (val) => (val >= 0 ? `+${val.toFixed(1)}` : val.toFixed(1)).padStart(5, ' ');
            const formatYaw = (val) => val.toFixed(1).padStart(5, '0');

            if (this.telemetryBadgeEl) {
                const rollEl = this.telemetryBadgeEl.querySelector('.val-roll');
                const pitchEl = this.telemetryBadgeEl.querySelector('.val-pitch');
                const yawEl = this.telemetryBadgeEl.querySelector('.val-yaw');

                if (rollEl) rollEl.textContent = `${formatSigned(roll)}°`;
                if (pitchEl) pitchEl.textContent = `${formatSigned(pitch)}°`;
                if (yawEl) yawEl.textContent = `${formatYaw(yaw)}°`;
            }

            if (this.headingBadgeEl) {
                const hVal = this.headingBadgeEl.querySelector('.heading-val');
                const hCard = this.headingBadgeEl.querySelector('.heading-cardinal');

                if (hVal) hVal.textContent = `${formatYaw(yaw)}°`;
                if (hCard) hCard.textContent = this._getCardinalDirection(yaw);
            }
        }

        /**
         * Convert heading degrees to 8-point compass cardinal direction.
         * @private
         */
        _getCardinalDirection(deg) {
            const d = ((deg % 360) + 360) % 360;
            if (d >= 337.5 || d < 22.5) return 'N';
            if (d >= 22.5 && d < 67.5) return 'NE';
            if (d >= 67.5 && d < 112.5) return 'E';
            if (d >= 112.5 && d < 157.5) return 'SE';
            if (d >= 157.5 && d < 202.5) return 'S';
            if (d >= 202.5 && d < 247.5) return 'SW';
            if (d >= 247.5 && d < 292.5) return 'W';
            return 'NW';
        }

        /**
         * Handle canvas resize event to preserve aspect ratio.
         */
        onResize() {
            if (!this.canvas || !this.renderer || !this.camera) return;

            const width = this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 400;
            const height = this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || 300;

            if (width === 0 || height === 0) return;

            this.camera.aspect = width / height;
            this.camera.updateProjectionMatrix();

            this.renderer.setSize(width, height, false);

            // Re-align horizon with camera
            this._alignHorizonWithCamera();
        }

        /**
         * Get current attitude angles (interpolated).
         * @returns {{ roll: number, pitch: number, yaw: number }}
         */
        getAttitude() {
            return {
                roll: Number(this.currentAttitude.roll.toFixed(2)),
                pitch: Number(this.currentAttitude.pitch.toFixed(2)),
                yaw: Number(this.currentAttitude.yaw.toFixed(2))
            };
        }

        /**
         * Reset attitude targets and current state to level flight (0, 0, 0).
         */
        resetAttitude() {
            this.updateAttitude(0, 0, 0);
        }

        /**
         * Dynamically change the CanSat wireframe color.
         * @param {number|string} hexColor
         */
        setWireframeColor(hexColor) {
            const THREE = window.THREE;
            if (!THREE || !this.wireframeMesh) return;

            const color = new THREE.Color(hexColor);
            this.wireframeMesh.material.color = color;
            this.options.wireframeColor = color.getHex();
        }

        /**
         * Clean up all Three.js resources, event listeners, and animation loop.
         */
        destroy() {
            this.isRunning = false;

            // 1. Cancel requestAnimationFrame
            if (this.animFrameId) {
                cancelAnimationFrame(this.animFrameId);
                this.animFrameId = null;
            }

            // 2. Unbind event listeners
            if (typeof window !== 'undefined') {
                window.removeEventListener('resize', this._handleResize);
            }

            if (this.resizeObserver) {
                this.resizeObserver.disconnect();
                this.resizeObserver = null;
            }

            // 3. Remove DOM overlay elements
            if (this.telemetryBadgeEl) this.telemetryBadgeEl.remove();
            if (this.headingBadgeEl) this.headingBadgeEl.remove();
            if (this.fpsBadgeEl) this.fpsBadgeEl.remove();

            // 4. Dispose Scene Graph
            if (this.scene) {
                this.scene.traverse((obj) => {
                    if (obj.geometry) {
                        obj.geometry.dispose();
                    }
                    if (obj.material) {
                        if (Array.isArray(obj.material)) {
                            obj.material.forEach((m) => this._disposeMaterial(m));
                        } else {
                            this._disposeMaterial(obj.material);
                        }
                    }
                });
            }

            // 5. Explicit disposal sets
            this.disposables.geometries.forEach((g) => g.dispose && g.dispose());
            this.disposables.materials.forEach((m) => this._disposeMaterial(m));
            this.disposables.textures.forEach((t) => t.dispose && t.dispose());
            this.disposables.geometries.clear();
            this.disposables.materials.clear();
            this.disposables.textures.clear();

            // 6. Dispose WebGL Renderer
            if (this.renderer) {
                this.renderer.dispose();
                if (this.renderer.forceContextLoss) {
                    this.renderer.forceContextLoss();
                }
                this.renderer.domElement = null;
                this.renderer = null;
            }

            this.scene = null;
            this.camera = null;
            this.cansatModel = null;
            this.horizonContainer = null;
            this.horizonMesh = null;
            this.compassRing = null;
            this.headingArrow = null;
            this.groundGrid = null;
        }

        /**
         * Dispose material and associated textures.
         * @private
         */
        _disposeMaterial(mat) {
            if (!mat) return;
            if (mat.map && mat.map.dispose) mat.map.dispose();
            if (mat.lightMap && mat.lightMap.dispose) mat.lightMap.dispose();
            if (mat.bumpMap && mat.bumpMap.dispose) mat.bumpMap.dispose();
            if (mat.normalMap && mat.normalMap.dispose) mat.normalMap.dispose();
            if (mat.specularMap && mat.specularMap.dispose) mat.specularMap.dispose();
            if (mat.envMap && mat.envMap.dispose) mat.envMap.dispose();
            if (mat.dispose) mat.dispose();
        }
    }

    // Export module globally and to CommonJS if applicable
    window.AttitudeIndicator = AttitudeIndicator;
    window.Attitude3D = AttitudeIndicator;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = AttitudeIndicator;
    }
})();

