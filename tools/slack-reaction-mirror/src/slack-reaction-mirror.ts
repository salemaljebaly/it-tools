import "dotenv/config";
import { WebClient } from "@slack/web-api";

type ArgSpec = {
  channel?: string;
  oldest?: string;
  latest?: string;
  includeThreadReplies: boolean;
  dryRun: boolean;
  addDefaultReactions: boolean;
  maxMessages?: number;
  maxReactionsAdds?: number;
};

const BUILTIN_DEFAULT_REACTIONS = ["rocket", "raised_hands", "saluting_face", "v"] as const;

function optionalEnv(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const trimmed = v.trim();
  if (trimmed.length === 0) return undefined;
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseCommaList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseListOrJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        return parsed.map((s) => s.trim()).filter((s) => s.length > 0);
      }
    } catch {
      // fall back to comma list
    }
  }
  return parseCommaList(trimmed);
}

function escapeRegexLiteral(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectStrings(value: unknown, out: string[], opts: { maxDepth: number; maxStrings: number }): void {
  if (out.length >= opts.maxStrings) return;
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (opts.maxDepth <= 0) return;
  if (typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, { ...opts, maxDepth: opts.maxDepth - 1 });
    return;
  }

  for (const v of Object.values(value as Record<string, unknown>)) {
    collectStrings(v, out, { ...opts, maxDepth: opts.maxDepth - 1 });
    if (out.length >= opts.maxStrings) return;
  }
}

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
    "  --add-default-reactions          If a message has no reactions yet, add default reactions (rocket, raised_hands, saluting_face, v)",
    "  --dry-run                        Log actions without adding reactions",
    "  --max-messages <N>               Stop after processing N messages",
    "  --max-adds <N>                   Stop after attempting N reaction adds",
    "",
    "Env:",
    "  SLACK_USER_TOKEN                 Slack user token (xoxp-... or xoxc-...)",
    "  SLACK_CHANNEL_ID                 Optional default channel ID if --channel is omitted",
    "  SLACK_MY_USER_ID                 Optional: your Slack user ID (U...). Used to skip reacting on your own messages",
    "  SLACK_SKIP_MESSAGE_REGEX         Optional regex (case-insensitive) to skip messages (useful for Workflow Builder posts)",
    "  SLACK_SKIP_MESSAGE_CONTAINS      Optional comma-separated substrings to skip messages (case-insensitive)",
    "  SLACK_DEBUG_SKIP                 Optional: set to 1 to log why messages are skipped",
    "  SLACK_DEFAULT_REACTIONS          Optional comma-separated emoji names to use with --add-default-reactions",
    "  SLACK_REACTION_BLACKLIST         Optional: comma-separated (or JSON array) emoji names to never add",
    "  SLACK_REACTION_BLACKLIST_CONTAINS Optional: comma-separated (or JSON array) substrings; blocks any emoji containing them (e.g. woman,girl)",
    "  SLACK_REACTION_BLACKLIST_REGEX   Optional regex (case-insensitive) matched against emoji names",
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
    addDefaultReactions: false,
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
    if (a === "--add-default-reactions") {
      spec.addDefaultReactions = true;
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
  user?: string;
  text?: string;
  subtype?: string;
  reactions?: Array<{ name: string; count: number }>;
  reply_count?: number;
};

type SkipConfig = {
  skipUserId: string;
  skipUserAliases: string[];
  skipMessageRegex?: RegExp;
  skipMessageContains: string[];
  debugSkip: boolean;
};

type ReactionFilterConfig = {
  blacklistExact: Set<string>;
  blacklistContains: string[];
  blacklistRegex?: RegExp;
  debug: boolean;
};

function normalizeReactionName(name: string): string {
  return name.trim().toLowerCase();
}

function canonicalizeReactionName(name: string): string {
  // Slack skin tone variants appear as e.g. "raised_hands::skin-tone-2".
  // Treat them as the same base emoji when deciding what to add.
  return name.replace(/::skin-tone-\\d+/g, "").replace(/:skin-tone-\\d+/g, "");
}

function isReactionBlocked(name: string, cfg: ReactionFilterConfig): boolean {
  const normalized = normalizeReactionName(name);
  if (cfg.blacklistExact.has(normalized)) return true;
  if (cfg.blacklistContains.some((s) => normalized.includes(s))) return true;
  if (cfg.blacklistRegex && cfg.blacklistRegex.test(normalized)) return true;
  return false;
}

function messageContentStrings(message: unknown): string[] {
  const out: string[] = [];
  collectStrings(message, out, { maxDepth: 8, maxStrings: 600 });
  return out;
}

function matchesWorkflowFromLineMention(strings: string[], userId: string): boolean {
  const re = new RegExp(`from\\s*:\\s*<@${escapeRegexLiteral(userId)}>`, "i");
  return strings.some((s) => re.test(s));
}

function matchesWorkflowFromLine(strings: string[], aliases: string[]): boolean {
  for (const alias of aliases) {
    const re = new RegExp(`from\\s*:\\s*@?\\s*${escapeRegexLiteral(alias)}\\b`, "i");
    if (strings.some((s) => re.test(s))) return true;
  }
  return false;
}

function normalizeForSubstringMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\\s+/g, " ")
    .trim();
}

function isStandupReminderMessage(strings: string[]): boolean {
  const haystack = normalizeForSubstringMatch(strings.join("\n"));
  if (haystack.includes("daily stand-up meeting reminder")) return true;
  // Some workflows format the title/body separately; allow matching on the body too.
  if (haystack.includes("don't forget to post your update in thread")) return true;
  if (haystack.includes("dont forget to post your update in thread")) return true;
  if (haystack.includes("fill form from slack shortcut")) return true;
  return false;
}

function shouldSkipMessage(message: unknown, cfg: SkipConfig): { skip: boolean; reason?: string } {
  if (typeof message === "object" && message !== null) {
    const anyMsg = message as { user?: unknown };
    if (typeof anyMsg.user === "string" && anyMsg.user === cfg.skipUserId) return { skip: true, reason: "author_user_id" };
  }

  const strings = messageContentStrings(message);

  if (isStandupReminderMessage(strings)) return { skip: true, reason: "standup_reminder" };

  if (matchesWorkflowFromLineMention(strings, cfg.skipUserId)) return { skip: true, reason: "workflow_from_line_user_id" };

  // Workflow Builder / apps often embed a "from:" line; match against known aliases.
  if (matchesWorkflowFromLine(strings, cfg.skipUserAliases)) return { skip: true, reason: "workflow_from_line_alias" };

  if (cfg.skipMessageContains.length > 0) {
    const lowerStrings = strings.map((s) => s.toLowerCase());
    for (const contains of cfg.skipMessageContains) {
      const needle = contains.toLowerCase();
      if (lowerStrings.some((s) => s.includes(needle))) return { skip: true, reason: "skip_contains" };
    }
  }

  if (cfg.skipMessageRegex && strings.some((s) => cfg.skipMessageRegex!.test(s))) return { skip: true, reason: "skip_regex" };

  return { skip: false };
}

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
  authedUserId: string;
  skipCfg: SkipConfig;
  reactionFilterCfg: ReactionFilterConfig;
  dryRun: boolean;
}): Promise<{ added: number; skippedAlreadyReacted: number; skippedOwnMessage: number; skippedBlacklisted: number }> {
  const { client, channel, messageTs, authedUserId, skipCfg, reactionFilterCfg, dryRun } = opts;

  const res = await withRateLimitRetry(() => client.reactions.get({ channel, timestamp: messageTs, full: true }));
  const message = res.message as
    | { user?: string; text?: string; reactions?: Array<{ name: string; users?: string[] }> }
    | undefined;
  if (!message) return { added: 0, skippedAlreadyReacted: 0, skippedOwnMessage: 1, skippedBlacklisted: 0 };

  const skip = shouldSkipMessage(message, skipCfg);
  if (skip.skip) {
    if (skipCfg.debugSkip) console.log(`[skip] ${channel} @ ${messageTs} reason=${skip.reason ?? "unknown"}`);
    return { added: 0, skippedAlreadyReacted: 0, skippedOwnMessage: 1, skippedBlacklisted: 0 };
  }

  const reactions = message?.reactions ?? [];
  if (reactions.length === 0) return { added: 0, skippedAlreadyReacted: 0, skippedOwnMessage: 0, skippedBlacklisted: 0 };

  const canonicalHasAuthedReaction = new Set<string>();
  const canonicals = new Set<string>();
  for (const reaction of reactions) {
    const name = reaction.name;
    if (!name) continue;
    const canonical = canonicalizeReactionName(name);
    canonicals.add(canonical);
    if (reaction.users?.includes(authedUserId)) canonicalHasAuthedReaction.add(canonical);
  }

  let added = 0;
  let skippedAlreadyReacted = 0;
  let skippedBlacklisted = 0;

  for (const canonical of canonicals) {
    if (canonicalHasAuthedReaction.has(canonical)) {
      skippedAlreadyReacted += 1;
      continue;
    }

    const addName = canonical; // always add the base emoji (no skin tone)
    if (isReactionBlocked(addName, reactionFilterCfg)) {
      skippedBlacklisted += 1;
      if (reactionFilterCfg.debug) console.log(`[blocklist] skip :${addName}: for ${channel} @ ${messageTs}`);
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] add :${addName}: to ${channel} @ ${messageTs}`);
      added += 1;
      continue;
    }

    try {
      await withRateLimitRetry(() => client.reactions.add({ name: addName, channel, timestamp: messageTs }));
      console.log(`added :${addName}: to ${channel} @ ${messageTs}`);
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

  return { added, skippedAlreadyReacted, skippedOwnMessage: 0, skippedBlacklisted };
}

async function addDefaultReactionsForMessage(opts: {
  client: WebClient;
  channel: string;
  messageTs: string;
  defaultReactionNames: string[];
  skipCfg: SkipConfig;
  reactionFilterCfg: ReactionFilterConfig;
  dryRun: boolean;
}): Promise<{
  added: number;
  skippedAlreadyReacted: number;
  skippedOwnMessage: number;
  skippedHasReactions: number;
  skippedBlacklisted: number;
}> {
  const { client, channel, messageTs, defaultReactionNames, skipCfg, reactionFilterCfg, dryRun } = opts;

  const res = await withRateLimitRetry(() => client.reactions.get({ channel, timestamp: messageTs, full: true }));
  const message = res.message as
    | { user?: string; text?: string; reactions?: Array<{ name: string; users?: string[] }> }
    | undefined;
  if (!message) {
    return { added: 0, skippedAlreadyReacted: 0, skippedOwnMessage: 0, skippedHasReactions: 0, skippedBlacklisted: 0 };
  }

  const skip = shouldSkipMessage(message, skipCfg);
  if (skip.skip) {
    if (skipCfg.debugSkip) console.log(`[skip] ${channel} @ ${messageTs} reason=${skip.reason ?? "unknown"}`);
    return { added: 0, skippedAlreadyReacted: 0, skippedOwnMessage: 1, skippedHasReactions: 0, skippedBlacklisted: 0 };
  }

  if (message.reactions && message.reactions.length > 0) {
    return { added: 0, skippedAlreadyReacted: 0, skippedOwnMessage: 0, skippedHasReactions: 1, skippedBlacklisted: 0 };
  }

  let added = 0;
  let skippedAlreadyReacted = 0;
  let skippedBlacklisted = 0;

  for (const name of defaultReactionNames) {
    if (isReactionBlocked(name, reactionFilterCfg)) {
      skippedBlacklisted += 1;
      if (reactionFilterCfg.debug) console.log(`[blocklist] skip default :${name}: for ${channel} @ ${messageTs}`);
      continue;
    }

    if (dryRun) {
      console.log(`[dry-run] add default :${name}: to ${channel} @ ${messageTs}`);
      added += 1;
      continue;
    }

    try {
      await withRateLimitRetry(() => client.reactions.add({ name, channel, timestamp: messageTs }));
      console.log(`added default :${name}: to ${channel} @ ${messageTs}`);
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

  return { added, skippedAlreadyReacted, skippedOwnMessage: 0, skippedHasReactions: 0, skippedBlacklisted };
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
  const authedUserId = auth.user_id;
  const authedUserName = typeof auth.user === "string" ? auth.user : undefined;
  if (!authedUserId) throw new Error("Could not determine user_id from auth.test()");

  const configuredSkipUserId = optionalEnv("SLACK_MY_USER_ID");
  const skipUserId = configuredSkipUserId ?? authedUserId;
  if (configuredSkipUserId && configuredSkipUserId !== authedUserId) {
    console.warn(
      `SLACK_MY_USER_ID=${configuredSkipUserId} does not match token user_id=${authedUserId}; using SLACK_MY_USER_ID only for skip logic`,
    );
  }

  const baseAliases =
    skipUserId === authedUserId && authedUserName ? [authedUserName, `@${authedUserName}`] : [];
  let userInfoAliases: string[] = [];
  try {
    const userInfo = await withRateLimitRetry(() => client.users.info({ user: skipUserId }));
    const u = userInfo.user as
      | { name?: unknown; real_name?: unknown; profile?: { display_name?: unknown; real_name?: unknown } }
      | undefined;
    const maybe = [
      typeof u?.name === "string" ? u.name : undefined,
      typeof u?.real_name === "string" ? u.real_name : undefined,
      typeof u?.profile?.display_name === "string" ? u.profile.display_name : undefined,
      typeof u?.profile?.real_name === "string" ? u.profile.real_name : undefined,
    ].filter((s): s is string => Boolean(s && s.trim().length > 0));
    userInfoAliases = maybe.flatMap((s) => [s, `@${s}`]);
  } catch {
    // ignore; requires users:read in some workspaces
  }

  const skipMessageContains = parseCommaList(optionalEnv("SLACK_SKIP_MESSAGE_CONTAINS"));
  const skipMessageRegexStr = optionalEnv("SLACK_SKIP_MESSAGE_REGEX");
  const skipMessageRegex = skipMessageRegexStr ? new RegExp(skipMessageRegexStr, "i") : undefined;
  const debugSkip = optionalEnv("SLACK_DEBUG_SKIP") === "1";

  const envDefaultReactions = parseCommaList(optionalEnv("SLACK_DEFAULT_REACTIONS"));
  const defaultReactionNames = (
    envDefaultReactions.length > 0 ? envDefaultReactions : [...BUILTIN_DEFAULT_REACTIONS]
  ).filter((v, i, arr) => arr.indexOf(v) === i);

  const reactionBlacklistExact = parseListOrJsonArray(optionalEnv("SLACK_REACTION_BLACKLIST")).map(normalizeReactionName);
  const reactionBlacklistContains = parseListOrJsonArray(optionalEnv("SLACK_REACTION_BLACKLIST_CONTAINS")).map(
    normalizeReactionName,
  );
  const reactionBlacklistRegexStr = optionalEnv("SLACK_REACTION_BLACKLIST_REGEX");
  const reactionBlacklistRegex = reactionBlacklistRegexStr ? new RegExp(reactionBlacklistRegexStr, "i") : undefined;

  const reactionFilterCfg: ReactionFilterConfig = {
    blacklistExact: new Set(reactionBlacklistExact),
    blacklistContains: reactionBlacklistContains.filter((v, i, arr) => arr.indexOf(v) === i),
    blacklistRegex: reactionBlacklistRegex,
    debug: debugSkip,
  };

  const skipCfg: SkipConfig = {
    skipUserId,
    skipUserAliases: [...baseAliases, ...userInfoAliases].filter((v, i, arr) => arr.indexOf(v) === i),
    skipMessageRegex,
    skipMessageContains,
    debugSkip,
  };

  console.log(
    [
      `user=${authedUserId}`,
      skipUserId !== authedUserId ? `skipUser=${skipUserId}` : undefined,
      `channel=${channel}`,
      oldest ? `oldest=${oldest}` : undefined,
      latest ? `latest=${latest}` : undefined,
      args.includeThreadReplies ? "includeThreadReplies=true" : undefined,
      args.addDefaultReactions ? `addDefaultReactions=${defaultReactionNames.join(",")}` : undefined,
      args.dryRun ? "dryRun=true" : undefined,
    ]
      .filter(Boolean)
      .join(" "),
  );

  let cursor: string | undefined;
  let processedMessages = 0;
  let totalAdds = 0;
  let totalSkipped = 0;
  let totalSkippedOwn = 0;
  let totalSkippedHasReactions = 0;
  let totalSkippedBlacklisted = 0;

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

      const isOwnMessage = shouldSkipMessage(message, skipCfg).skip;

      if (!message.reactions || message.reactions.length === 0) {
        if (args.addDefaultReactions && !isOwnMessage) {
          const r0 = await addDefaultReactionsForMessage({
            client,
            channel,
            messageTs: message.ts,
            defaultReactionNames,
            skipCfg,
            reactionFilterCfg,
            dryRun: args.dryRun,
          });
          totalAdds += r0.added;
          totalSkipped += r0.skippedAlreadyReacted;
          totalSkippedOwn += r0.skippedOwnMessage;
          totalSkippedHasReactions += r0.skippedHasReactions;
          totalSkippedBlacklisted += r0.skippedBlacklisted;

          if (args.maxReactionsAdds !== undefined && totalAdds >= args.maxReactionsAdds) {
            cursor = undefined;
            break;
          }
        } else if (isOwnMessage) {
          totalSkippedOwn += 1;
        }

        if (args.includeThreadReplies && message.reply_count && message.reply_count > 0) {
          const replies = await listThreadReplies(client, channel, message.ts);
          for (const reply of replies) {
            if (!reply.ts) continue;
            if (reply.ts === message.ts) continue;
            if (shouldSkipMessage(reply, skipCfg).skip) {
              totalSkippedOwn += 1;
              continue; // skip reacting on our own messages
            }
            if (!reply.reactions || reply.reactions.length === 0) {
              if (args.addDefaultReactions) {
                const r1 = await addDefaultReactionsForMessage({
                  client,
                  channel,
                  messageTs: reply.ts,
                  defaultReactionNames,
                  skipCfg,
                  reactionFilterCfg,
                  dryRun: args.dryRun,
                });
                totalAdds += r1.added;
                totalSkipped += r1.skippedAlreadyReacted;
                totalSkippedOwn += r1.skippedOwnMessage;
                totalSkippedHasReactions += r1.skippedHasReactions;
                totalSkippedBlacklisted += r1.skippedBlacklisted;

                if (args.maxReactionsAdds !== undefined && totalAdds >= args.maxReactionsAdds) {
                  cursor = undefined;
                  break;
                }
              }
              continue;
            }

            const r = await mirrorReactionsForMessage({
              client,
              channel,
              messageTs: reply.ts,
              authedUserId,
              skipCfg,
              reactionFilterCfg,
              dryRun: args.dryRun,
            });
            totalAdds += r.added;
            totalSkipped += r.skippedAlreadyReacted;
            totalSkippedOwn += r.skippedOwnMessage;
            totalSkippedBlacklisted += r.skippedBlacklisted;

            if (args.maxReactionsAdds !== undefined && totalAdds >= args.maxReactionsAdds) {
              cursor = undefined;
              break;
            }
          }
        }
        continue;
      }

      if (!isOwnMessage) {
        const r = await mirrorReactionsForMessage({
          client,
          channel,
          messageTs: message.ts,
          authedUserId,
          skipCfg,
          reactionFilterCfg,
          dryRun: args.dryRun,
        });
        totalAdds += r.added;
        totalSkipped += r.skippedAlreadyReacted;
        totalSkippedOwn += r.skippedOwnMessage;
        totalSkippedBlacklisted += r.skippedBlacklisted;
      } else {
        totalSkippedOwn += 1;
      }

      if (args.includeThreadReplies && message.reply_count && message.reply_count > 0) {
        const replies = await listThreadReplies(client, channel, message.ts);
        for (const reply of replies) {
          if (!reply.ts) continue;
          if (reply.ts === message.ts) continue;
          if (shouldSkipMessage(reply, skipCfg).skip) {
            totalSkippedOwn += 1;
            continue; // skip reacting on our own messages
          }
          if (!reply.reactions || reply.reactions.length === 0) {
            if (args.addDefaultReactions) {
              const r1 = await addDefaultReactionsForMessage({
                client,
                channel,
                messageTs: reply.ts,
                defaultReactionNames,
                skipCfg,
                reactionFilterCfg,
                dryRun: args.dryRun,
              });
              totalAdds += r1.added;
              totalSkipped += r1.skippedAlreadyReacted;
              totalSkippedOwn += r1.skippedOwnMessage;
              totalSkippedHasReactions += r1.skippedHasReactions;
              totalSkippedBlacklisted += r1.skippedBlacklisted;

              if (args.maxReactionsAdds !== undefined && totalAdds >= args.maxReactionsAdds) {
                cursor = undefined;
                break;
              }
            }
            continue;
          }

          const rr = await mirrorReactionsForMessage({
            client,
            channel,
            messageTs: reply.ts,
            authedUserId,
            skipCfg,
            reactionFilterCfg,
            dryRun: args.dryRun,
          });
          totalAdds += rr.added;
          totalSkipped += rr.skippedAlreadyReacted;
          totalSkippedOwn += rr.skippedOwnMessage;
          totalSkippedBlacklisted += rr.skippedBlacklisted;

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

  console.log(
    `done: messages=${processedMessages} adds=${totalAdds} skipped_already=${totalSkipped} skipped_own=${totalSkippedOwn} skipped_has_reactions=${totalSkippedHasReactions} skipped_blacklisted=${totalSkippedBlacklisted}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
