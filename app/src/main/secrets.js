'use strict';
// Workstream environment values are stored encrypted with Electron's safeStorage
// (DPAPI, tied to the current Windows user). Values never go to the renderer; they are
// decrypted only to write a session's settings file or to start a shell.
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch {}

function available() {
  return !!(safeStorage && safeStorage.isEncryptionAvailable());
}
function encrypt(value) {
  if (!available()) throw new Error('Encrypted storage is not available, so values cannot be saved.');
  return safeStorage.encryptString(value).toString('base64');
}
function decrypt(b64) {
  if (!available()) throw new Error('Encrypted storage is not available.');
  return safeStorage.decryptString(Buffer.from(b64, 'base64'));
}

module.exports = { encrypt, decrypt, available };
