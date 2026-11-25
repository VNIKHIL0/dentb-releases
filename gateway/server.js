const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const PORT = process.env.PORT || 5055;
const AUTH_DIR = path.join(__dirname, 'auth_session');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

let sock = null;
let lastQrDataUrl = null;
let connectionStatus = 'INITIALIZING'; // 'INITIALIZING' | 'QR_READY' | 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED'
let connectedNumber = null;
const recentLogs = [];

// ==========================================
// High-Traffic FIFO Queue & Anti-Ban Pacing
// ==========================================
const messageQueue = [];
let isProcessingQueue = false;
let totalMessagesProcessed = 0;
let totalMessagesFailed = 0;
let lastDispatchedTimestamp = 0;

// Anti-Spam / Anti-Ban human-like jitter delay:
// 1400ms base + up to 900ms jitter (total 1.4s - 2.3s per message)
// WhatsApp safely accepts high bursts without rate-limiting or blocking the number
const MIN_DISPATCH_DELAY_MS = 1400;
const JITTER_MAX_MS = 900;

function logActivity(type, recipient, message, status, error = null) {
  const entry = {
    id: 'log_' + Date.now(),
    timestamp: new Date().toLocaleTimeString(),
    type,
    recipient,
    preview: message.length > 90 ? message.substring(0, 90) + '...' : message,
    status,
    error: error ? String(error) : null
  };
  recentLogs.unshift(entry);
  if (recentLogs.length > 60) recentLogs.pop();
  return entry;
}

// Persistent cache of sent messages for End-to-End Encryption (E2EE) session key retry handshake
// Resolves WhatsApp's "Waiting for this message. This may take a while."
const CACHE_FILE = path.join(AUTH_DIR, 'sent_messages_cache.json');
let sentMessagesCache = new Map();

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      sentMessagesCache = new Map(Object.entries(data));
      console.log(`DentB Gateway: Restored ${sentMessagesCache.size} messages in E2EE Signal retry cache.`);
    }
  } catch (err) {
    console.warn('DentB Gateway: Notice loading sent cache:', err.message);
  }
}

function saveCacheToDisk() {
  try {
    const obj = Object.fromEntries(sentMessagesCache);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(obj), 'utf8');
  } catch (_) {}
}

function cacheSentMessage(id, messagePayload) {
  if (!id) return;
  sentMessagesCache.set(id, messagePayload);
  if (sentMessagesCache.size > 1000) {
    const oldestKey = sentMessagesCache.keys().next().value;
    sentMessagesCache.delete(oldestKey);
  }
  saveCacheToDisk();
}

function sanitizeJid(phone) {
  let cleaned = String(phone).replace(/[^0-9]/g, '');
  while (cleaned.startsWith('0')) {
    cleaned = cleaned.substring(1);
  }
  // Standardize 10-digit Indian mobile numbers to 91XXXXXXXXXX
  if (cleaned.length === 10) {
    cleaned = '91' + cleaned;
  }
  return cleaned + '@s.whatsapp.net';
}

async function processMessageQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (messageQueue.length > 0) {
    if (connectionStatus !== 'CONNECTED' || !sock) {
      console.log('DentB Gateway Queue: WhatsApp disconnected. Pausing dispatch until reconnected. (Queue remaining: ' + messageQueue.length + ')');
      break;
    }

    const item = messageQueue[0];
    const now = Date.now();
    const elapsed = now - lastDispatchedTimestamp;
    const requiredDelay = MIN_DISPATCH_DELAY_MS + Math.floor(Math.random() * JITTER_MAX_MS);

    if (elapsed < requiredDelay) {
      await new Promise(r => setTimeout(r, requiredDelay - elapsed));
    }

    try {
      const jid = sanitizeJid(item.phone);
      const messageText = String(item.message).trim();

      // Resolve contact & pre-warm Signal session keys via WhatsApp USync
      let targetJid = jid;
      try {
        const [contact] = await sock.onWhatsApp(jid);
        if (contact?.exists && contact?.jid) {
          targetJid = contact.jid;
        }
      } catch (_) {
        // Fall back to sanitized JID if USync lookup times out
      }

      const sent = await sock.sendMessage(targetJid, { text: messageText });
      lastDispatchedTimestamp = Date.now();
      totalMessagesProcessed++;

      // Cache exact proto.IMessage for E2EE Signal protocol retry handshake
      if (sent?.key?.id) {
        cacheSentMessage(sent.key.id, sent.message || { conversation: messageText });
      }

      logActivity(item.source || 'MESSAGE', item.phone, item.message, 'DELIVERED');
      console.log(`DentB Gateway [${item.id}]: Dispatched to ${item.phone} (Queue size: ${messageQueue.length - 1})`);
    } catch (err) {
      totalMessagesFailed++;
      console.error(`DentB Gateway [${item.id}] Error sending to ${item.phone}:`, err.message);
      logActivity(item.source || 'MESSAGE', item.phone, item.message, 'FAILED', err.message);
    } finally {
      messageQueue.shift();
    }
  }

  isProcessingQueue = false;
}

async function connectToWhatsApp() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  loadCacheFromDisk();

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['DentB Clinical OS', 'Chrome', '120.0.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: true,
    // E2EE retry callback: immediately provides key & content when recipient requests re-encryption
    getMessage: async (key) => {
      if (key?.id && sentMessagesCache.has(key.id)) {
        const item = sentMessagesCache.get(key.id);
        if (typeof item === 'object' && item !== null) {
          return item;
        }
        return { conversation: String(item) };
      }
      return { conversation: 'DentB Dental Clinic Notification' };
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Listen to incoming & outgoing messages to keep retry cache populated
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (msg.key?.id && msg.message) {
        cacheSentMessage(msg.key.id, msg.message);
      }
    }
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'QR_READY';
      lastQrDataUrl = await qrcode.toDataURL(qr, { width: 320, margin: 2 });
      console.log('DentB: New WhatsApp QR code generated. Visit http://localhost:' + PORT + ' to link clinic phone.');
    }

    if (connection === 'open') {
      connectionStatus = 'CONNECTED';
      lastQrDataUrl = null;
      connectedNumber = sock.user?.id ? sock.user.id.split(':')[0].split('@')[0] : 'Connected';
      console.log('DentB: WhatsApp Connected successfully! Active Clinic Number:', connectedNumber);
      logActivity('SYSTEM', 'Gateway', 'WhatsApp Linked Successfully (+ ' + connectedNumber + ')', 'ONLINE');
      // Drain queue if messages were waiting
      processMessageQueue();
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log('DentB: WhatsApp connection closed (code ' + statusCode + '). Reconnecting: ' + shouldReconnect);

      connectionStatus = 'DISCONNECTED';
      connectedNumber = null;

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('DentB: Logged out from WhatsApp. Resetting session credentials.');
        try {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } catch (_) {}
        setTimeout(connectToWhatsApp, 2000);
      }
    }
  });
}

// ==========================================
// REST API Endpoints for DentB App
// ==========================================

// Health Check Endpoint (For Docker / GCP / Caddy health checks)
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Gateway Status Endpoint
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    isConnected: connectionStatus === 'CONNECTED',
    connectedNumber: connectedNumber ? '+' + connectedNumber : null,
    queueLength: messageQueue.length,
    totalProcessed: totalMessagesProcessed,
    totalFailed: totalMessagesFailed,
    uptimeSeconds: Math.floor(process.uptime()),
    service: 'DentB Autonomous WhatsApp Engine (Google Compute Engine)'
  });
});

// Live QR Code Data Endpoint
app.get('/qr', (req, res) => {
  res.json({
    status: connectionStatus,
    qrDataUrl: lastQrDataUrl,
    connectedNumber: connectedNumber ? '+' + connectedNumber : null
  });
});

// Logs Endpoint
app.get('/logs', (req, res) => {
  res.json(recentLogs);
});

// Zero-Click Send WhatsApp Message (Burst-Protected FIFO Queue)
app.post('/send-message', async (req, res) => {
  const { phone, message, source } = req.body;

  if (!phone || !message) {
    return res.status(400).json({ success: false, error: 'Both phone and message fields are required.' });
  }

  if (connectionStatus !== 'CONNECTED' || !sock) {
    logActivity('MESSAGE', phone, message, 'FAILED', 'WhatsApp not linked yet. Scan QR code on gateway.');
    return res.status(503).json({
      success: false,
      error: 'Clinic WhatsApp is not connected. Please scan the QR code first.'
    });
  }

  const itemId = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const queueItem = {
    id: itemId,
    phone,
    message,
    source: source || 'DIRECT_SEND',
    enqueuedAt: Date.now()
  };

  messageQueue.push(queueItem);
  console.log(`DentB Gateway: Enqueued message ${itemId} to ${phone}. Current queue: ${messageQueue.length}`);

  // Kick off queue drain
  processMessageQueue();

  res.json({
    success: true,
    messageId: itemId,
    status: 'QUEUED',
    queuePosition: messageQueue.length,
    timestamp: Date.now()
  });
});

// Webhook ingestion for DentB WebhookDispatchService
app.post('/webhook', async (req, res) => {
  const payload = req.body || {};
  const event = payload.event || req.headers['x-dentb-event'] || 'unknown';
  const data = payload.data || {};

  console.log('DentB: Ingested webhook event: ' + event);

  // Extract phone & message from payload
  const phone = data.patientPhone || data.phone || (data.patient && data.patient.phone);
  let message = data.message || data.text;

  if (!message && event === 'appointment.booked') {
    const pName = data.patientName || 'Patient';
    const date = data.appointmentDate || 'your scheduled date';
    const time = data.appointmentTime || 'the operatory time';
    const clinic = data.clinicName || 'DentB Dental Clinic';
    message = `Hello ${pName}, your dental appointment at ${clinic} is confirmed for ${date} at ${time}. We look forward to seeing your smile!`;
  }

  if (phone && message) {
    if (connectionStatus !== 'CONNECTED' || !sock) {
      logActivity('WEBHOOK:' + event, phone, message, 'FAILED', 'WhatsApp gateway not linked');
      return res.status(503).json({ success: false, error: 'Gateway not linked' });
    }

    const itemId = 'wh_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
    messageQueue.push({
      id: itemId,
      phone,
      message,
      source: 'WEBHOOK:' + event,
      enqueuedAt: Date.now()
    });

    processMessageQueue();
    return res.json({ success: true, queued: true, queueLength: messageQueue.length });
  }

  res.json({ success: true, note: 'Event received' });
});

// Disconnect / Re-link
app.post('/logout', async (req, res) => {
  try {
    if (sock) {
      await sock.logout();
    }
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    connectionStatus = 'DISCONNECTED';
    connectedNumber = null;
    lastQrDataUrl = null;
    setTimeout(connectToWhatsApp, 1500);
    res.json({ success: true, message: 'Session cleared. Reconnecting...' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// Embedded Pairing Dashboard UI (HTML / CSS / JS)
// ==========================================
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DentB &bull; Autonomous WhatsApp Gateway (Google Cloud)</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220%22%3E<text y=%2226%22 font-size=%2224%22>🦷</text></svg>">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      background: #090e17;
      color: #f1f5f9;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 32px 16px;
    }
    .container {
      width: 100%;
      max-width: 900px;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid #1e293b;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .brand-icon {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: linear-gradient(135deg, #10b981, #06b6d4);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 22px;
      font-weight: bold;
      color: #fff;
      box-shadow: 0 4px 14px rgba(16, 185, 129, 0.3);
    }
    .brand h1 { font-size: 20px; font-weight: 700; color: #f8fafc; }
    .brand p { font-size: 13px; color: #94a3b8; }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 14px;
      border-radius: 9999px;
      font-size: 12.5px;
      font-weight: 600;
      background: #1e293b;
      border: 1px solid #334155;
    }
    .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #94a3b8;
    }
    .dot.connected { background: #10b981; box-shadow: 0 0 10px #10b981; }
    .dot.qr { background: #f59e0b; box-shadow: 0 0 10px #f59e0b; animation: pulse 1.5s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
      margin-bottom: 24px;
    }
    @media (max-width: 680px) {
      .stats-grid { grid-template-columns: 1fr; }
    }
    .stat-card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 12px;
      padding: 16px 20px;
    }
    .stat-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
    .stat-val { font-size: 22px; font-weight: 700; color: #f8fafc; margin-top: 4px; }
    .stat-sub { font-size: 11.5px; color: #64748b; margin-top: 2px; }

    .card {
      background: #0f172a;
      border: 1px solid #1e293b;
      border-radius: 14px;
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
    }
    .card-title {
      font-size: 16px;
      font-weight: 700;
      color: #e2e8f0;
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .qr-stage {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px;
      text-align: center;
    }
    .qr-box {
      background: #ffffff;
      padding: 16px;
      border-radius: 16px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.4);
      margin: 16px 0;
    }
    .qr-box img { display: block; max-width: 260px; height: auto; }
    .qr-instructions {
      font-size: 13.5px;
      color: #94a3b8;
      line-height: 1.6;
      max-width: 520px;
    }
    .connected-stage {
      display: none;
      text-align: center;
      padding: 24px;
    }
    .connected-icon {
      font-size: 48px;
      margin-bottom: 12px;
    }
    .connected-number {
      font-size: 24px;
      font-weight: 700;
      color: #10b981;
      margin-bottom: 6px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      border: none;
      transition: all 0.2s;
    }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-danger:hover { background: #dc2626; }
    .btn-primary { background: #10b981; color: #fff; }
    .btn-primary:hover { background: #059669; }

    /* Test Messenger */
    .form-row {
      display: grid;
      grid-template-columns: 1fr 2fr auto;
      gap: 12px;
      margin-top: 12px;
    }
    @media (max-width: 640px) {
      .form-row { grid-template-columns: 1fr; }
    }
    input, textarea {
      width: 100%;
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 8px;
      padding: 10px 14px;
      color: #fff;
      font-size: 14px;
    }
    input:focus, textarea:focus {
      outline: none;
      border-color: #10b981;
    }

    /* Logs Table */
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 13px;
    }
    th, td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid #1e293b;
    }
    th { color: #64748b; font-weight: 600; font-size: 11.5px; text-transform: uppercase; }
    .badge-del { color: #10b981; font-weight: 600; }
    .badge-fail { color: #ef4444; font-weight: 600; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <div class="brand-icon">&#9889;</div>
        <div>
          <h1>DentB Autonomous WhatsApp Gateway</h1>
          <p>Google Cloud Always-On Engine &bull; 100% Free &bull; Zero Doctor Clicks</p>
        </div>
      </div>
      <div class="status-badge" id="headerBadge">
        <span class="dot" id="statusDot"></span>
        <span id="statusText">Checking...</span>
      </div>
    </header>

    <!-- Real-time Stats Grid -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">FIFO Throttle Queue</div>
        <div class="stat-val" id="queueVal" style="color: #38bdf8;">0</div>
        <div class="stat-sub">Pending messages</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Messages Dispatched</div>
        <div class="stat-val" id="sentVal" style="color: #10b981;">0</div>
        <div class="stat-sub">Safely delivered to patients</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Anti-Ban Pacing</div>
        <div class="stat-val" style="color: #a78bfa;">1.4s - 2.3s</div>
        <div class="stat-sub">Humanized burst protection</div>
      </div>
    </div>

    <!-- Card 1: Pairing & Connection Status -->
    <div class="card">
      <div class="card-title">
        <span>Clinic WhatsApp Account Status</span>
        <button class="btn btn-danger" id="relinkBtn" style="display:none; padding: 6px 12px; font-size: 12px;" onclick="relink()">Disconnect / Re-link</button>
      </div>

      <!-- QR Code Stage -->
      <div class="qr-stage" id="qrStage">
        <div class="qr-box">
          <img id="qrImage" src="" alt="Scan QR Code" style="display:none;" />
          <div id="qrLoading">Generating session QR code...</div>
        </div>
        <div class="qr-instructions">
          <strong>How to link in 10 seconds:</strong><br>
          1. Open WhatsApp on your clinic mobile phone.<br>
          2. Tap <strong>Linked Devices</strong> &rarr; <strong>Link a Device</strong>.<br>
          3. Point your camera at this QR code (or link directly inside the DentB app).<br>
          <em>DentB will immediately take over all automated messaging 24/7 in the cloud!</em>
        </div>
      </div>

      <!-- Connected State -->
      <div class="connected-stage" id="connectedStage">
        <div class="connected-icon">&#10004;&#65039;</div>
        <div class="connected-number" id="connectedNumberText">+91 XXXXX XXXXX</div>
        <p style="color: #94a3b8; font-size: 14px;">Clinic WhatsApp is <strong>Online &amp; Listening 24/7</strong> on Google Compute Engine. When appointments, recalls, or invoices occur in DentB, messages are dispatched automatically without requiring any clicks from the doctor.</p>
      </div>
    </div>

    <!-- Card 2: Quick Test Console -->
    <div class="card">
      <div class="card-title">Instant Message Test Console</div>
      <p style="color: #94a3b8; font-size: 13.5px;">Test zero-click autonomous dispatch right now to any mobile phone:</p>
      <div class="form-row">
        <input type="text" id="testPhone" placeholder="Mobile number (e.g. 9790561943)" />
        <input type="text" id="testMsg" placeholder="Message text" value="Hello from DentB! Your automated dental care reminder is active." />
        <button class="btn btn-primary" onclick="sendTest()">Send WhatsApp</button>
      </div>
      <div id="testStatus" style="margin-top: 10px; font-size: 13px;"></div>
    </div>

    <!-- Card 3: Live Automation Dispatch Logs -->
    <div class="card">
      <div class="card-title">Live Dispatch Activity Log</div>
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Recipient</th>
            <th>Message Preview</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody id="logsBody">
          <tr><td colspan="5" style="color:#64748b; text-align:center;">No automated messages dispatched yet.</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <script>
    async function checkStatus() {
      try {
        const res = await fetch('/status');
        const data = await res.json();
        const dot = document.getElementById('statusDot');
        const text = document.getElementById('statusText');
        const qrStage = document.getElementById('qrStage');
        const connectedStage = document.getElementById('connectedStage');
        const relinkBtn = document.getElementById('relinkBtn');

        document.getElementById('queueVal').textContent = data.queueLength || 0;
        document.getElementById('sentVal').textContent = data.totalProcessed || 0;

        if (data.status === 'CONNECTED') {
          dot.className = 'dot connected';
          text.textContent = 'ONLINE: ' + (data.connectedNumber || 'Linked');
          qrStage.style.display = 'none';
          connectedStage.style.display = 'block';
          document.getElementById('connectedNumberText').textContent = data.connectedNumber || 'Connected';
          relinkBtn.style.display = 'inline-block';
        } else {
          dot.className = 'dot qr';
          text.textContent = 'SCAN QR CODE';
          qrStage.style.display = 'flex';
          connectedStage.style.display = 'none';
          relinkBtn.style.display = 'none';
          fetchQR();
        }
      } catch (e) {
        document.getElementById('statusDot').className = 'dot';
        document.getElementById('statusText').textContent = 'GATEWAY OFFLINE';
      }
    }

    async function fetchQR() {
      try {
        const res = await fetch('/qr');
        const data = await res.json();
        if (data.qrDataUrl) {
          const img = document.getElementById('qrImage');
          img.src = data.qrDataUrl;
          img.style.display = 'block';
          document.getElementById('qrLoading').style.display = 'none';
        }
      } catch (e) {}
    }

    async function fetchLogs() {
      try {
        const res = await fetch('/logs');
        const logs = await res.json();
        const tbody = document.getElementById('logsBody');
        if (logs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="color:#64748b; text-align:center;">No automated messages dispatched yet.</td></tr>';
          return;
        }
        tbody.innerHTML = logs.map(l => \`
          <tr>
            <td>\${l.timestamp}</td>
            <td><strong>\${l.type}</strong></td>
            <td>\${l.recipient}</td>
            <td>\${l.preview}</td>
            <td class="\${l.status === 'DELIVERED' || l.status === 'ONLINE' ? 'badge-del' : 'badge-fail'}">\${l.status}</td>
          </tr>
        \`).join('');
      } catch (e) {}
    }

    async function sendTest() {
      const phone = document.getElementById('testPhone').value.trim();
      const message = document.getElementById('testMsg').value.trim();
      const statusEl = document.getElementById('testStatus');
      if (!phone || !message) {
        statusEl.innerHTML = '<span style="color:#ef4444;">Please provide both mobile number and message text.</span>';
        return;
      }
      statusEl.innerHTML = '<span style="color:#38bdf8;">Enqueuing message in background...</span>';
      try {
        const res = await fetch('/send-message', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, message })
        });
        const d = await res.json();
        if (d.success) {
          statusEl.innerHTML = '<span style="color:#10b981;">&check; Message enqueued safely for delivery!</span>';
          checkStatus();
          fetchLogs();
        } else {
          statusEl.innerHTML = '<span style="color:#ef4444;">&cross; ' + (d.error || 'Failed to send') + '</span>';
        }
      } catch (err) {
        statusEl.innerHTML = '<span style="color:#ef4444;">&cross; Error contacting gateway service.</span>';
      }
    }

    async function relink() {
      if (!confirm('Are you sure you want to disconnect this WhatsApp account?')) return;
      await fetch('/logout', { method: 'POST' });
      checkStatus();
    }

    setInterval(checkStatus, 2500);
    setInterval(fetchLogs, 3500);
    checkStatus();
    fetchLogs();
  </script>
</body>
</html>`);
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log('====================================================');
  console.log('DentB Autonomous WhatsApp Gateway (Google Cloud)');
  console.log('  Listening on: http://0.0.0.0:' + PORT);
  console.log('  Persistent Auth: ' + AUTH_DIR);
  console.log('====================================================');
  connectToWhatsApp();
});
