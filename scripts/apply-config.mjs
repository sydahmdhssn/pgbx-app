// One place for the app's identity: app.config.json. This writes it into every file that needs it, so a new app ID,
// domain or version is one edit plus `npm run build:app` (which runs this first).
//
//   name, fullName   the app's name on the phone and in the store / web manifest
//   appId            the bundle ID (iOS) and application ID (Android). It can't change after the first store upload.
//   apiOrigin        where the phone apps and the production web app send API calls (https, no path)
//   version, build   the version people see (1.2.0) and the build number each store upload must increase
//   termsVersion     the version of legal/terms.html and legal/privacy.html; raise it when they change and every
//                    customer is asked to accept them again
//
// The Android Java package (namespace, MainActivity) stays pk.com.pgbx.app: it is internal and never shown.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.config.json'), 'utf8'));
const bad = [];
if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(config.appId)) bad.push('appId must look like pk.com.company.app');
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(config.apiOrigin)) bad.push('apiOrigin must be an https origin without a path');
if (!/^\d+\.\d+\.\d+$/.test(config.version)) bad.push('version must look like 1.2.0');
if (!Number.isInteger(config.build) || config.build < 1) bad.push('build must be a whole number from 1');
if (!config.name || !config.fullName) bad.push('name and fullName are required');
if (!/^[0-9A-Za-z._-]{1,20}$/.test(config.termsVersion || '')) bad.push('termsVersion must be a short version like 1.0');
if (bad.length) { console.error('app.config.json: ' + bad.join('; ')); process.exit(1); }

const changed = [];
function edit(rel, fn) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) return;
  const before = fs.readFileSync(f, 'utf8'), after = fn(before);
  if (after !== before) { fs.writeFileSync(f, after); changed.push(rel); }
}
const { appId, apiOrigin, version, build, name, fullName, termsVersion } = config;
const xml = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, "\\'");   // Android string resources
const plistText = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const reEsc = v => v.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// web: the deployed site's security policy, the demo's fallback rates server, the production fallback API
edit('vercel.json', s => s.replace(/connect-src 'self' https:\/\/[^;\s"]+/g, `connect-src 'self' ${apiOrigin}`));
edit('live.js', s => s.replace(/meta\('pgbx-api'\) \|\| '[^']+'/, `meta('pgbx-api') || '${apiOrigin}'`));
edit('app.js', s => s.replace(/const TERMS_VERSION = '[^']*'/, `const TERMS_VERSION = '${termsVersion}'`).replace(/new Set\(\['', 'https:\/\/[^']+'\]\)/, `new Set(['', '${apiOrigin}'])`).replace(/const APP_VERSION = LIVE \? '[^']+'/, `const APP_VERSION = LIVE ? '${version}'`));
edit('manifest.webmanifest', s => JSON.stringify({ ...JSON.parse(s), name: fullName, short_name: name }, null, 2) + '\n');
// phone apps
edit('mobile/capacitor.config.json', s => JSON.stringify({ ...JSON.parse(s), appId, appName: name }, null, 2) + '\n');
edit('mobile/android/app/build.gradle', s => s.replace(/applicationId "[^"]+"/, `applicationId "${appId}"`)
  .replace(/findProperty\('versionCode'\) \?: '\d+'/, `findProperty('versionCode') ?: '${build}'`)
  .replace(/findProperty\('versionName'\) \?: '[^']+'/, `findProperty('versionName') ?: '${version}'`));
edit('mobile/android/app/src/main/res/values/strings.xml', s => s.replace(/(<string name="(?:package_name|custom_url_scheme)">)[^<]+/g, `$1${appId}`)
  .replace(/(<string name="(?:app_name|title_activity_main)">)[^<]+/g, `$1${xml(name)}`));
edit('mobile/ios/App/App/Info.plist', s => s.replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*/, `$1${plistText(name)}`));
// the API also accepts browser calls from its own domain (pages such as a PGBX marketing site on that host)
edit('api/_origin.mjs', s => s.replace(/(const OWN = )\/[^\n]*\/;/, `$1/^${reEsc(apiOrigin)}$/;`));
edit('mobile/ios/App/App.xcodeproj/project.pbxproj', s => s.replace(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`)
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${version};`).replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`));

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(changed.length ? 'Updated: ' + changed.join(', ') : 'Everything already matches app.config.json');
