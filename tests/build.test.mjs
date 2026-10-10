// The production web app (live/index.html) is generated from index.html; this catches a forgotten `npm run build:app`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const style = f => fs.readFileSync(f, 'utf8').match(/<style>[\s\S]*<\/style>/)[0];
const body = f => fs.readFileSync(f, 'utf8').match(/<body>[\s\S]*<\/body>/)[0].replace(/<div class="page-caption">[^<]*<\/div>\n?/, '').replace(/src="(\/live\/)?app\.js"/, 'src="app.js"');

test('live/index.html is up to date with index.html', () => {
  assert.equal(style('live/index.html'), style('index.html'), 'run npm run build:app');
  assert.equal(body('live/index.html'), body('index.html'), 'run npm run build:app');
  const live = fs.readFileSync('live/index.html', 'utf8');
  assert.match(live, /<meta name="pgbx-build" content="production">/);
  assert.doesNotMatch(live, /prototype/i);
});

test('the production bundle (live/app.js) was built from the current sources', () => {
  const hash = crypto.createHash('sha256').update(['app.js', 'live.js', 'vendor/htm-preact-standalone-3.1.1.module.js'].map(f => fs.readFileSync(f, 'utf8')).join('\0')).digest('hex').slice(0, 16);
  const head = fs.readFileSync('live/app.js', 'utf8').slice(0, 300);
  assert.match(head, new RegExp('source ' + hash), 'run npm run build:app');
  assert.doesNotMatch(fs.readFileSync('live/app.js', 'utf8'), /\?start=home|kyc=done|Demo PIN/, 'demo shortcuts left in the production bundle');
});
