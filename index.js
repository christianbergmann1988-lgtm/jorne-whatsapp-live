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

async function markSendSuccess({
  sentAt,
  messageId,
  channelId
}) {
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
        /*
         * WICHTIG:
         * Wenn das Senden fehlschlägt, wird der Live-Start
         * NICHT dauerhaft als erledigt markiert.
         *
         * Beim nächsten Workflow-Lauf darf erneut versucht werden.
         */
        live: false,
        whatsappSent: false,
        whatsappError: String(error?.message || error),
        botMessageSentAt: null,
        botMessageId: null,
        deletePending: false,
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
        whatsappError:
          error
            ? String(error?.message || error)
            : null,
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
  constructor({
    mongoose,
    dataPath
  }) {
    super({ mongoose });

    this.fixedMongoose = mongoose;
    this.dataPath = dataPath;
  }

  async save(options) {
    const session = options.session;

    const zipPath =
      path.join(
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
          fs.createReadStream(zipPath);

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
          uploadDate: -1
        })
        .toArray();

    if (documents.length > 1) {
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

/* =========================================================
   HILFSFUNKTIONEN
   ========================================================= */

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
                new Error(message);

              error.name =
                'TimeoutError';

              reject(error);
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
      () =>
        clearTimeout(timeout)
    );
}

function normalize(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getSerializedId(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (
    typeof value._serialized ===
    'string'
  ) {
    return value._serialized;
  }

  return null;
}

function messageMatchesLivePost(
  message
) {
  const body =
    String(
      message?.body ||
      ''
    );

  return body.includes(
    LIVE_MESSAGE_PHRASE
  );
}

function assertPageAlive(
  page,
  step
) {
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

/* =========================================================
   TIKTOK PRÜFEN
   ========================================================= */

async function checkTikTokLive() {
  const module =
    await import(
      'tiktok-live-connector'
    );

  const TikTokLiveConnection =
    module.TikTokLiveConnection;

  if (!TikTokLiveConnection) {
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
      state === 'CONNECTED' &&
      pageAlive
    ) {
      if (!stableSince) {
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

    await sleep(1000);
  }

  throw new Error(
    'WhatsApp wurde nicht dauerhaft stabil CONNECTED.'
  );
}

/* =========================================================
   WHATSAPP POPUP SCHLIESSEN
   ========================================================= */

async function closeWhatsAppPopup(
  page
) {
  assertPageAlive(
    page,
    'Popup-Prüfung'
  );

  const result =
    await page.evaluate(
      () => {
        function isVisible(
          element
        ) {
          if (!element) {
            return false;
          }

          const rect =
            element
              .getBoundingClientRect();

          const style =
            window.getComputedStyle(
              element
            );

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !==
              'none' &&
            style.visibility !==
              'hidden'
          );
        }

        function textOf(
          element
        ) {
          return (
            element?.textContent ||
            ''
          )
            .replace(
              /\s+/g,
              ' '
            )
            .trim()
            .toLowerCase();
        }

        let popup =
          document.querySelector(
            '[data-testid="confirm-popup"]'
          );

        if (
          !popup ||
          !isVisible(popup)
        ) {
          popup =
            document.querySelector(
              '[data-testid="popup-contents"]'
            );
        }

        if (
          !popup ||
          !isVisible(popup)
        ) {
          popup =
            [
              ...document.querySelectorAll(
                '[role="dialog"]'
              )
            ].find(
              isVisible
            );
        }

        if (!popup) {
          return {
            found: false,
            closed: false
          };
        }

        const candidates =
          [
            ...popup.querySelectorAll(
              'button,[role="button"],[tabindex],[aria-label]'
            )
          ].filter(
            isVisible
          );

        let closeButton =
          candidates.find(
            element => {
              const aria =
                (
                  element.getAttribute(
                    'aria-label'
                  ) ||
                  ''
                )
                  .trim()
                  .toLowerCase();

              const text =
                textOf(element);

              const html =
                (
                  element.innerHTML ||
                  ''
                )
                  .toLowerCase();

              return (
                aria.includes(
                  'schließen'
                ) ||
                aria ===
                  'close' ||
                text ===
                  'schließen' ||
                text ===
                  'close' ||
                html.includes(
                  'ic-close'
                )
              );
            }
          );

        if (!closeButton) {
          closeButton =
            candidates.find(
              element => {
                const text =
                  textOf(element);

                return [
                  'ok',
                  'okay',
                  'verstanden',
                  'fertig',
                  'weiter',
                  'nicht jetzt'
                ].includes(text);
              }
            );
        }

        if (!closeButton) {
          return {
            found: true,
            closed: false
          };
        }

        closeButton.click();

        return {
          found: true,
          closed: true
        };
      }
    );

  if (
    result.found &&
    result.closed
  ) {
    await sleep(2000);
    return;
  }

  if (
    result.found &&
    !result.closed
  ) {
    try {
      await page.keyboard.press(
        'Escape'
      );

      await sleep(1500);
    } catch {}
  }
}

/* =========================================================
   RECHTE KANALANSICHT PRÜFEN
   ========================================================= */

async function inspectRightChannelArea(
  page
) {
  assertPageAlive(
    page,
    'Kanalansicht prüfen'
  );

  return await page.evaluate(
    channelName => {
      function isVisible(
        element
      ) {
        if (!element) {
          return false;
        }

        const rect =
          element
            .getBoundingClientRect();

        const style =
          window.getComputedStyle(
            element
          );

        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !==
            'none' &&
          style.visibility !==
            'hidden'
        );
      }

      const channelNameLower =
        channelName
          .toLowerCase();

      const pageText =
        (
          document.body?.innerText ||
          ''
        )
          .replace(
            /\s+/g,
            ' '
          )
          .trim();

      const emptyState =
        pageText.includes(
          'Kanäle entdecken'
        ) ||
        pageText.includes(
          'Folge den Kanälen, die dich interessieren'
        );

      const rightElements =
        [
          ...document.querySelectorAll(
            '[data-testid],[aria-label],[role],header,main,section,div'
          )
        ]
          .filter(
            isVisible
          )
          .filter(
            element => {
              const rect =
                element
                  .getBoundingClientRect();

              return (
                rect.left >
                window.innerWidth *
                  0.32
              );
            }
          );

      const channelNameVisibleRight =
        rightElements.some(
          element => {
            const text =
              (
                element.textContent ||
                ''
              )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim()
                .toLowerCase();

            const aria =
              (
                element.getAttribute(
                  'aria-label'
                ) ||
                ''
              )
                .toLowerCase();

            return (
              text.includes(
                channelNameLower
              ) ||
              aria.includes(
                channelNameLower
              )
            );
          }
        );

      return {
        emptyState,
        channelNameVisibleRight
      };
    },
    CHANNEL_NAME
  );
}

/* =========================================================
   WHATSAPP-KANAL ÜBER WEB ÖFFNEN
   ========================================================= */

async function openWhatsAppChannel(
  page
) {
  assertPageAlive(
    page,
    'Kanäle öffnen'
  );

  console.log(
    '🔎 Suche Bereich "Kanäle"...'
  );

  const channelsFound =
    await page.evaluate(
      () => {
        function normalizeText(
          value
        ) {
          return String(
            value ||
            ''
          )
            .replace(
              /\s+/g,
              ' '
            )
            .trim()
            .toLowerCase();
        }

        function isVisible(
          element
        ) {
          if (!element) {
            return false;
          }

          const rect =
            element
              .getBoundingClientRect();

          return (
            rect.width > 0 &&
            rect.height > 0
          );
        }

        document
          .querySelectorAll(
            '[data-bot-channels-button]'
          )
          .forEach(
            element =>
              element.removeAttribute(
                'data-bot-channels-button'
              )
          );

        const elements =
          [
            ...document.querySelectorAll(
              'button,[role="button"],[role="tab"],[tabindex],[aria-label],[data-testid]'
            )
          ].filter(
            isVisible
          );

        let target =
          document.querySelector(
            '[data-testid="newsletter-tab-drawer"]'
          );

        if (
          target &&
          !isVisible(target)
        ) {
          target = null;
        }

        if (!target) {
          target =
            elements.find(
              element =>
                normalizeText(
                  element.getAttribute(
                    'aria-label'
                  )
                ) ===
                'kanäle'
            );
        }

        if (!target) {
          target =
            elements.find(
              element =>
                normalizeText(
                  element.getAttribute(
                    'data-testid'
                  )
                ).includes(
                  'newsletter-tab-drawer'
                )
            );
        }

        if (!target) {
          target =
            elements.find(
              element =>
                normalizeText(
                  element.textContent
                ) ===
                'kanäle'
            );
        }

        if (!target) {
          return false;
        }

        const clickable =
          target.closest(
            'button,[role="button"],[role="tab"],[tabindex]'
          ) ||
          target;

        clickable.setAttribute(
          'data-bot-channels-button',
          'true'
        );

        return true;
      }
    );

  if (!channelsFound) {
    throw new Error(
      'Bereich "Kanäle" wurde nicht gefunden.'
    );
  }

  const channelsButton =
    await page.$(
      '[data-bot-channels-button="true"]'
    );

  if (!channelsButton) {
    throw new Error(
      'Markierter Kanäle-Button wurde nicht gefunden.'
    );
  }

  await channelsButton.evaluate(
    element => {
      element.scrollIntoView({
        block: 'center',
        inline: 'center'
      });
    }
  );

  await sleep(500);

  await channelsButton.click({
    delay: 120
  });

  console.log(
    '✅ Bereich "Kanäle" geöffnet.'
  );

  await sleep(4500);

  await closeWhatsAppPopup(
    page
  );

  await sleep(2500);

  console.log(
    `🔎 Suche Kanal "${CHANNEL_NAME}"...`
  );

  const channelFound =
    await page.evaluate(
      channelName => {
        function normalizeText(
          value
        ) {
          return String(
            value ||
            ''
          )
            .replace(
              /\s+/g,
              ' '
            )
            .trim()
            .toLowerCase();
        }

        function isVisible(
          element
        ) {
          if (!element) {
            return false;
          }

          const rect =
            element
              .getBoundingClientRect();

          return (
            rect.width > 0 &&
            rect.height > 0
          );
        }

        document
          .querySelectorAll(
            '[data-bot-channel-target]'
          )
          .forEach(
            element =>
              element.removeAttribute(
                'data-bot-channel-target'
              )
          );

        const wanted =
          normalizeText(
            channelName
          );

        const cells =
          [
            ...document.querySelectorAll(
              '[data-testid="newsletter-tab-newsletter-cell"]'
            )
          ].filter(
            isVisible
          );

        const target =
          cells.find(
            element => {
              const text =
                normalizeText(
                  element.textContent
                );

              const aria =
                normalizeText(
                  element.getAttribute(
                    'aria-label'
                  )
                );

              return (
                text.includes(
                  wanted
                ) ||
                aria.includes(
                  wanted
                )
              );
            }
          );

        if (!target) {
          return false;
        }

        const rect =
          target
            .getBoundingClientRect();

        if (
          rect.width > 700 ||
          rect.height > 300 ||
          rect.left >
            window.innerWidth *
              0.55
        ) {
          return false;
        }

        target.setAttribute(
          'data-bot-channel-target',
          'true'
        );

        return true;
      },
      CHANNEL_NAME
    );

  if (!channelFound) {
    throw new Error(
      `Kanal "${CHANNEL_NAME}" wurde nicht gefunden.`
    );
  }

  const channelHandle =
    await page.$(
      '[data-bot-channel-target="true"]'
    );

  if (!channelHandle) {
    throw new Error(
      'Markierte Kanal-Zelle wurde nicht wiedergefunden.'
    );
  }

  await channelHandle.evaluate(
    element => {
      element.scrollIntoView({
        block: 'center',
        inline: 'center'
      });
    }
  );

  await sleep(700);

  const box =
    await channelHandle.boundingBox();

  if (!box) {
    throw new Error(
      `Keine Klickposition für ${CHANNEL_NAME} verfügbar.`
    );
  }

  await page.mouse.click(
    box.x +
      box.width / 2,
    box.y +
      box.height / 2,
    {
      delay: 150
    }
  );

  console.log(
    `✅ "${CHANNEL_NAME}" angeklickt.`
  );

  await sleep(5000);

  await closeWhatsAppPopup(
    page
  );

  await sleep(1500);

  let check =
    await inspectRightChannelArea(
      page
    );

  if (
    check.emptyState &&
    !check.channelNameVisibleRight
  ) {
    console.log(
      '🔁 Kanalansicht noch nicht offen – zweiter Klick.'
    );

    const secondHandle =
      await page.$(
        '[data-bot-channel-target="true"]'
      );

    if (secondHandle) {
      const secondBox =
        await secondHandle.boundingBox();

      if (secondBox) {
        await page.mouse.click(
          secondBox.x +
            secondBox.width / 2,
          secondBox.y +
            secondBox.height / 2,
          {
            delay: 180
          }
        );

        await sleep(5000);
      }
    }

    check =
      await inspectRightChannelArea(
        page
      );
  }

  console.log(
    '📺 Kanalansicht:',
    check
  );

  if (
    check.emptyState &&
    !check.channelNameVisibleRight
  ) {
    throw new Error(
      `Kanal "${CHANNEL_NAME}" wurde rechts nicht geöffnet.`
    );
  }

  console.log(
    `✅ Kanal "${CHANNEL_NAME}" ist tatsächlich geöffnet.`
  );

  await sleep(2500);
}

/* =========================================================
   COMPOSER FINDEN
   ========================================================= */

async function markComposer(
  page
) {
  assertPageAlive(
    page,
    'Composer suchen'
  );

  const found =
    await page.evaluate(
      () => {
        function isVisible(
          element
        ) {
          if (!element) {
            return false;
          }

          const rect =
            element
              .getBoundingClientRect();

          const style =
            window.getComputedStyle(
              element
            );

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !==
              'none' &&
            style.visibility !==
              'hidden'
          );
        }

        document
          .querySelectorAll(
            '[data-bot-composer]'
          )
          .forEach(
            element =>
              element.removeAttribute(
                'data-bot-composer'
              )
          );

        let target =
          document.querySelector(
            '[data-testid="conversation-compose-box-input"]'
          );

        if (
          target &&
          !isVisible(target)
        ) {
          target = null;
        }

        if (!target) {
          const candidates =
            [
              ...document.querySelectorAll(
                '[contenteditable="true"],[role="textbox"],[data-lexical-editor="true"],textarea'
              )
            ].filter(
              isVisible
            );

          target =
            candidates.find(
              element => {
                const rect =
                  element
                    .getBoundingClientRect();

                const aria =
                  (
                    element.getAttribute(
                      'aria-label'
                    ) ||
                    ''
                  )
                    .toLowerCase();

                const placeholder =
                  (
                    element.getAttribute(
                      'placeholder'
                    ) ||
                    element.getAttribute(
                      'data-placeholder'
                    ) ||
                    ''
                  )
                    .toLowerCase();

                return (
                  !aria.includes(
                    'suchen'
                  ) &&
                  !placeholder.includes(
                    'suchen'
                  ) &&
                  rect.left > 500 &&
                  rect.width > 100
                );
              }
            );
        }

        if (!target) {
          return false;
        }

        target.setAttribute(
          'data-bot-composer',
          'true'
        );

        return true;
      }
    );

  if (!found) {
    throw new Error(
      'Meldungsfeld wurde nicht gefunden.'
    );
  }

  console.log(
    '✅ WhatsApp-Meldungsfeld gefunden.'
  );
}

/* =========================================================
   MEHRZEILIGE MELDUNG
   ========================================================= */

async function typeMultilineMessage(
  page,
  message
) {
  assertPageAlive(
    page,
    'Text eingeben'
  );

  const lines =
    message.split('\n');

  for (
    let index = 0;
    index < lines.length;
    index++
  ) {
    const line =
      lines[index];

    if (line) {
      await page.keyboard.type(
        line,
        {
          delay: 25
        }
      );
    }

    if (
      index <
      lines.length - 1
    ) {
      await page.keyboard.down(
        'Shift'
      );

      await page.keyboard.press(
        'Enter'
      );

      await page.keyboard.up(
        'Shift'
      );
    }
  }
}

/* =========================================================
   DOM-SENDEN
   BEWÄHRTER FALLBACK
   ========================================================= */

async function sendLiveMessageViaDom(
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

  const page =
    client.pupPage;

  assertPageAlive(
    page,
    'DOM-Sendevorgang'
  );

  console.log(
    '================================'
  );

  console.log(
    '📤 SENDE LIVE-MELDUNG ÜBER BEWÄHRTEN WEB-WEG'
  );

  console.log(
    '================================'
  );

  await openWhatsAppChannel(
    page
  );

  await markComposer(
    page
  );

  const composer =
    await page.$(
      '[data-bot-composer="true"]'
    );

  if (!composer) {
    throw new Error(
      'Meldungsfeld wurde nicht wiedergefunden.'
    );
  }

  await composer.evaluate(
    element => {
      element.scrollIntoView({
        block: 'center',
        inline: 'center'
      });
    }
  );

  await sleep(500);

  await composer.click({
    delay: 100
  });

  await sleep(500);

  await typeMultilineMessage(
    page,
    LIVE_MESSAGE
  );

  console.log(
    '⌨️ Live-Meldung vollständig eingegeben.'
  );

  await sleep(1500);

  await page.keyboard.press(
    'Enter'
  );

  console.log(
    '📤 ENTER gedrückt – Live-Meldung abgesendet.'
  );

  await sleep(6000);

  console.log(
    '✅ Live-Meldung über WhatsApp-Web-Sendeweg veröffentlicht.'
  );

  return {
    sentAt: new Date(),
    messageId: null,
    channelId: null,
    sendMode: 'dom'
  };
}

/* =========================================================
   CHANNEL DIREKT FINDEN
   ========================================================= */

async function getTargetChannel(
  client,
  savedChannelId = null
) {
  if (savedChannelId) {
    try {
      const direct =
        await withTimeout(
          client.getChatById(
            savedChannelId
          ),
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

  if (
    typeof client.getChannels !==
    'function'
  ) {
    throw new Error(
      'Diese whatsapp-web.js-Version stellt client.getChannels() nicht bereit.'
    );
  }

  console.log(
    `🔎 Suche WhatsApp-Kanal "${CHANNEL_NAME}" über Channel-API...`
  );

  const channels =
    await withTimeout(
      client.getChannels(),
      CHANNEL_LOOKUP_TIMEOUT_MS,
      'client.getChannels() hat zu lange benötigt.'
    );

  const wanted =
    normalize(
      CHANNEL_NAME
    );

  const channel =
    (channels || [])
      .find(
        item =>
          normalize(
            item?.name
          ) ===
          wanted
      );

  if (!channel) {
    const available =
      (channels || [])
        .map(
          item =>
            item?.name
        )
        .filter(Boolean)
        .slice(0, 20);

    throw new Error(
      `Kanal "${CHANNEL_NAME}" wurde über client.getChannels() nicht gefunden. ` +
      `Gefundene Kanäle: ${
        available.length
          ? available.join(', ')
          : 'keine'
      }`
    );
  }

  const channelId =
    getSerializedId(
      channel.id
    );

  console.log(
    `✅ Kanal gefunden: ${channel.name} (${channelId})`
  );

  await rememberChannelId(
    channelId
  );

  return channel;
}

/* =========================================================
   CHANNEL-API SENDEN
   ========================================================= */

async function sendLiveMessageViaChannelApi(
  client,
  savedChannelId = null
) {
  const channel =
    await getTargetChannel(
      client,
      savedChannelId
    );

  if (
    typeof channel.sendMessage !==
    'function'
  ) {
    throw new Error(
      'Der gefundene Kanal unterstützt channel.sendMessage() in dieser Library-Version nicht.'
    );
  }

  const channelId =
    getSerializedId(
      channel.id
    );

  console.log(
    '📤 Versuche Live-Meldung direkt über Channel-API...'
  );

  const message =
    await withTimeout(
      channel.sendMessage(
        LIVE_MESSAGE
      ),
      30000,
      'Live-Meldung konnte nicht rechtzeitig über Channel-API gesendet werden.'
    );

  if (!message) {
    throw new Error(
      'channel.sendMessage() hat keine Message zurückgegeben.'
    );
  }

  const messageId =
    getSerializedId(
      message.id
    );

  if (!messageId) {
    throw new Error(
      'Live-Meldung wurde gesendet, aber ihre WhatsApp-Message-ID konnte nicht gelesen werden.'
    );
  }

  console.log(
    '✅ Live-Meldung direkt über Channel-API gesendet.'
  );

  console.log(
    '🆔 Message-ID:',
    messageId
  );

  console.log(
    '📺 Channel-ID:',
    channelId
  );

  return {
    sentAt: new Date(),
    messageId,
    channelId,
    sendMode: 'channel-api'
  };
}

/* =========================================================
   HYBRID-SENDEN

   1. Channel-API versuchen.
   2. Wenn diese bei der installierten Version/Kanalart scheitert,
      automatisch auf den alten funktionierenden DOM-Weg wechseln.
   ========================================================= */

async function sendLiveMessage(
  client,
  savedChannelId = null
) {
  try {
    const result =
      await sendLiveMessageViaChannelApi(
        client,
        savedChannelId
      );

    console.log(
      '✅ Versandmodus: Channel-API.'
    );

    return result;
  } catch (error) {
    console.log(
      '⚠️ Channel-API-Versand nicht möglich:'
    );

    console.log(
      String(
        error?.message ||
        error
      )
    );

    console.log(
      '🔁 Wechsel automatisch auf den bewährten WhatsApp-Web-Sendeweg.'
    );
  }

  const result =
    await sendLiveMessageViaDom(
      client
    );

  console.log(
    '✅ Versandmodus: WhatsApp-Web-Fallback.'
  );

  return result;
}

/* =========================================================
   DIREKTE MESSAGE LÖSCHEN
   ========================================================= */

async function tryDeleteMessageObject(
  message,
  label
) {
  if (!message) {
    return false;
  }

  const messageId =
    getSerializedId(
      message.id
    );

  const body =
    String(
      message.body ||
      ''
    );

  console.log(
    `🗑️ Direkter Löschversuch (${label})`
  );

  console.log(
    '🆔 Message-ID:',
    messageId ||
      'unbekannt'
  );

  console.log(
    '📝 Texttreffer:',
    body.includes(
      LIVE_MESSAGE_PHRASE
    )
  );

  if (
    typeof message.delete !==
    'function'
  ) {
    console.log(
      '⚠️ Dieses Message-Objekt besitzt keine delete()-Funktion.'
    );

    return false;
  }

  try {
    await withTimeout(
      message.delete(true),
      MESSAGE_DELETE_TIMEOUT_MS,
      `message.delete(true) Timeout für ${messageId || label}`
    );

    console.log(
      '✅ message.delete(true) wurde ausgeführt.'
    );

    return true;
  } catch (error) {
    console.log(
      `⚠️ Direkte Löschung fehlgeschlagen (${messageId || label}):`,
      error?.message ||
      error
    );

    return false;
  }
}

/* =========================================================
   KANALNACHRICHTEN ABRUFEN
   ========================================================= */

async function findMatchingChannelMessages(
  channel
) {
  if (
    typeof channel.fetchMessages !==
    'function'
  ) {
    throw new Error(
      'Dieser Kanal unterstützt fetchMessages() in der installierten Library-Version nicht.'
    );
  }

  const messages =
    await withTimeout(
      channel.fetchMessages({
        limit:
          CHANNEL_FETCH_LIMIT,
        fromMe: true
      }),
      30000,
      'channel.fetchMessages() hat zu lange benötigt.'
    );

  return (
    messages ||
    []
  ).filter(
    messageMatchesLivePost
  );
}

/* =========================================================
   BOT-LIVE-MELDUNG IM DOM FINDEN
   ========================================================= */

async function findDomLiveMessageCandidates(
  page
) {
  assertPageAlive(
    page,
    'Live-Meldung im DOM suchen'
  );

  const candidates =
    await page.evaluate(
      phrase => {
        function normalizeText(
          value
        ) {
          return String(
            value ||
            ''
          )
            .replace(
              /\s+/g,
              ' '
            )
            .trim();
        }

        function isVisible(
          element
        ) {
          if (!element) {
            return false;
          }

          const rect =
            element
              .getBoundingClientRect();

          const style =
            window.getComputedStyle(
              element
            );

          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !==
              'none' &&
            style.visibility !==
              'hidden'
          );
        }

        function containsPhrase(
          element
        ) {
          const text =
            normalizeText(
              element?.textContent
            );

          return text.includes(
            phrase
          );
        }

        function plausible(
          element
        ) {
          if (
            !element ||
            !isVisible(element) ||
            !containsPhrase(element)
          ) {
            return false;
          }

          const rect =
            element
              .getBoundingClientRect();

          if (
            rect.left <
            window.innerWidth *
              0.30
          ) {
            return false;
          }

          if (
            rect.width < 150 ||
            rect.height < 35
          ) {
            return false;
          }

          if (
            rect.width >
            window.innerWidth *
              0.85
          ) {
            return false;
          }

          if (
            rect.height >
            window.innerHeight *
              0.65
          ) {
            return false;
          }

          return true;
        }

        document
          .querySelectorAll(
            '[data-bot-live-candidate]'
          )
          .forEach(
            element =>
              element.removeAttribute(
                'data-bot-live-candidate'
              )
          );

        const selected =
          [];

        const dataIdMatches =
          [
            ...document.querySelectorAll(
              '[data-id]'
            )
          ].filter(
            plausible
          );

        for (
          const element
          of dataIdMatches
        ) {
          const duplicate =
            selected.some(
              existing =>
                existing ===
                  element ||
                existing.contains(
                  element
                ) ||
                element.contains(
                  existing
                )
            );

          if (!duplicate) {
            selected.push(
              element
            );
          }
        }

        if (
          selected.length === 0
        ) {
          const semanticMatches =
            [
              ...document.querySelectorAll(
                '[data-testid*="msg"],[data-testid*="message"],[role="row"],[role="listitem"]'
              )
            ].filter(
              plausible
            );

          for (
            const element
            of semanticMatches
          ) {
            const duplicate =
              selected.some(
                existing =>
                  existing ===
                    element ||
                  existing.contains(
                    element
                  ) ||
                  element.contains(
                    existing
                  )
              );

            if (!duplicate) {
              selected.push(
                element
              );
            }
          }
        }

        if (
          selected.length === 0
        ) {
          const rawMatches =
            [
              ...document.querySelectorAll(
                '*'
              )
            ]
              .filter(
                isVisible
              )
              .filter(
                containsPhrase
              )
              .sort(
                (
                  a,
                  b
                ) => {
                  const ar =
                    a.getBoundingClientRect();

                  const br =
                    b.getBoundingClientRect();

                  return (
                    ar.width *
                      ar.height -
                    br.width *
                      br.height
                  );
                }
              );

          for (
            const raw
            of rawMatches
          ) {
            let current =
              raw;

            let best =
              null;

            for (
              let depth = 0;
              depth < 12 &&
              current;
              depth++
            ) {
              if (
                plausible(current)
              ) {
                best =
                  current;

                const dataId =
                  current.getAttribute(
                    'data-id'
                  );

                const role =
                  current.getAttribute(
                    'role'
                  );

                const testId =
                  (
                    current.getAttribute(
                      'data-testid'
                    ) ||
                    ''
                  )
                    .toLowerCase();

                if (
                  dataId ||
                  role ===
                    'row' ||
                  role ===
                    'listitem' ||
                  testId.includes(
                    'msg'
                  ) ||
                  testId.includes(
                    'message'
                  )
                ) {
                  break;
                }
              }

              current =
                current.parentElement;
            }

            if (!best) {
              continue;
            }

            const duplicate =
              selected.some(
                existing =>
                  existing ===
                    best ||
                  existing.contains(
                    best
                  ) ||
                  best.contains(
                    existing
                  )
              );

            if (!duplicate) {
              selected.push(
                best
              );
            }
          }
        }

        const deduped =
          [];

        for (
          const element
          of selected
        ) {
          const rect =
            element
              .getBoundingClientRect();

          const duplicate =
            deduped.some(
              existing => {
                const other =
                  existing
                    .getBoundingClientRect();

                return (
                  Math.abs(
                    rect.x -
                    other.x
                  ) < 8 &&
                  Math.abs(
                    rect.y -
                    other.y
                  ) < 8 &&
                  Math.abs(
                    rect.width -
                    other.width
                  ) < 12 &&
                  Math.abs(
                    rect.height -
                    other.height
                  ) < 12
                );
              }
            );

          if (!duplicate) {
            deduped.push(
              element
            );
          }
        }

        const limited =
          deduped
            .sort(
              (
                a,
                b
              ) =>
                a
                  .getBoundingClientRect()
                  .y -
                b
                  .getBoundingClientRect()
                  .y
            )
            .slice(
              0,
              10
            );

        limited.forEach(
          (
            element,
            index
          ) => {
            element.setAttribute(
              'data-bot-live-candidate',
              String(index)
            );
          }
        );

        return limited.map(
          (
            element,
            index
          ) => {
            const rect =
              element
                .getBoundingClientRect();

            return {
              index,
              dataId:
                element.getAttribute(
                  'data-id'
                ) ||
                null,
              x:
                Math.round(
                  rect.x
                ),
              y:
                Math.round(
                  rect.y
                ),
              width:
                Math.round(
                  rect.width
                ),
              height:
                Math.round(
                  rect.height
                )
            };
          }
        );
      },
      LIVE_MESSAGE_PHRASE
    );

  console.log(
    `🔎 Sichtbare Bot-Live-Meldungen im DOM: ${candidates.length}`
  );

  return candidates;
}

/* =========================================================
   DIREKTE LÖSCHUNG ÜBER ID + CHANNEL API

   Das ist der bevorzugte Weg.
   ========================================================= */

async function deleteBotLiveMessages(
  client,
  savedState
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

  console.log(
    '================================'
  );

  console.log(
    '🗑️ DIREKTE LÖSCHUNG DER BOT-LIVE-MELDUNG'
  );

  console.log(
    '================================'
  );

  let deleted = 0;
  let attempted = 0;
  let exactDeleteSucceeded =
    false;

  /*
   * ERSTER UND WICHTIGSTER WEG:
   * gespeicherte Message-ID.
   */

  if (
    savedState.botMessageId
  ) {
    console.log(
      '🎯 Gespeicherte Bot-Message-ID vorhanden.'
    );

    console.log(
      '🆔',
      savedState.botMessageId
    );

    if (
      typeof client.getMessageById ===
      'function'
    ) {
      try {
        const exactMessage =
          await withTimeout(
            client.getMessageById(
              savedState.botMessageId
            ),
            20000,
            'getMessageById() hat zu lange benötigt.'
          );

        if (exactMessage) {
          attempted++;

          exactDeleteSucceeded =
            await tryDeleteMessageObject(
              exactMessage,
              'gespeicherte Message-ID'
            );

          if (
            exactDeleteSucceeded
          ) {
            deleted++;
          }
        } else {
          console.log(
            '⚠️ Gespeicherte Message-ID wurde nicht mehr gefunden.'
          );
        }
      } catch (error) {
        console.log(
          '⚠️ Nachricht konnte über gespeicherte ID nicht geladen werden:',
          error?.message ||
          error
        );
      }
    } else {
      console.log(
        '⚠️ client.getMessageById() ist in dieser Library-Version nicht vorhanden.'
      );
    }
  } else {
    console.log(
      'ℹ️ Keine gespeicherte Message-ID vorhanden.'
    );

    console.log(
      '➡️ Das kann bei einer Meldung passieren, die über den DOM-Fallback gesendet wurde.'
    );
  }

  /*
   * CHANNEL-API FALLBACK:
   * eigene Live-Beiträge suchen.
   */

  let channel =
    null;

  try {
    channel =
      await getTargetChannel(
        client,
        savedState.channelId ||
          null
      );
  } catch (error) {
    console.log(
      '⚠️ Channel-API konnte den Kanal nicht laden:',
      error?.message ||
      error
    );
  }

  if (channel) {
    try {
      const matchingBefore =
        await findMatchingChannelMessages(
          channel
        );

      console.log(
        `🔎 Passende eigene Live-Meldungen über Channel-API: ${matchingBefore.length}`
      );

      for (
        const message
        of matchingBefore
      ) {
        const id =
          getSerializedId(
            message.id
          );

        if (
          exactDeleteSucceeded &&
          savedState.botMessageId &&
          id ===
            savedState.botMessageId
        ) {
          continue;
        }

        attempted++;

        const success =
          await tryDeleteMessageObject(
            message,
            'Channel.fetchMessages()'
          );

        if (success) {
          deleted++;

          await sleep(1200);
        }
      }

      await sleep(3000);

      const remaining =
        await findMatchingChannelMessages(
          channel
        );

      console.log(
        `🔎 Passende eigene Live-Meldungen nach direkter Löschung: ${remaining.length}`
      );

      if (
        remaining.length === 0 &&
        (
          deleted > 0 ||
          exactDeleteSucceeded
        )
      ) {
        console.log(
          '✅ Direkte Löschung wurde über Channel-API bestätigt.'
        );

        return {
          success: true,
          deleted,
          remaining: 0,
          attempted
        };
      }

      if (
        remaining.length > 0
      ) {
        console.log(
          '⚠️ Live-Meldung ist nach delete(true) weiterhin vorhanden.'
        );
      }
    } catch (error) {
      console.log(
        '⚠️ Channel-Nachrichten konnten nicht vollständig geprüft werden:',
        error?.message ||
        error
      );
    }
  }

  /*
   * LETZTE NACHKONTROLLE:
   * Im sichtbaren WhatsApp-Kanal prüfen,
   * ob die Meldung noch vorhanden ist.
   *
   * Wir löschen hier NICHT blind über DOM.
   * Dieser Teil dient nur der Kontrolle.
   */

  try {
    const page =
      client.pupPage;

    assertPageAlive(
      page,
      'DOM-Nachkontrolle'
    );

    await openWhatsAppChannel(
      page
    );

    const candidates =
      await findDomLiveMessageCandidates(
        page
      );

    if (
      candidates.length === 0
    ) {
      console.log(
        '✅ Live-Meldung ist auch in der sichtbaren Kanalansicht nicht mehr vorhanden.'
      );

      return {
        success: true,
        deleted,
        remaining: 0,
        attempted,
        verification:
          'DOM'
      };
    }

    console.log(
      `⚠️ Die Live-Meldung ist weiterhin sichtbar. Treffer: ${candidates.length}`
    );

    return {
      success: false,
      deleted,
      remaining:
        candidates.length,
      attempted
    };
  } catch (error) {
    console.log(
      '⚠️ Sichtbare Nachkontrolle konnte nicht durchgeführt werden:',
      error?.message ||
      error
    );
  }

  /*
   * Wenn wir einen bestätigten direkten Löschaufruf hatten,
   * aber keine Nachkontrolle möglich war, bleiben wir vorsichtig.
   */

  return {
    success: false,
    deleted,
    remaining:
      'nicht verifizierbar',
    attempted
  };
}

/* =========================================================
   WHATSAPP STARTEN
   ========================================================= */

async function startWhatsApp(
  store,
  action
) {
  fs.mkdirSync(
    AUTH_DATA_PATH,
    {
      recursive: true
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

            if (!readySeen) {
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
          () => {
            console.log(
              '📱 WhatsApp benötigt einen neuen Kopplungscode.'
            );

            console.log(
              '🛡️ Der Code wird aus Sicherheitsgründen nicht im öffentlichen Actions-Log ausgegeben.'
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
            if (!readySeen) {
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

  const initializePromise =
    client.initialize();

  await withTimeout(
    readyPromise,
    WHATSAPP_READY_TIMEOUT_MS,
    'WhatsApp wurde innerhalb von 90 Sekunden nicht READY.'
  );

  await waitForStableWhatsApp(
    client
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
    await sleep(2500);

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

/* =========================================================
   STORE ERSTELLEN
   ========================================================= */

function createStore() {
  fs.mkdirSync(
    AUTH_DATA_PATH,
    {
      recursive: true
    }
  );

  return new FixedMongoStore({
    mongoose,
    dataPath:
      AUTH_DATA_PATH
  });
}

/* =========================================================
   OFFLINE-BEHANDLUNG
   ========================================================= */

async function handleOffline(
  savedState
) {
  const oldLive =
    Boolean(
      savedState.live
    );

  const shouldDelete =
    Boolean(
      savedState.whatsappSent ||
      savedState.deletePending ||
      savedState.botMessageId
    );

  if (
    !oldLive &&
    !shouldDelete
  ) {
    console.log(
      '⚫ Jorne ist weiterhin offline.'
    );

    console.log(
      '✅ Keine WhatsApp-Aktion erforderlich.'
    );

    return;
  }

  console.log(
    '⚫ Jorne ist offline.'
  );

  if (!shouldDelete) {
    await resetOfflineState();

    console.log(
      '✅ Offline-Status zurückgesetzt.'
    );

    console.log(
      '➡️ Beim nächsten Live-Start darf wieder gesendet werden.'
    );

    return;
  }

  await markDeletePending();

  console.log(
    '🗑️ Direkte Löschung der Bot-Live-Meldung wird versucht.'
  );

  const store =
    createStore();

  try {
    const result =
      await startWhatsApp(
        store,
        async client =>
          deleteBotLiveMessages(
            client,
            savedState
          )
      );

    console.log(
      '📊 Lösch-Ergebnis:',
      result
    );

    if (
      result?.success
    ) {
      await resetOfflineState();

      console.log(
        '================================'
      );

      console.log(
        '✅ OFFLINE-WECHSEL ERFOLGREICH'
      );

      console.log(
        `🗑️ Löschaufrufe erfolgreich: ${result.deleted}`
      );

      console.log(
        '✅ System für nächsten Live-Start zurückgesetzt.'
      );

      console.log(
        '================================'
      );

      return;
    }

    await markDeletePending(
      new Error(
        `Direkte Löschung nicht bestätigt. Verbleibend: ${result?.remaining ?? 'unbekannt'}`
      )
    );

    console.log(
      '⚠️ Direkte Löschung konnte nicht bestätigt werden.'
    );

    console.log(
      '➡️ deletePending bleibt aktiv.'
    );

    console.log(
      '➡️ Nächster Offline-Lauf versucht es erneut.'
    );
  } catch (error) {
    await markDeletePending(
      error
    );

    console.error(
      '❌ Fehler bei der direkten Löschung:'
    );

    console.error(
      String(
        error?.stack ||
        error
      )
    );

    console.error(
      '➡️ deletePending bleibt aktiv.'
    );
  }
}

/* =========================================================
   LIVE-BEHANDLUNG
   ========================================================= */

async function handleLive(
  savedState
) {
  const oldLive =
    Boolean(
      savedState.live
    );

  /*
   * Wenn eine alte Nachricht noch nicht gelöscht werden konnte,
   * verhindern wir nicht dauerhaft einen neuen Live-Start.
   *
   * Wenn TikTok wieder live ist, wird der alte Löschstatus
   * zurückgesetzt und der neue Live-Start darf verarbeitet werden.
   */

  if (
    savedState.deletePending
  ) {
    console.log(
      '⚠️ Alte Live-Meldung konnte zuvor nicht sicher gelöscht werden.'
    );

    console.log(
      '➡️ TikTok ist jetzt wieder LIVE – alter Löschstatus wird für den neuen Live-Start freigegeben.'
    );

    await resetOfflineState();

    savedState =
      await getSavedState();
  }

  /*
   * Nur wenn wirklich erfolgreich gesendet wurde,
   * darf ein weiterer Lauf während desselben Lives stoppen.
   */

  if (
    oldLive &&
    savedState.whatsappSent
  ) {
    console.log(
      '🔴 Jorne ist weiterhin LIVE.'
    );

    console.log(
      '✅ Live-Meldung wurde bereits erfolgreich gesendet.'
    );

    console.log(
      '✅ Keine zweite WhatsApp-Nachricht.'
    );

    return;
  }

  /*
   * Falls ein vorheriger Sendeversuch fehlgeschlagen ist,
   * versuchen wir erneut.
   */

  if (
    oldLive &&
    !savedState.whatsappSent
  ) {
    console.log(
      '🔁 Jorne ist LIVE, aber der vorherige WhatsApp-Versand war nicht erfolgreich.'
    );

    console.log(
      '➡️ Dieser Lauf versucht den Versand erneut.'
    );
  } else {
    console.log(
      '🔴 NEUER TIKTOK-LIVE-START ERKANNT!'
    );

    const claimed =
      await reserveLiveStart();

    if (!claimed) {
      const latestState =
        await getSavedState();

      /*
       * Wenn die Reservierung nur deshalb fehlschlug,
       * weil ein vorheriger fehlerhafter Lauf live=true hinterlassen hat,
       * aber keine Nachricht erfolgreich gesendet wurde,
       * darf erneut versucht werden.
       */

      if (
        latestState.live &&
        !latestState.whatsappSent &&
        !latestState.deletePending
      ) {
        console.log(
          '🔁 Live-Start ist reserviert, aber noch keine WhatsApp-Meldung wurde erfolgreich gesendet.'
        );

        console.log(
          '➡️ Versand wird erneut versucht.'
        );
      } else {
        console.log(
          '✅ Ein anderer GitHub-Lauf hat diesen Live-Start bereits übernommen.'
        );

        console.log(
          '✅ Keine doppelte Nachricht.'
        );

        return;
      }
    } else {
      console.log(
        '🔒 Live-Start für diesen Workflow reserviert.'
      );
    }
  }

  const store =
    createStore();

  try {
    const sent =
      await startWhatsApp(
        store,
        async client =>
          sendLiveMessage(
            client,
            savedState.channelId ||
              null
          )
      );

    await markSendSuccess(
      sent
    );

    console.log(
      '================================'
    );

    console.log(
      '🎉 LIVE-ALARM ERFOLGREICH'
    );

    console.log(
      '✅ Live-Meldung erfolgreich im WhatsApp-Kanal veröffentlicht.'
    );

    console.log(
      `📤 Versandmodus: ${sent.sendMode || 'unbekannt'}`
    );

    if (
      sent.messageId
    ) {
      console.log(
        '🆔 Message-ID wurde in MongoDB gespeichert.'
      );

      console.log(
        `🆔 ${sent.messageId}`
      );
    } else {
      console.log(
        'ℹ️ DOM-Fallback wurde verwendet – dabei konnte keine Message-ID direkt gespeichert werden.'
      );

      console.log(
        '➡️ Beim Offline-Wechsel versucht der Bot zusätzlich die Channel-API zur Wiedererkennung.'
      );
    }

    console.log(
      '================================'
    );
  } catch (error) {
    await markSendFailure(
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
      '🔁 Der Live-Start wurde wieder freigegeben.'
    );

    console.error(
      '➡️ Der nächste Workflow-Lauf darf das Senden erneut versuchen.'
    );

    console.error(
      '================================'
    );

    throw error;
  }
}

/* =========================================================
   MAIN
   ========================================================= */

async function main() {
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

  console.log(
    '================================'
  );

  console.log(
    '🚀 JORNE WHATSAPP LIVE-BOT STARTET'
  );

  console.log(
    '🔧 Modus: Hybrid-Senden + Message-ID + delete(true)'
  );

  console.log(
    '================================'
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

  const currentLive =
    await checkTikTokLive();

  const savedState =
    await getSavedState();

  console.log(
    '🗄️ Gespeicherter Zustand:'
  );

  console.log(
    JSON.stringify(
      {
        live:
          Boolean(
            savedState.live
          ),

        whatsappSent:
          Boolean(
            savedState.whatsappSent
          ),

        deletePending:
          Boolean(
            savedState.deletePending
          ),

        botMessageSentAt:
          savedState.botMessageSentAt ||
          null,

        botMessageId:
          savedState.botMessageId ||
          null,

        channelId:
          savedState.channelId ||
          null,

        whatsappError:
          savedState.whatsappError ||
          null
      },
      null,
      2
    )
  );

  if (!currentLive) {
    await handleOffline(
      savedState
    );

    return;
  }

  await handleLive(
    savedState
  );
}

/* =========================================================
   START + SAUBERES ENDE
   ========================================================= */

main()
  .then(
    async () => {
      try {
        await mongoose.disconnect();
      } catch {}

      console.log(
        '================================'
      );

      console.log(
        '✅ Live-Check abgeschlossen.'
      );

      console.log(
        '================================'
      );

      process.exit(0);
    }
  )
  .catch(
    async error => {
      console.error(
        '================================'
      );

      console.error(
        '❌ Live-Check fehlgeschlagen:'
      );

      console.error(
        error
      );

      console.error(
        '================================'
      );

      try {
        await mongoose.disconnect();
      } catch {}

      process.exit(1);
    }
  );
