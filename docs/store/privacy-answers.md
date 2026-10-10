# Privacy answers for the stores (draft)

Based on what the app and server actually collect (see `legal/privacy.html`). Review with PGBX before submitting.
"Linked to the user" is yes for everything below, because each item belongs to a customer account. Nothing is used
for tracking, advertising or sold.

## Apple: App Privacy ("nutrition label")

**Does the app collect data?** Yes. **Used to track you?** No.

| Apple category | Data type | Collected | Purpose | Linked |
|---|---|---|---|---|
| Contact Info | Name | Yes | App functionality | Yes |
| Contact Info | Email address (optional) | Yes | App functionality | Yes |
| Contact Info | Phone number | Yes | App functionality (login) | Yes |
| Contact Info | Physical address (optional; gift and appraisal addresses) | Yes | App functionality | Yes |
| Financial Info | Payment info (payment references; card details go to the payment provider) | Yes | App functionality | Yes |
| Financial Info | Other financial info (holdings, transactions, bank account for payouts) | Yes | App functionality | Yes |
| Sensitive Info | Government ID (CNIC number) | Yes | App functionality (identity verification) | Yes |
| User Content | Other user content (rate chat messages, photos and PDFs, support requests) | Yes | App functionality, customer support | Yes |
| User Content | Photos (only files the customer chooses to send in a chat) | Yes | App functionality | Yes |
| Identifiers | User ID (account ID) | Yes | App functionality | Yes |
| Identifiers | Device ID: **No** (no advertising or device identifiers are collected) | No | | |
| Usage Data | No | | | |
| Diagnostics | No (no crash or analytics SDKs) | | | |
| Location | No | | | |
| Contacts / Browsing / Search history | No | | | |

If the identity provider's SDK is added to the app later (for CNIC photos and the selfie in the app), add **Sensitive
Info › Biometric data** if the provider says it processes face data, and re-check the provider's own disclosure.

## Google Play: Data Safety

**Collected:** yes. **Shared with third parties:** no (service providers acting for PGBX are not "sharing" in Google's
definition). **Encrypted in transit:** yes. **Users can request deletion:** yes (Account › Close account; data the law
requires is kept for the retention period). **Committed to the Families policy:** no (adults only).

| Google category | Data type | Collected | Optional? | Purpose |
|---|---|---|---|---|
| Personal info | Name | Yes | Required | Account management, fraud prevention and security, compliance |
| Personal info | Email address | Yes | Optional | Account management |
| Personal info | Phone number | Yes | Required | Account management (login), fraud prevention |
| Personal info | Address | Yes | Optional | App functionality (gifts, appraisals) |
| Personal info | Other info (CNIC number, date of birth) | Yes | Required for buying | Fraud prevention, security and compliance |
| Financial info | Purchase history | Yes | Required | App functionality |
| Financial info | Other financial info (bank account for payouts, holdings) | Yes | Required to sell | App functionality |
| Messages | Other in-app messages (rate chat, support) | Yes | Optional | App functionality, customer support |
| Photos and videos | Photos (chat attachments) | Yes | Optional | App functionality |
| Files and docs | Files (PDF chat attachments) | Yes | Optional | App functionality |
| App activity | No | | | |
| App info and performance | No | | | |
| Device or other IDs | No | | | |
| Location | No | | | |

Data processed only on the phone and never sent (Face ID / fingerprint checks) is not "collected".
