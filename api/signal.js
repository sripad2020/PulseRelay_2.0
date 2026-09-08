// Vercel Serverless Signaling Relay Endpoint
// Stores signals temporarily in memory (cleared on cold start / function timeout)

const roomSignals = {}; // { roomId: { [targetPeerId]: [ signalObjects ] } }
const roomPeers = {};   // { roomId: { [peerId]: { lastSeen, user } } }

// Clean up stale peers older than 60 seconds
function cleanup() {
  const now = Date.now();
  for (const room of Object.keys(roomPeers)) {
    for (const peerId of Object.keys(roomPeers[room])) {
      if (now - roomPeers[room][peerId].lastSeen > 60000) { // 1 min inactive
        delete roomPeers[room][peerId];
      }
    }
    if (Object.keys(roomPeers[room]).length === 0) {
      delete roomPeers[room];
      delete roomSignals[room];
    }
  }
}

module.exports = (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  cleanup();

  // Safely parse request body across Vercel environments (Object, String, or Buffer)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) {}
  } else if (Buffer.isBuffer(body)) {
    try { body = JSON.parse(body.toString('utf8')); } catch (e) {}
  }

  if (req.method === 'POST') {
    const { action, roomId, senderPeerId, targetPeerId, signal, user } = body || {};

    if (!roomId || !senderPeerId) {
      return res.status(400).json({ error: 'Missing required parameters: roomId and senderPeerId' });
    }

    const cleanRoomId = roomId.trim().toUpperCase();

    if (!roomPeers[cleanRoomId]) roomPeers[cleanRoomId] = {};
    if (!roomSignals[cleanRoomId]) roomSignals[cleanRoomId] = {};

    // Register or keepalive peer with fallback default identity if missing
    const peerUser = user || { id: senderPeerId, alias: `OPCODE_${senderPeerId.slice(-6).toUpperCase()}`, initial: 'OP' };
    roomPeers[cleanRoomId][senderPeerId] = { user: peerUser, lastSeen: Date.now() };

    if (action === 'send-signal') {
      if (!targetPeerId || !signal) {
        return res.status(400).json({ error: 'Missing targetPeerId or signal' });
      }

      if (targetPeerId === 'BROADCAST') {
        for (const pid of Object.keys(roomPeers[cleanRoomId] || {})) {
          if (pid !== senderPeerId) {
            if (!roomSignals[cleanRoomId][pid]) roomSignals[cleanRoomId][pid] = [];
            roomSignals[cleanRoomId][pid].push({ senderPeerId, signal, timestamp: Date.now() });
          }
        }
      } else {
        if (!roomSignals[cleanRoomId][targetPeerId]) {
          roomSignals[cleanRoomId][targetPeerId] = [];
        }
        roomSignals[cleanRoomId][targetPeerId].push({ senderPeerId, signal, timestamp: Date.now() });
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'poll' || action === 'join-room') {
      const pendingSignals = roomSignals[cleanRoomId][senderPeerId] || [];
      roomSignals[cleanRoomId][senderPeerId] = []; // Clear read signals

      const peers = Object.entries(roomPeers[cleanRoomId] || {}).map(([id, data]) => ({
        id: id,
        peerId: id,
        ...data.user
      }));

      return res.status(200).json({
        success: true,
        signals: pendingSignals,
        peers
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  }

  if (req.method === 'GET') {
    const { roomId, peerId } = req.query;
    if (!roomId || !peerId) {
      return res.status(400).json({ error: 'Missing roomId or peerId query param' });
    }
    const cleanRoomId = roomId.trim().toUpperCase();

    if (roomPeers[cleanRoomId] && roomPeers[cleanRoomId][peerId]) {
      roomPeers[cleanRoomId][peerId].lastSeen = Date.now();
    }

    const pendingSignals = roomSignals[cleanRoomId]?.[peerId] || [];
    if (roomSignals[cleanRoomId]) {
      roomSignals[cleanRoomId][peerId] = [];
    }

    const peers = Object.entries(roomPeers[cleanRoomId] || {}).map(([id, data]) => ({
      id: id,
      peerId: id,
      ...data.user
    }));

    return res.status(200).json({
      success: true,
      signals: pendingSignals,
      peers
    });
  }

  res.status(405).json({ error: 'Method not allowed' });
};
