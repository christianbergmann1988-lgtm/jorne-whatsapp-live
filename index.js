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

    const documents = await bucket
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
    STATUS PRÜFEN
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


    /*
     * Ab hier gilt der Test als wirklich gestartet.
     */

    testStarted = true;


    /*
     * WhatsApp noch kurz Zeit geben.
     */

    await sleep(4000);


    /*
    ----------------------------------------------------------
    SCHRITT 1:
    BEREICH "KANÄLE" ÖFFNEN
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
            .replace(
              /\s+/g,
              ' '
            )
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
         * 1. Direkte bekannte WhatsApp-TestID.
         */

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


        /*
         * Relevante klickbare Elemente sammeln.
         */

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


        /*
         * 2. aria-label exakt "Kanäle".
         */

        if (!target) {
          target =
            elements.find(
              element =>
                normalize(
                  element.getAttribute(
                    'aria-label'
                  )
                ) === 'kanäle'
            );
        }


        /*
         * 3. aria-label enthält "Kanäle".
         */

        if (!target) {
          target =
            elements.find(
              element =>
                normalize(
                  element.getAttribute(
                    'aria-label'
                  )
                ).includes(
                  'kanäle'
                )
            );
        }


        /*
         * 4. data-testid enthält newsletter-tab.
         */

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
                    'newsletter-tab'
                  )
                );
              }
            );
        }


        /*
         * 5. Sichtbarer Text exakt "Kanäle".
         */

        if (!target) {
          target =
            elements.find(
              element => {

                const text =
                  normalize(
                    element.textContent
                  );

                return (
                  text === 'kanäle' ||
                  text.startsWith(
                    'kanäle '
                  )
                );
              }
            );
        }


        /*
         * 6. Ganz breiter Fallback.
         */

        if (!target) {
          const allVisible =
            [
              ...document.querySelectorAll('*')
            ]
              .filter(
                isVisible
              );

          target =
            allVisible.find(
              element => {

                const aria =
                  normalize(
                    element.getAttribute(
                      'aria-label'
                    )
                  );

                const text =
                  normalize(
                    element.textContent
                  );

                const testId =
                  normalize(
                    element.getAttribute(
                      'data-testid'
                    )
                  );

                return (
                  aria === 'kanäle' ||
                  text === 'kanäle' ||
                  testId.includes(
                    'newsletter-tab'
                  )
                );
              }
            );
        }


        /*
         * Diagnose, falls gar nichts gefunden.
         */

        if (!target) {
          const possible =
            elements
              .map(
                element => ({
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
                      .trim()
                      .slice(
                        0,
                        120
                      )
                })
              )
              .filter(
                item => {

                  const combined =
                    normalize(
                      [
                        item.aria,
                        item.testId,
                        item.text
                      ]
                        .filter(Boolean)
                        .join(' ')
                    );

                  return (
                    combined.includes(
                      'kanal'
                    ) ||
                    combined.includes(
                      'newsletter'
                    )
                  );
                }
              )
              .slice(
                0,
                40
              );

          return {
            opened: false,
            possible
          };
        }


        /*
         * Anklickbares Eltern-Element bestimmen.
         */

        const clickable =
          target.closest(
            [
              'button',
              '[role="button"]',
              '[role="tab"]',
              '[tabindex]',
              '[data-testid]'
            ].join(',')
          ) || target;


        try {
          clickable.click();
        } catch {
          try {
            target.click();
          } catch {}
        }


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


    console.log(
      channelAreaResult.opened
        ? '✅ Bereich "Kanäle" angeklickt.'
        : '⚠️ Bereich "Kanäle" nicht direkt gefunden.'
    );


    if (
      !channelAreaResult.opened
    ) {
      console.log(
        '🔎 Mögliche Kanal-Elemente:',
        channelAreaResult.possible
      );
    }


    /*
     * Navigation laden lassen.
     */

    await sleep(5000);


    /*
    ----------------------------------------------------------
    SCHRITT 2:
    JORNE_L1VE ÖFFNEN
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
              .replace(
                /\s+/g,
                ' '
              )
              .trim()
              .toLowerCase();
          }


          function isVisible(element) {
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


          const wanted =
            normalize(
              channelName
            );


          /*
           * Bekannte Kanal-Zellen.
           */

          const cells =
            [
              ...document.querySelectorAll(
                [
                  '[data-testid="newsletter-tab-newsletter-cell"]',
                  '[data-testid*="newsletter"]',
                  '[role="listitem"]',
                  '[role="button"]',
                  '[tabindex]'
                ].join(',')
              )
            ]
              .filter(
                isVisible
              );


          let target =
            cells.find(
              element =>
                normalize(
                  element.textContent
                ).includes(
                  wanted
                )
            );


          /*
           * aria-label.
           */

          if (!target) {
            target =
              cells.find(
                element =>
                  normalize(
                    element.getAttribute(
                      'aria-label'
                    )
                  ).includes(
                    wanted
                  )
              );
          }


          /*
           * Gesamtes sichtbares DOM,
           * aber nur exakte kurze Treffer.
           */

          if (!target) {
            const allVisible =
              [
                ...document.querySelectorAll('*')
              ]
                .filter(
                  isVisible
                );

            target =
              allVisible.find(
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
                    text === wanted ||
                    aria === wanted ||
                    aria ===
                      `kanal ${wanted}`
                  );
                }
              );
          }


          /*
           * Noch breiter:
           * Element enthält Jorne_L1ve,
           * darf aber kein riesiger Container sein.
           */

          if (!target) {
            const allVisible =
              [
                ...document.querySelectorAll('*')
              ]
                .filter(
                  isVisible
                );

            target =
              allVisible.find(
                element => {

                  const text =
                    normalize(
                      element.textContent
                    );

                  return (
                    text.includes(
                      wanted
                    ) &&
                    text.length < 250
                  );
                }
              );
          }


          /*
           * Diagnose.
           */

          if (!target) {
            const possible =
              cells
                .map(
                  element => ({
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
                        .trim()
                        .slice(
                          0,
                          160
                        )
                  })
                )
                .filter(
                  item => {

                    const combined =
                      normalize(
                        [
                          item.aria,
                          item.testId,
                          item.text
                        ]
                          .filter(Boolean)
                          .join(' ')
                      );

                    return (
                      combined.includes(
                        'jorne'
                      ) ||
                      combined.includes(
                        'newsletter'
                      ) ||
                      combined.includes(
                        'kanal'
                      )
                    );
                  }
                )
                .slice(
                  0,
                  50
                );

            return {
              opened: false,
              possible
            };
          }


          /*
           * Hoch zum anklickbaren Container.
           */

          const clickable =
            target.closest(
              [
                '[data-testid="newsletter-tab-newsletter-cell"]',
                'button',
                '[role="button"]',
                '[role="listitem"]',
                '[tabindex]'
              ].join(',')
            ) || target;


          try {
            clickable.click();
          } catch {
            try {
              target.click();
            } catch {}
          }


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
                  160
                )
          };
        },

        CHANNEL_NAME
      );


    console.log(
      '📺 Kanal-Suche:',
      channelResult
    );


    if (
      !channelResult.opened
    ) {
      console.log(
        `❌ Kanal "${CHANNEL_NAME}" wurde nicht gefunden.`
      );

      console.log(
        '🔎 Mögliche Kanal-Zellen:',
        channelResult.possible
      );

      /*
       * Ganz wichtig:
       * Späteren neuen Versuch erlauben.
       */

      testStarted = false;

      return;
    }


    console.log(
      `✅ Kanal "${CHANNEL_NAME}" wurde geöffnet.`
    );


    /*
     * Kanal vollständig laden.
     */

    await sleep(8000);


    /*
    ----------------------------------------------------------
    SCHRITT 3:
    NEWSLETTER-ID SUCHEN
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche nach einer @newsletter-ID...'
    );


    const newsletterIds =
      await page.evaluate(() => {

        const ids =
          new Set();


        /*
         * DOM durchsuchen.
         */

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


        /*
         * WhatsApp Stores durchsuchen.
         */

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
              store?.models || [];

            for (
              const model
              of models
            ) {
              let id = null;

              try {
                id =
                  model?.id?._serialized ||
                  model?.id?.toString?.() ||
                  null;
              } catch {}

              if (
                id &&
                String(id).includes(
                  '@newsletter'
                )
              ) {
                ids.add(
                  String(id)
                );
              }
            }
          }

        } catch {}


        return [...ids];
      });


    console.log(
      '📺 Gefundene Newsletter-IDs:',
      newsletterIds
    );


    /*
    ----------------------------------------------------------
    SCHRITT 4:
    EINGABEFELD SUCHEN
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
            window.getComputedStyle(element);

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
                .trim()
                .slice(
                  0,
                  150
                )
          };
        }


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


        const allCandidates =
          [
            ...document.querySelectorAll(
              selectors.join(',')
            )
          ]
            .filter(isVisible);


        const candidates =
          [
            ...new Set(
              allCandidates
            )
          ];


        /*
         * 1. Direkte Meldungsbezeichnungen.
         */

        let target =
          candidates.find(element => {

            const aria =
              (
                element.getAttribute(
                  'aria-label'
                ) || ''
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

            const text =
              (
                element.textContent ||
                ''
              )
                .trim()
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
                'gib eine meldung ein' ||
              text ===
                'meldung verfassen'
            );
          });


        /*
         * Falls äußerer Container:
         * echtes Feld darin verwenden.
         */

        if (target) {
          const inner =
            target.querySelector?.(
              [
                '[contenteditable="true"]',
                '[role="textbox"]',
                'textarea',
                'input',
                '[data-lexical-editor="true"]'
              ].join(',')
            );

          if (
            inner &&
            isVisible(inner)
          ) {
            target = inner;
          }
        }


        /*
         * 2. Hauptbereich + untere Hälfte.
         */

        if (!target) {
          const editable =
            candidates.filter(element => {

              const info =
                getInfo(element);

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
            });


          target =
            editable.find(element => {

              const info =
                getInfo(element);

              const aria =
                (
                  info.aria || ''
                ).toLowerCase();

              const placeholder =
                (
                  info.placeholder || ''
                ).toLowerCase();

              const isSearch =
                aria.includes(
                  'suchen'
                ) ||
                placeholder.includes(
                  'suchen'
                );

              const isMainArea =
                info.left >
                window.innerWidth *
                  0.28;

              const isLowerArea =
                info.top >
                window.innerHeight *
                  0.40;

              return (
                !isSearch &&
                isMainArea &&
                isLowerArea
              );
            });
        }


        /*
         * 3. Hauptbereich ohne Höhenbedingung.
         */

        if (!target) {
          target =
            candidates.find(element => {

              const info =
                getInfo(element);

              const aria =
                (
                  info.aria || ''
                ).toLowerCase();

              const placeholder =
                (
                  info.placeholder || ''
                ).toLowerCase();

              const editable =
                info.contenteditable ===
                  'true' ||
                info.role ===
                  'textbox' ||
                info.lexical ===
                  'true' ||
                info.tag ===
                  'TEXTAREA';

              const search =
                aria.includes(
                  'suchen'
                ) ||
                placeholder.includes(
                  'suchen'
                );

              return (
                editable &&
                !search &&
                info.left >
                  window.innerWidth *
                    0.28
              );
            });
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
            .filter(isVisible);


        const details =
          diagnosticElements
            .map(
              (
                element,
                index
              ) => ({
                index,
                ...getInfo(element)
              })
            )
            .filter(item => {

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
                  .filter(Boolean)
                  .join(' ')
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
            })
            .slice(
              0,
              100
            );


        if (!target) {
          return {
            found: false,

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
          found: true,

          viewport: {
            width:
              window.innerWidth,

            height:
              window.innerHeight
          },

          selected:
            getInfo(target),

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
        '➡️ Bitte Screenshot vom kompletten Abschnitt "Composer-Diagnose" schicken.'
      );

      /*
       * Späteren Versuch zulassen.
       */

      testStarted = false;

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
    TESTTEXT EINGEBEN
    ----------------------------------------------------------
    */

    const composer =
      await page.$(
        '[data-bot-composer="true"]'
      );


    if (!composer) {
      console.log(
        '❌ Das markierte Meldungsfeld konnte nicht erneut gefunden werden.'
      );

      testStarted = false;

      return;
    }


    await composer.click();


    await sleep(500);


    await page.keyboard.type(
      TEST_MESSAGE,
      {
        delay: 40
      }
    );


    console.log(
      `⌨️ Text eingegeben: "${TEST_MESSAGE}"`
    );


    await sleep(2000);


    /*
    ----------------------------------------------------------
    SCHRITT 6:
    ABSENDEN
    ----------------------------------------------------------
    */

    await page.keyboard.press(
      'Enter'
    );


    console.log(
      '📤 ENTER gedrückt.'
    );


    await sleep(4000);


    const messageVisible =
      await page.evaluate(
        testMessage => {

          return [
            ...document.querySelectorAll('*')
          ].some(
            element =>
              (
                element.textContent ||
                ''
              ).trim() ===
              testMessage
          );

        },

        TEST_MESSAGE
      );


    console.log(
      messageVisible
        ? '✅ Testtext ist anschließend in der Oberfläche sichtbar.'
        : '⚠️ Testtext wurde nach ENTER nicht eindeutig in der Oberfläche gefunden.'
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

    console.error(error);

    console.log(
      '================================'
    );

    /*
     * Bei technischem Fehler erneuten Versuch zulassen.
     */

    testStarted = false;

  } finally {
    testRunning = false;
  }
}


/*
============================================================
BOT START
============================================================
*/

async function startBot() {

  /*
   * Lokalen RemoteAuth-Ordner anlegen.
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
   * Store erstellen.
   */

  const store =
    new FixedMongoStore({
      mongoose,

      dataPath:
        AUTH_DATA_PATH
    });


  /*
   * Gespeicherte Sitzung prüfen.
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
   * WhatsApp Client.
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
          width: 1365,
          height: 900
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

      console.log(code);

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


      await sleep(7000);


      try {
        const state =
          await client.getState();


        console.log(
          '📡 Status nach READY:',
          state
        );


        if (
          state === 'CONNECTED'
        ) {
          await runChannelUITest(
            client,
            'READY-Event'
          );

          return;
        }

      } catch {}


      await sleep(7000);


      try {
        const state =
          await client.getState();


        console.log(
          '📡 Status nach zusätzlicher Wartezeit:',
          state
        );


        if (
          state === 'CONNECTED'
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
        state === 'CONNECTED' &&
        !testStarted &&
        !testRunning
      ) {
        setTimeout(
          () => {

            runChannelUITest(
              client,
              'change_state = CONNECTED'
            ).catch(
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
          state === 'CONNECTED'
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
   * WhatsApp initialisieren.
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

    console.error(error);

    process.exit(1);
  }
);
