/**
 * ============================================================================
 * CanSat Ground Control Station (GCS) - Interactive GPS Tracking Map Manager
 * High-Contrast Sunlight-Visible Outdoor Aerospace Dashboard Component
 * ============================================================================
 * 
 * Features:
 * - High-contrast OpenStreetMap integration with HTML5 Canvas acceleration
 * - Ground Control Station (GCS) marker with directional 14dBi LPDA antenna beam cone (~30° beamwidth)
 * - Real-time CanSat telemetry marker with altitude badge and pulsing radar ring
 * - Multi-segment altitude-colored flight trail (Blue = High Altitude -> Red = Low Altitude)
 * - Auto-Follow mode with intelligent user pan detection and on-screen toggle control
 * - Geodesic calculations: Haversine distance, Azimuth/Bearing, Forward Geodesic Projection
 * - Launch site safety exclusion perimeter & Landing zone uncertainty prediction
 * - Recovery zone search & rescue perimeter visualization
 * - KML 2.2 3D Flight Path Export (<altitudeMode>absolute</altitudeMode>)
 * - GeoJSON FeatureCollection Export with 3D LineString trajectory
 * - 4Hz update throttling on map rendering & 10,000-point decimation for smooth 60 FPS
 */

(function () {
    'use strict';

    // ------------------------------------------------------------------------
    // CSS Styles for High-Contrast Outdoor Sunlight Visibility
    // ------------------------------------------------------------------------
    const MAP_MANAGER_STYLES_ID = 'cansat-map-manager-styles';

    function injectStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById(MAP_MANAGER_STYLES_ID)) return;

        const style = document.createElement('style');
        style.id = MAP_MANAGER_STYLES_ID;
        style.textContent = `
            /* CanSat Animated Pulsing Marker */
            .cansat-marker-wrapper {
                position: relative;
                width: 36px;
                height: 36px;
                display: flex;
                align-items: center;
                justify-content: center;
                pointer-events: auto;
            }
            .cansat-pulse-ring {
                position: absolute;
                width: 36px;
                height: 36px;
                border-radius: 50%;
                background: rgba(37, 99, 235, 0.4);
                border: 2px solid #2563eb;
                animation: cansat-ping 1.8s cubic-bezier(0, 0, 0.2, 1) infinite;
            }
            .cansat-core-dot {
                position: relative;
                width: 14px;
                height: 14px;
                border-radius: 50%;
                background-color: #2563eb;
                border: 2px solid #ffffff;
                box-shadow: 0 0 8px rgba(0, 0, 0, 0.6), 0 0 2px rgba(37, 99, 235, 0.8);
                z-index: 2;
                transition: background-color 0.3s ease;
            }
            .cansat-alt-badge {
                position: absolute;
                bottom: -22px;
                left: 50%;
                transform: translateX(-50%);
                background: #0f172a;
                color: #ffffff;
                font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
                font-size: 11px;
                font-weight: 700;
                padding: 1px 6px;
                border-radius: 4px;
                border: 1px solid #334155;
                white-space: nowrap;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
                letter-spacing: 0.02em;
                z-index: 3;
            }

            @keyframes cansat-ping {
                0% {
                    transform: scale(0.6);
                    opacity: 1;
                }
                80%, 100% {
                    transform: scale(2.2);
                    opacity: 0;
                }
            }

            /* GCS Marker Styling */
            .gcs-marker-wrapper {
                position: relative;
                width: 44px;
                height: 44px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
            }
            .gcs-icon-badge {
                width: 34px;
                height: 34px;
                background: #ffffff;
                border: 2.5px solid #0f172a;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                box-shadow: 0 4px 10px rgba(0, 0, 0, 0.3);
                position: relative;
                z-index: 2;
            }
            .gcs-heading-arrow {
                position: absolute;
                top: -8px;
                width: 0;
                height: 0;
                border-left: 5px solid transparent;
                border-right: 5px solid transparent;
                border-bottom: 8px solid #2563eb;
                transform-origin: 5px 25px;
                z-index: 3;
            }
            .gcs-label {
                position: absolute;
                bottom: -18px;
                background: #ffffff;
                color: #0f172a;
                border: 1.5px solid #0f172a;
                font-family: system-ui, -apple-system, sans-serif;
                font-size: 10px;
                font-weight: 800;
                padding: 0 5px;
                border-radius: 3px;
                white-space: nowrap;
                box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
            }

            /* Map Control Custom Buttons */
            .leaflet-bar .gcs-map-btn {
                background-color: #ffffff;
                border: 2px solid #0f172a !important;
                color: #0f172a;
                font-family: system-ui, -apple-system, sans-serif;
                font-size: 11px;
                font-weight: 700;
                display: flex;
                align-items: center;
                gap: 5px;
                padding: 4px 9px;
                cursor: pointer;
                box-shadow: 0 2px 6px rgba(0,0,0,0.25);
                border-radius: 4px;
                transition: all 0.15s ease-in-out;
                user-select: none;
                margin-bottom: 6px;
            }
            .leaflet-bar .gcs-map-btn:hover {
                background-color: #f1f5f9;
            }
            .leaflet-bar .gcs-map-btn.active {
                background-color: #2563eb;
                border-color: #1d4ed8 !important;
                color: #ffffff;
                box-shadow: 0 0 10px rgba(37, 99, 235, 0.5);
            }
            .leaflet-bar .gcs-map-btn svg {
                width: 14px;
                height: 14px;
                stroke-width: 2.5;
            }

            /* Map Altitude Legend */
            .gcs-map-legend {
                background: #ffffff;
                border: 2px solid #0f172a;
                border-radius: 6px;
                padding: 6px 10px;
                font-family: ui-monospace, SFMono-Regular, monospace;
                font-size: 10px;
                font-weight: 700;
                color: #0f172a;
                box-shadow: 0 4px 12px rgba(0,0,0,0.2);
                pointer-events: auto;
            }
            .gcs-legend-bar {
                width: 110px;
                height: 8px;
                border-radius: 3px;
                background: linear-gradient(to right, #dc2626, #f97316, #eab308, #10b981, #06b6d4, #2563eb);
                margin: 4px 0 2px 0;
                border: 1px solid #475569;
            }
            .gcs-legend-labels {
                display: flex;
                justify-content: space-between;
                font-size: 9px;
                color: #334155;
            }

            /* Landing Prediction Marker */
            .landing-target-marker {
                width: 28px;
                height: 28px;
                border-radius: 50%;
                border: 2px dashed #dc2626;
                display: flex;
                align-items: center;
                justify-content: center;
                background: rgba(220, 38, 38, 0.15);
                animation: target-spin 6s linear infinite;
            }
            .landing-target-inner {
                width: 8px;
                height: 8px;
                background-color: #dc2626;
                border-radius: 50%;
            }
            @keyframes target-spin {
                0% { transform: rotate(0deg); }
                100% { transform: rotate(360deg); }
            }
        `;
        document.head.appendChild(style);
    }

    // ------------------------------------------------------------------------
    // MapManager Class Implementation
    // ------------------------------------------------------------------------
    class MapManager {
        /**
         * Create an interactive GPS Map Manager for the CanSat Ground Control Station.
         * @param {string} containerId - DOM container ID (default: 'map-container')
         * @param {Object} options - Configuration overrides
         */
        constructor(containerId = 'map-container', options = {}) {
            injectStyles();

            this.containerId = containerId;
            this.options = Object.assign({
                defaultLat: 28.6139,
                defaultLon: 77.2090,
                defaultZoom: 16,
                minZoom: 4,
                maxZoom: 19,
                antennaBeamwidthDeg: 30, // 14dBi LPDA ~30° beamwidth
                antennaRangeMeters: 1500, // Visual cone distance in meters
                maxTrailPoints: 10000,
                throttleIntervalMs: 250 // 4Hz maximum map rendering frequency
            }, options);

            // Leaflet instance and renderers
            this.map = null;
            this.canvasRenderer = null;
            this.tileLayer = null;

            // Follow mode
            this.followMode = true;
            this.isProgrammaticMove = false;
            this.followControl = null;
            this.legendControl = null;

            // Markers and layers
            this.canSatMarker = null;
            this.gcsMarker = null;
            this.antennaConePolygon = null;
            this.antennaBoresightLine = null;
            this.launchSiteLayerGroup = null;
            this.landingPredictionLayerGroup = null;
            this.recoveryZoneLayerGroup = null;
            this.trailLayerGroup = null;

            // Telemetry state
            this.currentLat = null;
            this.currentLon = null;
            this.currentAlt = null;
            this.currentState = 'IDLE';
            this.gcsLat = null;
            this.gcsLon = null;
            this.antennaHeading = 0;

            // Trail data store: array of [lat, lon, alt, time]
            this.trailPoints = [];
            this.lastRenderedPointIndex = -1;
            this.minAltitude = Infinity;
            this.maxAltitude = -Infinity;
            this.apogeePoint = null;

            // Throttling mechanism (4Hz = 250ms max map rendering rate)
            this.lastRenderTimestamp = 0;
            this.throttleTimer = null;

            // Auto-initialize if DOM container element exists
            if (typeof document !== 'undefined') {
                const container = document.getElementById(this.containerId);
                if (container) {
                    this.initMap(this.options.defaultLat, this.options.defaultLon, this.options.defaultZoom);
                }
            }
        }

        // --------------------------------------------------------------------
        // Initialization
        // --------------------------------------------------------------------

        /**
         * Initialize Leaflet map with OpenStreetMap tiles and Canvas acceleration.
         * @param {number} centerLat 
         * @param {number} centerLon 
         * @param {number} zoom 
         * @returns {MapManager} self instance
         */
        initMap(centerLat, centerLon, zoom) {
            const lat = Number(centerLat) || this.options.defaultLat;
            const lon = Number(centerLon) || this.options.defaultLon;
            const z = Number(zoom) || this.options.defaultZoom;

            if (this.map) {
                this.map.setView([lat, lon], z);
                return this;
            }

            if (typeof document === 'undefined') return this;
            const container = document.getElementById(this.containerId);
            if (!container) {
                console.warn(`[MapManager] Map container element '#${this.containerId}' not found in DOM.`);
                return this;
            }

            if (typeof L === 'undefined') {
                console.error('[MapManager] Leaflet library (L) is not loaded! Include leaflet.js before MapManager.');
                return this;
            }

            // Create Canvas Renderer for high-performance polyline rendering
            this.canvasRenderer = L.canvas({ padding: 0.5 });

            // Initialize Leaflet map instance
            this.map = L.map(this.containerId, {
                center: [lat, lon],
                zoom: z,
                minZoom: this.options.minZoom,
                maxZoom: this.options.maxZoom,
                preferCanvas: true,
                zoomControl: false, // Repositioned cleanly for aerospace layout
                attributionControl: true
            });

            // Compact OpenStreetMap Tile Layer
            this.tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: this.options.maxZoom,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OSM</a>'
            }).addTo(this.map);

            // Add standard zoom control at top-left
            L.control.zoom({ position: 'topleft' }).addTo(this.map);

            // Layer Groups
            this.launchSiteLayerGroup = L.layerGroup().addTo(this.map);
            this.recoveryZoneLayerGroup = L.layerGroup().addTo(this.map);
            this.landingPredictionLayerGroup = L.layerGroup().addTo(this.map);
            this.trailLayerGroup = L.featureGroup().addTo(this.map);

            // Add Custom Aerospace Controls
            this._initFollowControl();
            this._initLegendControl();

            // Detect manual user pans to cleanly disengage auto-follow
            this.map.on('movestart dragstart', (e) => {
                if (!this.isProgrammaticMove) {
                    this.setFollowMode(false);
                }
            });

            this.map.on('moveend', () => {
                this.isProgrammaticMove = false;
            });

            return this;
        }

        // --------------------------------------------------------------------
        // Ground Station Marker & LPDA Directional Antenna Beam Cone
        // --------------------------------------------------------------------

        /**
         * Place or update GCS marker with directional LPDA antenna beam cone.
         * @param {number} lat - GCS Latitude
         * @param {number} lon - GCS Longitude
         * @param {number} antennaHeading - Azimuth direction in degrees (0 = North)
         */
        setGroundStation(lat, lon, antennaHeading = 0) {
            lat = Number(lat);
            lon = Number(lon);
            antennaHeading = (Number(antennaHeading) || 0) % 360;

            if (isNaN(lat) || isNaN(lon)) {
                console.error('[MapManager] Invalid GCS coordinates:', lat, lon);
                return;
            }

            this.gcsLat = lat;
            this.gcsLon = lon;
            this.antennaHeading = antennaHeading;

            if (!this.map || typeof L === 'undefined') return;

            // 1. Create or update GCS Marker with SVG Antenna Tower Icon
            const gcsIconHtml = `
                <div class="gcs-marker-wrapper">
                    <div class="gcs-icon-badge" title="GCS Antenna Heading: ${antennaHeading.toFixed(1)}°">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#0f172a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 2v20M4 6l16 0M6 10l12 0M8 14l8 0M10 18l4 0"/>
                            <circle cx="12" cy="2" r="1.5" fill="#2563eb" stroke="#2563eb"/>
                        </svg>
                        <div class="gcs-heading-arrow" style="transform: rotate(${antennaHeading}deg) translateX(-5px);"></div>
                    </div>
                    <div class="gcs-label">GCS ${Math.round(antennaHeading)}°</div>
                </div>
            `;

            const gcsIcon = L.divIcon({
                className: 'custom-gcs-marker',
                html: gcsIconHtml,
                iconSize: [44, 44],
                iconAnchor: [22, 22]
            });

            if (this.gcsMarker) {
                this.gcsMarker.setLatLng([lat, lon]);
                this.gcsMarker.setIcon(gcsIcon);
            } else {
                this.gcsMarker = L.marker([lat, lon], {
                    icon: gcsIcon,
                    zIndexOffset: 500,
                    interactive: true
                }).addTo(this.map);

                this.gcsMarker.bindPopup(`
                    <div style="font-family: system-ui, sans-serif; font-size: 12px; color: #0f172a;">
                        <strong style="color: #2563eb; font-size: 13px;">Ground Control Station (GCS)</strong><br/>
                        <b>Position:</b> ${lat.toFixed(5)}°, ${lon.toFixed(5)}°<br/>
                        <b>LPDA Azimuth:</b> ${antennaHeading.toFixed(1)}°<br/>
                        <b>Beamwidth:</b> ~${this.options.antennaBeamwidthDeg}° (-3dB)
                    </div>
                `);
            }

            // 2. Render 14dBi LPDA Directional Beam Cone (~30° beamwidth)
            const coneCoordinates = this._calculateAntennaConeCoords(
                lat,
                lon,
                antennaHeading,
                this.options.antennaBeamwidthDeg,
                this.options.antennaRangeMeters
            );

            if (this.antennaConePolygon) {
                this.antennaConePolygon.setLatLngs(coneCoordinates);
            } else {
                this.antennaConePolygon = L.polygon(coneCoordinates, {
                    color: '#2563eb',
                    weight: 1.5,
                    opacity: 0.8,
                    dashArray: '4, 4',
                    fillColor: '#3b82f6',
                    fillOpacity: 0.18,
                    renderer: this.canvasRenderer
                }).addTo(this.map);
            }

            // 3. Render Boresight Centerline
            const boresightEnd = this._destinationPoint(lat, lon, this.options.antennaRangeMeters, antennaHeading);
            if (this.antennaBoresightLine) {
                this.antennaBoresightLine.setLatLngs([[lat, lon], boresightEnd]);
            } else {
                this.antennaBoresightLine = L.polyline([[lat, lon], boresightEnd], {
                    color: '#1d4ed8',
                    weight: 2,
                    opacity: 0.7,
                    dashArray: '3, 4',
                    renderer: this.canvasRenderer
                }).addTo(this.map);
            }
        }

        /**
         * Update antenna azimuth direction without relocating GCS position.
         * @param {number} headingDeg - Heading in degrees
         */
        updateAntennaHeading(headingDeg) {
            if (this.gcsLat !== null && this.gcsLon !== null) {
                this.setGroundStation(this.gcsLat, this.gcsLon, headingDeg);
            }
        }

        // --------------------------------------------------------------------
        // CanSat Telemetry Tracking & Throttling
        // --------------------------------------------------------------------

        /**
         * Update CanSat position with altitude and flight state.
         * Appends immediately to the telemetry store; throttles visual map redraw to 4Hz (250ms).
         * @param {number} lat - Latitude
         * @param {number} lon - Longitude
         * @param {number} alt - Altitude in meters
         * @param {string} [state='FLIGHT'] - CanSat mission state (e.g. 'PAD', 'ASCENT', 'DESCENT', 'LANDED')
         * @param {number} [timestamp] - Telemetry timestamp (epoch ms)
         */
        updateCanSatPosition(lat, lon, alt, state = 'FLIGHT', timestamp = Date.now()) {
            lat = Number(lat);
            lon = Number(lon);
            alt = Number(alt) || 0;

            if (isNaN(lat) || isNaN(lon)) return;

            // 1. Immediately record telemetry point into trail points array
            this.currentLat = lat;
            this.currentLon = lon;
            this.currentAlt = alt;
            this.currentState = state || 'FLIGHT';

            if (alt < this.minAltitude) this.minAltitude = alt;
            if (alt > this.maxAltitude) {
                this.maxAltitude = alt;
                this.apogeePoint = { lat, lon, alt, timestamp };
            }

            const currentPoint = [lat, lon, alt, timestamp];
            this.trailPoints.push(currentPoint);

            // Decimate if trail points exceed 10,000
            if (this.trailPoints.length > this.options.maxTrailPoints) {
                this._decimateTrail();
            }

            // 2. Throttle visual map rendering to 4Hz max (250ms)
            const now = Date.now();
            const elapsed = now - this.lastRenderTimestamp;

            if (elapsed >= this.options.throttleIntervalMs) {
                if (this.throttleTimer) {
                    clearTimeout(this.throttleTimer);
                    this.throttleTimer = null;
                }
                this._renderMapUpdate();
                this.lastRenderTimestamp = now;
            } else if (!this.throttleTimer) {
                const waitTime = this.options.throttleIntervalMs - elapsed;
                this.throttleTimer = setTimeout(() => {
                    this.throttleTimer = null;
                    this._renderMapUpdate();
                    this.lastRenderTimestamp = Date.now();
                }, waitTime);
            }
        }

        /**
         * Generic update adapter for telemetry engines
         */
        update(lat, lon, alt = 0, state = 'FLIGHT') {
            return this.updateCanSatPosition(lat, lon, alt, state, Date.now());
        }

        /**
         * Recenter map on specific or latest coordinates
         */
        recenter(lat = null, lon = null) {
            const targetLat = lat !== null ? Number(lat) : this.currentLat;
            const targetLon = lon !== null ? Number(lon) : this.currentLon;
            if (targetLat !== null && targetLon !== null && !isNaN(targetLat) && !isNaN(targetLon) && this.map) {
                this.isProgrammaticMove = true;
                this.map.panTo([targetLat, targetLon], { animate: true, duration: 0.5 });
            }
        }

        /**
         * Render throttled map changes: marker update, polyline additions, and follow auto-pan.
         * @private
         */
        _renderMapUpdate() {
            if (!this.map || typeof L === 'undefined') return;
            if (this.currentLat === null || this.currentLon === null) return;

            const lat = this.currentLat;
            const lon = this.currentLon;
            const alt = this.currentAlt;
            const state = this.currentState;

            const stateColor = this._getStateColor(state);
            const altFormatted = `${alt.toFixed(1)}m`;

            // 1. Update or Create CanSat Marker
            if (this.canSatMarker) {
                this.canSatMarker.setLatLng([lat, lon]);
                const badgeEl = this.canSatMarker.getElement()?.querySelector('.cansat-alt-badge');
                if (badgeEl) {
                    badgeEl.textContent = altFormatted;
                }
                const coreDot = this.canSatMarker.getElement()?.querySelector('.cansat-core-dot');
                if (coreDot) {
                    coreDot.style.backgroundColor = stateColor;
                }
            } else {
                const canSatIconHtml = `
                    <div class="cansat-marker-wrapper">
                        <div class="cansat-pulse-ring"></div>
                        <div class="cansat-core-dot" style="background-color: ${stateColor};"></div>
                        <div class="cansat-alt-badge">${altFormatted}</div>
                    </div>
                `;

                const canSatIcon = L.divIcon({
                    className: 'custom-cansat-marker',
                    html: canSatIconHtml,
                    iconSize: [36, 36],
                    iconAnchor: [18, 18]
                });

                this.canSatMarker = L.marker([lat, lon], {
                    icon: canSatIcon,
                    zIndexOffset: 1000,
                    interactive: true
                }).addTo(this.map);

                this.canSatMarker.bindPopup(() => {
                    const dist = this.getDistanceToGCS(this.currentLat, this.currentLon);
                    const brg = this.getBearingFromGCS(this.currentLat, this.currentLon);
                    return `
                        <div style="font-family: system-ui, sans-serif; font-size: 12px; color: #0f172a; line-height: 1.4;">
                            <strong style="color: #2563eb; font-size: 13px;">CanSat Telemetry</strong><br/>
                            <b>Coordinates:</b> ${this.currentLat.toFixed(5)}°, ${this.currentLon.toFixed(5)}°<br/>
                            <b>Altitude:</b> ${this.currentAlt.toFixed(1)} m<br/>
                            <b>Flight State:</b> <span style="font-weight:700; color: ${this._getStateColor(this.currentState)}">${this.currentState}</span><br/>
                            ${dist !== null ? `<b>Range to GCS:</b> ${(dist / 1000).toFixed(2)} km (${dist.toFixed(0)} m)<br/>` : ''}
                            ${brg !== null ? `<b>Bearing from GCS:</b> ${brg.toFixed(1)}°<br/>` : ''}
                            <b>Trail Points:</b> ${this.trailPoints.length}
                        </div>
                    `;
                });
            }

            // 2. Render pending polyline segments since last visual render
            if (this.trailLayerGroup && this.trailPoints.length > 1) {
                const startIndex = Math.max(0, this.lastRenderedPointIndex);
                for (let i = startIndex; i < this.trailPoints.length - 1; i++) {
                    const p1 = this.trailPoints[i];
                    const p2 = this.trailPoints[i + 1];
                    const segmentColor = this._getAltitudeColor(p2[2]);
                    const segment = L.polyline([[p1[0], p1[1]], [p2[0], p2[1]]], {
                        color: segmentColor,
                        weight: 3.5,
                        opacity: 0.9,
                        renderer: this.canvasRenderer
                    });
                    this.trailLayerGroup.addLayer(segment);
                }
            }
            this.lastRenderedPointIndex = this.trailPoints.length - 1;

            // 3. Auto-Follow CanSat if Follow Mode enabled
            if (this.followMode) {
                this.isProgrammaticMove = true;
                this.map.panTo([lat, lon], { animate: true, duration: 0.25 });
            }
        }

        // --------------------------------------------------------------------
        // Trail Management
        // --------------------------------------------------------------------

        /**
         * Remove all trail points and clear polyline layers from map.
         */
        clearTrail() {
            this.trailPoints = [];
            this.lastRenderedPointIndex = -1;
            this.minAltitude = Infinity;
            this.maxAltitude = -Infinity;
            this.apogeePoint = null;

            if (this.trailLayerGroup) {
                this.trailLayerGroup.clearLayers();
            }

            if (this.currentLat !== null && this.currentLon !== null && this.currentAlt !== null) {
                this.minAltitude = this.currentAlt;
                this.maxAltitude = this.currentAlt;
                this.trailPoints.push([this.currentLat, this.currentLon, this.currentAlt, Date.now()]);
                this.lastRenderedPointIndex = 0;
            }
        }

        /**
         * Return array of all recorded trail points: [lat, lon, alt, time]
         * @returns {Array<[number, number, number, number]>}
         */
        getTrailPoints() {
            return this.trailPoints.slice();
        }

        /**
         * Decimates older trail points by half when capacity exceeds maxTrailPoints.
         * @private
         */
        _decimateTrail() {
            const preservedEnd = 2000;
            const toDecimateCount = this.trailPoints.length - preservedEnd;
            if (toDecimateCount <= 0) return;

            const decimatedHead = [];
            for (let i = 0; i < toDecimateCount; i += 2) {
                decimatedHead.push(this.trailPoints[i]);
            }

            const preservedTail = this.trailPoints.slice(toDecimateCount);
            this.trailPoints = decimatedHead.concat(preservedTail);

            // Rebuild polyline segments on canvas
            if (this.trailLayerGroup && typeof L !== 'undefined') {
                this.trailLayerGroup.clearLayers();
                for (let i = 0; i < this.trailPoints.length - 1; i++) {
                    const p1 = this.trailPoints[i];
                    const p2 = this.trailPoints[i + 1];
                    const color = this._getAltitudeColor(p2[2]);
                    const segment = L.polyline([[p1[0], p1[1]], [p2[0], p2[1]]], {
                        color: color,
                        weight: 3.5,
                        opacity: 0.9,
                        renderer: this.canvasRenderer
                    });
                    this.trailLayerGroup.addLayer(segment);
                }
                this.lastRenderedPointIndex = this.trailPoints.length - 1;
            }
        }

        // --------------------------------------------------------------------
        // Follow Mode Controls
        // --------------------------------------------------------------------

        /**
         * Toggle Follow Mode on/off.
         * @returns {boolean} New follow mode state
         */
        toggleFollowMode() {
            this.setFollowMode(!this.followMode);
            return this.followMode;
        }

        /**
         * Explicitly set follow mode state.
         * @param {boolean} enabled 
         */
        setFollowMode(enabled) {
            this.followMode = Boolean(enabled);

            // Update UI control button appearance
            if (this.followControl && this.followControl.buttonEl) {
                if (this.followMode) {
                    this.followControl.buttonEl.classList.add('active');
                    this.followControl.labelEl.textContent = 'FOLLOW: ON';
                } else {
                    this.followControl.buttonEl.classList.remove('active');
                    this.followControl.labelEl.textContent = 'FOLLOW: OFF';
                }
            }

            // Immediately center if enabled and coordinates are known
            if (this.followMode && this.currentLat !== null && this.currentLon !== null && this.map) {
                this.isProgrammaticMove = true;
                this.map.panTo([this.currentLat, this.currentLon], { animate: true, duration: 0.4 });
            }
        }

        /**
         * Build the Follow Mode custom Leaflet UI Control.
         * @private
         */
        _initFollowControl() {
            if (typeof L === 'undefined' || !this.map) return;

            const self = this;
            const FollowControl = L.Control.extend({
                options: { position: 'topright' },
                onAdd: function (map) {
                    const container = L.DomUtil.create('div', 'leaflet-bar');
                    const button = L.DomUtil.create('button', 'gcs-map-btn active', container);
                    button.title = 'Toggle Auto-Center Follow Mode';

                    // Target / Crosshairs SVG Icon
                    button.innerHTML = `
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                            <circle cx="12" cy="12" r="7"/>
                            <line x1="12" y1="2" x2="12" y2="5"/>
                            <line x1="12" y1="19" x2="12" y2="22"/>
                            <line x1="2" y1="12" x2="5" y2="12"/>
                            <line x1="19" y1="12" x2="22" y2="12"/>
                        </svg>
                        <span class="btn-label">FOLLOW: ON</span>
                    `;

                    L.DomEvent.disableClickPropagation(container);
                    L.DomEvent.on(button, 'click', function (e) {
                        L.DomEvent.stop(e);
                        self.toggleFollowMode();
                    });

                    self.followControl = {
                        container,
                        buttonEl: button,
                        labelEl: button.querySelector('.btn-label')
                    };

                    return container;
                }
            });

            new FollowControl().addTo(this.map);
        }

        /**
         * Build the Altitude Color Scale Legend Control.
         * @private
         */
        _initLegendControl() {
            if (typeof L === 'undefined' || !this.map) return;

            const LegendControl = L.Control.extend({
                options: { position: 'bottomright' },
                onAdd: (map) => {
                    const div = L.DomUtil.create('div', 'gcs-map-legend');
                    div.innerHTML = `
                        <div style="font-size: 10px; font-weight: 800; letter-spacing: 0.05em; color: #0f172a;">ALTITUDE SPECTRUM</div>
                        <div class="gcs-legend-bar"></div>
                        <div class="gcs-legend-labels">
                            <span>0m (LOW)</span>
                            <span>APOGEE (HIGH)</span>
                        </div>
                    `;
                    L.DomEvent.disableClickPropagation(div);
                    this.legendControl = div;
                    return div;
                }
            });

            new LegendControl().addTo(this.map);
        }

        // --------------------------------------------------------------------
        // Geodesic Distance & Bearing Calculations
        // --------------------------------------------------------------------

        /**
         * Calculate Haversine distance in meters from given coordinates to GCS.
         * @param {number} lat - Latitude
         * @param {number} lon - Longitude
         * @returns {number|null} Distance in meters, or null if GCS not set
         */
        getDistanceToGCS(lat, lon) {
            if (this.gcsLat === null || this.gcsLon === null) return null;
            return this._haversine(this.gcsLat, this.gcsLon, Number(lat), Number(lon));
        }

        /**
         * Calculate bearing in degrees from given coordinates TO GCS.
         * @param {number} lat - CanSat Latitude
         * @param {number} lon - CanSat Longitude
         * @returns {number|null} Bearing in degrees (0 - 360°), or null if GCS not set
         */
        getBearingToGCS(lat, lon) {
            if (this.gcsLat === null || this.gcsLon === null) return null;
            return this._bearing(Number(lat), Number(lon), this.gcsLat, this.gcsLon);
        }

        /**
         * Calculate antenna azimuth bearing from GCS pointing toward CanSat.
         * @param {number} lat - CanSat Latitude
         * @param {number} lon - CanSat Longitude
         * @returns {number|null} Azimuth in degrees (0 - 360°)
         */
        getBearingFromGCS(lat, lon) {
            if (this.gcsLat === null || this.gcsLon === null) return null;
            return this._bearing(this.gcsLat, this.gcsLon, Number(lat), Number(lon));
        }

        // --------------------------------------------------------------------
        // Visual Zones: Landing Prediction, Launch Site, Recovery Area
        // --------------------------------------------------------------------

        /**
         * Display predicted landing zone uncertainty circle with animated target.
         * @param {number} lat - Predicted Latitude
         * @param {number} lon - Predicted Longitude
         * @param {number} [radius=50] - Uncertainty radius in meters
         */
        showLandingPrediction(lat, lon, radius = 50) {
            lat = Number(lat);
            lon = Number(lon);
            radius = Number(radius) || 50;

            if (!this.map || typeof L === 'undefined' || isNaN(lat) || isNaN(lon)) return;

            this.landingPredictionLayerGroup.clearLayers();

            // Landing Uncertainty Circle
            const circle = L.circle([lat, lon], {
                radius: radius,
                color: '#dc2626',
                weight: 2,
                dashArray: '6, 6',
                fillColor: '#ef4444',
                fillOpacity: 0.22,
                renderer: this.canvasRenderer
            });

            // Target Crosshair Center Marker
            const targetIconHtml = `
                <div class="landing-target-marker" title="Predicted Landing Center">
                    <div class="landing-target-inner"></div>
                </div>
            `;
            const targetIcon = L.divIcon({
                className: 'custom-target-marker',
                html: targetIconHtml,
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            });

            const marker = L.marker([lat, lon], { icon: targetIcon });
            marker.bindPopup(`
                <div style="font-family: system-ui, sans-serif; font-size: 12px; color: #0f172a;">
                    <strong style="color: #dc2626; font-size: 13px;">Predicted Landing Site</strong><br/>
                    <b>Coordinates:</b> ${lat.toFixed(5)}°, ${lon.toFixed(5)}°<br/>
                    <b>Uncertainty Radius:</b> ±${radius.toFixed(0)} m
                </div>
            `);

            this.landingPredictionLayerGroup.addLayer(circle);
            this.landingPredictionLayerGroup.addLayer(marker);
        }

        /**
         * Clear predicted landing zone visualizations.
         */
        clearLandingPrediction() {
            if (this.landingPredictionLayerGroup) {
                this.landingPredictionLayerGroup.clearLayers();
            }
        }

        /**
         * Add Launch Site boundary and rocket launch pad marker.
         * @param {number} lat - Launch Pad Latitude
         * @param {number} lon - Launch Pad Longitude
         * @param {number} [radiusMeters=100] - Safety perimeter in meters
         */
        addLaunchSiteCircle(lat, lon, radiusMeters = 100) {
            lat = Number(lat);
            lon = Number(lon);
            radiusMeters = Number(radiusMeters) || 100;

            if (!this.map || typeof L === 'undefined' || isNaN(lat) || isNaN(lon)) return;

            this.launchSiteLayerGroup.clearLayers();

            // Safety exclusion zone perimeter
            const circle = L.circle([lat, lon], {
                radius: radiusMeters,
                color: '#475569',
                weight: 2,
                dashArray: '5, 5',
                fillColor: '#64748b',
                fillOpacity: 0.12,
                renderer: this.canvasRenderer
            });

            // Launch pad icon marker
            const launchPadIconHtml = `
                <div style="width: 32px; height: 32px; background: #ffffff; border: 2.5px solid #0f172a; border-radius: 50%; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#0f172a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
                        <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
                        <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
                        <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
                    </svg>
                </div>
            `;
            const launchIcon = L.divIcon({
                className: 'custom-launch-marker',
                html: launchPadIconHtml,
                iconSize: [32, 32],
                iconAnchor: [16, 16]
            });

            const marker = L.marker([lat, lon], { icon: launchIcon });
            marker.bindPopup(`
                <div style="font-family: system-ui, sans-serif; font-size: 12px; color: #0f172a;">
                    <strong style="color: #0f172a; font-size: 13px;">Launch Site Pad</strong><br/>
                    <b>Position:</b> ${lat.toFixed(5)}°, ${lon.toFixed(5)}°<br/>
                    <b>Safety Perimeter:</b> ${radiusMeters} m
                </div>
            `);

            this.launchSiteLayerGroup.addLayer(circle);
            this.launchSiteLayerGroup.addLayer(marker);
        }

        /**
         * Highlight Recovery Search & Rescue Area.
         * @param {number} lat - Recovery Zone Latitude
         * @param {number} lon - Recovery Zone Longitude
         * @param {number} [radius=250] - Perimeter in meters
         */
        showRecoveryZone(lat, lon, radius = 250) {
            lat = Number(lat);
            lon = Number(lon);
            radius = Number(radius) || 250;

            if (!this.map || typeof L === 'undefined' || isNaN(lat) || isNaN(lon)) return;

            this.recoveryZoneLayerGroup.clearLayers();

            const circle = L.circle([lat, lon], {
                radius: radius,
                color: '#10b981',
                weight: 2,
                dashArray: '4, 4',
                fillColor: '#10b981',
                fillOpacity: 0.16,
                renderer: this.canvasRenderer
            });

            circle.bindPopup(`
                <div style="font-family: system-ui, sans-serif; font-size: 12px; color: #0f172a;">
                    <strong style="color: #10b981; font-size: 13px;">Recovery Zone Perimeter</strong><br/>
                    <b>Center:</b> ${lat.toFixed(5)}°, ${lon.toFixed(5)}°<br/>
                    <b>Perimeter Radius:</b> ${radius} m
                </div>
            `);

            this.recoveryZoneLayerGroup.addLayer(circle);
        }

        /**
         * Clear recovery area highlights.
         */
        clearRecoveryZone() {
            if (this.recoveryZoneLayerGroup) {
                this.recoveryZoneLayerGroup.clearLayers();
            }
        }

        /**
         * Fit map view to encompass all active flight elements (Trail, GCS, Launch Pad).
         */
        fitBounds() {
            if (!this.map || typeof L === 'undefined') return;

            const bounds = L.latLngBounds([]);

            if (this.gcsLat !== null && this.gcsLon !== null) {
                bounds.extend([this.gcsLat, this.gcsLon]);
            }
            if (this.currentLat !== null && this.currentLon !== null) {
                bounds.extend([this.currentLat, this.currentLon]);
            }
            this.trailPoints.forEach(p => bounds.extend([p[0], p[1]]));

            if (bounds.isValid()) {
                this.isProgrammaticMove = true;
                this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 17 });
            }
        }

        // --------------------------------------------------------------------
        // Export Methods: KML 2.2 & GeoJSON
        // --------------------------------------------------------------------

        /**
         * Generate valid 3D KML string for Google Earth / GIS analysis.
         * Includes LineString trajectory with absolute altitude and placemarks for
         * Launch Site, Apogee, Current/Landing, and Ground Station.
         * @returns {string} KML XML document string
         */
        getTrailAsKML() {
            const escapeXml = (unsafe) => {
                return String(unsafe).replace(/[<>&'"]/g, (c) => {
                    switch (c) {
                        case '<': return '&lt;';
                        case '>': return '&gt;';
                        case '&': return '&amp;';
                        case '\'': return '&apos;';
                        case '"': return '&quot;';
                    }
                });
            };

            const flightPathCoords = this.trailPoints
                .map(p => `${p[1].toFixed(6)},${p[0].toFixed(6)},${p[2].toFixed(1)}`)
                .join('\n            ');

            const launchPoint = this.trailPoints.length > 0 ? this.trailPoints[0] : null;
            const currentPoint = this.trailPoints.length > 0 ? this.trailPoints[this.trailPoints.length - 1] : null;
            const apogee = this.apogeePoint;

            let placemarksXml = '';

            // 1. GCS Placemark
            if (this.gcsLat !== null && this.gcsLon !== null) {
                placemarksXml += `
        <Placemark>
            <name>Ground Control Station (GCS)</name>
            <description>LPDA Antenna Heading: ${this.antennaHeading.toFixed(1)}°</description>
            <styleUrl>#gcsStyle</styleUrl>
            <Point>
                <coordinates>${this.gcsLon.toFixed(6)},${this.gcsLat.toFixed(6)},0</coordinates>
            </Point>
        </Placemark>`;
            }

            // 2. Launch Site Placemark
            if (launchPoint) {
                placemarksXml += `
        <Placemark>
            <name>Launch Site</name>
            <description>Time: ${new Date(launchPoint[3]).toISOString()} | Alt: ${launchPoint[2].toFixed(1)}m</description>
            <styleUrl>#launchStyle</styleUrl>
            <Point>
                <altitudeMode>absolute</altitudeMode>
                <coordinates>${launchPoint[1].toFixed(6)},${launchPoint[0].toFixed(6)},${launchPoint[2].toFixed(1)}</coordinates>
            </Point>
        </Placemark>`;
            }

            // 3. Apogee Placemark
            if (apogee) {
                placemarksXml += `
        <Placemark>
            <name>Apogee (Peak Altitude)</name>
            <description>Max Altitude: ${apogee.alt.toFixed(1)}m | Time: ${new Date(apogee.timestamp).toISOString()}</description>
            <styleUrl>#apogeeStyle</styleUrl>
            <Point>
                <altitudeMode>absolute</altitudeMode>
                <coordinates>${apogee.lon.toFixed(6)},${apogee.lat.toFixed(6)},${apogee.alt.toFixed(1)}</coordinates>
            </Point>
        </Placemark>`;
            }

            // 4. Current / Landing Placemark
            if (currentPoint && currentPoint !== launchPoint) {
                placemarksXml += `
        <Placemark>
            <name>Final / Current Position</name>
            <description>Altitude: ${currentPoint[2].toFixed(1)}m | State: ${escapeXml(this.currentState)}</description>
            <styleUrl>#landingStyle</styleUrl>
            <Point>
                <altitudeMode>absolute</altitudeMode>
                <coordinates>${currentPoint[1].toFixed(6)},${currentPoint[0].toFixed(6)},${currentPoint[2].toFixed(1)}</coordinates>
            </Point>
        </Placemark>`;
            }

            return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
    <Document>
        <name>CanSat Flight Path Telemetry</name>
        <description>Ground Control Station Recorded Mission Trajectory</description>
        
        <Style id="flightPathStyle">
            <LineStyle>
                <color>ffff6600</color> <!-- KML aabbggrr: vivid blue line -->
                <width>4</width>
            </LineStyle>
            <PolyStyle>
                <color>44ff6600</color>
            </PolyStyle>
        </Style>

        <Style id="launchStyle">
            <IconStyle>
                <scale>1.2</scale>
                <Icon><href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href></Icon>
            </IconStyle>
        </Style>

        <Style id="apogeeStyle">
            <IconStyle>
                <scale>1.4</scale>
                <Icon><href>http://maps.google.com/mapfiles/kml/shapes/star.png</href></Icon>
            </IconStyle>
        </Style>

        <Style id="landingStyle">
            <IconStyle>
                <scale>1.3</scale>
                <Icon><href>http://maps.google.com/mapfiles/kml/shapes/target.png</href></Icon>
            </IconStyle>
        </Style>

        <Style id="gcsStyle">
            <IconStyle>
                <scale>1.2</scale>
                <Icon><href>http://maps.google.com/mapfiles/kml/shapes/triangle.png</href></Icon>
            </IconStyle>
        </Style>

        ${placemarksXml}

        <!-- 3D Flight Trajectory LineString -->
        <Placemark>
            <name>3D Flight Trajectory</name>
            <description>CanSat Telemetry Trail (${this.trailPoints.length} points)</description>
            <styleUrl>#flightPathStyle</styleUrl>
            <LineString>
                <extrude>1</extrude>
                <tessellate>1</tessellate>
                <altitudeMode>absolute</altitudeMode>
                <coordinates>
            ${flightPathCoords}
                </coordinates>
            </LineString>
        </Placemark>
    </Document>
</kml>`;
        }

        /**
         * Return GeoJSON FeatureCollection of flight path with 3D coordinates and metadata.
         * @returns {Object} GeoJSON FeatureCollection object
         */
        getTrailAsGeoJSON() {
            const coordinates3D = this.trailPoints.map(p => [
                Number(p[1].toFixed(6)), // lon
                Number(p[0].toFixed(6)), // lat
                Number(p[2].toFixed(1))  // alt
            ]);

            const features = [
                {
                    type: 'Feature',
                    geometry: {
                        type: 'LineString',
                        coordinates: coordinates3D
                    },
                    properties: {
                        name: 'CanSat Flight Path Trajectory',
                        totalPoints: this.trailPoints.length,
                        minAltitudeMeters: isFinite(this.minAltitude) ? this.minAltitude : 0,
                        maxAltitudeMeters: isFinite(this.maxAltitude) ? this.maxAltitude : 0,
                        currentState: this.currentState,
                        startTime: this.trailPoints.length > 0 ? new Date(this.trailPoints[0][3]).toISOString() : null,
                        endTime: this.trailPoints.length > 0 ? new Date(this.trailPoints[this.trailPoints.length - 1][3]).toISOString() : null
                    }
                }
            ];

            // Add GCS point feature
            if (this.gcsLat !== null && this.gcsLon !== null) {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [this.gcsLon, this.gcsLat, 0]
                    },
                    properties: {
                        name: 'Ground Control Station (GCS)',
                        antennaHeadingDeg: this.antennaHeading,
                        beamwidthDeg: this.options.antennaBeamwidthDeg
                    }
                });
            }

            // Add Apogee feature
            if (this.apogeePoint) {
                features.push({
                    type: 'Feature',
                    geometry: {
                        type: 'Point',
                        coordinates: [this.apogeePoint.lon, this.apogeePoint.lat, this.apogeePoint.alt]
                    },
                    properties: {
                        name: 'Flight Apogee',
                        altitudeMeters: this.apogeePoint.alt,
                        timestamp: new Date(this.apogeePoint.timestamp).toISOString()
                    }
                });
            }

            return {
                type: 'FeatureCollection',
                metadata: {
                    generatedAt: new Date().toISOString(),
                    system: 'CanSat Ground Control Station'
                },
                features: features
            };
        }

        // --------------------------------------------------------------------
        // Cleanup & Destruction
        // --------------------------------------------------------------------

        /**
         * Clean up all map resources, listeners, timers, and DOM layers.
         */
        destroy() {
            if (this.throttleTimer) {
                clearTimeout(this.throttleTimer);
                this.throttleTimer = null;
            }

            if (this.map) {
                this.map.off();
                this.map.remove();
                this.map = null;
            }

            this.canSatMarker = null;
            this.gcsMarker = null;
            this.antennaConePolygon = null;
            this.antennaBoresightLine = null;
            this.launchSiteLayerGroup = null;
            this.landingPredictionLayerGroup = null;
            this.recoveryZoneLayerGroup = null;
            this.trailLayerGroup = null;
            this.trailPoints = [];
            this.lastRenderedPointIndex = -1;
        }

        // --------------------------------------------------------------------
        // Mathematical & Aesthetic Utility Helpers
        // --------------------------------------------------------------------

        /**
         * Calculate antenna directional beam cone polygon vertices.
         * @private
         */
        _calculateAntennaConeCoords(centerLat, centerLon, headingDeg, beamwidthDeg, rangeMeters) {
            const coords = [[centerLat, centerLon]];
            const halfBeam = beamwidthDeg / 2;
            const startAngle = headingDeg - halfBeam;
            const endAngle = headingDeg + halfBeam;
            const stepDeg = 1.5; // Smooth arc resolution

            for (let a = startAngle; a <= endAngle; a += stepDeg) {
                coords.push(this._destinationPoint(centerLat, centerLon, rangeMeters, a));
            }

            coords.push(this._destinationPoint(centerLat, centerLon, rangeMeters, endAngle));
            coords.push([centerLat, centerLon]); // Close polygon loop

            return coords;
        }

        /**
         * Forward Geodesic Projection: Compute destination point given start, distance, and bearing.
         * @private
         */
        _destinationPoint(lat, lon, distanceMeters, bearingDeg) {
            const R = 6371000; // Mean Earth radius in meters
            const delta = distanceMeters / R;
            const theta = (bearingDeg * Math.PI) / 180;
            const phi1 = (lat * Math.PI) / 180;
            const lambda1 = (lon * Math.PI) / 180;

            const sinPhi1 = Math.sin(phi1);
            const cosPhi1 = Math.cos(phi1);
            const sinDelta = Math.sin(delta);
            const cosDelta = Math.cos(delta);

            const phi2 = Math.asin(sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta));
            const lambda2 = lambda1 + Math.atan2(
                Math.sin(theta) * sinDelta * cosPhi1,
                cosDelta - sinPhi1 * Math.sin(phi2)
            );

            return [(phi2 * 180) / Math.PI, (lambda2 * 180) / Math.PI];
        }

        /**
         * Haversine formula for great-circle distance between two coordinates in meters.
         * @private
         */
        _haversine(lat1, lon1, lat2, lon2) {
            const R = 6371000;
            const toRad = deg => (deg * Math.PI) / 180;
            const phi1 = toRad(lat1);
            const phi2 = toRad(lat2);
            const dPhi = toRad(lat2 - lat1);
            const dLambda = toRad(lon2 - lon1);

            const a = Math.sin(dPhi / 2) * Math.sin(dPhi / 2) +
                      Math.cos(phi1) * Math.cos(phi2) *
                      Math.sin(dLambda / 2) * Math.sin(dLambda / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

            return R * c;
        }

        /**
         * Initial bearing (forward azimuth) from coordinate 1 to coordinate 2 in degrees.
         * @private
         */
        _bearing(lat1, lon1, lat2, lon2) {
            const toRad = deg => (deg * Math.PI) / 180;
            const toDeg = rad => (rad * 180) / Math.PI;

            const phi1 = toRad(lat1);
            const phi2 = toRad(lat2);
            const dLambda = toRad(lon2 - lon1);

            const y = Math.sin(dLambda) * Math.cos(phi2);
            const x = Math.cos(phi1) * Math.sin(phi2) -
                      Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);

            const brg = toDeg(Math.atan2(y, x));
            return (brg + 360) % 360;
        }

        /**
         * Altitude color gradient mapping:
         * Low altitude = Red (0° hue) -> Mid = Yellow/Green -> High altitude = Blue (220° hue)
         * @private
         */
        _getAltitudeColor(alt) {
            const min = isFinite(this.minAltitude) ? this.minAltitude : 0;
            const max = (isFinite(this.maxAltitude) && this.maxAltitude > min) ? this.maxAltitude : (min + 500);
            const range = Math.max(50, max - min);
            const t = Math.max(0, Math.min(1, (alt - min) / range));

            // Map t [0..1] to Hue [0 (Red) -> 220 (Aerospace Royal Blue)]
            const hue = Math.round(t * 220);
            return `hsl(${hue}, 92%, 46%)`;
        }

        /**
         * Color scheme based on CanSat mission flight state.
         * @private
         */
        _getStateColor(state) {
            const s = String(state).toUpperCase();
            if (s.includes('PAD') || s.includes('IDLE') || s.includes('INIT')) return '#64748b'; // Slate
            if (s.includes('BOOST') || s.includes('ASCENT') || s.includes('POWERED')) return '#f59e0b'; // Amber
            if (s.includes('APOGEE')) return '#9333ea'; // Purple
            if (s.includes('DROGUE') || s.includes('DESCENT')) return '#0ea5e9'; // Sky
            if (s.includes('PARACHUTE') || s.includes('MAIN')) return '#2563eb'; // Blue
            if (s.includes('LAND') || s.includes('TOUCHDOWN')) return '#10b981'; // Emerald
            if (s.includes('ABORT') || s.includes('WARN') || s.includes('FAIL')) return '#dc2626'; // Red
            return '#2563eb'; // Default royal blue
        }
    }

    // Export module globally and to CommonJS if applicable
    if (typeof window !== 'undefined') {
        window.MapManager = MapManager;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = MapManager;
    }
})();
