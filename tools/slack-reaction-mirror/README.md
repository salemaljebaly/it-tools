# Slack reaction mirror

Mirrors reactions on messages in a Slack channel by adding the same emoji reactions **from your own Slack account**.

This uses a **Slack user token** (not a bot token), so the reaction is shown as created by *you*.

For an admin/install request doc (scopes, events, Socket Mode), see `REQUEST.md`.

## Setup (Slack app)

Create a Slack app and enable OAuth **User Token** scopes (OAuth & Permissions):

- `conversations:history` (read private channel messages you can access)
- `reactions:read`
- `reactions:write`

Install the app to your workspace and complete OAuth to get a user token (commonly `xoxp-...`).

## Install

```bash
cd slack-reaction-mirror
npm install
```

## Configure (.env)

Create a local `.env` file (this repo ignores it):

```bash
cp .env.example .env
```

Then edit `.env`:

- Always set `SLACK_USER_TOKEN`
- For live mode (`npm run watch`), also set `SLACK_APP_TOKEN`
- Optionally set `SLACK_CHANNEL_ID` to limit to one channel
- Optionally set `SLACK_MY_USER_ID` to skip reacting on messages authored by you
- For Workflow Builder messages posted by an app user, optionally set `SLACK_SKIP_MESSAGE_REGEX` or `SLACK_SKIP_MESSAGE_CONTAINS` to skip “your” messages based on content (e.g. a `from:` line).
- Optionally set `SLACK_REACTION_BLACKLIST`, `SLACK_REACTION_BLACKLIST_CONTAINS`, or `SLACK_REACTION_BLACKLIST_REGEX` to prevent adding specific reactions (supports comma-separated values or a JSON array string).

## Run

Dry-run first:

```bash
npm run start -- --channel G12345678 --oldest 2026-01-29 --dry-run
```

Then run for real (no `--dry-run`):

```bash
npm run start -- --channel G12345678 --oldest 2026-01-29
```

## Options

- `--channel <CHANNEL_ID>` private channel ID (starts with `G...` or `C...`) (or set `SLACK_CHANNEL_ID` in `.env`)
- `--oldest <ISO|epoch_seconds>` start time (inclusive)
- `--latest <ISO|epoch_seconds>` end time (inclusive)
- `--include-thread-replies` also process thread replies (slower)
- `--add-default-reactions` if a message has no reactions yet, add default reactions (`rocket`, `raised_hands`, `saluting_face`, `v`). Optionally override via `SLACK_DEFAULT_REACTIONS`
- `--dry-run` log actions without adding reactions
- `--max-messages <N>` stop after processing N messages
- `--max-adds <N>` stop after attempting N reaction adds

## Behavior

- By default skips messages with no reactions. With `--add-default-reactions`, it will add default reactions to messages that have none.
- For each emoji reaction on a message, if you have not reacted yet, it adds that emoji reaction from your account.
- If a reaction is blacklisted via `SLACK_REACTION_BLACKLIST*`, it will never be added (including default reactions).
- Skips the daily stand-up reminder message (`Daily stand-up meeting reminder`) so it doesn’t get reactions.
- Skips mirroring reactions onto messages authored by you.
- For Workflow Builder / app-posted standups, it can also skip messages that *mention you* (`<@U...>`) or match `SLACK_SKIP_MESSAGE_REGEX` / `SLACK_SKIP_MESSAGE_CONTAINS`.
- Handles Slack rate limits (429) by sleeping and retrying.

## Run continuously (best)

Instead of scanning history, you can mirror reactions in real-time by listening to Slack’s `reaction_added` event via **Socket Mode**.

Slack app settings:

1) Enable **Socket Mode** and create an **App-Level Token** (`xapp-...`) with `connections:write`
2) Enable **Event Subscriptions** and subscribe to **Bot Events**: `reaction_added`
3) Reinstall the app (so settings/scopes apply)

Then run:

```bash
npm run watch
```

Leave it running on your laptop.
