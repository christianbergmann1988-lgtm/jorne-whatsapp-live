const QRCode = require('qrcode');
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
      backupSyncIntervalMs: 300000
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

  client.on('qr', async (qr) => {
    console.log('📱 Neuer WhatsApp-QR-Code erhalten.');

    try {
      await QRCode.toFile('whatsapp-qr.png', qr, {
        width: 600,
        margin: 4
      });

      console.log('✅ QR-Code als whatsapp-qr.png gespeichert.');
    } catch (error) {
      console.error('❌ QR-Code konnte nicht gespeichert werden:', error);
    }
  });

  client.on('authenticated', () => {
    console.log('✅ WhatsApp erfolgreich angemeldet.');
  });

  client.on('remote_session_saved', () => {
    console.log('💾 WhatsApp-Sitzung wurde in MongoDB gespeichert.');
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp-Bot ist bereit.');

    try {
      const chats = await client.getChats();
      const channels = chats.filter(chat => chat.isChannel);

      console.log('Gefundene Kanäle:');

      channels.forEach(channel => {
        console.log(`- ${channel.name} | ${channel.id._serialized}`);
      });
    } catch (error) {
      console.error('❌ Fehler beim Laden der Kanäle:', error);
    }
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp-Anmeldung fehlgeschlagen:', msg);
  });

  client.initialize();
}

startBot().catch((error) => {
  console.error('❌ Startfehler:', error);
  process.exit(1);
});
