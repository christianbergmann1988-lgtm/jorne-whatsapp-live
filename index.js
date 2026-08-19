const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const WEB_VERSION = '2.3000.1031490220-alpha';

async function startBot() {
  console.log('Verbinde mit MongoDB...');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB verbunden.');

  const store = new MongoStore({ mongoose });

  const client = new Client({
    webVersion: WEB_VERSION,

    webVersionCache: {
      type: 'remote',
      remotePath:
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1031490220-alpha.html'
    },

    authStrategy: new RemoteAuth({
      clientId: 'jorne-whatsapp-live',
      store,
      dataPath: '.',
      backupSyncIntervalMs: 60000
    }),

    pairWithPhoneNumber: {
      phoneNumber: process.env.WHATSAPP_PHONE,
      showNotification: true,
      intervalMs: 180000
    },

    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    }
  });

  client.on('code', (code) => {
    console.log('================================');
    console.log('📱 WHATSAPP KOPPLUNGSCODE:');
    console.log(code);
    console.log('================================');
  });

  client.on('authenticated', () => {
    console.log('✅ WhatsApp erfolgreich angemeldet.');
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp-Bot ist bereit.');

    try {
      const version = await client.getWWebVersion();
      console.log('📦 Tatsächlich verwendete WhatsApp-Web-Version:', version);
    } catch (error) {
      console.log('⚠️ Web-Version konnte nicht gelesen werden.');
    }
  });

  client.on('remote_session_saved', () => {
    console.log('💾 WhatsApp-Sitzung wurde in MongoDB gespeichert.');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp-Anmeldung fehlgeschlagen:', msg);
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp getrennt:', reason);
  });

  console.log(
    `Starte WhatsApp mit festgelegter Web-Version ${WEB_VERSION}...`
  );

  await client.initialize();
}

startBot().catch((error) => {
  console.error('❌ Startfehler:', error);
  process.exit(1);
});
