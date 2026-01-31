# Board Request: Slack Reaction Mirror (Local Automation)

## Bullet summary

- **Request**: Approve a small internal automation that mirrors emoji reactions in a specific Slack channel.
- **What changes**: When a teammate reacts to a message, the tool adds the same emoji reaction from the standup facilitator’s account.
- **Where it runs**: Locally on a team laptop via Slack **Socket Mode** (no public endpoint).
- **Why**: Saves time and improves consistency for standup acknowledgements.
- **Security**: Uses least-privilege Slack OAuth scopes; secrets stored locally in `.env` (not committed).
- **Rollback**: Stop the process and/or revoke the tokens / uninstall the Slack app.

## Background / problem

Daily standup updates happen in a Slack channel and require multiple emoji reactions for acknowledgement/visibility. Manually applying reactions is repetitive and error-prone.

## Proposed solution

Introduce a small Node.js script that:

- Listens for Slack `reaction_added` events in real-time (Socket Mode).
- For the configured channel, adds the same emoji reaction from the facilitator’s Slack user account.
- Prevents loops by ignoring reactions created by the facilitator user.

Optional one-time “backfill” mode exists to scan a date range and add missing reactions from the facilitator account.

## Scope

**In scope**
- One Slack workspace.
- One (or a limited set of) channel(s), controlled by `SLACK_CHANNEL_ID`.
- Mirroring only the **reaction type** (emoji name).

**Out of scope**
- Recreating reactions as other users (not possible).
- Editing/deleting messages.
- Persisting message content.

## Required approvals / access

### Slack app installation

- Approval to create/install a Slack app in the workspace (if restricted by policy).

### Tokens

- **User OAuth Token** (`xoxp-...`) for the facilitator account.
- **App-Level Token** (`xapp-...`) for Socket Mode connectivity.

### OAuth scopes (user token scopes)

For private channels:
- `groups:history`
- `reactions:read`
- `reactions:write`

Optional (if used for public channels too):
- `channels:history`

### Events / Socket Mode

- Enable **Socket Mode** (`connections:write` on the app-level token).
- Enable **Event Subscriptions** and subscribe to **Bot Events**:
  - `reaction_added`

## Security / compliance notes

- Secrets are stored locally in `.env`; `.env` is git-ignored.
- The tool logs only: emoji name, channel id, and message timestamp (no message content storage).
- Least-privilege scopes are used; scope additions require reinstall approval.

## Risk assessment

**Risks**
- Accidental reaction spam if misconfigured to the wrong channel.
- Slack rate limiting if reaction volume spikes.

**Mitigations**
- Channel allow-list via `SLACK_CHANNEL_ID`.
- Idempotent behavior: ignores `already_reacted`.
- Built-in rate limit handling (retries on 429).
- Easy shutdown (stop the local process) + token revocation.

## Rollout plan

1) Create Slack app, configure scopes/events, enable Socket Mode, reinstall.
2) Configure `.env` with `SLACK_USER_TOKEN`, `SLACK_APP_TOKEN`, and `SLACK_CHANNEL_ID`.
3) Start live mode: `npm run watch`.
4) (Optional) One-time backfill by date range using `npm run start -- --oldest ... --latest ...`.

## Rollback plan

- Stop the running process.
- Revoke tokens and/or uninstall the Slack app from the workspace.

## References

- Admin request (technical details): `REQUEST.md`
- Tool usage: `README.md`

