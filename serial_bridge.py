"""
============================================================================
IN-SPACe CanSat GCS — Serial-to-WebSocket Fallback Bridge (serial_bridge.py)
============================================================================
Reads incoming $CANSAT telemetry from STM32 BlackPill COM Port
and forwards to browser via WebSocket on ws://localhost:8080.
(Optional: useful if browser does not have Web Serial API enabled)
============================================================================
"""
import sys
import time
import argparse

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    print("[ERROR] pyserial is required for this bridge. Run: pip install pyserial")
    sys.exit(1)

try:
    import asyncio
    import websockets
except ImportError:
    print("[ERROR] websockets is required for this bridge. Run: pip install websockets")
    sys.exit(1)

CONNECTED_CLIENTS = set()

async def ws_handler(websocket):
    CONNECTED_CLIENTS.add(websocket)
    print(f"[WS] GCS Client connected from {websocket.remote_address}")
    try:
        async for message in websocket:
            pass # Uplink commands can be handled here
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        CONNECTED_CLIENTS.remove(websocket)
        print(f"[WS] GCS Client disconnected")

async def serial_reader(port_name, baud_rate):
    print(f"[SERIAL] Connecting to {port_name} at {baud_rate} baud...")
    try:
        ser = serial.Serial(port_name, baud_rate, timeout=0.1)
        print(f"[SERIAL] Connected successfully to {port_name}!")
    except Exception as e:
        print(f"[SERIAL ERROR] Could not open {port_name}: {e}")
        return

    buffer = ""
    while True:
        try:
            if ser.in_waiting > 0:
                raw_bytes = ser.read(ser.in_waiting)
                text = raw_bytes.decode('ascii', errors='ignore')
                buffer += text
                while '\n' in buffer:
                    line, buffer = buffer.split('\n', 1)
                    line = line.strip()
                    if line.startswith('$CANSAT'):
                        # Forward to all connected GCS clients
                        if CONNECTED_CLIENTS:
                            websockets.broadcast(CONNECTED_CLIENTS, line)
                            print(f"[TELEMETRY RX] {line}")
            await asyncio.sleep(0.01)
        except Exception as e:
            print(f"[STREAM ERROR] {e}")
            await asyncio.sleep(0.5)

async def main():
    parser = argparse.ArgumentParser(description="CanSat Serial-to-WebSocket Bridge")
    parser.add_argument("--port", type=str, default=None, help="COM Port (e.g. COM3)")
    parser.add_argument("--baud", type=int, default=115200, help="Baud rate (default 115200)")
    parser.add_argument("--ws_port", type=int, default=8080, help="WebSocket port (default 8080)")
    args = parser.parse_args()

    if not args.port:
        available_ports = list(serial.tools.list_ports.comports())
        if not available_ports:
            print("[WARN] No COM ports automatically detected. Specify with --port COMx")
            return
        print("Available COM Ports:")
        for p in available_ports:
            print(f"  - {p.device}: {p.description}")
        args.port = available_ports[0].device
        print(f"Auto-selected: {args.port}")

    # Start WebSocket Server
    server = await websockets.serve(ws_handler, "localhost", args.ws_port)
    print(f"[SERVER] WebSocket bridge listening on ws://localhost:{args.ws_port}")

    # Run serial reader
    await serial_reader(args.port, args.baud)

if __name__ == "__main__":
    asyncio.run(main())
