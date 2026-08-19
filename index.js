const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

async function startBot() {
  console.log('Verbinde mit MongoDB...');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB verbunden.');

  const store = new MongoStore({ mongoose });

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: 'jorne-whatsapp-live',
      store,
      dataPath: '.',
      backupSyncIntervalMs: 60000
    }),

    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    }
  });

  client.on('authenticated', () => {
    console.log('✅ WhatsApp erfolgreich angemeldet.');
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp-Bot ist bereit.');

    try {
      const version = await client.getWWebVersion();
      console.log('📦 WhatsApp-Web-Version:', version);
    } catch (err) {
      console.log('⚠️ WhatsApp-Web-Version konnte nicht gelesen werden:', err.message);
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

  console.log('Starte WhatsApp...');

  // Wichtig: nicht darauf warten, sonst kommen wir vor der Anmeldung
  // nicht an den Pairing-Schritt.
  client.initialize();

  // WhatsApp Web Zeit zum Laden geben
  await new Promise(resolve => setTimeout(resolve, 15000));

  try {
    const version = await client.getWWebVersion();
    console.log('📦 Geladene WhatsApp-Web-Version:', version);
  } catch (err) {
    console.log('⚠️ Version vor Anmeldung nicht lesbar:', err.message);
  }

  console.log('📱 Fordere Kopplungscode an...');

  const code = await client.requestPairingCode(
    process.env.WHATSAPP_PHONE,
    true,
    180000
  );

  console.log('================================');
  console.log('WHATSAPP KOPPLUNGSCODE:');
  console.log(code);
  console.log('================================');
}

startBot().catch((error) => {
  console.error('❌ Startfehler:', error);
  process.exit(1);
});
