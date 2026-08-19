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

const CLIENT_ID = 'jorne-whatsapp-live';

const AUTH_DATA_PATH =
  path.resolve('./.wwebjs_auth');

const TIKTOK_TIMEOUT_MS = 20000;

const WHATSAPP_READY_TIMEOUT_MS = 90000;


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


async function getSavedLiveState() {

  const state =
    await TikTokState
      .findOne({
        username: TIKTOK_USERNAME
      })
      .lean();


  return Boolean(
    state?.live
  );
}


/*
============================================================
OFFLINE SPEICHERN
============================================================
*/

async function setOfflineState() {

  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: {
        live: false,
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
LIVE-START ATOMAR RESERVIEREN

Verhindert möglichst, dass zwei gleichzeitig gestartete
GitHub-Runs dieselbe LIVE-Meldung doppelt schicken.
============================================================
*/

async function claimNewLiveStart() {

  /*
   * Existierenden OFFLINE-Eintrag auf LIVE setzen.
   */

  const result =
    await TikTokState.findOneAndUpdate(
      {
        username: TIKTOK_USERNAME,
        live: false
      },

      {
        $set: {
          live: true,
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


  /*
   * Vielleicht existiert noch gar kein Eintrag.
   */

  const existing =
    await TikTokState
      .findOne({
        username: TIKTOK_USERNAME
      })
      .lean();


  if (existing) {

    /*
     * Bereits LIVE gespeichert.
     */

    return false;
  }


  /*
   * Erster Eintrag überhaupt.
   */

  try {

    await TikTokState.create({
      username: TIKTOK_USERNAME,
      live: true,
      changedAt: new Date()
    });


    return true;

  } catch (error) {

    /*
     * Falls gleichzeitig ein zweiter Run
     * denselben Eintrag angelegt hat.
     */

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
HILFSFUNKTION
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


/*
============================================================
TIMEOUT
============================================================
*/

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

  /*
   * tiktok-live-connector wird dynamisch geladen,
   * weil unsere Datei CommonJS verwendet.
   */

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

    } catch {

      /*
       * Keine aktive Verbindung.
       */
    }
  }
}


/*
============================================================
WHATSAPP-POPUP SCHLIESSEN
============================================================
*/

async function closeWhatsAppPopup(
  page
) {

  console.log(
    '🔎 Prüfe auf WhatsApp-Popup...'
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


              const testId =
                (
                  element.getAttribute(
                    'data-testid'
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
                testId.includes(
                  'close'
                ) ||
                text ===
                  'schließen' ||
                text ===
                  'close' ||
                html.includes(
                  'ic-close'
                ) ||
                html.includes(
                  'wds-ic-close'
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


  console.log(
    '🪟 Popup-Prüfung:',
    result
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
            [
              '[data-testid]',
              '[aria-label]',
              '[role]',
              'header',
              'main',
              'section',
              'div'
            ].join(',')
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

  console.log(
    '🔎 Suche Bereich "Kanäle"...'
  );


  /*
  ----------------------------------------------------------
  KANÄLE-BUTTON MARKIEREN
  ----------------------------------------------------------
  */

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


  /*
  ----------------------------------------------------------
  JORNE_L1VE MARKIEREN
  ----------------------------------------------------------
  */

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
      'Keine Klickposition für Jorne_L1ve verfügbar.'
    );
  }


  /*
   * Echter Maus-Klick.
   * Genau damit hat unser Test funktioniert.
   */

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


  /*
   * Falls erster Klick nicht reicht,
   * genau einmal erneut klicken.
   */

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


        /*
         * Beim erfolgreichen Test wurde
         * dieses data-testid erkannt.
         */

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


        /*
         * Fallback.
         */

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
MEHRZEILIGE MELDUNG EINGEBEN
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

      /*
       * Zeilenumbruch ohne Absenden.
       */

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


  if (!page) {

    throw new Error(
      'Puppeteer-Seite wurde nicht gefunden.'
    );
  }


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
      'Markiertes Meldungsfeld wurde nicht wiedergefunden.'
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


  /*
   * Erst jetzt wirklich absenden.
   */

  await page.keyboard.press(
    'Enter'
  );


  console.log(
    '📤 ENTER gedrückt.'
  );


  await sleep(
    4000
  );


  console.log(
    '🎉 WhatsApp-Live-Meldung wurde abgesendet.'
  );
}


/*
============================================================
WHATSAPP STARTEN UND AUF READY WARTEN
============================================================
*/

async function startWhatsAppAndSend(
  store
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

          '--window-size=1365,900'
        ],

        defaultViewport: {

          width: 1365,

          height: 900
        }
      }
    });


  const readyPromise =
    new Promise(
      (
        resolve,
        reject
      ) => {

        let resolved =
          false;


        const finishReady =
          () => {

            if (resolved) {
              return;
            }


            resolved =
              true;


            resolve();
          };


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


            finishReady();
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
              state ===
              'CONNECTED'
            ) {

              /*
               * Bei uns kam CONNECTED teilweise
               * auch ohne READY zuverlässig.
               */

              setTimeout(
                finishReady,
                3000
              );
            }
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

            if (!resolved) {

              reject(
                new Error(
                  `WhatsApp wurde getrennt: ${reason}`
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


  /*
   * Initialisierung im Hintergrund starten.
   */

  client
    .initialize()
    .catch(
      error => {

        console.error(
          '❌ WhatsApp-Initialisierung:',
          error
        );
      }
    );


  /*
   * Maximal 90 Sekunden warten.
   */

  await withTimeout(

    readyPromise,

    WHATSAPP_READY_TIMEOUT_MS,

    'WhatsApp wurde innerhalb von 90 Sekunden nicht bereit.'
  );


  /*
   * Sicherstellen, dass CONNECTED.
   */

  let state =
    null;


  for (
    let attempt = 1;
    attempt <= 10;
    attempt++
  ) {

    try {

      state =
        await client.getState();

    } catch {}


    if (
      state === 'CONNECTED'
    ) {

      break;
    }


    await sleep(
      2000
    );
  }


  if (
    state !== 'CONNECTED'
  ) {

    try {
      await client.destroy();
    } catch {}


    throw new Error(
      `WhatsApp ist nach dem Start nicht CONNECTED: ${state}`
    );
  }


  console.log(
    '✅ WhatsApp ist CONNECTED.'
  );


  /*
   * Oberfläche kurz stabilisieren.
   */

  await sleep(
    4000
  );


  try {

    await sendLiveMessage(
      client
    );

  } finally {

    /*
     * Dieser GitHub-Run soll danach ENDEN.
     */

    await sleep(
      3000
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
}


/*
============================================================
EINMALIGER GITHUB-CHECK
============================================================
*/

async function main() {

  /*
   * Secrets.
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
   * TikTok genau EINMAL prüfen.
   */

  const currentLive =
    await checkTikTokLive();


  const oldLive =
    await getSavedLiveState();


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

    if (
      oldLive
    ) {

      await setOfflineState();


      console.log(
        '⚫ Jorne ist wieder offline.'
      );


      console.log(
        '✅ Status wurde zurückgesetzt.'
      );


      console.log(
        '➡️ Beim nächsten Live-Start wird wieder eine WhatsApp-Meldung gesendet.'
      );

    } else {

      console.log(
        '⚫ Jorne ist weiterhin offline.'
      );


      console.log(
        '✅ Keine WhatsApp-Nachricht erforderlich.'
      );
    }


    return;
  }


  /*
  ==========================================================
  LIVE
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
      '✅ Die Live-Meldung wurde bereits ausgelöst.'
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


  /*
   * LIVE atomar reservieren.
   *
   * Falls zwischenzeitlich ein anderer GitHub-Run
   * schneller war, wird hier false geliefert.
   */

  const claimed =
    await claimNewLiveStart();


  if (!claimed) {

    console.log(
      '✅ Ein anderer Lauf hat diesen Live-Start bereits übernommen.'
    );


    console.log(
      '✅ Keine doppelte Nachricht.'
    );


    return;
  }


  console.log(
    '🔒 Live-Start für diesen Workflow reserviert.'
  );


  /*
   * WhatsApp-Store.
   */

  fs.mkdirSync(
    AUTH_DATA_PATH,
    {
      recursive: true
    }
  );


  const store =
    new FixedMongoStore({

      mongoose,

      dataPath:
        AUTH_DATA_PATH
    });


  try {

    const exists =
      await store.sessionExists({

        session:
          `RemoteAuth-${CLIENT_ID}`
      });


    console.log(
      '🗄️ Gespeicherte WhatsApp-Sitzung vorhanden:',
      exists
    );

  } catch (error) {

    console.log(
      '⚠️ WhatsApp-Sitzungsstatus konnte nicht geprüft werden:',
      error.message
    );
  }


  /*
   * WhatsApp nur bei NEUEM LIVE starten.
   */

  try {

    await startWhatsAppAndSend(
      store
    );


    console.log(
      '================================'
    );


    console.log(
      '🎉 LIVE-ALARM ERFOLGREICH ABGESCHLOSSEN'
    );


    console.log(
      '================================'
    );

  } catch (error) {

    /*
     * Senden fehlgeschlagen:
     * LIVE wieder freigeben, damit der nächste
     * Minuten-Run einen neuen Versuch machen kann.
     */

    await setOfflineState();


    console.error(
      '❌ WhatsApp-Live-Meldung fehlgeschlagen.'
    );


    console.error(
      '➡️ LIVE-Status wurde wieder freigegeben, damit der nächste Run erneut versucht.'
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
