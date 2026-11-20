# Railway GPS Telegram Alert

Automated monitoring for RJK, RG and CH railway GPS devices.

## Alerts
- Stale GPS update: alert after 30 minutes without a report; repeat every 30 minutes while stale.
- Night GPS ON monitoring: 23:00 IST to 07:00 IST.
- 23:25 report: list devices not yet ON, grouped by section.
- Ignore list: suppress alerts for configured device IDs.

## Runtime
GitHub Actions runs a Python Playwright monitor approximately every 2 minutes and sends Telegram alerts.

## Configuration
Set RILAPP_URL, RILAPP_USERNAME, RILAPP_PASSWORD, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID as runtime environment variables. Maintain device mappings and ignored IDs in config.json.

## Status
Initial scaffold. Verify current RILAPP selectors and device mappings before enabling continuous alerts.
