# Request: Slack “Reaction Mirror” (local Socket Mode)

## Summary

We want to run a small internal script that mirrors existing emoji reactions by adding the same reaction from a designated user account (the standup facilitator). This reduces manual clicking while keeping the existing team reaction workflow unchanged.

The script runs locally and listens to Slack events in real-time using **Socket Mode**.

## What it does

- When anyone adds a reaction to a message in the target channel, the script adds the **same emoji reaction** from the facilitator’s account.
- It ignores reactions added by the facilitator to prevent loops.
- It can be restricted to a single private channel via `SLACK_CHANNEL_ID`.

## Where it runs

- Runs on a team member’s laptop (or a small internal machine) as a long-running process.
- No public web server required (Socket Mode).

## Slack app requirements

### OAuth tokens

1) **User OAuth Token** (`xoxp-...`)
   - Used to add reactions “as the facilitator user”.

2) **App-Level Token** (`xapp-...`)
   - Used only for Socket Mode connectivity.

### Scopes (User Token Scopes)

Private channels require:

- `groups:history` (read private channel message history; needed if using the history scan tool)
- `reactions:read`
- `reactions:write`

Optional (if supporting public channels too):

- `channels:history`

### Socket Mode

- Enable **Socket Mode**
- Create an **App-Level Token** with scope: `connections:write`

### Event subscriptions

- Enable **Event Subscriptions**
- Subscribe to **Bot Events**:
  - `reaction_added`

## Data access / privacy

- The live mode processes only `reaction_added` events and adds a reaction.
- The tool does not store message content; it logs only the emoji name + channel id + message timestamp.
- Tokens are stored locally in a `.env` file (not committed to git).

## Operations

- Start: `npm run watch` in `tools/slack-reaction-mirror/`
- Stop: terminate the process
- Rollback: stop the process and/or revoke tokens / uninstall the app

## Approvals needed

- Workspace admin approval to install the Slack app (if required by policy)
- Approval for the OAuth scopes listed above

