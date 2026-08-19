const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const WEB_VERSION = '2.3000.1031490220-alpha';
const TEST_TEXT = 'BOT-TEST 12345';

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
      console.log(
        '📦 Tatsächlich verwendete WhatsApp-Web-Version:',
        version
      );
    } catch (error) {
      console.log('⚠️ Web-Version konnte nicht gelesen werden.');
    }

    console.log(`🔎 Suche Testnachricht: "${TEST_TEXT}"`);

    try {
      const messages = await client.searchMessages(TEST_TEXT, {
        limit: 20
      });

      console.log('================================');
      console.log(`🔎 Gefundene Nachrichten: ${messages.length}`);
      console.log('================================');

      if (messages.length === 0) {
        console.log('❌ Testnachricht wurde nicht gefunden.');
        return;
      }

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        console.log(`--- TREFFER ${i + 1} ---`);
        console.log('Text:', msg.body);
        console.log('fromMe:', msg.fromMe);

        console.log(
          'ID serialized:',
          msg.id?._serialized || 'nicht vorhanden'
        );

        console.log(
          'ID remote:',
          msg.id?.remote || 'nicht vorhanden'
        );

        console.log(
          'FROM:',
          msg.from || 'nicht vorhanden'
        );

        console.log(
          'TO:',
          msg.to || 'nicht vorhanden'
        );

        const candidates = [
          msg.id?.remote,
          msg.from,
          msg.to
        ].filter(Boolean);

        const newsletterId =
          candidates.find(value =>
            String(value).includes('@newsletter')
          );

        if (newsletterId) {
          console.log('================================');
          console.log('🎯 KANAL-ID GEFUNDEN:');
          console.log(newsletterId);
          console.log('================================');
        }
      }

    } catch (error) {
      console.error(
        '❌ Fehler beim Suchen der Testnachricht:',
        error
      );
    }
  });

  client.on('remote_session_saved', () => {
    console.log(
      '💾 WhatsApp-Sitzung wurde in MongoDB gespeichert.'
    );
  });

  client.on('auth_failure', (msg) => {
    console.error(
      '❌ WhatsApp-Anmeldung fehlgeschlagen:',
      msg
    );
  });

  client.on('disconnected', (reason) => {
    console.log(
      '⚠️ WhatsApp getrennt:',
      reason
    );
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
