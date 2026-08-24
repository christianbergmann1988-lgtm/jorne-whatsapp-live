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

const CLIENT_ID =
  'jorne-whatsapp-live';

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

      deletePending: {
        type: Boolean,
        default: false
      },

      changedAt: {
        type: Date,
        default: Date.now
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
    botMessageSentAt: null,
    deletePending: false
  };
}


/*
============================================================
LIVE-START RESERVIEREN
============================================================
*/

async function reserveLiveStart() {
  const result =
    await TikTokState.findOneAndUpdate(
      {
        username: TIKTOK_USERNAME,
        live: false,

        deletePending: {
          $ne: true
        }
      },

      {
        $set: {
          live: true,
          whatsappSent: false,
          whatsappError: null,
          botMessageSentAt: null,
          changedAt: new Date()
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
      username: TIKTOK_USERNAME,
      live: true,
      whatsappSent: false,
      whatsappError: null,
      botMessageSentAt: null,
      deletePending: false,
      changedAt: new Date()
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
SENDEN ERFOLGREICH
============================================================
*/

async function markSendSuccess(
  sentAt
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
        botMessageSentAt: sentAt,
        deletePending: false,
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
SENDEN FEHLGESCHLAGEN
============================================================
*/

async function markSendFailure(
  error
) {
  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: {
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
LÖSCHUNG VORMERKEN
============================================================
*/

async function markDeletePending(
  error = null
) {
  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: {
        live: false,
        deletePending: true,

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
      upsert: true
    }
  );
}


/*
============================================================
OFFLINE KOMPLETT ZURÜCKSETZEN
============================================================
*/

async function resetOfflineState() {
  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: {
        live: false,
        whatsappSent: false,
        whatsappError: null,
        botMessageSentAt: null,
        deletePending: false,
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
        !stableSince
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
            element
              .getBoundingClientRect();

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
                textOf(
                  element
                );

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
                  textOf(
                    element
                  );

                return [
                  'ok',
                  'okay',
                  'verstanden',
                  'fertig',
                  'weiter',
                  'nicht jetzt'
                ].includes(
                  text
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
RECHTE KANALANSICHT PRÜFEN
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
          style.display !== 'none' &&
          style.visibility !== 'hidden'
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
              element =>
                normalize(
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


  await sleep(
    500
  );


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


  await sleep(
    700
  );


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


/*
============================================================
MEHRZEILIGE MELDUNG
============================================================
*/

async function typeMultilineMessage(
  page,
  message
) {
  assertPageAlive(
    page,
    'Text eingeben'
  );


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
BOT-LIVE-MELDUNGEN FINDEN

WICHTIGER FIX:

Die vorhandene Kanalnachricht wird beim späteren Öffnen
NICHT mehr gleichzeitig über Text + komplette TikTok-URL
gesucht.

WhatsApp stellt Links in Kanalbeiträgen teilweise anders
im DOM dar. Deshalb reicht die eindeutige Phrase:

"Jorne ist jetzt LIVE auf TikTok!"

Damit kann die Nachricht auch beim Offline-Wechsel wieder
gefunden werden.
============================================================
*/

async function findBotLiveMessageCandidates(
  page
) {
  assertPageAlive(
    page,
    'Bot-Live-Meldungen suchen'
  );


  const candidates =
    await page.evaluate(
      phrase => {
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
            element
              .getBoundingClientRect();


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


        function containsMessageText(
          element
        ) {
          const text =
            normalize(
              element?.textContent
            );


          return text.includes(
            phrase
          );
        }


        function isPlausibleMessageContainer(
          element
        ) {
          if (
            !element ||
            !isVisible(
              element
            ) ||
            !containsMessageText(
              element
            )
          ) {
            return false;
          }


          const rect =
            element
              .getBoundingClientRect();


          /*
           * Nur rechte Kanalansicht.
           */

          if (
            rect.left <
            window.innerWidth *
              0.30
          ) {
            return false;
          }


          /*
           * Zu kleine Text-/Icon-Elemente
           * ignorieren.
           */

          if (
            rect.width < 180 ||
            rect.height < 45
          ) {
            return false;
          }


          /*
           * Riesige Container wie die ganze
           * rechte Seite ignorieren.
           */

          if (
            rect.width >
            window.innerWidth *
              0.80
          ) {
            return false;
          }


          if (
            rect.height >
            window.innerHeight *
              0.60
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


        const chosen =
          [];


/*
------------------------------------------------------------
1. WAHL: WHATSAPP-MESSAGE-CONTAINER MIT data-id
------------------------------------------------------------
*/

        const dataIdMatches =
          [
            ...document.querySelectorAll(
              '[data-id]'
            )
          ].filter(
            isPlausibleMessageContainer
          );


        for (
          const element
          of dataIdMatches
        ) {
          const duplicate =
            chosen.some(
              existing =>
                existing === element ||
                existing.contains(
                  element
                ) ||
                element.contains(
                  existing
                )
            );


          if (!duplicate) {
            chosen.push(
              element
            );
          }
        }


/*
------------------------------------------------------------
2. WAHL: TYPISCHE MESSAGE-CONTAINER
------------------------------------------------------------
*/

        if (
          chosen.length === 0
        ) {
          const semanticMatches =
            [
              ...document.querySelectorAll(
                '[data-testid*="msg"],[data-testid*="message"],[role="row"],[role="listitem"]'
              )
            ].filter(
              isPlausibleMessageContainer
            );


          for (
            const element
            of semanticMatches
          ) {
            const duplicate =
              chosen.some(
                existing =>
                  existing === element ||
                  existing.contains(
                    element
                  ) ||
                  element.contains(
                    existing
                  )
              );


            if (!duplicate) {
              chosen.push(
                element
              );
            }
          }
        }


/*
------------------------------------------------------------
3. FALLBACK: TEXT FINDEN UND ELTERN-CONTAINER BESTIMMEN
------------------------------------------------------------
*/

        if (
          chosen.length === 0
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
                element => {
                  const rect =
                    element
                      .getBoundingClientRect();


                  return (
                    rect.left >
                      window.innerWidth *
                        0.30 &&
                    containsMessageText(
                      element
                    )
                  );
                }
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
                isPlausibleMessageContainer(
                  current
                )
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
              chosen.some(
                existing =>
                  existing === best ||
                  existing.contains(
                    best
                  ) ||
                  best.contains(
                    existing
                  )
              );


            if (!duplicate) {
              chosen.push(
                best
              );
            }
          }
        }


/*
------------------------------------------------------------
GEOMETRISCHE DEDUPLIZIERUNG
------------------------------------------------------------
*/

        const deduped =
          [];


        for (
          const element
          of chosen
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
              String(
                index
              )
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

              tag:
                element.tagName,

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
    `🔎 Gefundene Bot-Live-Meldungen: ${candidates.length}`
  );


  if (
    candidates.length
  ) {
    console.log(
      '🧭 Kandidaten:',
      JSON.stringify(
        candidates
      )
    );
  }


  return candidates;
}


/*
============================================================
BOT-MELDUNG NACH SENDEN PRÜFEN
============================================================
*/

async function verifyLiveMessageVisible(
  page
) {
  const candidates =
    await findBotLiveMessageCandidates(
      page
    );


  if (
    candidates.length < 1
  ) {
    throw new Error(
      'Live-Meldung wurde nach dem Absenden nicht sicher im Kanal gefunden.'
    );
  }


  console.log(
    '✅ Live-Meldung ist im WhatsApp-Kanal sichtbar.'
  );


  return true;
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


  await composer.evaluate(
    element => {
      element.scrollIntoView({
        block: 'center',
        inline: 'center'
      });
    }
  );


  await sleep(
    500
  );


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
    '⌨️ Live-Meldung vollständig eingegeben.'
  );


  await sleep(
    1500
  );


  await page.keyboard.press(
    'Enter'
  );


  console.log(
    '📤 ENTER gedrückt – Live-Meldung abgesendet.'
  );


  await sleep(
    6000
  );


  await verifyLiveMessageVisible(
    page
  );


  const sentAt =
    new Date();


  console.log(
    '🎉 WhatsApp-Live-Meldung erfolgreich veröffentlicht.'
  );


  return sentAt;
}


/*
============================================================
MENÜ DER EXAKTEN BOT-MELDUNG FINDEN
============================================================
*/

async function markMenuButtonForCandidate(
  page,
  candidateIndex
) {
  const candidateSelector =
    `[data-bot-live-candidate="${candidateIndex}"]`;


  const target =
    await page.$(
      candidateSelector
    );


  if (!target) {
    return false;
  }


  await target.evaluate(
    element => {
      element.scrollIntoView({
        block: 'center',
        inline: 'nearest'
      });
    }
  );


  await sleep(
    700
  );


  let box =
    await target.boundingBox();


  if (!box) {
    return false;
  }


  const hoverPoints =
    [
      [
        box.x +
          box.width *
            0.65,

        box.y +
          Math.min(
            30,
            box.height *
              0.35
          )
      ],

      [
        box.x +
          Math.max(
            20,
            box.width -
              28
          ),

        box.y +
          Math.min(
            28,
            box.height *
              0.30
          )
      ],

      [
        box.x +
          Math.max(
            20,
            box.width -
              28
          ),

        box.y +
          box.height *
            0.50
      ]
    ];


  for (
    const [
      x,
      y
    ]
    of hoverPoints
  ) {
    await page.mouse.move(
      x,
      y,
      {
        steps: 8
      }
    );


    await sleep(
      700
    );
  }


  box =
    await target.boundingBox();


  if (!box) {
    return false;
  }


  const menuMarked =
    await page.evaluate(
      (
        {
          candidateIndex,
          targetBox
        }
      ) => {
        function visible(
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
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        }


        function descriptor(
          element
        ) {
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


          const dataIcon =
            (
              element.getAttribute(
                'data-icon'
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


          return {
            aria,
            title,
            testId,
            dataIcon,
            html,
            text
          };
        }


        function looksLikeMenu(
          element
        ) {
          const d =
            descriptor(
              element
            );


          return (
            d.aria.includes(
              'menü'
            ) ||
            d.aria.includes(
              'menu'
            ) ||
            d.aria.includes(
              'weitere'
            ) ||
            d.aria.includes(
              'more'
            ) ||
            d.title.includes(
              'menü'
            ) ||
            d.title.includes(
              'menu'
            ) ||
            d.title.includes(
              'weitere'
            ) ||
            d.title.includes(
              'more'
            ) ||
            d.testId.includes(
              'menu'
            ) ||
            d.testId.includes(
              'dropdown'
            ) ||
            d.dataIcon.includes(
              'down'
            ) ||
            d.dataIcon.includes(
              'chevron'
            ) ||
            d.html.includes(
              'data-icon="down"'
            ) ||
            d.html.includes(
              'data-icon="chevron'
            ) ||
            d.html.includes(
              'down-context'
            ) ||
            d.html.includes(
              'chevron-down'
            ) ||
            d.text ===
              '⌄' ||
            d.text ===
              '▼'
          );
        }


        document
          .querySelectorAll(
            '[data-bot-message-menu]'
          )
          .forEach(
            element =>
              element.removeAttribute(
                'data-bot-message-menu'
              )
          );


        const target =
          document.querySelector(
            `[data-bot-live-candidate="${candidateIndex}"]`
          );


        if (!target) {
          return {
            found: false,
            reason:
              'candidate-missing'
          };
        }


        let container =
          target;


        for (
          let depth = 0;
          depth < 12 &&
          container;
          depth++
        ) {
          const buttons =
            [
              ...container.querySelectorAll(
                'button,[role="button"],[aria-label],[title],[data-testid],[data-icon],[tabindex]'
              )
            ].filter(
              visible
            );


          for (
            const raw
            of buttons
          ) {
            const clickable =
              raw.closest(
                'button,[role="button"],[tabindex]'
              ) ||
              raw;


            if (
              visible(
                clickable
              ) &&
              looksLikeMenu(
                raw
              )
            ) {
              clickable.setAttribute(
                'data-bot-message-menu',
                'true'
              );


              return {
                found: true,
                mode:
                  'ancestor'
              };
            }
          }


          container =
            container.parentElement;
        }


        const globalElements =
          [
            ...document.querySelectorAll(
              'button,[role="button"],[aria-label],[title],[data-testid],[data-icon],[tabindex]'
            )
          ].filter(
            visible
          );


        const box =
          targetBox;


        const centerY =
          box.y +
          box.height /
            2;


        const nearby =
          [];


        for (
          const raw
          of globalElements
        ) {
          if (
            !looksLikeMenu(
              raw
            )
          ) {
            continue;
          }


          const clickable =
            raw.closest(
              'button,[role="button"],[tabindex]'
            ) ||
            raw;


          if (
            !visible(
              clickable
            )
          ) {
            continue;
          }


          const rect =
            clickable
              .getBoundingClientRect();


          const cy =
            rect.y +
            rect.height /
              2;


          const verticalDistance =
            Math.abs(
              cy -
              centerY
            );


          const horizontalOkay =
            rect.x >=
              box.x -
                80 &&
            rect.x <=
              box.x +
                box.width +
                120;


          const verticalOkay =
            verticalDistance <=
            Math.max(
              90,
              box.height *
                0.85
            );


          if (
            horizontalOkay &&
            verticalOkay
          ) {
            const dx =
              Math.abs(
                (
                  rect.x +
                  rect.width /
                    2
                ) -
                (
                  box.x +
                  box.width
                )
              );


            const score =
              verticalDistance +
              dx *
                0.35;


            nearby.push({
              clickable,
              score
            });
          }
        }


        nearby.sort(
          (
            a,
            b
          ) =>
            a.score -
            b.score
        );


        if (
          nearby.length
        ) {
          nearby[0]
            .clickable
            .setAttribute(
              'data-bot-message-menu',
              'true'
            );


          return {
            found: true,
            mode:
              'nearby'
          };
        }


        return {
          found: false,
          reason:
            'no-menu-near-message'
        };
      },

      {
        candidateIndex,

        targetBox: {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height
        }
      }
    );


  if (
    !menuMarked?.found
  ) {
    console.log(
      '⚠️ Nachrichtenmenü nicht gefunden:',
      menuMarked?.reason ||
      'unbekannt'
    );


    return false;
  }


  console.log(
    `✅ Nachrichtenmenü gefunden (${menuMarked.mode}).`
  );


  return true;
}


/*
============================================================
MENÜPUNKT "LÖSCHEN" FINDEN
============================================================
*/

async function markDeleteMenuItem(
  page
) {
  return await page.evaluate(
    () => {
      function visible(
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
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      }


      document
        .querySelectorAll(
          '[data-bot-delete-button]'
        )
        .forEach(
          element =>
            element.removeAttribute(
              'data-bot-delete-button'
            )
        );


      const elements =
        [
          ...document.querySelectorAll(
            '[role="menuitem"],button,[role="button"],[tabindex]'
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
}


/*
============================================================
AUSSCHLIESSLICH "FÜR ALLE LÖSCHEN" FINDEN
============================================================
*/

async function markDeleteForEveryoneButton(
  page
) {
  return await page.evaluate(
    () => {
      function visible(
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
          style.display !== 'none' &&
          style.visibility !== 'hidden'
        );
      }


      document
        .querySelectorAll(
          '[data-bot-delete-everyone]'
        )
        .forEach(
          element =>
            element.removeAttribute(
              'data-bot-delete-everyone'
            )
        );


      const dialogs =
        [
          ...document.querySelectorAll(
            '[role="dialog"]'
          )
        ].filter(
          visible
        );


      if (
        !dialogs.length
      ) {
        return {
          dialogFound: false,
          buttonFound: false
        };
      }


      const dialog =
        dialogs[
          dialogs.length - 1
        ];


      const buttons =
        [
          ...dialog.querySelectorAll(
            'button,[role="button"],[tabindex]'
          )
        ].filter(
          visible
        );


      const confirm =
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
        return {
          dialogFound: true,
          buttonFound: false
        };
      }


      confirm.setAttribute(
        'data-bot-delete-everyone',
        'true'
      );


      return {
        dialogFound: true,
        buttonFound: true
      };
    }
  );
}


/*
============================================================
EINE BOT-MELDUNG LÖSCHEN
============================================================
*/

async function deleteOneBotCandidate(
  page,
  candidateIndex
) {
  console.log(
    `🗑️ Löschversuch für Bot-Live-Kandidat ${candidateIndex}...`
  );


  const menuMarked =
    await markMenuButtonForCandidate(
      page,
      candidateIndex
    );


  if (!menuMarked) {
    console.log(
      '⚠️ Nachrichtenmenü wurde für diese Bot-Meldung nicht sicher gefunden.'
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
    1800
  );


  const deleteMarked =
    await markDeleteMenuItem(
      page
    );


  if (!deleteMarked) {
    console.log(
      '⚠️ Menüpunkt "Löschen" wurde nicht gefunden.'
    );


    try {
      await page.keyboard.press(
        'Escape'
      );
    } catch {}


    return false;
  }


  const deleteButton =
    await page.$(
      '[data-bot-delete-button="true"]'
    );


  if (!deleteButton) {
    return false;
  }


  await deleteButton.click({
    delay: 100
  });


  await sleep(
    1800
  );


  const confirmation =
    await markDeleteForEveryoneButton(
      page
    );


  if (
    !confirmation.dialogFound
  ) {
    console.log(
      '⚠️ Kein Lösch-Bestätigungsdialog gefunden.'
    );


    console.log(
      '🛑 Aus Sicherheitsgründen gilt die Löschung als NICHT bestätigt.'
    );


    return false;
  }


  if (
    !confirmation.buttonFound
  ) {
    console.log(
      '🛑 "Für alle löschen" wurde NICHT angeboten.'
    );


    console.log(
      '🛡️ Der Bot wählt NICHT "Nur für mich löschen".'
    );


    try {
      await page.keyboard.press(
        'Escape'
      );
    } catch {}


    return false;
  }


  const confirmButton =
    await page.$(
      '[data-bot-delete-everyone="true"]'
    );


  if (!confirmButton) {
    return false;
  }


  console.log(
    '✅ "Für alle löschen" eindeutig gefunden.'
  );


  await confirmButton.click({
    delay: 120
  });


  await sleep(
    4500
  );


  console.log(
    '🗑️ "Für alle löschen" ausgeführt.'
  );


  return true;
}


/*
============================================================
ALLE SICHTBAREN BOT-LIVE-MELDUNGEN LÖSCHEN
============================================================
*/

async function deleteBotLiveMessages(
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
    'Bot-Meldungen löschen'
  );


  console.log(
    '================================'
  );


  console.log(
    '🗑️ SUCHE BOT-LIVE-MELDUNG ZUM LÖSCHEN'
  );


  console.log(
    '================================'
  );


  await openWhatsAppChannel(
    page
  );


  let totalDeleted =
    0;


  for (
    let round = 1;
    round <= 10;
    round++
  ) {
    console.log(
      `🔎 Löschrunde ${round}/10 ...`
    );


    const candidates =
      await findBotLiveMessageCandidates(
        page
      );


    if (
      candidates.length === 0
    ) {
      console.log(
        '🔎 Keine weitere Bot-Live-Meldung gefunden.'
      );


      break;
    }


    const deleted =
      await deleteOneBotCandidate(
        page,
        0
      );


    if (!deleted) {
      console.log(
        '🛑 Löschung konnte nicht sicher abgeschlossen werden.'
      );


      break;
    }


    totalDeleted++;


    console.log(
      `✅ Bot-Live-Meldungen bisher für alle gelöscht: ${totalDeleted}`
    );


    await sleep(
      3000
    );
  }


  const remaining =
    await findBotLiveMessageCandidates(
      page
    );


  console.log(
    `🔎 Verbleibende Bot-Live-Meldungen: ${remaining.length}`
  );


  if (
    remaining.length > 0
  ) {
    console.log(
      '⚠️ Mindestens eine Bot-Live-Meldung ist noch sichtbar.'
    );


    return {
      success: false,
      deleted: totalDeleted,
      remaining:
        remaining.length
    };
  }


  if (
    totalDeleted === 0
  ) {
    console.log(
      'ℹ️ Keine passende Bot-Live-Meldung mehr vorhanden.'
    );


    console.log(
      '✅ Offline-Zustand kann zurückgesetzt werden.'
    );


    return {
      success: true,
      deleted: 0,
      remaining: 0
    };
  }


  console.log(
    '================================'
  );


  console.log(
    `✅ ${totalDeleted} BOT-LIVE-MELDUNG(EN) FÜR ALLE GELÖSCHT`
  );


  console.log(
    '🛡️ Andere Kanalbeiträge wurden nicht verändert.'
  );


  console.log(
    '================================'
  );


  return {
    success: true,
    deleted: totalDeleted,
    remaining: 0
  };
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


        /*
         * Repository öffentlich:
         * Kopplungscode NICHT ins Actions-Log schreiben.
         */

        client.on(
          'code',
          () => {
            console.log(
              '📱 WhatsApp benötigt einen neuen Kopplungscode.'
            );


            console.log(
              '🛡️ Kopplungscode wird nicht im öffentlichen Actions-Log ausgegeben.'
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


  const page =
    client.pupPage;


  assertPageAlive(
    page,
    'nach WhatsApp-Stabilisierung'
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
OFFLINE-BEHANDLUNG
============================================================
*/

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
      savedState.deletePending
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


  if (
    !shouldDelete
  ) {
    await resetOfflineState();


    console.log(
      '✅ Offline-Status zurückgesetzt.'
    );


    console.log(
      '➡️ Beim nächsten Live-Start darf wieder eine Meldung gesendet werden.'
    );


    return;
  }


  await markDeletePending();


  console.log(
    '🗑️ Bot-Live-Meldung soll entfernt werden.'
  );


  const store =
    createStore();


  try {
    const result =
      await startWhatsApp(
        store,

        async client =>
          await deleteBotLiveMessages(
            client
          )
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
        `🗑️ Für alle gelöschte Bot-Live-Meldungen: ${result.deleted}`
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
        `Löschung nicht vollständig. Verbleibend: ${result?.remaining ?? 'unbekannt'}`
      )
    );


    console.log(
      '⚠️ Bot-Live-Meldung konnte nicht vollständig gelöscht werden.'
    );


    console.log(
      '➡️ deletePending bleibt aktiv.'
    );


    console.log(
      '➡️ Ein späterer Offline-Lauf darf erneut versuchen.'
    );

  } catch (error) {
    await markDeletePending(
      error
    );


    console.error(
      '❌ Fehler beim Löschen der Bot-Live-Meldung:'
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


    console.error(
      '➡️ Ein späterer Offline-Lauf darf erneut versuchen.'
    );
  }
}


/*
============================================================
LIVE-BEHANDLUNG
============================================================
*/

async function handleLive(
  savedState
) {
  const oldLive =
    Boolean(
      savedState.live
    );


  if (
    savedState.deletePending
  ) {
    console.log(
      '⚠️ TikTok ist LIVE, aber eine alte Bot-Live-Meldung ist noch zur Löschung vorgemerkt.'
    );


    console.log(
      '🛑 Neue Live-Meldung wird in diesem Lauf nicht gesendet.'
    );


    console.log(
      '➡️ Erst muss die alte Bot-Meldung sauber entfernt werden.'
    );


    return;
  }


  if (
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


  console.log(
    '🔴 NEUER TIKTOK-LIVE-START ERKANNT!'
  );


  const claimed =
    await reserveLiveStart();


  if (
    !claimed
  ) {
    console.log(
      '✅ Ein anderer GitHub-Lauf hat diesen Live-Start bereits übernommen.'
    );


    console.log(
      '✅ Keine doppelte Nachricht.'
    );


    return;
  }


  console.log(
    '🔒 Live-Start für diesen Workflow reserviert.'
  );


  const store =
    createStore();


  try {
    const sentAt =
      await startWhatsApp(
        store,

        async client =>
          await sendLiveMessage(
            client
          )
      );


    await markSendSuccess(
      sentAt
    );


    console.log(
      '================================'
    );


    console.log(
      '🎉 LIVE-ALARM ERFOLGREICH'
    );


    console.log(
      '✅ Live-Meldung wurde im Kanal veröffentlicht.'
    );


    console.log(
      '🗑️ Beim Offline-Wechsel sucht der Bot ausschließlich nach seiner Live-Meldung.'
    );


    console.log(
      '🛡️ Manuelle andere Kanalbeiträge bleiben unangetastet.'
    );


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
      '⚠️ Live-Status bleibt absichtlich auf LIVE.'
    );


    console.error(
      '✅ Deshalb startet WhatsApp nicht jede Minute erneut.'
    );


    console.error(
      '================================'
    );


    throw error;
  }
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
    '================================'
  );


  console.log(
    '🚀 JORNE WHATSAPP LIVE-BOT STARTET'
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

        whatsappError:
          savedState.whatsappError ||
          null
      },

      null,

      2
    )
  );


  if (
    !currentLive
  ) {
    await handleOffline(
      savedState
    );


    return;
  }


  await handleLive(
    savedState
  );
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
        '================================'
      );


      console.log(
        '✅ Live-Check abgeschlossen.'
      );


      console.log(
        '================================'
      );


      process.exit(
        0
      );
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


      process.exit(
        1
      );
    }
  );
