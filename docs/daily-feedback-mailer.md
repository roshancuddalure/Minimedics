# Daily Feedback Mailer

## Purpose

Sends each verified user one daily summary email at the configured local morning hour.

## Schedule

- Processor: `processDailyFeedbackDigests()` in [index.js](/d:/Coding/Project%201%20codex/index.js)
- Poll interval: every 15 minutes
- Default send hour: `6`
- Default timezone: `Asia/Kolkata`

Environment overrides:

- `DAILY_FEEDBACK_HOUR`
- `DAILY_FEEDBACK_TIMEZONE`

## Idempotency

Successful sends are recorded in `daily_digest_sends` with a unique key on:

- `user_id`
- `digest_day`

This prevents duplicate sends for the same user on the same local day even if the server restarts or the scheduler runs multiple times inside the 6 AM window.

## Email contents

Each digest includes:

- account snapshot: level, XP, title, login streak
- last 24 hours activity summary
- recent XP rewards
- reminders due in the next 2 days
- CTA to log in and claim the daily bonus / maintain streak

## Data sources

- `users`
- `xp_events`
- `posts`
- `post_comments`
- `quiz_attempts`
- `post_reminder_targets`
- `reminder_completions`

## Notes

- Uses the existing Resend-based mail flow.
- Only verified, unblocked users with a valid stored email are included.
- If `RESEND_API_KEY` is missing, sends will safely fail without marking the day as delivered.
