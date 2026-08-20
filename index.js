const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');


/*
============================================================
EINSTELLUNGEN
============================================================
*/

const TIKTOK_USERNAME = 'feliiiocean';

const CHANNEL_NAME = 'Jorne_L1ve';

const LIVE_MESSAGE =
  `🔴 Jorne ist jetzt LIVE auf TikTok!\n\n` +
  `👉 Direkt zum Live:\n` +
  `https://www.tiktok.com/@${TIKTOK_USERNAME}/live`;

const LIVE_MESSAGE_PHRASE =
  'Jorne ist jetzt LIVE auf TikTok!';

const LIVE_URL =
  `https://www.tiktok.com/@${TIKTOK_USERNAME}/live`;

const CLIENT_ID = 'jorne-whatsapp-live';

const AUTH_DATA_PATH =
  path.resolve('./.wwebjs_auth');

const TIKTOK_TIMEOUT_MS =
  20000;

const WHATSAPP_READY_TIMEOUT_MS =
  90000;

const WHATSAPP_STABLE_MS =
  10000;


/*
============================================================
MONGODB: TIKTOK + WHATSAPP STATUS
============================================================
*/

const TikTokStateSchema =
  new mongoose.Schema(
    {
      username: {
        type: String,
        required: true,
        unique: true
      },

      live: {
        type: Boolean,
        default: false
      },

      changedAt: {
        type: Date,
        default: Date.now
      },

      whatsappSent: {
        type: Boolean,
        default: false
      },

      whatsappError: {
        type: String,
        default: null
      },

      /*
       * Echte WhatsApp-ID der vom Bot
       * erzeugten Live-Meldung.
       */

      botMessageId: {
        type: String,
        default: null
      },

      /*
       * Echte WhatsApp-ID des Kanals.
       */

      botChannelId: {
        type: String,
        default: null
      },

      botMessageSentAt: {
        type: Date,
        default: null
      },

      /*
       * Falls Löschen einmal fehlschlägt,
       * darf ein späterer Offline-Run
       * exakt dieselbe Nachricht erneut versuchen.
       */

      deletePending: {
        type: Boolean,
        default: false
      }
    },
    {
      versionKey: false
    }
  );


const TikTokState =
  mongoose.models.TikTokState ||
  mongoose.model(
    'TikTokState',
    TikTokStateSchema
  );


/*
============================================================
STATUS LADEN
============================================================
*/

async function getSavedState() {

  const state =
    await TikTokState
      .findOne({
        username:
          TIKTOK_USERNAME
      })
      .lean();


  return state || {
    username:
      TIKTOK_USERNAME,

    live:
      false,

    whatsappSent:
      false,

    whatsappError:
      null,

    botMessageId:
      null,

    botChannelId:
      null,

    botMessageSentAt:
      null,

    deletePending:
      false
  };
}


/*
============================================================
OFFLINE + KOMPLETT ZURÜCKSETZEN
============================================================
*/

async function resetOfflineState() {

  await TikTokState.updateOne(
    {
      username:
        TIKTOK_USERNAME
    },

    {
      $set: {

        live:
          false,

        whatsappSent:
          false,

        whatsappError:
          null,

        botMessageId:
          null,

        botChannelId:
          null,

        botMessageSentAt:
          null,

        deletePending:
          false,

        changedAt:
          new Date()
      }
    },

    {
      upsert:
        true
    }
  );
}


/*
============================================================
OFFLINE + LÖSCHUNG NOCH OFFEN
============================================================
*/

async function markDeletePending(
  error = null
) {

  await TikTokState.updateOne(
    {
      username:
        TIKTOK_USERNAME
    },

    {
      $set: {

        live:
          false,

        deletePending:
          true,

        whatsappError:
          error
            ? String(
                error?.message ||
                error
              )
            : null,

        changedAt:
          new Date()
      }
    },

    {
      upsert:
        true
    }
  );
}


/*
============================================================
WHATSAPP-LIVE-MELDUNG ERFOLGREICH SPEICHERN
============================================================
*/

async function setWhatsAppSuccess(
  message,
  channel
) {

  const messageId =
    message?.id?._serialized ||
    null;


  const channelId =
    channel?.id?._serialized ||
    null;


  if (!messageId) {

    throw new Error(
      'Nach dem Senden wurde keine WhatsApp-Message-ID zurückgegeben.'
    );
  }


  if (!channelId) {

    throw new Error(
      'Nach dem Senden wurde keine WhatsApp-Kanal-ID zurückgegeben.'
    );
  }


  await TikTokState.updateOne(
    {
      username:
        TIKTOK_USERNAME
    },

    {
      $set: {

        live:
          true,

        whatsappSent:
          true,

        whatsappError:
          null,

        botMessageId:
          messageId,

        botChannelId:
          channelId,

        botMessageSentAt:
          new Date(),

        deletePending:
          false,

        changedAt:
          new Date()
      }
    },

    {
      upsert:
        true
    }
  );


  console.log(
    '🔐 Bot-Message-ID gespeichert:',
    messageId
  );


  console.log(
    '📺 Bot-Kanal-ID gespeichert:',
    channelId
  );
}


/*
============================================================
WHATSAPP-SENDEFEHLER

LIVE BLEIBT TRUE.
DADURCH KEIN NEUER SENDVERSUCH JEDE MINUTE.
============================================================
*/

async function setWhatsAppFailure(
  error
) {

  await TikTokState.updateOne(
    {
      username:
        TIKTOK_USERNAME
    },

    {
      $set: {

        live:
          true,

        whatsappSent:
          false,

        whatsappError:
          String(
            error?.message ||
            error
          ),

        changedAt:
          new Date()
      }
    },

    {
      upsert:
        true
    }
  );
}


/*
============================================================
NEUEN LIVE-START ATOMAR RESERVIEREN
============================================================
*/

async function claimNewLiveStart() {

  const existingOffline =
    await TikTokState.findOneAndUpdate(
      {
        username:
          TIKTOK_USERNAME,

        live:
          false,

        /*
         * Wenn eine alte Meldung noch auf
         * Löschung wartet, darf nicht gleichzeitig
         * ein neuer Versand reserviert werden.
         */

        deletePending: {
          $ne:
            true
        }
      },

      {
        $set: {

          live:
            true,

          whatsappSent:
            false,

          whatsappError:
            null,

          changedAt:
            new Date()
        }
      },

      {
        new:
          true
      }
    );


  if (existingOffline) {

    return true;
  }


  const existing =
    await TikTokState
      .findOne({
        username:
          TIKTOK_USERNAME
      })
      .lean();


  if (existing) {

    return false;
  }


  /*
   * Erster Lauf überhaupt.
   */

  try {

    await TikTokState.create({

      username:
        TIKTOK_USERNAME,

      live:
        true,

      whatsappSent:
        false,

      whatsappError:
        null,

      deletePending:
        false,

      changedAt:
        new Date()
    });


    return true;

  } catch (error) {

    if (
      error?.code ===
      11000
    ) {

      return false;
    }


    throw error;
  }
}


/*
============================================================
REMOTEAUTH + MONGODB FIX
============================================================
*/

class FixedMongoStore
  extends MongoStore {

  constructor({
    mongoose,
    dataPath
  }) {

    super({
      mongoose
    });


    this.fixedMongoose =
      mongoose;


    this.dataPath =
      dataPath;
  }


  async save(options) {

    const session =
      options.session;


    const zipPath =
      path.join(
        this.dataPath,
        `${session}.zip`
      );


    console.log(
      '💾 MongoStore: Speichere Sitzung aus:',
      zipPath
    );


    if (
      !fs.existsSync(
        zipPath
      )
    ) {

      throw new Error(
        `RemoteAuth-ZIP wurde nicht gefunden: ${zipPath}`
      );
    }


    const bucket =
      new this.fixedMongoose.mongo.GridFSBucket(
        this.fixedMongoose.connection.db,

        {
          bucketName:
            `whatsapp-${session}`
        }
      );


    await new Promise(
      (
        resolve,
        reject
      ) => {

        const readStream =
          fs.createReadStream(
            zipPath
          );


        const uploadStream =
          bucket.openUploadStream(
            `${session}.zip`
          );


        readStream.on(
          'error',
          reject
        );


        uploadStream.on(
          'error',
          reject
        );


        uploadStream.on(
          'finish',
          resolve
        );


        readStream.pipe(
          uploadStream
        );
      }
    );


    const documents =
      await bucket
        .find({
          filename:
            `${session}.zip`
        })
        .sort({
          uploadDate:
            -1
        })
        .toArray();


    if (
      documents.length >
      1
    ) {

      for (
        const document
        of documents.slice(1)
      ) {

        try {

          await bucket.delete(
            document._id
          );

        } catch (error) {

          console.log(
            '⚠️ Alte Sicherung konnte nicht gelöscht werden:',
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
============================================================
HILFSFUNKTIONEN
============================================================
*/

function sleep(ms) {

  return new Promise(
    resolve =>
      setTimeout(
        resolve,
        ms
      )
  );
}


function withTimeout(
  promise,
  milliseconds,
  message
) {

  let timeout;


  const timeoutPromise =
    new Promise(
      (
        _,
        reject
      ) => {

        timeout =
          setTimeout(
            () => {

              const error =
                new Error(
                  message
                );


              error.name =
                'TimeoutError';


              reject(
                error
              );

            },

            milliseconds
          );
      }
    );


  return Promise
    .race([
      promise,
      timeoutPromise
    ])
    .finally(
      () => {

        clearTimeout(
          timeout
        );
      }
    );
}


/*
============================================================
TIKTOK EINMAL PRÜFEN
============================================================
*/

async function checkTikTokLive() {

  const module =
    await import(
      'tiktok-live-connector'
    );


  const TikTokLiveConnection =
    module.TikTokLiveConnection;


  if (
    !TikTokLiveConnection
  ) {

    throw new Error(
      'TikTokLiveConnection konnte nicht geladen werden.'
    );
  }


  const connection =
    new TikTokLiveConnection(
      TIKTOK_USERNAME,
      {}
    );


  try {

    console.log(
      `🔎 Prüfe TikTok-Status von @${TIKTOK_USERNAME} ...`
    );


    const live =
      await withTimeout(

        connection.fetchIsLive(),

        TIKTOK_TIMEOUT_MS,

        `TikTok antwortet nach ${TIKTOK_TIMEOUT_MS / 1000} Sekunden nicht.`
      );


    console.log(
      `📡 TikTok-Status: ${live ? 'LIVE 🔴' : 'offline ⚫'}`
    );


    return Boolean(
      live
    );

  } finally {

    try {

      await connection.disconnect();

    } catch {}
  }
}


/*
============================================================
PUPPETEER/WHATSAPP PRÜFEN
============================================================
*/

function assertPageAlive(
  client,
  step
) {

  const page =
    client?.pupPage;


  if (!page) {

    throw new Error(
      `WhatsApp-Seite fehlt bei "${step}".`
    );
  }


  if (
    typeof page.isClosed ===
      'function' &&
    page.isClosed()
  ) {

    throw new Error(
      `WhatsApp/Puppeteer-Seite wurde bei "${step}" geschlossen.`
    );
  }
}


/*
============================================================
AUF STABILES WHATSAPP WARTEN
============================================================
*/

async function waitForStableWhatsApp(
  client
) {

  console.log(
    '⏳ Warte, bis WhatsApp Web stabil ist...'
  );


  const started =
    Date.now();


  let stableSince =
    null;


  while (
    Date.now() -
      started <
    WHATSAPP_READY_TIMEOUT_MS
  ) {

    let state =
      null;


    try {

      state =
        await client.getState();

    } catch {}


    const page =
      client.pupPage;


    const pageAlive =
      page &&
      (
        typeof page.isClosed !==
          'function' ||
        !page.isClosed()
      );


    if (
      state ===
        'CONNECTED' &&
      pageAlive
    ) {

      if (
        stableSince ===
        null
      ) {

        stableSince =
          Date.now();


        console.log(
          '🟢 WhatsApp CONNECTED – Stabilitätsprüfung läuft...'
        );
      }


      if (
        Date.now() -
          stableSince >=
        WHATSAPP_STABLE_MS
      ) {

        console.log(
          `✅ WhatsApp seit ${WHATSAPP_STABLE_MS / 1000} Sekunden stabil CONNECTED.`
        );


        return;
      }

    } else {

      stableSince =
        null;
    }


    await sleep(
      1000
    );
  }


  throw new Error(
    'WhatsApp wurde nicht dauerhaft stabil CONNECTED.'
  );
}


/*
============================================================
WHATSAPP-KANAL DIREKT HOLEN
============================================================
*/

async function getJorneChannel(
  client
) {

  assertPageAlive(
    client,
    'Kanalsuche'
  );


  console.log(
    `🔎 Suche WhatsApp-Kanal "${CHANNEL_NAME}"...`
  );


  const channels =
    await client.getChannels();


  console.log(
    `📺 Gefundene WhatsApp-Kanäle: ${channels.length}`
  );


  const wanted =
    CHANNEL_NAME
      .trim()
      .toLowerCase();


  const channel =
    channels.find(
      item => {

        const name =
          String(
            item?.name ||
            ''
          )
            .trim()
            .toLowerCase();


        return (
          name ===
          wanted
        );
      }
    );


  if (!channel) {

    /*
     * Diagnose ohne sensible Daten.
     */

    const names =
      channels
        .map(
          item =>
            item?.name
        )
        .filter(
          Boolean
        );


    console.log(
      '🔎 Verfügbare Kanalnamen:',
      names
    );


    throw new Error(
      `WhatsApp-Kanal "${CHANNEL_NAME}" wurde über getChannels() nicht gefunden.`
    );
  }


  const channelId =
    channel?.id?._serialized;


  if (!channelId) {

    throw new Error(
      `Kanal "${CHANNEL_NAME}" hat keine gültige WhatsApp-ID.`
    );
  }


  console.log(
    `✅ Kanal gefunden: "${channel.name}"`
  );


  console.log(
    '📺 Kanal-ID:',
    channelId
  );


  return channel;
}


/*
============================================================
LIVE-MELDUNG DIREKT SENDEN
============================================================
*/

async function sendLiveMessage(
  client
) {

  const state =
    await client.getState();


  if (
    state !==
    'CONNECTED'
  ) {

    throw new Error(
      `WhatsApp ist nicht CONNECTED, sondern ${state}.`
    );
  }


  assertPageAlive(
    client,
    'Live-Meldung senden'
  );


  console.log(
    '================================'
  );


  console.log(
    '📤 SENDE LIVE-MELDUNG AN WHATSAPP'
  );


  console.log(
    '================================'
  );


  const channel =
    await getJorneChannel(
      client
    );


  /*
   * whatsapp-web.js 1.34.7:
   * Channel.sendMessage() liefert
   * das echte Message-Objekt zurück.
   */

  const message =
    await channel.sendMessage(
      LIVE_MESSAGE
    );


  if (!message) {

    throw new Error(
      'WhatsApp hat nach dem Senden kein Message-Objekt zurückgegeben.'
    );
  }


  const messageId =
    message?.id?._serialized;


  if (!messageId) {

    throw new Error(
      'Die gesendete WhatsApp-Nachricht besitzt keine Message-ID.'
    );
  }


  console.log(
    '✅ Live-Meldung erfolgreich veröffentlicht.'
  );


  console.log(
    '🔐 Echte WhatsApp-Message-ID:',
    messageId
  );


  /*
   * Zusätzliche Kontrolle:
   * Der zurückgegebene Inhalt sollte
   * unsere Live-Meldung enthalten.
   */

  const body =
    String(
      message.body ||
      ''
    );


  if (
    body &&
    !body.includes(
      LIVE_MESSAGE_PHRASE
    )
  ) {

    throw new Error(
      'Gesendetes Message-Objekt enthält nicht den erwarteten Live-Text.'
    );
  }


  return {
    message,
    channel
  };
}


/*
============================================================
EXAKTE BOT-LIVE-MELDUNG FÜR ALLE LÖSCHEN
============================================================
*/

async function deleteBotLiveMessage(
  client,
  savedState
) {

  console.log(
    '================================'
  );


  console.log(
    '🗑️ LÖSCHE EXAKT DIE BOT-LIVE-MELDUNG'
  );


  console.log(
    '================================'
  );


  /*
   * Ohne gespeicherte echte ID
   * wird GAR NICHT gelöscht.
   */

  if (
    !savedState.botMessageId
  ) {

    console.log(
      '🛑 Keine gespeicherte Bot-Message-ID.'
    );


    console.log(
      '🛡️ Keine WhatsApp-Nachricht wird gelöscht.'
    );


    return false;
  }


  if (
    !savedState.botChannelId
  ) {

    console.log(
      '🛑 Keine gespeicherte Kanal-ID.'
    );


    console.log(
      '🛡️ Keine WhatsApp-Nachricht wird gelöscht.'
    );


    return false;
  }


  assertPageAlive(
    client,
    'Bot-Meldung löschen'
  );


  console.log(
    '🔐 Gesuchte Bot-Message-ID:',
    savedState.botMessageId
  );


  /*
   * Zuerst DIREKT über die eindeutige
   * WhatsApp-Message-ID suchen.
   */

  let target =
    null;


  try {

    target =
      await client.getMessageById(
        savedState.botMessageId
      );

  } catch (error) {

    console.log(
      '⚠️ getMessageById() konnte die Nachricht nicht direkt laden:',
      error.message
    );
  }


  /*
   * Fallback:
   * Nur Nachrichten aus EXAKT dem
   * gespeicherten Kanal laden.
   */

  if (!target) {

    console.log(
      '🔎 Direkte Suche ohne Treffer – prüfe gespeicherten Kanal.'
    );


    const channel =
      await client.getChatById(
        savedState.botChannelId
      );


    if (!channel) {

      console.log(
        '⚠️ Gespeicherter Kanal wurde nicht gefunden.'
      );


      return false;
    }


    if (
      !channel.isChannel
    ) {

      console.log(
        '🛑 Gespeicherte ID gehört nicht zu einem WhatsApp-Kanal.'
      );


      return false;
    }


    const messages =
      await channel.fetchMessages({
        limit:
          100,

        fromMe:
          true
      });


    target =
      messages.find(
        item =>
          item?.id?._serialized ===
          savedState.botMessageId
      );
  }


  if (!target) {

    console.log(
      '⚠️ Die gespeicherte Bot-Live-Meldung wurde nicht mehr gefunden.'
    );


    console.log(
      '🛡️ Es wird NICHT ersatzweise eine andere Nachricht gelöscht.'
    );


    return false;
  }


  /*
   * SICHERHEIT 1:
   * Exakte Message-ID muss stimmen.
   */

  const targetId =
    target?.id?._serialized;


  if (
    targetId !==
    savedState.botMessageId
  ) {

    console.log(
      '🛑 Message-ID stimmt nicht exakt überein.'
    );


    console.log(
      '🛡️ Keine Löschung.'
    );


    return false;
  }


  /*
   * SICHERHEIT 2:
   * Nachricht muss von unserem
   * angemeldeten Account stammen.
   */

  if (
    target.fromMe !==
    true
  ) {

    console.log(
      '🛑 Gefundene Nachricht stammt nicht vom verbundenen WhatsApp-Account.'
    );


    console.log(
      '🛡️ Keine Löschung.'
    );


    return false;
  }


  /*
   * SICHERHEIT 3:
   * Text muss exakt unsere
   * Live-Meldungsmerkmale enthalten.
   */

  const body =
    String(
      target.body ||
      ''
    );


  if (
    !body.includes(
      LIVE_MESSAGE_PHRASE
    ) ||
    !body.includes(
      LIVE_URL
    )
  ) {

    console.log(
      '🛑 Message-ID gefunden, aber Inhalt ist nicht die Bot-Live-Meldung.'
    );


    console.log(
      '🛡️ Keine Löschung.'
    );


    return false;
  }


  /*
   * SICHERHEIT 4:
   * Nachricht muss zum gespeicherten
   * Kanal gehören.
   *
   * Bei Newsletter-/Channel-Messages kann
   * die ID unterschiedliche Felder enthalten.
   */

  const remote =
    target?.id?.remote ||
    target?.from ||
    null;


  if (
    remote &&
    String(remote) !==
      String(
        savedState.botChannelId
      )
  ) {

    console.log(
      '🛑 Gefundene Nachricht gehört nicht zum gespeicherten Kanal.'
    );


    console.log(
      '🛡️ Keine Löschung.'
    );


    return false;
  }


  console.log(
    '🎯 Exakte Bot-Live-Meldung eindeutig gefunden.'
  );


  console.log(
    '🔐 Message-ID stimmt.'
  );


  console.log(
    '👤 Nachricht stammt vom verbundenen Account.'
  );


  console.log(
    '📝 Inhalt stimmt mit der Bot-Live-Meldung überein.'
  );


  /*
   * ENTSCHEIDENDER BEFEHL:
   *
   * true = FÜR ALLE löschen.
   */

  await target.delete(
    true
  );


  console.log(
    '🗑️ Löschbefehl "FÜR ALLE" wurde ausgeführt.'
  );


  /*
   * Kurz warten.
   */

  await sleep(
    4000
  );


  /*
   * Danach prüfen, ob die Nachricht
   * noch abrufbar ist.
   */

  let stillExists =
    false;


  try {

    const check =
      await client.getMessageById(
        savedState.botMessageId
      );


    if (
      check &&
      String(
        check.body ||
        ''
      ).includes(
        LIVE_MESSAGE_PHRASE
      )
    ) {

      stillExists =
        true;
    }

  } catch {

    /*
     * Nicht mehr auffindbar =
     * gute Nachricht.
     */

    stillExists =
      false;
  }


  if (stillExists) {

    console.log(
      '⚠️ Die Bot-Meldung scheint nach dem Löschbefehl noch vorhanden zu sein.'
    );


    return false;
  }


  console.log(
    '✅ Bot-Live-Meldung wurde für alle entfernt.'
  );


  console.log(
    '🛡️ Andere Kanalbeiträge wurden nicht angefasst.'
  );


  return true;
}


/*
============================================================
WHATSAPP-CLIENT EINMAL STARTEN
============================================================
*/

async function startWhatsApp(
  store,
  action
) {

  fs.mkdirSync(
    AUTH_DATA_PATH,
    {
      recursive:
        true
    }
  );


  const client =
    new Client({

      authStrategy:
        new RemoteAuth({

          clientId:
            CLIENT_ID,

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

        headless:
          true,

        args: [

          '--no-sandbox',

          '--disable-setuid-sandbox',

          '--disable-dev-shm-usage',

          '--disable-gpu',

          '--no-zygote',

          '--window-size=1365,900'
        ],

        defaultViewport: {

          width:
            1365,

          height:
            900
        }
      }
    });


  let readySeen =
    false;


  const readyPromise =
    new Promise(
      (
        resolve,
        reject
      ) => {

        client.on(
          'authenticated',
          () => {

            console.log(
              '✅ WhatsApp erfolgreich angemeldet.'
            );
          }
        );


        client.on(
          'ready',
          () => {

            console.log(
              '✅ WhatsApp READY-Event erhalten.'
            );


            if (
              !readySeen
            ) {

              readySeen =
                true;


              resolve();
            }
          }
        );


        client.on(
          'change_state',
          state => {

            console.log(
              '🔄 WhatsApp Statusänderung:',
              state
            );
          }
        );


        client.on(
          'code',
          code => {

            console.log(
              '================================'
            );


            console.log(
              '📱 WHATSAPP KOPPLUNGSCODE:'
            );


            console.log(
              code
            );


            console.log(
              '================================'
            );
          }
        );


        client.on(
          'auth_failure',
          message => {

            reject(
              new Error(
                `WhatsApp-Anmeldung fehlgeschlagen: ${message}`
              )
            );
          }
        );


        client.on(
          'disconnected',
          reason => {

            if (
              !readySeen
            ) {

              reject(
                new Error(
                  `WhatsApp wurde vor READY getrennt: ${reason}`
                )
              );

            } else {

              console.log(
                '⚠️ WhatsApp getrennt:',
                reason
              );
            }
          }
        );


        client.on(
          'remote_session_saved',
          () => {

            console.log(
              '💾 REMOTE SESSION SAVED.'
            );
          }
        );
      }
    );


  /*
   * Initialisierung starten.
   */

  const initializePromise =
    client.initialize();


  /*
   * Maximal 90 Sekunden
   * auf READY warten.
   */

  await withTimeout(

    readyPromise,

    WHATSAPP_READY_TIMEOUT_MS,

    'WhatsApp wurde innerhalb von 90 Sekunden nicht READY.'
  );


  /*
   * Danach auf stabile
   * CONNECTED-Verbindung warten.
   */

  await waitForStableWhatsApp(
    client
  );


  assertPageAlive(
    client,
    'nach READY'
  );


  console.log(
    '✅ WhatsApp Web ist bereit.'
  );


  let result;


  try {

    result =
      await action(
        client
      );

  } finally {

    /*
     * Noch kurz Zeit geben,
     * bevor Browser geschlossen wird.
     */

    await sleep(
      2500
    );


    /*
     * Eventuelle späte initialize()-Fehler
     * abfangen.
     */

    initializePromise.catch(
      error => {

        const message =
          String(
            error?.message ||
            error
          );


        if (
          message.includes(
            'Target closed'
          )
        ) {

          console.log(
            '⚠️ Puppeteer meldete beim Beenden "Target closed".'
          );


          return;
        }


        console.log(
          '⚠️ WhatsApp initialize():',
          message
        );
      }
    );


    try {

      await client.destroy();


      console.log(
        '✅ WhatsApp-Client beendet.'
      );

    } catch (error) {

      console.log(
        '⚠️ WhatsApp-Client konnte nicht sauber beendet werden:',
        error.message
      );
    }
  }


  return result;
}


/*
============================================================
STORE ERSTELLEN
============================================================
*/

function createStore() {

  fs.mkdirSync(
    AUTH_DATA_PATH,
    {
      recursive:
        true
    }
  );


  return new FixedMongoStore({

    mongoose,

    dataPath:
      AUTH_DATA_PATH
  });
}


/*
============================================================
OFFENE ALTE BOT-MELDUNG LÖSCHEN
============================================================
*/

async function tryPendingDeletion(
  savedState
) {

  if (
    !savedState.deletePending
  ) {

    return true;
  }


  console.log(
    '🗑️ Es existiert noch eine vorgemerkte Bot-Meldung zur Löschung.'
  );


  if (
    !savedState.botMessageId ||
    !savedState.botChannelId
  ) {

    console.log(
      '🛑 Vorgemerkte Löschung hat keine sichere Message-/Kanal-ID.'
    );


    console.log(
      '🛡️ Keine Nachricht wird gelöscht.'
    );


    return false;
  }


  const store =
    createStore();


  try {

    const deleted =
      await startWhatsApp(
        store,

        async client => {

          return await deleteBotLiveMessage(
            client,
            savedState
          );
        }
      );


    if (
      deleted
    ) {

      await resetOfflineState();


      console.log(
        '✅ Vorgemerkte Bot-Live-Meldung entfernt.'
      );


      return true;
    }


    return false;

  } catch (error) {

    console.error(
      '⚠️ Vorgemerkte Bot-Meldung konnte nicht gelöscht werden:',
      error.message
    );


    await markDeletePending(
      error
    );


    return false;
  }
}


/*
============================================================
MAIN
============================================================
*/

async function main() {

  /*
   * Secrets prüfen.
   */

  if (
    !process.env.MONGODB_URI
  ) {

    throw new Error(
      'MONGODB_URI fehlt.'
    );
  }


  if (
    !process.env.WHATSAPP_PHONE
  ) {

    throw new Error(
      'WHATSAPP_PHONE fehlt.'
    );
  }


  /*
   * MongoDB verbinden.
   */

  console.log(
    'Verbinde mit MongoDB...'
  );


  await mongoose.connect(
    process.env.MONGODB_URI
  );


  console.log(
    '✅ MongoDB verbunden.'
  );


  /*
   * TikTok EINMAL prüfen.
   */

  const currentLive =
    await checkTikTokLive();


  let savedState =
    await getSavedState();


  console.log(
    `🗄️ Gespeicherter Status: ${savedState.live ? 'LIVE' : 'offline'}`
  );


  /*
  ==========================================================
  EVENTUELL NOCH OFFENE ALTE LÖSCHUNG
  ==========================================================
  */

  if (
    savedState.deletePending
  ) {

    const cleanupSuccessful =
      await tryPendingDeletion(
        savedState
      );


    if (
      !cleanupSuccessful
    ) {

      console.log(
        '⚠️ Alte Bot-Meldung konnte noch nicht sicher entfernt werden.'
      );


      /*
       * Wenn er währenddessen wieder LIVE ist,
       * senden wir bewusst keine neue Meldung,
       * solange die alte noch nicht sauber
       * abgearbeitet wurde.
       */

      if (
        currentLive
      ) {

        console.log(
          '🛡️ Kein neuer Live-Beitrag, solange eine alte Bot-Meldung noch zur Löschung vorgemerkt ist.'
        );
      }


      return;
    }


    /*
     * Status nach erfolgreicher
     * Bereinigung neu laden.
     */

    savedState =
      await getSavedState();
  }


  /*
  ==========================================================
  TIKTOK OFFLINE
  ==========================================================
  */

  if (
    !currentLive
  ) {

    /*
     * Bot hatte während des vorherigen Lives
     * tatsächlich eine WhatsApp-Meldung gesendet.
     */

    if (
      savedState.live &&
      savedState.whatsappSent &&
      savedState.botMessageId &&
      savedState.botChannelId
    ) {

      console.log(
        '⚫ Jorne ist jetzt OFFLINE.'
      );


      console.log(
        '🗑️ Exakt die gespeicherte Bot-Live-Meldung wird für alle entfernt.'
      );


      const store =
        createStore();


      try {

        const deleted =
          await startWhatsApp(
            store,

            async client => {

              return await deleteBotLiveMessage(
                client,
                savedState
              );
            }
          );


        if (
          deleted
        ) {

          await resetOfflineState();


          console.log(
            '================================'
          );


          console.log(
            '✅ LIVE BEENDET'
          );


          console.log(
            '✅ Bot-Live-Meldung für alle gelöscht.'
          );


          console.log(
            '✅ System für nächsten Live-Start zurückgesetzt.'
          );


          console.log(
            '================================'
          );


          return;
        }


        /*
         * Sichere Nachricht wurde nicht gelöscht:
         * Daten BEHALTEN und später erneut versuchen.
         */

        await markDeletePending();


        console.log(
          '⚠️ Bot-Meldung konnte nicht sicher gelöscht werden.'
        );


        console.log(
          '➡️ Exakte Message-ID bleibt gespeichert.'
        );


        console.log(
          '➡️ Nächster Offline-Run darf dieselbe Nachricht erneut versuchen.'
        );


        return;

      } catch (error) {

        await markDeletePending(
          error
        );


        console.error(
          '❌ Fehler beim Löschen der Bot-Live-Meldung:',
          error
        );


        return;
      }
    }


    /*
     * Live war gespeichert, aber es gibt
     * keine Bot-Nachricht.
     *
     * Beispiel: WhatsApp-Senden war
     * beim Live-Start fehlgeschlagen.
     */

    if (
      savedState.live
    ) {

      await resetOfflineState();


      console.log(
        '⚫ Jorne ist wieder offline.'
      );


      console.log(
        '✅ Keine gespeicherte Bot-Live-Meldung vorhanden.'
      );


      console.log(
        '✅ Status für nächsten Live-Start zurückgesetzt.'
      );


      return;
    }


    console.log(
      '⚫ Jorne ist weiterhin offline.'
    );


    console.log(
      '✅ Keine WhatsApp-Aktion erforderlich.'
    );


    return;
  }


  /*
  ==========================================================
  TIKTOK IST LIVE UND WAR VORHER SCHON LIVE
  ==========================================================
  */

  if (
    currentLive &&
    savedState.live
  ) {

    console.log(
      '🔴 Jorne ist weiterhin LIVE.'
    );


    if (
      savedState.whatsappSent &&
      savedState.botMessageId
    ) {

      console.log(
        '✅ Bot-Live-Meldung wurde bereits gesendet.'
      );


      console.log(
        '🔐 Message-ID ist gespeichert.'
      );

    } else {

      console.log(
        '⚠️ Dieser Live-Start wurde bereits verarbeitet.'
      );
    }


    console.log(
      '✅ Keine zweite WhatsApp-Nachricht.'
    );


    return;
  }


  /*
  ==========================================================
  OFFLINE → LIVE
  ==========================================================
  */

  console.log(
    '🔴 NEUER TIKTOK-LIVE-START ERKANNT!'
  );


  const claimed =
    await claimNewLiveStart();


  if (
    !claimed
  ) {

    console.log(
      '✅ Ein anderer Workflow hat diesen Live-Start bereits übernommen.'
    );


    console.log(
      '✅ Keine doppelte WhatsApp-Nachricht.'
    );


    return;
  }


  console.log(
    '🔒 Live-Start für diesen Workflow reserviert.'
  );


  const store =
    createStore();


  try {

    const result =
      await startWhatsApp(
        store,

        async client => {

          return await sendLiveMessage(
            client
          );
        }
      );


    /*
     * Echte WhatsApp-Message-ID
     * und Kanal-ID dauerhaft speichern.
     */

    await setWhatsAppSuccess(
      result.message,
      result.channel
    );


    console.log(
      '================================'
    );


    console.log(
      '🎉 LIVE-ALARM ERFOLGREICH'
    );


    console.log(
      '✅ Live-Meldung im WhatsApp-Kanal veröffentlicht.'
    );


    console.log(
      '🔐 Exakte Bot-Message-ID gespeichert.'
    );


    console.log(
      '➡️ Beim Offline-Wechsel darf NUR diese Nachricht für alle gelöscht werden.'
    );


    console.log(
      '================================'
    );

  } catch (error) {

    /*
     * Live-Status bleibt TRUE.
     *
     * Dadurch startet nicht jede Minute
     * wieder WhatsApp.
     */

    await setWhatsAppFailure(
      error
    );


    console.error(
      '================================'
    );


    console.error(
      '❌ WHATSAPP-LIVE-MELDUNG FEHLGESCHLAGEN'
    );


    console.error(
      String(
        error?.stack ||
        error
      )
    );


    console.error(
      '⚠️ Live-Status bleibt auf LIVE.'
    );


    console.error(
      '✅ Kein minutenweiser WhatsApp-Sende-Loop.'
    );


    console.error(
      '================================'
    );


    throw error;
  }
}


/*
============================================================
START + SAUBERES ENDE
============================================================
*/

main()
  .then(
    async () => {

      try {

        await mongoose.disconnect();

      } catch {}


      console.log(
        '✅ Live-Check abgeschlossen.'
      );


      process.exit(
        0
      );
    }
  )
  .catch(
    async error => {

      console.error(
        '❌ Live-Check fehlgeschlagen:',
        error
      );


      try {

        await mongoose.disconnect();

      } catch {}


      process.exit(
        1
      );
    }
  );
