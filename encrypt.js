const crypto = require('crypto');
const fs = require('fs');

const keyFile = process.argv[2];
const secretFile = process.argv[3];

const publicKeyB64 = fs.readFileSync(keyFile, 'utf-8').trim();
const secret = fs.readFileSync(secretFile, 'utf-8').trim();

const key = Buffer.from(publicKeyB64, 'base64');
const publicKey = crypto.createPublicKey({ key, type: 'spki', format: 'der' });
const buffer = Buffer.from(secret, 'utf-8');
const encrypted = crypto.publicEncrypt(
  { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' },
  buffer
);
process.stdout.write(encrypted.toString('base64'));
