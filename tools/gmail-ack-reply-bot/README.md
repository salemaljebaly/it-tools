# Gmail Acknowledgement Reply Bot

Google Apps Script that auto-replies to **unread** inbox threads that are **directly addressed** to a target email (not CC/BCC), and match Arabic keywords like “جازة / مغادرة / خروج”.

## What it does

- Finds candidate emails via a strict Gmail search query (`to:` + excludes `cc:`/`bcc:`)
- Verifies the message is directly addressed via `message.getTo()`
- Replies once per new thread (only when the thread has exactly 1 message)
- Labels the thread (`Auto-replied`) and marks it as read

## Setup

1. Open `script.google.com` → create a new Apps Script project
2. Paste `code.gs` from this folder
3. Update `ACK_BOT_CONFIG` (`targetToEmail`, `fromDomainQuery`, keywords, reply HTML)
4. Create a time-driven trigger to run `autoAcknowledgeTeamLeaderInbox`

Note: Apps Script does **not** run automatically “on save”, and Gmail does not provide an “on email received” simple trigger. Use a time-driven trigger (e.g., every 1–5 minutes).

