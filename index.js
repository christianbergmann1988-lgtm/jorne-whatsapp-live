const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const CHANNEL_INVITE_CODE = '0029Vb9AGcELikg6ValudB0f';
const TEST_MESSAGE = 'BOT-TEST AUTOMATISCH 2';

async function startBot() {
  console.log('Verbinde mit MongoDB...');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB verbunden.');

  const store = new MongoStore({ mongoose });

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: 'jorne-whatsapp-live',
      store,
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

  client.on('code', code => {
    console.log('================================');
    console.log('📱 WHATSAPP KOPPLUNGSCODE:');
    console.log(code);
    console.log('================================');
  });

  client.on('authenticated', () => {
    console.log('✅ WhatsApp erfolgreich angemeldet.');
  });

  client.on('remote_session_saved', () => {
    console.log('💾 WhatsApp-Sitzung in MongoDB gespeichert.');
  });

  client.on('auth_failure', msg => {
    console.error('❌ Anmeldung fehlgeschlagen:', msg);
  });

  client.on('disconnected', reason => {
    console.log('⚠️ WhatsApp getrennt:', reason);
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp-Bot ist bereit.');

    try {
      const version = await client.getWWebVersion();
      console.log('📦 WhatsApp-Web-Version:', version);

      console.log('🔎 Suche Kanal über Einladungs-Code...');
      console.log('Code:', CHANNEL_INVITE_CODE);

      const channel =
        await client.getChannelByInviteCode(CHANNEL_INVITE_CODE);

      if (!channel) {
        console.error('❌ Kanal wurde nicht gefunden.');
        return;
      }

      console.log('================================');
      console.log('🎯 KANAL GEFUNDEN!');
      console.log('Name:', channel.name);
      console.log(
        'ID:',
        channel.id?._serialized || channel.id || 'unbekannt'
      );
      console.log('================================');

      console.log(
        `📤 Sende Testnachricht: "${TEST_MESSAGE}"`
      );

      const message = await channel.sendMessage(TEST_MESSAGE);

      console.log('================================');
      console.log('🎉 TESTNACHRICHT GESENDET!');
      console.log(
        'Nachrichten-ID:',
        message?.id?._serialized || 'nicht verfügbar'
      );
      console.log('================================');

    } catch (error) {
      console.error('❌ Kanal-Test fehlgeschlagen:');
      console.error(error);
    }
  });

  console.log('🚀 WhatsApp wird gestartet...');

  await client.initialize();
}

startBot().catch(error => {
  console.error('❌ Startfehler:', error);
  process.exit(1);
});
