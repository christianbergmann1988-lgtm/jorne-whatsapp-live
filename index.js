const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const WEB_VERSION = '2.3000.1031490220-alpha';

const CHANNEL_NAME = 'Jorne_L1ve';
const TEST_MESSAGE = 'BOT-TEST AUTOMATISCH';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function startBot() {
  console.log('Verbinde mit MongoDB...');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ MongoDB verbunden.');

  const store = new MongoStore({ mongoose });

  const client = new Client({
    webVersion: WEB_VERSION,

    webVersionCache: {
      type: 'remote',
      remotePath:
        'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1031490220-alpha.html'
    },

    authStrategy: new RemoteAuth({
      clientId: 'jorne-whatsapp-live',
      store,
      dataPath: '.',
      backupSyncIntervalMs: 60000
    }),

    pairWithPhoneNumber: {
      phoneNumber: process.env.WHATSAPP_PHONE,
      showNotification: true,
      intervalMs: 180000
    },

    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    }
  });

  client.on('code', (code) => {
    console.log('================================');
    console.log('📱 WHATSAPP KOPPLUNGSCODE:');
    console.log(code);
    console.log('================================');
  });

  client.on('authenticated', () => {
    console.log('✅ WhatsApp erfolgreich angemeldet.');
  });

  client.on('remote_session_saved', () => {
    console.log(
      '💾 WhatsApp-Sitzung wurde in MongoDB gespeichert.'
    );
  });

  client.on('auth_failure', (msg) => {
    console.error(
      '❌ WhatsApp-Anmeldung fehlgeschlagen:',
      msg
    );
  });

  client.on('disconnected', (reason) => {
    console.log(
      '⚠️ WhatsApp getrennt:',
      reason
    );
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp-Bot ist bereit.');

    try {
      const version = await client.getWWebVersion();

      console.log(
        '📦 Tatsächlich verwendete WhatsApp-Web-Version:',
        version
      );
    } catch (error) {
      console.log(
        '⚠️ WhatsApp-Web-Version konnte nicht gelesen werden.'
      );
    }

    const page = client.pupPage;

    if (!page) {
      console.error(
        '❌ Puppeteer-Seite wurde nicht gefunden.'
      );
      return;
    }

    console.log('🌐 WhatsApp-Web-Oberfläche wird geprüft...');

    await sleep(5000);

    /*
     * SCHRITT 1:
     * Versuchen, den Bereich "Kanäle" zu öffnen.
     */
    console.log('🔎 Suche den Bereich "Kanäle"...');

    const channelsOpened = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('*')];

      const candidate = elements.find(el => {
        const text = el.textContent?.trim();
        const aria = el.getAttribute('aria-label')?.trim();

        return (
          text === 'Kanäle' ||
          aria === 'Kanäle' ||
          aria?.includes('Kanäle')
        );
      });

      if (!candidate) {
        return false;
      }

      const clickable =
        candidate.closest(
          'button,[role="button"],[tabindex]'
        ) || candidate;

      clickable.click();

      return true;
    });

    if (channelsOpened) {
      console.log('✅ Bereich "Kanäle" angeklickt.');
    } else {
      console.log(
        '⚠️ Schaltfläche "Kanäle" wurde nicht gefunden.'
      );
      console.log(
        '➡️ Suche den Kanal trotzdem direkt in der Oberfläche.'
      );
    }

    await sleep(5000);

    /*
     * SCHRITT 2:
     * Jorne_L1ve über sichtbaren Text bzw. aria-label finden.
     */
    console.log(
      `🔎 Suche WhatsApp-Kanal "${CHANNEL_NAME}"...`
    );

    const channelOpened = await page.evaluate(
      (channelName) => {
        const elements = [
          ...document.querySelectorAll('*')
        ];

        const candidate = elements.find(el => {
          const text = el.textContent?.trim();
          const aria = el.getAttribute('aria-label')?.trim();

          return (
            text === channelName ||
            aria === `Kanal ${channelName}` ||
            aria?.includes(`Kanal ${channelName}`)
          );
        });

        if (!candidate) {
          return false;
        }

        const clickable =
          candidate.closest(
            'button,[role="button"],[role="listitem"],[tabindex]'
          ) || candidate;

        clickable.click();

        return true;
      },
      CHANNEL_NAME
    );

    if (!channelOpened) {
      console.error(
        `❌ Kanal "${CHANNEL_NAME}" wurde in der WhatsApp-Web-Oberfläche nicht gefunden.`
      );

      const diagnostics = await page.evaluate(() => {
        return [...document.querySelectorAll('[aria-label]')]
          .map(el => el.getAttribute('aria-label'))
          .filter(Boolean)
          .filter(value =>
            value.toLowerCase().includes('kanal')
          )
          .slice(0, 30);
      });

      console.log(
        '🔍 Gefundene Kanal-Aria-Labels:',
        diagnostics
      );

      return;
    }

    console.log(
      `✅ Kanal "${CHANNEL_NAME}" wurde geöffnet.`
    );

    await sleep(5000);

    /*
     * SCHRITT 3:
     * Eingabefeld des geöffneten Kanals suchen.
     */
    console.log(
      '🔎 Suche das Eingabefeld für eine Kanalmeldung...'
    );

    const editorFound = await page.evaluate(() => {
      const editors = [
        ...document.querySelectorAll(
          '[contenteditable="true"]'
        )
      ];

      const editor = editors.find(el => {
        const aria =
          el.getAttribute('aria-label') || '';

        const placeholder =
          el.getAttribute('data-placeholder') || '';

        const text =
          `${aria} ${placeholder}`.toLowerCase();

        return (
          text.includes('meldung') ||
          text.includes('message')
        );
      }) || editors.at(-1);

      if (!editor) {
        return false;
      }

      editor.setAttribute(
        'data-bot-target',
        'channel-editor'
      );

      editor.focus();

      return true;
    });

    if (!editorFound) {
      console.error(
        '❌ Eingabefeld des Kanals wurde nicht gefunden.'
      );

      const editorDiagnostics =
        await page.evaluate(() => {
          return [
            ...document.querySelectorAll(
              '[contenteditable="true"]'
            )
          ].map(el => ({
            aria:
              el.getAttribute('aria-label'),
            placeholder:
              el.getAttribute(
                'data-placeholder'
              )
          }));
        });

      console.log(
        '🔍 Gefundene Eingabefelder:',
        editorDiagnostics
      );

      return;
    }

    console.log('✅ Eingabefeld gefunden.');

    /*
     * SCHRITT 4:
     * Testnachricht schreiben.
     */
    const selector =
      '[data-bot-target="channel-editor"]';

    await page.click(selector);

    await page.keyboard.type(
      TEST_MESSAGE,
      { delay: 50 }
    );

    await sleep(1000);

    console.log(
      `✍️ Testtext eingetragen: "${TEST_MESSAGE}"`
    );

    /*
     * SCHRITT 5:
     * Enter drücken und damit posten.
     */
    await page.keyboard.press('Enter');

    console.log('📤 Enter gedrückt.');

    await sleep(5000);

    /*
     * SCHRITT 6:
     * Prüfen, ob die Meldung anschließend sichtbar ist.
     */
    const messageVisible = await page.evaluate(
      (testMessage) => {
        return [
          ...document.querySelectorAll('*')
        ].some(
          el =>
            el.textContent?.trim() ===
            testMessage
        );
      },
      TEST_MESSAGE
    );

    console.log('================================');

    if (messageVisible) {
      console.log(
        '🎉 TEST ERFOLGREICH!'
      );
      console.log(
        `✅ "${TEST_MESSAGE}" ist im Kanal sichtbar.`
      );
    } else {
      console.log(
        '⚠️ Enter wurde ausgeführt, aber die Testmeldung konnte anschließend nicht eindeutig im DOM bestätigt werden.'
      );
    }

    console.log('================================');
  });

  console.log(
    `Starte WhatsApp mit festgelegter Web-Version ${WEB_VERSION}...`
  );

  await client.initialize();
}

startBot().catch((error) => {
  console.error('❌ Startfehler:', error);
  process.exit(1);
});
