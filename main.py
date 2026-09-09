"""
PulseRelay Multi-Threaded Non-Blocking Python Server
HTTP Port: 3000 | WS Port: 3001
Supports High-Throughput 100GB Targeted File Chunk Streaming & REST /api/signal Signaling Relay
Run with: python main.py
"""

import os
import sys
import socket
import json
import asyncio
import http.server
import socketserver
import threading

try:
    import websockets
except ImportError:
    print("Installing 'websockets' module...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets"])
    import websockets

PORT = 3000
WS_PORT = 3001
PUBLIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), 'public'))

ROOMS = {}
CLIENT_ROOMS = {}

API_ROOM_PEERS = {}
API_ROOM_SIGNALS = {}

def get_lan_ip_addresses():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        if ip and ip != "127.0.0.1":
            ips.append(ip)
    except Exception:
        pass

    try:
        hostname = socket.gethostname()
        for ip in socket.gethostbyname_ex(hostname)[2]:
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except Exception:
        pass

    return ips if ips else ["127.0.0.1"]

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

class PublicHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=PUBLIC_DIR, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        if self.path.startswith('/api/signal'):
            content_length = int(self.headers.get('Content-Length', 0))
            body_bytes = self.rfile.read(content_length)
            try:
                data = json.loads(body_bytes.decode('utf8'))
                action = data.get('action')
                room_id = data.get('roomId', 'LOBBY').strip().upper()
                sender_id = data.get('senderPeerId')
                target_id = data.get('targetPeerId')
                user = data.get('user', {})
                signal = data.get('signal')

                if room_id not in API_ROOM_PEERS:
                    API_ROOM_PEERS[room_id] = {}
                if room_id not in API_ROOM_SIGNALS:
                    API_ROOM_SIGNALS[room_id] = {}

                if user and sender_id:
                    API_ROOM_PEERS[room_id][sender_id] = user

                if action == 'send-signal':
                    if target_id == 'BROADCAST':
                        for pid in API_ROOM_PEERS[room_id]:
                            if pid != sender_id:
                                if pid not in API_ROOM_SIGNALS[room_id]:
                                    API_ROOM_SIGNALS[room_id][pid] = []
                                API_ROOM_SIGNALS[room_id][pid].append({'senderPeerId': sender_id, 'signal': signal})
                    else:
                        if target_id not in API_ROOM_SIGNALS[room_id]:
                            API_ROOM_SIGNALS[room_id][target_id] = []
                        API_ROOM_SIGNALS[room_id][target_id].append({'senderPeerId': sender_id, 'signal': signal})

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True}).encode('utf8'))
                    return

                if action == 'poll' or action == 'join-room':
                    pending = API_ROOM_SIGNALS[room_id].get(sender_id, [])
                    API_ROOM_SIGNALS[room_id][sender_id] = []

                    peers = list(API_ROOM_PEERS[room_id].values())

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps({'success': True, 'signals': pending, 'peers': peers}).encode('utf8'))
                    return

            except Exception as e:
                pass

        super().do_POST()

    def log_message(self, format, *args):
        pass

async def broadcast_to_room(room_id, message_dict, exclude_ws=None):
    if room_id not in ROOMS:
        return
    
    payload = json.dumps(message_dict)
    dead_clients = []

    for ws, user in list(ROOMS[room_id].items()):
        if ws != exclude_ws:
            try:
                await ws.send(payload)
            except Exception:
                dead_clients.append(ws)

    for ws in dead_clients:
        await remove_client(ws)

async def send_to_target_peer(room_id, target_peer_id, message_dict):
    if room_id not in ROOMS:
        return False
    
    payload = json.dumps(message_dict)
    target_ws = None

    for ws, user in ROOMS[room_id].items():
        if user.get('id') == target_peer_id:
            target_ws = ws
            break

    if target_ws:
        try:
            await target_ws.send(payload)
            return True
        except Exception:
            await remove_client(target_ws)
    return False

async def remove_client(ws):
    if ws in CLIENT_ROOMS:
        room_id, user = CLIENT_ROOMS[ws]
        del CLIENT_ROOMS[ws]
        if room_id in ROOMS and ws in ROOMS[room_id]:
            del ROOMS[room_id][ws]
            room_users = list(ROOMS[room_id].values())
            
            print(f"[-] User {user.get('alias', 'Unknown')} left room #{room_id} (Remaining: {len(room_users)})")

            await broadcast_to_room(room_id, {
                "event": "user-left",
                "user": user
            })
            await broadcast_to_room(room_id, {
                "event": "room-users",
                "users": room_users
            })
            
            if not ROOMS[room_id]:
                del ROOMS[room_id]

async def ws_handler(websocket, path=None):
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                event = data.get("event")
                payload = data.get("data", {})

                if event == "join-room":
                    room_id = payload.get("roomId", "LOBBY").strip().upper()
                    user = payload.get("user", {})
                    
                    if websocket in CLIENT_ROOMS:
                        old_room, old_user = CLIENT_ROOMS[websocket]
                        if old_room != room_id and old_room in ROOMS and websocket in ROOMS[old_room]:
                            del ROOMS[old_room][websocket]
                            await broadcast_to_room(old_room, {
                                "event": "room-users",
                                "users": list(ROOMS[old_room].values())
                            })

                    if room_id not in ROOMS:
                        ROOMS[room_id] = {}
                    
                    ROOMS[room_id][websocket] = user
                    CLIENT_ROOMS[websocket] = (room_id, user)

                    room_users = list(ROOMS[room_id].values())

                    print(f"[+] User {user.get('alias')} registered in room #{room_id} (Total peers: {len(room_users)})")

                    await broadcast_to_room(room_id, {
                        "event": "room-users",
                        "users": room_users
                    })
                    await broadcast_to_room(room_id, {
                        "event": "user-joined",
                        "user": user
                    }, exclude_ws=websocket)

                elif event == "chat-message":
                    room_id, user = CLIENT_ROOMS.get(websocket, (None, None))
                    if room_id:
                        target_peer_id = payload.get("targetPeerId")
                        if target_peer_id:
                            for client_ws, client_user in ROOMS[room_id].items():
                                if client_user.get("id") == target_peer_id:
                                    await client_ws.send(json.dumps({
                                        "event": "chat-message",
                                        "data": payload
                                    }))
                                    break
                        else:
                            await broadcast_to_room(room_id, {
                                "event": "chat-message",
                                "data": payload
                            }, exclude_ws=websocket)

                elif event == "targeted-file-init" or event == "targeted-file-chunk" or event == "targeted-file-ack":
                    room_id, user = CLIENT_ROOMS.get(websocket, (None, None))
                    target_peer_id = payload.get("targetPeerId")
                    if room_id and target_peer_id:
                        await send_to_target_peer(room_id, target_peer_id, {
                            "event": event,
                            "data": payload,
                            "sender": user
                        })

                elif event == "typing-status":
                    room_id, user = CLIENT_ROOMS.get(websocket, (None, None))
                    if room_id:
                        await broadcast_to_room(room_id, {
                            "event": "typing-status",
                            "data": payload
                        }, exclude_ws=websocket)

                elif event == "ping":
                    room_id, user = CLIENT_ROOMS.get(websocket, (None, None))
                    if room_id and room_id in ROOMS:
                        await websocket.send(json.dumps({
                            "event": "room-users",
                            "users": list(ROOMS[room_id].values())
                        }))

            except json.JSONDecodeError:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        await remove_client(websocket)

def run_http_server():
    server = ThreadedHTTPServer(("0.0.0.0", PORT), PublicHTTPRequestHandler)
    server.serve_forever()

async def main_async():
    async with websockets.serve(ws_handler, "0.0.0.0", WS_PORT):
        print("\n======================================================")
        print("  🚀 PulseRelay High-Throughput 100GB Streaming Server")
        print("======================================================")
        print(f"  🏠 Local Access:   http://localhost:{PORT}")
        lan_ips = get_lan_ip_addresses()
        for ip in lan_ips:
            print(f"  🌐 LAN Access:     http://{ip}:{PORT}")
        print("------------------------------------------------------")
        print("  📱 Share the LAN URL with any device on your WiFi!")
        print("======================================================\n")
        await asyncio.Future()

def main():
    http_thread = threading.Thread(target=run_http_server, daemon=True)
    http_thread.start()

    try:
        asyncio.run(main_async())
    except KeyboardInterrupt:
        print("\nShutting down PulseRelay server...")

if __name__ == "__main__":
    main()
