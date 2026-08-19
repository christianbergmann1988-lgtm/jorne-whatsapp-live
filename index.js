const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const CHANNEL_INVITE_CODE = '0029Vb9AGcELikg6ValudB0f';
const CHANNEL_NAME = 'Jorne_L1ve';
const TEST_MESSAGE = 'BOT-TEST AUTOMATISCH 3';

const AUTH_DATA_PATH = path.resolve('./.wwebjs_auth');
const CLIENT_ID = 'jorne-whatsapp-live';

let channelTestStarted = false;


/*
 * ============================================================
 * FIX FÜR whatsapp-web.js 1.34.7 + wwebjs-mongo
 * ============================================================
 *
 * RemoteAuth 1.34.7 legt seine ZIP unter dataPath ab.
 *
 * wwebjs-mongo 1.1.0 sucht beim Speichern dagegen normalerweise:
 *
 *   RemoteAuth-xxxx.zip
 *
 * direkt im aktuellen Arbeitsordner.
 *
 * Dieser Store verwendet stattdessen den tatsächlichen
 * RemoteAuth-Pfad.
 */
class FixedMongoStore extends MongoStore {
  constructor({ mongoose, dataPath }) {
    super({ mongoose });

    this.fixedMongoose = mongoose;
    this.dataPath = dataPath;
  }

  async save(options) {
    const session = options.session;

    const zipPath = path.join(
      this.dataPath,
      `${session}.zip`
    );

    console.log(
      '💾 MongoStore: Speichere Sitzung aus:',
      zipPath
    );

    if (!fs.existsSync(zipPath)) {
      throw new Error(
        `RemoteAuth-ZIP wurde nicht gefunden: ${zipPath}`
      );
    }

    const bucket =
      new this.fixedMongoose.mongo.GridFSBucket(
        this.fixedMongoose.connection.db,
        {
          bucketName: `whatsapp-${session}`
        }
      );

    await new Promise((resolve, reject) => {
      const readStream =
        fs.createReadStream(zipPath);

      const uploadStream =
        bucket.openUploadStream(
          `${session}.zip`
        );

      readStream.on('error', reject);
      uploadStream.on('error', reject);
      uploadStream.on('finish', resolve);

      readStream.pipe(uploadStream);
    });

    /*
     * Alte Sicherungen entfernen.
     * Die neueste bleibt erhalten.
     */
    const documents = await bucket
      .find({
        filename: `${session}.zip`
      })
      .sort({ uploadDate: -1 })
      .toArray();

    if (documents.length > 1) {
      for (const oldDocument of documents.slice(1)) {
        try {
          await bucket.delete(oldDocument._id);
        } catch (error) {
          console.log(
            '⚠️ Alte MongoDB-Sicherung konnte nicht gelöscht werden:',
            error.message
          );
        }
      }
    }

    console.log(
      '✅ WhatsApp-Sitzung erfolgreich in MongoDB gespeichert.'
    );
  }
}


/*
 * ============================================================
 * KANAL-TEST
 * ============================================================
 */

async function runChannelTest(client, reason) {
  if (channelTestStarted) {
    return;
  }

  channelTestStarted = true;

  console.log('================================');
  console.log('🚀 STARTE KANAL-TEST');
  console.log('Auslöser:', reason);
  console.log('================================');

  try {
    const state = await client.getState();

    console.log(
      '📡 WhatsApp-Verbindungsstatus:',
      state
    );

    if (state !== 'CONNECTED') {
      console.log(
        '❌ WhatsApp ist noch nicht CONNECTED.'
      );

      channelTestStarted = false;
      return;
    }

    console.log('✅ WhatsApp ist CONNECTED.');

    try {
      const webVersion =
        await client.getWWebVersion();

      console.log(
        '📦 WhatsApp-Web-Version:',
        webVersion
      );
    } catch (error) {
      console.log(
        '⚠️ Web-Version konnte nicht gelesen werden.'
      );
    }

    console.log('--------------------------------');
    console.log(
      '🔍 Prüfe Channel-Funktionen...'
    );

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
     * --------------------------------------------------------
     * WEG 1:
     * Kanal über Einladungs-Code laden.
     * --------------------------------------------------------
     */

    if (
      typeof client.getChannelByInviteCode ===
      'function'
    ) {
      try {
        console.log(
          `🔎 Suche "${CHANNEL_NAME}" über den Kanal-Link...`
        );

        const channel =
          await client.getChannelByInviteCode(
            CHANNEL_INVITE_CODE
          );

        if (channel) {
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

          if (
            typeof channel.sendMessage ===
            'function'
          ) {
            console.log(
              `📤 Sende Testnachricht: "${TEST_MESSAGE}"`
            );

            const result =
              await channel.sendMessage(
                TEST_MESSAGE
              );

            console.log('================================');
            console.log(
              '🎉 TESTNACHRICHT GESENDET!'
            );

            console.log(
              'Nachrichten-ID:',
              result?.id?._serialized ||
                'nicht verfügbar'
            );

            console.log('================================');

            return;
          }
        } else {
          console.log(
            '⚠️ getChannelByInviteCode lieferte keinen Kanal.'
          );
        }

      } catch (error) {
        console.log(
          '⚠️ Direkte Kanalsuche über Invite-Code fehlgeschlagen.'
        );

        console.log(
          'Fehler:',
          error?.message || error
        );
      }
    }


    /*
     * --------------------------------------------------------
     * WEG 2:
     * gecachte Kanäle versuchen.
     * --------------------------------------------------------
     */

    if (
      typeof client.getChannels ===
      'function'
    ) {
      try {
        console.log(
          '🔎 Versuche getChannels()...'
        );

        const channels =
          await client.getChannels();

        console.log(
          '📺 Gefundene Kanäle:',
          channels.length
        );

        for (
          let i = 0;
          i < channels.length;
          i++
        ) {
          const channel = channels[i];

          console.log(
            `Kanal ${i + 1}:`,
            channel.name || 'ohne Name',
            '| ID:',
            channel.id?._serialized ||
              channel.id ||
              'unbekannt'
          );
        }

        const target =
          channels.find(
            channel =>
              channel.name === CHANNEL_NAME
          );

        if (target) {
          console.log('================================');
          console.log(
            `🎯 ${CHANNEL_NAME} über getChannels() gefunden!`
          );

          console.log(
            'ID:',
            target.id?._serialized ||
              target.id ||
              'unbekannt'
          );

          console.log(
            'sendMessage:',
            typeof target.sendMessage
          );

          console.log('================================');

          if (
            typeof target.sendMessage ===
            'function'
          ) {
            console.log(
              `📤 Sende Testnachricht: "${TEST_MESSAGE}"`
            );

            const result =
              await target.sendMessage(
                TEST_MESSAGE
              );

            console.log('================================');
            console.log(
              '🎉 TESTNACHRICHT GESENDET!'
            );

            console.log(
              'Nachrichten-ID:',
              result?.id?._serialized ||
                'nicht verfügbar'
            );

            console.log('================================');

            return;
          }
        }

      } catch (error) {
        console.log(
          '⚠️ getChannels() ist fehlgeschlagen.'
        );

        console.log(
          'Fehler:',
          error?.message || error
        );
      }
    }

    console.log('================================');
    console.log(
      '⚠️ Kanal konnte über die aktuelle API noch nicht erfolgreich angesprochen werden.'
    );
    console.log('================================');

  } catch (error) {
    console.log('================================');
    console.error(
      '❌ Fehler beim Kanal-Test:'
    );
    console.error(error);
    console.log('================================');
  }
}


/*
 * ============================================================
 * BOT STARTEN
 * ============================================================
 */

async function startBot() {
  /*
   * Auf jedem frischen GitHub-Runner existiert dieser
   * Ordner zunächst nicht.
   *
   * RemoteAuth 1.34.7 erwartet ihn beim Wiederherstellen
   * der MongoDB-Sitzung.
   */
  fs.mkdirSync(
    AUTH_DATA_PATH,
    {
      recursive: true
    }
  );

  console.log(
    '📁 RemoteAuth-Ordner bereit:',
    AUTH_DATA_PATH
  );

  console.log(
    'Verbinde mit MongoDB...'
  );

  await mongoose.connect(
    process.env.MONGODB_URI
  );

  console.log(
    '✅ MongoDB verbunden.'
  );


  const store =
    new FixedMongoStore({
      mongoose,
      dataPath: AUTH_DATA_PATH
    });


  /*
   * Nur Diagnose:
   * Wir prüfen, ob MongoDB bereits eine Sitzung besitzt.
   */

  try {
    const sessionExists =
      await store.sessionExists({
        session:
          `RemoteAuth-${CLIENT_ID}`
      });

    console.log(
      '🗄️ Gespeicherte MongoDB-Sitzung vorhanden:',
      sessionExists
    );
  } catch (error) {
    console.log(
      '⚠️ MongoDB-Sitzungsstatus konnte nicht geprüft werden:',
      error.message
    );
  }


  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: CLIENT_ID,

      store,

      dataPath:
        AUTH_DATA_PATH,

      backupSyncIntervalMs:
        60000,

      rmMaxRetries:
        10
    }),

    pairWithPhoneNumber: {
      phoneNumber:
        process.env.WHATSAPP_PHONE,

      showNotification:
        true,

      intervalMs:
        180000
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


  /*
   * ========================================================
   * EVENTS
   * ========================================================
   */

  client.on(
    'code',
    code => {
      console.log('================================');
      console.log(
        '📱 WHATSAPP KOPPLUNGSCODE:'
      );
      console.log(code);
      console.log('================================');
    }
  );


  client.on(
    'authenticated',
    () => {
      console.log(
        '✅ WhatsApp erfolgreich angemeldet.'
      );
    }
  );


  client.on(
    'remote_session_saved',
    () => {
      console.log(
        '💾 REMOTE SESSION SAVED wurde ausgelöst.'
      );
    }
  );


  client.on(
    'auth_failure',
    message => {
      console.error(
        '❌ WhatsApp-Anmeldung fehlgeschlagen:',
        message
      );
    }
  );


  client.on(
    'disconnected',
    reason => {
      console.log(
        '⚠️ WhatsApp getrennt:',
        reason
      );
    }
  );


  client.on(
    'change_state',
    state => {
      console.log(
        '🔄 WhatsApp Statusänderung:',
        state
      );

      if (
        state === 'CONNECTED'
      ) {
        setTimeout(
          () => {
            runChannelTest(
              client,
              'change_state = CONNECTED'
            );
          },
          5000
        );
      }
    }
  );


  client.on(
    'ready',
    async () => {
      console.log(
        '✅ WhatsApp READY-Event erhalten.'
      );

      await runChannelTest(
        client,
        'READY-Event'
      );
    }
  );


  /*
   * Sicherheitsnetz:
   *
   * Bei dir kam READY teilweise nicht,
   * obwohl getState() bereits CONNECTED meldete.
   */

  setTimeout(
    async () => {
      if (
        channelTestStarted
      ) {
        return;
      }

      try {
        const state =
          await client.getState();

        console.log('================================');
        console.log(
          '⏰ 60-SEKUNDEN-CHECK'
        );

        console.log(
          '📡 Aktueller Status:',
          state
        );

        console.log('================================');

        if (
          state === 'CONNECTED'
        ) {
          await runChannelTest(
            client,
            '60-Sekunden-Check = CONNECTED'
          );
        }

      } catch (error) {
        console.error(
          '❌ 60-Sekunden-Statusprüfung fehlgeschlagen:',
          error
        );
      }
    },
    60000
  );


  console.log(
    '🚀 WhatsApp wird gestartet...'
  );

  await client.initialize();
}


/*
 * ============================================================
 * START
 * ============================================================
 */

startBot().catch(
  error => {
    console.error(
      '❌ STARTFEHLER:'
    );

    console.error(error);

    process.exit(1);
  }
);
