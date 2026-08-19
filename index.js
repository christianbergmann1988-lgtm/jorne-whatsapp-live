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
FIX FÜR REMOTEAUTH + MONGODB
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
      const readStream = fs.createReadStream(zipPath);

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
  return new Promise(resolve => setTimeout(resolve, ms));
}


/*
============================================================
KANAL ÜBER DIE WHATSAPP-WEB-OBERFLÄCHE ÖFFNEN
============================================================
*/

async function runChannelUITest(client, reason) {
  if (testStarted) {
    return;
  }

  testStarted = true;

  console.log('================================');
  console.log('🚀 STARTE WHATSAPP-KANAL-UI-TEST');
  console.log('Auslöser:', reason);
  console.log('================================');

  try {
    const state = await client.getState();

    console.log(
      '📡 WhatsApp-Status:',
      state
    );

    if (state !== 'CONNECTED') {
      console.log(
        '❌ WhatsApp ist nicht CONNECTED.'
      );

      testStarted = false;
      return;
    }

    const page = client.pupPage;

    if (!page) {
      console.log(
        '❌ Puppeteer-Seite wurde nicht gefunden.'
      );
      return;
    }


    /*
    ----------------------------------------------------------
    SCHRITT 1 – Bereich "Kanäle" öffnen
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche Bereich "Kanäle"...'
    );

    const channelAreaOpened =
      await page.evaluate(() => {
        const elements =
          [...document.querySelectorAll('*')];

        const target =
          elements.find(element => {
            const aria =
              element
                .getAttribute('aria-label')
                ?.trim();

            const text =
              element.textContent?.trim();

            return (
              aria === 'Kanäle' ||
              text === 'Kanäle'
            );
          });

        if (!target) {
          return false;
        }

        const clickable =
          target.closest(
            'button,[role="button"],[tabindex]'
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
    SCHRITT 2 – Jorne_L1ve öffnen
    ----------------------------------------------------------
    */

    console.log(
      `🔎 Suche Kanal "${CHANNEL_NAME}"...`
    );

    const channelOpened =
      await page.evaluate(
        channelName => {
          const channelCells =
            [
              ...document.querySelectorAll(
                '[data-testid="newsletter-tab-newsletter-cell"]'
              )
            ];

          let target =
            channelCells.find(element =>
              element.textContent
                ?.includes(channelName)
            );

          if (!target) {
            const elements =
              [...document.querySelectorAll('*')];

            target =
              elements.find(element => {
                const text =
                  element.textContent?.trim();

                const aria =
                  element
                    .getAttribute('aria-label')
                    ?.trim();

                return (
                  text === channelName ||
                  aria === `Kanal ${channelName}`
                );
              });
          }

          if (!target) {
            return false;
          }

          const clickable =
            target.closest(
              '[data-testid="newsletter-tab-newsletter-cell"],button,[role="button"],[role="listitem"],[tabindex]'
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

    await sleep(5000);


    /*
    ----------------------------------------------------------
    SCHRITT 3 – Newsletter-ID suchen
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche nach einer @newsletter-ID...'
    );

    const newsletterInfo =
      await page.evaluate(() => {
        const ids = new Set();

        const html =
          document.documentElement.innerHTML;

        const matches =
          html.match(
            /\d{8,30}@newsletter/g
          ) || [];

        matches.forEach(id => ids.add(id));

        try {
          const collection =
            window.Store?.NewsletterCollection;

          const models =
            collection?.models || [];

          for (const model of models) {
            let id = null;

            try {
              id =
                model?.id?._serialized ||
                model?.id?.toString?.() ||
                null;
            } catch {}

            if (
              id &&
              String(id).includes('@newsletter')
            ) {
              ids.add(String(id));
            }
          }
        } catch {}

        return [...ids];
      });

    console.log(
      '📺 Gefundene Newsletter-IDs:',
      newsletterInfo
    );


    /*
    ----------------------------------------------------------
    SCHRITT 4 – Meldungsfeld suchen
    ----------------------------------------------------------
    */

    console.log(
      '🔎 Suche Meldungs-Eingabefeld...'
    );

    const composerInfo =
      await page.evaluate(() => {
        const candidates =
          [
            ...document.querySelectorAll(
              [
                '[contenteditable="true"]',
                '[role="textbox"]',
                'textarea',
                'input'
              ].join(',')
            )
          ];

        const visible =
          candidates.filter(element => {
            const rect =
              element.getBoundingClientRect();

            return (
              rect.width > 0 &&
              rect.height > 0
            );
          });

        const details =
          visible.map(
            (element, index) => ({
              index,
              tag: element.tagName,
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
              text:
                (
                  element.textContent ||
                  ''
                )
                  .trim()
                  .slice(0, 100)
            })
          );

        let target =
          visible.find(element => {
            const aria =
              (
                element.getAttribute(
                  'aria-label'
                ) || ''
              ).toLowerCase();

            const placeholder =
              (
                element.getAttribute(
                  'placeholder'
                ) ||
                element.getAttribute(
                  'data-placeholder'
                ) ||
                ''
              ).toLowerCase();

            return (
              aria.includes('meldung') ||
              aria.includes('nachricht') ||
              placeholder.includes('meldung') ||
              placeholder.includes('nachricht')
            );
          });

        if (!target) {
          target =
            visible.find(element => {
              if (
                element.getAttribute(
                  'contenteditable'
                ) !== 'true'
              ) {
                return false;
              }

              const aria =
                (
                  element.getAttribute(
                    'aria-label'
                  ) || ''
                ).toLowerCase();

              const placeholder =
                (
                  element.getAttribute(
                    'placeholder'
                  ) ||
                  element.getAttribute(
                    'data-placeholder'
                  ) ||
                  ''
                ).toLowerCase();

              return (
                !aria.includes('suchen') &&
                !placeholder.includes('suchen')
              );
            });
        }

        if (!target) {
          return {
            found: false,
            details
          };
        }

        target.setAttribute(
          'data-bot-composer',
          'true'
        );

        return {
          found: true,
          tag: target.tagName,
          aria:
            target.getAttribute(
              'aria-label'
            ),
          placeholder:
            target.getAttribute(
              'placeholder'
            ) ||
            target.getAttribute(
              'data-placeholder'
            ),
          role:
            target.getAttribute(
              'role'
            ),
          contenteditable:
            target.getAttribute(
              'contenteditable'
            ),
          details
        };
      });

    console.log(
      '📝 Composer-Diagnose:',
      composerInfo
    );

    if (!composerInfo.found) {
      console.log(
        '❌ Meldungsfeld wurde nicht gefunden.'
      );

      console.log(
        '➡️ Bitte Screenshot vom Abschnitt "Composer-Diagnose" schicken.'
      );

      return;
    }

    console.log(
      '✅ Meldungsfeld gefunden!'
    );


    /*
    ----------------------------------------------------------
    SCHRITT 5 – TESTNACHRICHT EINGEBEN
    ----------------------------------------------------------
    */

    const composer =
      await page.$(
        '[data-bot-composer="true"]'
      );

    if (!composer) {
      console.log(
        '❌ Meldungsfeld konnte nicht ausgewählt werden.'
      );
      return;
    }

    await composer.click();

    await page.keyboard.type(
      TEST_MESSAGE,
      {
        delay: 35
      }
    );

    console.log(
      `⌨️ Text eingegeben: "${TEST_MESSAGE}"`
    );

    await sleep(1500);


    /*
    ----------------------------------------------------------
    SCHRITT 6 – ENTER DRÜCKEN
    ----------------------------------------------------------
    */

    await page.keyboard.press(
      'Enter'
    );

    console.log(
      '📤 ENTER gedrückt.'
    );

    await sleep(3000);

    console.log('================================');
    console.log(
      '🎉 UI-SENDEVERSUCH ABGESCHLOSSEN'
    );
    console.log(
      `➡️ Prüfe jetzt im Kanal, ob "${TEST_MESSAGE}" erschienen ist.`
    );
    console.log('================================');

  } catch (error) {
    console.log('================================');
    console.error(
      '❌ FEHLER IM KANAL-UI-TEST'
    );
    console.error(error);
    console.log('================================');
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
      recursive: true
    }
  );

  console.log(
    '📁 RemoteAuth-Ordner bereit:',
    AUTH_DATA_PATH
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
      '🗄️ Gespeicherte MongoDB-Sitzung vorhanden:',
      exists
    );

  } catch (error) {
    console.log(
      '⚠️ MongoDB-Sitzungsstatus konnte nicht geprüft werden:',
      error.message
    );
  }

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
          '--disable-dev-shm-usage'
        ]
      }
    });


  client.on(
    'code',
    code => {
      console.log('================================');
      console.log(
        '📱 WHATSAPP KOPPLUNGSCODE:'
      );
      console.log(code);
      console.log('================================');
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

      await sleep(5000);

      await runChannelUITest(
        client,
        'READY-Event'
      );
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

  setTimeout(
    async () => {
      if (testStarted) {
        return;
      }

      try {
        const state =
          await client.getState();

        console.log(
          '⏰ 60-Sekunden-Status:',
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
