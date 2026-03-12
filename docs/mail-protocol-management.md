# Mail Protocol Management

## Purpose

Central control layer for all automated email flows.

Admins can enable or disable each protocol from the admin panel to manage delivery volume and email spend.

## Current protocols

- `verification_email`
- `password_reset_email`
- `reminder_due_email`
- `daily_feedback_email`

## Backend

Registry and logs live in [index.js](/d:/Coding/Project%201%20codex/index.js).

Tables:

- `mail_protocols`
- `mail_delivery_logs`

Admin APIs:

- `GET /api/admin/mail-protocols`
- `POST /api/admin/mail-protocols/:key`

## Important rule for future mail features

Any new automated email flow should:

1. be added to `MAIL_PROTOCOLS`
2. send through `sendHtmlEmail(protocolKey, toEmail, subject, html, meta)`

If that pattern is followed, the protocol will:

- appear in admin mail management
- respect enable/disable state
- log sent, failed, and disabled delivery attempts

## Delivery logging

`mail_delivery_logs` records:

- protocol key
- user id when available
- email
- subject
- status: `sent`, `failed`, `disabled`
- error details when relevant

The admin UI currently shows recent 7-day sent and blocked counts plus the last logged event.
