/**
 * ============================================================================
 * INSPACE CANSAT GROUND CONTROL STATION (GCS)
 * TELEMETRY PARSING AND DATA MANAGEMENT ENGINE
 * ============================================================================
 * 
 * Target Hardware: STM32F411CEU6 BlackPill Flight Controller + LoRa SX1278
 * Packet Protocol: $CANSAT,<seq_id>,<timestamp_ms>,<alt>,<pressure>,<temperature>,
 *                  <roll>,<pitch>,<yaw>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>,
 *                  <mx>,<my>,<mz>,<lat>,<lon>,<gps_alt>,<sat_count>,<hdop>,
 *                  <fix_type>,<voltage>,<current>,<power>,<bus_voltage>,
 *                  <rssi>,<snr>,<lqi>
 * 
 * Architecture & Features:
 *  - High-performance, zero-allocation RingBuffer (O(1) push, capped at 36,000 entries)
 *  - Web Serial API with Web Streams and text line decoding
 *  - WebSocket bridge fallback with automatic 3-retry exponential backoff
 *  - Sequence and packet-format health monitoring
 *  - 5-point Savitzky-Golay / least-squares vertical speed estimator (dAlt/dt)
 *  - Barometric altitude calculation with hypsometric temperature compensation
 *  - Haversine geodesic distance and 3D slant range from GCS coordinates
 *  - Ballistic energy conservation apogee prediction
 *  - Finite State Machine auto-detecting 7 flight phases (Pre-flight to Touchdown)
 *  - Telemetry link health diagnostics and >15% packet loss breach detector
 *  - Baseline pressure calibration (50-sample moving average)
 *  - Full CSV export and Google Earth KML 2.2 trajectory generation
 *  - Built-in realistic flight profile simulator for hardware-less testing
 * 
 * Standards Compliance:
 *  - High-rate 10-20 Hz sustained ingestion without GC memory leaks
 *  - Browser window & CommonJS dual export
 * ============================================================================
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const exports = factory();
        root.TelemetryEngine = exports.TelemetryEngine;
        root.RingBuffer = exports.RingBuffer;
        root.FLIGHT_STATES = exports.FLIGHT_STATES;
    }
}(typeof self !== 'undefined' ? self : this, function () {

    'use strict';

    /**
     * Standardized CanSat Flight States
     */
    const FLIGHT_STATES = Object.freeze({
        PRE_FLIGHT: 'PRE_FLIGHT',
        LAUNCH_PAD: 'LAUNCH_PAD',
        POWERED_ASCENT: 'POWERED_ASCENT',
        APOGEE: 'APOGEE',
        DROGUE_DESCENT: 'DROGUE_DESCENT',
        MAIN_DESCENT: 'MAIN_DESCENT',
        TOUCHDOWN: 'TOUCHDOWN'
    });

    /**
     * Physical & Aerodynamic Constants
     */
    const CONSTANTS = Object.freeze({
        STANDARD_SEA_LEVEL_PRESSURE: 1013.25, // hPa
        STANDARD_LAPSE_RATE: 0.0065,          // K/m
        STANDARD_SEA_LEVEL_TEMP_K: 288.15,    // 15 °C in Kelvin
        GAS_CONSTANT_AIR: 287.05,             // J/(kg*K)
        STANDARD_GRAVITY: 9.80665,            // m/s^2
        EARTH_RADIUS_METERS: 6371000.0,       // Mean Earth radius in meters
        BARO_EXPONENT: 0.19022256,            // (R * L) / (g * M)
        MAX_DEFAULT_CAPACITY: 36000           // 1 hour at 10Hz
    });

    // ========================================================================
    // RING BUFFER IMPLEMENTATION
    // ========================================================================

    /**
     * High-performance circular buffer with fixed memory allocation.
     * Prevents browser memory leaks during high-rate telemetry logging.
     */
    class RingBuffer {
        /**
         * @param {number} capacity Maximum number of elements to retain
         */
        constructor(capacity = CONSTANTS.MAX_DEFAULT_CAPACITY) {
            const cap = Math.floor(capacity);
            if (cap <= 0 || !Number.isFinite(cap)) {
                throw new Error(`Invalid RingBuffer capacity: ${capacity}. Must be a positive integer.`);
            }
            this.capacity = cap;
            this.buffer = new Array(cap);
            this.head = 0;   // Index where next push will be written
            this.count = 0;  // Current number of valid elements stored
        }

        /**
         * Insert a new element into the ring buffer.
         * If buffer is at capacity, the oldest element is overwritten in O(1) time.
         * @param {*} value Element to store
         */
        push(value) {
            this.buffer[this.head] = value;
            this.head = (this.head + 1) % this.capacity;
            if (this.count < this.capacity) {
                this.count++;
            }
        }

        /**
         * Number of elements currently in the buffer
         * @returns {number}
         */
        get length() {
            return this.count;
        }

        /**
         * Get the most recently pushed element.
         * @returns {*|undefined}
         */
        get last() {
            if (this.count === 0) return undefined;
            const lastIdx = (this.head - 1 + this.capacity) % this.capacity;
            return this.buffer[lastIdx];
        }

        /**
         * Retrieve element by index.
         * Supports both positive index (0 = oldest, count-1 = newest)
         * and negative index (-1 = newest, -count = oldest).
         * @param {number} index
         * @returns {*|undefined}
         */
        get(index) {
            if (this.count === 0 || !Number.isInteger(index)) return undefined;

            let actualIndex = index;
            if (index < 0) {
                actualIndex = this.count + index;
            }

            if (actualIndex < 0 || actualIndex >= this.count) {
                return undefined;
            }

            const physicalIndex = (this.head - this.count + this.capacity + actualIndex) % this.capacity;
            return this.buffer[physicalIndex];
        }

        /**
         * Return a fresh array containing all items in chronological order.
         * @returns {Array}
         */
        toArray() {
            const result = new Array(this.count);
            const startPhysical = (this.head - this.count + this.capacity) % this.capacity;
            for (let i = 0; i < this.count; i++) {
                result[i] = this.buffer[(startPhysical + i) % this.capacity];
            }
            return result;
        }

        /**
         * Extract a shallow slice of items in chronological order.
         * Matches Array.prototype.slice semantics with negative indices support.
         * @param {number} [start=0]
         * @param {number} [end]
         * @returns {Array}
         */
        slice(start = 0, end = this.count) {
            if (this.count === 0) return [];

            let s = start < 0 ? Math.max(0, this.count + start) : Math.min(this.count, start);
            let e = end < 0 ? Math.max(0, this.count + end) : Math.min(this.count, end);

            if (s >= e) return [];

            const len = e - s;
            const result = new Array(len);
            const physicalStart = (this.head - this.count + this.capacity) % this.capacity;

            for (let i = 0; i < len; i++) {
                result[i] = this.buffer[(physicalStart + s + i) % this.capacity];
            }
            return result;
        }

        /**
         * Reset the buffer to empty state without reallocating underlying memory.
         */
        clear() {
            this.buffer.fill(undefined);
            this.head = 0;
            this.count = 0;
        }
    }

    // ========================================================================
    // TELEMETRY ENGINE CORE
    // ========================================================================

    /**
     * Production-grade Telemetry Engine for Aerospace CanSat GCS.
     */
    class TelemetryEngine {
        /**
         * @param {Object} [options={}] Configuration options
         * @param {number} [options.capacity=36000] Capacity of the ring buffer
         * @param {number} [options.gcsLat=0.0] Ground Control Station latitude (deg)
         * @param {number} [options.gcsLon=0.0] Ground Control Station longitude (deg)
         * @param {number} [options.gcsAlt=0.0] Ground Control Station elevation AMSL (m)
         * @param {number} [options.baselinePressure=null] Starting baseline pressure (hPa)
         */
        constructor(options = {}) {
            this.options = Object.assign({
                capacity: CONSTANTS.MAX_DEFAULT_CAPACITY,
                gcsLat: 0.0,
                gcsLon: 0.0,
                gcsAlt: 0.0,
                baselinePressure: null,
                maxReconnectAttempts: 3,
                baseReconnectDelayMs: 1000
            }, options);

            // Ring buffer primary store
            this.records = new RingBuffer(this.options.capacity);

            // GCS Coordinates
            this.gcsCoordinates = {
                lat: this.options.gcsLat,
                lon: this.options.gcsLon,
                alt: this.options.gcsAlt
            };

            // Calibration & Barometric State
            this.baselinePressure = this.options.baselinePressure;
            this.altitudeOffset = 0.0;
            this.calibrationActive = false;
            this.calibrationTarget = 50;
            this.calibrationSamples = [];
            this.calibrationResolve = null;

            // Connection State
            this.isConnected = false;
            this.connectionType = null; // 'serial' | 'websocket' | 'simulator'
            this.serialPort = null;
            this.serialReader = null;
            this.ws = null;
            this.wsUrl = null;
            this.baudRate = 115200;
            this.isIntentionalDisconnect = false;
            this.reconnectAttempts = 0;
            this.reconnectTimer = null;

            // Flight State Machine
            this.flightState = FLIGHT_STATES.PRE_FLIGHT;
            this.maxAltitude = 0.0;
            this.launchPadTimestamp = null;
            this.touchdownStabilityCounter = 0;
            this.previousVz = 0.0;
            this.isArmed = false;

            // Packet Health & Loss Tracking
            this.firstSeqId = null;
            this.lastSeqId = null;
            this.totalPacketsReceived = 0;
            this.totalPacketsExpected = 0;
            this.totalPacketsLost = 0;
            this.lastPacketTimestampMs = null;
            this.lastPacketWallClock = null;

            // Rolling window for real-time loss tracking (last 5 seconds)
            this.rollingPackets = []; // Array of { time: wallClock, seq: seqId }
            this.highLossStartTime = null;

            // Testing & Transmission Instrumentation
            this.totalBytesIngested = 0;
            this.malformedPacketsCount = 0;
            this.interArrivalDeltas = []; // rolling last 100 intervals (ms)
            this.lastArrivalTimestamp = null;
            this.byteRateWindow = []; // { time, bytes }

            // Event listener registry
            this.listeners = new Map();

            // Simulation state
            this.simulationInterval = null;
            this.simulationTick = 0;
        }

        // ====================================================================
        // EVENT SYSTEM
        // ====================================================================

        /**
         * Subscribe an event listener.
         * Supported events: 'data', 'stateChange', 'warning', 'connectionChange', 'error', 'calibration'
         * @param {string} event
         * @param {Function} callback
         */
        on(event, callback) {
            if (typeof callback !== 'function') {
                throw new TypeError('Event callback must be a function');
            }
            if (!this.listeners.has(event)) {
                this.listeners.set(event, new Set());
            }
            this.listeners.get(event).add(callback);
            return this;
        }

        /**
         * Unsubscribe an event listener.
         * @param {string} event
         * @param {Function} callback
         */
        off(event, callback) {
            if (this.listeners.has(event)) {
                this.listeners.get(event).delete(callback);
            }
            return this;
        }

        /**
         * Subscribe a one-time event listener.
         * @param {string} event
         * @param {Function} callback
         */
        once(event, callback) {
            const wrapper = (...args) => {
                this.off(event, wrapper);
                callback.apply(this, args);
            };
            return this.on(event, wrapper);
        }

        /**
         * Emit an event to all registered listeners.
         * @param {string} event
         * @param {*} data
         */
        emit(event, data) {
            if (this.listeners.has(event)) {
                for (const callback of this.listeners.get(event)) {
                    try {
                        callback(data);
                    } catch (err) {
                        console.error(`Error in TelemetryEngine event listener for '${event}':`, err);
                    }
                }
            }
            return this;
        }

        // ====================================================================
        // CONNECTION MANAGEMENT
        // ====================================================================

        /**
         * Connect to CanSat telemetry stream via Web Serial API.
         * Handles native Web Streams, text decoding, and automatic buffer line breaking.
         * @param {number} [baudRate=115200]
         * @returns {Promise<boolean>}
         */
        async connectSerial(baudRate = 115200) {
            if (typeof navigator === 'undefined' || !('serial' in navigator)) {
                const errMsg = 'Web Serial API is not supported in this browser. Please use Google Chrome, MS Edge, or a WebSocket bridge.';
                this.emit('error', { type: 'SERIAL_UNSUPPORTED', message: errMsg });
                throw new Error(errMsg);
            }

            this.isIntentionalDisconnect = false;
            this.baudRate = baudRate;

            try {
                // Request port selection if not already held
                this.serialPort = await navigator.serial.requestPort();
                await this.serialPort.open({ baudRate: this.baudRate });

                this.serialReader = this.serialPort.readable.getReader();
                this.isConnected = true;
                this.connectionType = 'serial';
                this.reconnectAttempts = 0;

                this.emit('connectionChange', {
                    type: 'serial',
                    status: 'connected',
                    baudRate: this.baudRate
                });

                // Start asynchronous stream reader
                this._readSerialStream();
                return true;
            } catch (err) {
                this.isConnected = false;
                this.connectionType = null;
                this.emit('error', { type: 'SERIAL_CONNECT_FAILED', error: err });
                throw err;
            }
        }

        /**
         * Background loop consuming Web Serial stream.
         * @private
         */
        async _readSerialStream() {
            const decoder = new TextDecoder();
            let lineBuffer = '';

            try {
                while (this.isConnected && this.serialReader) {
                    const { value, done } = await this.serialReader.read();
                    if (done) {
                        break;
                    }
                    if (value) {
                        lineBuffer += decoder.decode(value, { stream: true });
                        let newlineIdx;
                        while ((newlineIdx = lineBuffer.indexOf('\n')) >= 0) {
                            const rawLine = lineBuffer.slice(0, newlineIdx).trim();
                            lineBuffer = lineBuffer.slice(newlineIdx + 1);
                            if (rawLine.length > 0) {
                                this.handleRawLine(rawLine);
                            }
                        }
                    }
                }
            } catch (err) {
                if (!this.isIntentionalDisconnect) {
                    this.emit('error', { type: 'SERIAL_STREAM_ERROR', error: err });
                    this._handleConnectionLoss('serial', this.baudRate);
                }
            } finally {
                this._cleanupSerialResources();
            }
        }

        /**
         * Safely release Web Serial reader and lock.
         * @private
         */
        async _cleanupSerialResources() {
            if (this.serialReader) {
                try {
                    await this.serialReader.cancel();
                } catch (e) { /* ignore stream cancel errors */ }
                try {
                    this.serialReader.releaseLock();
                } catch (e) { /* ignore lock errors */ }
                this.serialReader = null;
            }
            if (this.serialPort) {
                try {
                    await this.serialPort.close();
                } catch (e) { /* ignore port close errors */ }
                this.serialPort = null;
            }
        }

        /**
         * Connect via WebSocket bridge fallback (e.g., node-serialport bridge or GCS relay).
         * @param {string} url WebSocket endpoint (e.g. 'ws://localhost:8080')
         * @returns {Promise<boolean>}
         */
        async connectWebSocket(url) {
            if (!url || typeof url !== 'string') {
                throw new Error('Valid WebSocket URL string is required');
            }

            this.isIntentionalDisconnect = false;
            this.wsUrl = url;

            return new Promise((resolve, reject) => {
                try {
                    this.ws = new WebSocket(url);

                    this.ws.onopen = () => {
                        this.isConnected = true;
                        this.connectionType = 'websocket';
                        this.reconnectAttempts = 0;
                        this.emit('connectionChange', {
                            type: 'websocket',
                            status: 'connected',
                            url: this.wsUrl
                        });
                        resolve(true);
                    };

                    this.ws.onmessage = (event) => {
                        const data = event.data;
                        if (typeof data === 'string') {
                            const lines = data.split(/\r?\n/);
                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (trimmed.length > 0) {
                                    this.handleRawLine(trimmed);
                                }
                            }
                        }
                    };

                    this.ws.onerror = (err) => {
                        this.emit('error', { type: 'WEBSOCKET_ERROR', error: err });
                        if (!this.isConnected) {
                            reject(err);
                        }
                    };

                    this.ws.onclose = () => {
                        const wasConnected = this.isConnected;
                        this.isConnected = false;
                        if (wasConnected && !this.isIntentionalDisconnect) {
                            this._handleConnectionLoss('websocket', this.wsUrl);
                        }
                    };
                } catch (err) {
                    this.isConnected = false;
                    reject(err);
                }
            });
        }

        /**
         * Cleanly disconnect active Serial, WebSocket, or Simulator connections.
         */
        async disconnect() {
            this.isIntentionalDisconnect = true;
            this._clearReconnectTimer();
            this.stopSimulation();

            const previousType = this.connectionType;

            if (this.connectionType === 'serial') {
                await this._cleanupSerialResources();
            } else if (this.connectionType === 'websocket') {
                if (this.ws) {
                    try {
                        this.ws.close();
                    } catch (e) { /* ignore */ }
                    this.ws = null;
                }
            }

            this.isConnected = false;
            this.connectionType = null;

            this.emit('connectionChange', {
                type: previousType,
                status: 'disconnected'
            });
        }

        /**
         * Handle unexpected connection loss with 3-retry exponential backoff.
         * @private
         */
        _handleConnectionLoss(type, config) {
            if (this.isIntentionalDisconnect) return;

            this.isConnected = false;
            this.emit('connectionChange', { type, status: 'lost' });

            if (this.reconnectAttempts < this.options.maxReconnectAttempts) {
                this.reconnectAttempts++;
                const delay = this.options.baseReconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

                this.emit('warning', {
                    type: 'RECONNECTING',
                    message: `Connection lost. Retrying ${type} (${this.reconnectAttempts}/${this.options.maxReconnectAttempts}) in ${delay}ms...`,
                    attempt: this.reconnectAttempts,
                    maxAttempts: this.options.maxReconnectAttempts,
                    delayMs: delay
                });

                this._clearReconnectTimer();
                this.reconnectTimer = setTimeout(async () => {
                    try {
                        if (type === 'websocket') {
                            await this.connectWebSocket(config);
                        } else if (type === 'serial') {
                            if (typeof navigator !== 'undefined' && 'serial' in navigator) {
                                const ports = await navigator.serial.getPorts();
                                if (ports.length > 0) {
                                    this.serialPort = ports[0];
                                    await this.serialPort.open({ baudRate: config });
                                    this.serialReader = this.serialPort.readable.getReader();
                                    this.isConnected = true;
                                    this.connectionType = 'serial';
                                    this.reconnectAttempts = 0;
                                    this.emit('connectionChange', {
                                        type: 'serial',
                                        status: 'connected',
                                        baudRate: config
                                    });
                                    this._readSerialStream();
                                }
                            }
                        }
                    } catch (retryErr) {
                        this._handleConnectionLoss(type, config);
                    }
                }, delay);
            } else {
                this.emit('warning', {
                    type: 'RECONNECT_FAILED',
                    message: `Telemetry link reconnection failed after ${this.options.maxReconnectAttempts} attempts.`
                });
                this.emit('connectionChange', { type, status: 'failed' });
            }
        }

        /**
         * @private
         */
        _clearReconnectTimer() {
            if (this.reconnectTimer) {
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = null;
            }
        }

        // ====================================================================
        // PACKET PARSING & VERIFICATION
        // ====================================================================

        /**
         * Ingest a raw line, parse, compute metrics, and push to store.
         * @param {string} rawLine
         * @returns {Object|null} Parsed packet or null if malformed
         */
        handleRawLine(rawLine) {
            const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            if (this.lastArrivalTimestamp !== null) {
                const delta = now - this.lastArrivalTimestamp;
                if (delta > 0 && delta < 5000) {
                    this.interArrivalDeltas.push(delta);
                    if (this.interArrivalDeltas.length > 100) {
                        this.interArrivalDeltas.shift();
                    }
                }
            }
            this.lastArrivalTimestamp = now;

            const byteLen = (rawLine ? rawLine.length + 2 : 0);
            this.totalBytesIngested += byteLen;
            this.byteRateWindow.push({ time: Date.now(), bytes: byteLen });
            const cutoff = Date.now() - 3000;
            while (this.byteRateWindow.length > 0 && this.byteRateWindow[0].time < cutoff) {
                this.byteRateWindow.shift();
            }

            const parsed = this.parsePacket(rawLine);
            if (parsed) {
                this.addDataPoint(parsed);
                return parsed;
            }
            return null;
        }

        /**
         * Parse comma-separated CanSat packet into typed, structured object.
         * Format:
         * $CANSAT,<seq_id>,<timestamp_ms>,<alt>,<pressure>,<temperature>,<roll>,<pitch>,<yaw>,
         *         <ax>,<ay>,<az>,<gx>,<gy>,<gz>,<mx>,<my>,<mz>,<lat>,<lon>,<gps_alt>,
         *         <sat_count>,<hdop>,<fix_type>,<voltage>,<current>,<power>,<bus_voltage>,
         *         <rssi>,<snr>,<lqi>
         * @param {string} rawLine
         * @returns {Object|null} Structured telemetry packet or null if invalid
         */
        parsePacket(rawLine) {
            if (!rawLine || typeof rawLine !== 'string') return null;

            const trimmed = rawLine.trim();

            const dollarIdx = trimmed.indexOf('$');
            if (dollarIdx < 0) {
                this.malformedPacketsCount++;
                this.emit('warning', { type: 'MALFORMED_PACKET', message: 'Telemetry line is missing the $CANSAT prefix', raw: trimmed });
                return null;
            }

            const packetBody = trimmed.substring(dollarIdx + 1);
            // Ignore any legacy checksum suffix; current telemetry is checksum-free.
            const legacySuffixIdx = packetBody.indexOf('*');
            const payload = legacySuffixIdx >= 0 ? packetBody.substring(0, legacySuffixIdx) : packetBody;
            const tokens = payload.split(',');

            // Expect header 'CANSAT' + at least 5 core fields (seq, time, alt, pressure, temp) up to 30 fields
            if (tokens.length < 6 || tokens[0] !== 'CANSAT') {
                this.malformedPacketsCount++;
                this.emit('warning', {
                    type: 'MALFORMED_PACKET',
                    message: `Invalid token count: expected header CANSAT and >= 6 fields, got ${tokens.length}`,
                    raw: trimmed
                });
                return null;
            }

            // Safe parsing helpers
            const toInt = (val, def = 0) => {
                if (val === undefined || val === null || val === '') return def;
                const n = parseInt(val, 10);
                return Number.isFinite(n) ? n : def;
            };

            const toFloat = (val, def = 0.0) => {
                if (val === undefined || val === null || val === '') return def;
                const n = parseFloat(val);
                return Number.isFinite(n) ? n : def;
            };

            const seqId = toInt(tokens[1]);
            const timestampMs = toFloat(tokens[2]);
            const rawAlt = toFloat(tokens[3]);
            const pressure = toFloat(tokens[4], 1013.25);
            const temperature = toFloat(tokens[5], 25.0);

            // Orientation
            const roll = toFloat(tokens[6], 0.0);
            const pitch = toFloat(tokens[7], 0.0);
            const yaw = toFloat(tokens[8], 0.0);

            // Acceleration
            const ax = toFloat(tokens[9], 0.0);
            const ay = toFloat(tokens[10], 0.0);
            const az = toFloat(tokens[11], 9.81);

            // Gyroscope
            const gx = toFloat(tokens[12], 0.0);
            const gy = toFloat(tokens[13], 0.0);
            const gz = toFloat(tokens[14], 0.0);

            // Magnetometer
            const mx = toFloat(tokens[15], 0.0);
            const my = toFloat(tokens[16], 0.0);
            const mz = toFloat(tokens[17], 0.0);

            // GPS
            const lat = toFloat(tokens[18], 0.0);
            const lon = toFloat(tokens[19], 0.0);
            const gpsAlt = toFloat(tokens[20], 0.0);
            const satCount = toInt(tokens[21], 0);
            const hdop = toFloat(tokens[22], 1.0);
            const fixType = toInt(tokens[23], 0);

            // Electrical Power Subsystem
            const voltage = toFloat(tokens[24], 3.3);
            const current = toFloat(tokens[25], 0.05);
            const power = toFloat(tokens[26], 0.165);
            const busVoltage = toFloat(tokens[27], 3.3);

            // RF Link Quality
            const rssi = toFloat(tokens[28], -60.0);
            const snr = toFloat(tokens[29], 10.0);
            const lqi = toFloat(tokens[30], 100.0);

            // Compute calibrated barometric altitude
            const computedAlt = this._calculateBarometricAltitude(pressure, temperature);

            // Compute vector magnitudes
            const accelMag = Math.sqrt(ax * ax + ay * ay + az * az);
            const rotVel = Math.sqrt(gx * gx + gy * gy + gz * gz);

            // Structure packet
            const parsed = {
                raw: trimmed,
                seq_id: seqId,
                timestamp_ms: timestampMs,

                // Barometer & Environment
                alt: computedAlt,
                raw_alt: rawAlt,
                computed_alt: computedAlt,
                pressure: pressure,
                temperature: temperature,

                // Attitude (deg)
                roll: roll,
                pitch: pitch,
                yaw: yaw,

                // Acceleration
                ax: ax,
                ay: ay,
                az: az,
                accel_mag: accelMag,

                // Gyroscope
                gx: gx,
                gy: gy,
                gz: gz,
                rot_vel: rotVel,

                // Magnetometer
                mx: mx,
                my: my,
                mz: mz,

                // GPS Navigation
                lat: lat,
                lon: lon,
                gps_alt: gpsAlt,
                sat_count: satCount,
                hdop: hdop,
                fix_type: fixType,
                distance_gcs: this.computeDistanceFromGCS(this.gcsCoordinates.lat, this.gcsCoordinates.lon, lat, lon),

                // Electrical
                voltage: voltage,
                current: current,
                power: power,
                bus_voltage: busVoltage,

                // Radio Link
                rssi: rssi,
                snr: snr,
                lqi: lqi,

                // Dynamics (Computed upon insertion)
                vertical_speed: 0.0,
                predicted_apogee: computedAlt,
                flight_state: this.flightState,
                packet_loss_pct: this.getPacketLossPercent(),

                // Metadata
                received_at: Date.now()
            };

            return parsed;
        }

        // ====================================================================
        // DATA STORE & RING BUFFERS
        // ====================================================================

        /**
         * Ingest a parsed telemetry packet into the primary ring buffer,
         * update sequence tracking, state machine, and notify listeners.
         * @param {Object} parsed
         */
        addDataPoint(parsed) {
            if (!parsed || typeof parsed !== 'object') return;

            // Handle baseline calibration if active
            if (this.calibrationActive && Number.isFinite(parsed.pressure) && parsed.pressure > 0) {
                this.calibrationSamples.push(parsed.pressure);
                this.emit('calibration', {
                    progress: Math.min(100, Math.round((this.calibrationSamples.length / this.calibrationTarget) * 100)),
                    samplesCollected: this.calibrationSamples.length,
                    samplesTarget: this.calibrationTarget,
                    currentPressure: parsed.pressure
                });

                if (this.calibrationSamples.length >= this.calibrationTarget) {
                    this._finalizeBaselineCalibration();
                }
            }

            // Push to ring buffer (fixed memory allocation)
            this.records.push(parsed);

            // Compute 5-point vertical speed (dAlt/dt)
            parsed.vertical_speed = this.computeVerticalSpeed();

            // Compute predicted apogee
            parsed.predicted_apogee = this.predictApogee();

            // Track sequence ID and packet loss
            this._trackPacketSequence(parsed.seq_id, parsed.received_at);
            parsed.packet_loss_pct = this.getPacketLossPercent();

            // Update flight state machine
            const detectedState = this.detectFlightState(parsed);
            parsed.flight_state = detectedState;

            // Health monitoring checks
            if (this.isPacketLossExceeded()) {
                this.emit('warning', {
                    type: 'HIGH_PACKET_LOSS',
                    message: `High packet loss (>15%) sustained for > 3 seconds. Current loss: ${this.getPacketLossPercent().toFixed(1)}%`,
                    lossPercent: this.getPacketLossPercent()
                });
            }

            // Emit data event with enriched packet
            this.emit('data', parsed);
        }

        /**
         * Retrieve the last N data points for a specific key.
         * Formatted for direct consumption by Chart.js or canvas graphing.
         * @param {string} key Field name (e.g. 'alt', 'pressure', 'voltage', 'accel_mag')
         * @param {number} [count=100] Number of recent points to fetch
         * @returns {Array<{timestamp: number, value: *}>}
         */
        getTimeSeries(key, count = 100) {
            const n = Math.min(this.records.length, Math.max(1, count));
            const recent = this.records.slice(-n);

            if (!key || key === 'all') {
                return recent;
            }

            const series = new Array(recent.length);
            for (let i = 0; i < recent.length; i++) {
                const pt = recent[i];
                series[i] = {
                    timestamp: pt.timestamp_ms !== undefined ? pt.timestamp_ms : pt.received_at,
                    value: pt[key] !== undefined ? pt[key] : null
                };
            }
            return series;
        }

        /**
         * Fast extraction of raw value array for a metric.
         * @param {string} key
         * @param {number} [count=100]
         * @returns {number[]}
         */
        getSeriesValues(key, count = 100) {
            const n = Math.min(this.records.length, Math.max(1, count));
            const recent = this.records.slice(-n);
            const values = new Array(recent.length);
            for (let i = 0; i < recent.length; i++) {
                values[i] = recent[i][key] !== undefined ? recent[i][key] : 0.0;
            }
            return values;
        }

        // ====================================================================
        // COMPUTED METRICS
        // ====================================================================

        /**
         * Compute vertical speed (Vz in m/s) using a 5-point linear regression derivative.
         * This Savitzky-Golay optimal filter attenuates barometric sensor noise while
         * naturally handling variable sampling intervals without instability.
         * @returns {number} Vertical speed in m/s
         */
        computeVerticalSpeed() {
            const count = this.records.length;
            if (count < 2) return 0.0;

            const n = Math.min(5, count);
            const points = this.records.slice(-n);

            let sumT = 0.0;
            let sumY = 0.0;
            const tSeconds = new Array(n);
            const yValues = new Array(n);

            // Convert milliseconds to seconds relative to first point in window
            const t0 = points[0].timestamp_ms !== undefined ? points[0].timestamp_ms : points[0].received_at;

            for (let i = 0; i < n; i++) {
                const p = points[i];
                const rawT = p.timestamp_ms !== undefined ? p.timestamp_ms : p.received_at;
                const t = (rawT - t0) / 1000.0;
                const y = p.alt !== undefined ? p.alt : (p.computed_alt || 0.0);

                tSeconds[i] = t;
                yValues[i] = y;
                sumT += t;
                sumY += y;
            }

            const meanT = sumT / n;
            const meanY = sumY / n;

            let numerator = 0.0;
            let denominator = 0.0;

            for (let i = 0; i < n; i++) {
                const dt = tSeconds[i] - meanT;
                const dy = yValues[i] - meanY;
                numerator += dt * dy;
                denominator += dt * dt;
            }

            if (denominator < 1e-9) {
                // Fallback to simple two-point difference if timestamps match
                const pFirst = points[0];
                const pLast = points[n - 1];
                const dt = ((pLast.timestamp_ms || pLast.received_at) - (pFirst.timestamp_ms || pFirst.received_at)) / 1000.0;
                if (dt > 1e-5) {
                    return (pLast.alt - pFirst.alt) / dt;
                }
                return 0.0;
            }

            const vz = numerator / denominator;
            return Number.isFinite(vz) ? vz : 0.0;
        }

        /**
         * Compute 3D Acceleration Magnitude: sqrt(ax² + ay² + az²)
         * @param {number} [ax]
         * @param {number} [ay]
         * @param {number} [az]
         * @returns {number}
         */
        computeAccelMagnitude(ax, ay, az) {
            if (ax !== undefined && ay !== undefined && az !== undefined) {
                return Math.sqrt(ax * ax + ay * ay + az * az);
            }
            const last = this.records.last;
            if (!last) return 0.0;
            return Math.sqrt(last.ax * last.ax + last.ay * last.ay + last.az * last.az);
        }

        /**
         * Compute 3D Rotational Velocity Magnitude: sqrt(gx² + gy² + gz²)
         * @param {number} [gx]
         * @param {number} [gy]
         * @param {number} [gz]
         * @returns {number}
         */
        computeRotationalVelocity(gx, gy, gz) {
            if (gx !== undefined && gy !== undefined && gz !== undefined) {
                return Math.sqrt(gx * gx + gy * gy + gz * gz);
            }
            const last = this.records.last;
            if (!last) return 0.0;
            return Math.sqrt(last.gx * last.gx + last.gy * last.gy + last.gz * last.gz);
        }

        /**
         * Compute geodesic distance from Ground Station using Great-Circle Haversine formula.
         * @param {number} [gcsLat] GCS Latitude in degrees
         * @param {number} [gcsLon] GCS Longitude in degrees
         * @param {number} [cansatLat] CanSat Latitude in degrees
         * @param {number} [cansatLon] CanSat Longitude in degrees
         * @returns {number} Distance in meters
         */
        computeDistanceFromGCS(gcsLat, gcsLon, cansatLat, cansatLon) {
            const lat1 = gcsLat !== undefined ? gcsLat : this.gcsCoordinates.lat;
            const lon1 = gcsLon !== undefined ? gcsLon : this.gcsCoordinates.lon;

            let lat2 = cansatLat;
            let lon2 = cansatLon;

            if (lat2 === undefined || lon2 === undefined) {
                const last = this.records.last;
                if (!last || last.lat === undefined || last.lon === undefined) return 0.0;
                lat2 = last.lat;
                lon2 = last.lon;
            }

            if (!Number.isFinite(lat1) || !Number.isFinite(lon1) ||
                !Number.isFinite(lat2) || !Number.isFinite(lon2) ||
                (lat2 === 0.0 && lon2 === 0.0)) {
                return 0.0;
            }

            const toRad = Math.PI / 180.0;
            const phi1 = lat1 * toRad;
            const phi2 = lat2 * toRad;
            const deltaPhi = (lat2 - lat1) * toRad;
            const deltaLambda = (lon2 - lon1) * toRad;

            const a = Math.sin(deltaPhi / 2.0) * Math.sin(deltaPhi / 2.0) +
                      Math.cos(phi1) * Math.cos(phi2) *
                      Math.sin(deltaLambda / 2.0) * Math.sin(deltaLambda / 2.0);

            const c = 2.0 * Math.atan2(Math.sqrt(a), Math.sqrt(1.0 - a));
            const distance = CONSTANTS.EARTH_RADIUS_METERS * c;

            return Number.isFinite(distance) ? distance : 0.0;
        }

        /**
         * Compute 3D Slant Range (Euclidean line-of-sight distance) from GCS.
         * @param {number} [gcsLat]
         * @param {number} [gcsLon]
         * @param {number} [gcsAlt]
         * @returns {number}
         */
        computeSlantRangeFromGCS(gcsLat, gcsLon, gcsAlt) {
            const surfaceDist = this.computeDistanceFromGCS(gcsLat, gcsLon);
            const refAlt = gcsAlt !== undefined ? gcsAlt : this.gcsCoordinates.alt;
            const last = this.records.last;
            const targetAlt = last ? (last.alt || 0.0) : 0.0;
            const deltaAlt = targetAlt - refAlt;
            return Math.sqrt(surfaceDist * surfaceDist + deltaAlt * deltaAlt);
        }

        /**
         * Predict Apogee using energy conservation & linear ascent rate extrapolation.
         * For positive vertical velocity (ascent): h_apogee = h + Vz² / (2 * g).
         * For descent/touchdown: returns highest observed altitude during flight.
         * @returns {number} Predicted or achieved apogee in meters
         */
        predictApogee() {
            const last = this.records.last;
            if (!last) return 0.0;

            const currentAlt = last.alt || 0.0;
            const vz = last.vertical_speed || this.computeVerticalSpeed();

            // Track maximum observed altitude
            if (currentAlt > this.maxAltitude) {
                this.maxAltitude = currentAlt;
            }

            if (vz > 0.5) {
                // Ballistic energy equation: kinetic -> potential energy
                const ballisticGain = (vz * vz) / (2.0 * CONSTANTS.STANDARD_GRAVITY);
                const predicted = currentAlt + ballisticGain;
                return Math.max(this.maxAltitude, predicted);
            }

            return this.maxAltitude;
        }

        // ====================================================================
        // PACKET HEALTH MONITORING
        // ====================================================================

        /**
         * Track sequence IDs and update rolling packet window for loss statistics.
         * @private
         */
        _trackPacketSequence(seqId, wallClock = Date.now()) {
            if (!Number.isInteger(seqId)) return;

            if (this.firstSeqId === null) {
                this.firstSeqId = seqId;
                this.lastSeqId = seqId;
                this.totalPacketsReceived = 1;
                this.totalPacketsExpected = 1;
            } else {
                if (seqId > this.lastSeqId) {
                    const gap = seqId - this.lastSeqId - 1;
                    if (gap > 0) {
                        this.totalPacketsLost += gap;
                    }
                    this.totalPacketsExpected += (gap + 1);
                    this.totalPacketsReceived++;
                    this.lastSeqId = seqId;
                } else if (seqId < this.lastSeqId - 5000) {
                    // Sequence counter wrapped or flight controller rebooted
                    this.emit('warning', {
                        type: 'SEQUENCE_RESET',
                        message: `Sequence ID reset detected (${this.lastSeqId} -> ${seqId})`,
                        previousSeq: this.lastSeqId,
                        newSeq: seqId
                    });
                    this.lastSeqId = seqId;
                    this.totalPacketsExpected++;
                    this.totalPacketsReceived++;
                } else {
                    // Out-of-order or duplicate packet
                    this.totalPacketsReceived++;
                }
            }

            this.lastPacketWallClock = wallClock;

            // Maintain rolling window for real-time loss tracking (last 5 seconds)
            this.rollingPackets.push({ time: wallClock, seq: seqId });
            const cutoff = wallClock - 5000;
            while (this.rollingPackets.length > 0 && this.rollingPackets[0].time < cutoff) {
                this.rollingPackets.shift();
            }
        }

        /**
         * Cumulative packet loss percentage across the entire mission.
         * @returns {number} Percentage (0.0 to 100.0)
         */
        getPacketLossPercent() {
            if (this.totalPacketsExpected <= 0) return 0.0;
            const loss = (this.totalPacketsLost / this.totalPacketsExpected) * 100.0;
            return Math.max(0.0, Math.min(100.0, loss));
        }

        /**
         * Rolling packet loss percentage over the last 3 seconds.
         * @returns {number}
         */
        getRollingPacketLossPercent() {
            const now = Date.now();
            const windowStart = now - 3000;
            const valid = this.rollingPackets.filter(p => p.time >= windowStart);

            if (valid.length < 2) return 0.0;

            const seqStart = valid[0].seq;
            const seqEnd = valid[valid.length - 1].seq;
            const expected = Math.max(1, seqEnd - seqStart + 1);
            const received = valid.length;
            const lost = Math.max(0, expected - received);

            return Math.min(100.0, (lost / expected) * 100.0);
        }

        /**
         * Returns true if packet loss rate exceeds 15% for 3+ consecutive seconds.
         * @returns {boolean}
         */
        isPacketLossExceeded() {
            const rollingLoss = this.getRollingPacketLossPercent();
            const now = Date.now();

            if (rollingLoss > 15.0) {
                if (this.highLossStartTime === null) {
                    this.highLossStartTime = now;
                } else if ((now - this.highLossStartTime) >= 3000) {
                    return true;
                }
            } else {
                this.highLossStartTime = null;
            }

            return false;
        }

        /**
         * Complete telemetry health status diagnosis.
         * @returns {Object}
         */
        checkTelemetryHealth() {
            const last = this.records.last;
            const now = Date.now();
            const timeSinceLastPacketMs = this.lastPacketWallClock ? (now - this.lastPacketWallClock) : 999999;
            const lossPct = this.getPacketLossPercent();
            const rollingLossPct = this.getRollingPacketLossPercent();
            const isLossBreached = this.isPacketLossExceeded();

            // Calculate instantaneous data rate (Hz) over last 2 seconds
            const recent2s = this.rollingPackets.filter(p => p.time >= now - 2000);
            const dataRateHz = recent2s.length / 2.0;

            let status = 'OPTIMAL';
            if (timeSinceLastPacketMs > 4000) {
                status = 'NO_SIGNAL';
            } else if (isLossBreached || (last && (last.rssi < -115 || last.voltage < 6.8))) {
                status = 'CRITICAL';
            } else if (lossPct > 5.0 || rollingLossPct > 10.0 || (last && (last.rssi < -100 || last.voltage < 7.2))) {
                status = 'DEGRADED';
            }

            let batteryHealth = 'NOMINAL';
            if (last && last.voltage !== undefined) {
                if (last.voltage < 6.8) batteryHealth = 'CRITICAL';
                else if (last.voltage < 7.2) batteryHealth = 'LOW';
            }

            const fixMap = { 0: 'NO_FIX', 1: '2D', 2: '3D', 3: 'DGPS' };

            return {
                status: status,
                packetLossPercent: Number(lossPct.toFixed(2)),
                recentPacketLossPercent: Number(rollingLossPct.toFixed(2)),
                isPacketLossExceeded: isLossBreached,
                packetsReceived: this.totalPacketsReceived,
                packetsExpected: this.totalPacketsExpected,
                packetsLost: this.totalPacketsLost,
                lastSequenceId: this.lastSeqId,
                lastPacketTime: this.lastPacketWallClock,
                timeSinceLastPacketMs: timeSinceLastPacketMs,
                dataRateHz: Number(dataRateHz.toFixed(1)),
                rssi: last ? last.rssi : null,
                snr: last ? last.snr : null,
                lqi: last ? last.lqi : null,
                batteryVoltage: last ? last.voltage : null,
                batteryHealth: batteryHealth,
                gpsFix: last ? (fixMap[last.fix_type] || 'UNKNOWN') : 'NO_FIX'
            };
        }

        // ====================================================================
        // FLIGHT STATE MACHINE
        // ====================================================================

        /**
         * Set arming status for launch pad.
         * @param {boolean} armed
         */
        setArmed(armed) {
            this.isArmed = !!armed;
            if (this.isArmed && this.flightState === FLIGHT_STATES.PRE_FLIGHT) {
                this._transitionState(FLIGHT_STATES.LAUNCH_PAD, 'Manual system arming');
            } else if (!this.isArmed && this.flightState === FLIGHT_STATES.LAUNCH_PAD) {
                this._transitionState(FLIGHT_STATES.PRE_FLIGHT, 'Manual system disarm');
            }
        }

        /**
         * Manually override the flight state.
         * @param {string} newState Valid FLIGHT_STATES entry
         */
        setFlightState(newState) {
            if (Object.values(FLIGHT_STATES).includes(newState)) {
                this._transitionState(newState, 'Manual operator override');
            }
        }

        /**
         * Automatically detect flight state from telemetry patterns.
         * Evaluates altitude, vertical speed, acceleration, and mission history.
         * @param {Object} data Current parsed telemetry point
         * @returns {string} Detected FLIGHT_STATES string
         */
        detectFlightState(data) {
            if (!data) return this.flightState;

            const alt = data.alt !== undefined ? data.alt : 0.0;
            const vz = data.vertical_speed !== undefined ? data.vertical_speed : 0.0;
            const accelMag = data.accel_mag !== undefined ? data.accel_mag : 9.81;
            const previousState = this.flightState;

            switch (this.flightState) {
                case FLIGHT_STATES.PRE_FLIGHT:
                    // If operator armed or stable on launch pad
                    if (this.isArmed) {
                        this._transitionState(FLIGHT_STATES.LAUNCH_PAD, 'System armed on pad');
                    }
                    // Direct ignition bypass
                    if (alt > 15.0 && vz > 5.0 && accelMag > 13.0) {
                        this._transitionState(FLIGHT_STATES.POWERED_ASCENT, 'Rapid altitude & acceleration climb detected');
                    }
                    break;

                case FLIGHT_STATES.LAUNCH_PAD:
                    // Powered ascent trigger: altitude climbing rapidly + Vz > 5 m/s
                    if ((alt > 10.0 && vz > 5.0) || (vz > 7.0 && accelMag > 14.0)) {
                        this._transitionState(FLIGHT_STATES.POWERED_ASCENT, `Powered ascent confirmed: Vz=${vz.toFixed(1)} m/s, Alt=${alt.toFixed(1)} m`);
                    }
                    break;

                case FLIGHT_STATES.POWERED_ASCENT:
                    // Track highest altitude
                    if (alt > this.maxAltitude) {
                        this.maxAltitude = alt;
                    }

                    // Apogee detection: Vz crosses zero from positive, or altitude drops from peak
                    if ((this.previousVz > 0.1 && vz <= 0.2 && alt > 30.0) || (alt < this.maxAltitude - 3.0 && alt > 50.0)) {
                        this._transitionState(FLIGHT_STATES.APOGEE, `Apogee reached at ${this.maxAltitude.toFixed(1)} m`);
                    }
                    break;

                case FLIGHT_STATES.APOGEE:
                    // Transition to drogue descent: Vz becomes negative
                    if (vz < -2.0) {
                        if (alt > 200.0) {
                            this._transitionState(FLIGHT_STATES.DROGUE_DESCENT, `Drogue descent initiated: Vz=${vz.toFixed(1)} m/s, Alt=${alt.toFixed(1)} m`);
                        } else {
                            this._transitionState(FLIGHT_STATES.MAIN_DESCENT, `Low altitude apogee: direct main parachute descent at ${alt.toFixed(1)} m`);
                        }
                    }
                    break;

                case FLIGHT_STATES.DROGUE_DESCENT:
                    // Main chute deployment trigger:
                    // 1. Altitude drops below 200m
                    // 2. Or sudden deceleration detected (chute deployment jolt) and descent slows
                    if (alt <= 200.0 || (vz > -9.0 && this.previousVz < -14.0)) {
                        this._transitionState(FLIGHT_STATES.MAIN_DESCENT, `Main parachute deployment confirmed: Alt=${alt.toFixed(1)} m, Vz=${vz.toFixed(1)} m/s`);
                    }
                    break;

                case FLIGHT_STATES.MAIN_DESCENT:
                    // Touchdown detection: altitude near ground (< 15m), Vz near zero (< 0.8 m/s) sustained
                    if (alt < 15.0 && Math.abs(vz) < 0.8 && Math.abs(accelMag - 9.81) < 2.0) {
                        this.touchdownStabilityCounter++;
                        if (this.touchdownStabilityCounter >= 10) { // ~1 second of static readings at 10Hz
                            this._transitionState(FLIGHT_STATES.TOUCHDOWN, `Touchdown confirmed at Ground Elevation ${alt.toFixed(1)} m`);
                        }
                    } else {
                        this.touchdownStabilityCounter = Math.max(0, this.touchdownStabilityCounter - 1);
                    }
                    break;

                case FLIGHT_STATES.TOUCHDOWN:
                    // CanSat has landed and mission completed
                    break;

                default:
                    this.flightState = FLIGHT_STATES.PRE_FLIGHT;
            }

            this.previousVz = vz;
            return this.flightState;
        }

        /**
         * State transition helper that emits 'stateChange' event.
         * @private
         */
        _transitionState(newState, reason = '') {
            if (this.flightState === newState) return;

            const previousState = this.flightState;
            this.flightState = newState;

            const transitionInfo = {
                previousState: previousState,
                currentState: newState,
                timestamp: Date.now(),
                altitude: this.records.last ? this.records.last.alt : 0.0,
                reason: reason
            };

            this.emit('stateChange', transitionInfo);
        }

        // ====================================================================
        // CALIBRATION SUPPORT
        // ====================================================================

        /**
         * Capture baseline ground pressure via 50-sample moving average for BMP585 zeroing.
         * Can compute immediately if buffer contains sufficient points, or collect incoming stream.
         * @param {number} [sampleCount=50]
         * @returns {Promise<number>} Resolved baseline pressure in hPa
         */
        async captureBaselinePressure(sampleCount = 50) {
            const target = Math.max(5, sampleCount);

            // If we already have enough valid pressure records in buffer, calibrate instantly
            if (this.records.length >= target) {
                const samples = this.records.slice(-target);
                let sum = 0.0;
                let validCount = 0;

                for (let i = 0; i < samples.length; i++) {
                    const p = samples[i].pressure;
                    if (Number.isFinite(p) && p > 300.0 && p < 1200.0) {
                        sum += p;
                        validCount++;
                    }
                }

                if (validCount >= Math.floor(target * 0.8)) {
                    this.baselinePressure = sum / validCount;
                    this.altitudeOffset = 0.0;
                    this.emit('calibration', {
                        status: 'complete',
                        baselinePressure: this.baselinePressure,
                        sampleCount: validCount
                    });
                    return this.baselinePressure;
                }
            }

            // Otherwise, accumulate live incoming packets
            return new Promise((resolve) => {
                this.calibrationActive = true;
                this.calibrationTarget = target;
                this.calibrationSamples = [];
                this.calibrationResolve = resolve;
            });
        }

        /**
         * Finalize asynchronous baseline calibration.
         * @private
         */
        _finalizeBaselineCalibration() {
            this.calibrationActive = false;
            let sum = 0.0;
            const valid = this.calibrationSamples.filter(p => Number.isFinite(p) && p > 300.0 && p < 1200.0);

            if (valid.length > 0) {
                sum = valid.reduce((a, b) => a + b, 0.0);
                this.baselinePressure = sum / valid.length;
            } else {
                this.baselinePressure = CONSTANTS.STANDARD_SEA_LEVEL_PRESSURE;
            }

            this.altitudeOffset = 0.0;
            this.calibrationSamples = [];

            this.emit('calibration', {
                status: 'complete',
                baselinePressure: this.baselinePressure,
                sampleCount: valid.length
            });

            if (this.calibrationResolve) {
                this.calibrationResolve(this.baselinePressure);
                this.calibrationResolve = null;
            }
        }

        /**
         * Set custom altitude offset (e.g. for sea-level MSL vs ground AGL adjustment).
         * @param {number} offset
         */
        setAltitudeOffset(offset) {
            if (Number.isFinite(offset)) {
                this.altitudeOffset = offset;
            }
        }

        /**
         * Directly set baseline pressure (hPa) from external calibration.
         * Used by CalibrationPanel and app.js BMP585 tare UI.
         * @param {number} pressure Baseline pressure in hPa (e.g. 1013.25)
         */
        setBaselinePressure(pressure) {
            if (Number.isFinite(pressure) && pressure > 300 && pressure < 1200) {
                this.baselinePressure = pressure;
                this.emit('calibration', {
                    status: 'manual',
                    baselinePressure: this.baselinePressure,
                    sampleCount: 1
                });
            }
        }

        /**
         * Update GCS ground station coordinates.
         * Affects Haversine distance and slant range calculations.
         * @param {number} lat Latitude in degrees
         * @param {number} lon Longitude in degrees
         * @param {number} [alt=0] Altitude in meters AMSL
         */
        setGCSCoordinates(lat, lon, alt = 0) {
            if (Number.isFinite(lat) && Number.isFinite(lon)) {
                this.gcsCoordinates = { lat, lon, alt: Number.isFinite(alt) ? alt : 0 };
                this.options.gcsLat = lat;
                this.options.gcsLon = lon;
                this.options.gcsAlt = this.gcsCoordinates.alt;
            }
        }

        /**
         * Zero the current altitude relative to the latest data point.
         */
        zeroAltitude() {
            const last = this.records.last;
            if (last) {
                this.altitudeOffset = -(this._calculateBarometricAltitude(last.pressure, last.temperature, 0.0));
            }
        }

        /**
         * Barometric formula calculating altitude relative to calibrated baseline.
         * Incorporates hypsometric temperature compensation.
         * @private
         */
        _calculateBarometricAltitude(pressure, temperature, offset = this.altitudeOffset) {
            if (!Number.isFinite(pressure) || pressure <= 0.0) {
                return 0.0;
            }

            const p0 = this.baselinePressure || CONSTANTS.STANDARD_SEA_LEVEL_PRESSURE;

            // Temperature compensation in Kelvin
            let tK = CONSTANTS.STANDARD_SEA_LEVEL_TEMP_K;
            if (Number.isFinite(temperature) && temperature > -50.0 && temperature < 80.0) {
                tK = temperature + 273.15;
            }

            // Hypsometric equation: h = (T0 / L) * (1 - (P / P0)^((R*L)/(g*M)))
            const pressureRatio = pressure / p0;
            const h = (tK / CONSTANTS.STANDARD_LAPSE_RATE) * (1.0 - Math.pow(pressureRatio, CONSTANTS.BARO_EXPONENT));

            return Number.isFinite(h) ? (h + offset) : 0.0;
        }

        // ====================================================================
        // DATA EXPORT (CSV & KML)
        // ====================================================================

        /**
         * Export entire ring buffer history as standard RFC 4180 CSV text.
         * @returns {string} CSV formatted data
         */
        exportCSV() {
            const headers = [
                'seq_id',
                'timestamp_ms',
                'alt',
                'pressure',
                'temperature',
                'roll',
                'pitch',
                'yaw',
                'ax',
                'ay',
                'az',
                'gx',
                'gy',
                'gz',
                'mx',
                'my',
                'mz',
                'lat',
                'lon',
                'gps_alt',
                'sat_count',
                'hdop',
                'fix_type',
                'voltage',
                'current',
                'power',
                'bus_voltage',
                'rssi',
                'snr',
                'lqi',
                'computed_alt',
                'vertical_speed',
                'accel_mag',
                'rot_vel',
                'distance_gcs',
                'predicted_apogee',
                'flight_state'
            ];

            const records = this.records.toArray();
            const lines = [headers.join(',')];

            for (let i = 0; i < records.length; i++) {
                const r = records[i];
                const row = [
                    r.seq_id,
                    r.timestamp_ms,
                    r.alt !== undefined ? r.alt.toFixed(2) : '',
                    r.pressure !== undefined ? r.pressure.toFixed(2) : '',
                    r.temperature !== undefined ? r.temperature.toFixed(2) : '',
                    r.roll !== undefined ? r.roll.toFixed(2) : '',
                    r.pitch !== undefined ? r.pitch.toFixed(2) : '',
                    r.yaw !== undefined ? r.yaw.toFixed(2) : '',
                    r.ax !== undefined ? r.ax.toFixed(3) : '',
                    r.ay !== undefined ? r.ay.toFixed(3) : '',
                    r.az !== undefined ? r.az.toFixed(3) : '',
                    r.gx !== undefined ? r.gx.toFixed(3) : '',
                    r.gy !== undefined ? r.gy.toFixed(3) : '',
                    r.gz !== undefined ? r.gz.toFixed(3) : '',
                    r.mx !== undefined ? r.mx.toFixed(2) : '',
                    r.my !== undefined ? r.my.toFixed(2) : '',
                    r.mz !== undefined ? r.mz.toFixed(2) : '',
                    r.lat !== undefined ? r.lat.toFixed(6) : '',
                    r.lon !== undefined ? r.lon.toFixed(6) : '',
                    r.gps_alt !== undefined ? r.gps_alt.toFixed(2) : '',
                    r.sat_count,
                    r.hdop !== undefined ? r.hdop.toFixed(2) : '',
                    r.fix_type,
                    r.voltage !== undefined ? r.voltage.toFixed(2) : '',
                    r.current !== undefined ? r.current.toFixed(2) : '',
                    r.power !== undefined ? r.power.toFixed(2) : '',
                    r.bus_voltage !== undefined ? r.bus_voltage.toFixed(2) : '',
                    r.rssi !== undefined ? r.rssi.toFixed(1) : '',
                    r.snr !== undefined ? r.snr.toFixed(1) : '',
                    r.lqi !== undefined ? r.lqi.toFixed(0) : '',
                    r.computed_alt !== undefined ? r.computed_alt.toFixed(2) : '',
                    r.vertical_speed !== undefined ? r.vertical_speed.toFixed(2) : '',
                    r.accel_mag !== undefined ? r.accel_mag.toFixed(3) : '',
                    r.rot_vel !== undefined ? r.rot_vel.toFixed(3) : '',
                    r.distance_gcs !== undefined ? r.distance_gcs.toFixed(1) : '',
                    r.predicted_apogee !== undefined ? r.predicted_apogee.toFixed(1) : '',
                    `"${r.flight_state || ''}"`
                ];
                lines.push(row.join(','));
            }

            return lines.join('\r\n');
        }

        /**
         * Trigger immediate browser file download of telemetry log as CSV.
         * @param {string} [filename]
         */
        downloadCSV(filename) {
            const csvText = this.exportCSV();
            const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const name = filename || `cansat_telemetry_${dateStr}.csv`;
            this._triggerDownload(csvText, name, 'text/csv;charset=utf-8;');
        }

        /**
         * Export GPS trajectory as OpenGIS KML 2.2 XML file for Google Earth 3D playback.
         * @returns {string} XML KML document
         */
        exportKML() {
            const records = this.records.toArray();
            const validPoints = records.filter(r =>
                Number.isFinite(r.lat) && Number.isFinite(r.lon) &&
                !(r.lat === 0.0 && r.lon === 0.0) &&
                r.fix_type >= 2
            );

            let coordString = '';
            for (let i = 0; i < validPoints.length; i++) {
                const p = validPoints[i];
                const alt = p.gps_alt !== undefined && p.gps_alt > 0 ? p.gps_alt : (p.alt || 0.0);
                coordString += `${p.lon.toFixed(7)},${p.lat.toFixed(7)},${alt.toFixed(2)}\n        `;
            }

            const launchPoint = validPoints[0];
            const currentPoint = validPoints[validPoints.length - 1];

            // Find Apogee point
            let maxPt = validPoints[0];
            for (let i = 1; i < validPoints.length; i++) {
                if (validPoints[i].alt > (maxPt ? maxPt.alt : -999)) {
                    maxPt = validPoints[i];
                }
            }

            const dateStr = new Date().toISOString();

            return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>INSPACE CanSat Trajectory Log</name>
    <description>Mission Flight Path recorded at ${dateStr}</description>
    
    <Style id="flightPathStyle">
      <LineStyle>
        <color>ff0055ff</color>
        <width>4</width>
      </LineStyle>
      <PolyStyle>
        <color>440055ff</color>
      </PolyStyle>
    </Style>

    <Style id="padStyle">
      <IconStyle>
        <scale>1.2</scale>
        <Icon>
          <href>http://maps.google.com/mapfiles/kml/shapes/placemark_circle.png</href>
        </Icon>
      </IconStyle>
    </Style>

    <Style id="apogeeStyle">
      <IconStyle>
        <scale>1.3</scale>
        <Icon>
          <href>http://maps.google.com/mapfiles/kml/shapes/star.png</href>
        </Icon>
      </IconStyle>
    </Style>

    ${launchPoint ? `
    <Placemark>
      <name>Launch Pad Site</name>
      <description>Sequence ID: ${launchPoint.seq_id}, Initial Alt: ${launchPoint.alt.toFixed(1)} m</description>
      <styleUrl>#padStyle</styleUrl>
      <Point>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${launchPoint.lon.toFixed(7)},${launchPoint.lat.toFixed(7)},0</coordinates>
      </Point>
    </Placemark>` : ''}

    ${maxPt ? `
    <Placemark>
      <name>Apogee Peak: ${maxPt.alt.toFixed(1)} m</name>
      <description>Apogee recorded at timestamp ${maxPt.timestamp_ms} ms</description>
      <styleUrl>#apogeeStyle</styleUrl>
      <Point>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>${maxPt.lon.toFixed(7)},${maxPt.lat.toFixed(7)},${(maxPt.gps_alt || maxPt.alt).toFixed(2)}</coordinates>
      </Point>
    </Placemark>` : ''}

    ${currentPoint ? `
    <Placemark>
      <name>Touchdown / Latest Position</name>
      <description>State: ${currentPoint.flight_state}, Final Alt: ${currentPoint.alt.toFixed(1)} m</description>
      <Point>
        <altitudeMode>clampToGround</altitudeMode>
        <coordinates>${currentPoint.lon.toFixed(7)},${currentPoint.lat.toFixed(7)},0</coordinates>
      </Point>
    </Placemark>` : ''}

    <Placemark>
      <name>CanSat 3D Flight Track</name>
      <styleUrl>#flightPathStyle</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>absolute</altitudeMode>
        <coordinates>
        ${coordString.trim()}
        </coordinates>
      </LineString>
    </Placemark>

  </Document>
</kml>`;
        }

        /**
         * Trigger immediate browser file download of flight track as KML.
         * @param {string} [filename]
         */
        downloadKML(filename) {
            const kmlText = this.exportKML();
            const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const name = filename || `cansat_flight_track_${dateStr}.kml`;
            this._triggerDownload(kmlText, name, 'application/vnd.google-earth.kml+xml;charset=utf-8;');
        }

        /**
         * Helper for triggering browser file downloads.
         * @private
         */
        _triggerDownload(content, filename, mimeType) {
            if (typeof document === 'undefined' || typeof window === 'undefined') return;
            const blob = new Blob([content], { type: mimeType });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 100);
        }

        // ====================================================================
        // REALISTIC TELEMETRY SIMULATOR (HARDWARE-FREE TESTING)
        // ====================================================================

        /**
         * Start a high-fidelity CanSat flight simulation at 10Hz.
         * Simulates launch sequence, powered ascent, apogee, drogue descent,
         * parachute deployment, and touchdown with sensor noise.
         * @param {number} [intervalMs=100] 100ms = 10Hz
         */
        startSimulation(intervalMs = 100) {
            this.stopSimulation();
            this.isConnected = true;
            this.connectionType = 'simulator';
            this.isIntentionalDisconnect = false;
            this.simulationTick = 0;

            this.emit('connectionChange', {
                type: 'simulator',
                status: 'connected',
                rateHz: 1000 / intervalMs
            });

            // Initial simulation state parameters
            let simTime = 0.0;
            let simAlt = 0.0;
            let simVz = 0.0;
            let simSeq = 1;
            let simLat = this.gcsCoordinates.lat !== 0 ? this.gcsCoordinates.lat : 28.6139;
            let simLon = this.gcsCoordinates.lon !== 0 ? this.gcsCoordinates.lon : 77.2090;
            const baseP = this.baselinePressure || 1013.25;

            this.simulationInterval = setInterval(() => {
                simTime += intervalMs / 1000.0;
                simSeq++;

                // Physics simulation phases
                let ax = (Math.random() - 0.5) * 0.4;
                let ay = (Math.random() - 0.5) * 0.4;
                let az = 9.81 + (Math.random() - 0.5) * 0.3;
                let gx = (Math.random() - 0.5) * 2.0;
                let gy = (Math.random() - 0.5) * 2.0;
                let gz = (Math.random() - 0.5) * 2.0;

                if (simTime < 5.0) {
                    // Pre-flight & Pad
                    simAlt = (Math.random() - 0.5) * 0.3;
                    simVz = 0.0;
                } else if (simTime < 13.0) {
                    // Powered Ascent (Rocket burn)
                    const burnAcc = 35.0; // ~3.5g boost
                    simVz += burnAcc * (intervalMs / 1000.0);
                    simAlt += simVz * (intervalMs / 1000.0);
                    az = burnAcc + 9.81 + (Math.random() - 0.5) * 4.0;
                    gz = 15.0 + (Math.random() - 0.5) * 10.0; // Spin stabilized
                } else if (simTime < 22.0) {
                    // Coasting to Apogee
                    simVz -= 9.81 * (intervalMs / 1000.0);
                    simAlt += simVz * (intervalMs / 1000.0);
                    az = (Math.random() - 0.5) * 0.5; // Microgravity/freefall
                } else if (simTime < 35.0) {
                    // Drogue Descent (Falling at terminal velocity ~18 m/s)
                    const targetVz = -18.0;
                    simVz += (targetVz - simVz) * 0.1;
                    simAlt += simVz * (intervalMs / 1000.0);
                } else if (simTime < 65.0) {
                    // Main Chute Deployed (Terminal velocity ~5 m/s)
                    const targetVz = -5.0;
                    simVz += (targetVz - simVz) * 0.2;
                    simAlt += simVz * (intervalMs / 1000.0);
                } else {
                    // Touchdown
                    simAlt = 0.0;
                    simVz = 0.0;
                }

                simAlt = Math.max(0.0, simAlt);

                // Wind drift
                if (simAlt > 0) {
                    simLat += 0.000005 * (intervalMs / 100.0);
                    simLon += 0.000008 * (intervalMs / 100.0);
                }

                // Barometer reverse calculation with noise
                const pressure = baseP * Math.pow(1.0 - (CONSTANTS.STANDARD_LAPSE_RATE * simAlt) / CONSTANTS.STANDARD_SEA_LEVEL_TEMP_K, 1.0 / CONSTANTS.BARO_EXPONENT) + (Math.random() - 0.5) * 0.2;
                const temp = 24.5 - (simAlt * 0.0065) + (Math.random() - 0.5) * 0.1;

                // Battery & RF
                const voltage = 12.26;
                const current = 320.0 + (Math.random() - 0.5) * 20.0;
                const power = voltage * current;
                const busVoltage = 5.02;
                const rssi = -68.0 - (simAlt * 0.03) + (Math.random() - 0.5) * 3.0;
                const snr = 9.5 - (simAlt * 0.004) + (Math.random() - 0.5) * 0.5;
                const lqi = Math.max(20, Math.min(100, Math.round(95 - (simAlt * 0.04))));

                // Orientation angles
                const roll = Math.sin(simTime * 1.5) * 12.0;
                const pitch = Math.cos(simTime * 1.2) * 8.0;
                const yaw = (simTime * 25.0) % 360.0;

                // Assemble payload
                const payload = [
                    'CANSAT',
                    simSeq,
                    Math.round(simTime * 1000),
                    simAlt.toFixed(2),
                    pressure.toFixed(2),
                    temp.toFixed(2),
                    roll.toFixed(2),
                    pitch.toFixed(2),
                    yaw.toFixed(2),
                    ax.toFixed(3),
                    ay.toFixed(3),
                    az.toFixed(3),
                    gx.toFixed(3),
                    gy.toFixed(3),
                    gz.toFixed(3),
                    (18.5 + (Math.random() - 0.5)).toFixed(2),
                    (-6.2 + (Math.random() - 0.5)).toFixed(2),
                    (42.1 + (Math.random() - 0.5)).toFixed(2),
                    simLat.toFixed(6),
                    simLon.toFixed(6),
                    (simAlt + 215.0).toFixed(2),
                    12,
                    0.95,
                    3,
                    voltage.toFixed(2),
                    current.toFixed(2),
                    power.toFixed(2),
                    busVoltage.toFixed(2),
                    rssi.toFixed(1),
                    snr.toFixed(1),
                    lqi
                ].join(',');

                this.handleRawLine(`$${payload}`);
            }, intervalMs);
        }

        /**
         * Stop the telemetry flight simulator.
         */
        stopSimulation() {
            if (this.simulationInterval) {
                clearInterval(this.simulationInterval);
                this.simulationInterval = null;
            }
            if (this.connectionType === 'simulator') {
                this.isConnected = false;
                this.connectionType = null;
                this.emit('connectionChange', { type: 'simulator', status: 'disconnected' });
            }
        }

        // ====================================================================
        // TESTING, BENCHMARKS & CONSTRAINTS ENGINE
        // ====================================================================

        /**
         * Get real-time ring buffer health & capacity statistics
         * @returns {Object}
         */
        getBufferStats() {
            const capacity = this.records.capacity;
            const count = this.records.count;
            const fillPercent = capacity > 0 ? (count / capacity) * 100 : 0;
            // Approx memory footprint: ~800 bytes per structured telemetry record
            const memoryEstimateBytes = count * 800;
            const memoryEstimateKB = (memoryEstimateBytes / 1024).toFixed(1);

            return {
                capacity,
                count,
                head: this.records.head,
                fillPercent: Number(fillPercent.toFixed(2)),
                memoryEstimateBytes,
                memoryEstimateKB: Number(memoryEstimateKB),
                freeSlots: Math.max(0, capacity - count),
                isOverwriting: count >= capacity
            };
        }

        /**
         * Get transmission speed, baud rate utilization, and link jitter
         * @returns {Object}
         */
        getTransmissionMetrics() {
            const now = Date.now();
            const recentBytes = this.byteRateWindow.filter(b => b.time >= now - 2000);
            const totalBytes2s = recentBytes.reduce((acc, cur) => acc + cur.bytes, 0);
            const bytesPerSec = totalBytes2s / 2.0;
            const kbPerSec = bytesPerSec / 1024.0;

            // Baud rate utilization (10 bits per character: 1 start, 8 data, 1 stop bit)
            const configuredBaud = this.baudRate || 115200;
            const bitsPerSec = bytesPerSec * 10;
            const baudUtilizationPct = Math.min(100.0, (bitsPerSec / configuredBaud) * 100);

            // Instantaneous data rate (Hz)
            const recentPackets2s = this.rollingPackets.filter(p => p.time >= now - 2000);
            const packetRateHz = recentPackets2s.length / 2.0;

            // Inter-packet jitter calculation (standard deviation of delta arrival times)
            let jitterMs = 0.0;
            if (this.interArrivalDeltas.length >= 2) {
                const meanDelta = this.interArrivalDeltas.reduce((a, b) => a + b, 0) / this.interArrivalDeltas.length;
                const variance = this.interArrivalDeltas.reduce((a, b) => a + Math.pow(b - meanDelta, 2), 0) / this.interArrivalDeltas.length;
                jitterMs = Math.sqrt(variance);
            }

            // Packet-format error rate (checksums are not part of the telemetry format)
            const totalAttempts = this.totalPacketsReceived + this.malformedPacketsCount;
            const malformedPacketRatePct = totalAttempts > 0 ? (this.malformedPacketsCount / totalAttempts) * 100 : 0.0;

            return {
                packetRateHz: Number(packetRateHz.toFixed(1)),
                bytesPerSec: Math.round(bytesPerSec),
                kbPerSec: Number(kbPerSec.toFixed(2)),
                baudRate: configuredBaud,
                baudUtilizationPct: Number(baudUtilizationPct.toFixed(1)),
                jitterMs: Number(jitterMs.toFixed(2)),
                totalBytesIngested: this.totalBytesIngested,
                malformedPacketsCount: this.malformedPacketsCount,
                malformedPacketRatePct: Number(malformedPacketRatePct.toFixed(2))
            };
        }

        /**
         * Evaluate flight and operational constraints checklist
         * @returns {Array<Object>}
         */
        evaluateConstraints() {
            const transmission = this.getTransmissionMetrics();
            const buffer = this.getBufferStats();
            const health = this.checkTelemetryHealth();
            const last = this.records.last;

            return [
                {
                    id: 'PACKET_LOSS_GATE',
                    name: 'Packet Loss Limit (≤ 5.0%)',
                    category: 'RF Telemetry',
                    value: `${health.packetLossPercent}%`,
                    threshold: '≤ 5.0%',
                    passed: health.packetLossPercent <= 5.0,
                    status: health.packetLossPercent <= 5.0 ? 'PASS' : (health.packetLossPercent <= 15.0 ? 'WARN' : 'FAIL'),
                    description: 'Cumulative packet loss across active mission window'
                },
                {
                    id: 'TELEMETRY_RATE_GATE',
                    name: 'Telemetry Streaming Rate (≥ 8.0 Hz)',
                    category: 'Throughput',
                    value: `${transmission.packetRateHz} Hz`,
                    threshold: '≥ 8.0 Hz',
                    passed: this.isConnected ? transmission.packetRateHz >= 8.0 : true,
                    status: !this.isConnected ? 'STANDBY' : (transmission.packetRateHz >= 8.0 ? 'PASS' : (transmission.packetRateHz >= 4.0 ? 'WARN' : 'FAIL')),
                    description: 'Ingestion frequency required for smooth Kalman/Mahony attitude filtering'
                },
                {
                    id: 'PACKET_FORMAT_GATE',
                    name: 'Malformed Packet Rate (< 1.0%)',
                    category: 'Data Format',
                    value: `${transmission.malformedPacketRatePct}% (${transmission.malformedPacketsCount} malformed)`,
                    threshold: '< 1.0%',
                    passed: !this.isConnected || transmission.malformedPacketRatePct < 1.0,
                    status: !this.isConnected ? 'STANDBY' : (transmission.malformedPacketRatePct < 1.0 ? 'PASS' : 'FAIL'),
                    description: 'Malformed lines rejected by the CANSAT CSV field parser'
                },
                {
                    id: 'JITTER_LIMIT_GATE',
                    name: 'Packet Arrival Jitter (< 35 ms)',
                    category: 'Timing Stability',
                    value: `${transmission.jitterMs} ms`,
                    threshold: '< 35.0 ms',
                    passed: transmission.jitterMs < 35.0,
                    status: !this.isConnected ? 'STANDBY' : (transmission.jitterMs < 35.0 ? 'PASS' : 'WARN'),
                    description: 'Standard deviation of inter-packet delivery latency'
                },
                {
                    id: 'BATTERY_FLOOR_GATE',
                    name: 'Battery Voltage Floor (≥ 7.0 V)',
                    category: 'EPS Power',
                    value: last && last.voltage !== undefined ? `${last.voltage.toFixed(2)} V` : 'N/A',
                    threshold: '≥ 7.0 V',
                    passed: last ? (last.voltage >= 7.0) : true,
                    status: !last ? 'STANDBY' : (last.voltage >= 7.2 ? 'PASS' : (last.voltage >= 7.0 ? 'WARN' : 'FAIL')),
                    description: '2S LiPo cutoff protection against brownouts'
                },
                {
                    id: 'GNSS_HDOP_GATE',
                    name: 'GNSS Precision HDOP (≤ 2.0)',
                    category: 'Navigation',
                    value: last && last.hdop !== undefined ? `${last.hdop.toFixed(2)}` : 'N/A',
                    threshold: '≤ 2.0',
                    passed: last ? (last.hdop <= 2.0 && last.fix_type >= 2) : true,
                    status: !last ? 'STANDBY' : (last.fix_type >= 2 && last.hdop <= 2.0 ? 'PASS' : 'WARN'),
                    description: 'Horizontal Dilution of Precision for SAR recovery radius'
                },
                {
                    id: 'BUFFER_HEADROOM_GATE',
                    name: 'RingBuffer Capacity Headroom (≤ 90% full)',
                    category: 'Memory Management',
                    value: `${buffer.fillPercent}% (${buffer.count}/${buffer.capacity})`,
                    threshold: '≤ 90.0%',
                    passed: buffer.fillPercent <= 90.0,
                    status: buffer.fillPercent <= 90.0 ? 'PASS' : 'WARN',
                    description: 'Circular buffer overflow protection for zero memory leaks'
                }
            ];
        }

        /**
         * Benchmark RingBuffer push & read throughput
         * @param {number} [iterations=50000]
         * @returns {Object}
         */
        runBufferBenchmark(iterations = 50000) {
            const testBuffer = new RingBuffer(iterations);
            const dummyPacket = {
                seq_id: 1,
                timestamp_ms: 1000,
                alt: 150.2,
                pressure: 980.5,
                temperature: 24.2,
                roll: 12.5,
                pitch: -3.4,
                yaw: 88.1,
                ax: 0.12,
                ay: 0.05,
                az: 9.82
            };

            const startTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());

            // 1. Push iterations
            for (let i = 0; i < iterations; i++) {
                dummyPacket.seq_id = i;
                testBuffer.push(dummyPacket);
            }

            // 2. Read iterations
            let sumAlt = 0;
            for (let i = 0; i < iterations; i++) {
                const rec = testBuffer.get(i);
                if (rec) sumAlt += rec.alt;
            }

            const endTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const durationMs = Math.max(0.001, endTime - startTime);
            const totalOps = iterations * 2; // push + read
            const opsPerSec = Math.round((totalOps / durationMs) * 1000);
            const avgLatencyUs = ((durationMs * 1000) / totalOps).toFixed(3);

            return {
                iterations,
                totalOps,
                durationMs: Number(durationMs.toFixed(2)),
                opsPerSec,
                avgLatencyUs: Number(avgLatencyUs),
                passed: opsPerSec >= 500000 // Target >= 500,000 ops/sec
            };
        }

        /**
         * Benchmark checksum-free CANSAT telemetry parsing throughput
         * @param {number} [iterations=25000]
         * @returns {Object}
         */
        runParserBenchmark(iterations = 25000) {
            const packet = '$CANSAT,1024,12500,245.50,984.20,22.40,14.50,-2.30,112.40,0.210,-0.040,9.810,0.010,-0.020,0.050,18.50,-6.20,42.10,28.613900,77.209000,460.50,12,0.95,3,7.85,0.450,3.532,7.85,-68.5,12.4,98.0';

            const startTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());

            let parsedCount = 0;
            for (let i = 0; i < iterations; i++) {
                if (this.parsePacket(packet)) parsedCount++;
            }

            const endTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            const durationMs = Math.max(0.001, endTime - startTime);
            const opsPerSec = Math.round((iterations / durationMs) * 1000);
            const totalBytes = packet.length * iterations;
            const throughputMBps = Number(((totalBytes / (1024 * 1024)) / (durationMs / 1000)).toFixed(2));

            return {
                iterations,
                durationMs: Number(durationMs.toFixed(2)),
                opsPerSec,
                throughputMBps,
                parsedCount,
                passed: opsPerSec >= 200000 // Target >= 200,000 parses/sec
            };
        }

        /**
         * Inject a burst of high-frequency simulated packets to stress test ingestion
         * @param {number} [count=200]
         * @param {number} [intervalMs=5]
         * @returns {Promise<number>} Number of injected packets
         */
        async injectStressBurst(count = 200, intervalMs = 5) {
            return new Promise((resolve) => {
                let sent = 0;
                let curSeq = (this.lastSeqId || 100) + 1;
                const timer = setInterval(() => {
                    if (sent >= count) {
                        clearInterval(timer);
                        resolve(sent);
                        return;
                    }
                    curSeq++;
                    sent++;
                    const payload = `CANSAT,${curSeq},${Date.now()},${(100 + sent * 0.5).toFixed(2)},1005.20,24.50,${(Math.sin(sent) * 20).toFixed(2)},${(Math.cos(sent) * 15).toFixed(2)},${(sent % 360).toFixed(2)},0.12,-0.04,9.81,0.01,-0.02,0.03,18.5,-6.2,42.1,28.6139,77.209,315.0,12,0.95,3,7.95,0.42,3.33,7.95,-65.0,14.0,99`;
                    this.handleRawLine(`$${payload}`);
                }, intervalMs);
            });
        }

        /**
         * Deliberately inject a malformed packet to exercise format rejection.
         * @returns {string} Raw malformed packet injected
         */
        injectMalformedPacket() {
            const badSeq = (this.lastSeqId || 100) + 1;
            const malformedPacket = `$CANSAT,${badSeq},${Date.now()},150.00,995.00`;
            this.handleRawLine(malformedPacket);
            return malformedPacket;
        }
    }

    // Explicit window assignment for browser environments
    if (typeof window !== 'undefined') {
        window.TelemetryEngine = TelemetryEngine;
        window.RingBuffer = RingBuffer;
        window.FLIGHT_STATES = FLIGHT_STATES;
    }

    // Dual export
    return {
        TelemetryEngine,
        RingBuffer,
        FLIGHT_STATES,
        CONSTANTS
    };
}));
