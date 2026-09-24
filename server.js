const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const env = process.env;
const PORT = env.PORT || 3000;
// Public address of the site, used in SEO tags, robots.txt and sitemap.xml.
const SITE_URL = (env.SITE_URL || 'https://sudfa.onrender.com').replace(/\/+$/, '');
const MAX_CHAT_LENGTH = 500;
const REMATCH_COOLDOWN_MS = 6000; // don't instantly re-pair the same two people
const REPORTS_TO_BAN = 3; // distinct reporters needed
const REPORT_WINDOW_MS = 60 * 60 * 1000;
const BAN_DURATION_MS = 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5 });

// ── SEO ──────────────────────────────────────────────
// Accepts either the bare token or the whole <meta> tag Search Console shows.
function googleVerificationTag() {
  const raw = env.GOOGLE_SITE_VERIFICATION;
  if (!raw) return '';
  const match = raw.match(/content="([^"]+)"/);
  const token = (match ? match[1] : raw).replace(/[^\w-]/g, '');
  return `<meta name="google-site-verification" content="${token}">`;
}

const indexHtml = fs
  .readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
  .replaceAll('%SITE_URL%', SITE_URL)
  .replace('<!--GOOGLE_SITE_VERIFICATION-->', googleVerificationTag());

app.get(['/', '/index.html'], (_req, res) => res.type('html').send(indexHtml));

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`);
});

app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml').send(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `  <url><loc>${SITE_URL}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>\n` +
      '</urlset>\n',
  );
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ── ICE servers ──────────────────────────────────────
// STUN alone only works when neither side is behind a strict NAT. Users on mobile
// data or many home ISPs need a TURN relay, configured through env vars:
//   Cloudflare: CF_TURN_KEY_ID + CF_TURN_API_TOKEN
//   Metered:    METERED_DOMAIN (e.g. myapp.metered.live) + METERED_API_KEY
//   Any other:  TURN_URL (comma-separated) + TURN_USERNAME + TURN_CREDENTIAL
const STUN_SERVERS = { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] };
const ICE_TTL_S = 24 * 60 * 60;
const ICE_CACHE_MS = 60 * 60 * 1000;
let iceCache = { servers: null, expires: 0 };

const TURN_PROVIDER =
  (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN && 'cloudflare') ||
  (env.METERED_DOMAIN && env.METERED_API_KEY && 'metered') ||
  (env.TURN_URL && 'custom') ||
  null;

async function fetchTurnServers() {
  if (TURN_PROVIDER === 'cloudflare') {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: ICE_TTL_S }),
      },
    );
    if (!res.ok) throw new Error(`Cloudflare TURN: HTTP ${res.status}`);
    const { iceServers } = await res.json();
    // Port 53 is blocked by browsers and only slows ICE gathering down.
    return iceServers.map((s) => ({ ...s, urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
  }
  if (TURN_PROVIDER === 'metered') {
    const host = env.METERED_DOMAIN.includes('.') ? env.METERED_DOMAIN : `${env.METERED_DOMAIN}.metered.live`;
    const res = await fetch(
      `https://${host}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`,
    );
    if (!res.ok) throw new Error(`Metered TURN: HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : data.iceServers;
  }
  if (TURN_PROVIDER === 'custom') {
    return [{ urls: env.TURN_URL.split(','), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }];
  }
  return [];
}

async function getIceServers() {
  if (iceCache.servers && Date.now() < iceCache.expires) return iceCache.servers;
  let turn = [];
  let cacheMs = ICE_CACHE_MS;
  try {
    turn = await fetchTurnServers();
  } catch (err) {
    console.error('[turn]', err.message);
    cacheMs = 60 * 1000; // retry the provider soon
  }
  iceCache = { servers: [STUN_SERVERS, ...turn], expires: Date.now() + cacheMs };
  return iceCache.servers;
}

app.get('/config', async (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers: await getIceServers() });
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
  if (TURN_PROVIDER) console.log(`TURN provider: ${TURN_PROVIDER}`);
  else console.warn('No TURN server configured — video will fail for many users on mobile data. See README.');
});
