# PGBX store listing (draft)

Everything the App Store and Google Play ask for, ready to paste. Items marked **[PGBX]** need PGBX's input.
Character limits are noted; every text below fits them.

## Names

| Field | App Store | Google Play |
|---|---|---|
| App name (30 / 30) | PGBX: Gold & Silver | PGBX: Gold & Silver |
| Subtitle (30) / short description (80) | Buy 999 gold at live prices | Buy 999.0 gold and silver bars at live prices. Collect at PGBX dealers. |
| Category | Finance | Finance |
| Age rating | 18+ (in the age-rating questions, set the app as for adults; unrestricted web access: No; gambling: No; the app is for adults with a CNIC) | Rated for 18+ users in the content questionnaire; target audience 18+ |
| Price | Free | Free |
| Availability | Pakistan only | Pakistan only |

## Description (App Store 4,000 / Play 4,000)

Buy real 999.0 gold and silver bars from Pakistan Gold Bullion Exchange, hold them in your PGBX wallet and collect them
at a PGBX dealer whenever you like.

LIVE PRICES, FINAL RATE BY CHAT
• Gold and silver prices update every few seconds, per tola and per gram
• Before you buy or sell, PGBX support confirms your final rate in a private chat
• Your confirmed rate is locked for a few minutes so you can pay with confidence

WHOLE BARS, BACKED ONE-TO-ONE
• Gold bars from 10 mg to 5 grams and silver bars from 1 to 10 tola, all 999.0 purity
• Every bar in your wallet is backed by metal PGBX holds for you
• Mix gold and silver in one order

COLLECT AT A DEALER
• Choose a PGBX dealer with your bar in stock and get a collection code
• Bring your CNIC; the dealer records your bar's serial number

$1 GOLD
• Start with just one dollar of gold
• Every dollar has its own transaction ID, pooled into whole 1-tola bars held by PGBX
• Sell any amount, paid to your bank account

MORE FROM PGBX
• Sell bars back to PGBX at a rate confirmed in chat
• Send gold or silver coins and bars as gifts, made to order and delivered by insured courier
• Book a doorstep appraisal of your jewellery, or estimate its worth in the app
• Price alerts, statements and a full history of every transaction

SAFE BY DESIGN
• Identity verified with your CNIC before your first purchase
• PIN, Face ID or fingerprint to open the app; it locks itself when you leave
• Records of money and metal can't be changed, only added to

Prices in the app are indicative. Final buying and selling rates are confirmed by PGBX support through live chat.

## Keywords (App Store, 100 characters, comma separated)

gold,silver,bullion,tola,999,gold price,silver price,sarafa,invest,Pakistan,PKR,bars,coins,gift

## Promotional text (App Store, 170, can change without review)

Today's gold and silver prices, whole 999.0 bars from 10 mg, and your final rate confirmed by PGBX support before you pay.

## Links

| Field | Value |
|---|---|
| Privacy policy URL | https://**[PGBX domain]**/legal/privacy |
| Terms (App Store: EULA, optional) | https://**[PGBX domain]**/legal/terms |
| Account deletion URL (Google Play) | https://**[PGBX domain]**/legal/delete-account |
| Support URL | https://pgbx.com.pk **[PGBX: a page with contact details]** |
| Marketing URL (optional) | https://pgbx.com.pk |
| Contact email for the stores | **[PGBX]** |

## App Review / Play review notes

> PGBX lets customers in Pakistan buy whole 999.0 gold and silver bars held by PGBX, collect them at PGBX dealers and
> sell them back. It is operated by **[PGBX legal entity]**, licensed by **[regulator and licence number]**.
>
> Login uses an SMS code to a Pakistani mobile number. For review, use mobile number **[review number]** and code
> **[review code]** (no SMS is sent to this number). The account is already identity-verified.
>
> Prices in the app are indicative: before a purchase or sale the customer asks for the final rate in a chat, and a
> PGBX support agent confirms it (during review we will answer within **[time]**, **[hours, PKT]**). Payments go through
> **[payment provider]**; to see the payment step without paying, stop at the payment page.
>
> No account data is stored on the phone; the PIN is checked by the server. On Android, screenshots are blocked on purpose
> (FLAG_SECURE) to protect financial data.

Turn the review login on with `REVIEW_LOGIN=<number>:<code>:<last day, YYYY-MM-DD>` in the production settings for the review, approve that
account's identity in Admin › Identity checks beforehand, and remove the setting once the app is approved.

## Google Play: other declarations

* **Financial features**: the app offers buying and selling of precious metals and payments. Select the matching
  options and upload PGBX's licence or registration **[PGBX: document]**.
* **Government ID**: the app collects CNIC numbers for identity verification (declare under Data Safety).
* **Ads**: the app contains no ads.
* **News / health / COVID**: not applicable.
* **Target audience**: 18 and over.
* **App access**: provide the review login above.

## Apple: other answers

* **Encryption** (export compliance): the app uses only standard HTTPS and the operating system's encryption, so it
  qualifies for the exemption. `ITSAppUsesNonExemptEncryption = NO` is already set in Info.plist, so App Store Connect won't ask.
* **Sign in with Apple**: not required (the app uses mobile-number login only, no third-party social login).
* **Account deletion**: available in the app (Account › Close account), as Apple requires.
* **Financial app**: Apple may ask for proof that PGBX is licensed to offer the service in Pakistan; have it ready.
