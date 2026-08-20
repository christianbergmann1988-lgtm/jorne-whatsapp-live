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

const TIKTOK_TIMEOUT_MS = 20000;

const WHATSAPP_READY_TIMEOUT_MS = 90000;

const WHATSAPP_STABLE_MS = 10000;


/*
============================================================
MONGODB: TIKTOK-STATUS
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
       * Daten zur eindeutig vom Bot erzeugten
       * WhatsApp-Kanalmeldung.
       */

      botMessageKeyType: {
        type: String,
        default: null
      },

      botMessageKeyValue: {
        type: String,
        default: null
      },

      botMessagePrePlainText: {
        type: String,
        default: null
      },

      botMessageSentAt: {
        type: Date,
        default: null
      },

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
GESPEICHERTEN STATUS HOLEN
============================================================
*/

async function getSavedState() {

  const state =
    await TikTokState
      .findOne({
        username: TIKTOK_USERNAME
      })
      .lean();


  return state || {
    username: TIKTOK_USERNAME,
    live: false,
    whatsappSent: false,
    whatsappError: null,
    botMessageKeyType: null,
    botMessageKeyValue: null,
    botMessagePrePlainText: null,
    botMessageSentAt: null,
    deletePending: false
  };
}


/*
============================================================
OFFLINE SPEICHERN
============================================================
*/

async function setOfflineState(
  {
    deletionSuccessful = false
  } = {}
) {

  const update = {

    live: false,

    whatsappError: null,

    changedAt: new Date()
  };


  /*
   * Nur wenn die Bot-Meldung tatsächlich
   * entfernt wurde oder gar keine existiert,
   * löschen wir ihre gespeicherten Daten.
   */

  if (
    deletionSuccessful
  ) {

    update.whatsappSent = false;

    update.botMessageKeyType = null;

    update.botMessageKeyValue = null;

    update.botMessagePrePlainText = null;

    update.botMessageSentAt = null;

    update.deletePending = false;
  }


  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: update
    },

    {
      upsert: true
    }
  );
}


/*
============================================================
LÖSCHEN VORMERKEN
============================================================
*/

async function markDeletePending() {

  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: {
        live: false,
        deletePending: true,
        changedAt: new Date()
      }
    },

    {
      upsert: true
    }
  );
}


/*
============================================================
WHATSAPP-ERFOLG SPEICHERN
============================================================
*/

async function setWhatsAppSuccess(
  messageIdentity
) {

  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: {

        live: true,

        whatsappSent: true,

        whatsappError: null,

        botMessageKeyType:
          messageIdentity?.keyType ||
          null,

        botMessageKeyValue:
          messageIdentity?.keyValue ||
          null,

        botMessagePrePlainText:
          messageIdentity?.prePlainText ||
          null,

        botMessageSentAt:
          new Date(),

        deletePending: false,

        changedAt:
          new Date()
      }
    },

    {
      upsert: true
    }
  );
}


/*
============================================================
WHATSAPP-FEHLER SPEICHERN
============================================================
*/

async function setWhatsAppFailure(
  error
) {

  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: {

        /*
         * Ganz wichtig:
         * LIVE bleibt TRUE.
         *
         * Sonst würde jede Minute wieder versucht.
         */

        live: true,

        whatsappSent: false,

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
      upsert: true
    }
  );
}


/*
============================================================
LIVE-START ATOMAR RESERVIEREN
============================================================
*/

async function claimNewLiveStart() {

  const result =
    await TikTokState.findOneAndUpdate(
      {
        username: TIKTOK_USERNAME,
        live: false
      },

      {
        $set: {

          live: true,

          whatsappSent: false,

          whatsappError: null,

          changedAt:
            new Date()
        }
      },

      {
        new: true
      }
    );


  if (result) {

    return true;
  }


  const existing =
    await TikTokState
      .findOne({
        username: TIKTOK_USERNAME
      })
      .lean();


  if (existing) {

    return false;
  }


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

      changedAt:
        new Date()
    });


    return true;

  } catch (error) {

    if (
      error?.code === 11000
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

class FixedMongoStore extends MongoStore {

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
          uploadDate: -1
        })
        .toArray();


    if (
      documents.length > 1
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
TIKTOK PRÜFEN
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
PUPPETEER PRÜFEN
============================================================
*/

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
    typeof page.isClosed === 'function' &&
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
    Date.now() - started <
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
        typeof page.isClosed !== 'function' ||
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
WHATSAPP-POPUP SCHLIESSEN
============================================================
*/

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
            element.getBoundingClientRect();


          const style =
            window.getComputedStyle(
              element
            );


          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        }


        function getText(
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
            .trim();
        }


        let popup =
          document.querySelector(
            '[data-testid="confirm-popup"]'
          );


        if (
          !popup ||
          !isVisible(
            popup
          )
        ) {

          popup =
            document.querySelector(
              '[data-testid="popup-contents"]'
            );
        }


        if (
          !popup ||
          !isVisible(
            popup
          )
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
              [
                'button',
                '[role="button"]',
                '[tabindex]',
                '[aria-label]'
              ].join(',')
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
                getText(
                  element
                )
                  .toLowerCase();


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
                  getText(
                    element
                  )
                    .toLowerCase();


                return (
                  text === 'ok' ||
                  text === 'okay' ||
                  text === 'verstanden' ||
                  text === 'fertig' ||
                  text === 'weiter' ||
                  text === 'nicht jetzt'
                );
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

    await sleep(
      2000
    );


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


      await sleep(
        1500
      );

    } catch {}
  }
}


/*
============================================================
KANALANSICHT PRÜFEN
============================================================
*/

async function inspectRightChannelArea(
  page
) {

  assertPageAlive(
    page,
    'Kanalansicht prüfen'
  );


  return await page.evaluate(
    channelName => {

      const channel =
        channelName.toLowerCase();


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


      const rightText =
        [
          ...document.querySelectorAll(
            '*'
          )
        ]
          .filter(
            element => {

              const rect =
                element.getBoundingClientRect();


              return (
                rect.width > 0 &&
                rect.height > 0 &&
                rect.left >
                  window.innerWidth *
                    0.32
              );
            }
          )
          .some(
            element => {

              const text =
                (
                  element.textContent ||
                  ''
                )
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
                  channel
                ) ||
                aria.includes(
                  channel
                )
              );
            }
          );


      return {

        emptyState,

        channelNameVisibleRight:
          rightText
      };
    },

    CHANNEL_NAME
  );
}


/*
============================================================
WHATSAPP-KANAL ÖFFNEN
============================================================
*/

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

        function normalize(
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
            element.getBoundingClientRect();


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
              [
                'button',
                '[role="button"]',
                '[role="tab"]',
                '[tabindex]',
                '[aria-label]',
                '[data-testid]'
              ].join(',')
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
          !isVisible(
            target
          )
        ) {

          target =
            null;
        }


        if (!target) {

          target =
            elements.find(
              element =>
                normalize(
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
              element => {

                const testId =
                  normalize(
                    element.getAttribute(
                      'data-testid'
                    )
                  );


                return (
                  testId.includes(
                    'newsletter-tab-drawer'
                  )
                );
              }
            );
        }


        if (!target) {

          target =
            elements.find(
              element =>
                normalize(
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
            [
              'button',
              '[role="button"]',
              '[role="tab"]',
              '[tabindex]'
            ].join(',')
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


  await channelsButton.click({
    delay: 120
  });


  console.log(
    '✅ Bereich "Kanäle" geöffnet.'
  );


  await sleep(
    4500
  );


  await closeWhatsAppPopup(
    page
  );


  await sleep(
    2500
  );


  console.log(
    `🔎 Suche Kanal "${CHANNEL_NAME}"...`
  );


  const channelFound =
    await page.evaluate(
      channelName => {

        function normalize(
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
            element.getBoundingClientRect();


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
          normalize(
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
                normalize(
                  element.textContent
                );


              const aria =
                normalize(
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
          target.getBoundingClientRect();


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


  const box =
    await channelHandle.boundingBox();


  if (!box) {

    throw new Error(
      'Keine Klickposition für Jorne_L1ve verfügbar.'
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


  await sleep(
    5000
  );


  await closeWhatsAppPopup(
    page
  );


  await sleep(
    1500
  );


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


        await sleep(
          5000
        );
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


  await sleep(
    2500
  );
}


/*
============================================================
COMPOSER FINDEN
============================================================
*/

async function markComposer(
  page
) {

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
            element.getBoundingClientRect();


          const style =
            window.getComputedStyle(
              element
            );


          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
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
          !isVisible(
            target
          )
        ) {

          target =
            null;
        }


        if (!target) {

          const candidates =
            [
              ...document.querySelectorAll(
                [
                  '[contenteditable="true"]',
                  '[role="textbox"]',
                  '[data-lexical-editor="true"]',
                  'textarea'
                ].join(',')
              )
            ].filter(
              isVisible
            );


          target =
            candidates.find(
              element => {

                const rect =
                  element.getBoundingClientRect();


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
}


/*
============================================================
MEHRZEILIGE MELDUNG
============================================================
*/

async function typeMultilineMessage(
  page,
  message
) {

  const lines =
    message.split(
      '\n'
    );


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


/*
============================================================
BOT-MELDUNG IDENTIFIZIEREN

Wir speichern eine echte WhatsApp-DOM-Kennung.
Wenn keine eindeutige Kennung gefunden wird,
löschen wir später NICHT blind irgendeine Nachricht.
============================================================
*/

async function identifyBotMessage(
  page
) {

  console.log(
    '🔐 Ermittle eindeutige Kennung der Bot-Meldung...'
  );


  const identity =
    await page.evaluate(
      (
        phrase,
        liveUrl
      ) => {

        function normalize(
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


        const elements =
          [
            ...document.querySelectorAll(
              '*'
            )
          ];


        /*
         * Möglichst kleinstes Element,
         * das BEIDE Merkmale enthält.
         */

        const matches =
          elements.filter(
            element => {

              const text =
                normalize(
                  element.textContent
                );


              return (
                text.includes(
                  phrase
                ) &&
                text.includes(
                  liveUrl
                )
              );
            }
          );


        if (!matches.length) {

          return null;
        }


        matches.sort(
          (
            a,
            b
          ) => {

            return (
              a.children.length -
              b.children.length
            );
          }
        );


        let element =
          matches[0];


        /*
         * Bis zu 10 Eltern nach einer
         * brauchbaren eindeutigen ID durchsuchen.
         */

        for (
          let depth = 0;
          depth < 10 &&
          element;
          depth++
        ) {

          const dataId =
            element.getAttribute(
              'data-id'
            );


          if (dataId) {

            return {
              keyType:
                'data-id',

              keyValue:
                dataId,

              prePlainText:
                element.getAttribute(
                  'data-pre-plain-text'
                ) ||
                null
            };
          }


          const messageId =
            element.getAttribute(
              'data-message-id'
            );


          if (messageId) {

            return {
              keyType:
                'data-message-id',

              keyValue:
                messageId,

              prePlainText:
                element.getAttribute(
                  'data-pre-plain-text'
                ) ||
                null
            };
          }


          const prePlain =
            element.getAttribute(
              'data-pre-plain-text'
            );


          if (prePlain) {

            return {
              keyType:
                'data-pre-plain-text',

              keyValue:
                prePlain,

              prePlainText:
                prePlain
            };
          }


          element =
            element.parentElement;
        }


        /*
         * KEINE eindeutige Kennung.
         *
         * Dann lieber später NICHT löschen.
         */

        return null;
      },

      LIVE_MESSAGE_PHRASE,

      LIVE_URL
    );


  console.log(
    '🔐 Bot-Nachrichtenkennung:',
    identity
  );


  return identity;
}


/*
============================================================
LIVE-MELDUNG SENDEN
============================================================
*/

async function sendLiveMessage(
  client
) {

  const state =
    await client.getState();


  if (
    state !== 'CONNECTED'
  ) {

    throw new Error(
      `WhatsApp ist nicht CONNECTED, sondern ${state}.`
    );
  }


  const page =
    client.pupPage;


  assertPageAlive(
    page,
    'Sendevorgang'
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


  await composer.click({
    delay: 100
  });


  await sleep(
    500
  );


  await typeMultilineMessage(
    page,
    LIVE_MESSAGE
  );


  console.log(
    '⌨️ Live-Meldung eingegeben.'
  );


  await sleep(
    1500
  );


  await page.keyboard.press(
    'Enter'
  );


  console.log(
    '📤 Live-Meldung abgesendet.'
  );


  await sleep(
    6000
  );


  /*
   * Jetzt die Bot-Meldung eindeutig identifizieren.
   */

  const identity =
    await identifyBotMessage(
      page
    );


  if (!identity) {

    /*
     * Meldung wurde trotzdem gesendet.
     *
     * Wir speichern aber bewusst KEINE
     * unsichere Kennung.
     */

    console.log(
      '⚠️ Live-Meldung wurde gesendet, aber keine sichere DOM-Kennung gefunden.'
    );


    console.log(
      '⚠️ Aus Sicherheitsgründen würde diese Meldung später NICHT automatisch gelöscht.'
    );
  }


  console.log(
    '🎉 WhatsApp-Live-Meldung erfolgreich veröffentlicht.'
  );


  return identity;
}


/*
============================================================
NUR DIE BOT-MELDUNG SUCHEN
============================================================
*/

async function markExactBotMessageForDeletion(
  page,
  savedState
) {

  /*
   * Ohne gespeicherte eindeutige Kennung:
   * KEINE Löschung.
   */

  if (
    !savedState.botMessageKeyType ||
    !savedState.botMessageKeyValue
  ) {

    return {
      found: false,
      reason:
        'Keine eindeutige Bot-Nachrichtenkennung gespeichert.'
    };
  }


  return await page.evaluate(
    (
      keyType,
      keyValue,
      phrase,
      liveUrl
    ) => {

      function normalize(
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
          element.getBoundingClientRect();


        return (
          rect.width > 0 &&
          rect.height > 0
        );
      }


      document
        .querySelectorAll(
          '[data-bot-delete-target]'
        )
        .forEach(
          element =>
            element.removeAttribute(
              'data-bot-delete-target'
            )
        );


      let target =
        null;


      const all =
        [
          ...document.querySelectorAll(
            '*'
          )
        ];


      if (
        keyType ===
        'data-id'
      ) {

        target =
          all.find(
            element =>
              element.getAttribute(
                'data-id'
              ) ===
              keyValue
          );
      }


      if (
        !target &&
        keyType ===
          'data-message-id'
      ) {

        target =
          all.find(
            element =>
              element.getAttribute(
                'data-message-id'
              ) ===
              keyValue
          );
      }


      if (
        !target &&
        keyType ===
          'data-pre-plain-text'
      ) {

        target =
          all.find(
            element =>
              element.getAttribute(
                'data-pre-plain-text'
              ) ===
              keyValue
          );
      }


      if (
        !target
      ) {

        return {
          found: false,
          reason:
            'Gespeicherte WhatsApp-Kennung wurde nicht mehr gefunden.'
        };
      }


      /*
       * ZWEITE SICHERHEIT:
       * Das gefundene Element muss weiterhin
       * genau unsere Live-Nachricht enthalten.
       */

      let container =
        target;


      let verified =
        false;


      for (
        let depth = 0;
        depth < 8 &&
        container;
        depth++
      ) {

        const text =
          normalize(
            container.textContent
          );


        if (
          text.includes(
            phrase
          ) &&
          text.includes(
            liveUrl
          )
        ) {

          verified =
            true;

          break;
        }


        container =
          container.parentElement;
      }


      if (
        !verified ||
        !container
      ) {

        return {
          found: false,
          reason:
            'Kennung gefunden, Text stimmt aber NICHT mit der Bot-Live-Meldung überein.'
        };
      }


      if (
        !isVisible(
          container
        )
      ) {

        return {
          found: false,
          reason:
            'Bot-Meldung ist nicht sichtbar.'
        };
      }


      container.setAttribute(
        'data-bot-delete-target',
        'true'
      );


      return {
        found: true
      };
    },

    savedState.botMessageKeyType,

    savedState.botMessageKeyValue,

    LIVE_MESSAGE_PHRASE,

    LIVE_URL
  );
}


/*
============================================================
BOT-MELDUNG LÖSCHEN
============================================================
*/

async function deleteBotLiveMessage(
  client,
  savedState
) {

  const page =
    client.pupPage;


  assertPageAlive(
    page,
    'Bot-Meldung löschen'
  );


  console.log(
    '================================'
  );


  console.log(
    '🗑️ LÖSCHE AUSSCHLIESSLICH BOT-LIVE-MELDUNG'
  );


  console.log(
    '================================'
  );


  await openWhatsAppChannel(
    page
  );


  const result =
    await markExactBotMessageForDeletion(
      page,
      savedState
    );


  console.log(
    '🔎 Bot-Meldung Suche:',
    result
  );


  if (
    !result.found
  ) {

    console.log(
      '🛑 Keine Löschung durchgeführt.'
    );


    console.log(
      '🛡️ Sicherheit: Andere Kanalbeiträge bleiben unangetastet.'
    );


    return false;
  }


  const target =
    await page.$(
      '[data-bot-delete-target="true"]'
    );


  if (!target) {

    return false;
  }


  /*
   * Maus über die exakt erkannte
   * Bot-Meldung bewegen.
   */

  const box =
    await target.boundingBox();


  if (!box) {

    return false;
  }


  await page.mouse.move(

    box.x +
      box.width / 2,

    box.y +
      Math.min(
        30,
        box.height / 2
      )
  );


  await sleep(
    1200
  );


  /*
   * Menü-Button NUR im Bereich
   * dieser Nachricht suchen.
   */

  const menuMarked =
    await page.evaluate(
      () => {

        function visible(
          element
        ) {

          if (!element) {

            return false;
          }


          const rect =
            element.getBoundingClientRect();


          return (
            rect.width > 0 &&
            rect.height > 0
          );
        }


        const target =
          document.querySelector(
            '[data-bot-delete-target="true"]'
          );


        if (!target) {

          return false;
        }


        let container =
          target;


        for (
          let depth = 0;
          depth < 6 &&
          container;
          depth++
        ) {

          const buttons =
            [
              ...container.querySelectorAll(
                [
                  'button',
                  '[role="button"]',
                  '[aria-label]',
                  '[data-testid]'
                ].join(',')
              )
            ].filter(
              visible
            );


          const button =
            buttons.find(
              element => {

                const aria =
                  (
                    element.getAttribute(
                      'aria-label'
                    ) ||
                    ''
                  )
                    .toLowerCase();


                const title =
                  (
                    element.getAttribute(
                      'title'
                    ) ||
                    ''
                  )
                    .toLowerCase();


                const testId =
                  (
                    element.getAttribute(
                      'data-testid'
                    ) ||
                    ''
                  )
                    .toLowerCase();


                const html =
                  (
                    element.innerHTML ||
                    ''
                  )
                    .toLowerCase();


                return (
                  aria.includes(
                    'menü'
                  ) ||
                  aria.includes(
                    'menu'
                  ) ||
                  aria.includes(
                    'weitere'
                  ) ||
                  aria.includes(
                    'more'
                  ) ||
                  title.includes(
                    'menü'
                  ) ||
                  title.includes(
                    'menu'
                  ) ||
                  testId.includes(
                    'menu'
                  ) ||
                  html.includes(
                    'down'
                  ) ||
                  html.includes(
                    'chevron'
                  )
                );
              }
            );


          if (button) {

            button.setAttribute(
              'data-bot-message-menu',
              'true'
            );


            return true;
          }


          container =
            container.parentElement;
        }


        return false;
      }
    );


  if (!menuMarked) {

    console.log(
      '⚠️ Menü der Bot-Meldung wurde nicht sicher gefunden.'
    );


    console.log(
      '🛑 Keine Löschung.'
    );


    return false;
  }


  const menuButton =
    await page.$(
      '[data-bot-message-menu="true"]'
    );


  if (!menuButton) {

    return false;
  }


  await menuButton.click({
    delay: 100
  });


  await sleep(
    1500
  );


  /*
   * Jetzt explizit "Löschen".
   */

  const deleteMarked =
    await page.evaluate(
      () => {

        function visible(
          element
        ) {

          if (!element) {

            return false;
          }


          const rect =
            element.getBoundingClientRect();


          const style =
            window.getComputedStyle(
              element
            );


          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        }


        const elements =
          [
            ...document.querySelectorAll(
              [
                '[role="menuitem"]',
                'button',
                '[role="button"]',
                '[tabindex]'
              ].join(',')
            )
          ].filter(
            visible
          );


        const deleteButton =
          elements.find(
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


              return (
                text ===
                  'löschen' ||
                text ===
                  'delete'
              );
            }
          );


        if (!deleteButton) {

          return false;
        }


        deleteButton.setAttribute(
          'data-bot-delete-button',
          'true'
        );


        return true;
      }
    );


  if (!deleteMarked) {

    console.log(
      '⚠️ Menüpunkt "Löschen" wurde nicht gefunden.'
    );


    return false;
  }


  const deleteButton =
    await page.$(
      '[data-bot-delete-button="true"]'
    );


  await deleteButton.click({
    delay: 100
  });


  await sleep(
    1500
  );


  /*
   * Falls WhatsApp noch einen
   * Bestätigungsdialog zeigt.
   */

  const confirmMarked =
    await page.evaluate(
      () => {

        function visible(
          element
        ) {

          if (!element) {

            return false;
          }


          const rect =
            element.getBoundingClientRect();


          return (
            rect.width > 0 &&
            rect.height > 0
          );
        }


        const dialogs =
          [
            ...document.querySelectorAll(
              '[role="dialog"]'
            )
          ].filter(
            visible
          );


        if (!dialogs.length) {

          /*
           * Offenbar direkt gelöscht.
           */

          return {
            needed: false
          };
        }


        const dialog =
          dialogs[
            dialogs.length - 1
          ];


        const buttons =
          [
            ...dialog.querySelectorAll(
              [
                'button',
                '[role="button"]'
              ].join(',')
            )
          ].filter(
            visible
          );


        /*
         * Vorrang für "Für alle löschen".
         */

        let confirm =
          buttons.find(
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


              return (
                text.includes(
                  'für alle löschen'
                ) ||
                text.includes(
                  'delete for everyone'
                )
              );
            }
          );


        if (!confirm) {

          confirm =
            buttons.find(
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


                return (
                  text ===
                    'löschen' ||
                  text ===
                    'delete'
                );
              }
            );
        }


        if (!confirm) {

          return {
            needed: true,
            found: false
          };
        }


        confirm.setAttribute(
          'data-bot-confirm-delete',
          'true'
        );


        return {
          needed: true,
          found: true
        };
      }
    );


  if (
    confirmMarked.needed
  ) {

    if (
      !confirmMarked.found
    ) {

      console.log(
        '⚠️ Lösch-Bestätigung wurde nicht sicher gefunden.'
      );


      return false;
    }


    const confirmButton =
      await page.$(
        '[data-bot-confirm-delete="true"]'
      );


    await confirmButton.click({
      delay: 120
    });


    await sleep(
      3000
    );
  }


  /*
   * Prüfen, ob die exakte Bot-Kennung
   * verschwunden ist.
   */

  const stillExists =
    await page.evaluate(
      (
        keyType,
        keyValue
      ) => {

        return [
          ...document.querySelectorAll(
            '*'
          )
        ].some(
          element => {

            return (
              (
                keyType ===
                  'data-id' &&
                element.getAttribute(
                  'data-id'
                ) ===
                  keyValue
              ) ||

              (
                keyType ===
                  'data-message-id' &&
                element.getAttribute(
                  'data-message-id'
                ) ===
                  keyValue
              ) ||

              (
                keyType ===
                  'data-pre-plain-text' &&
                element.getAttribute(
                  'data-pre-plain-text'
                ) ===
                  keyValue
              )
            );
          }
        );
      },

      savedState.botMessageKeyType,

      savedState.botMessageKeyValue
    );


  if (stillExists) {

    console.log(
      '⚠️ Bot-Meldung ist nach dem Löschversuch noch vorhanden.'
    );


    return false;
  }


  console.log(
    '✅ Bot-Live-Meldung wurde erfolgreich gelöscht.'
  );


  console.log(
    '🛡️ Keine andere Kanalnachricht wurde verändert.'
  );


  return true;
}


/*
============================================================
WHATSAPP STARTEN
============================================================
*/

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


  let result;


  try {

    result =
      await action(
        client
      );

  } finally {

    await sleep(
      2500
    );


    initializePromise.catch(
      error => {

        const message =
          String(
            error?.message ||
            error
          );


        if (
          !message.includes(
            'Target closed'
          )
        ) {

          console.log(
            '⚠️ initialize():',
            message
          );
        }
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
      recursive: true
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
MAIN
============================================================
*/

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


  const oldLive =
    Boolean(
      savedState.live
    );


  console.log(
    `🗄️ Gespeicherter Status: ${oldLive ? 'LIVE' : 'offline'}`
  );


  /*
  ==========================================================
  OFFLINE
  ==========================================================
  */

  if (
    !currentLive
  ) {

    /*
     * Es gab vorher einen Live-Start und
     * der Bot hatte tatsächlich eine Meldung gesendet.
     */

    if (
      (
        oldLive ||
        savedState.deletePending
      ) &&
      savedState.whatsappSent
    ) {

      console.log(
        '⚫ Jorne ist offline.'
      );


      console.log(
        '🗑️ Die gespeicherte Bot-Live-Meldung soll entfernt werden.'
      );


      /*
       * Wenn keine eindeutige Kennung gespeichert wurde,
       * wird ABSICHTLICH nichts gelöscht.
       */

      if (
        !savedState.botMessageKeyType ||
        !savedState.botMessageKeyValue
      ) {

        console.log(
          '🛑 Keine sichere Nachrichtenkennung vorhanden.'
        );


        console.log(
          '🛡️ Deshalb wird keine WhatsApp-Nachricht gelöscht.'
        );


        await setOfflineState({
          deletionSuccessful:
            false
        });


        return;
      }


      const store =
        createStore();


      let deleted =
        false;


      try {

        deleted =
          await startWhatsApp(
            store,

            async client => {

              return await deleteBotLiveMessage(
                client,
                savedState
              );
            }
          );

      } catch (error) {

        console.error(
          '⚠️ Bot-Live-Meldung konnte nicht gelöscht werden:',
          error.message
        );
      }


      if (deleted) {

        await setOfflineState({
          deletionSuccessful:
            true
        });


        console.log(
          '✅ Jorne offline.'
        );


        console.log(
          '✅ Bot-Live-Meldung entfernt.'
        );


        console.log(
          '✅ System für den nächsten Live-Start zurückgesetzt.'
        );

      } else {

        /*
         * TikTok ist trotzdem offline.
         * Löschversuch wird vorgemerkt.
         */

        await markDeletePending();


        console.log(
          '⚠️ Bot-Meldung blieb bestehen.'
        );


        console.log(
          '➡️ Ein späterer Offline-Lauf darf erneut versuchen, ausschließlich diese gespeicherte Bot-Meldung zu löschen.'
        );
      }


      return;
    }


    /*
     * Keine Bot-Meldung vorhanden.
     */

    if (
      oldLive
    ) {

      await setOfflineState({
        deletionSuccessful:
          true
      });


      console.log(
        '⚫ Jorne ist wieder offline.'
      );


      console.log(
        '✅ Status zurückgesetzt.'
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
  BEREITS LIVE
  ==========================================================
  */

  if (
    currentLive &&
    oldLive
  ) {

    console.log(
      '🔴 Jorne ist weiterhin LIVE.'
    );


    console.log(
      '✅ Dieser Live-Start wurde bereits verarbeitet.'
    );


    console.log(
      '✅ Keine zweite WhatsApp-Nachricht.'
    );


    return;
  }


  /*
  ==========================================================
  NEUER LIVE-START
  ==========================================================
  */

  console.log(
    '🔴 NEUER TIKTOK-LIVE-START ERKANNT!'
  );


  const claimed =
    await claimNewLiveStart();


  if (!claimed) {

    console.log(
      '✅ Ein anderer Lauf hat diesen Live-Start bereits übernommen.'
    );


    return;
  }


  console.log(
    '🔒 Live-Start reserviert.'
  );


  const store =
    createStore();


  try {

    const identity =
      await startWhatsApp(
        store,

        async client => {

          return await sendLiveMessage(
            client
          );
        }
      );


    await setWhatsAppSuccess(
      identity
    );


    console.log(
      '================================'
    );


    console.log(
      '🎉 LIVE-ALARM ERFOLGREICH'
    );


    if (identity) {

      console.log(
        '🔐 Bot-Live-Meldung wurde eindeutig gespeichert.'
      );


      console.log(
        '➡️ Beim Offline-Wechsel darf genau diese Nachricht gelöscht werden.'
      );

    } else {

      console.log(
        '⚠️ Keine eindeutige Nachrichtenkennung.'
      );


      console.log(
        '🛡️ Diese Meldung wird deshalb aus Sicherheitsgründen später NICHT automatisch gelöscht.'
      );
    }


    console.log(
      '================================'
    );

  } catch (error) {

    await setWhatsAppFailure(
      error
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
      '✅ Kein minutenweiser Sende-Loop.'
    );


    throw error;
  }
}


/*
============================================================
START
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
