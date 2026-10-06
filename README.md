# PGBX: customer app, API, admin panel and dealer app

Built against *PGBX Mobile App: Software Requirements Specification (Developer Guide, draft of 2 Oct 2026)*.
Requirement IDs (FR-*, NFR-*, CMP-*) are referenced in the code comments.

| Part | Where | State |
|---|---|---|
| Customer app, **demo build** | `/` (`index.html`, `app.js`) | Live rates, sample customer data in the browser, demo controls. For presentations. |
| Customer app, **production build** | `/live`, and `dist/` for the phone apps | Same screens, every record from the API, no demo shortcuts. Needs the database. |
| API and business rules | `/api/v1` (`server/`, `supabase/migrations/`) | Built and tested. Waits for PGBX's own database (`DATABASE_URL`). |
| Admin panel | `/admin` | Built and tested on the API. |
| Dealer app | `/dealer` | Built and tested on the API. |
| iOS and Android apps | `mobile/` (Capacitor) | Projects generated; building and signing need Xcode, Android Studio and PGBX's store accounts. |

**The deployed site is not connected to any PGBX system yet.** Until `DATABASE_URL` is set, `/live`, `/admin` and
`/dealer` show that PGBX services aren't connected, and the demo at `/` works as before.

## Run it

Everything (demo, production build, API, admin panel, dealer app) on an in-memory database with sample data:

```bash
npm install
npm run dev            # http://localhost:8080  ·  /live  ·  /admin  ·  /dealer
```

The dev server runs the providers in test mode: login code **123456**, sandbox payments and identity checks. It prints
sample staff logins and their authenticator secrets (the current 6-digit code is printed too). Data is lost when it stops.
`npm test` runs the database and API tests (no network or database needed).

Only the demo, as plain static files:

```bash
npx serve .            # or: python3 -m http.server 8080
```

Then open http://localhost:3000 (serve) or http://localhost:8080 (python).
A plain static server has no `/api`, so the page reads live rates from the deployed endpoint
(`https://pgbx-app.vercel.app/api/rates`); if that is unreachable it switches to simulated rates and says so.
`npx vercel dev` runs the function locally.
On a desktop the app shows inside a 390×844 phone frame; at phone width (500 px or less) it fills the screen.

### URL parameters

| Param | Effect |
|---|---|
| `?start=home` | Skip the splash and login and open the Rates home, logged in |
| `?feedFail=1` | Simulate a stale rate feed: shows "Rates are delayed" and disables buying (FR-R4) |
| `?start=login` / `?start=pin` | Open straight on the login or PIN screen |
| `?sim=1` | Use simulated rates instead of the live feed |
| `?kyc=done` | Start with identity already verified (skips the CNIC + selfie step before buying) |

Combine them: `?start=home&feedFail=1`. `?start=home` and `?kyc=done` are demo shortcuts and must not exist in a production build.

## Deploy

```bash
npx vercel --prod
```

`vercel.json` serves the folder as static files plus the functions in `api/`. There is no build step on Vercel;
after changing `index.html` or `app.js`, run `npm run build:app` and commit `live/index.html` (a test checks it is current).
`vercel.json` also runs `/api/v1/cron/sweep` daily (expire unpaid orders and old collection codes, purge closed accounts
after the retention period, send pending push notifications); on a paid plan make it hourly.

## Live rates

`api/rates.mjs` is a Vercel serverless function, so prices are set on the server, never on the phone (Rule 1, FR-R3).
It fetches, with no API keys:

- Spot prices for gold, silver, platinum, palladium and copper from [gold-api.com](https://gold-api.com) (fallback for gold and silver: goldprice.org)
- USD/PKR from [open.er-api.com](https://open.er-api.com) (fallback: fawazahmed0/currency-api), cached for 30 minutes

It converts to PKR per tola (11.664 g) and per gram, applies the sample spread, prices all eleven products
with the sample premiums, and caches the response at the edge for 8 seconds. The app polls it every 10 seconds (FR-R1);
if no update arrives for 30 seconds it shows "Rates are delayed" and blocks buying (FR-R4).
International spot converted at the interbank rate is not the local Sarafa rate; PGBX will supply its own rate source.

`api/history.mjs` serves the day / week / month chart (FR-R5): COMEX gold and silver futures from the Yahoo Finance chart API
(fallback for week and month: Stooq daily closes), converted to PKR per tola at the current USD/PKR rate. If no source answers,
the app says history is unavailable rather than drawing a made-up chart.

## Login codes by SMS or WhatsApp (FR-A1)

The demo uses `api/otp.mjs`; the production build uses `/api/v1/auth/otp/*`, which adds database-backed limits, the optional human check and the login session. Both use the same Twilio settings below.

`api/otp.mjs` sends and checks real one-time codes through [Twilio Verify](https://www.twilio.com/docs/verify).
Twilio generates, sends, expires (10 minutes) and checks the code; the app and this server never see it, and the
provider keys stay on the server (Rule 6). Only Pakistani mobile numbers (+92 30x–34x, 355) are accepted, a number can
request a new code every 30 seconds, and Twilio adds its own rate limits and fraud blocking.

Abuse limits now in place (no extra accounts needed): code requests must come from the app's own pages (Origin check,
JSON only); at most 3 codes per number per hour, 5 code requests per device (IP) per 10 minutes and 20 code checks per
device per 10 minutes. These are kept in each server instance's memory, so they are best effort. **Still to do:** a shared
rate-limit store (for example Vercel KV / Upstash) and a human check (for example Cloudflare Turnstile) before sending,
plus Twilio geo-permissions limited to Pakistan, Fraud Guard and a spending alert.

If the code service cannot be reached, the app shows an error with Retry. Demo mode is used only when the server reports
that no provider is connected.

Until the keys below are set, the login runs in **demo mode**: it says so on screen, sends nothing, and accepts any 6 digits.

Turn on real codes:

1. Create a Twilio account, then in the console create a **Verify service** (Verify → Services).
2. In Vercel → project `pgbx-app` → Settings → Environment Variables, add for Production:
   `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`.
3. Redeploy. The production app (`/live` and the phone apps) then sends real SMS codes through `/api/v1/auth/otp/*`,
   which has the human check and database-backed limits. The demo at `/` only sends real codes if `OTP_DEMO_SMS=1` is
   also set; leave it unset in production, because the demo endpoint's limits are per server instance and could be
   used to run up SMS costs.
4. Recommended in Twilio: restrict SMS geo-permissions to Pakistan and keep Fraud Guard on.

WhatsApp codes: since March 2024 WhatsApp requires the business's own approved WhatsApp Business sender.
Connect PGBX's WhatsApp sender to the Verify service in Twilio, then add `OTP_WHATSAPP=1` and redeploy;
until then the app shows WhatsApp as "soon" and offers SMS. Twilio charges per message and per successful verification.

## Stack

- `index.html` (markup and styles) + `app.js` (the app), no build step
- Preact + htm self-hosted in `vendor/` (licences in `vendor/LICENSES.txt`); no third-party script or font at runtime
- Fonts: Apple's system families, used through CSS system-font keywords (Apple licenses them for Apple platforms only, so
  they are not embedded): **SF Pro** for text and controls (`--sans`), **SF Compact** for tight layouts such as tab labels,
  small caps labels, chips and pills (`--compact`), **SF Mono** for receipt numbers, codes and OTP boxes (`--mono`) and
  **New York** for headings and prices (`--serif`). iPhone, iPad and Mac show the real fonts; Android and Windows fall back to
  Roboto / Segoe UI, Georgia and Consolas. SF Compact appears only where it is installed; elsewhere SF Pro is used.
- One inline SVG icon family (24 px grid, 1.8 px stroke), drawn ingots and the PGBX coin mark

## Design system

All styles live in `index.html` as tokens and one set of components, so every screen is built from the same parts.

| Token | Values |
|---|---|
| Colour | Brand green `#0B4A2C` (primary actions, headings), gold `#C8962B` (metal, accents, focus on dark); warm neutrals (`--bg`, `--surface`, `--fill`, three text levels, two border levels); success, warning, danger and info used only for status |
| Type | New York for screen titles and headline figures; SF Pro 15/1.45 for body, 13 for secondary text, 12 for captions; SF Compact for tags and tab labels; SF Mono for receipt numbers and codes. Weights 400–700 only; tabular numerals throughout |
| Spacing | 4, 8, 12, 16, 20, 24, 32, 40, 48 (16 px side gutter) |
| Radius | 6 tags, 8 thumbnails, 12 buttons and inputs, 16 cards and lists, 24 sheets; nested controls use outer radius minus padding |
| Elevation | `--e1` resting cards, `--e2` floating (tab bar, rate cards), `--e3` overlays (dialogs, toasts) |
| Motion | 120 ms press, 200 ms state, 300 ms screen. Entrances: screen content rises in and list rows cascade, once per screen. Ambient (slow, low intensity): the logo breathes with a glow and a passing light, soft drifting lights on login, light sweeps over bars, the green header and the wallet card, the live dot pulses, the product bar floats. Feedback: prices tint green or red when they move, sliding tab indicator with a small spring, charts draw in, one ring on success. All off under reduced motion |

Components: large title (root tabs), navigation bar (pushed screens), grouped list rows, cards, brand card (wallet value), buttons (primary, secondary, tertiary, danger, accent on dark; with pressed, focus, disabled and loading states), fields with inline errors, segmented control, stepper, radio, switch, tags, notices, empty states, skeletons, sticky action bar, confirmation sheet, toast, push banner and a "Demo" panel that keeps prototype-only controls visibly separate from the product.

Rules the screens follow:
- Requirement IDs (FR-*, CMP-*) are kept in code comments only, never shown to customers.
- Open items appear as plain "[To be confirmed by PGBX]" text where a customer would look for them (fees, collection, sell-back, receipts, terms, support hours). Vendor choices (payment, ID check, SMS/push/email, map providers) and Urdu are listed under Account › About this prototype.
- Checkout and verification hide the tab bar and use a sticky action bar. Consequential actions (log out, cancel collection, reset demo) ask for confirmation.
- Actions the customer just took are confirmed on screen or by a toast and recorded in the inbox quietly; push banners are for things that happen in the background (dealer updates, price alerts, operations).
- Offline state, delayed rates, failed history and service outages each have a plain-language message and a way forward.
- Every control has an accessible name and a 40 px or larger target; focus is visible; `prefers-reduced-motion` and `prefers-reduced-transparency` are respected.

## How the app behaves (UX rules)

- **Back works like a phone app.** The phone's back button, iOS edge swipe and browser back step back through screens. Back closes an open dialog first, steps back inside identity verification, and never leaves a payment in progress.
- **No lost work.** Leaving Personal details, a report or identity verification with unsaved input asks first ("Discard your changes?" / "Keep editing"), whether you leave by the back button, the tab bar or the phone's back gesture. The cart survives closing the app.
- **PIN lifecycle.** The first login asks the customer to create their own PIN (easy PINs like 1234 are refused with a reason). "Forgot PIN?" and five wrong PINs both lead to an SMS login and a new PIN. "Unlock with PIN" only appears once a PIN exists.
- **Guests are told why.** Tapping something that needs an account explains it ("Log in to buy 1 gram Gold.") and returns them there after logging in.
- **Forgiving actions.** Removing a cart item or deleting a price alert shows Undo. Log out, cancel collection, close account and reset demo explain their consequences before confirming.
- **No dead ends.** Notifications open what they're about (a collection, a receipt, a price chart). Empty states say what to do next; errors offer a retry.
- **Slow or no internet.** Requests time out (code sending 15 s, rate history 10 s) with a plain message and a retry, instead of spinning forever; payment and reservations are disabled while offline, with the reason shown and the order kept.
- **Close account** (Account › Your data) lists anything that must happen first (bars still held, open collections, orders being completed) with a button to do it, then explains what closing means before a final confirmation.
- **Notifications** have channels (push, SMS, email) and topics: price alerts can be turned off; purchases, collections and security notices stay on, with the reason given. Actions the customer just took are confirmed on screen, not by a banner.
- **Contextual help.** A one-time note on Rates explains Buy and Sell prices; it stays dismissed.

## Private preview password

`middleware.js` puts the whole site behind a PGBX-branded password screen. To switch it on, add **`SITE_PASSWORD`** in
Vercel (Project → Settings → Environment Variables, Production) and redeploy. To remove it, delete the variable and
redeploy. Until the variable exists the site is open, so a missing setting can't lock everyone out.

- The right password sets an HttpOnly cookie for 30 days. Changing `SITE_PASSWORD` signs everyone out.
- Payment webhooks and the scheduled sweep aren't behind the screen; they have their own signatures and secret.
- The phone apps can't reach the API while the screen is on, so turn it off before testing or releasing them.
- It's a preview lock, not a login: use a long password and share it only with testers.

## Back end

**Database** (`supabase/migrations/20261004000000_pgbx_core.sql`): portable PostgreSQL, ready for Supabase. Business
rules live in SQL functions so no client or server bug can bypass them: price locks from the server's own rate snapshot,
stale prices refuse to lock, identity check before buying, per-order and per-day limits, idempotent orders, a payment
credits exactly once, amount mismatches and late payments go to operations, reservations only against free holdings and
dealer stock, one active code per collection, dealer handover needs the CNIC check and one distinct serial per bar,
expiry, price alerts, account closure with blockers, purge after the retention period, daily reconciliation and
database-wide rate limits. The wallet ledger and the audit log are append-only (triggers reject updates and deletes).
Row-level security is on for every table with no policies, so only the server's connection can read or write.
`supabase/seed.sql` is **sample data for development only**.

**API** (`server/api.mjs`, served as `/api/v1/*` by `api/v1.mjs`): one route per action, each calling one SQL function and
turning error codes into plain language. Customers sign in with an SMS code; the session token (256 random bits, only
its SHA-256 stored) is an HttpOnly, SameSite=Strict cookie on the web or a Bearer token kept in the phone's secure
storage. Staff sign in with a password (scrypt) **and** an authenticator code (TOTP); roles are admin, ops and dealer.
Payment and identity providers report results through HMAC-signed webhooks. Abuse limits are stored in the database,
so they hold across server instances. Every staff action and every look at a customer's details goes to the audit log.

### Environment variables (set in Vercel, never in the code)

| Variable | Purpose | Until it is set |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection. On Supabase use the pooled connection string (port 6543). | API answers "not connected" |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID` | SMS login codes (see below). `OTP_WHATSAPP=1` adds WhatsApp. | No login in production |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | Cloudflare human check before a code is sent | Skipped |
| `PAYMENT_PROVIDER`, `PAYMENT_WEBHOOK_SECRET` | Payment provider and its webhook signing secret. The provider adapter (`server/providers.mjs`) is written once PGBX chooses one. | No payments |
| `KYC_PROVIDER`, `KYC_WEBHOOK_SECRET` | Identity verification provider | No identity checks |
| `FCM_SERVICE_ACCOUNT` | Firebase service account JSON for push to Android and iOS | Notifications stay in the app |
| `SITE_PASSWORD` | Password screen in front of the whole site (see above) | Site open |
| `CRON_SECRET` | Protects the scheduled sweep (Vercel sends it automatically) | Sweep refused |
| `OTP_DEMO_SMS=1` | Lets the demo at `/` send real SMS codes. Leave unset in production. | Demo login stays in demo mode |
| `OTP_TEST_MODE=1`, `PAYMENT_PROVIDER=sandbox`, `KYC_PROVIDER=sandbox` | **Test modes. Never in production.** Code 123456 logs anyone in; payments and checks always pass. | — |

### Connecting PGBX's database

1. Create a Supabase project in **PGBX's own organisation** (region close to Pakistan, e.g. Mumbai), with PGBX billing.
2. Run the migration in `supabase/migrations/` (SQL editor or `supabase db push`). Do **not** run `seed.sql`.
3. Add `DATABASE_URL` (pooled, port 6543) and `CRON_SECRET` in Vercel and redeploy.
4. Create the first administrator: `DATABASE_URL=... npm run staff:create -- --email name@pgbx.pk --name "Full Name" --role admin`.
   It prints a one-time password and an authenticator secret. Everyone else is added in the admin panel.
   New and reset staff must choose their own password (12+ characters) at first sign-in; each authenticator code works
   once. An administrator can reset someone's password and authenticator in Staff → Reset sign-in.
5. In the admin panel: enter dealers and their stock, the real premiums, limits and spread (Settings), and record a vault count.

## $1 gold (buy one dollar at a time, sell any amount)

- **Buying:** each purchase is US$1 converted at the live USD/PKR rate (about Rs 280), buying gold in grams at PGBX's
  buy price at that moment. A customer can buy as many as they like in one payment (up to `micro_max_units`, default
  100), within the daily limit. Every dollar is its own transaction with its own ID, e.g. `PGBX-M-261006-1A2B3C4D`.
  The payment groups them under an order ID (`PGBX-MO-…`). Identity verification is required.
- **Tola lots:** paid transactions from all customers are clubbed, in order, into 1-tola lots (`PGBX-T-000001`,
  `-000002`, …). A transaction that crosses the end of a lot is split between that lot and the next, so every full lot
  is exactly 11.664 g. Each lot keeps the list of transaction IDs in it and the grams each contributed. At today's
  prices a tola takes about 1,550 transactions.
- **Selling:** any amount the customer holds (from 0.001 g) at PGBX's sell price, paid to the customer's IBAN. Each
  sale gets its own ID (`PGBX-MS-…`) and is clubbed into 1-tola sell lots (`PGBX-TS-…`) the same way.
- **Operations (admin panel → $1 gold & tola lots):**
  - Search any transaction, order or lot ID.
  - Open a lot to see every transaction ID in it, or download the full list.
  - Record the tola bar bought for each full buy lot (with its serial) and each tola sold for a full sell lot.
  - Send payouts for sales, and see payments to refund.
- **Rules in the database** (`supabase/migrations/20261007000000_dollar_gold.sql`):
  - Late, wrong or repeated payments are never credited twice. They are marked for refund instead.
  - A customer can't sell more than they hold.
  - Purchases count toward the daily limit.
  - Accounts with $1 gold, or a payout still owed, can't be closed.
  - Prices pause (`RATES_STALE`) if the dollar rate is missing or jumps by more than 10%.

## Services (jewellery worth, doorstep appraisal, gift bullion)

The **Services** tab replaces the old Redeem tab: collecting bars now sits inside it and in Wallet.

- **Jewellery worth** works for guests: estimate = metal weight × fineness of the karat × today's sell price per pure
  gram × (1 − buy-back deduction). Fineness, deductions and everything below are PGBX settings (admin panel → Settings):
  `purity`, `buyback_deduction_pct`, `appraisal_fee_pkr`, `appraisal_cities`, `appraisal_slots`,
  `appraisal_free_cancel_hours`, `gift_making_pkr`, `gift_packaging_pkr`, `gift_delivery_pkr`, `gift_lead_days`,
  `gift_cities`. All current values are **samples** until PGBX sets them.
- **Doorstep appraisal**: booking needs a login but not an identity check. The fee is paid like an order (one payment,
  wrong amounts refused). Each paid booking gets a 4-digit visit code; at most 6 visits per time slot. Customers can
  cancel; the fee is refunded only if it's more than `appraisal_free_cancel_hours` before the visit. Operations
  assigns a goldsmith and records the assay result in **Admin → Doorstep appraisals**; the customer is notified at each step.
- **Gift gold and silver**: buying metal, so identity must be verified, and it counts towards the daily purchase limit.
  The server prices it from its own fresh rate snapshot: metal at the buy price + making (plain or themed, + engraving)
  + packaging + insured delivery. Customers can cancel until production starts. Operations moves orders through
  production, dispatch (courier tracking number required) and delivery in **Admin → Gift orders**.
- Open bookings and gift orders block account closure; purge removes addresses and recipients' details.
- Database: `supabase/migrations/20261006000000_services.sql`. Tests: `tests/services.test.mjs` and `tests/api.test.mjs`.

## Staff tools

- **Admin panel** (`/admin`): overview, identity checks to review, orders waiting for operations (credit or refund with a
  note), customers (search, details, suspend), support requests (reply to the customer's inbox), dealers and stock,
  products and premiums, reconciliation (money and metal, with vault counts), settings, audit log, staff accounts.
  Also: **Doorstep appraisals** (assign goldsmith, record result, cancel) and **Gift orders** (production, dispatch
  with tracking, delivery, cancel).
  Operations staff can't change settings, premiums, dealers' details or staff, or suspend customers.
- **Dealer app** (`/dealer`, phone-first): enter the customer's code, prepare and mark ready, tick the CNIC check,
  record one serial per bar and confirm. Shows today's queue and the counter's stock.

Both are `noindex`, use the same password + authenticator sign-in, and end the session after 12 hours.

## Production build and phone apps

`npm run build:app` writes the production build: `live/index.html` (web, at `/live`) and `dist/` (bundled into the
phone apps, with its own Content-Security-Policy). In the production build there is no demo mode: no demo PIN, demo
panels, sample customer, simulated payments or camera, URL shortcuts or simulated rates (if live prices are down, buying
pauses). Limits and premiums come from PGBX's settings. The PIN is stored only as a salted, stretched hash; no account
records are stored on the phone. In identity verification the app collects the CNIC details and the chosen provider's
own capture screens (CNIC photos and selfie) are added when PGBX picks a provider.

`mobile/` holds the Capacitor 8 projects (`ios/`, `android/`) and `bridge.js`, which connects the app to the session
token in the iOS Keychain / Android Keystore, Face ID / fingerprint unlock, push notifications and the in-app browser for
payment pages. Android backups and cleartext traffic are off.

```bash
cd mobile && npm install
npm run sync            # builds dist/ and copies it into both projects
npm run open:ios        # Xcode (Mac only): set the team, signing, push capability, then Archive
npm run open:android    # Android Studio: add google-services.json for push, create the upload key, then build the bundle
```

Push notifications are **off** in the phone apps until their setup is complete, because registering without Firebase
crashes the Android app. When `google-services.json` is in `mobile/android/app/` (Android) and the Push Notifications
capability is added in Xcode (iOS, which creates `App.entitlements` with `aps-environment`), build with the platforms
listed: `PGBX_PUSH=android,ios npm run sync`. The apps are portrait-only on phones; icons and splash screens are
generated from `favicon.svg`.

Before a store release PGBX needs: Apple and Google developer accounts in PGBX's name, the final bundle ID
(`pk.com.pgbx.app` is a placeholder), a Firebase project for push, store screenshots, and the privacy answers (plus an app-level `PrivacyInfo.xcprivacy` if PGBX
adds code that uses Apple's "required reason" APIs; Capacitor and its plugins ship their own).

## Security headers

`vercel.json` sends a Content-Security-Policy (scripts only from this site, connections only to this site and
`pgbx-app.vercel.app`, no embedding in other sites), `X-Frame-Options: DENY`, `Permissions-Policy`, `Referrer-Policy`,
`X-Content-Type-Options` and `Cross-Origin-Opener-Policy`. The `/api` services send cross-origin (CORS) headers only to the app's own addresses
(production, its previews and localhost), set in `api/_origin.mjs`; this stops other websites from using them in a browser. Keep scripts out of inline `<script>` tags and `on…=` attributes,
or the policy will block them.

## Demo data in the browser

(Demo build only. The production build keeps only device settings on the phone: PIN hash, notification choices, cart.)


The prototype saves its sample data (wallet, orders, cart, profile, verification status, PIN, notifications, alerts) in this
browser's local storage so a refresh does not reset the demo, and a returning user unlocks with the PIN. Account →
**Reset demo data** erases it. Nothing is sent anywhere. A real app keeps this on the server and in the phone's secure storage.
Saved data is checked when the app opens: anything damaged or from an older version is dropped or converted, and the rest
falls back to defaults. If the app ever fails while drawing, a recovery screen offers **Try again** and **Reset demo data**
instead of a blank page. Returning users see a short splash (under 1 s) before the PIN screen; first-time visitors see the mark draw in once (about 2 s).

## What the prototype covers

| Area | Screens | SRS |
|---|---|---|
| Login | Animated splash, mobile number + one-time code login, PIN lock (prototype PIN 1234) with face unlock, 30 s pause after 3 wrong PINs and OTP login required after 5, guest browsing, auto-lock after 2 min | FR-A1, FR-A3, FR-A4, FR-A5 |
| Identity | CNIC details, CNIC front and back capture, selfie, verification before the first purchase; profile edits to name, CNIC or date of birth require re-verification; mobile number change by OTP | FR-A2, FR-N2 |
| Rates | Live gold and silver buy/sell per tola and per gram, rolling-digit prices, change % since opening, sparkline, world spot (platinum, palladium, copper), freshness, delayed state; tap a card for the day/week/month history chart and price alerts | FR-R1–R6 |
| Buy | 11 products, whole-unit stepper, cart mixing gold and silver in one order, 60 s price lock with refresh, per-order (10 units) and per-day (Rs 1,500,000) sample limits, payment choice, receipt; a prototype switch shows payment succeeding but crediting failing, with 3 retries, hand-off to operations and later credit | FR-P1–P7, FR-B1–B8 |
| Wallet | Holdings by product count, weights, sell value, reserved units, pending credits, history from an append-only ledger, statement for a chosen period as CSV or printable PDF | FR-W1–W4 |
| Services | **Jewellery worth** (free, no login): karat and weight in grams, tola or tola-masha-ratti, stones deducted, several pieces, buy-back estimate from the live sell price minus a deduction. **Doorstep appraisal**: pieces, day and time slot, address, fee payment, 4-digit visit code the goldsmith must say at the door, goldsmith details, assay report, cancellation rules. **Gift gold and silver**: bars and coins made to order (weight, coin or bar, design, engraving, card, packaging), live preview, recipient and delivery date, price breakdown, tracking from order to delivery. **Collect your bars** (below) | — |
| Collect (in Services and Wallet) | Product and quantity, schematic dealer map, 4 sample dealers with area, hours, distance and stock, call and directions, 6-digit collection code, 24 h expiry, status steps, cancel with confirmation, dealer simulation (ready, ID check, hand over with serials) | FR-D1–D9 |
| Account | Profile, identity verification, security (change PIN, Face ID, auto-lock), notifications inbox and notification settings, price alerts, questions and answers, contact, report a problem, fees and limits, terms and privacy, About this prototype (live vs sample data, open items, reset demo) | FR-N1–N4 |

The table describes the demo build. The dealer interface (FR-DL1–6) and the admin panel (FR-M1–10) are at `/dealer` and
`/admin`, and work with the production build through the API; in the demo the redemption screen simulates the dealer's steps.

## Sample data vs. real data

Live:
- Gold, silver, platinum, palladium and copper spot prices, and USD/PKR.

Sample or simulated:
- If the live feed is unreachable, rates fall back to the Pakistan Sarafa 24K rate of 1 Oct 2026 (gold Rs 438,636/tola, silver Rs 6,528/tola) with random ticks, labelled "Simulated".
- Sell prices use a sample spread (gold 1.2 %, silver 2.5 %).
- Login: real SMS / WhatsApp codes once Twilio is connected (see above); until then demo mode accepts any 6 digits and sends nothing. The PIN is 1234 until changed.
- Identity verification always passes; no camera is used and no image is taken.
- Dealer phone numbers, coordinates and the customer's location (Saddar) are samples; the map is a schematic drawing.
- Notifications appear in the app only; nothing is sent by push, SMS or email.
- Purchase limits (10 units per order, Rs 1,500,000 per day) are samples.
- Product premiums, the 10-unit per-order limit, the customer (Ahmed Khan), opening holdings (2 × 1 tola silver, 1 × 1 g gold), the four dealers and their stock.
- Payments always succeed after about 1.8 s. Receipt numbers, collection codes and serial numbers are generated locally.

Shown as "[To be confirmed by PGBX]" (open questions in Section 10 and related FRs):
- Which rate source PGBX will use for its local buy and sell prices, and the real spread
- Redemption fee or making charge, and who pays the dealer
- Whether redemption differs for gold and silver
- Whether sell-back to PGBX is in version 1 (FR-W6)
- Storage fee or time limit for holdings (FR-W7)
- Minimum purchase and per-day limits
- Which payment channels are enabled and the ID-verification provider
- Push, SMS and email providers, and the map provider
- Dealer stock model (all eleven products at every dealer, or reservation with delivery)
- Urdu at launch
- Terms, privacy policy, Shariah approval and tax details on receipts (CMP-3, CMP-5, CMP-6, CMP-7)
