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
