const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const CHANNEL_NAME = 'Jorne_L1ve';
const TEST_MESSAGE = 'BOT-TEST AUTOMATISCH UI';

const CLIENT_ID = 'jorne-whatsapp-live';
const AUTH_DATA_PATH = path.resolve('./.wwebjs_auth');

let testStarted = false;
let testRunning = false;


/*
============================================================
REMOTEAUTH + MONGODB FIX
============================================================
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

    const documents =
      await bucket
        .find({
          filename: `${session}.zip`
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


/*
============================================================
WARTEFUNKTION
============================================================
*/

function sleep(ms) {
  return new Promise(
    resolve => setTimeout(resolve, ms)
  );
}


/*
============================================================
WHATSAPP-POPUP SCHLIESSEN
============================================================
*/

async function closeWhatsAppPopup(page) {

  console.log(
    '🔎 Prüfe auf WhatsApp-Popup...'
  );

  const result =
    await page.evaluate(() => {

      function isVisible(element) {
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


      function getText(element) {
        return (
          element?.textContent ||
          ''
        )
          .replace(/\s+/g, ' ')
          .trim();
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


      const popupText =
        getText(popup)
          .slice(
            0,
            500
          );


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
                ) || ''
              )
                .trim()
                .toLowerCase();

            const testId =
              (
                element.getAttribute(
                  'data-testid'
                ) || ''
              )
                .trim()
                .toLowerCase();

            const text =
              getText(element)
                .toLowerCase();

            return (
              aria === 'schließen' ||
              aria === 'close' ||
              aria.includes(
                'schließen'
              ) ||
              testId.includes(
                'close'
              ) ||
              text === 'schließen' ||
              text === 'close'
            );
          }
        );


      if (!closeButton) {
        closeButton =
          candidates.find(
            element => {

              const content =
                (
                  element.innerHTML ||
                  ''
                )
                  .toLowerCase();

              return (
                content.includes(
                  'ic-close'
                ) ||
                content.includes(
                  'wds-ic-close'
                )
              );
            }
          );
      }


      if (!closeButton) {
        closeButton =
          candidates.find(
            element => {

              const text =
                getText(element)
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
          closed: false,
          text: popupText
        };
      }


      try {
        closeButton.click();

        return {
          found: true,
          closed: true,
          text: popupText,
          buttonText:
            getText(
              closeButton
            ),
          buttonAria:
            closeButton.getAttribute(
              'aria-label'
            )
        };

      } catch (error) {

        return {
          found: true,
          closed: false,
          text: popupText,
          error:
            String(
              error?.message ||
              error
            )
        };
      }
    });


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

    await sleep(2500);

    return true;
  }


  if (
    result.found &&
    !result.closed
  ) {
    console.log(
      '⚠️ Popup erkannt, aber kein geeigneter Schließen-Button gefunden.'
    );

    try {
      await page.keyboard.press(
        'Escape'
      );

      await sleep(2000);

      console.log(
        '⌨️ ESC zum Schließen des Popups gedrückt.'
      );

    } catch (error) {
      console.log(
        '⚠️ ESC konnte nicht ausgeführt werden:',
        error.message
      );
    }

    return true;
  }


  console.log(
    '✅ Kein störendes WhatsApp-Popup sichtbar.'
  );

  return false;
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

      function isVisible(element) {
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


      const rightSideElements =
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
                element.getBoundingClientRect();

              return (
                rect.left >
                window.innerWidth * 0.32
              );
            }
          );


      const channelNameLower =
        channelName.toLowerCase();


      const matchingElements =
        rightSideElements
          .map(
            element => {

              const rect =
                element.getBoundingClientRect();

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
                  .filter(Boolean)
                  .join(' ')
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
              ) &&
            item.left >
              window.innerWidth *
                0.32
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
KANAL-UI-TEST
============================================================
*/

async function runChannelUITest(
  client,
  reason
) {

  if (
    testStarted ||
    testRunning
  ) {
    return;
  }


  testRunning = true;


  console.log(
    '================================'
  );

  console.log(
    '🚀 STARTE WHATSAPP-KANAL-UI-TEST'
  );

  console.log(
    'Auslöser:',
    reason
  );

  console.log(
    '================================'
  );


  try {

    /*
    ----------------------------------------------------------
    STATUS
    ----------------------------------------------------------
    */

    const state =
      await client.getState();


    console.log(
      '📡 WhatsApp-Status:',
      state
    );


    if (
      state !== 'CONNECTED'
    ) {
      console.log(
        '❌ WhatsApp ist nicht CONNECTED.'
      );

      return;
    }


    const page =
      client.pupPage;


    if (!page) {
      console.log(
        '❌ Puppeteer-Seite wurde nicht gefunden.'
      );

      return;
    }


    testStarted = true;


    await sleep(3000);


    /*
    ----------------------------------------------------------
    SCHRITT 1:
    KANÄLE ÖFFNEN
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche Bereich "Kanäle"...'
    );


    const channelAreaResult =
      await page.evaluate(() => {

        function normalize(value) {
          return String(
            value || ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        }


        function isVisible(element) {
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


        /*
         * Alten Marker entfernen.
         */

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
          !isVisible(target)
        ) {
          target = null;
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
            opened: false
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
          opened: true,

          tag:
            clickable.tagName,

          aria:
            clickable.getAttribute(
              'aria-label'
            ),

          testId:
            clickable.getAttribute(
              'data-testid'
            ),

          role:
            clickable.getAttribute(
              'role'
            ),

          text:
            (
              clickable.textContent ||
              ''
            )
              .trim()
              .slice(
                0,
                120
              )
        };
      });


    console.log(
      '📺 Kanäle-Navigation:',
      channelAreaResult
    );


    if (
      !channelAreaResult.opened
    ) {
      console.log(
        '❌ Bereich "Kanäle" wurde nicht gefunden.'
      );

      testStarted = false;

      return;
    }


    /*
     * ECHTER PUPPETEER-KLICK.
     */

    const channelsButton =
      await page.$(
        '[data-bot-channels-button="true"]'
      );


    if (!channelsButton) {
      console.log(
        '❌ Markierter Kanäle-Button wurde nicht wiedergefunden.'
      );

      testStarted = false;

      return;
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
      '✅ Bereich "Kanäle" mit Puppeteer angeklickt.'
    );


    await sleep(4500);


    /*
    ----------------------------------------------------------
    SCHRITT 1B:
    POPUP
    ----------------------------------------------------------
    */

    await closeWhatsAppPopup(
      page
    );


    await sleep(2500);


    /*
    ----------------------------------------------------------
    SCHRITT 2:
    JORNE_L1VE FINDEN
    ----------------------------------------------------------
    */

    console.log(
      `🔎 Suche Kanal "${CHANNEL_NAME}"...`
    );


    const channelResult =
      await page.evaluate(
        channelName => {

          function normalize(value) {
            return String(
              value || ''
            )
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();
          }


          function isVisible(element) {
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


          function getInfo(element) {
            const rect =
              element.getBoundingClientRect();

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


          /*
           * Die Logs haben genau diesen data-testid
           * für Jorne_L1ve bestätigt.
           */

          const newsletterCells =
            [
              ...document.querySelectorAll(
                '[data-testid="newsletter-tab-newsletter-cell"]'
              )
            ]
              .filter(
                isVisible
              );


          let target =
            newsletterCells.find(
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
                  aria ===
                    `kanal ${wanted}` ||
                  aria.includes(
                    wanted
                  ) ||
                  text.startsWith(
                    wanted
                  )
                );
              }
            );


          /*
           * Zweiter Fallback.
           */

          if (!target) {
            target =
              newsletterCells.find(
                element => {

                  const info =
                    getInfo(
                      element
                    );

                  return (
                    normalize(
                      info.text
                    ).includes(
                      wanted
                    ) ||
                    normalize(
                      info.aria
                    ).includes(
                      wanted
                    )
                  );
                }
              );
          }


          /*
           * Dritter Fallback.
           */

          if (!target) {

            const clickables =
              [
                ...document.querySelectorAll(
                  [
                    '[role="button"]',
                    '[role="listitem"]',
                    '[tabindex]',
                    'button'
                  ].join(',')
                )
              ]
                .filter(
                  isVisible
                );


            target =
              clickables.find(
                element => {

                  const info =
                    getInfo(
                      element
                    );

                  const text =
                    normalize(
                      info.text
                    );

                  const aria =
                    normalize(
                      info.aria
                    );


                  return (
                    (
                      text.includes(
                        wanted
                      ) ||
                      aria.includes(
                        wanted
                      )
                    ) &&
                    info.left <
                      window.innerWidth *
                        0.5 &&
                    info.width <
                      600 &&
                    info.height <
                      200
                  );
                }
              );
          }


          if (!target) {

            const possible =
              newsletterCells
                .map(
                  getInfo
                )
                .slice(
                  0,
                  30
                );


            return {
              found: false,
              possible
            };
          }


          const info =
            getInfo(
              target
            );


          /*
           * Sicherheitscheck:
           * Die bestätigte Jorne-Zelle lag links
           * bei ca. 65 px und war rund 409 x 72 px.
           */

          if (
            info.left >
              window.innerWidth *
                0.55 ||
            info.width >
              700 ||
            info.height >
              300
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

      console.log(
        `❌ Kanal "${CHANNEL_NAME}" wurde nicht sicher gefunden.`
      );


      if (
        channelResult.rejected
      ) {
        console.log(
          '⚠️ Unsicherer Treffer:',
          channelResult.rejected
        );
      }


      if (
        channelResult.possible
      ) {
        console.log(
          '🔎 Gefundene Kanalzellen:',
          channelResult.possible
        );
      }


      testStarted = false;

      return;
    }


    console.log(
      '🎯 Gefundene Kanal-Zelle:',
      channelResult.selected
    );


    /*
     * Wichtigste Änderung:
     * KEIN element.click() im Browser-JavaScript,
     * sondern Puppeteers echter Klick.
     */

    const channelHandle =
      await page.$(
        '[data-bot-channel-target="true"]'
      );


    if (!channelHandle) {

      console.log(
        '❌ Markierte Jorne-Kanal-Zelle konnte nicht erneut gefunden werden.'
      );

      testStarted = false;

      return;
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


    console.log(
      '🖱️ Klickposition Kanal:',
      box
    );


    if (!box) {

      console.log(
        '❌ Keine Klickposition für Kanal-Zelle verfügbar.'
      );

      testStarted = false;

      return;
    }


    /*
     * Direkter Maus-Klick auf die Mitte
     * der Kanal-Zelle.
     */

    await page.mouse.move(
      box.x +
        box.width / 2,

      box.y +
        box.height / 2
    );


    await sleep(300);


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
      `✅ ECHTER MAUSKLICK auf "${CHANNEL_NAME}" ausgeführt.`
    );


    /*
     * Oberfläche Zeit zum Wechseln geben.
     */

    await sleep(5000);


    /*
     * Sicherheitshalber Popup schließen.
     */

    await closeWhatsAppPopup(
      page
    );


    await sleep(2000);


    /*
    ----------------------------------------------------------
    SCHRITT 2B:
    PRÜFEN, OB RECHTE SEITE WIRKLICH GEWECHSELT HAT
    ----------------------------------------------------------
    */

    const firstChannelCheck =
      await inspectRightChannelArea(
        page
      );


    console.log(
      '🔍 Rechte Kanalansicht nach Klick:',
      firstChannelCheck
    );


    /*
     * Falls rechts weiterhin "Kanäle entdecken"
     * steht, ein zweiter echter Klick.
     */

    if (
      firstChannelCheck.emptyState &&
      !firstChannelCheck.channelNameVisibleRight
    ) {

      console.log(
        '⚠️ Rechte Seite zeigt noch "Kanäle entdecken".'
      );


      console.log(
        '🔁 Zweiter Mausklick auf Jorne_L1ve...'
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


          await sleep(6000);
        }
      }
    }


    const finalChannelCheck =
      await inspectRightChannelArea(
        page
      );


    console.log(
      '📺 FINALE Kanalansicht:',
      finalChannelCheck
    );


    /*
     * Wenn die leere Kanal-Entdecken-Seite
     * immer noch sichtbar ist, stoppen wir.
     *
     * Dadurch suchen wir NICHT mehr sinnlos
     * nach einem Composer in der falschen Ansicht.
     */

    if (
      finalChannelCheck.emptyState &&
      !finalChannelCheck.channelNameVisibleRight
    ) {

      console.log(
        '❌ Jorne_L1ve wurde links gefunden, aber die rechte Kanalansicht wurde trotz echtem Mausklick nicht geöffnet.'
      );


      console.log(
        '➡️ Bitte Screenshot ab "FINALE Kanalansicht" schicken.'
      );


      testStarted = false;

      return;
    }


    console.log(
      `✅ Kanal "${CHANNEL_NAME}" ist jetzt tatsächlich geöffnet.`
    );


    await sleep(4000);


    /*
    ----------------------------------------------------------
    SCHRITT 3:
    NEWSLETTER-ID
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche nach einer @newsletter-ID...'
    );


    const newsletterIds =
      await page.evaluate(() => {

        const ids =
          new Set();


        try {

          const html =
            document.documentElement.innerHTML;


          const matches =
            html.match(
              /[0-9]{5,40}@newsletter/g
            ) || [];


          for (
            const id
            of matches
          ) {
            ids.add(id);
          }

        } catch {}


        try {

          const possibleStores = [

            window.Store?.NewsletterCollection,

            window.Store?.Newsletter,

            window.Store?.NewsletterStore
          ];


          for (
            const store
            of possibleStores
          ) {

            const models =
              store?.models ||
              [];


            for (
              const model
              of models
            ) {

              let id =
                null;


              try {

                id =
                  model?.id?._serialized ||
                  model?.id?.toString?.() ||
                  null;

              } catch {}


              if (
                id &&
                String(
                  id
                ).includes(
                  '@newsletter'
                )
              ) {

                ids.add(
                  String(
                    id
                  )
                );
              }
            }
          }

        } catch {}


        return [
          ...ids
        ];
      });


    console.log(
      '📺 Gefundene Newsletter-IDs:',
      newsletterIds
    );


    /*
    ----------------------------------------------------------
    SCHRITT 4:
    COMPOSER FINDEN
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche Meldungs-Eingabefeld...'
    );


    const composerInfo =
      await page.evaluate(() => {

        function isVisible(element) {

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
            style.visibility !== 'hidden' &&
            style.opacity !== '0'
          );
        }


        function getInfo(element) {

          const rect =
            element.getBoundingClientRect();


          return {

            tag:
              element.tagName,

            aria:
              element.getAttribute(
                'aria-label'
              ),

            placeholder:
              element.getAttribute(
                'placeholder'
              ) ||
              element.getAttribute(
                'data-placeholder'
              ),

            role:
              element.getAttribute(
                'role'
              ),

            contenteditable:
              element.getAttribute(
                'contenteditable'
              ),

            testId:
              element.getAttribute(
                'data-testid'
              ),

            dataTab:
              element.getAttribute(
                'data-tab'
              ),

            lexical:
              element.getAttribute(
                'data-lexical-editor'
              ),

            left:
              Math.round(
                rect.left
              ),

            right:
              Math.round(
                rect.right
              ),

            top:
              Math.round(
                rect.top
              ),

            bottom:
              Math.round(
                rect.bottom
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
                  200
                )
          };
        }


        /*
         * Alten Marker entfernen.
         */

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


        const selectors = [

          '[contenteditable="true"]',

          '[role="textbox"]',

          'textarea',

          'input',

          '[data-lexical-editor="true"]',

          '[data-tab]',

          '[data-testid*="compose"]',

          '[data-testid*="input"]',

          '[data-testid*="newsletter"]',

          '[aria-label*="Meldung"]',

          '[aria-label*="Nachricht"]',

          '[placeholder*="Meldung"]',

          '[data-placeholder*="Meldung"]'
        ];


        const candidates =
          [
            ...new Set(
              [
                ...document.querySelectorAll(
                  selectors.join(',')
                )
              ]
            )
          ]
            .filter(
              isVisible
            );


        /*
         * Direkte Bezeichnungen.
         */

        let target =
          candidates.find(
            element => {

              const info =
                getInfo(
                  element
                );


              const aria =
                (
                  info.aria ||
                  ''
                )
                  .toLowerCase();


              const placeholder =
                (
                  info.placeholder ||
                  ''
                )
                  .toLowerCase();


              const text =
                (
                  info.text ||
                  ''
                )
                  .toLowerCase();


              return (
                aria.includes(
                  'gib eine meldung ein'
                ) ||
                aria.includes(
                  'meldung verfassen'
                ) ||
                aria.includes(
                  'meldung eingeben'
                ) ||
                aria.includes(
                  'nachricht eingeben'
                ) ||
                placeholder.includes(
                  'gib eine meldung ein'
                ) ||
                placeholder.includes(
                  'meldung verfassen'
                ) ||
                placeholder.includes(
                  'meldung eingeben'
                ) ||
                placeholder.includes(
                  'nachricht eingeben'
                ) ||
                text ===
                  'gib eine meldung ein'
              );
            }
          );


        /*
         * Falls äußerer Container:
         * echtes Textfeld innen.
         */

        if (target) {

          const inner =
            target.querySelector?.(
              [
                '[contenteditable="true"]',
                '[role="textbox"]',
                'textarea',
                '[data-lexical-editor="true"]'
              ].join(',')
            );


          if (
            inner &&
            isVisible(
              inner
            )
          ) {

            target =
              inner;
          }
        }


        /*
         * Rechter Hauptbereich.
         */

        if (!target) {

          const editable =
            candidates.filter(
              element => {

                const info =
                  getInfo(
                    element
                  );


                return (
                  info.contenteditable ===
                    'true' ||
                  info.role ===
                    'textbox' ||
                  info.lexical ===
                    'true' ||
                  info.tag ===
                    'TEXTAREA'
                );
              }
            );


          target =
            editable.find(
              element => {

                const info =
                  getInfo(
                    element
                  );


                const aria =
                  (
                    info.aria ||
                    ''
                  )
                    .toLowerCase();


                const placeholder =
                  (
                    info.placeholder ||
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


                /*
                 * Rechts vom Kanal-Drawer.
                 * Der Drawer endet laut Log ungefähr
                 * bei x = 474.
                 */

                const rightSide =
                  info.left >
                    500;


                const reasonableWidth =
                  info.width >
                    100;


                return (
                  !search &&
                  rightSide &&
                  reasonableWidth
                );
              }
            );
        }


        /*
         * Diagnose.
         */

        const diagnosticSelectors = [

          '[contenteditable]',

          '[role]',

          'input',

          'textarea',

          '[aria-label]',

          '[placeholder]',

          '[data-placeholder]',

          '[data-testid]',

          '[data-tab]',

          '[data-lexical-editor]'
        ];


        const diagnosticElements =
          [
            ...new Set(
              [
                ...document.querySelectorAll(
                  diagnosticSelectors.join(',')
                )
              ]
            )
          ]
            .filter(
              isVisible
            );


        const details =
          diagnosticElements
            .map(
              (
                element,
                index
              ) => ({
                index,
                ...getInfo(
                  element
                )
              })
            )
            .filter(
              item => {

                const joined =
                  [
                    item.aria,
                    item.placeholder,
                    item.role,
                    item.contenteditable,
                    item.testId,
                    item.dataTab,
                    item.lexical,
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
                  joined.includes(
                    'meldung'
                  ) ||
                  joined.includes(
                    'nachricht'
                  ) ||
                  joined.includes(
                    'newsletter'
                  ) ||
                  joined.includes(
                    'compose'
                  ) ||
                  joined.includes(
                    'textbox'
                  ) ||
                  joined.includes(
                    'editable'
                  ) ||
                  joined.includes(
                    'suchen'
                  )
                );
              }
            )
            .slice(
              0,
              120
            );


        if (!target) {

          return {

            found:
              false,

            viewport: {

              width:
                window.innerWidth,

              height:
                window.innerHeight
            },

            details
          };
        }


        target.setAttribute(
          'data-bot-composer',
          'true'
        );


        return {

          found:
            true,

          viewport: {

            width:
              window.innerWidth,

            height:
              window.innerHeight
          },

          selected:
            getInfo(
              target
            ),

          details
        };
      });


    console.log(
      '📝 Composer-Diagnose:',
      composerInfo
    );


    if (
      !composerInfo.found
    ) {

      console.log(
        '❌ Meldungsfeld wurde nicht gefunden.'
      );


      console.log(
        '➡️ Bitte Screenshot ab "Composer-Diagnose" schicken.'
      );


      testStarted =
        false;


      return;
    }


    console.log(
      '✅ Meldungsfeld gefunden!'
    );


    console.log(
      '🎯 Ausgewähltes Element:',
      composerInfo.selected
    );


    /*
    ----------------------------------------------------------
    SCHRITT 5:
    TEXT EINGEBEN
    ----------------------------------------------------------
    */

    const composer =
      await page.$(
        '[data-bot-composer="true"]'
      );


    if (!composer) {

      console.log(
        '❌ Markiertes Meldungsfeld konnte nicht erneut gefunden werden.'
      );


      testStarted =
        false;


      return;
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
      TEST_MESSAGE,
      {
        delay:
          40
      }
    );


    console.log(
      `⌨️ Text eingegeben: "${TEST_MESSAGE}"`
    );


    await sleep(
      2000
    );


    /*
    ----------------------------------------------------------
    SCHRITT 6:
    SENDEN
    ----------------------------------------------------------
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


    const messageVisible =
      await page.evaluate(
        testMessage => {

          return [
            ...document.querySelectorAll(
              '*'
            )
          ].some(
            element =>
              (
                element.textContent ||
                ''
              )
                .trim() ===
              testMessage
          );
        },

        TEST_MESSAGE
      );


    console.log(
      messageVisible
        ?
        '✅ Testtext ist anschließend in der Oberfläche sichtbar.'
        :
        '⚠️ Testtext wurde nach ENTER nicht eindeutig gefunden.'
    );


    console.log(
      '================================'
    );


    console.log(
      '🎉 UI-SENDEVERSUCH ABGESCHLOSSEN'
    );


    console.log(
      `➡️ Bitte WhatsApp-Kanal prüfen: "${TEST_MESSAGE}"`
    );


    console.log(
      '================================'
    );

  } catch (error) {

    console.log(
      '================================'
    );


    console.error(
      '❌ FEHLER IM KANAL-UI-TEST'
    );


    console.error(
      error
    );


    console.log(
      '================================'
    );


    testStarted =
      false;

  } finally {

    testRunning =
      false;
  }
}


/*
============================================================
BOT START
============================================================
*/

async function startBot() {

  fs.mkdirSync(
    AUTH_DATA_PATH,
    {
      recursive:
        true
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


  const store =
    new FixedMongoStore({

      mongoose,

      dataPath:
        AUTH_DATA_PATH
    });


  /*
   * Sitzung prüfen.
   */

  try {

    const exists =
      await store.sessionExists({

        session:
          `RemoteAuth-${CLIENT_ID}`
      });


    console.log(
      '🗄️ Gespeicherte MongoDB-Sitzung vorhanden:',
      exists
    );

  } catch (error) {

    console.log(
      '⚠️ MongoDB-Sitzungsstatus konnte nicht geprüft werden:',
      error.message
    );
  }


  /*
   * Client.
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
  EVENTS
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


      await sleep(
        7000
      );


      try {

        const state =
          await client.getState();


        console.log(
          '📡 Status nach READY:',
          state
        );


        if (
          state ===
          'CONNECTED'
        ) {

          await runChannelUITest(
            client,
            'READY-Event'
          );


          return;
        }

      } catch {}


      await sleep(
        7000
      );


      try {

        const state =
          await client.getState();


        console.log(
          '📡 Status nach zusätzlicher Wartezeit:',
          state
        );


        if (
          state ===
          'CONNECTED'
        ) {

          await runChannelUITest(
            client,
            'READY + Wartezeit'
          );
        }

      } catch (error) {

        console.log(
          '⚠️ Status nach READY konnte nicht geprüft werden:',
          error.message
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
          'CONNECTED' &&
        !testStarted &&
        !testRunning
      ) {

        setTimeout(
          () => {

            runChannelUITest(
              client,
              'change_state = CONNECTED'
            )
              .catch(
                error => {

                  console.error(
                    '❌ CONNECTED-Test fehlgeschlagen:',
                    error
                  );
                }
              );
          },

          5000
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


  /*
  ------------------------------------------------------------
  60-SEKUNDEN-SICHERHEITSNETZ
  ------------------------------------------------------------
  */

  setTimeout(
    async () => {

      if (
        testStarted ||
        testRunning
      ) {
        return;
      }


      try {

        const state =
          await client.getState();


        console.log(
          '⏰ 60-SEKUNDEN-STATUS:',
          state
        );


        if (
          state ===
          'CONNECTED'
        ) {

          await runChannelUITest(
            client,
            '60-Sekunden-CONNECTED'
          );
        }

      } catch (error) {

        console.error(
          '❌ 60-Sekunden-Prüfung fehlgeschlagen:',
          error
        );
      }
    },

    60000
  );


  /*
   * Start.
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

startBot().catch(
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
