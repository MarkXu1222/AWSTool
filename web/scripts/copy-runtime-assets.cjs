const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'dist/server/scripts');
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(root, 'server/scripts/root-email-ocr.py'), path.join(target, 'root-email-ocr.py'));
