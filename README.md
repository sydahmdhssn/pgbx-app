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
| `?api=https://host` | Read live rates and history from another deployment's `/api/rates` and `/api/history` |
| `?kyc=done` | Start with identity already verified (skips the CNIC + selfie step before buying) |

Combine them: `?start=home&feedFail=1`.

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

## Stack

- `index.html` only: Preact + htm as an ES module from jsDelivr, Google Fonts (Lora, Lato)
- Inline SVG icons, metallic ingots and the PGBX coin logo
- Motion uses transform and opacity with `cubic-bezier(.22,1,.36,1)` and respects `prefers-reduced-motion`

## What the prototype covers

| Area | Screens | SRS |
|---|---|---|
| Login | Animated splash, mobile number + one-time code login, PIN lock (prototype PIN 1234) with face unlock, 30 s pause after 3 wrong PINs and OTP login required after 5, guest browsing, auto-lock after 2 min | FR-A1, FR-A3, FR-A4, FR-A5 |
| Identity | CNIC details, CNIC front and back capture, selfie, verification before the first purchase; profile edits to name, CNIC or date of birth require re-verification; mobile number change by OTP | FR-A2, FR-N2 |
| Rates | Live gold and silver buy/sell per tola and per gram, rolling-digit prices, change % since opening, sparkline, world spot (platinum, palladium, copper), freshness, delayed state; tap a card for the day/week/month history chart and price alerts | FR-R1–R6 |
| Buy | 11 products, whole-unit stepper, cart mixing gold and silver in one order, 60 s price lock with refresh, per-order (10 units) and per-day (Rs 1,500,000) sample limits, payment choice, receipt; a prototype switch shows payment succeeding but crediting failing, with 3 retries, hand-off to operations and later credit | FR-P1–P7, FR-B1–B8 |
| Wallet | Holdings by product count, weights, sell value, reserved units, pending credits, history from an append-only ledger, statement for a chosen period as CSV or printable PDF | FR-W1–W4 |
| Redeem | Product and units, schematic dealer map, 4 sample dealers with address, phone, hours, distance and stock, directions link, 6-digit code, 24 h expiry, status, cancel, dealer simulation (ready, ID check, hand over with serials) | FR-D1–D9 |
| Account | Verification status, personal details, notifications inbox with push / SMS / email settings and in-app push banners, change PIN, biometric toggle, FAQs, contact, report a problem, fee schedule, terms | FR-N1–N4 |

Not in this prototype: the dealer interface (FR-DL1–6) and the admin panel (FR-M1–10) are separate products; the redemption screen only simulates the dealer's steps. Back-end rules (daily reconciliation, audit log, security, backups) need the real platform.

## Sample data vs. real data

Live:
- Gold, silver, platinum, palladium and copper spot prices, and USD/PKR.

Sample or simulated:
- If the live feed is unreachable, rates fall back to the Pakistan Sarafa 24K rate of 1 Oct 2026 (gold Rs 438,636/tola, silver Rs 6,528/tola) with random ticks, labelled "Simulated".
- Sell prices use a sample spread (gold 1.2 %, silver 2.5 %).
- Login: any 10-digit 3XX mobile number and any 6-digit code are accepted; no SMS is sent. The PIN is 1234 until changed.
- Identity verification always passes; no camera is used and no image is taken.
- Dealer phone numbers, coordinates and the customer's location (Saddar) are samples; the map is a schematic drawing.
- Notifications appear in the app only; nothing is sent by push, SMS or email.
- Purchase limits (10 units per order, Rs 1,500,000 per day) are samples.
- Product premiums, the 10-unit per-order limit, the customer (Ahmed Khan), opening holdings (2 × 1 tola silver, 1 × 1 g gold), the four dealers and their stock.
- Payments always succeed after about 1.8 s. Receipt numbers, redemption codes, the QR-style pattern and serial numbers are generated locally.

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
