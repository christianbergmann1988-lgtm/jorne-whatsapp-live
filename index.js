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
 * Wie lange WhatsApp nach READY stabil sein soll,
 * bevor wir die Kanaloberfläche bedienen.
 */
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

      /*
       * Nur zur Diagnose.
       */
      whatsappSent: {
        type: Boolean,
        default: false
      },

      whatsappError: {
        type: String,
        default: null
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
        whatsappSent: false,
        whatsappError: null,
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

async function setWhatsAppSuccess() {

  await TikTokState.updateOne(
    {
      username: TIKTOK_USERNAME
    },

    {
      $set: {
        live: true,
        whatsappSent: true,
        whatsappError: null,
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
WHATSAPP-FEHLER SPEICHERN

WICHTIG:
LIVE BLEIBT TRUE.

Damit wird NICHT jede Minute erneut WhatsApp gestartet.
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
        live: true,
        whatsappSent: false,
        whatsappError:
          String(
            error?.message ||
            error
          ),
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
PRÜFEN, OB PUPPETEER NOCH LEBT
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

      if (stableSince) {

        console.log(
          '⚠️ WhatsApp wurde während der Stabilitätsprüfung kurz instabil.'
        );
      }


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
                aria === 'close' ||
                testId.includes(
                  'close'
                ) ||
                text === 'schließen' ||
                text === 'close' ||
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


  assertPageAlive(
    page,
    'Kanäle-Button klicken'
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


  assertPageAlive(
    page,
    'nach Kanäle-Klick'
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
      'Keine Klickposition für Jorne_L1ve verfügbar.'
    );
  }


  assertPageAlive(
    page,
    'Kanal anklicken'
  );


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


  assertPageAlive(
    page,
    'nach Kanal-Klick'
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

        assertPageAlive(
          page,
          'zweiter Kanal-Klick'
        );


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
    'Sendevorgang starten'
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


  assertPageAlive(
    page,
    'Composer anklicken'
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


  assertPageAlive(
    page,
    'Meldung absenden'
  );


  await page.keyboard.press(
    'Enter'
  );


  console.log(
    '📤 ENTER gedrückt.'
  );


  await sleep(
    5000
  );


  assertPageAlive(
    page,
    'nach dem Absenden'
  );


  const visible =
    await page.evaluate(
      message => {

        const wanted =
          String(
            message
          )
            .replace(
              /\s+/g,
              ' '
            )
            .trim();


        return [
          ...document.querySelectorAll(
            '*'
          )
        ].some(
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
                .trim();


            return (
              text === wanted ||
              text.includes(
                'Jorne ist jetzt LIVE auf TikTok!'
              )
            );
          }
        );
      },

      LIVE_MESSAGE
    );


  console.log(
    visible
      ?
      '✅ Live-Meldung ist in der WhatsApp-Oberfläche sichtbar.'
      :
      '⚠️ Meldung wurde nicht eindeutig in der Oberfläche wiedergefunden.'
  );


  console.log(
    '🎉 WhatsApp-Sendevorgang abgeschlossen.'
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

            /*
             * READY kann mehrfach kommen.
             * Das ist okay.
             */

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


  /*
   * WICHTIG:
   * initialize() nicht einfach verschwinden lassen.
   */

  const initializePromise =
    client.initialize();


  await withTimeout(

    readyPromise,

    WHATSAPP_READY_TIMEOUT_MS,

    'WhatsApp wurde innerhalb von 90 Sekunden nicht READY.'
  );


  /*
   * Nach READY nicht sofort loslegen.
   * Erst auf eine wirklich stabile Seite warten.
   */

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
    '✅ WhatsApp Web ist bereit für den Sendeversuch.'
  );


  try {

    await sendLiveMessage(
      client
    );

  } finally {

    /*
     * Nur kurz warten.
     * Der eigentliche Beitrag wurde bereits abgesendet.
     */

    await sleep(
      2500
    );


    /*
     * initialize() kann intern noch etwas nacharbeiten.
     * Wir verhindern hier einen unhandled rejection.
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
}


/*
============================================================
EINMALIGER GITHUB-CHECK
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
        '➡️ Beim nächsten Live-Start darf wieder genau eine WhatsApp-Meldung ausgelöst werden.'
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
      '✅ Kein weiterer WhatsApp-Sendeversuch.'
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


    console.log(
      '✅ Keine doppelte Nachricht.'
    );


    return;
  }


  console.log(
    '🔒 Live-Start für diesen Workflow reserviert.'
  );


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


  try {

    await startWhatsAppAndSend(
      store
    );


    await setWhatsAppSuccess();


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
     * GANZ WICHTIG:
     *
     * Wir setzen LIVE hier NICHT wieder auf OFFLINE.
     *
     * Sonst würde der Cronjob jede Minute WhatsApp erneut
     * öffnen und du bekämst wieder ständig Benachrichtigungen.
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
      '⚠️ Live-Status bleibt absichtlich auf LIVE.'
    );


    console.error(
      '✅ Deshalb wird dieser Live-Start NICHT jede Minute erneut ausgelöst.'
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
