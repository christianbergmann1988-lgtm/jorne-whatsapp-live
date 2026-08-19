const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const CHANNEL_INVITE_CODE = '0029Vb9AGcELikg6ValudB0f';
const TEST_MESSAGE = 'BOT-TEST AUTOMATISCH CONNECTED';

let testStarted = false;

async function runChannelTest(client, reason) {
  if (testStarted) {
    return;
  }

  testStarted = true;

  console.log('================================');
  console.log('🚀 STARTE KANAL-TEST');
  console.log('Auslöser:', reason);
  console.log('================================');

  try {
    const state = await client.getState();
    console.log('📡 WhatsApp-Verbindungsstatus:', state);

    if (state !== 'CONNECTED') {
      console.log(
        '❌ WhatsApp ist noch nicht CONNECTED. Kanal-Test wird nicht gestartet.'
      );
      testStarted = false;
      return;
    }

    console.log('✅ WhatsApp ist CONNECTED.');

    try {
      const version = await client.getWWebVersion();

      console.log(
        '📦 Tatsächlich verwendete WhatsApp-Web-Version:',
        version
      );
    } catch (error) {
      console.log(
        '⚠️ WhatsApp-Web-Version konnte nicht gelesen werden.'
      );
    }

    console.log('--------------------------------');
    console.log('🔍 Prüfe verfügbare Channel-Funktionen...');

    console.log(
      'getChannelByInviteCode:',
      typeof client.getChannelByInviteCode
    );

    console.log(
      'getChannels:',
      typeof client.getChannels
    );

    console.log('--------------------------------');

    /*
     * WEG 1:
     * Direkte Suche über den Einladungs-Code.
     */
    if (typeof client.getChannelByInviteCode === 'function') {
      console.log(
        '🔎 Suche Jorne_L1ve über den WhatsApp-Kanal-Link...'
      );

      const channel =
        await client.getChannelByInviteCode(
          CHANNEL_INVITE_CODE
        );

      if (!channel) {
        console.log(
          '❌ getChannelByInviteCode() lieferte keinen Kanal.'
        );
      } else {
        console.log('================================');
        console.log('🎯 KANAL GEFUNDEN!');

        console.log(
          'Name:',
          channel.name || 'unbekannt'
        );

        console.log(
          'ID:',
          channel.id?._serialized ||
          channel.id ||
          'unbekannt'
        );

        console.log(
          'sendMessage:',
          typeof channel.sendMessage
        );

        console.log('================================');

        if (typeof channel.sendMessage === 'function') {
          console.log(
            `📤 Sende: "${TEST_MESSAGE}"`
          );

          const message =
            await channel.sendMessage(TEST_MESSAGE);

          console.log('================================');
          console.log('🎉 TESTNACHRICHT GESENDET!');

          console.log(
            'Nachrichten-ID:',
            message?.id?._serialized ||
            'nicht verfügbar'
          );

          console.log('================================');
          return;
        }

        console.log(
          '❌ Der gefundene Kanal besitzt keine sendMessage()-Funktion.'
        );
      }
    } else {
      console.log(
        '⚠️ getChannelByInviteCode() ist in dieser installierten whatsapp-web.js-Version nicht vorhanden.'
      );
    }

    /*
     * WEG 2:
     * Falls vorhanden, gecachte Kanäle auslesen.
     */
    if (typeof client.getChannels === 'function') {
      console.log('🔎 Versuche getChannels()...');

      const channels = await client.getChannels();

      console.log(
        '📺 Anzahl gefundener Kanäle:',
        channels.length
      );

      channels.forEach((channel, index) => {
        console.log(
          `Kanal ${index + 1}:`,
          channel.name || 'ohne Name',
          '| ID:',
          channel.id?._serialized ||
          channel.id ||
          'unbekannt'
        );
      });

      const jorne = channels.find(channel =>
        channel.name === 'Jorne_L1ve'
      );

      if (jorne) {
        console.log('================================');
        console.log(
          '🎯 Jorne_L1ve über getChannels() gefunden!'
        );

        console.log(
          'ID:',
          jorne.id?._serialized ||
          jorne.id ||
          'unbekannt'
        );

        console.log(
          'sendMessage:',
          typeof jorne.sendMessage
        );

        console.log('================================');

        if (typeof jorne.sendMessage === 'function') {
          console.log(
            `📤 Sende: "${TEST_MESSAGE}"`
          );

          const message =
            await jorne.sendMessage(TEST_MESSAGE);

          console.log('================================');
          console.log('🎉 TESTNACHRICHT GESENDET!');

          console.log(
            'Nachrichten-ID:',
            message?.id?._serialized ||
            'nicht verfügbar'
          );

          console.log('================================');
          return;
        }
      }
    } else {
      console.log(
        '⚠️ Auch getChannels() ist in dieser Version nicht vorhanden.'
      );
    }

    console.log('================================');
    console.log(
      '⚠️ DIREKTER CHANNEL-TEST NICHT MÖGLICH.'
    );
    console.log(
      'WhatsApp selbst ist CONNECTED, aber die installierte Bibliothek stellt die benötigte Channel-Funktion nicht erfolgreich bereit.'
    );
    console.log('================================');

  } catch (error) {
    console.log('================================');
    console.error('❌ FEHLER BEIM KANAL-TEST');
    console.error(error);
    console.log('================================');
  }
}

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
    console.log('✅ WhatsApp READY-Event erhalten.');

    await runChannelTest(
      client,
      'READY-Event'
    );
  });

  client.on('change_state', (state) => {
    console.log(
      '🔄 WhatsApp Statusänderung:',
      state
    );

    if (state === 'CONNECTED') {
      setTimeout(() => {
        runChannelTest(
          client,
          'change_state = CONNECTED'
        );
      }, 5000);
    }
  });

  client.on('remote_session_saved', () => {
    console.log(
      '💾 WhatsApp-Sitzung in MongoDB gespeichert.'
    );
  });

  client.on('auth_failure', (msg) => {
    console.error(
      '❌ Anmeldung fehlgeschlagen:',
      msg
    );
  });

  client.on('disconnected', (reason) => {
    console.log(
      '⚠️ WhatsApp getrennt:',
      reason
    );
  });

  /*
   * Sicherheitsnetz:
   * Auch wenn weder READY noch change_state sauber ausgelöst werden,
   * prüfen wir nach 60 Sekunden den tatsächlichen Status.
   */
  setTimeout(async () => {
    if (testStarted) {
      return;
    }

    try {
      const state = await client.getState();

      console.log('================================');
      console.log('⏰ 60-SEKUNDEN-CHECK');
      console.log(
        '📡 Aktueller Status:',
        state
      );
      console.log('================================');

      if (state === 'CONNECTED') {
        await runChannelTest(
          client,
          '60-Sekunden-Check = CONNECTED'
        );
      }
    } catch (error) {
      console.error(
        '❌ Statusprüfung nach 60 Sekunden fehlgeschlagen:',
        error
      );
    }
  }, 60000);

  console.log('🚀 WhatsApp wird gestartet...');

  await client.initialize();
}

startBot().catch((error) => {
  console.error('❌ Startfehler:', error);
  process.exit(1);
});
