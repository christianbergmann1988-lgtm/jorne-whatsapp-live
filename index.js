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
      store: store,

      // Workaround für den aktuellen RemoteAuth-ZIP-Pfadfehler
      dataPath: '.',

      // Sitzung alle 60 Sekunden sichern
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

  client.on('code', (code) => {
    console.log('================================');
    console.log('WHATSAPP KOPPLUNGSCODE:');
    console.log(code);
    console.log('================================');
  });

  client.on('authenticated', () => {
    console.log('✅ WhatsApp erfolgreich angemeldet.');
  });

  client.on('ready', () => {
    console.log('✅ WhatsApp-Bot ist bereit.');
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

  await client.initialize();

  // Nur wenn noch keine bestehende Anmeldung vorhanden ist
  if (!client.info) {
    console.log('📱 Fordere Kopplungscode an...');

    const code = await client.requestPairingCode(
      process.env.WHATSAPP_PHONE
    );

    console.log('================================');
    console.log('WHATSAPP KOPPLUNGSCODE:');
    console.log(code);
    console.log('================================');
  }
}

startBot().catch((error) => {
  console.error('❌ Startfehler:', error);
  process.exit(1);
});
