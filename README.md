# Tulum Yoga Music Fest + Conference Week — 2026

Customer-facing website for **Tulum Yoga Music Fest (TYMF) 2026** · September 21–27, 2026 · Oasis Tulum, Mexico.

A single self-contained page (`index.html`) — no build step, no dependencies. Fonts load from Google Fonts with graceful serif/sans fallbacks; the festival flyer is embedded directly in the file.

## Features

### Ticket delivery and entry

New paid orders receive one email containing a numbered QR ticket and PNG attachment
for each admission. Each individual QR admits one person, and guests can arrive
separately. The order code shown in the organizer dashboard is not an admission QR.

Sales and commissions remain one record per order in `orders`. Individual codes
live in `tickets`; one-time check-in receipts live in `ticket-admissions`.
The organizer dashboard displays the checked-in count for each order.
Webhook retries preserve issued codes and admission receipts. Email delivery
uses a delivery record plus a Resend idempotency key.

Previously issued shared tickets remain valid for their original quantity.
This change does not automatically split, invalidate, or resend them. Do not
create additional valid admissions for an old order without retiring its shared
code as part of a deliberate reissue workflow.

Run `npm test` for isolated ticketing tests; they do not charge cards or send email.

- One-page scroll: hero, main festival, the week, color-coded 7-day schedule, teachers + healers, musicians + artists, partners, affiliates, vendors, about, gallery, organizers, sponsors, contact.
- Live ticketing UI — tiered passes, quantity steppers, order summary, checkout modal, confirmation.
- Countdown to the festival, light/dark themes, responsive, reduced-motion friendly.

## Deploy on Netlify

This is a static site with no build command.

**Option A — connect the repo (recommended)**
1. In Netlify: **Add new site → Import an existing project → GitHub**.
2. Choose `cyberdreadx/yogamusicfest`.
3. Build command: *(leave empty)* · Publish directory: `.`
4. Deploy. `netlify.toml` already sets these.

**Option B — drag & drop**
Drag `index.html` onto the Netlify dashboard.

## Before going live

- **Payments:** the checkout is a front-end demo — it generates a confirmation code but processes no real payment. Wire in Stripe or a ticketing provider (Eventbrite / Tixr) to sell for real.
- **Content:** teachers, artists, vendors, partners, schedule and ticket prices are realistic placeholders — replace with the real lineup and pricing.
- **Contact:** Instagram [@yogamusicfest.mx](https://instagram.com/yogamusicfest.mx) · WhatsApp +1 786 748 7247.
