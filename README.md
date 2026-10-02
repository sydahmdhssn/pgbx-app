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
| `?start=home` | Skip the splash and PIN and open the Rates home, logged in |
| `?feedFail=1` | Simulate a stale rate feed: shows "Rates are delayed" and disables buying (FR-R4) |
| `?start=login` / `?start=pin` | Open straight on the login or PIN screen |
| `?sim=1` | Use simulated rates instead of the live feed |
| `?api=https://host` | Read live rates from another deployment's `/api/rates` |

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

## Stack

- `index.html` only: Preact + htm as an ES module from jsDelivr, Google Fonts (Lora, Lato)
- Inline SVG icons, metallic ingots and the PGBX coin logo
- Motion uses transform and opacity with `cubic-bezier(.22,1,.36,1)` and respects `prefers-reduced-motion`

## What the prototype covers

| Area | Screens | SRS |
|---|---|---|
| Login | Animated splash, mobile number + one-time code login, PIN lock (any 4 digits, Face key), guest browsing, auto-lock after 2 min | FR-A1, FR-A3, FR-A4, FR-A5 |
| Rates | Live gold and silver buy/sell per tola and per gram, rolling-digit prices, change % since opening, sparkline, world spot (platinum, palladium, copper), freshness, delayed state | FR-R1, FR-R2, FR-R3, FR-R4 |
| Buy | 11 products, whole-unit stepper, 60 s price lock with refresh, payment choice, processing, receipt | FR-P1–P7, FR-B1–B8 |
| Wallet | Holdings by product count, weights, sell value, reserved units, history from an append-only ledger | FR-W1–W3 |
| Redeem | Product and units, 4 sample dealers with stock, 6-digit code, 24 h expiry, status, cancel, dealer simulation (ready, ID check, hand over with serials) | FR-D1–D9 |
| Account | Verified badge, change PIN, biometric toggle, FAQs, contact, report a problem, fee schedule, terms | FR-N2–N4 |

## Sample data vs. real data

Live:
- Gold, silver, platinum, palladium and copper spot prices, and USD/PKR.

Sample or simulated:
- If the live feed is unreachable, rates fall back to the Pakistan Sarafa 24K rate of 1 Oct 2026 (gold Rs 438,636/tola, silver Rs 6,528/tola) with random ticks, labelled "Simulated".
- Sell prices use a sample spread (gold 1.2 %, silver 2.5 %).
- Login: any 10-digit 3XX mobile number and any 6-digit code are accepted; no SMS is sent.
- Product premiums, the 10-unit per-order limit, the customer (Ahmed Khan), opening holdings (2 × 1 tola silver, 1 × 1 g gold), the four dealers and their stock.
- Payments always succeed after about 1.8 s. Receipt numbers, redemption codes, the QR-style pattern and serial numbers are generated locally.
- Which rate source PGBX will use for local buy and sell prices.

Shown as "[To be confirmed by PGBX]" (open questions in Section 10 and related FRs):
- Redemption fee or making charge, and who pays the dealer
- Whether redemption differs for gold and silver
- Whether sell-back to PGBX is in version 1 (FR-W6)
- Storage fee or time limit for holdings (FR-W7)
- Minimum purchase and per-day limits
- Which payment channels are enabled and the ID-verification provider
- Dealer stock model (all eleven products at every dealer, or reservation with delivery)
- Urdu at launch
- Terms, privacy policy, Shariah approval and tax details on receipts (CMP-3, CMP-5, CMP-6, CMP-7)
