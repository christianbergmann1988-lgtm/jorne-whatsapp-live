const mongoose = require('mongoose');
const { MongoStore } = require('wwebjs-mongo');
const { Client, RemoteAuth } = require('whatsapp-web.js');

const WEB_VERSION = '2.3000.1031490220-alpha';
const CHANNEL_NAME = 'Jorne_L1ve';

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
    console.log('💾 WhatsApp-Sitzung wurde in MongoDB gespeichert.');
  });

  client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp-Anmeldung fehlgeschlagen:', msg);
  });

  client.on('disconnected', (reason) => {
    console.log('⚠️ WhatsApp getrennt:', reason);
  });

  client.on('ready', async () => {
    console.log('✅ WhatsApp-Bot ist bereit.');

    try {
      const version = await client.getWWebVersion();
      console.log(
        '📦 Tatsächlich verwendete WhatsApp-Web-Version:',
        version
      );
    } catch {
      console.log('⚠️ Web-Version konnte nicht gelesen werden.');
    }

    const page = client.pupPage;

    if (!page) {
      console.error('❌ Puppeteer-Seite wurde nicht gefunden.');
      return;
    }

    await sleep(5000);

    console.log('🔎 Suche Bereich "Kanäle"...');

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

    console.log(
      channelsOpened
        ? '✅ Bereich "Kanäle" angeklickt.'
        : '⚠️ Bereich "Kanäle" wurde nicht gefunden.'
    );

    await sleep(5000);

    console.log(`🔎 Suche Kanal "${CHANNEL_NAME}"...`);

    const channelOpened = await page.evaluate(
      (channelName) => {
        const elements = [...document.querySelectorAll('*')];

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
      console.error(`❌ Kanal "${CHANNEL_NAME}" wurde nicht gefunden.`);
      return;
    }

    console.log(`✅ Kanal "${CHANNEL_NAME}" wurde geöffnet.`);

    await sleep(7000);

    console.log('🔎 Untersuche mögliche Eingabefelder...');

    const diagnostics = await page.evaluate(() => {
      const selectors = [
        'textarea',
        'input',
        '[contenteditable]',
        '[role="textbox"]',
        '[aria-label]',
        '[data-testid]',
        '[data-placeholder]'
      ];

      const elements = [
        ...new Set(
          selectors.flatMap(selector =>
            [...document.querySelectorAll(selector)]
          )
        )
      ];

      return elements
        .map((el, index) => ({
          index,
          tag: el.tagName,
          type: el.getAttribute('type'),
          role: el.getAttribute('role'),
          contenteditable: el.getAttribute('contenteditable'),
          aria: el.getAttribute('aria-label'),
          testid: el.getAttribute('data-testid'),
          placeholder:
            el.getAttribute('placeholder') ||
            el.getAttribute('data-placeholder'),
          text:
            (el.innerText || el.textContent || '')
              .trim()
              .slice(0, 120),
          visible: !!(
            el.offsetWidth ||
            el.offsetHeight ||
            el.getClientRects().length
          )
        }))
        .filter(item =>
          item.visible &&
          (
            item.tag === 'TEXTAREA' ||
            item.tag === 'INPUT' ||
            item.role === 'textbox' ||
            item.contenteditable !== null ||
            item.aria ||
            item.testid ||
            item.placeholder
          )
        )
        .slice(0, 100);
    });

    console.log('================================');
    console.log('🔍 DIAGNOSE DER SICHTBAREN ELEMENTE');
    console.log('================================');

    diagnostics.forEach(item => {
      console.log('---');
      console.log('Index:', item.index);
      console.log('Tag:', item.tag);
      console.log('Type:', item.type);
      console.log('Role:', item.role);
      console.log('Contenteditable:', item.contenteditable);
      console.log('ARIA:', item.aria);
      console.log('TestID:', item.testid);
      console.log('Placeholder:', item.placeholder);
      console.log('Text:', item.text);
    });

    console.log('================================');
    console.log('✅ Diagnose abgeschlossen.');
    console.log('➡️ Noch keine Nachricht wurde gesendet.');
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
