// Native features for the production app, loaded only inside the Capacitor app (dist/index.html).
// Exposes window.PGBXNative for app.js and live.js:
//   secure     the session token in the iOS Keychain / Android Keystore (capacitor-secure-storage-plugin)
//   biometric  Face ID, Touch ID or fingerprint to unlock (@capgo/capacitor-native-biometric)
//   push       FCM / APNs registration and taps on notifications (@capacitor/push-notifications)
//   openUrl    payment pages in the in-app browser (@capacitor/browser)
//   saveFile   statements through the share sheet (@capacitor/filesystem, @capacitor/share)
// Android's back button walks back through the app's screens (@capacitor/app).
const C = window.Capacitor;
if (C && C.isNativePlatform && C.isNativePlatform()) {
  const P = C.Plugins;
  const native = {};

  if (P.SecureStoragePlugin) {
    native.secure = {
      get: key => P.SecureStoragePlugin.get({ key }).then(r => r.value, () => null),
      set: (key, value) => P.SecureStoragePlugin.set({ key, value }),
      remove: key => P.SecureStoragePlugin.remove({ key }).catch(() => {}),
    };
  }

  if (P.NativeBiometric) {
    // kind: 'face' (Face ID / face unlock), 'touch' (Touch ID / fingerprint) or 'any', for the right label in the app
    native.biometric = { ready: false, kind: 'any', verify: reason => P.NativeBiometric.verifyIdentity({ reason, title: 'PGBX' }).then(() => true, () => false) };
    P.NativeBiometric.isAvailable().then(r => {
      native.biometric.ready = !!r.isAvailable;
      native.biometric.kind = r.biometryType === 2 || r.biometryType === 4 ? 'face' : r.biometryType === 1 || r.biometryType === 3 ? 'touch' : 'any';
    }, () => {});
  }

  // Push is switched on per platform at build time (PGBX_PUSH=android,ios npm run build:app) only once Firebase
  // (google-services.json) or the APNs entitlement is in place: registering without them crashes the Android app.
  const PUSH_ON = '__PGBX_PUSH__'.split(',').map(x => x.trim()).includes(C.getPlatform());
  if (P.PushNotifications && PUSH_ON) {
    let listening = false, handler = null;
    native.push = {
      token: null,                     // this phone's push token, sent on logout so the server stops using it
      // Called on every sign-in: the token goes to whichever customer is signed in now
      async register(onToken) {
        handler = onToken;
        if (native.push.token) { handler({ token: native.push.token, platform: C.getPlatform() }); return; }
        const perm = await P.PushNotifications.requestPermissions().catch(() => ({ receive: 'denied' }));
        if (perm.receive !== 'granted') return;
        if (!listening) {
          listening = true;
          P.PushNotifications.addListener('registration', t => { native.push.token = t.value; if (handler) handler({ token: t.value, platform: C.getPlatform() }); });
          P.PushNotifications.addListener('pushNotificationActionPerformed', a => {
            let link = null;
            try { link = JSON.parse((a.notification.data && a.notification.data.link) || 'null'); } catch (e) { }
            if (link) window.dispatchEvent(new CustomEvent('pgbx-open-link', { detail: link }));
          });
        }
        await P.PushNotifications.register();
      },
    };
  }

  // Statements: written to the app's cache folder, then the share sheet lets the customer keep it (Files, Drive, email...)
  if (P.Filesystem && P.Share) {
    native.saveFile = async (name, type, text) => {
      const f = await P.Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
      try { await P.Share.share({ title: name, url: f.uri, dialogTitle: 'Save your statement' }); return true; }
      catch (e) { if (/cancel/i.test((e && e.message) || '')) return false; throw e; }
    };
  }

  if (P.Browser) {
    native.openUrl = url => P.Browser.open({ url, presentationStyle: 'popover' });
    // Closing a payment page: the app refreshes at once to show the result
    P.Browser.addListener('browserFinished', () => window.dispatchEvent(new Event('pgbx-browser-closed')));
  }

  if (P.App) {
    P.App.addListener('backButton', ({ canGoBack }) => { if (canGoBack) history.back(); else P.App.minimizeApp(); });
    // Background and back: the app locks itself after a short time away (see app.js)
    P.App.addListener('pause', () => window.dispatchEvent(new Event('pgbx-pause')));
    P.App.addListener('resume', () => window.dispatchEvent(new Event('pgbx-resume')));
  }

  window.PGBXNative = native;
}
