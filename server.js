const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_CHAT_LENGTH = 500;
const REMATCH_COOLDOWN_MS = 6000; // don't instantly re-pair the same two people
const REPORTS_TO_BAN = 3; // distinct reporters needed
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const BAN_DURATION_MS = 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

app.use(express.static(path.join(__dirname, 'public')));

// ICE servers are served from here so a TURN server can be added via env vars
// without touching the client.
app.get('/config', (_req, res) => {
  const iceServers = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (process.env.TURN_URL) {
    iceServers.push({
      urls: process.env.TURN_URL.split(','),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    });
  }
  res.json({ iceServers });
});

/** @type {{ socket: import('socket.io').Socket, since: number }[]} */
const queue = [];
const partners = new Map(); // socketId -> partner socket
const lastPartner = new Map(); // socketId -> socketId of the previous partner
const reports = new Map(); // ip -> { reporters: Set<ip>, first: number }
const bans = new Map(); // ip -> banned until (ms)

function clientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  return (forwarded ? forwarded.split(',')[0] : socket.handshake.address).trim();
}

function isBanned(ip) {
  const until = bans.get(ip);
  if (!until) return false;
  if (Date.now() > until) {
    bans.delete(ip);
    return false;
  }
  return true;
}

function removeFromQueue(socket) {
  const i = queue.findIndex((e) => e.socket.id === socket.id);
  if (i !== -1) queue.splice(i, 1);
}

function canPair(a, b, now) {
  const recent =
    lastPartner.get(a.socket.id) === b.socket.id || lastPartner.get(b.socket.id) === a.socket.id;
  if (!recent) return true;
  return now - a.since > REMATCH_COOLDOWN_MS && now - b.since > REMATCH_COOLDOWN_MS;
}

function pair(a, b) {
  partners.set(a.id, b);
  partners.set(b.id, a);
  lastPartner.set(a.id, b.id);
  lastPartner.set(b.id, a.id);
  // One side creates the WebRTC offer, the other answers.
  a.emit('matched', { initiator: true });
  b.emit('matched', { initiator: false });
}

function matchmake() {
  const now = Date.now();
  for (let i = 0; i < queue.length; i++) {
    for (let j = i + 1; j < queue.length; j++) {
      if (!canPair(queue[i], queue[j], now)) continue;
      const b = queue.splice(j, 1)[0];
      const a = queue.splice(i, 1)[0];
      pair(a.socket, b.socket);
      i--;
      break;
    }
  }
}

// Picks up pairs that were held back by the rematch cooldown.
setInterval(matchmake, 1000);

function enqueue(socket) {
  if (partners.has(socket.id) || queue.some((e) => e.socket.id === socket.id)) return;
  queue.push({ socket, since: Date.now() });
  matchmake();
}

function leavePartner(socket) {
  const partner = partners.get(socket.id);
  if (!partner) return;
  partners.delete(socket.id);
  partners.delete(partner.id);
  partner.emit('partner-left');
}

function broadcastOnline() {
  io.emit('online', io.engine.clientsCount);
}

io.on('connection', (socket) => {
  socket.data.ip = clientIp(socket);
  socket.data.lastChat = 0;

  if (isBanned(socket.data.ip)) {
    socket.emit('banned');
    socket.disconnect(true);
    return;
  }

  broadcastOnline();

  socket.on('find', () => {
    if (isBanned(socket.data.ip)) {
      socket.emit('banned');
      return;
    }
    enqueue(socket);
  });

  socket.on('next', () => {
    leavePartner(socket);
    removeFromQueue(socket);
    enqueue(socket);
  });

  socket.on('stop', () => {
    leavePartner(socket);
    removeFromQueue(socket);
  });

  // WebRTC offer/answer/ICE relay — only ever to the current partner.
  socket.on('signal', (data) => {
    const partner = partners.get(socket.id);
    if (partner && data && typeof data === 'object') partner.emit('signal', data);
  });

  socket.on('chat', (text) => {
    const partner = partners.get(socket.id);
    if (!partner || typeof text !== 'string') return;
    const now = Date.now();
    if (now - socket.data.lastChat < 300) return; // basic flood protection
    socket.data.lastChat = now;
    const clean = text.trim().slice(0, MAX_CHAT_LENGTH);
    if (clean) partner.emit('chat', clean);
  });

  socket.on('typing', (isTyping) => {
    const partner = partners.get(socket.id);
    if (partner) partner.emit('typing', Boolean(isTyping));
  });

  socket.on('report', () => {
    const partner = partners.get(socket.id);
    if (!partner) return;
    const target = partner.data.ip;
    const now = Date.now();
    let entry = reports.get(target);
    if (!entry || now - entry.first > REPORT_WINDOW_MS) {
      entry = { reporters: new Set(), first: now };
      reports.set(target, entry);
    }
    entry.reporters.add(socket.data.ip);
    console.log(`[report] ${target} reported (${entry.reporters.size}/${REPORTS_TO_BAN})`);

    leavePartner(socket);
    enqueue(socket);

    if (entry.reporters.size >= REPORTS_TO_BAN) {
      bans.set(target, now + BAN_DURATION_MS);
      reports.delete(target);
      for (const s of io.sockets.sockets.values()) {
        if (s.data.ip === target) {
          leavePartner(s);
          removeFromQueue(s);
          s.emit('banned');
          s.disconnect(true);
        }
      }
    }
  });

  socket.on('disconnect', () => {
    leavePartner(socket);
    removeFromQueue(socket);
    lastPartner.delete(socket.id);
    broadcastOnline();
  });
});

server.listen(PORT, () => {
  console.log(`Sudfa random video chat running on http://localhost:${PORT}`);
});
