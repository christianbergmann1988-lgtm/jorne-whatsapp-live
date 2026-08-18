const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
  client.initialize();

  console.log('⏳ Warte 20 Sekunden, bis WhatsApp Web vollständig geladen ist...');
  await sleep(20000);

  let pairingCode = null;

  for (let versuch = 1; versuch <= 4; versuch++) {
    try {
      console.log(`📱 Kopplungscode anfordern – Versuch ${versuch}/4...`);

      pairingCode = await client.requestPairingCode(
        process.env.WHATSAPP_PHONE,
        true,
        180000
      );

      if (pairingCode) {
        console.log('================================');
        console.log('WHATSAPP KOPPLUNGSCODE:');
        console.log(pairingCode);
        console.log('================================');
        break;
      }
    } catch (error) {
      console.log(`⚠️ Versuch ${versuch} fehlgeschlagen.`);

      if (versuch < 4) {
        console.log('⏳ Warte 15 Sekunden und versuche es erneut...');
        await sleep(15000);
      }
    }
  }

  if (!pairingCode) {
    throw new Error(
      'Nach 4 Versuchen konnte kein WhatsApp-Kopplungscode erzeugt werden.'
    );
  }

  console.log('⏳ Bot bleibt jetzt aktiv. Kopplung am Handy durchführen.');
}

startBot().catch((error) => {
  console.error('❌ Startfehler:', error);
  process.exit(1);
});
