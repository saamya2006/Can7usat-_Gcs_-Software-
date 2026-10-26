/**
 * ============================================================================
 * IN-SPACE CANSAT GROUND CONTROL STATION (GCS)
 * COMMAND PROTOCOL MODULE
 * ============================================================================
 * Handles uplink command generation, NMEA-style XOR checksum calculation,
 * safety interlocks, operator confirmation dialogs, transmission via telemetry
 * transport, ACK response handling with retry, and event console integration.
 *
 * Command Packet Specification (Uplink to CanSat):
 *   $CMD,<cmd_id>,<cmd_type>,<param1>,<param2>*<checksum>\r\n
 *   Checksum = XOR of all bytes between '$' and '*' (exclusive), 2-digit uppercase hex.
 *
 * ACK Packet Specification (Downlink from CanSat):
 *   $ACK,<cmd_id>,<status>*<checksum>\r\n
 *   status: OK | FAIL | BUSY
 *
 * File: command-protocol.js
 * Author: Aerospace Software Architect & GCS Flight Operations
 * Version: 2.5.0
 * ============================================================================
 */

(function (window) {
    'use strict';

    /**
     * Standard Command Definitions and Safety Rules
     */
    const COMMAND_REGISTRY = {
        RST: {
            name: 'Reset Microcontroller',
            description: 'Hard reset flight computer and reboot onboard sensors.',
            dangerous: true,
            dangerLevel: 'CRITICAL',
            warning: 'This will reset the flight computer',
            requiresArm: true,
            requiresDoubleConfirm: false,
            defaultParams: []
        },
        ARM: {
            name: 'Arm/Disarm Flight Systems',
            description: 'Arm or disarm pyrotechnic deployment circuits and flight actuators.',
            dangerous: true,
            dangerLevel: 'HIGH',
            warning: 'This will arm/disarm the flight system',
            requiresArm: false,
            requiresDoubleConfirm: false,
            paramInfo: '1 = Arm, 0 = Disarm'
        },
        DEP: {
            name: 'Trigger Backup Deployment',
            description: 'Fires pyrotechnic squib / backup parachute deployment mechanism.',
            dangerous: true,
            dangerLevel: 'CRITICAL',
            warning: 'This will trigger pyrotechnic deployment',
            requiresArm: true,
            requiresDoubleConfirm: true,
            paramInfo: 'chute_id: 1 = Drogue Chute, 2 = Main Chute'
        },
        LOG: {
            name: 'Force Telemetry Logging',
            description: 'Force start/stop onboard high-rate flash telemetry logging.',
            dangerous: false,
            dangerLevel: 'LOW',
            warning: null,
            requiresArm: false,
            requiresDoubleConfirm: false,
            paramInfo: '1 = Start Logging, 0 = Stop Logging'
        },
        CAL: {
            name: 'Send Calibration Baseline',
            description: 'Upload calibration offsets (barometer reference pressure, gyro zero).',
            dangerous: false,
            dangerLevel: 'MEDIUM',
            warning: 'This will send calibration data and update sensor baselines',
            requiresArm: false,
            requiresDoubleConfirm: false,
            paramInfo: 'cal_type, cal_value'
        },
        PNG: {
            name: 'Ping / Loopback Latency Test',
            description: 'Sends RF ping sequence to test uplink/downlink latency and RSSI.',
            dangerous: false,
            dangerLevel: 'NONE',
            warning: null,
            requiresArm: false,
            requiresDoubleConfirm: false,
            paramInfo: 'sequence_number'
        },
        CAM: {
            name: 'Camera Control',
            description: 'Trigger payload camera optical capture or video recording.',
            dangerous: false,
            dangerLevel: 'LOW',
            warning: null,
            requiresArm: false,
            requiresDoubleConfirm: false,
            paramInfo: '1 = Capture, 0 = Stop'
        },
        BZR: {
            name: 'Recovery Buzzer Control',
            description: 'Enable or disable audible recovery beacon buzzer.',
            dangerous: false,
            dangerLevel: 'LOW',
            warning: null,
            requiresArm: false,
            requiresDoubleConfirm: false,
            paramInfo: '1 = Buzzer ON, 0 = Buzzer OFF'
        },
        SIM: {
            name: 'Simulation Mode Control',
            description: 'Enable or disable hardware-in-the-loop synthetic simulation mode.',
            dangerous: true,
            dangerLevel: 'MEDIUM',
            warning: 'This will toggle CanSat flight computer simulation mode',
            requiresArm: false,
            requiresDoubleConfirm: false,
            paramInfo: '1 = Enable Simulation, 0 = Disable Simulation'
        }
    };

    /**
     * Aerospace Command Protocol Manager Class
     */
    class CommandProtocol {
        /**
         * @param {Object} telemetryEngine Reference to telemetry transport engine (Serial/WebSocket/WebWorker)
         */
        constructor(telemetryEngine = null) {
            this.telemetryEngine = telemetryEngine;
            this.commandIdCounter = 1;
            this.isSystemArmed = false;
            this.flightState = 'IDLE'; // Pre-Flight, Ascent, Apogee, Descent, Recovery
            this.pendingCommands = new Map(); // cmdId -> PendingCommandEntry
            this.commandHistory = [];
            this.eventLogs = [];
            this._pingSeq = 0;
            this.activeDialogPromise = null;
            this.dialogCountdownTimer = null;

            // Bind methods
            this.handleAck = this.handleAck.bind(this);
            this.logToConsole = this.logToConsole.bind(this);

            // Hook telemetry engine transport if provided
            this.initTelemetryEngineHook();

            // Listen to browser-wide events for cross-module integration
            if (typeof window !== 'undefined') {
                window.addEventListener('cansat:incoming-ack', (e) => {
                    if (e.detail) this.handleAck(e.detail);
                });
                window.addEventListener('cansat:flight-state-changed', (e) => {
                    if (e.detail && e.detail.flightState) {
                        this.setFlightState(e.detail.flightState);
                    }
                });
            }
        }

        /**
         * Initialize telemetry engine hooks for incoming packet streaming
         */
        initTelemetryEngineHook() {
            if (!this.telemetryEngine) return;

            // Inject reference back to this protocol module
            this.telemetryEngine.commandProtocol = this;

            // Hook EventTarget listeners
            if (typeof this.telemetryEngine.addEventListener === 'function') {
                this.telemetryEngine.addEventListener('ack', (e) => this.handleAck(e.detail || e));
                this.telemetryEngine.addEventListener('packet', (e) => {
                    const data = e.detail?.data || e.detail || e.data;
                    if (typeof data === 'string' && data.includes('$ACK')) {
                        this.handleAck(data);
                    }
                });
            } else if (typeof this.telemetryEngine.on === 'function') {
                this.telemetryEngine.on('ack', (ack) => this.handleAck(ack));
                this.telemetryEngine.on('packet', (pkt) => {
                    if (typeof pkt === 'string' && pkt.includes('$ACK')) {
                        this.handleAck(pkt);
                    }
                });
                this.telemetryEngine.on('data', (d) => {
                    if (typeof d === 'string' && d.includes('$ACK')) {
                        this.handleAck(d);
                    }
                });
            }
        }

        /**
         * Attach or replace the telemetry engine instance
         * @param {Object} engine 
         */
        setTelemetryEngine(engine) {
            this.telemetryEngine = engine;
            this.initTelemetryEngineHook();
        }

        /**
         * Get auto-incrementing command ID (1 - 999999)
         * @returns {number}
         */
        getNextCommandId() {
            const id = this.commandIdCounter++;
            if (this.commandIdCounter > 999999) {
                this.commandIdCounter = 1;
            }
            return id;
        }

        /**
         * Get next sequential ping number
         * @returns {number}
         */
        getNextPingSeq() {
            this._pingSeq = ((this._pingSeq || 0) % 65535) + 1;
            return this._pingSeq;
        }

        /**
         * Computes NMEA-style XOR checksum of all bytes in payload
         * Payload = all bytes between '$' and '*' (exclusive)
         * 
         * @param {string} payload - Payload string between '$' and '*'
         * @returns {string} 2-digit uppercase hex checksum
         */
        computeChecksum(payload) {
            if (!payload || typeof payload !== 'string') return '00';
            let checksum = 0;
            for (let i = 0; i < payload.length; i++) {
                checksum ^= payload.charCodeAt(i);
            }
            return checksum.toString(16).toUpperCase().padStart(2, '0');
        }

        /**
         * Converts string to space-separated hex byte representation
         * @param {string} str 
         * @returns {string}
         */
        stringToHex(str) {
            if (!str || typeof str !== 'string') return '';
            const hexParts = [];
            for (let i = 0; i < str.length; i++) {
                hexParts.push(str.charCodeAt(i).toString(16).toUpperCase().padStart(2, '0'));
            }
            return hexParts.join(' ');
        }

        /**
         * Builds formatted command packet string with checksum
         * Format: $CMD,<cmd_id>,<cmd_type>,<param1>,<param2>*<checksum>\r\n
         * 
         * @param {string} cmdType - Command identifier (e.g. 'RST', 'ARM', 'DEP')
         * @param {Array<number|string>} [params=[]] - Optional command parameters
         * @param {number} [explicitCmdId=null] - Optional specific command ID
         * @returns {string} Complete formatted packet string
         */
        buildPacket(cmdType, params = [], explicitCmdId = null) {
            const id = (explicitCmdId !== null && explicitCmdId !== undefined) ? explicitCmdId : this.getNextCommandId();
            const type = String(cmdType).toUpperCase().trim();
            const paramArray = Array.isArray(params) ? params : (params !== undefined && params !== null ? [params] : []);

            const parts = ['CMD', id, type, ...paramArray];
            const payload = parts.join(',');
            const checksum = this.computeChecksum(payload);
            return `$${payload}*${checksum}\r\n`;
        }

        /**
         * Parses incoming ACK response
         * Supported formats:
         *   $ACK,<cmd_id>,<status>*<checksum>\r\n
         *   $ACK,<cmd_id>,<status>,<message>*<checksum>\r\n
         * 
         * @param {string|Object} rawPacket 
         * @returns {Object|null}
         */
        parseAckPacket(rawPacket) {
            if (!rawPacket) return null;

            // Handle object inputs
            if (typeof rawPacket === 'object') {
                if (rawPacket.cmdId !== undefined && rawPacket.status !== undefined) {
                    return {
                        cmdId: parseInt(rawPacket.cmdId, 10),
                        status: String(rawPacket.status).toUpperCase().trim(),
                        message: rawPacket.message || '',
                        validChecksum: true,
                        raw: JSON.stringify(rawPacket)
                    };
                }
                rawPacket = String(rawPacket.data || rawPacket.packet || rawPacket.payload || '');
            }

            if (typeof rawPacket !== 'string') return null;

            const str = rawPacket.trim();
            const ackIdx = str.indexOf('$ACK');
            if (ackIdx === -1) return null;

            const sub = str.slice(ackIdx);
            const starIdx = sub.indexOf('*');
            let payload = '';
            let checksum = null;
            let validChecksum = true;

            if (starIdx !== -1) {
                payload = sub.substring(1, starIdx); // Exclude '$' and '*'
                const afterStar = sub.slice(starIdx + 1);
                const match = afterStar.match(/^([0-9A-Fa-f]{2})/);
                if (match) {
                    checksum = match[1].toUpperCase();
                    const expectedChecksum = this.computeChecksum(payload);
                    validChecksum = (checksum === expectedChecksum);
                }
            } else {
                // If packet lacks asterisk, split until newline
                const endIdx = sub.search(/[\r\n]/);
                payload = (endIdx !== -1 ? sub.slice(1, endIdx) : sub.slice(1)).trim();
            }

            const tokens = payload.split(',');
            if (tokens.length < 3 || tokens[0] !== 'ACK') {
                return null;
            }

            const cmdId = parseInt(tokens[1], 10);
            const status = tokens[2].toUpperCase().trim();
            const message = tokens.slice(3).join(',').trim();

            return {
                cmdId,
                status,
                message,
                payload,
                checksum,
                validChecksum,
                raw: str
            };
        }

        /**
         * Checks if the flight systems are currently armed
         * @returns {boolean}
         */
        isArmed() {
            return Boolean(this.isSystemArmed);
        }

        /**
         * Sets the arm state and updates UI indicators
         * @param {boolean} armed 
         */
        setArmed(armed) {
            const previous = this.isSystemArmed;
            this.isSystemArmed = Boolean(armed);

            const level = this.isSystemArmed ? 'WARNING' : 'INFO';
            const statusText = this.isSystemArmed ? 'ARMED (PYRO CIRCUITS ACTIVE)' : 'DISARMED (SAFE)';
            this.logToConsole(`[ARM STATE] Flight systems changed to: ${statusText}`, level);

            // Update UI elements in DOM
            this.updateArmUI();

            // Dispatch global event
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('cansat:arm-state-changed', {
                    detail: { armed: this.isSystemArmed, previous }
                }));
            }
        }

        /**
         * Get current flight state
         * @returns {string}
         */
        getFlightState() {
            // Check if telemetry engine has up-to-date state
            if (this.telemetryEngine) {
                if (this.telemetryEngine.flightState) return this.telemetryEngine.flightState;
                if (this.telemetryEngine.currentTelemetry?.flightState) return this.telemetryEngine.currentTelemetry.flightState;
                if (this.telemetryEngine.lastTelemetry?.flightState) return this.telemetryEngine.lastTelemetry.flightState;
            }
            // Check DOM element
            if (typeof document !== 'undefined') {
                const stateEl = document.getElementById('flight-state') || document.getElementById('mission-state');
                if (stateEl && stateEl.textContent) {
                    return stateEl.textContent.trim();
                }
            }
            return this.flightState || 'IDLE';
        }

        /**
         * Sets current flight state
         * @param {string} state 
         */
        setFlightState(state) {
            if (!state) return;
            this.flightState = String(state).trim();
            this.logToConsole(`[FLIGHT STATE] Operating state updated to: ${this.flightState}`, 'INFO');
        }

        /**
         * Safety verification interlock
         * - Block dangerous commands (DEP, RST) if not armed
         * - Block DEP if flight state is Pre-Flight / Launchpad
         * 
         * @param {string} cmdType 
         * @returns {{ valid: boolean, reason: string }}
         */
        validateCommand(cmdType) {
            const type = String(cmdType).toUpperCase().trim();
            const config = COMMAND_REGISTRY[type] || {};

            // 1. Arm State Check for dangerous hardware commands (RST, DEP)
            if (config.requiresArm && !this.isArmed()) {
                return {
                    valid: false,
                    reason: `Command ${type} blocked by safety interlock: System is DISARMED. Flight systems must be ARMED to execute ${config.name || type}.`
                };
            }

            // 2. Flight State Check for Pyrotechnic Deployment (DEP)
            if (type === 'DEP') {
                const rawState = this.getFlightState().toUpperCase();
                const preFlightStates = [
                    'PRE-FLIGHT', 'PREFLIGHT', 'PRE_FLIGHT',
                    'IDLE', 'STANDBY', 'LAUNCHPAD', 'GROUND', 'PAD', 'READY'
                ];

                const isPreFlight = preFlightStates.some(s => rawState === s || rawState.includes(s));
                if (isPreFlight) {
                    return {
                        valid: false,
                        reason: `Deployment (DEP) blocked: Pyrotechnic squib ignition is strictly prohibited in Ground / Pre-Flight state (Current: "${rawState}").`
                    };
                }
            }

            return {
                valid: true,
                reason: `Command ${type} validated through safety interlocks.`
            };
        }

        /**
         * Sends an uplink command with validation, optional confirmation dialog,
         * ACK timeout (3 seconds), and automatic retry mechanism (up to 3 retries).
         * 
         * Flow:
         *   1. Validate command (block dangerous if not armed, block DEP in Pre-Flight)
         *   2. Build the packet with auto-incrementing command ID
         *   3. If requireConfirm=true, show confirmation dialog
         *   4. Send via telemetryEngine's connection
         *   5. Start ACK timeout timer (3 seconds)
         *   6. Log command to event console
         *   7. Return promise that resolves on ACK or rejects on timeout
         * 
         * @param {string} cmdType - Command identifier (RST, ARM, DEP, etc.)
         * @param {Array<number|string>} [params=[]] - Command arguments
         * @param {boolean} [requireConfirm=false] - Whether operator must explicitly confirm
         * @returns {Promise<Object>} Resolves on ACK 'OK', rejects on timeout or NACK
         */
        async sendCommand(cmdType, params = [], requireConfirm = false) {
            const type = String(cmdType).toUpperCase().trim();
            const paramArray = Array.isArray(params) ? params : (params !== undefined && params !== null ? [params] : []);

            // 1. Interlock Validation
            const validation = this.validateCommand(type);
            if (!validation.valid) {
                this.logToConsole(`[COMMAND REJECTED] ${validation.reason}`, 'CRITICAL');
                throw new Error(validation.reason);
            }

            // 2. Allocate auto-incrementing ID and pre-build packet
            const cmdId = this.getNextCommandId();
            const packet = this.buildPacket(type, paramArray, cmdId);

            // 3. Confirmation Dialog for dangerous or specified commands
            const config = COMMAND_REGISTRY[type] || {};
            const mustConfirm = requireConfirm || config.dangerous || type === 'DEP' || type === 'RST' || type === 'ARM';

            if (mustConfirm) {
                const confirmed = await this.showConfirmDialog(type, paramArray, packet, cmdId);
                if (!confirmed) {
                    this.logToConsole(`[COMMAND ABORTED] Operator cancelled uplink for #${cmdId} [${type}].`, 'WARNING');
                    return {
                        success: false,
                        cancelled: true,
                        cmdId,
                        cmdType: type,
                        reason: 'Operator cancelled confirmation dialog'
                    };
                }
            }

            // 4. Send via telemetryEngine connection and manage ACK promise
            return new Promise((resolve, reject) => {
                const pendingEntry = {
                    cmdId,
                    cmdType: type,
                    params: paramArray,
                    packet,
                    sentAt: Date.now(),
                    retries: 0,
                    maxRetries: 3,
                    timeoutTimer: null,
                    resolve,
                    reject,
                    requireConfirm: mustConfirm
                };

                this.pendingCommands.set(cmdId, pendingEntry);
                this.updatePendingUI();

                // Record in history log
                this.recordCommandHistory(pendingEntry, 'PENDING');

                // Execute transmission & start ACK timeout timer (3 seconds)
                this.executeTransmission(pendingEntry);
            });
        }

        /**
         * Executes transmission over available transport and starts 3-second timeout timer
         * @param {Object} pendingEntry 
         */
        executeTransmission(pendingEntry) {
            const attemptInfo = pendingEntry.retries > 0 
                ? ` [Retry ${pendingEntry.retries}/${pendingEntry.maxRetries}]` 
                : '';

            this.logToConsole(
                `[UPLINK TX] Sending #${pendingEntry.cmdId} [${pendingEntry.cmdType}]${attemptInfo} -> ${pendingEntry.packet.trim()}`,
                'INFO'
            );

            // Transport write
            this.transmitRawPacket(pendingEntry.packet);

            // Set 3-second ACK timeout
            if (pendingEntry.timeoutTimer) {
                clearTimeout(pendingEntry.timeoutTimer);
            }

            pendingEntry.timeoutTimer = setTimeout(() => {
                this.handleTimeout(pendingEntry.cmdId);
            }, 3000);
        }

        /**
         * Transmits raw packet through available connection on telemetry engine
         * @param {string} packet 
         */
        async transmitRawPacket(packet) {
            let sent = false;

            if (this.telemetryEngine) {
                try {
                    if (typeof this.telemetryEngine.sendUplink === 'function') {
                        await this.telemetryEngine.sendUplink(packet);
                        sent = true;
                    } else if (typeof this.telemetryEngine.send === 'function') {
                        await this.telemetryEngine.send(packet);
                        sent = true;
                    } else if (typeof this.telemetryEngine.write === 'function') {
                        await this.telemetryEngine.write(packet);
                        sent = true;
                    } else if (typeof this.telemetryEngine.sendData === 'function') {
                        await this.telemetryEngine.sendData(packet);
                        sent = true;
                    } else if (typeof this.telemetryEngine.sendCommand === 'function' && this.telemetryEngine.sendCommand !== this.sendCommand) {
                        await this.telemetryEngine.sendCommand(packet);
                        sent = true;
                    } else if (this.telemetryEngine.serial && typeof this.telemetryEngine.serial.write === 'function') {
                        await this.telemetryEngine.serial.write(packet);
                        sent = true;
                    } else if (this.telemetryEngine.ws && typeof this.telemetryEngine.ws.send === 'function') {
                        await this.telemetryEngine.ws.send(packet);
                        sent = true;
                    }
                } catch (err) {
                    this.logToConsole(`[TRANSPORT ERROR] Failed transmitting packet: ${err.message}`, 'CRITICAL');
                }
            }

            if (!sent) {
                // If offline or in simulation loopback mode, notify console
                this.logToConsole(`[TRANSPORT STANDALONE] Packet buffered for uplink: ${packet.trim()}`, 'INFO');
            }

            // Dispatch global event for visual telemetry monitor
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('cansat:packet-transmitted', {
                    detail: { packet, timestamp: Date.now() }
                }));
            }
        }

        /**
         * Handles ACK timeout after 3 seconds with up to 3 retries
         * @param {number} cmdId 
         */
        handleTimeout(cmdId) {
            const entry = this.pendingCommands.get(cmdId);
            if (!entry) return;

            if (entry.retries < entry.maxRetries) {
                entry.retries++;
                this.logToConsole(
                    `[ACK TIMEOUT] No ACK for #${cmdId} [${entry.cmdType}] within 3.0s. Retrying uplink (${entry.retries}/${entry.maxRetries})...`,
                    'WARNING'
                );
                this.executeTransmission(entry);
            } else {
                // Max retries exhausted
                this.pendingCommands.delete(cmdId);
                this.updatePendingUI();
                this.updateHistoryStatus(cmdId, 'TIMEOUT');

                const timeoutErr = `Command #${cmdId} [${entry.cmdType}] timed out after ${entry.maxRetries} retries (No ACK from CanSat).`;
                this.logToConsole(`[COMMAND FAILED] ${timeoutErr}`, 'CRITICAL');

                entry.reject(new Error(timeoutErr));
            }
        }

        /**
         * Acknowledgement Handling
         * Parses ACK response: $ACK,<cmd_id>,<status>*<checksum>
         * Statuses: OK, FAIL, BUSY
         * 
         * @param {string|Object} ackPacket 
         * @returns {boolean} Whether an active pending command was resolved
         */
        handleAck(ackPacket) {
            const parsed = this.parseAckPacket(ackPacket);
            if (!parsed) {
                return false;
            }

            const { cmdId, status, message, validChecksum, raw } = parsed;

            if (!validChecksum) {
                this.logToConsole(
                    `[ACK CHECKSUM WARNING] Packet #${cmdId} checksum mismatch: ${raw}`,
                    'WARNING'
                );
            }

            const entry = this.pendingCommands.get(cmdId);

            if (entry) {
                // Clear active timer
                if (entry.timeoutTimer) {
                    clearTimeout(entry.timeoutTimer);
                    entry.timeoutTimer = null;
                }

                if (status === 'OK') {
                    this.pendingCommands.delete(cmdId);
                    this.updatePendingUI();
                    this.updateHistoryStatus(cmdId, 'ACK_OK');

                    // Handle state change side effects
                    if (entry.cmdType === 'ARM') {
                        const isArm = entry.params.length > 0 ? Number(entry.params[0]) === 1 : true;
                        this.setArmed(isArm);
                    }

                    const ackLog = `[ACK RECEIVED] #${cmdId} [${entry.cmdType}] status: OK${message ? ' (' + message + ')' : ''}`;
                    this.logToConsole(ackLog, 'COMMAND_ACK');

                    entry.resolve({
                        success: true,
                        cmdId,
                        cmdType: entry.cmdType,
                        status: 'OK',
                        message,
                        ackPacket: raw
                    });
                    return true;
                } else if (status === 'BUSY') {
                    // CanSat busy: wait 500ms and retry if attempts remain
                    if (entry.retries < entry.maxRetries) {
                        entry.retries++;
                        this.logToConsole(
                            `[ACK BUSY] #${cmdId} [${entry.cmdType}] CanSat busy. Retrying in 500ms (${entry.retries}/${entry.maxRetries})...`,
                            'WARNING'
                        );
                        entry.timeoutTimer = setTimeout(() => {
                            if (this.pendingCommands.has(cmdId)) {
                                this.executeTransmission(entry);
                            }
                        }, 500);
                        return true;
                    } else {
                        this.pendingCommands.delete(cmdId);
                        this.updatePendingUI();
                        this.updateHistoryStatus(cmdId, 'BUSY_LIMIT');

                        const busyErr = `Command #${cmdId} [${entry.cmdType}] failed: CanSat remained BUSY after ${entry.maxRetries} retries.`;
                        this.logToConsole(`[COMMAND FAILED] ${busyErr}`, 'CRITICAL');
                        entry.reject(new Error(busyErr));
                        return false;
                    }
                } else {
                    // FAIL or NACK
                    this.pendingCommands.delete(cmdId);
                    this.updatePendingUI();
                    this.updateHistoryStatus(cmdId, 'FAIL');

                    const failErr = `Command #${cmdId} [${entry.cmdType}] rejected with status: ${status}${message ? ' (' + message + ')' : ''}`;
                    this.logToConsole(`[ACK NACK] ${failErr}`, 'CRITICAL');
                    entry.reject(new Error(failErr));
                    return false;
                }
            } else {
                // Late or unprompted ACK
                const level = status === 'OK' ? 'COMMAND_ACK' : 'WARNING';
                this.logToConsole(
                    `[UNSOLICITED ACK] Received ACK for command #${cmdId} (${status})${message ? ' - ' + message : ''}`,
                    level
                );
                return false;
            }
        }

        /**
         * Returns list of currently pending commands awaiting ACK
         * @returns {Array<Object>}
         */
        getPendingCommands() {
            return Array.from(this.pendingCommands.values()).map(cmd => ({
                cmdId: cmd.cmdId,
                cmdType: cmd.cmdType,
                params: [...cmd.params],
                packet: cmd.packet,
                sentAt: cmd.sentAt,
                retries: cmd.retries,
                maxRetries: cmd.maxRetries,
                elapsedMs: Date.now() - cmd.sentAt
            }));
        }

        /**
         * Cancels an active pending command
         * @param {number} cmdId 
         * @returns {boolean}
         */
        cancelPending(cmdId) {
            const entry = this.pendingCommands.get(cmdId);
            if (!entry) return false;

            if (entry.timeoutTimer) {
                clearTimeout(entry.timeoutTimer);
                entry.timeoutTimer = null;
            }

            this.pendingCommands.delete(cmdId);
            this.updatePendingUI();
            this.updateHistoryStatus(cmdId, 'CANCELLED');

            this.logToConsole(`[COMMAND CANCELLED] Pending command #${cmdId} [${entry.cmdType}] cancelled by operator.`, 'WARNING');
            entry.reject(new Error(`Command #${cmdId} cancelled by operator.`));
            return true;
        }

        /**
         * Displays the Command Confirmation Dialog
         * Features:
         *   - High-contrast white sunlight-visible theme
         *   - Yellow warning banner for dangerous commands
         *   - Specific warnings:
         *       RST: "This will reset the flight computer"
         *       DEP: "This will trigger pyrotechnic deployment"
         *       ARM: "This will arm/disarm the flight system"
         *   - Monospace built packet string and packet hex representation
         *   - Green "Confirm Send" button and gray "Cancel" button
         *   - 5-second auto-cancel countdown timer with visual progress bar
         *   - Double-confirmation for pyrotechnic deployment (DEP)
         *   - Resolves true (confirmed) or false (cancelled)
         * 
         * @param {string} cmdType 
         * @param {Array} params 
         * @param {string} [packetString=null] 
         * @param {number} [cmdId=null] 
         * @returns {Promise<boolean>}
         */
        showConfirmDialog(cmdType, params = [], packetString = null, cmdId = null) {
            const type = String(cmdType).toUpperCase().trim();
            const config = COMMAND_REGISTRY[type] || {
                name: type,
                description: 'Custom Uplink Command',
                dangerous: false,
                dangerLevel: 'LOW',
                warning: null
            };

            const packet = packetString || this.buildPacket(type, params, cmdId || this.commandIdCounter);
            const hexDump = this.stringToHex(packet);

            return new Promise((resolve) => {
                const dialogEl = this.ensureDialogElement();
                let remainingTime = 5.0;
                let step = 1;

                // Stop any previous active countdown
                if (this.dialogCountdownTimer) {
                    clearInterval(this.dialogCountdownTimer);
                    this.dialogCountdownTimer = null;
                }

                // Populate dialog content
                this.renderDialogContent(dialogEl, {
                    cmdId: cmdId || this.commandIdCounter,
                    cmdType: type,
                    config,
                    params,
                    packet,
                    hexDump
                });

                // Show modal
                dialogEl.classList.remove('hidden');

                // Cleanup and resolve helper
                const finish = (result) => {
                    if (this.dialogCountdownTimer) {
                        clearInterval(this.dialogCountdownTimer);
                        this.dialogCountdownTimer = null;
                    }
                    dialogEl.classList.add('hidden');
                    document.removeEventListener('keydown', keyHandler);
                    resolve(result);
                };

                // Keyboard handler (Escape = Cancel)
                const keyHandler = (e) => {
                    if (e.key === 'Escape') {
                        finish(false);
                    }
                };
                document.addEventListener('keydown', keyHandler);

                // Update countdown bar
                const timerBar = dialogEl.querySelector('#command-dialog-timer-bar');
                const timerText = dialogEl.querySelector('#command-dialog-timer-text');
                const confirmBtn = dialogEl.querySelector('#command-dialog-confirm-btn');
                const cancelBtn = dialogEl.querySelector('#command-dialog-cancel-btn');
                const closeBtn = dialogEl.querySelector('#command-dialog-close-btn');

                const updateTimerDisplay = () => {
                    if (timerText) timerText.textContent = `${remainingTime.toFixed(1)}s`;
                    if (timerBar) {
                        const pct = Math.max(0, Math.min(100, (remainingTime / 5.0) * 100));
                        timerBar.style.width = `${pct}%`;
                        if (pct < 30) {
                            timerBar.className = 'bg-red-600 h-full transition-all duration-75';
                        } else if (pct < 60) {
                            timerBar.className = 'bg-amber-500 h-full transition-all duration-75';
                        } else {
                            timerBar.className = 'bg-emerald-600 h-full transition-all duration-75';
                        }
                    }
                };

                updateTimerDisplay();

                // 5-second countdown interval (50ms tick)
                this.dialogCountdownTimer = setInterval(() => {
                    remainingTime -= 0.05;
                    if (remainingTime <= 0) {
                        this.logToConsole(`[SAFETY TIMEOUT] Command dialog for [${type}] auto-cancelled after 5.0s.`, 'WARNING');
                        finish(false);
                    } else {
                        updateTimerDisplay();
                    }
                }, 50);

                // Button bindings
                if (cancelBtn) {
                    cancelBtn.onclick = () => finish(false);
                }
                if (closeBtn) {
                    closeBtn.onclick = () => finish(false);
                }

                if (confirmBtn) {
                    confirmBtn.onclick = () => {
                        // Double confirmation for pyrotechnic deployment (DEP)
                        if (type === 'DEP' && step === 1) {
                            step = 2;
                            remainingTime = 5.0; // Reset 5-second countdown for step 2
                            updateTimerDisplay();

                            this.renderDialogStep2(dialogEl, {
                                cmdType: type,
                                params,
                                onConfirmDouble: () => {
                                    finish(true);
                                }
                            });
                            return;
                        }

                        // Normal confirmation
                        finish(true);
                    };
                }
            });
        }

        /**
         * Ensures the `#command-dialog` modal element exists with proper layout in the DOM
         * @returns {HTMLElement}
         */
        ensureDialogElement() {
            let el = document.getElementById('command-dialog');
            if (!el) {
                el = document.createElement('div');
                el.id = 'command-dialog';
                document.body.appendChild(el);
            }

            el.className = 'fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 select-none hidden';
            el.innerHTML = `
                <div class="bg-white border-2 border-slate-700 rounded-xl shadow-2xl max-w-lg w-full overflow-hidden flex flex-col font-sans animate-in fade-in zoom-in-95 duration-150">
                    <!-- Header -->
                    <div class="flex items-center justify-between px-5 py-3.5 border-b border-slate-200 bg-slate-50">
                        <div class="flex items-center gap-2">
                            <span class="w-3 h-3 rounded-full bg-blue-600 animate-pulse"></span>
                            <h3 id="command-dialog-title" class="text-sm font-black text-slate-900 tracking-wider uppercase">
                                Uplink Command Confirmation
                            </h3>
                        </div>
                        <button id="command-dialog-close-btn" class="text-slate-400 hover:text-slate-800 p-1 rounded hover:bg-slate-200 text-lg font-bold leading-none transition-colors" title="Cancel (Esc)">&times;</button>
                    </div>

                    <!-- Body Content -->
                    <div id="command-dialog-body" class="p-5 space-y-4 text-slate-800">
                        <!-- Yellow Warning Banner for Dangerous Commands -->
                        <div id="command-dialog-warning-banner" class="hidden rounded-lg p-3.5 border-2 text-xs flex items-start gap-3 bg-amber-100 border-amber-500 text-amber-950 font-semibold shadow-sm">
                            <div class="text-amber-700 font-bold text-base leading-none">⚠️</div>
                            <div id="command-dialog-warning-text" class="font-bold text-amber-950">Warning</div>
                        </div>

                        <!-- Command Details -->
                        <div class="bg-slate-50 border border-slate-200 rounded-lg p-3.5 space-y-2.5 text-xs">
                            <div class="flex justify-between items-center py-1 border-b border-slate-200">
                                <span class="text-slate-500 font-semibold uppercase tracking-wider">Command Name:</span>
                                <span id="command-dialog-name" class="font-bold text-slate-900 text-sm">CMD_NAME</span>
                            </div>
                            <div class="flex justify-between items-center py-1 border-b border-slate-200">
                                <span class="text-slate-500 font-semibold uppercase tracking-wider">Command ID & Type:</span>
                                <span id="command-dialog-badge" class="font-mono font-bold px-2 py-0.5 rounded bg-slate-200 text-slate-900 border border-slate-300">#1 [ARM]</span>
                            </div>
                            <div class="flex justify-between items-center py-1 border-b border-slate-200">
                                <span class="text-slate-500 font-semibold uppercase tracking-wider">Parameters:</span>
                                <span id="command-dialog-params" class="font-mono font-bold text-blue-700">None</span>
                            </div>
                            <div class="py-1">
                                <span class="text-slate-500 font-semibold uppercase tracking-wider block mb-1">Built Packet String:</span>
                                <code id="command-dialog-packet-str" class="block bg-slate-900 text-emerald-400 font-mono text-xs p-2 rounded break-all select-all font-semibold shadow-inner">
                                    $CMD...
                                </code>
                            </div>
                            <div class="py-1">
                                <span class="text-slate-500 font-semibold uppercase tracking-wider block mb-1">Packet Hex Dump:</span>
                                <code id="command-dialog-packet-hex" class="block bg-slate-100 text-slate-700 font-mono text-[11px] p-2 rounded border border-slate-300 break-all select-all">
                                    00 00
                                </code>
                            </div>
                        </div>

                        <!-- Stage 2 Double Confirmation Slot for DEP -->
                        <div id="command-dialog-step2-slot"></div>

                        <!-- 5-Second Countdown Timer Bar -->
                        <div class="space-y-1 pt-1">
                            <div class="flex justify-between text-[11px] text-slate-600 font-bold uppercase tracking-wider">
                                <span>Auto-Cancel Safety Timeout:</span>
                                <span id="command-dialog-timer-text" class="text-red-600 font-mono font-bold">5.0s</span>
                            </div>
                            <div class="w-full bg-slate-200 h-2 rounded-full overflow-hidden border border-slate-300">
                                <div id="command-dialog-timer-bar" class="bg-emerald-600 h-full w-full transition-all duration-75"></div>
                            </div>
                        </div>
                    </div>

                    <!-- Footer Buttons: Confirm Send (green) and Cancel (gray) -->
                    <div class="flex items-center justify-end gap-3 px-5 py-3.5 border-t border-slate-200 bg-slate-50">
                        <button id="command-dialog-cancel-btn" type="button" class="px-4 py-2 text-xs font-bold text-slate-700 bg-slate-200 hover:bg-slate-300 active:bg-slate-400 rounded-lg border border-slate-300 transition-colors uppercase tracking-wider shadow-sm">
                            Cancel
                        </button>
                        <button id="command-dialog-confirm-btn" type="button" class="px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 rounded-lg shadow-md transition-colors uppercase tracking-wider flex items-center gap-1.5">
                            <span>Confirm Send</span>
                        </button>
                    </div>
                </div>
            `;
            return el;
        }

        /**
         * Renders content inside the confirmation modal dialog
         */
        renderDialogContent(dialogEl, data) {
            const { cmdId, cmdType, config, params, packet, hexDump } = data;

            const badgeEl = dialogEl.querySelector('#command-dialog-badge');
            const nameEl = dialogEl.querySelector('#command-dialog-name');
            const paramsEl = dialogEl.querySelector('#command-dialog-params');
            const packetStrEl = dialogEl.querySelector('#command-dialog-packet-str');
            const packetHexEl = dialogEl.querySelector('#command-dialog-packet-hex');
            const warningBanner = dialogEl.querySelector('#command-dialog-warning-banner');
            const warningText = dialogEl.querySelector('#command-dialog-warning-text');
            const step2Slot = dialogEl.querySelector('#command-dialog-step2-slot');
            const confirmBtn = dialogEl.querySelector('#command-dialog-confirm-btn');

            if (step2Slot) step2Slot.innerHTML = '';

            if (badgeEl) badgeEl.textContent = `#${cmdId} [${cmdType}]`;
            if (nameEl) nameEl.textContent = config.name || cmdType;
            if (paramsEl) {
                paramsEl.textContent = (params && params.length > 0) ? `[ ${params.join(', ')} ]` : 'None';
            }
            if (packetStrEl) packetStrEl.textContent = packet.trim();
            if (packetHexEl) packetHexEl.textContent = hexDump;

            // Configure Yellow Warning Banner for dangerous commands
            if (warningBanner && warningText) {
                if (cmdType === 'RST') {
                    warningText.innerHTML = `
                        <div class="font-bold text-amber-900 uppercase tracking-wide">Microcontroller Reset Warning</div>
                        <p class="mt-0.5 text-amber-950 font-medium">${config.warning}</p>
                    `;
                    warningBanner.classList.remove('hidden');
                } else if (cmdType === 'DEP') {
                    const chuteTarget = params[0] == 2 ? 'Main Chute' : 'Drogue Chute';
                    warningText.innerHTML = `
                        <div class="font-bold text-amber-900 uppercase tracking-wide">Pyrotechnic Deployment Warning (${chuteTarget})</div>
                        <p class="mt-0.5 text-amber-950 font-medium">${config.warning}</p>
                    `;
                    warningBanner.classList.remove('hidden');
                } else if (cmdType === 'ARM') {
                    warningText.innerHTML = `
                        <div class="font-bold text-amber-900 uppercase tracking-wide">Flight Systems Arming Warning</div>
                        <p class="mt-0.5 text-amber-950 font-medium">${config.warning}</p>
                    `;
                    warningBanner.classList.remove('hidden');
                } else if (config.warning) {
                    warningText.innerHTML = `
                        <div class="font-bold text-amber-900 uppercase tracking-wide">Command Safety Warning</div>
                        <p class="mt-0.5 text-amber-950 font-medium">${config.warning}</p>
                    `;
                    warningBanner.classList.remove('hidden');
                } else {
                    warningBanner.classList.add('hidden');
                }
            }

            // Confirm button (green)
            if (confirmBtn) {
                if (cmdType === 'DEP') {
                    confirmBtn.className = 'px-5 py-2 text-xs font-bold text-white bg-amber-600 hover:bg-amber-700 active:bg-amber-800 rounded-lg shadow-md transition-colors uppercase tracking-wider flex items-center gap-1.5';
                    confirmBtn.innerHTML = `<span>Proceed to Step 2 &rarr;</span>`;
                } else {
                    confirmBtn.className = 'px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 rounded-lg shadow-md transition-colors uppercase tracking-wider flex items-center gap-1.5';
                    confirmBtn.innerHTML = `<span>Confirm Send</span>`;
                }
            }
        }

        /**
         * Renders Stage 2 double-confirmation for Pyrotechnic Deployment (DEP)
         */
        renderDialogStep2(dialogEl, data) {
            const { params, onConfirmDouble } = data;
            const chuteName = params[0] == 2 ? 'MAIN CHUTE' : 'DROGUE CHUTE';
            const step2Slot = dialogEl.querySelector('#command-dialog-step2-slot');
            const confirmBtn = dialogEl.querySelector('#command-dialog-confirm-btn');

            if (!step2Slot) return;

            step2Slot.innerHTML = `
                <div class="bg-red-100 border-2 border-red-700 rounded-lg p-3.5 space-y-2.5 text-xs animate-in fade-in duration-150">
                    <div class="flex items-center gap-2 text-red-950 font-black tracking-wider uppercase text-xs">
                        <span class="w-2.5 h-2.5 rounded-full bg-red-600 animate-ping"></span>
                        <span>DOUBLE-CONFIRMATION: Pyrotechnic Deployment (${chuteName})</span>
                    </div>
                    <p class="text-red-950 font-bold leading-relaxed">
                        This will trigger pyrotechnic deployment. Ensure ground recovery perimeter is clear of personnel before firing squib.
                    </p>
                    <label class="flex items-start gap-2.5 text-red-950 font-bold cursor-pointer select-none pt-1">
                        <input type="checkbox" id="command-dialog-dep-checkbox" class="mt-0.5 w-4 h-4 text-red-700 border-red-500 rounded focus:ring-red-600 accent-red-600 cursor-pointer">
                        <span class="leading-tight text-[11px]">
                            I verify recovery area is clear and confirm pyrotechnic firing
                        </span>
                    </label>
                </div>
            `;

            if (confirmBtn) {
                // Confirm button becomes green once verified
                confirmBtn.className = 'px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 active:bg-emerald-800 rounded-lg shadow-md transition-colors uppercase tracking-wider flex items-center gap-1.5 cursor-not-allowed opacity-60';
                confirmBtn.innerHTML = `<span>Confirm Send (Double-Confirmed)</span>`;
                confirmBtn.disabled = true;

                const checkbox = step2Slot.querySelector('#command-dialog-dep-checkbox');
                if (checkbox) {
                    checkbox.onchange = () => {
                        if (checkbox.checked) {
                            confirmBtn.disabled = false;
                            confirmBtn.classList.remove('cursor-not-allowed', 'opacity-60');
                        } else {
                            confirmBtn.disabled = true;
                            confirmBtn.classList.add('cursor-not-allowed', 'opacity-60');
                        }
                    };
                }

                confirmBtn.onclick = () => {
                    const cb = step2Slot.querySelector('#command-dialog-dep-checkbox');
                    if (cb && cb.checked) {
                        onConfirmDouble();
                    }
                };
            }
        }

        /**
         * Event Console Integration
         * Appends styled entry to `#event-log` (or `#event-console`)
         * 
         * Levels:
         *   INFO (blue)
         *   WARNING (amber)
         *   CRITICAL (red)
         *   COMMAND_ACK (green)
         * 
         * @param {string} message 
         * @param {'INFO'|'WARNING'|'CRITICAL'|'COMMAND_ACK'} level 
         */
        logToConsole(message, level = 'INFO') {
            const now = new Date();
            const h = String(now.getUTCHours()).padStart(2, '0');
            const m = String(now.getUTCMinutes()).padStart(2, '0');
            const s = String(now.getUTCSeconds()).padStart(2, '0');
            const ms = String(now.getUTCMilliseconds()).padStart(3, '0');
            const timeStr = `${h}:${m}:${s}.${ms} UTC`;
            const cleanLevel = String(level).toUpperCase();

            const entry = {
                timestamp: timeStr,
                timeMs: now.getTime(),
                level: cleanLevel,
                message: String(message)
            };

            this.eventLogs.push(entry);
            if (this.eventLogs.length > 500) {
                this.eventLogs.shift();
            }

            // Output to browser console
            const styles = {
                INFO: 'color: #3b82f6; font-weight: bold;',
                WARNING: 'color: #f59e0b; font-weight: bold;',
                CRITICAL: 'color: #ef4444; font-weight: bold; background: #450a0a; padding: 1px 4px;',
                COMMAND_ACK: 'color: #10b981; font-weight: bold;'
            };
            console.log(`%c[${cleanLevel}]%c ${timeStr} - ${message}`, styles[cleanLevel] || styles.INFO, 'color: inherit;');

            // DOM insertion
            if (typeof document !== 'undefined') {
                const logContainer = document.getElementById('event-log') ||
                    document.getElementById('event-console') ||
                    document.querySelector('.event-log') ||
                    document.getElementById('console-log');

                if (logContainer) {
                    const row = document.createElement('div');
                    row.className = 'flex items-start gap-2 py-0.5 px-1 font-mono text-[11px] leading-relaxed select-text hover:bg-slate-900/50 transition-colors';

                    let badgeClass = 'text-blue-300 bg-blue-950/80 border border-blue-500 font-medium';
                    let textClass = 'text-slate-200';

                    switch (cleanLevel) {
                        case 'WARNING':
                            badgeClass = 'text-amber-300 bg-amber-950/80 border border-amber-500 font-bold';
                            textClass = 'text-amber-200 font-medium';
                            break;
                        case 'CRITICAL':
                            badgeClass = 'text-red-300 bg-red-950/90 border border-red-500 font-bold animate-pulse';
                            textClass = 'text-red-200 font-bold';
                            break;
                        case 'COMMAND_ACK':
                            badgeClass = 'text-emerald-300 bg-emerald-950/80 border border-emerald-500 font-bold';
                            textClass = 'text-emerald-200 font-semibold';
                            break;
                        case 'INFO':
                        default:
                            badgeClass = 'text-blue-300 bg-blue-950/80 border border-blue-500 font-medium';
                            textClass = 'text-slate-200';
                            break;
                    }

                    row.innerHTML = `
                        <span class="text-slate-500 select-none shrink-0 font-mono">[${timeStr}]</span>
                        <span class="px-1.5 py-0.2 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 ${badgeClass}">${cleanLevel}</span>
                        <span class="flex-1 break-all ${textClass}">${this.escapeHtml(message)}</span>
                    `;

                    logContainer.appendChild(row);

                    // Maintain max 500 rows in DOM
                    while (logContainer.children.length > 500) {
                        logContainer.removeChild(logContainer.firstChild);
                    }

                    // Auto-scroll to latest
                    logContainer.scrollTop = logContainer.scrollHeight;
                }
            }

            // Dispatch event for UI modules
            if (typeof window !== 'undefined') {
                window.dispatchEvent(new CustomEvent('cansat:event-logged', { detail: entry }));
            }
        }

        /**
         * Escape HTML to prevent injection in console
         */
        escapeHtml(str) {
            return String(str)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        }

        /**
         * Record command history
         */
        recordCommandHistory(entry, status) {
            this.commandHistory.push({
                cmdId: entry.cmdId,
                cmdType: entry.cmdType,
                params: entry.params,
                packet: entry.packet,
                sentAt: entry.sentAt,
                status
            });

            if (this.commandHistory.length > 100) {
                this.commandHistory.shift();
            }

            this.updateCommandHistoryUI();
        }

        /**
         * Update status in command history table
         */
        updateHistoryStatus(cmdId, status) {
            const hist = this.commandHistory.find(h => h.cmdId === cmdId);
            if (hist) {
                hist.status = status;
                hist.updatedAt = Date.now();
            }
            this.updateCommandHistoryUI();
        }

        /**
         * Updates Arm UI components across the GCS dashboard
         */
        updateArmUI() {
            if (typeof document === 'undefined') return;

            const armed = this.isSystemArmed;

            // Update badge elements
            const badgeSelectors = ['#arm-status-badge', '#arm-state-indicator', '#system-arm-badge'];
            badgeSelectors.forEach(sel => {
                const el = document.querySelector(sel);
                if (el) {
                    if (armed) {
                        el.textContent = 'ARMED';
                        el.className = 'px-2 py-0.5 rounded text-xs font-black uppercase tracking-wider bg-red-600 text-white border border-red-700 shadow-sm animate-pulse';
                    } else {
                        el.textContent = 'DISARMED';
                        el.className = 'px-2 py-0.5 rounded text-xs font-bold uppercase tracking-wider bg-slate-200 text-slate-700 border border-slate-300';
                    }
                }
            });

            // Update Arm toggle button if present
            const armBtn = document.getElementById('arm-toggle-btn') || document.getElementById('btn-arm-toggle');
            if (armBtn) {
                if (armed) {
                    armBtn.textContent = 'DISARM SYSTEM';
                    armBtn.className = 'px-3 py-1.5 text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white rounded shadow transition-colors uppercase';
                } else {
                    armBtn.textContent = 'ARM SYSTEM';
                    armBtn.className = 'px-3 py-1.5 text-xs font-bold bg-red-600 hover:bg-red-700 text-white rounded shadow transition-colors uppercase';
                }
            }
        }

        /**
         * Updates Pending Commands UI container
         */
        updatePendingUI() {
            if (typeof document === 'undefined') return;

            const pending = this.getPendingCommands();

            // Badge count
            const countBadge = document.getElementById('pending-commands-count');
            if (countBadge) {
                countBadge.textContent = String(pending.length);
                if (pending.length > 0) {
                    countBadge.classList.remove('hidden');
                } else {
                    countBadge.classList.add('hidden');
                }
            }

            // Pending list container
            const container = document.getElementById('pending-commands-list');
            if (container) {
                if (pending.length === 0) {
                    container.innerHTML = `<div class="text-xs text-slate-400 italic p-2 text-center">No pending uplink commands</div>`;
                } else {
                    container.innerHTML = pending.map(cmd => `
                        <div class="flex items-center justify-between p-2 border-b border-slate-200 text-xs font-mono bg-amber-50">
                            <div>
                                <span class="font-bold text-slate-900">#${cmd.cmdId} [${cmd.cmdType}]</span>
                                <span class="text-slate-500 text-[10px] ml-1">Retry: ${cmd.retries}/${cmd.maxRetries}</span>
                            </div>
                            <button onclick="window.commandProtocolInstance && window.commandProtocolInstance.cancelPending(${cmd.cmdId})" class="text-red-600 hover:text-red-800 text-[10px] font-bold uppercase px-1.5 py-0.5 bg-red-50 border border-red-300 rounded hover:bg-red-100">
                                Cancel
                            </button>
                        </div>
                    `).join('');
                }
            }
        }

        /**
         * Updates Command History UI table
         */
        updateCommandHistoryUI() {
            if (typeof document === 'undefined') return;

            const container = document.getElementById('command-history-tbody') || document.getElementById('command-history-list');
            if (!container) return;

            const recent = this.commandHistory.slice(-15).reverse();
            if (container.tagName.toUpperCase() === 'TBODY') {
                container.innerHTML = recent.map(cmd => {
                    let statusClass = 'text-blue-700 font-semibold';
                    if (cmd.status === 'ACK_OK') statusClass = 'text-emerald-700 font-bold';
                    if (cmd.status === 'TIMEOUT' || cmd.status === 'FAIL') statusClass = 'text-red-700 font-bold';
                    if (cmd.status === 'CANCELLED') statusClass = 'text-slate-500 font-medium';

                    const d = new Date(cmd.sentAt);
                    const h = String(d.getUTCHours()).padStart(2, '0');
                    const m = String(d.getUTCMinutes()).padStart(2, '0');
                    const s = String(d.getUTCSeconds()).padStart(2, '0');
                    const timeStr = `${h}:${m}:${s} UTC`;
                    return `
                        <tr class="border-b border-slate-100 text-xs hover:bg-slate-50">
                            <td class="p-1.5 font-mono text-slate-500">${timeStr}</td>
                            <td class="p-1.5 font-mono font-bold text-slate-800">#${cmd.cmdId}</td>
                            <td class="p-1.5 font-bold text-slate-900">${cmd.cmdType}</td>
                            <td class="p-1.5 font-mono text-[11px] text-slate-600">${cmd.params.join(', ') || '-'}</td>
                            <td class="p-1.5 ${statusClass}">${cmd.status}</td>
                        </tr>
                    `;
                }).join('');
            }
        }

        /* ====================================================================
         * Quick Command Methods
         * ==================================================================== */

        /**
         * Arm flight systems
         */
        async arm() {
            return this.sendCommand('ARM', [1], true);
        }

        /**
         * Disarm flight systems
         */
        async disarm() {
            return this.sendCommand('ARM', [0], true);
        }

        /**
         * Reset flight computer microcontroller
         */
        async resetMCU() {
            return this.sendCommand('RST', [], true);
        }

        /**
         * Trigger backup drogue parachute pyrotechnic deployment
         */
        async triggerDrogue() {
            return this.sendCommand('DEP', [1], true);
        }

        /**
         * Trigger backup main parachute pyrotechnic deployment
         */
        async triggerMain() {
            return this.sendCommand('DEP', [2], true);
        }

        /**
         * Force start onboard telemetry flash logging
         */
        async startLogging() {
            return this.sendCommand('LOG', [1], false);
        }

        /**
         * Force stop onboard telemetry flash logging
         */
        async stopLogging() {
            return this.sendCommand('LOG', [0], false);
        }

        /**
         * Ping / loopback test
         * @param {number} [seq]
         */
        async ping(seq) {
            const sequenceNumber = (seq !== undefined && seq !== null) ? seq : this.getNextPingSeq();
            return this.sendCommand('PNG', [sequenceNumber], false);
        }

        /**
         * Trigger payload camera still frame capture
         */
        async captureImage() {
            return this.sendCommand('CAM', [1], false);
        }

        /**
         * Turn recovery buzzer beacon ON
         */
        async buzzerOn() {
            return this.sendCommand('BZR', [1], false);
        }

        /**
         * Turn recovery buzzer beacon OFF
         */
        async buzzerOff() {
            return this.sendCommand('BZR', [0], false);
        }

        /**
         * Send sensor calibration data
         * @param {string} calType 
         * @param {number|string} calValue 
         */
        async calibrate(calType, calValue) {
            return this.sendCommand('CAL', [calType, calValue], true);
        }

        /**
         * Toggle CanSat flight computer simulation mode
         * @param {boolean} enable 
         */
        async setSimulation(enable) {
            return this.sendCommand('SIM', [enable ? 1 : 0], true);
        }
    }

    // Attach to global window
    window.CommandProtocol = CommandProtocol;

    // Auto-instantiate singleton helper if requested or available
    if (typeof window.commandProtocolInstance === 'undefined') {
        window.commandProtocolInstance = new CommandProtocol(window.telemetryEngine || null);
    }

    // Connect global triggerCommand in index.html to CommandProtocol
    window.triggerCommand = function(cmdKey, cmdDesc) {
        if (!window.commandProtocolInstance) {
            window.commandProtocolInstance = new CommandProtocol(window.telemetryEngine || null);
        }
        const cp = window.commandProtocolInstance;
        const key = String(cmdKey).toUpperCase().trim();

        switch (key) {
            case 'PING':
            case 'PNG':
                return cp.ping();
            case 'DEPLOY_DROGUE':
            case 'DROGUE':
                return cp.triggerDrogue();
            case 'DEPLOY_MAIN':
            case 'MAIN':
                return cp.triggerMain();
            case 'CAL_PRESSURE':
                return cp.calibrate('BARO', 1013.25);
            case 'BUZZER_ON':
            case 'BUZZER':
                return cp.buzzerOn();
            case 'BUZZER_OFF':
                return cp.buzzerOff();
            case 'ARM':
                return cp.arm();
            case 'DISARM':
                return cp.disarm();
            case 'RESET_MCU':
            case 'RST':
                return cp.resetMCU();
            case 'START_LOG':
            case 'LOG_ON':
                return cp.startLogging();
            case 'STOP_LOG':
            case 'LOG_OFF':
                return cp.stopLogging();
            case 'SIM_ENABLE':
            case 'SIM_ON':
                return cp.setSimulation(true);
            case 'SIM_DISABLE':
            case 'SIM_OFF':
                return cp.setSimulation(false);
            default:
                return cp.sendCommand(key, [], true);
        }
    };

})(typeof window !== 'undefined' ? window : this);
