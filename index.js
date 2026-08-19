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
  if (testStarted) {
    return;
  }

  testStarted = true;

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

      testStarted = false;

      return;
    }


    const page =
      client.pupPage;

    if (!page) {
      console.log(
        '❌ Puppeteer-Seite wurde nicht gefunden.'
      );

      testStarted = false;

      return;
    }


    /*
    ----------------------------------------------------------
    SCHRITT 1:
    BEREICH "KANÄLE" ÖFFNEN
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche Bereich "Kanäle"...'
    );


    const channelAreaOpened =
      await page.evaluate(() => {

        const elements =
          [
            ...document.querySelectorAll('*')
          ];


        const target =
          elements.find(element => {

            const aria =
              (
                element.getAttribute(
                  'aria-label'
                ) || ''
              )
                .trim();


            const text =
              (
                element.textContent || ''
              )
                .trim();


            const testId =
              element.getAttribute(
                'data-testid'
              );


            return (
              aria === 'Kanäle' ||
              text === 'Kanäle' ||
              testId ===
                'newsletter-tab-drawer'
            );
          });


        if (!target) {
          return false;
        }


        const clickable =
          target.closest(
            [
              'button',
              '[role="button"]',
              '[tabindex]',
              '[data-testid="newsletter-tab-drawer"]'
            ].join(',')
          ) || target;


        clickable.click();

        return true;
      });


    console.log(
      channelAreaOpened
        ? '✅ Bereich "Kanäle" angeklickt.'
        : '⚠️ Bereich "Kanäle" nicht direkt gefunden.'
    );


    await sleep(4000);


    /*
    ----------------------------------------------------------
    SCHRITT 2:
    JORNE_L1VE ÖFFNEN
    ----------------------------------------------------------
    */

    console.log(
      `🔎 Suche Kanal "${CHANNEL_NAME}"...`
    );


    const channelOpened =
      await page.evaluate(
        channelName => {

          const cells =
            [
              ...document.querySelectorAll(
                '[data-testid="newsletter-tab-newsletter-cell"]'
              )
            ];


          let target =
            cells.find(element =>
              (
                element.textContent || ''
              ).includes(channelName)
            );


          /*
           * Fallback über sichtbaren Text.
           */

          if (!target) {
            const elements =
              [
                ...document.querySelectorAll('*')
              ];


            target =
              elements.find(element => {

                const text =
                  (
                    element.textContent || ''
                  ).trim();


                const aria =
                  (
                    element.getAttribute(
                      'aria-label'
                    ) || ''
                  ).trim();


                return (
                  text === channelName ||
                  aria === channelName ||
                  aria ===
                    `Kanal ${channelName}`
                );
              });
          }


          if (!target) {
            return false;
          }


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


          clickable.click();

          return true;
        },

        CHANNEL_NAME
      );


    if (!channelOpened) {
      console.log(
        `❌ Kanal "${CHANNEL_NAME}" wurde nicht gefunden.`
      );

      return;
    }


    console.log(
      `✅ Kanal "${CHANNEL_NAME}" wurde geöffnet.`
    );


    /*
     * Dem Kanal etwas mehr Zeit geben,
     * seine komplette Oberfläche zu laden.
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

    WICHTIG:
    Wir suchen diesmal deutlich breiter und
    schließen die linken Suchfelder gezielt aus.
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche Meldungs-Eingabefeld...'
    );


    const composerInfo =
      await page.evaluate(() => {

        /*
         * Prüft, ob ein Element tatsächlich
         * sichtbar ist.
         */

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


        /*
         * Textwerte eines Elements normalisieren.
         */

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


        /*
         * Kandidaten sammeln.
         *
         * Nicht nur input / textarea,
         * sondern auch WhatsApps editierbare DIVs.
         */

        const selectors = [
          '[contenteditable="true"]',
          '[role="textbox"]',
          'textarea',
          'input',
          '[data-lexical-editor="true"]',
          '[data-tab]',
          '[data-testid*="compose"]',
          '[data-testid*="input"]',
          '[data-testid*="newsletter"]'
        ];


        const allCandidates =
          [
            ...document.querySelectorAll(
              selectors.join(',')
            )
          ]
            .filter(isVisible);


        /*
         * Doppelte Elemente entfernen.
         */

        const candidates =
          [
            ...new Set(
              allCandidates
            )
          ];


        /*
         * 1.
         * Explizit nach Texten wie
         * "Meldung verfassen" suchen.
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
                'meldung verfassen'
              ) ||
              aria.includes(
                'meldung eingeben'
              ) ||
              aria.includes(
                'nachricht eingeben'
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
                'meldung verfassen'
            );
          });


        /*
         * 2.
         * Falls wir einen äußeren Container
         * erwischt haben, darin das echte
         * editierbare Element suchen.
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
         * 3.
         * Editierbare Elemente im Hauptbereich
         * von WhatsApp bevorzugen.
         *
         * Linke Suchfelder befinden sich typischerweise
         * weit links. Der Kanal selbst befindet sich
         * im Hauptbereich.
         */

        if (!target) {
          const editable =
            candidates.filter(element => {

              const editableValue =
                element.getAttribute(
                  'contenteditable'
                );


              const role =
                element.getAttribute(
                  'role'
                );


              const lexical =
                element.getAttribute(
                  'data-lexical-editor'
                );


              const tag =
                element.tagName;


              return (
                editableValue ===
                  'true' ||
                role ===
                  'textbox' ||
                lexical ===
                  'true' ||
                tag ===
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


              /*
               * Suchfelder ausdrücklich ausschließen.
               */

              const isSearch =
                aria.includes(
                  'suchen'
                ) ||
                placeholder.includes(
                  'suchen'
                );


              /*
               * Das Eingabefeld sollte nicht ganz links
               * liegen.
               */

              const isMainArea =
                info.left >
                window.innerWidth *
                  0.28;


              /*
               * Meist befindet sich der Composer
               * eher im unteren Bildschirmbereich.
               */

              const isLowerArea =
                info.top >
                window.innerHeight *
                  0.45;


              return (
                !isSearch &&
                isMainArea &&
                isLowerArea
              );
            });
        }


        /*
         * 4.
         * Falls weiterhin nichts gefunden:
         * Suche nach einem editierbaren Element,
         * auch wenn WhatsApp den Composer weiter
         * oben positioniert.
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
                element.tagName ===
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
         * Vollständige Diagnose der
         * interessanten sichtbaren Elemente.
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
              80
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


        /*
         * Marker setzen, damit Puppeteer
         * das Element außerhalb von evaluate()
         * wiederfindet.
         */

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

      return;
    }


    await composer.click();


    await sleep(500);


    /*
     * Eventuell vorhandenen Text nicht löschen,
     * sondern nur eintippen.
     */

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


    /*
     * Nach dem Senden prüfen,
     * ob der Text sichtbar ist.
     */

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
  }
}


/*
============================================================
BOT START
============================================================
*/

async function startBot() {

  /*
   * Lokalen RemoteAuth-Ordner auf jedem
   * frischen GitHub-Runner anlegen.
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
   * Prüfen, ob eine gespeicherte
   * RemoteAuth-Sitzung existiert.
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
   * WhatsApp Client erstellen.
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


      /*
       * WhatsApp nach READY noch kurz
       * fertig laden lassen.
       */

      await sleep(7000);


      /*
       * READY kann bei WhatsApp bereits kommen,
       * bevor getState() CONNECTED meldet.
       */

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


      /*
       * Falls noch nicht CONNECTED:
       * kurze Zeit später erneut versuchen.
       */

      await sleep(7000);


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


      /*
       * Sicherheitsnetz:
       * Falls READY zu früh kam und CONNECTED
       * später folgt.
       */

      if (
        state ===
          'CONNECTED' &&
        !testStarted
      ) {
        setTimeout(
          () => {
            runChannelUITest(
              client,
              'change_state = CONNECTED'
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

      if (testStarted) {
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
