// index.js
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

let sock;
let qrCode = null;
let isConnected = false;


// Firebase configuration
import { initializeApp, getApps } from 'firebase/app';
import { getDatabase, ref, set } from 'firebase/database';

const firebaseConfig = {
  apiKey: "AIzaSyCdaA5mIgysrnyLrMOL9wwuVafKcWeNFEM",
  authDomain: "x-kira.firebaseapp.com",
  databaseURL: "https://x-kira-default-rtdb.firebaseio.com",
  projectId: "x-kira",
  storageBucket: "x-kira.firebasestorage.app",
  messagingSenderId: "215930236545",
  appId: "1:215930236545:web:a953b6672ab4894199a780",
  measurementId: "G-NKLB18HE1R"
};

const firebaseApp = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const database = getDatabase(firebaseApp);

// Logger
const logger = pino({ level: 'silent' });

// Store user in Firebase
async function storeUserInFirebase(phoneNumber) {
  try {
    const userRef = ref(database, `users/${phoneNumber}`);
    await set(userRef, {
      phoneNumber,
      verified: true,
      verifiedAt: new Date().toISOString()
    });
    console.log(`User ${phoneNumber} stored in Firebase`);
    return true;
  } catch (error) {
    console.error('Error storing user in Firebase:', error);
    return false;
  }
}

// Delete auth folder
function deleteAuthFolder(sessionPath) {
  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true });
      console.log(`Deleted auth folder: ${sessionPath}`);
      return true;
    }
  } catch (error) {
    console.error('Error deleting auth folder:', error);
  }
  return false;
}

// Connect to WhatsApp
async function connectToWhatsApp(sessionPath = './auth_info', usePairingCode = false) {
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    browser: Browsers.ubuntu("Firefox"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
  });

  // Save credentials on update
  sock.ev.on('creds.update', saveCreds);

  // Connection update handler
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

  

    if (connection === 'close') {
      const shouldReconnect = 
        (lastDisconnect?.error instanceof Boom) &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;

      console.log('Connection closed. Reason:', lastDisconnect?.error);

      if (shouldReconnect) {
        console.log('Reconnecting...');
        setTimeout(() => connectToWhatsApp(sessionPath), 3000);
      } else {
        console.log('Logged out, not reconnecting');
        isConnected = false;
      }
    } else if (connection === 'open') {
      console.log('Connected to WhatsApp ✓');
      isConnected = true;

    }
  });

// Message handler
sock.ev.on('messages.upsert', async ({ messages, type }) => {
  if (type !== 'notify') return;

  for (const msg of messages) {
    if (!msg.message) continue;

    // Get message text
    const messageText =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      '';

    // Get sender info
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith('@g.us');
    const isChannel = remoteJid.endsWith('@newsletter');

    // Skip groups and channels
    if (isGroup || isChannel) continue;

    // Skip messages from the bot itself
    //if (msg.key.fromMe) continue;


    // --- ✅ PING TEST ---
    if (/^ping$/i.test(messageText.trim())) {
      const start = Date.now();
      const sentMsg = await sock.sendMessage(remoteJid, { text: '🏓 Pong!' });
      const latency = Date.now() - start;

      await sock.sendMessage(remoteJid, {
        text: `⚡ *Response Time:* ${latency}ms`
      });
      console.log(`Ping test from ${remoteJid}: ${latency}ms`);
      continue;
    }

    // --- 🔐 PAIRING REQUEST ---
    const pairRegex = /pair\s+me\s+x-kira\s+pro/i;

    if (pairRegex.test(messageText)) {
      console.log(`Pairing request detected from ${remoteJid}`);

      // Choose random delay (2, 5, or 8 minutes)
      const possibleDelays = [2, 5, 8];
      const randomDelayMinutes = possibleDelays[Math.floor(Math.random() * possibleDelays.length)];
      const delayMs = randomDelayMinutes * 60 * 1000;

      console.log(`Processing ${remoteJid} in ${randomDelayMinutes} minutes...`);

      setTimeout(async () => {
        try {
          const phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
          const stored = await storeUserInFirebase(phoneNumber);

          if (stored) {
            await sock.sendMessage(remoteJid, {
              text: `pair again x-kira pro ${phoneNumber}`
            });
            console.log(`User ${phoneNumber} verified successfully`);
          } else {
            await sock.sendMessage(remoteJid, {
              text: '❌ *Verification Failed*\n\nThere was an error processing your request. Please try again later.'
            });
          }
        } catch (error) {
          console.error('Error processing pairing request:', error);
          await sock.sendMessage(remoteJid, {
            text: '❌ *Error*\n\nAn error occurred. Please try again.'
          });
        }
      }, delayMs);

      // Immediate acknowledgment
      await sock.sendMessage(remoteJid, {
        text: `Bro Please wait...`
      });
    }
  }
});

  return sock;
}

// Express routes
app.get('/', (req, res) => {
  res.json({
    status: isConnected ? 'connected' : 'disconnected',
    message: 'WhatsApp Bot is running'
  });
});

app.get('/pair', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ 
      error: 'Phone number required',
      example: '/pair?code=1234567890'
    });
  }

  try {
    if (!sock) {
      return res.status(500).json({ error: 'Bot not initialized. Please restart the bot.' });
    }

    if (isConnected) {
      return res.status(400).json({ 
        error: 'Bot is already connected',
        message: 'Use /logout first to disconnect'
      });
    }

    // Clean phone number (remove spaces, dashes, plus signs)
    const cleanNumber = code.replace(/[\s\-\+]/g, '');
    
    // Validate phone number (should be digits only)
    if (!/^\d+$/.test(cleanNumber)) {
      return res.status(400).json({ 
        error: 'Invalid phone number format',
        message: 'Phone number should contain only digits',
        example: '/pair?code=1234567890'
      });
    }

    // Request pairing code
    const pairingCode = await sock.requestPairingCode(cleanNumber);
    
    res.json({
      success: true,
      pairingCode,
      phoneNumber: cleanNumber,
      message: `Enter this code in WhatsApp:\n1. Open WhatsApp\n2. Go to Settings > Linked Devices\n3. Tap "Link a Device"\n4. Enter the code: ${pairingCode}`
    });
  } catch (error) {
    console.error('Pairing error:', error);
    res.status(500).json({
      error: 'Failed to generate pairing code',
      details: error.message,
      tip: 'Make sure the bot is not already connected. Try /logout first.'
    });
  }
});

app.get('/logout', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: 'Phone number code required' });
  }

  try {
    // Logout from WhatsApp
    if (sock) {
      await sock.logout();
    }

    // Delete auth folder
    const sessionPath = './auth_info';
    const deleted = deleteAuthFolder(sessionPath);

    res.json({
      success: true,
      message: 'Logged out successfully',
      authFolderDeleted: deleted
    });

    // Don't reconnect after logout
    isConnected = false;
    sock = null;

  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({
      error: 'Failed to logout',
      details: error.message
    });
  }
});


app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    hasQR: !!qrCode
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Pairing URL: http://localhost:${PORT}/pair?code=YOUR_NUMBER`);
  console.log(`Logout URL: http://localhost:${PORT}/logout?code=YOUR_NUMBER`);
  
  // Connect to WhatsApp
  await connectToWhatsApp();
});