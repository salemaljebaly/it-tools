import "dotenv/config";
import { WebClient } from "@slack/web-api";

type ArgSpec = {
  channel?: string;
  oldest?: string;
  latest?: string;
  includeThreadReplies: boolean;
  dryRun: boolean;
  maxMessages?: number;
  maxReactionsAdds?: number;
};

function usage(): string {
  return [
    "Slack reaction mirror (add same reactions as others, using your user token)",
    "",
    "Required:",
    "  --channel <CHANNEL_ID>           Private channel ID (starts with G... or C...)",
    "",
    "Optional:",
    "  --oldest <ISO|epoch_seconds>     Start time (inclusive). Example: 2026-01-01 or 1735689600",
    "  --latest <ISO|epoch_seconds>     End time (inclusive). Example: 2026-01-31 or 1738281600",
    "  --include-thread-replies         Also process thread replies (slower)",
    "  --dry-run                        Log actions without adding reactions",
    "  --max-messages <N>               Stop after processing N messages",
    "  --max-adds <N>                   Stop after attempting N reaction adds",
    "",
    "Env:",
    "  SLACK_USER_TOKEN                 Slack user token (xoxp-... or xoxc-...)",
    "  SLACK_CHANNEL_ID                 Optional default channel ID if --channel is omitted",
    "",
    "Example:",
    "  cp .env.example .env",
    "  # edit .env then:",
    "  npm run start -- --channel G123 --oldest 2026-01-29 --dry-run",
  ].join("\n");
}

function parseArgs(argv: string[]): ArgSpec {
  const spec: ArgSpec = {
    includeThreadReplies: false,
    dryRun: false,
  };

  const takeValue = (i: number): string => {
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`Missing value for ${argv[i]}`);
    return v;
  };

  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--channel") {
      spec.channel = takeValue(i);
      i += 1;
      continue;
    }
    if (a === "--oldest") {
      spec.oldest = takeValue(i);
      i += 1;
      continue;
    }
    if (a === "--latest") {
      spec.latest = takeValue(i);
      i += 1;
      continue;
    }
    if (a === "--include-thread-replies") {
      spec.includeThreadReplies = true;
      continue;
    }
    if (a === "--dry-run") {
      spec.dryRun = true;
      continue;
    }
    if (a === "--max-messages") {
      spec.maxMessages = Number(takeValue(i));
      i += 1;
      continue;
    }
    if (a === "--max-adds") {
      spec.maxReactionsAdds = Number(takeValue(i));
      i += 1;
      continue;
    }
    if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    }
    throw new Error(`Unknown arg: ${a}`);
  }

  if (spec.maxMessages !== undefined && !Number.isFinite(spec.maxMessages)) {
    throw new Error("--max-messages must be a number");
  }
  if (spec.maxReactionsAdds !== undefined && !Number.isFinite(spec.maxReactionsAdds)) {
    throw new Error("--max-adds must be a number");
  }

  return spec;
}

function parseTime(input: string): string {
  const trimmed = input.trim();
  if (/^\\d+(\\.\\d+)?$/.test(trimmed)) return trimmed;

  // Support YYYY-MM-DD by treating it as UTC midnight.
  const maybeDateOnly = /^\\d{4}-\\d{2}-\\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed;
  const ms = Date.parse(maybeDateOnly);
  if (Number.isNaN(ms)) throw new Error(`Invalid time: ${input}`);
  return String(ms / 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryAfterSeconds(err: unknown): number | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as { retryAfter?: unknown; data?: unknown };
  if (typeof anyErr.retryAfter === "number") return anyErr.retryAfter;
  const data = anyErr.data as { retry_after?: unknown } | undefined;
  if (data && typeof data.retry_after === "number") return data.retry_after;
  return undefined;
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const retryAfter = getRetryAfterSeconds(err);
      if (retryAfter === undefined) throw err;
      console.warn(`Rate limited; sleeping ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
    }
  }
}

type SlackMessage = {
  ts: string;
  subtype?: string;
  reactions?: Array<{ name: string; count: number }>;
  reply_count?: number;
};

async function listThreadReplies(client: WebClient, channel: string, threadTs: string): Promise<SlackMessage[]> {
  const replies: SlackMessage[] = [];
  let cursor: string | undefined;
  do {
    const res = await withRateLimitRetry(() =>
      client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 200,
        cursor,
        inclusive: true,
      }),
    );
    const msgs = (res.messages ?? []) as SlackMessage[];
    replies.push(...msgs);
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return replies;
}

async function mirrorReactionsForMessage(opts: {
  client: WebClient;
  channel: string;
  messageTs: string;
  myUserId: string;
  dryRun: boolean;
}): Promise<{ added: number; skippedAlreadyReacted: number }> {
  const { client, channel, messageTs, myUserId, dryRun } = opts;

  const res = await withRateLimitRetry(() => client.reactions.get({ channel, timestamp: messageTs, full: true }));
  const message = res.message as { reactions?: Array<{ name: string; users?: string[] }> } | undefined;
  const reactions = message?.reactions ?? [];
  if (reactions.length === 0) return { added: 0, skippedAlreadyReacted: 0 };

  let added = 0;
  let skippedAlreadyReacted = 0;

  for (const reaction of reactions) {
    const name = reaction.name;
    if (!name) continue;

    const users = reaction.users ?? [];
    if (users.includes(myUserId)) {
      skippedAlreadyReacted += 1;
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] add :${name}: to ${channel} @ ${messageTs}`);
      added += 1;
      continue;
    }

    try {
      await withRateLimitRetry(() => client.reactions.add({ name, channel, timestamp: messageTs }));
      console.log(`added :${name}: to ${channel} @ ${messageTs}`);
      added += 1;
    } catch (err) {
      const anyErr = err as { data?: { error?: string } };
      if (anyErr?.data?.error === "already_reacted") {
        skippedAlreadyReacted += 1;
        continue;
      }
      throw err;
    }
  }

  return { added, skippedAlreadyReacted };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const channel = args.channel || process.env.SLACK_CHANNEL_ID;
  const token = process.env.SLACK_USER_TOKEN;
  if (!channel || !token) {
    console.error("Missing SLACK_USER_TOKEN.\n\n" + usage());
    process.exit(2);
  }

  const oldest = args.oldest ? parseTime(args.oldest) : undefined;
  const latest = args.latest ? parseTime(args.latest) : undefined;

  const client = new WebClient(token);
  const auth = await withRateLimitRetry(() => client.auth.test());
  const myUserId = auth.user_id;
  if (!myUserId) throw new Error("Could not determine user_id from auth.test()");

  console.log(
    [
      `user=${myUserId}`,
      `channel=${channel}`,
      oldest ? `oldest=${oldest}` : undefined,
      latest ? `latest=${latest}` : undefined,
      args.includeThreadReplies ? "includeThreadReplies=true" : undefined,
      args.dryRun ? "dryRun=true" : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );

  let cursor: string | undefined;
  let processedMessages = 0;
  let totalAdds = 0;
  let totalSkipped = 0;

  do {
    const res = await withRateLimitRetry(() =>
      client.conversations.history({
        channel,
        oldest,
        latest,
        inclusive: true,
        limit: 200,
        cursor,
      }),
    );

    const messages = (res.messages ?? []) as SlackMessage[];
    cursor = res.response_metadata?.next_cursor || undefined;

    for (const message of messages) {
      if (!message.ts) continue;

      processedMessages += 1;
      if (args.maxMessages !== undefined && processedMessages > args.maxMessages) {
        cursor = undefined;
        break;
      }

      if (!message.reactions || message.reactions.length === 0) {
        if (args.includeThreadReplies && message.reply_count && message.reply_count > 0) {
          const replies = await listThreadReplies(client, channel, message.ts);
          for (const reply of replies) {
            if (!reply.ts) continue;
            if (reply.ts === message.ts) continue;
            if (!reply.reactions || reply.reactions.length === 0) continue;

            const r = await mirrorReactionsForMessage({
              client,
              channel,
              messageTs: reply.ts,
              myUserId,
              dryRun: args.dryRun,
            });
            totalAdds += r.added;
            totalSkipped += r.skippedAlreadyReacted;

            if (args.maxReactionsAdds !== undefined && totalAdds >= args.maxReactionsAdds) {
              cursor = undefined;
              break;
            }
          }
        }
        continue;
      }

      const r = await mirrorReactionsForMessage({
        client,
        channel,
        messageTs: message.ts,
        myUserId,
        dryRun: args.dryRun,
      });
      totalAdds += r.added;
      totalSkipped += r.skippedAlreadyReacted;

      if (args.includeThreadReplies && message.reply_count && message.reply_count > 0) {
        const replies = await listThreadReplies(client, channel, message.ts);
        for (const reply of replies) {
          if (!reply.ts) continue;
          if (reply.ts === message.ts) continue;
          if (!reply.reactions || reply.reactions.length === 0) continue;

          const rr = await mirrorReactionsForMessage({
            client,
            channel,
            messageTs: reply.ts,
            myUserId,
            dryRun: args.dryRun,
          });
          totalAdds += rr.added;
          totalSkipped += rr.skippedAlreadyReacted;

          if (args.maxReactionsAdds !== undefined && totalAdds >= args.maxReactionsAdds) {
            cursor = undefined;
            break;
          }
        }
      }

      if (args.maxReactionsAdds !== undefined && totalAdds >= args.maxReactionsAdds) {
        cursor = undefined;
        break;
      }
    }
  } while (cursor);

  console.log(`done: messages=${processedMessages} adds=${totalAdds} skipped_already=${totalSkipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
