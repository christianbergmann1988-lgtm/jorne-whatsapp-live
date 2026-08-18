const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

const client = new Client({
  authStrategy: new LocalAuth({
    clientId: 'jorne-whatsapp-live'
  }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  }
});

client.on('qr', (qr) => {
  console.log('QR-Code mit WhatsApp scannen:');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ WhatsApp erfolgreich angemeldet.');
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
    console.error('Fehler beim Laden der Kanäle:', error);
  }
});

client.on('auth_failure', (msg) => {
  console.error('❌ WhatsApp-Anmeldung fehlgeschlagen:', msg);
});

client.initialize();
