# PGBX customer app: clickable prototype

A single-file, no-build prototype of the PGBX customer mobile app, built against
*PGBX Mobile App: Software Requirements Specification (Developer Guide, draft of 2 Oct 2026)*.
Requirement IDs (FR-*, NFR-*, CMP-*) are referenced in the UI and the code comments.

**Gold and silver rates are live (international spot converted to PKR). Customer, wallet, dealer and fee data is sample data. It is not connected to any PGBX system.**

## Run it

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

`vercel.json` serves the folder as static files. No build step.

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
3. Redeploy. The login switches to real SMS codes automatically.
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

## Security headers

`vercel.json` sends a Content-Security-Policy (scripts only from this site, connections only to this site and
`pgbx-app.vercel.app`, no embedding in other sites), `X-Frame-Options: DENY`, `Permissions-Policy`, `Referrer-Policy`,
`X-Content-Type-Options` and `Cross-Origin-Opener-Policy`. The `/api` services send cross-origin (CORS) headers only to the app's own addresses
(production, its previews and localhost), set in `api/_origin.mjs`; this stops other websites from using them in a browser. Keep scripts out of inline `<script>` tags and `on…=` attributes,
or the policy will block them.

## Demo data in the browser

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
| Redeem | Product and quantity, schematic dealer map, 4 sample dealers with area, hours, distance and stock, call and directions, 6-digit collection code, 24 h expiry, status steps, cancel with confirmation, dealer simulation (ready, ID check, hand over with serials) | FR-D1–D9 |
| Account | Profile, identity verification, security (change PIN, Face ID, auto-lock), notifications inbox and notification settings, price alerts, questions and answers, contact, report a problem, fees and limits, terms and privacy, About this prototype (live vs sample data, open items, reset demo) | FR-N1–N4 |

Not in this prototype: the dealer interface (FR-DL1–6) and the admin panel (FR-M1–10) are separate products; the redemption screen only simulates the dealer's steps. Back-end rules (daily reconciliation, audit log, security, backups) need the real platform.

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
