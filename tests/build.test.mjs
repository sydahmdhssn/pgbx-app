// The production web app (live/index.html) is generated from index.html; this catches a forgotten `npm run build:app`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const style = f => fs.readFileSync(f, 'utf8').match(/<style>[\s\S]*<\/style>/)[0];
const body = f => fs.readFileSync(f, 'utf8').match(/<body>[\s\S]*<\/body>/)[0].replace(/<div class="page-caption">[^<]*<\/div>\n?/, '').replace(/src="\/?app\.js"/, 'src="app.js"');

test('live/index.html is up to date with index.html', () => {
  assert.equal(style('live/index.html'), style('index.html'), 'run npm run build:app');
  assert.equal(body('live/index.html'), body('index.html'), 'run npm run build:app');
  const live = fs.readFileSync('live/index.html', 'utf8');
  assert.match(live, /<meta name="pgbx-build" content="production">/);
  assert.doesNotMatch(live, /prototype/i);
});
