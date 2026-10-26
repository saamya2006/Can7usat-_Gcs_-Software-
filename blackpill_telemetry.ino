/**
 * ============================================================================
 * IN-SPACe CANSAT MISSION CONTROL — BLACKPILL STM32 FLIGHT CONTROLLER FIRMWARE
 * Target Board : STM32F401CCU6 / STM32F411CEU6 BlackPill
 * Sensors      : Bosch BMP280 (I2C) + 7Semi GNSS L89 (UART)
 * Telemetry    : Checksum-free $CANSAT CSV line via USB Serial (115200 baud)
 * Compatibility: Fully matched with inspace project WebSerial TelemetryEngine
 * ============================================================================
 *
 * PINOUT CONNECTIONS:
 * ----------------------------------------------------------------------------
 * 1. BMP280 (Barometer & Temperature):
 *    - VCC  ---> 3.3V (BlackPill 3.3V pin)
 *    - GND  ---> GND
 *    - SCL  ---> PB6 (I2C1_SCL)
 *    - SDA  ---> PB7 (I2C1_SDA)
 *    - SDO  ---> GND (Address 0x76) OR 3.3V (Address 0x77)
 *    - CSB  ---> 3.3V (Selects I2C mode)
 *
 * 2. 7Semi GNSS L89 (GPS / Multi-Constellation):
 *    - VCC  ---> 3.3V (or 5V if module has onboard LDO)
 *    - GND  ---> GND
 *    - TX   ---> PA3 (STM32 USART2 RX)
 *    - RX   ---> PA2 (STM32 USART2 TX)
 *
 * 3. BlackPill to PC:
 *    - USB Type-C Cable directly to PC (USB CDC Virtual COM Port)
 *      OR use FTDI / CP2102 USB-to-UART on PA9(TX) / PA10(RX).
 *
 * REQUIRED ARDUINO LIBRARIES (Install via Arduino Library Manager):
 * ----------------------------------------------------------------------------
 * 1. "Adafruit BMP280 Library" (by Adafruit)
 * 2. "TinyGPSPlus" (by Mikal Hart)
 * ----------------------------------------------------------------------------
 */

#include <Wire.h>
#include <Adafruit_BMP280.h>
#include <TinyGPSPlus.h>

// ----------------------------------------------------------------------------
// HARDWARE INSTANCES & CONFIGURATION
// ----------------------------------------------------------------------------
Adafruit_BMP280 bmp;     // I2C interface
TinyGPSPlus gps;         // GNSS L89 parser

// Cross-compatible Hardware Serial setup for GNSS L89 on USART2 (PA3=RX, PA2=TX)
// Avoids "Uart does not name a type" and duplicate IRQ handler conflicts on STM32duino
#if defined(ARDUINO_ARCH_STM32)
  #if defined(HAVE_HWSERIAL2) || defined(Serial2)
    #define GNSSSerial Serial2
  #else
    HardwareSerial GNSSSerial(PA3, PA2);
  #endif
#elif defined(ESP32)
  HardwareSerial GNSSSerial(2);
#else
  #define GNSSSerial Serial1
#endif

// Telemetry output rate: 10 Hz (every 100 ms)
const unsigned long TELEMETRY_INTERVAL_MS = 100;
unsigned long lastTelemetryTime = 0;
uint32_t packetSequence = 0;

// Sensor status flags
bool bmpReady = false;
float baselinePressureHPa = 1013.25f;

// ----------------------------------------------------------------------------
// SETUP
// ----------------------------------------------------------------------------
void setup() {
  // 1. Initialise USB CDC Serial for Ground Station communication
  Serial.begin(115200);

  // Optional: wait up to 2 seconds for USB CDC to enumerate on PC, but continue if on battery
  unsigned long usbWaitStart = millis();
  while (!Serial && (millis() - usbWaitStart < 2000)) {
    delay(10);
  }

  // Status LED (BlackPill onboard LED is PC13, active LOW)
  #ifdef PC13
    pinMode(PC13, OUTPUT);
    digitalWrite(PC13, HIGH); // Off initially
  #endif

  // 2. Initialise I2C for BMP280 (PB7=SDA, PB6=SCL on STM32 BlackPill)
  #if defined(ARDUINO_ARCH_STM32)
    Wire.setSDA(PB7);
    Wire.setSCL(PB6);
  #endif
  Wire.begin();
  delay(50); // Allow I2C bus to settle

  // 3. Initialise 7Semi GNSS L89 UART (Default baud: 9600)
  #if defined(ARDUINO_ARCH_STM32) && defined(HAVE_HWSERIAL2)
    GNSSSerial.setRx(PA3);
    GNSSSerial.setTx(PA2);
  #endif
  GNSSSerial.begin(9600);

  // 4. Initialise BMP280 with auto-detection for addresses 0x76 & 0x77
  // Includes chip ID probing for standard Bosch (0x58) and clone chips (0x56, 0x57, 0x60)
  if (bmp.begin(0x76, 0x58) || bmp.begin(0x77, 0x58) ||
      bmp.begin(0x76, 0x56) || bmp.begin(0x77, 0x56) ||
      bmp.begin(0x76, 0x57) || bmp.begin(0x77, 0x57) ||
      bmp.begin(0x76, 0x60) || bmp.begin(0x77, 0x60) ||
      bmp.begin(0x76)       || bmp.begin(0x77)) {
    bmpReady = true;
  }

  if (bmpReady) {
    // Configure BMP280 for aerospace high-resolution sensing:
    // - Mode: Normal (continuous measurement)
    // - Temperature Oversampling: 2x
    // - Pressure Oversampling: 16x (Ultra-high resolution: 0.16 Pa / ~1.2 cm)
    // - IIR Filter: 16 (Drastically reduces acoustic noise and air drafts)
    // - Standby Time: 62.5 ms (~16 Hz sampling rate)
    bmp.setSampling(Adafruit_BMP280::MODE_NORMAL,
                    Adafruit_BMP280::SAMPLING_X2,
                    Adafruit_BMP280::SAMPLING_X16,
                    Adafruit_BMP280::FILTER_X16,
                    Adafruit_BMP280::STANDBY_MS_63);

    // Initial baseline calibration (average of 10 valid readings)
    float sumPress = 0.0f;
    int validSamples = 0;
    for (int i = 0; i < 10; i++) {
      float p = bmp.readPressure();
      if (p > 30000.0f && p < 120000.0f) { // Within reasonable atmospheric range in Pa
        sumPress += (p / 100.0f); // Convert Pa to hPa
        validSamples++;
      }
      delay(20);
    }

    if (validSamples > 0) {
      baselinePressureHPa = sumPress / (float)validSamples;
    } else {
      baselinePressureHPa = 1013.25f;
    }
  }
}

// ----------------------------------------------------------------------------
// MAIN LOOP
// ----------------------------------------------------------------------------
void loop() {
  // Continuously ingest incoming NMEA characters from 7Semi GNSS L89
  while (GNSSSerial.available() > 0) {
    char c = GNSSSerial.read();
    gps.encode(c);
  }

  // Periodic Telemetry Dispatch (10 Hz)
  unsigned long now = millis();
  if (now - lastTelemetryTime >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryTime = now;
    sendTelemetryPacket();

    // Toggle onboard LED on PC13 as heartbeat
    #ifdef PC13
      digitalWrite(PC13, !digitalRead(PC13));
    #endif
  }
}

// ----------------------------------------------------------------------------
// TELEMETRY PACKET BUILDER & TRANSMITTER
// ----------------------------------------------------------------------------
void sendTelemetryPacket() {
  packetSequence++;

  // 1. Read BMP280 values
  float temperature = 0.0f;
  float pressureHPa = 0.0f;
  float altitudeM   = 0.0f;

  if (bmpReady) {
    temperature = bmp.readTemperature();
    pressureHPa = bmp.readPressure() / 100.0f; // Convert Pa to hPa
    altitudeM   = bmp.readAltitude(baselinePressureHPa); // Altitude relative to pad baseline
  }

  // 2. Read 7Semi GNSS L89 values
  double lat = 0.0;
  double lon = 0.0;
  float gpsAlt = 0.0f;
  uint32_t satCount = 0;
  float hdop = 99.9f;
  int fixType = 0;

  if (gps.location.isValid()) {
    lat = gps.location.lat();
    lon = gps.location.lng();
  }
  if (gps.altitude.isValid()) {
    gpsAlt = (float)gps.altitude.meters();
  }
  if (gps.satellites.isValid()) {
    satCount = gps.satellites.value();
  }
  if (gps.hdop.isValid()) {
    hdop = (float)gps.hdop.hdop();
  }

  // Determine Fix Quality: 0 = No Fix, 1 = 2D Fix, 2 = 3D Fix
  if (gps.location.isValid() && satCount >= 4) {
    fixType = (satCount >= 6) ? 2 : 1;
  } else {
    fixType = 0;
  }

  // 3. Sensor placeholders (Replace with your PCB IMU / ADC readings when fitted)
  float roll = 0.0f;
  float pitch = 0.0f;
  float yaw = 0.0f;
  float ax = 0.0f;
  float ay = 0.0f;
  float az = 9.81f; // 1G gravity
  float gx = 0.0f;
  float gy = 0.0f;
  float gz = 0.0f;
  float mx = 0.0f;
  float my = 0.0f;
  float mz = 0.0f;
  float voltage = 3.30f;    // 3.3V logic level (or read from battery ADC divider)
  float current = 0.045f;   // ~45mA nominal consumption
  float power = voltage * current;
  float busVoltage = 3.30f;
  float rssi = -55.0f;      // Direct USB / clean link
  float snr = 12.0f;
  float lqi = 100.0f;

  // 4. Construct comma-separated CANSAT telemetry payload
  // Buffer size of 320 bytes prevents snprintf truncation
  char payload[320];
  snprintf(payload, sizeof(payload),
    "CANSAT,%lu,%lu,%.2f,%.2f,%.2f,%.1f,%.1f,%.1f,%.2f,%.2f,%.2f,%.2f,%.2f,%.2f,%.1f,%.1f,%.1f,%.6f,%.6f,%.1f,%lu,%.2f,%d,%.2f,%.3f,%.2f,%.2f,%.1f,%.1f,%.0f",
    (unsigned long)packetSequence,
    (unsigned long)millis(),
    altitudeM,
    pressureHPa,
    temperature,
    roll, pitch, yaw,
    ax, ay, az,
    gx, gy, gz,
    mx, my, mz,
    lat, lon,
    gpsAlt,
    (unsigned long)satCount,
    hdop,
    fixType,
    voltage,
    current,
    power,
    busVoltage,
    rssi,
    snr,
    lqi
  );

  // 5. Transmit plain telemetry line without a trailing checksum
  Serial.print('$');
  Serial.print(payload);
  Serial.println();
}
