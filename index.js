const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const TIKTOK_USERNAME = 'feliiiocean';
const CHANNEL_NAME = 'Jorne_L1ve';

const LIVE_MESSAGE =
  `🔴 Jorne ist jetzt LIVE auf TikTok!\n\n` +
  `👉 Direkt zum Live:\n` +
  `https://www.tiktok.com/@${TIKTOK_USERNAME}/live`;

const LIVE_MESSAGE_PHRASE = 'Jorne ist jetzt LIVE auf TikTok!';

const CLIENT_ID = 'jorne-whatsapp-live';
const AUTH_DATA_PATH = path.resolve('./.wwebjs_auth');

const TIKTOK_TIMEOUT_MS = 20000;
const WHATSAPP_READY_TIMEOUT_MS = 90000;
const WHATSAPP_STABLE_MS = 10000;
const CHANNEL_LOOKUP_TIMEOUT_MS = 25000;
const MESSAGE_DELETE_TIMEOUT_MS = 30000;
const CHANNEL_FETCH_LIMIT = 100;

/* =========================================================
   MONGODB: STATUS
   ========================================================= */

const TikTokStateSchema = new mongoose.Schema(
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
    whatsappSent: {
      type: Boolean,
      default: false
    },
    whatsappError: {
      type: String,
      default: null
    },
    botMessageSentAt: {
      type: Date,
      default: null
    },
    botMessageId: {
      type: String,
      default: null
    },
    channelId: {
      type: String,
      default: null
    },
    deletePending: {
      type: Boolean,
      default: false
    },
    changedAt: {
      type: Date,
      default: Date.now
    }
  },
  { versionKey: false }
);

const TikTokState =
  mongoose.models.TikTokState ||
  mongoose.model('TikTokState', TikTokStateSchema);

async function getSavedState() {
  const state = await TikTokState.findOne({
    username: TIKTOK_USERNAME
  }).lean();

  return state || {
    username: TIKTOK_USERNAME,
    live: false,
    whatsappSent: false,
    whatsappError: null,
    botMessageSentAt: null,
    botMessageId: null,
    channelId: null,
    deletePending: false
  };
}

async function reserveLiveStart() {
  const result = await TikTokState.findOneAndUpdate(
    {
      username: TIKTOK_USERNAME,
      live: false,
      deletePending: { $ne: true }
    },
    {
      $set: {
        live: true,
        whatsappSent: false,
        whatsappError: null,
        botMessageSentAt: null,
        botMessageId: null,
        changedAt: new Date()
      }
    },
    { new: true }
  );

  if (result) return true;

  const existing = await TikTokState.findOne({
    username: TIKTOK_USERNAME
  }).lean();

  if (existing) return false;

  try {
    await TikTokState.create({
      username: TIKTOK_USERNAME,
      live: true,
      whatsappSent: false,
      whatsappError: null,
      botMessageSentAt: null,
      botMessageId: null,
      channelId: null,
      deletePending: false,
      changedAt: new Date()
    });
    return true;
  } catch (error) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

async function markSendSuccess({ sentAt, messageId, channelId }) {
  await TikTokState.updateOne(
    { username: TIKTOK_USERNAME },
    {
      $set: {
        live: true,
        whatsappSent: true,
        whatsappError: null,
        botMessageSentAt: sentAt,
        botMessageId: messageId || null,
        channelId: channelId || null,
        deletePending: false,
        changedAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function markSendFailure(error) {
  await TikTokState.updateOne(
    { username: TIKTOK_USERNAME },
    {
      $set: {
        live: true,
        whatsappSent: false,
        whatsappError: String(error?.message || error),
        changedAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function markDeletePending(error = null) {
  await TikTokState.updateOne(
    { username: TIKTOK_USERNAME },
    {
      $set: {
        live: false,
        deletePending: true,
        whatsappError: error ? String(error?.message || error) : null,
        changedAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function resetOfflineState() {
  await TikTokState.updateOne(
    { username: TIKTOK_USERNAME },
    {
      $set: {
        live: false,
        whatsappSent: false,
        whatsappError: null,
        botMessageSentAt: null,
        botMessageId: null,
        deletePending: false,
        changedAt: new Date()
      }
    },
    { upsert: true }
  );
}

async function rememberChannelId(channelId) {
  if (!channelId) return;

  await TikTokState.updateOne(
    { username: TIKTOK_USERNAME },
    {
      $set: {
        channelId,
        changedAt: new Date()
      }
    },
    { upsert: true }
  );
}

/* =========================================================
   REMOTEAUTH + MONGODB FIX
   ========================================================= */

class FixedMongoStore extends MongoStore {
  constructor({ mongoose, dataPath }) {
    super({ mongoose });
    this.fixedMongoose = mongoose;
    this.dataPath = dataPath;
  }

  async save(options) {
    const session = options.session;
    const zipPath = path.join(this.dataPath, `${session}.zip`);

    console.log('💾 MongoStore: Speichere Sitzung aus:', zipPath);

    if (!fs.existsSync(zipPath)) {
      throw new Error(`RemoteAuth-ZIP wurde nicht gefunden: ${zipPath}`);
    }

    const bucket = new this.fixedMongoose.mongo.GridFSBucket(
      this.fixedMongoose.connection.db,
      { bucketName: `whatsapp-${session}` }
    );

    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(zipPath);
      const uploadStream = bucket.openUploadStream(`${session}.zip`);

      readStream.on('error', reject);
      uploadStream.on('error', reject);
      uploadStream.on('finish', resolve);
      readStream.pipe(uploadStream);
    });

    const documents = await bucket
      .find({ filename: `${session}.zip` })
      .sort({ uploadDate: -1 })
      .toArray();

    if (documents.length > 1) {
      for (const document of documents.slice(1)) {
        try {
          await bucket.delete(document._id);
        } catch (error) {
          console.log(
            '⚠️ Alte Sicherung konnte nicht gelöscht werden:',
            error.message
          );
        }
      }
    }

    console.log('✅ WhatsApp-Sitzung erfolgreich in MongoDB gespeichert.');
  }
}

/* =========================================================
   HILFSFUNKTIONEN
   ========================================================= */

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, milliseconds, message) {
  let timeout;

  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(message);
      error.name = 'TimeoutError';
      reject(error);
    }, milliseconds);
  });

  return Promise.race([promise, timeoutPromise])
    .finally(() => clearTimeout(timeout));
}

function normalize(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getSerializedId(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value._serialized === 'string') return value._serialized;
  return null;
}

function messageMatchesLivePost(message) {
  const body = String(message?.body || '');
  return body.includes(LIVE_MESSAGE_PHRASE);
}

/* =========================================================
   TIKTOK
   ========================================================= */

async function checkTikTokLive() {
  const module = await import('tiktok-live-connector');
  const TikTokLiveConnection = module.TikTokLiveConnection;

  if (!TikTokLiveConnection) {
    throw new Error('TikTokLiveConnection konnte nicht geladen werden.');
  }

  const connection = new TikTokLiveConnection(TIKTOK_USERNAME, {});

  try {
    console.log(`🔎 Prüfe TikTok-Status von @${TIKTOK_USERNAME} ...`);

    const live = await withTimeout(
      connection.fetchIsLive(),
      TIKTOK_TIMEOUT_MS,
      `TikTok antwortet nach ${TIKTOK_TIMEOUT_MS / 1000} Sekunden nicht.`
    );

    console.log(`📡 TikTok-Status: ${live ? 'LIVE 🔴' : 'offline ⚫'}`);
    return Boolean(live);
  } finally {
    try {
      await connection.disconnect();
    } catch {}
  }
}

/* =========================================================
   WHATSAPP: STABILITÄT
   ========================================================= */

async function waitForStableWhatsApp(client) {
  console.log('⏳ Warte, bis WhatsApp Web stabil ist...');

  const started = Date.now();
  let stableSince = null;

  while (Date.now() - started < WHATSAPP_READY_TIMEOUT_MS) {
    let state = null;

    try {
      state = await client.getState();
    } catch {}

    const page = client.pupPage;
    const pageAlive =
      page &&
      (typeof page.isClosed !== 'function' || !page.isClosed());

    if (state === 'CONNECTED' && pageAlive) {
      if (!stableSince) {
        stableSince = Date.now();
        console.log('🟢 WhatsApp CONNECTED – Stabilitätsprüfung läuft...');
      }

      if (Date.now() - stableSince >= WHATSAPP_STABLE_MS) {
        console.log(
          `✅ WhatsApp seit ${WHATSAPP_STABLE_MS / 1000} Sekunden stabil CONNECTED.`
        );
        return;
      }
    } else {
      stableSince = null;
    }

    await sleep(1000);
  }

  throw new Error('WhatsApp wurde nicht dauerhaft stabil CONNECTED.');
}

/* =========================================================
   WHATSAPP: KANAL DIREKT FINDEN
   ========================================================= */

async function getTargetChannel(client, savedChannelId = null) {
  if (savedChannelId) {
    try {
      const direct = await withTimeout(
        client.getChatById(savedChannelId),
        CHANNEL_LOOKUP_TIMEOUT_MS,
        'Gespeicherter WhatsApp-Kanal konnte nicht rechtzeitig geladen werden.'
      );

      if (direct?.isChannel) {
        console.log(
          `✅ Kanal über gespeicherte ID geladen: ${getSerializedId(direct.id)}`
        );
        return direct;
      }
    } catch (error) {
      console.log(
        '⚠️ Gespeicherte Kanal-ID konnte nicht direkt verwendet werden:',
        error.message
      );
    }
  }

  console.log(`🔎 Suche WhatsApp-Kanal "${CHANNEL_NAME}" über Channel-API...`);

  const channels = await withTimeout(
    client.getChannels(),
    CHANNEL_LOOKUP_TIMEOUT_MS,
    'client.getChannels() hat zu lange benötigt.'
  );

  const wanted = normalize(CHANNEL_NAME);
  const channel = (channels || []).find(item => normalize(item?.name) === wanted);

  if (!channel) {
    const available = (channels || [])
      .map(item => item?.name)
      .filter(Boolean)
      .slice(0, 20);

    throw new Error(
      `Kanal "${CHANNEL_NAME}" wurde über client.getChannels() nicht gefunden. ` +
      `Gefundene Kanäle: ${available.length ? available.join(', ') : 'keine'}`
    );
  }

  const channelId = getSerializedId(channel.id);
  console.log(`✅ Kanal gefunden: ${channel.name} (${channelId})`);

  await rememberChannelId(channelId);
  return channel;
}

/* =========================================================
   WHATSAPP: LIVE-MELDUNG DIREKT SENDEN
   ========================================================= */

async function sendLiveMessage(client, savedChannelId = null) {
  const state = await client.getState();

  if (state !== 'CONNECTED') {
    throw new Error(`WhatsApp ist nicht CONNECTED, sondern ${state}.`);
  }

  console.log('================================');
  console.log('📤 SENDE LIVE-MELDUNG DIREKT ÜBER CHANNEL-API');
  console.log('================================');

  const channel = await getTargetChannel(client, savedChannelId);
  const channelId = getSerializedId(channel.id);

  const message = await withTimeout(
    channel.sendMessage(LIVE_MESSAGE),
    30000,
    'Live-Meldung konnte nicht rechtzeitig an den Kanal gesendet werden.'
  );

  if (!message) {
    throw new Error('channel.sendMessage() hat keine Message zurückgegeben.');
  }

  const messageId = getSerializedId(message.id);

  if (!messageId) {
    throw new Error(
      'Live-Meldung wurde gesendet, aber ihre WhatsApp-Message-ID konnte nicht gelesen werden.'
    );
  }

  console.log('✅ Live-Meldung direkt über Channel-API gesendet.');
  console.log('🆔 Message-ID:', messageId);
  console.log('📺 Channel-ID:', channelId);

  return {
    sentAt: new Date(),
    messageId,
    channelId
  };
}

/* =========================================================
   WHATSAPP: MESSAGE DIREKT LÖSCHEN
   ========================================================= */

async function tryDeleteMessageObject(message, label) {
  if (!message) return false;

  const messageId = getSerializedId(message.id);
  const body = String(message.body || '');

  console.log(`🗑️ Direkter Löschversuch (${label})`);
  console.log('🆔 Message-ID:', messageId || 'unbekannt');
  console.log('📝 Texttreffer:', body.includes(LIVE_MESSAGE_PHRASE));

  try {
    await withTimeout(
      message.delete(true),
      MESSAGE_DELETE_TIMEOUT_MS,
      `message.delete(true) Timeout für ${messageId || label}`
    );

    console.log('✅ message.delete(true) wurde ausgeführt.');
    return true;
  } catch (error) {
    console.log(
      `⚠️ Direkte Löschung fehlgeschlagen (${messageId || label}):`,
      error?.message || error
    );
    return false;
  }
}

async function findMatchingChannelMessages(channel) {
  const messages = await withTimeout(
    channel.fetchMessages({
      limit: CHANNEL_FETCH_LIMIT,
      fromMe: true
    }),
    30000,
    'channel.fetchMessages() hat zu lange benötigt.'
  );

  return (messages || []).filter(messageMatchesLivePost);
}

async function deleteBotLiveMessages(client, savedState) {
  const state = await client.getState();

  if (state !== 'CONNECTED') {
    throw new Error(`WhatsApp ist nicht CONNECTED, sondern ${state}.`);
  }

  console.log('================================');
  console.log('🗑️ DIREKTE LÖSCHUNG DER BOT-LIVE-MELDUNG');
  console.log('================================');

  const channel = await getTargetChannel(client, savedState.channelId || null);
  const channelId = getSerializedId(channel.id);
  await rememberChannelId(channelId);

  let attempted = 0;
  let directByIdSucceeded = false;

  /*
   * 1) Bevorzugt exakt die beim Senden gespeicherte Message-ID.
   */
  if (savedState.botMessageId) {
    console.log('🎯 Gespeicherte Bot-Message-ID vorhanden.');

    try {
      const exactMessage = await withTimeout(
        client.getMessageById(savedState.botMessageId),
        20000,
        'getMessageById() hat zu lange benötigt.'
      );

      if (exactMessage) {
        attempted++;
        directByIdSucceeded = await tryDeleteMessageObject(
          exactMessage,
          'gespeicherte Message-ID'
        );
      } else {
        console.log('⚠️ Gespeicherte Message-ID wurde nicht mehr gefunden.');
      }
    } catch (error) {
      console.log(
        '⚠️ Nachricht konnte über gespeicherte ID nicht geladen werden:',
        error?.message || error
      );
    }
  } else {
    console.log(
      'ℹ️ Für ältere Bot-Beiträge ist noch keine gespeicherte Message-ID vorhanden.'
    );
  }

  /*
   * 2) Zusätzlich/Fallback: Eigene Kanalnachrichten direkt über Channel.fetchMessages().
   *    Damit können auch alte Meldungen aus der bisherigen DOM-Version gefunden werden.
   */
  let matchingBefore = [];

  try {
    matchingBefore = await findMatchingChannelMessages(channel);
  } catch (error) {
    console.log(
      '⚠️ Kanalnachrichten konnten nicht über fetchMessages() gelesen werden:',
      error?.message || error
    );

    if (directByIdSucceeded) {
      return {
        success: true,
        deleted: 1,
        remaining: 0,
        verification: 'nicht möglich, ID-Löschung wurde aber ausgeführt'
      };
    }

    throw error;
  }

  console.log(
    `🔎 Passende eigene Live-Meldungen vor Löschung: ${matchingBefore.length}`
  );

  let deleted = directByIdSucceeded ? 1 : 0;

  for (const message of matchingBefore) {
    const id = getSerializedId(message.id);

    if (
      savedState.botMessageId &&
      id === savedState.botMessageId &&
      directByIdSucceeded
    ) {
      continue;
    }

    attempted++;

    const success = await tryDeleteMessageObject(
      message,
      'Channel.fetchMessages()'
    );

    if (success) {
      deleted++;
      await sleep(1200);
    }
  }

  await sleep(3500);

  let matchingAfter;

  try {
    matchingAfter = await findMatchingChannelMessages(channel);
  } catch (error) {
    console.log(
      '⚠️ Nachkontrolle über fetchMessages() nicht möglich:',
      error?.message || error
    );

    return {
      success: deleted > 0,
      deleted,
      remaining: null,
      attempted,
      verification: 'fetchMessages-Nachkontrolle fehlgeschlagen'
    };
  }

  console.log(
    `🔎 Passende eigene Live-Meldungen nach Löschung: ${matchingAfter.length}`
  );

  if (matchingAfter.length > 0) {
    console.log(
      '⚠️ Die Meldung(en) sind nach message.delete(true) weiterhin über den Kanal abrufbar.'
    );

    return {
      success: false,
      deleted,
      remaining: matchingAfter.length,
      attempted
    };
  }

  console.log('✅ Keine passende Bot-Live-Meldung mehr im Kanal gefunden.');

  return {
    success: true,
    deleted,
    remaining: 0,
    attempted
  };
}

/* =========================================================
   WHATSAPP STARTEN
   ========================================================= */

async function startWhatsApp(store, action) {
  fs.mkdirSync(AUTH_DATA_PATH, { recursive: true });

  const client = new Client({
    authStrategy: new RemoteAuth({
      clientId: CLIENT_ID,
      store,
      dataPath: AUTH_DATA_PATH,
      backupSyncIntervalMs: 60000,
      rmMaxRetries: 10
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
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--window-size=1365,900'
      ],
      defaultViewport: {
        width: 1365,
        height: 900
      }
    }
  });

  let readySeen = false;

  const readyPromise = new Promise((resolve, reject) => {
    client.on('authenticated', () => {
      console.log('✅ WhatsApp erfolgreich angemeldet.');
    });

    client.on('ready', () => {
      console.log('✅ WhatsApp READY-Event erhalten.');

      if (!readySeen) {
        readySeen = true;
        resolve();
      }
    });

    client.on('change_state', state => {
      console.log('🔄 WhatsApp Statusänderung:', state);
    });

    client.on('code', () => {
      console.log('📱 WhatsApp benötigt einen neuen Kopplungscode.');
      console.log(
        '🛡️ Der Code wird nicht im öffentlichen Actions-Log ausgegeben.'
      );
    });

    client.on('auth_failure', message => {
      reject(
        new Error(`WhatsApp-Anmeldung fehlgeschlagen: ${message}`)
      );
    });

    client.on('disconnected', reason => {
      if (!readySeen) {
        reject(
          new Error(`WhatsApp wurde vor READY getrennt: ${reason}`)
        );
      } else {
        console.log('⚠️ WhatsApp getrennt:', reason);
      }
    });

    client.on('remote_session_saved', () => {
      console.log('💾 REMOTE SESSION SAVED.');
    });
  });

  const initializePromise = client.initialize();

  await withTimeout(
    readyPromise,
    WHATSAPP_READY_TIMEOUT_MS,
    'WhatsApp wurde innerhalb von 90 Sekunden nicht READY.'
  );

  await waitForStableWhatsApp(client);

  console.log('✅ WhatsApp Web ist bereit.');

  let result;

  try {
    result = await action(client);
  } finally {
    await sleep(2500);

    initializePromise.catch(error => {
      const message = String(error?.message || error);

      if (message.includes('Target closed')) {
        console.log('⚠️ Puppeteer meldete beim Beenden "Target closed".');
        return;
      }

      console.log('⚠️ WhatsApp initialize():', message);
    });

    try {
      await client.destroy();
      console.log('✅ WhatsApp-Client beendet.');
    } catch (error) {
      console.log(
        '⚠️ WhatsApp-Client konnte nicht sauber beendet werden:',
        error.message
      );
    }
  }

  return result;
}

function createStore() {
  fs.mkdirSync(AUTH_DATA_PATH, { recursive: true });

  return new FixedMongoStore({
    mongoose,
    dataPath: AUTH_DATA_PATH
  });
}

/* =========================================================
   OFFLINE-BEHANDLUNG
   ========================================================= */

async function handleOffline(savedState) {
  const oldLive = Boolean(savedState.live);
  const shouldDelete = Boolean(
    savedState.whatsappSent ||
    savedState.deletePending ||
    savedState.botMessageId
  );

  if (!oldLive && !shouldDelete) {
    console.log('⚫ Jorne ist weiterhin offline.');
    console.log('✅ Keine WhatsApp-Aktion erforderlich.');
    return;
  }

  console.log('⚫ Jorne ist offline.');

  if (!shouldDelete) {
    await resetOfflineState();
    console.log('✅ Offline-Status zurückgesetzt.');
    console.log('➡️ Beim nächsten Live-Start darf wieder gesendet werden.');
    return;
  }

  await markDeletePending();

  console.log('🗑️ Direkte Löschung der Bot-Live-Meldung wird versucht.');

  const store = createStore();

  try {
    const result = await startWhatsApp(
      store,
      async client => deleteBotLiveMessages(client, savedState)
    );

    console.log('📊 Lösch-Ergebnis:', result);

    if (result?.success) {
      await resetOfflineState();

      console.log('================================');
      console.log('✅ OFFLINE-WECHSEL ERFOLGREICH');
      console.log(`🗑️ Löschaufrufe erfolgreich: ${result.deleted}`);
      console.log('✅ System für nächsten Live-Start zurückgesetzt.');
      console.log('================================');
      return;
    }

    await markDeletePending(
      new Error(
        `Direkte Löschung nicht bestätigt. Verbleibend: ${result?.remaining ?? 'unbekannt'}`
      )
    );

    console.log('⚠️ Direkte Löschung konnte nicht bestätigt werden.');
    console.log('➡️ deletePending bleibt aktiv.');
    console.log('➡️ Nächster Offline-Lauf versucht es erneut.');
  } catch (error) {
    await markDeletePending(error);

    console.error('❌ Fehler bei der direkten Löschung:');
    console.error(String(error?.stack || error));
    console.error('➡️ deletePending bleibt aktiv.');
  }
}

/* =========================================================
   LIVE-BEHANDLUNG
   ========================================================= */

async function handleLive(savedState) {
  const oldLive = Boolean(savedState.live);

  if (savedState.deletePending) {
    console.log(
      '⚠️ TikTok ist LIVE, aber eine alte Live-Meldung wartet noch auf Löschung.'
    );
    console.log('🛑 In diesem Lauf wird keine neue Meldung gesendet.');
    return;
  }

  if (oldLive) {
    console.log('🔴 Jorne ist weiterhin LIVE.');
    console.log('✅ Dieser Live-Start wurde bereits verarbeitet.');
    console.log('✅ Keine zweite WhatsApp-Nachricht.');
    return;
  }

  console.log('🔴 NEUER TIKTOK-LIVE-START ERKANNT!');

  const claimed = await reserveLiveStart();

  if (!claimed) {
    console.log(
      '✅ Ein anderer GitHub-Lauf hat diesen Live-Start bereits übernommen.'
    );
    console.log('✅ Keine doppelte Nachricht.');
    return;
  }

  console.log('🔒 Live-Start für diesen Workflow reserviert.');

  const store = createStore();

  try {
    const sent = await startWhatsApp(
      store,
      async client => sendLiveMessage(client, savedState.channelId || null)
    );

    await markSendSuccess(sent);

    console.log('================================');
    console.log('🎉 LIVE-ALARM ERFOLGREICH');
    console.log('✅ Live-Meldung direkt über Channel-API veröffentlicht.');
    console.log('🆔 Message-ID wurde in MongoDB gespeichert.');
    console.log('🗑️ Beim Offline-Wechsel wird exakt diese Message direkt gelöscht.');
    console.log('================================');
  } catch (error) {
    await markSendFailure(error);

    console.error('================================');
    console.error('❌ WHATSAPP-LIVE-MELDUNG FEHLGESCHLAGEN');
    console.error(String(error?.stack || error));
    console.error('⚠️ Live-Status bleibt absichtlich auf LIVE.');
    console.error('✅ Dadurch gibt es keinen minutenweisen Sende-Loop.');
    console.error('================================');

    throw error;
  }
}

/* =========================================================
   MAIN
   ========================================================= */

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI fehlt.');
  }

  if (!process.env.WHATSAPP_PHONE) {
    throw new Error('WHATSAPP_PHONE fehlt.');
  }

  console.log('================================');
  console.log('🚀 JORNE WHATSAPP LIVE-BOT STARTET');
  console.log('🔧 Modus: Channel-API + Message-ID + delete(true)');
  console.log('================================');

  console.log('Verbinde mit MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB verbunden.');

  const currentLive = await checkTikTokLive();
  const savedState = await getSavedState();

  console.log('🗄️ Gespeicherter Zustand:');
  console.log(
    JSON.stringify(
      {
        live: Boolean(savedState.live),
        whatsappSent: Boolean(savedState.whatsappSent),
        deletePending: Boolean(savedState.deletePending),
        botMessageSentAt: savedState.botMessageSentAt || null,
        botMessageId: savedState.botMessageId || null,
        channelId: savedState.channelId || null,
        whatsappError: savedState.whatsappError || null
      },
      null,
      2
    )
  );

  if (!currentLive) {
    await handleOffline(savedState);
    return;
  }

  await handleLive(savedState);
}

/* =========================================================
   START + SAUBERES ENDE
   ========================================================= */

main()
  .then(async () => {
    try {
      await mongoose.disconnect();
    } catch {}

    console.log('================================');
    console.log('✅ Live-Check abgeschlossen.');
    console.log('================================');
    process.exit(0);
  })
  .catch(async error => {
    console.error('================================');
    console.error('❌ Live-Check fehlgeschlagen:');
    console.error(error);
    console.error('================================');

    try {
      await mongoose.disconnect();
    } catch {}

    process.exit(1);
  });
