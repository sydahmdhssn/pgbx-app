// Native features for the production app, loaded only inside the Capacitor app (dist/index.html).
// Exposes window.PGBXNative for app.js and live.js:
//   secure     the session token in the iOS Keychain / Android Keystore (capacitor-secure-storage-plugin)
//   biometric  Face ID, Touch ID or fingerprint to unlock (@capgo/capacitor-native-biometric)
//   push       FCM / APNs registration and taps on notifications (@capacitor/push-notifications)
//   openUrl    payment pages in the in-app browser (@capacitor/browser)
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
    native.biometric = { ready: false, verify: reason => P.NativeBiometric.verifyIdentity({ reason, title: 'PGBX' }).then(() => true, () => false) };
    P.NativeBiometric.isAvailable().then(r => { native.biometric.ready = !!r.isAvailable; }, () => {});
  }

  // Push is switched on per platform at build time (PGBX_PUSH=android,ios npm run build:app) only once Firebase
  // (google-services.json) or the APNs entitlement is in place: registering without them crashes the Android app.
  const PUSH_ON = '__PGBX_PUSH__'.split(',').map(x => x.trim()).includes(C.getPlatform());
  if (P.PushNotifications && PUSH_ON) {
    let registered = false;
    native.push = {
      async register(onToken) {
        if (registered) return; registered = true;
        const perm = await P.PushNotifications.requestPermissions().catch(() => ({ receive: 'denied' }));
        if (perm.receive !== 'granted') return;
        P.PushNotifications.addListener('registration', t => onToken({ token: t.value, platform: C.getPlatform() }));
        P.PushNotifications.addListener('pushNotificationActionPerformed', a => {
          let link = null;
          try { link = JSON.parse((a.notification.data && a.notification.data.link) || 'null'); } catch (e) { }
          if (link) window.dispatchEvent(new CustomEvent('pgbx-open-link', { detail: link }));
        });
        await P.PushNotifications.register();
      },
    };
  }

  if (P.Browser) native.openUrl = url => P.Browser.open({ url, presentationStyle: 'popover' });

  if (P.App) {
    P.App.addListener('backButton', ({ canGoBack }) => { if (canGoBack) history.back(); else P.App.minimizeApp(); });
  }

  window.PGBXNative = native;
}
