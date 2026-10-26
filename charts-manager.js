/**
 * ============================================================================
 * CanSat Ground Control Station (GCS) - Charts Manager Module
 * ============================================================================
 * Architecture: Mission-Critical Aerospace Telemetry Dashboard
 * Framework: Chart.js 4.x
 * Target: Sunlight-Readable White High-Contrast Theme
 * Performance: 10Hz Real-Time Telemetry with RAF 4Hz Batching
 * ============================================================================
 */

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.ChartsManager = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    /**
     * Helper: Cross-browser rounded rectangle path on CanvasRenderingContext2D
     */
    function drawRoundedRect(ctx, x, y, width, height, radius) {
        if (typeof ctx.roundRect === 'function') {
            ctx.beginPath();
            ctx.roundRect(x, y, width, height, radius);
            return;
        }
        const r = Math.min(radius, width / 2, height / 2);
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + width - r, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + r);
        ctx.lineTo(x + width, y + height - r);
        ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
        ctx.lineTo(x + r, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    }

    /**
     * ChartsManager Class
     * Manages all real-time flight telemetry visualizations for the CanSat GCS.
     */
    class ChartsManager {
        /**
         * @param {Object} [options] Configuration options
         * @param {number} [options.windowSeconds=120] Visible rolling time window in seconds
         * @param {number} [options.maxPoints=1200] Maximum visible points in rolling window
         * @param {number} [options.maxUpdateRate=4] Maximum chart.update() calls per second (batching)
         */
        constructor(options = {}) {
            this.windowSeconds = options.windowSeconds || 120;
            this.maxPoints = options.maxPoints || 1200;
            this.maxUpdateRate = options.maxUpdateRate || 4; // 4Hz throttled render
            this.renderIntervalMs = 1000 / this.maxUpdateRate;

            // Chart instances
            this.altitudeChart = null;
            this.envChart = null;
            this.accelChart = null;
            this.gyroChart = null;
            this.magChart = null;
            this.sparklines = new Map();

            // Apogee tracking
            this.apogee = {
                time: null,
                altitude: -Infinity,
                auto: true
            };
            this.predictedApogee = null;

            // Render scheduling & batching
            this.needsAltitudeUpdate = false;
            this.needsEnvUpdate = false;
            this.needsIMUUpdate = false;
            this.pendingSparklines = new Set();

            this.lastRenderTime = 0;
            this.isRenderScheduled = false;
            this.throttleTimer = null;
            this.rafId = null;

            // Theme colors (Sunlight-readable high-contrast aerospace palette)
            this.theme = {
                fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                textPrimary: '#111827',     // gray-900
                textSecondary: '#4B5563',   // gray-600
                textMuted: '#9CA3AF',       // gray-400
                gridColor: '#E5E7EB',       // gray-200
                axisBorder: '#9CA3AF',      // gray-400
                cardBg: '#FFFFFF',
                blue: '#2563EB',            // blue-600 (Altitude)
                purple: '#7C3AED',          // violet-600 (Pressure)
                red: '#DC2626',             // red-600 (Temperature & Apogee)
                emerald: '#059669',         // emerald-600
                amber: '#D97706'            // amber-600
            };

            this._onResize = this._onResize.bind(this);
            if (typeof window !== 'undefined') {
                window.addEventListener('resize', this._onResize);
            }
        }

        /**
         * Set theme to Dark (aerospace cockpit) or Light (outdoor sunlight)
         * @param {'dark'|'light'} mode
         */
        setTheme(mode = 'dark') {
            const isDark = mode === 'dark';
            this.theme.textPrimary = isDark ? '#f8fafc' : '#111827';
            this.theme.textSecondary = isDark ? '#94a3b8' : '#4B5563';
            this.theme.textMuted = isDark ? '#64748b' : '#9CA3AF';
            this.theme.gridColor = isDark ? 'rgba(255, 255, 255, 0.08)' : '#E5E7EB';
            this.theme.axisBorder = isDark ? '#334155' : '#9CA3AF';
            this.theme.cardBg = isDark ? '#0f172a' : '#FFFFFF';

            [this.altitudeChart, this.envChart].forEach(chart => {
                if (!chart || !chart.options) return;
                if (chart.options.scales) {
                    Object.values(chart.options.scales).forEach(scale => {
                        if (scale.ticks) scale.ticks.color = this.theme.textSecondary;
                        if (scale.grid) scale.grid.color = this.theme.gridColor;
                    });
                }
                chart.update('none');
            });
        }

        // ====================================================================
        // INITIALIZATION METHODS
        // ====================================================================

        /**
         * Initialize the primary Altitude vs Time chart
         * @param {string|HTMLCanvasElement} canvasTarget Canvas ID or DOM element
         * @returns {Chart|null} Created Chart.js instance
         */
        initAltitudeChart(canvasTarget = 'altitude-chart') {
            const canvas = this._resolveCanvas(canvasTarget);
            if (!canvas) return null;

            if (this.altitudeChart) {
                this.altitudeChart.destroy();
                this.altitudeChart = null;
            }

            const ctx = canvas.getContext('2d');
            const self = this;

            // Inline custom plugin for apogee & predicted apogee overlays
            const apogeeOverlayPlugin = {
                id: 'apogeeOverlayPlugin',
                afterDatasetsDraw: (chart) => {
                    const { ctx: c, chartArea, scales } = chart;
                    if (!chartArea || !scales.x || !scales.y) return;

                    c.save();

                    // 1. Draw Predicted Apogee Horizontal Guideline
                    if (self.predictedApogee !== null && !isNaN(self.predictedApogee)) {
                        const yPixel = scales.y.getPixelForValue(self.predictedApogee);
                        if (yPixel >= chartArea.top && yPixel <= chartArea.bottom) {
                            c.strokeStyle = '#DC2626';
                            c.lineWidth = 1.5;
                            c.setLineDash([6, 4]);
                            c.beginPath();
                            c.moveTo(chartArea.left, yPixel);
                            c.lineTo(chartArea.right, yPixel);
                            c.stroke();
                            c.setLineDash([]);

                            // Label badge on top-right of the guideline
                            const label = `PRED APOGEE: ${self.predictedApogee.toFixed(1)} m`;
                            c.font = `600 10px ${self.theme.fontFamily}`;
                            const textMetrics = c.measureText(label);
                            const badgeWidth = textMetrics.width + 12;
                            const badgeHeight = 16;
                            const badgeX = chartArea.right - badgeWidth - 6;
                            const badgeY = yPixel - badgeHeight - 2;

                            c.fillStyle = 'rgba(254, 242, 242, 0.95)';
                            c.strokeStyle = '#DC2626';
                            c.lineWidth = 1;
                            drawRoundedRect(c, badgeX, badgeY, badgeWidth, badgeHeight, 3);
                            c.fill();
                            c.stroke();

                            c.fillStyle = '#DC2626';
                            c.textAlign = 'center';
                            c.textBaseline = 'middle';
                            c.fillText(label, badgeX + badgeWidth / 2, badgeY + badgeHeight / 2);
                        }
                    }

                    // 2. Draw Detected/Set Apogee Callout
                    if (self.apogee && self.apogee.altitude > -Infinity && self.apogee.time !== null) {
                        const xPixel = scales.x.getPixelForValue(self.apogee.time);
                        const yPixel = scales.y.getPixelForValue(self.apogee.altitude);

                        if (xPixel >= chartArea.left && xPixel <= chartArea.right &&
                            yPixel >= chartArea.top && yPixel <= chartArea.bottom) {

                            // Outer pulse aura
                            c.beginPath();
                            c.arc(xPixel, yPixel, 7, 0, Math.PI * 2);
                            c.fillStyle = 'rgba(220, 38, 38, 0.25)';
                            c.fill();

                            // Inner solid red point
                            c.beginPath();
                            c.arc(xPixel, yPixel, 4, 0, Math.PI * 2);
                            c.fillStyle = '#DC2626';
                            c.fill();
                            c.lineWidth = 2;
                            c.strokeStyle = '#FFFFFF';
                            c.stroke();

                            // Vertical drop line to x-axis
                            c.setLineDash([2, 3]);
                            c.strokeStyle = 'rgba(220, 38, 38, 0.45)';
                            c.lineWidth = 1;
                            c.beginPath();
                            c.moveTo(xPixel, yPixel + 7);
                            c.lineTo(xPixel, chartArea.bottom);
                            c.stroke();
                            c.setLineDash([]);

                            // Apogee Callout Box
                            const mainText = `APOGEE: ${self.apogee.altitude.toFixed(1)} m`;
                            const subText = `T+${self.apogee.time.toFixed(1)}s`;
                            c.font = `bold 10px ${self.theme.fontFamily}`;
                            const wMain = c.measureText(mainText).width;
                            c.font = `500 8.5px ${self.theme.fontFamily}`;
                            const wSub = c.measureText(subText).width;

                            const boxW = Math.max(wMain, wSub) + 14;
                            const boxH = 28;
                            let boxX = xPixel - boxW / 2;
                            let boxY = yPixel - boxH - 9;

                            // Edge boundaries
                            if (boxY < chartArea.top + 4) boxY = yPixel + 10;
                            if (boxX < chartArea.left + 4) boxX = chartArea.left + 4;
                            if (boxX + boxW > chartArea.right - 4) boxX = chartArea.right - boxW - 4;

                            // Badge background with border
                            c.fillStyle = 'rgba(255, 255, 255, 0.98)';
                            c.strokeStyle = '#DC2626';
                            c.lineWidth = 1.5;
                            drawRoundedRect(c, boxX, boxY, boxW, boxH, 4);
                            c.fill();
                            c.stroke();

                            // Badge text
                            c.textAlign = 'center';
                            c.textBaseline = 'top';
                            c.fillStyle = '#DC2626';
                            c.font = `bold 9.5px ${self.theme.fontFamily}`;
                            c.fillText(mainText, boxX + boxW / 2, boxY + 4);

                            c.fillStyle = '#4B5563';
                            c.font = `500 8.5px ${self.theme.fontFamily}`;
                            c.fillText(subText, boxX + boxW / 2, boxY + 16);
                        }
                    }

                    c.restore();
                }
            };

            const config = {
                type: 'line',
                data: {
                    datasets: [{
                        label: 'Altitude (m)',
                        data: [],
                        borderColor: this.theme.blue,
                        borderWidth: 2,
                        tension: 0.15,
                        fill: true,
                        backgroundColor: (context) => {
                            const chart = context.chart;
                            const { ctx: c, chartArea } = chart;
                            if (!chartArea) return 'rgba(37, 99, 235, 0.15)';
                            const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                            gradient.addColorStop(0, 'rgba(37, 99, 235, 0.32)');
                            gradient.addColorStop(0.65, 'rgba(37, 99, 235, 0.08)');
                            gradient.addColorStop(1, 'rgba(37, 99, 235, 0.0)');
                            return gradient;
                        },
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        pointHoverBackgroundColor: this.theme.blue,
                        pointHoverBorderColor: '#FFFFFF',
                        pointHoverBorderWidth: 2
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 0 }, // Zero flicker real-time
                    normalized: true,
                    parsing: false,
                    interaction: {
                        mode: 'nearest',
                        axis: 'x',
                        intersect: false
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top',
                            align: 'end',
                            labels: {
                                color: this.theme.textPrimary,
                                font: { family: this.theme.fontFamily, size: 11, weight: '600' },
                                boxWidth: 12,
                                boxHeight: 3,
                                usePointStyle: false,
                                padding: 12
                            }
                        },
                        tooltip: {
                            enabled: true,
                            backgroundColor: 'rgba(17, 24, 39, 0.95)',
                            titleColor: '#FFFFFF',
                            titleFont: { family: this.theme.fontFamily, size: 11, weight: '700' },
                            bodyColor: '#F3F4F6',
                            bodyFont: { family: this.theme.fontFamily, size: 11 },
                            borderColor: '#374151',
                            borderWidth: 1,
                            padding: 8,
                            displayColors: true,
                            boxPadding: 4,
                            callbacks: {
                                title: (items) => {
                                    if (!items.length) return '';
                                    const val = items[0].parsed.x ?? items[0].raw.x;
                                    return `T+${Number(val).toFixed(1)}s`;
                                },
                                label: (item) => {
                                    const val = item.parsed.y ?? item.raw.y;
                                    return ` Altitude: ${Number(val).toFixed(2)} m`;
                                }
                            }
                        },
                        decimation: {
                            enabled: true,
                            algorithm: 'lttb',
                            samples: 600
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            min: 0,
                            max: this.windowSeconds,
                            title: {
                                display: true,
                                text: 'Mission Elapsed Time (s)',
                                color: this.theme.textPrimary,
                                font: { family: this.theme.fontFamily, size: 11, weight: '600' }
                            },
                            grid: {
                                color: this.theme.gridColor,
                                borderColor: this.theme.axisBorder
                            },
                            ticks: {
                                color: this.theme.textSecondary,
                                font: { family: this.theme.fontFamily, size: 10 },
                                callback: (val) => `${val.toFixed(0)}s`,
                                maxRotation: 0,
                                autoSkip: true,
                                maxTicksLimit: 12
                            }
                        },
                        y: {
                            type: 'linear',
                            position: 'left',
                            suggestedMin: 0,
                            suggestedMax: 100,
                            title: {
                                display: true,
                                text: 'Altitude (m)',
                                color: this.theme.blue,
                                font: { family: this.theme.fontFamily, size: 11, weight: '600' }
                            },
                            grid: {
                                color: this.theme.gridColor,
                                borderColor: this.theme.axisBorder
                            },
                            ticks: {
                                color: this.theme.textSecondary,
                                font: { family: this.theme.fontFamily, size: 10 },
                                callback: (val) => `${val.toFixed(0)} m`
                            }
                        }
                    }
                },
                plugins: [apogeeOverlayPlugin]
            };

            this.altitudeChart = new Chart(ctx, config);
            return this.altitudeChart;
        }

        /**
         * Initialize the dual-axis Pressure & Temperature vs Time chart
         * @param {string|HTMLCanvasElement} canvasTarget Canvas ID or DOM element
         * @returns {Chart|null} Created Chart.js instance
         */
        initEnvironmentChart(canvasTarget = 'env-chart') {
            const canvas = this._resolveCanvas(canvasTarget);
            if (!canvas) return null;

            if (this.envChart) {
                this.envChart.destroy();
                this.envChart = null;
            }

            const ctx = canvas.getContext('2d');
            const config = {
                type: 'line',
                data: {
                    datasets: [
                        {
                            label: 'Pressure (hPa)',
                            data: [],
                            borderColor: this.theme.purple,
                            borderWidth: 2,
                            tension: 0.15,
                            fill: true,
                            yAxisID: 'y-pressure',
                            backgroundColor: (context) => {
                                const chart = context.chart;
                                const { ctx: c, chartArea } = chart;
                                if (!chartArea) return 'rgba(124, 58, 237, 0.1)';
                                const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                                gradient.addColorStop(0, 'rgba(124, 58, 237, 0.22)');
                                gradient.addColorStop(0.7, 'rgba(124, 58, 237, 0.04)');
                                gradient.addColorStop(1, 'rgba(124, 58, 237, 0.0)');
                                return gradient;
                            },
                            pointRadius: 0,
                            pointHoverRadius: 5,
                            pointHoverBackgroundColor: this.theme.purple,
                            pointHoverBorderColor: '#FFFFFF',
                            pointHoverBorderWidth: 2
                        },
                        {
                            label: 'Temperature (°C)',
                            data: [],
                            borderColor: this.theme.red,
                            borderWidth: 2,
                            tension: 0.15,
                            fill: true,
                            yAxisID: 'y-temp',
                            backgroundColor: (context) => {
                                const chart = context.chart;
                                const { ctx: c, chartArea } = chart;
                                if (!chartArea) return 'rgba(220, 38, 38, 0.08)';
                                const gradient = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
                                gradient.addColorStop(0, 'rgba(220, 38, 38, 0.18)');
                                gradient.addColorStop(0.7, 'rgba(220, 38, 38, 0.03)');
                                gradient.addColorStop(1, 'rgba(220, 38, 38, 0.0)');
                                return gradient;
                            },
                            pointRadius: 0,
                            pointHoverRadius: 5,
                            pointHoverBackgroundColor: this.theme.red,
                            pointHoverBorderColor: '#FFFFFF',
                            pointHoverBorderWidth: 2
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 0 },
                    normalized: true,
                    parsing: false,
                    interaction: {
                        mode: 'nearest',
                        axis: 'x',
                        intersect: false
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top',
                            align: 'end',
                            labels: {
                                color: this.theme.textPrimary,
                                font: { family: this.theme.fontFamily, size: 11, weight: '600' },
                                boxWidth: 12,
                                boxHeight: 3,
                                usePointStyle: false,
                                padding: 12
                            }
                        },
                        tooltip: {
                            enabled: true,
                            backgroundColor: 'rgba(17, 24, 39, 0.95)',
                            titleColor: '#FFFFFF',
                            titleFont: { family: this.theme.fontFamily, size: 11, weight: '700' },
                            bodyColor: '#F3F4F6',
                            bodyFont: { family: this.theme.fontFamily, size: 11 },
                            borderColor: '#374151',
                            borderWidth: 1,
                            padding: 8,
                            displayColors: true,
                            boxPadding: 4,
                            callbacks: {
                                title: (items) => {
                                    if (!items.length) return '';
                                    const val = items[0].parsed.x ?? items[0].raw.x;
                                    return `T+${Number(val).toFixed(1)}s`;
                                },
                                label: (item) => {
                                    const val = item.parsed.y ?? item.raw.y;
                                    if (item.datasetIndex === 0) {
                                        return ` Pressure: ${Number(val).toFixed(1)} hPa`;
                                    } else {
                                        return ` Temperature: ${Number(val).toFixed(1)} °C`;
                                    }
                                }
                            }
                        },
                        decimation: {
                            enabled: true,
                            algorithm: 'lttb',
                            samples: 600
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            min: 0,
                            max: this.windowSeconds,
                            title: {
                                display: true,
                                text: 'Mission Elapsed Time (s)',
                                color: this.theme.textPrimary,
                                font: { family: this.theme.fontFamily, size: 11, weight: '600' }
                            },
                            grid: {
                                color: this.theme.gridColor,
                                borderColor: this.theme.axisBorder
                            },
                            ticks: {
                                color: this.theme.textSecondary,
                                font: { family: this.theme.fontFamily, size: 10 },
                                callback: (val) => `${val.toFixed(0)}s`,
                                maxRotation: 0,
                                autoSkip: true,
                                maxTicksLimit: 12
                            }
                        },
                        'y-pressure': {
                            type: 'linear',
                            position: 'left',
                            suggestedMin: 950,
                            suggestedMax: 1050,
                            title: {
                                display: true,
                                text: 'Pressure (hPa)',
                                color: this.theme.purple,
                                font: { family: this.theme.fontFamily, size: 11, weight: '600' }
                            },
                            grid: {
                                color: this.theme.gridColor,
                                borderColor: this.theme.purple
                            },
                            ticks: {
                                color: this.theme.purple,
                                font: { family: this.theme.fontFamily, size: 10 },
                                callback: (val) => `${val.toFixed(0)}`
                            }
                        },
                        'y-temp': {
                            type: 'linear',
                            position: 'right',
                            suggestedMin: 0,
                            suggestedMax: 40,
                            title: {
                                display: true,
                                text: 'Temperature (°C)',
                                color: this.theme.red,
                                font: { family: this.theme.fontFamily, size: 11, weight: '600' }
                            },
                            grid: {
                                drawOnChartArea: false, // Prevent cross-grid clash
                                borderColor: this.theme.red
                            },
                            ticks: {
                                color: this.theme.red,
                                font: { family: this.theme.fontFamily, size: 10 },
                                callback: (val) => `${val.toFixed(0)}°`
                            }
                        }
                    }
                }
            };

            this.envChart = new Chart(ctx, config);
            return this.envChart;
        }

        /**
         * Bonus: Initialize high-performance sparkline mini chart for kinematic gauges
         * @param {string|HTMLCanvasElement} canvasTarget Canvas ID or element
         * @param {Object} [sparkOptions] Sparkline styling
         * @returns {Chart|null} Created Chart.js sparkline instance
         */
        initSparkline(canvasTarget, sparkOptions = {}) {
            const canvas = this._resolveCanvas(canvasTarget);
            if (!canvas) return null;

            const id = canvas.id || `sparkline-${Math.random().toString(36).substr(2, 9)}`;
            if (this.sparklines.has(id)) {
                this.sparklines.get(id).destroy();
                this.sparklines.delete(id);
            }

            const ctx = canvas.getContext('2d');
            const color = sparkOptions.color || this.theme.blue;
            const maxPoints = sparkOptions.maxPoints || 60;

            const config = {
                type: 'line',
                data: {
                    datasets: [{
                        label: sparkOptions.label || 'Value',
                        data: [],
                        borderColor: color,
                        borderWidth: sparkOptions.borderWidth || 1.75,
                        tension: 0.25,
                        fill: Boolean(sparkOptions.fill),
                        backgroundColor: sparkOptions.fillColor || `${color}22`,
                        pointRadius: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: { duration: 0 },
                    normalized: true,
                    parsing: false,
                    events: [], // Completely disable interaction for maximum gauge performance
                    plugins: {
                        legend: { display: false },
                        tooltip: { enabled: false }
                    },
                    scales: {
                        x: { display: false },
                        y: {
                            display: false,
                            min: sparkOptions.min,
                            max: sparkOptions.max
                        }
                    }
                }
            };

            const chart = new Chart(ctx, config);
            chart._sparklineMaxPoints = maxPoints;
            this.sparklines.set(id, chart);
            return chart;
        }

        /**
         * Initialize the 3 stacked IMU Telemetry charts (Accelerometer, Gyroscope, Magnetometer)
         * Matching the exact orientation in the reference photo (Left of 3D Mahony AHRS):
         * - Accel: X (Red), Y (Green), Z (Blue)
         * - Gyro:  X (Red), Y (Green), Z (Blue)
         * - Mag:   X (Red), Y (Green), Z (Blue) with "Time (seconds)" axis
         */
        initIMUCharts(accelTarget = 'chart-accel', gyroTarget = 'chart-gyro', magTarget = 'chart-mag') {
            const self = this;
            const commonOptions = (title, showXAxis = false, ySuggestedMin = -20, ySuggestedMax = 20) => ({
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 0 },
                normalized: true,
                interaction: { mode: 'nearest', intersect: false },
                plugins: {
                    legend: {
                        display: true,
                        position: 'top',
                        align: 'end',
                        labels: {
                            boxWidth: 14,
                            boxHeight: 2,
                            color: self.theme.textSecondary,
                            font: { family: self.theme.fontFamily, size: 10, weight: 'bold' },
                            padding: 6
                        }
                    },
                    tooltip: { enabled: true }
                },
                scales: {
                    x: {
                        type: 'linear',
                        display: showXAxis,
                        min: 0,
                        max: 20,
                        title: {
                            display: showXAxis,
                            text: 'Time (seconds)',
                            color: self.theme.textSecondary,
                            font: { family: self.theme.fontFamily, size: 10, weight: 'bold' }
                        },
                        grid: {
                            color: self.theme.gridColor,
                            borderColor: self.theme.axisBorder
                        },
                        ticks: {
                            color: self.theme.textSecondary,
                            font: { family: self.theme.fontFamily, size: 9 },
                            callback: (v) => v.toFixed(2),
                            maxTicksLimit: 6
                        }
                    },
                    y: {
                        type: 'linear',
                        display: true,
                        suggestedMin: ySuggestedMin,
                        suggestedMax: ySuggestedMax,
                        grid: {
                            color: self.theme.gridColor,
                            borderColor: self.theme.axisBorder
                        },
                        ticks: {
                            color: self.theme.textSecondary,
                            font: { family: self.theme.fontFamily, size: 9 },
                            maxTicksLimit: 4
                        }
                    }
                }
            });

            const makeDataset = (label, color) => ({
                label: label,
                data: [],
                borderColor: color,
                backgroundColor: color,
                borderWidth: 1.6,
                tension: 0.1,
                pointRadius: 0,
                fill: false
            });

            // 1. Accelerometer Chart
            const canvasAccel = this._resolveCanvas(accelTarget);
            if (canvasAccel) {
                if (this.accelChart) this.accelChart.destroy();
                this.accelChart = new Chart(canvasAccel.getContext('2d'), {
                    type: 'line',
                    data: {
                        datasets: [
                            makeDataset('X', '#ef4444'),
                            makeDataset('Y', '#10b981'),
                            makeDataset('Z', '#3b82f6')
                        ]
                    },
                    options: commonOptions('Accelerometer', false, -15, 15)
                });
            }

            // 2. Gyroscope Chart
            const canvasGyro = this._resolveCanvas(gyroTarget);
            if (canvasGyro) {
                if (this.gyroChart) this.gyroChart.destroy();
                this.gyroChart = new Chart(canvasGyro.getContext('2d'), {
                    type: 'line',
                    data: {
                        datasets: [
                            makeDataset('X', '#ef4444'),
                            makeDataset('Y', '#10b981'),
                            makeDataset('Z', '#3b82f6')
                        ]
                    },
                    options: commonOptions('Gyroscope', false, -30, 30)
                });
            }

            // 3. Magnetometer Chart
            const canvasMag = this._resolveCanvas(magTarget);
            if (canvasMag) {
                if (this.magChart) this.magChart.destroy();
                this.magChart = new Chart(canvasMag.getContext('2d'), {
                    type: 'line',
                    data: {
                        datasets: [
                            makeDataset('X', '#ef4444'),
                            makeDataset('Y', '#10b981'),
                            makeDataset('Z', '#3b82f6')
                        ]
                    },
                    options: commonOptions('Magnetometer', true, -60, 60)
                });
            }

            return { accel: this.accelChart, gyro: this.gyroChart, mag: this.magChart };
        }

        // ====================================================================
        // DATA UPDATE METHODS (CALLED AT 10Hz)
        // ====================================================================

        /**
         * Ingest a full telemetry packet from TelemetryEngine and update charts
         * @param {Object} packet Parsed CanSat telemetry packet
         */
        update(packet) {
            if (!packet) return;

            let timeSec = 0;
            if (typeof packet.timestamp_ms === 'number' && packet.timestamp_ms > 0) {
                if (this._initialTimestampMs === undefined) {
                    this._initialTimestampMs = packet.timestamp_ms;
                }
                timeSec = (packet.timestamp_ms - this._initialTimestampMs) / 1000.0;
            } else {
                if (this._initialReceivedAt === undefined) {
                    this._initialReceivedAt = packet.received_at || Date.now();
                }
                timeSec = ((packet.received_at || Date.now()) - this._initialReceivedAt) / 1000.0;
            }

            if (Number.isFinite(packet.alt)) {
                this.updateAltitudeChart(timeSec, packet.alt);
            }

            if (Number.isFinite(packet.pressure) || Number.isFinite(packet.temperature)) {
                this.updateEnvironmentChart(timeSec, packet.pressure, packet.temperature);
            }

            // Update 3-axis IMU charts (Accel, Gyro, Mag)
            this.updateIMUCharts(
                timeSec,
                packet.ax, packet.ay, packet.az,
                packet.gx, packet.gy, packet.gz,
                packet.mx, packet.my, packet.mz
            );
        }

        /**
         * Update real-time 3-axis IMU charts (Accelerometer, Gyroscope, Magnetometer)
         */
        updateIMUCharts(time, ax, ay, az, gx, gy, gz, mx, my, mz) {
            const imuWindow = 20; // 20s rolling window
            const updateChartData = (chart, xVal, yVal, zVal) => {
                if (!chart) return;
                const dX = chart.data.datasets[0];
                const dY = chart.data.datasets[1];
                const dZ = chart.data.datasets[2];

                dX.data.push({ x: time, y: xVal || 0 });
                dY.data.push({ x: time, y: yVal || 0 });
                dZ.data.push({ x: time, y: zVal || 0 });

                const minX = Math.max(0, time - imuWindow);
                const maxX = Math.max(imuWindow, time);
                chart.options.scales.x.min = minX;
                chart.options.scales.x.max = maxX;

                const cutoff = time - imuWindow - 5;
                while (dX.data.length > 0 && dX.data[0].x < cutoff) {
                    dX.data.shift();
                    dY.data.shift();
                    dZ.data.shift();
                }
            };

            if (this.accelChart && (Number.isFinite(ax) || Number.isFinite(ay) || Number.isFinite(az))) {
                updateChartData(this.accelChart, ax, ay, az);
            }
            if (this.gyroChart && (Number.isFinite(gx) || Number.isFinite(gy) || Number.isFinite(gz))) {
                updateChartData(this.gyroChart, gx, gy, gz);
            }
            if (this.magChart && (Number.isFinite(mx) || Number.isFinite(my) || Number.isFinite(mz))) {
                updateChartData(this.magChart, mx, my, mz);
            }

            this.needsIMUUpdate = true;
            this.scheduleRender();
        }

        /**
         * Ingest new altitude telemetry data point
         * @param {number} time Mission elapsed time in seconds
         * @param {number} altitude Current altitude in meters
         */
        updateAltitudeChart(time, altitude) {
            if (!this.altitudeChart || typeof time !== 'number' || typeof altitude !== 'number' || isNaN(time) || isNaN(altitude)) {
                return;
            }

            const dataset = this.altitudeChart.data.datasets[0];
            dataset.data.push({ x: time, y: altitude });

            // Auto-detect peak apogee during flight
            if (this.apogee.auto && altitude > this.apogee.altitude) {
                this.apogee.altitude = altitude;
                this.apogee.time = time;
            }

            // Rolling time window adjustment
            const windowMin = Math.max(0, time - this.windowSeconds);
            const windowMax = Math.max(this.windowSeconds, time);
            this.altitudeChart.options.scales.x.min = windowMin;
            this.altitudeChart.options.scales.x.max = windowMax;

            // Prune expired data points beyond rolling window (+10s buffer for smooth edge)
            const cutoffTime = time - this.windowSeconds - 10;
            while (dataset.data.length > 0 && dataset.data[0].x < cutoffTime) {
                dataset.data.shift();
            }

            // Cap visible points if data rate spikes above nominal
            if (dataset.data.length > this.maxPoints * 1.5) {
                dataset.data = this.decimateData(dataset.data, this.maxPoints);
            }

            this.needsAltitudeUpdate = true;
            this.scheduleRender();
        }

        /**
         * Ingest new environment telemetry data points
         * @param {number} time Mission elapsed time in seconds
         * @param {number} pressure Atmospheric pressure in hPa
         * @param {number} temperature Temperature in Celsius
         */
        updateEnvironmentChart(time, pressure, temperature) {
            if (!this.envChart || typeof time !== 'number' || isNaN(time)) {
                return;
            }

            const pressureDataset = this.envChart.data.datasets[0];
            const tempDataset = this.envChart.data.datasets[1];

            if (typeof pressure === 'number' && !isNaN(pressure)) {
                pressureDataset.data.push({ x: time, y: pressure });
            }
            if (typeof temperature === 'number' && !isNaN(temperature)) {
                tempDataset.data.push({ x: time, y: temperature });
            }

            // Rolling time window adjustment
            const windowMin = Math.max(0, time - this.windowSeconds);
            const windowMax = Math.max(this.windowSeconds, time);
            this.envChart.options.scales.x.min = windowMin;
            this.envChart.options.scales.x.max = windowMax;

            // Prune expired data points
            const cutoffTime = time - this.windowSeconds - 10;
            while (pressureDataset.data.length > 0 && pressureDataset.data[0].x < cutoffTime) {
                pressureDataset.data.shift();
            }
            while (tempDataset.data.length > 0 && tempDataset.data[0].x < cutoffTime) {
                tempDataset.data.shift();
            }

            if (pressureDataset.data.length > this.maxPoints * 1.5) {
                pressureDataset.data = this.decimateData(pressureDataset.data, this.maxPoints);
            }
            if (tempDataset.data.length > this.maxPoints * 1.5) {
                tempDataset.data = this.decimateData(tempDataset.data, this.maxPoints);
            }

            this.needsEnvUpdate = true;
            this.scheduleRender();
        }

        /**
         * Update an individual sparkline mini chart
         * @param {string|HTMLCanvasElement} canvasTarget Canvas ID or element
         * @param {number} value New numeric telemetry reading
         * @param {number} [time] Optional timestamp or counter
         */
        updateSparkline(canvasTarget, value, time) {
            const canvas = this._resolveCanvas(canvasTarget);
            if (!canvas) return;
            const id = canvas.id;
            const chart = this.sparklines.get(id);
            if (!chart || typeof value !== 'number' || isNaN(value)) return;

            const dataset = chart.data.datasets[0];
            const xVal = typeof time === 'number' ? time : dataset.data.length;
            dataset.data.push({ x: xVal, y: value });

            const maxPoints = chart._sparklineMaxPoints || 60;
            while (dataset.data.length > maxPoints) {
                dataset.data.shift();
            }

            this.pendingSparklines.add(id);
            this.scheduleRender();
        }

        // ====================================================================
        // APOGEE & PREDICTION ANNOTATIONS
        // ====================================================================

        /**
         * Manually set or lock the apogee annotation point
         * @param {number} time Time at which apogee occurred (MET seconds)
         * @param {number} altitude Maximum altitude reached in meters
         */
        setApogeeAnnotation(time, altitude) {
            if (typeof altitude === 'number' && !isNaN(altitude)) {
                this.apogee = {
                    time: typeof time === 'number' && !isNaN(time) ? time : 0,
                    altitude: altitude,
                    auto: false // Explicitly locked by telemetry or command
                };
                this.needsAltitudeUpdate = true;
                this.scheduleRender();
            }
        }

        /**
         * Update the predicted apogee horizontal guideline
         * @param {number|null} altitude Predicted apogee altitude in meters (or null to clear)
         */
        setPredictedApogee(altitude) {
            if (altitude === null || (typeof altitude === 'number' && !isNaN(altitude))) {
                this.predictedApogee = altitude;
                this.needsAltitudeUpdate = true;
                this.scheduleRender();
            }
        }

        /**
         * Reset auto apogee tracking for a new flight sequence
         */
        resetApogee() {
            this.apogee = {
                time: null,
                altitude: -Infinity,
                auto: true
            };
            this.predictedApogee = null;
            this.needsAltitudeUpdate = true;
            this.scheduleRender();
        }

        // ====================================================================
        // OPTIMIZATION & DECIMATION ALGORITHMS
        // ====================================================================

        /**
         * Largest-Triangle-Three-Buckets (LTTB) downsampling algorithm
         * Preserves visual signal peaks, troughs, and apogee points with optimal fidelity.
         * @param {Array<{x: number, y: number}>} data Source array of points
         * @param {number} maxPoints Target point count
         * @returns {Array<{x: number, y: number}>} Decimated array
         */
        decimateData(data, maxPoints) {
            if (!Array.isArray(data) || data.length <= maxPoints || maxPoints <= 2) {
                return data ? data.slice() : [];
            }

            const sampled = [];
            const every = (data.length - 2) / (maxPoints - 2);
            let a = 0; // Always include first point
            sampled.push(data[a]);

            for (let i = 0; i < maxPoints - 2; i++) {
                // Calculate average for next bucket (bucket c)
                let avgX = 0;
                let avgY = 0;
                let avgRangeStart = Math.floor((i + 1) * every) + 1;
                let avgRangeEnd = Math.min(Math.floor((i + 2) * every) + 1, data.length);
                const avgRangeLength = avgRangeEnd - avgRangeStart;

                for (; avgRangeStart < avgRangeEnd; avgRangeStart++) {
                    avgX += data[avgRangeStart].x;
                    avgY += data[avgRangeStart].y;
                }
                avgX /= (avgRangeLength || 1);
                avgY /= (avgRangeLength || 1);

                // Get range for current bucket (bucket b)
                let rangeOffs = Math.floor(i * every) + 1;
                const rangeTo = Math.min(Math.floor((i + 1) * every) + 1, data.length);

                const pointAX = data[a].x;
                const pointAY = data[a].y;

                let maxArea = -1;
                let maxAreaPoint = data[rangeOffs];
                let nextA = rangeOffs;

                for (; rangeOffs < rangeTo; rangeOffs++) {
                    // Triangle area: 0.5 * |x_a(y_b - y_c) + x_b(y_c - y_a) + x_c(y_a - y_b)|
                    const area = Math.abs(
                        (pointAX - avgX) * (data[rangeOffs].y - pointAY) -
                        (pointAX - data[rangeOffs].x) * (avgY - pointAY)
                    ) * 0.5;

                    if (area > maxArea) {
                        maxArea = area;
                        maxAreaPoint = data[rangeOffs];
                        nextA = rangeOffs;
                    }
                }

                sampled.push(maxAreaPoint);
                a = nextA;
            }

            sampled.push(data[data.length - 1]); // Always include last point
            return sampled;
        }

        // ====================================================================
        // RENDER SCHEDULING (RAF + 4Hz THROTTLED BATCHING)
        // ====================================================================

        /**
         * Schedules chart rendering via requestAnimationFrame with 4Hz throttle
         */
        scheduleRender() {
            if (this.isRenderScheduled) return;
            this.isRenderScheduled = true;

            this.rafId = requestAnimationFrame((now) => {
                this.isRenderScheduled = false;
                const elapsed = now - this.lastRenderTime;

                if (elapsed >= this.renderIntervalMs) {
                    this._flushUpdates();
                    this.lastRenderTime = now;
                } else {
                    // Schedule trailing execution for remaining window
                    if (!this.throttleTimer) {
                        const waitTime = Math.max(10, this.renderIntervalMs - elapsed);
                        this.throttleTimer = setTimeout(() => {
                            this.throttleTimer = null;
                            this.rafId = requestAnimationFrame((time) => {
                                this._flushUpdates();
                                this.lastRenderTime = time;
                            });
                        }, waitTime);
                    }
                }
            });
        }

        /**
         * Instantly flush and commit all queued chart updates
         */
        flush() {
            if (this.throttleTimer) {
                clearTimeout(this.throttleTimer);
                this.throttleTimer = null;
            }
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
            this.isRenderScheduled = false;
            this._flushUpdates();
            this.lastRenderTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        }

        /**
         * Internal: Flushes dirty charts with zero animation duration
         * @private
         */
        _flushUpdates() {
            if (this.needsAltitudeUpdate && this.altitudeChart) {
                this.altitudeChart.update('none');
                this.needsAltitudeUpdate = false;
            }

            if (this.needsEnvUpdate && this.envChart) {
                this.envChart.update('none');
                this.needsEnvUpdate = false;
            }

            if (this.needsIMUUpdate) {
                if (this.accelChart) this.accelChart.update('none');
                if (this.gyroChart) this.gyroChart.update('none');
                if (this.magChart) this.magChart.update('none');
                this.needsIMUUpdate = false;
            }

            if (this.pendingSparklines.size > 0) {
                this.pendingSparklines.forEach((id) => {
                    const spark = this.sparklines.get(id);
                    if (spark) {
                        spark.update('none');
                    }
                });
                this.pendingSparklines.clear();
            }
        }

        // ====================================================================
        // UTILITIES & STATE MANAGEMENT
        // ====================================================================

        /**
         * Reset all charts and telemetry histories for a new test or launch
         */
        reset() {
            if (this.altitudeChart) {
                this.altitudeChart.data.datasets[0].data = [];
                this.altitudeChart.options.scales.x.min = 0;
                this.altitudeChart.options.scales.x.max = this.windowSeconds;
                this.altitudeChart.update('none');
            }

            if (this.envChart) {
                this.envChart.data.datasets[0].data = [];
                this.envChart.data.datasets[1].data = [];
                this.envChart.options.scales.x.min = 0;
                this.envChart.options.scales.x.max = this.windowSeconds;
                this.envChart.update('none');
            }

            if (this.accelChart) {
                this.accelChart.data.datasets.forEach(d => { d.data = []; });
                this.accelChart.options.scales.x.min = 0;
                this.accelChart.options.scales.x.max = this.windowSeconds;
                this.accelChart.update('none');
            }

            if (this.gyroChart) {
                this.gyroChart.data.datasets.forEach(d => { d.data = []; });
                this.gyroChart.options.scales.x.min = 0;
                this.gyroChart.options.scales.x.max = this.windowSeconds;
                this.gyroChart.update('none');
            }

            if (this.magChart) {
                this.magChart.data.datasets.forEach(d => { d.data = []; });
                this.magChart.options.scales.x.min = 0;
                this.magChart.options.scales.x.max = this.windowSeconds;
                this.magChart.update('none');
            }

            this.sparklines.forEach((spark) => {
                spark.data.datasets[0].data = [];
                spark.update('none');
            });

            this.apogee = { time: null, altitude: -Infinity, auto: true };
            this.predictedApogee = null;

            this.needsAltitudeUpdate = false;
            this.needsEnvUpdate = false;
            this.needsIMUUpdate = false;
            this.pendingSparklines.clear();
        }

        /**
         * Resize all active chart instances (e.g., when panel expands or window changes)
         */
        resize() {
            if (this.altitudeChart) this.altitudeChart.resize();
            if (this.envChart) this.envChart.resize();
            if (this.accelChart) this.accelChart.resize();
            if (this.gyroChart) this.gyroChart.resize();
            if (this.magChart) this.magChart.resize();
            this.sparklines.forEach((spark) => spark.resize());
        }

        /**
         * Window resize handler
         * @private
         */
        _onResize() {
            this.resize();
        }

        /**
         * Resolve canvas DOM element by ID or object
         * @param {string|HTMLCanvasElement} target
         * @returns {HTMLCanvasElement|null}
         * @private
         */
        _resolveCanvas(target) {
            if (!target) return null;
            if (typeof target === 'string') {
                const el = document.getElementById(target);
                if (!el) {
                    console.warn(`[ChartsManager] Canvas element with ID "${target}" not found.`);
                    return null;
                }
                return el;
            }
            if (target instanceof HTMLCanvasElement) {
                return target;
            }
            console.warn('[ChartsManager] Target is not a valid HTMLCanvasElement:', target);
            return null;
        }

        /**
         * Export current telemetry data points as JSON
         * @returns {Object} Current telemetry buffers
         */
        exportData() {
            return {
                altitude: this.altitudeChart ? this.altitudeChart.data.datasets[0].data.slice() : [],
                pressure: this.envChart ? this.envChart.data.datasets[0].data.slice() : [],
                temperature: this.envChart ? this.envChart.data.datasets[1].data.slice() : [],
                apogee: { ...this.apogee },
                predictedApogee: this.predictedApogee
            };
        }

        /**
         * Clean up all chart instances, event listeners, and timers
         */
        destroy() {
            if (typeof window !== 'undefined') {
                window.removeEventListener('resize', this._onResize);
            }

            if (this.throttleTimer) {
                clearTimeout(this.throttleTimer);
                this.throttleTimer = null;
            }

            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }

            if (this.altitudeChart) {
                this.altitudeChart.destroy();
                this.altitudeChart = null;
            }

            if (this.envChart) {
                this.envChart.destroy();
                this.envChart = null;
            }

            if (this.accelChart) {
                this.accelChart.destroy();
                this.accelChart = null;
            }
            if (this.gyroChart) {
                this.gyroChart.destroy();
                this.gyroChart = null;
            }
            if (this.magChart) {
                this.magChart.destroy();
                this.magChart = null;
            }

            this.sparklines.forEach((spark) => spark.destroy());
            this.sparklines.clear();
            this.pendingSparklines.clear();
        }
    }

    return ChartsManager;
}));
