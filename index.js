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

const TIKTOK_CHECK_INTERVAL_MS =
  60 * 1000;

const TIKTOK_TIMEOUT_MS =
  20 * 1000;


let whatsappReady = false;

let liveCheckRunning = false;

let monitorStarted = false;

let sendRunning = false;


/*
============================================================
MONGODB LIVE-STATUS
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
  mongoose.model(
    'TikTokState',
    TikTokStateSchema
  );


async function getSavedLiveState() {

  const state =
    await TikTokState
      .findOne({
        username:
          TIKTOK_USERNAME
      })
      .lean();


  if (!state) {
    return false;
  }


  return Boolean(
    state.live
  );
}


async function saveLiveState(
  live
) {

  await TikTokState.updateOne(
    {
      username:
        TIKTOK_USERNAME
    },

    {
      $set: {
        live:
          Boolean(live),

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
WARTEFUNKTION
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
  milliseconds
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
                  `TikTok antwortet nach ${milliseconds / 1000} Sekunden nicht.`
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
TIKTOK LIVE-STATUS ABFRAGEN
============================================================
*/

async function checkTikTokLive() {

  /*
   * tiktok-live-connector wird dynamisch geladen,
   * damit unser bestehender CommonJS-Code mit
   * require(...) unverändert funktionieren kann.
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


    const isLive =
      await withTimeout(
        connection.fetchIsLive(),
        TIKTOK_TIMEOUT_MS
      );


    console.log(
      `📡 TikTok-Status: ${isLive ? 'LIVE 🔴' : 'offline ⚫'}`
    );


    return Boolean(
      isLive
    );

  } finally {

    try {

      await connection.disconnect();

    } catch {

      /*
       * Falls keine aktive Verbindung besteht,
       * gibt es nichts zu trennen.
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
            style.display !==
              'none' &&
            style.visibility !==
              'hidden'
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
            ]
              .find(
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
          ]
            .filter(
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
                  text ===
                    'ok' ||
                  text ===
                    'okay' ||
                  text ===
                    'verstanden' ||
                  text ===
                    'fertig' ||
                  text ===
                    'weiter' ||
                  text ===
                    'nicht jetzt'
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

    console.log(
      '✅ WhatsApp-Popup geschlossen.'
    );


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


      console.log(
        '⌨️ ESC zum Schließen des Popups gedrückt.'
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
          style.display !==
            'none' &&
          style.visibility !==
            'hidden'
        );
      }


      const channelNameLower =
        channelName
          .toLowerCase();


      const elements =
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


      const matchingElements =
        elements
          .map(
            element => {

              const rect =
                element
                  .getBoundingClientRect();


              return {

                tag:
                  element.tagName,

                aria:
                  element.getAttribute(
                    'aria-label'
                  ),

                testId:
                  element.getAttribute(
                    'data-testid'
                  ),

                role:
                  element.getAttribute(
                    'role'
                  ),

                left:
                  Math.round(
                    rect.left
                  ),

                top:
                  Math.round(
                    rect.top
                  ),

                width:
                  Math.round(
                    rect.width
                  ),

                height:
                  Math.round(
                    rect.height
                  ),

                text:
                  (
                    element.textContent ||
                    ''
                  )
                    .replace(
                      /\s+/g,
                      ' '
                    )
                    .trim()
                    .slice(
                      0,
                      300
                    )
              };
            }
          )
          .filter(
            item => {

              const combined =
                [
                  item.aria,
                  item.testId,
                  item.text
                ]
                  .filter(
                    Boolean
                  )
                  .join(
                    ' '
                  )
                  .toLowerCase();


              return (
                combined.includes(
                  channelNameLower
                ) ||
                combined.includes(
                  'newsletter'
                ) ||
                combined.includes(
                  'kanalinfo'
                ) ||
                combined.includes(
                  'kanal-info'
                )
              );
            }
          )
          .slice(
            0,
            30
          );


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


      const channelNameVisibleRight =
        matchingElements.some(
          item =>
            (
              item.text ||
              ''
            )
              .toLowerCase()
              .includes(
                channelNameLower
              )
        );


      return {

        emptyState,

        channelNameVisibleRight,

        matchingElements
      };
    },

    CHANNEL_NAME
  );
}


/*
============================================================
KANAL ÖFFNEN
============================================================
*/

async function openWhatsAppChannel(
  page
) {

  /*
  ----------------------------------------------------------
  KANÄLE-BEREICH FINDEN
  ----------------------------------------------------------
  */

  console.log(
    '🔎 Suche Bereich "Kanäle"...'
  );


  const channelAreaResult =
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
          ]
            .filter(
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
                  testId ===
                    'newsletter-tab-drawer' ||
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

          target =
            elements.find(
              element => {

                const html =
                  (
                    element.innerHTML ||
                    ''
                  )
                    .toLowerCase();


                return (
                  html.includes(
                    'wds-ic-channels'
                  ) ||
                  html.includes(
                    'ic-channels'
                  )
                );
              }
            );
        }


        if (!target) {

          return {
            found: false
          };
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


        return {
          found: true
        };
      }
    );


  if (
    !channelAreaResult.found
  ) {

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
  JORNE_L1VE FINDEN
  ----------------------------------------------------------
  */

  console.log(
    `🔎 Suche Kanal "${CHANNEL_NAME}"...`
  );


  const channelResult =
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


        function getInfo(
          element
        ) {

          const rect =
            element
              .getBoundingClientRect();


          return {

            aria:
              element.getAttribute(
                'aria-label'
              ),

            testId:
              element.getAttribute(
                'data-testid'
              ),

            text:
              (
                element.textContent ||
                ''
              )
                .replace(
                  /\s+/g,
                  ' '
                )
                .trim()
                .slice(
                  0,
                  250
                ),

            width:
              Math.round(
                rect.width
              ),

            height:
              Math.round(
                rect.height
              ),

            left:
              Math.round(
                rect.left
              ),

            top:
              Math.round(
                rect.top
              )
          };
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
          ]
            .filter(
              isVisible
            );


        let target =
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
                aria.includes(
                  wanted
                ) ||
                text.includes(
                  wanted
                )
              );
            }
          );


        if (!target) {

          return {
            found: false
          };
        }


        const info =
          getInfo(
            target
          );


        if (
          info.width >
            700 ||
          info.height >
            300 ||
          info.left >
            window.innerWidth *
              0.55
        ) {

          return {
            found: false,
            rejected: info
          };
        }


        target.setAttribute(
          'data-bot-channel-target',
          'true'
        );


        return {
          found: true,
          selected: info
        };
      },

      CHANNEL_NAME
    );


  console.log(
    '📺 Kanal-Suche:',
    channelResult
  );


  if (
    !channelResult.found
  ) {

    throw new Error(
      `Kanal "${CHANNEL_NAME}" wurde nicht sicher gefunden.`
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
      'Keine Klickposition für Kanal verfügbar.'
    );
  }


  /*
   * Echter Maus-Klick –
   * genau diese Variante hat unseren
   * erfolgreichen BOT-TEST veröffentlicht.
   */

  await page.mouse.move(
    box.x +
      box.width / 2,

    box.y +
      box.height / 2
  );


  await sleep(
    300
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


  await closeWhatsAppPopup(
    page
  );


  await sleep(
    2000
  );


  /*
   * Prüfen, ob die rechte Kanalansicht
   * tatsächlich gewechselt hat.
   */

  let channelCheck =
    await inspectRightChannelArea(
      page
    );


  console.log(
    '🔍 Kanalansicht:',
    channelCheck
  );


  if (
    channelCheck.emptyState &&
    !channelCheck.channelNameVisibleRight
  ) {

    console.log(
      '🔁 Zweiter Klick auf den Kanal...'
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


    channelCheck =
      await inspectRightChannelArea(
        page
      );
  }


  if (
    channelCheck.emptyState &&
    !channelCheck.channelNameVisibleRight
  ) {

    throw new Error(
      `Kanal "${CHANNEL_NAME}" wurde links gefunden, aber rechts nicht geöffnet.`
    );
  }


  console.log(
    `✅ Kanal "${CHANNEL_NAME}" ist tatsächlich geöffnet.`
  );


  await sleep(
    3000
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
              'hidden' &&
            style.opacity !==
              '0'
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
         * Bevorzugt direkt das Feld,
         * das beim erfolgreichen Test
         * verwendet wurde.
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
            ]
              .filter(
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


                const search =
                  aria.includes(
                    'suchen'
                  ) ||
                  placeholder.includes(
                    'suchen'
                  );


                return (
                  !search &&
                  rect.left >
                    500 &&
                  rect.width >
                    100
                );
              }
            );
        }


        if (!target) {

          return {
            found: false
          };
        }


        target.setAttribute(
          'data-bot-composer',
          'true'
        );


        return {
          found: true,

          testId:
            target.getAttribute(
              'data-testid'
            ),

          aria:
            target.getAttribute(
              'aria-label'
            )
        };
      }
    );


  console.log(
    '📝 Composer:',
    result
  );


  if (
    !result.found
  ) {

    throw new Error(
      'Meldungsfeld wurde nicht gefunden.'
    );
  }
}


/*
============================================================
WHATSAPP-NACHRICHT SENDEN
============================================================
*/

async function sendWhatsAppLiveMessage(
  client
) {

  if (sendRunning) {

    throw new Error(
      'WhatsApp-Sendevorgang läuft bereits.'
    );
  }


  sendRunning =
    true;


  try {

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
        'Markiertes Meldungsfeld konnte nicht wiedergefunden werden.'
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


    await page.keyboard.type(
      LIVE_MESSAGE,

      {
        delay: 30
      }
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
      '📤 ENTER gedrückt.'
    );


    await sleep(
      4000
    );


    const visible =
      await page.evaluate(
        expected => {

          return [
            ...document.querySelectorAll(
              '*'
            )
          ]
            .some(
              element =>
                (
                  element.textContent ||
                  ''
                )
                  .trim() ===
                expected
            );
        },

        LIVE_MESSAGE
      );


    if (
      !visible
    ) {

      throw new Error(
        'Live-Meldung wurde nach ENTER nicht eindeutig in WhatsApp gefunden.'
      );
    }


    console.log(
      '🎉 LIVE-MELDUNG ERFOLGREICH IM WHATSAPP-KANAL!'
    );


    return true;

  } finally {

    sendRunning =
      false;
  }
}


/*
============================================================
EINEN LIVE-CHECK AUSFÜHREN
============================================================
*/

async function runLiveCheck(
  client
) {

  if (
    liveCheckRunning
  ) {

    console.log(
      '⏳ Vorheriger TikTok-Check läuft noch.'
    );


    return;
  }


  liveCheckRunning =
    true;


  try {

    if (
      !whatsappReady
    ) {

      console.log(
        '⏳ WhatsApp ist noch nicht bereit.'
      );


      return;
    }


    let currentLive;


    try {

      currentLive =
        await checkTikTokLive();

    } catch (error) {

      if (
        error.name ===
          'TimeoutError'
      ) {

        console.warn(
          error.message
        );


        console.warn(
          '⚠️ Dieser TikTok-Check wird übersprungen.'
        );


        return;
      }


      throw error;
    }


    const oldLive =
      await getSavedLiveState();


    console.log(
      `🗄️ Gespeicherter TikTok-Status: ${oldLive ? 'LIVE' : 'offline'}`
    );


    /*
    ----------------------------------------------------------
    OFFLINE → LIVE
    ----------------------------------------------------------
    */

    if (
      currentLive &&
      !oldLive
    ) {

      console.log(
        '🔴 NEUER LIVE-START ERKANNT!'
      );


      /*
       * Erst WhatsApp senden.
       * Nur wenn das klappt, speichern wir LIVE.
       */

      await sendWhatsAppLiveMessage(
        client
      );


      await saveLiveState(
        true
      );


      console.log(
        '✅ LIVE-Status in MongoDB gespeichert.'
      );


      return;
    }


    /*
    ----------------------------------------------------------
    LIVE → LIVE
    ----------------------------------------------------------
    */

    if (
      currentLive &&
      oldLive
    ) {

      console.log(
        '🔴 Jorne ist weiterhin LIVE.'
      );


      console.log(
        '✅ Keine zweite WhatsApp-Nachricht erforderlich.'
      );


      return;
    }


    /*
    ----------------------------------------------------------
    LIVE → OFFLINE
    ----------------------------------------------------------
    */

    if (
      !currentLive &&
      oldLive
    ) {

      console.log(
        '⚫ Jorne ist jetzt OFFLINE.'
      );


      await saveLiveState(
        false
      );


      console.log(
        '✅ Status zurückgesetzt.'
      );


      console.log(
        '➡️ Beim nächsten Live-Start wird wieder eine Nachricht gesendet.'
      );


      return;
    }


    /*
    ----------------------------------------------------------
    OFFLINE → OFFLINE
    ----------------------------------------------------------
    */

    console.log(
      '⚫ Jorne ist weiterhin offline.'
    );


    console.log(
      '✅ Keine WhatsApp-Nachricht erforderlich.'
    );

  } catch (error) {

    console.error(
      '❌ Fehler beim TikTok-Live-Check:',
      error
    );

  } finally {

    liveCheckRunning =
      false;
  }
}


/*
============================================================
TIKTOK-MONITOR STARTEN
============================================================
*/

async function startTikTokMonitor(
  client
) {

  if (
    monitorStarted
  ) {

    return;
  }


  monitorStarted =
    true;


  console.log(
    '================================'
  );


  console.log(
    '👀 TIKTOK-LIVE-MONITOR GESTARTET'
  );


  console.log(
    `👤 Account: @${TIKTOK_USERNAME}`
  );


  console.log(
    '⏱️ Prüfung: alle 60 Sekunden'
  );


  console.log(
    `📢 WhatsApp-Kanal: ${CHANNEL_NAME}`
  );


  console.log(
    '================================'
  );


  /*
   * Sofort erster Check.
   */

  await runLiveCheck(
    client
  );


  /*
   * Danach jede Minute.
   */

  setInterval(
    () => {

      runLiveCheck(
        client
      )
        .catch(
          error => {

            console.error(
              '❌ Intervall-Check fehlgeschlagen:',
              error
            );
          }
        );

    },

    TIKTOK_CHECK_INTERVAL_MS
  );
}


/*
============================================================
BOT START
============================================================
*/

async function startBot() {

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
   * RemoteAuth-Ordner.
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


  /*
   * MongoDB.
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
   * Store.
   */

  const store =
    new FixedMongoStore({

      mongoose,

      dataPath:
        AUTH_DATA_PATH
    });


  /*
   * Gespeicherte WhatsApp-Sitzung prüfen.
   */

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
      '⚠️ Sitzungsstatus konnte nicht geprüft werden:',
      error.message
    );
  }


  /*
   * WhatsApp-Client.
   */

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


  /*
  ------------------------------------------------------------
  WHATSAPP EVENTS
  ------------------------------------------------------------
  */


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
    'authenticated',

    () => {

      console.log(
        '✅ WhatsApp erfolgreich angemeldet.'
      );
    }
  );


  client.on(
    'ready',

    async () => {

      console.log(
        '✅ WhatsApp READY-Event erhalten.'
      );


      /*
       * WhatsApp nach READY fertig laden lassen.
       */

      await sleep(
        7000
      );


      try {

        const state =
          await client.getState();


        console.log(
          '📡 WhatsApp-Status nach READY:',
          state
        );


        if (
          state ===
            'CONNECTED'
        ) {

          whatsappReady =
            true;


          console.log(
            '✅ WhatsApp-Bot ist bereit.'
          );


          await startTikTokMonitor(
            client
          );

        } else {

          console.log(
            '⏳ WhatsApp ist noch nicht CONNECTED.'
          );
        }

      } catch (error) {

        console.error(
          '❌ READY-Prüfung fehlgeschlagen:',
          error
        );
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


      if (
        state ===
          'CONNECTED'
      ) {

        whatsappReady =
          true;


        /*
         * Falls READY nicht sauber kam,
         * trotzdem Monitor starten.
         */

        if (
          !monitorStarted
        ) {

          setTimeout(
            () => {

              startTikTokMonitor(
                client
              )
                .catch(
                  error => {

                    console.error(
                      '❌ TikTok-Monitor konnte nicht gestartet werden:',
                      error
                    );
                  }
                );

            },

            5000
          );
        }

      } else {

        whatsappReady =
          false;
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


  client.on(
    'auth_failure',

    message => {

      whatsappReady =
        false;


      console.error(
        '❌ WhatsApp-Anmeldung fehlgeschlagen:',
        message
      );
    }
  );


  client.on(
    'disconnected',

    reason => {

      whatsappReady =
        false;


      console.log(
        '⚠️ WhatsApp getrennt:',
        reason
      );
    }
  );


  /*
   * WhatsApp starten.
   */

  console.log(
    '🚀 WhatsApp wird gestartet...'
  );


  await client.initialize();
}


/*
============================================================
START
============================================================
*/

startBot()
  .catch(
    error => {

      console.error(
        '❌ STARTFEHLER:'
      );


      console.error(
        error
      );


      process.exit(
        1
      );
    }
  );
