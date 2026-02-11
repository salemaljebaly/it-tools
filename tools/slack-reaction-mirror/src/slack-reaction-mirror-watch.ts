import "dotenv/config";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in environment (.env).`);
  return v;
}

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

function getSlackApiErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const anyErr = err as { data?: { error?: unknown } };
  return typeof anyErr.data?.error === "string" ? anyErr.data.error : undefined;
}

async function withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const retryAfter = getRetryAfterSeconds(err);
      if (retryAfter === undefined) throw err;
      // eslint-disable-next-line no-console
      console.warn(`Rate limited; sleeping ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
    }
  }
}

type ReactionAddedEvent = {
  type: "reaction_added";
  user: string;
  reaction: string;
  item_user?: string;
  item: { type: string; channel?: string; ts?: string };
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

async function getMessageWithReactions(
  web: WebClient,
  channel: string,
  ts: string,
): Promise<{ message?: unknown; reactions: Array<{ name?: string; users?: string[] }> }> {
  const res = await withRateLimitRetry(() => web.reactions.get({ channel, timestamp: ts, full: true }));
  const msg = (res.message as unknown) ?? undefined;
  const reactions = (res.message as { reactions?: Array<{ name?: string; users?: string[] }> } | undefined)?.reactions ?? [];
  return { message: msg, reactions };
}

async function main(): Promise<void> {
  const slackUserToken = requiredEnv("SLACK_USER_TOKEN");
  const slackAppToken = requiredEnv("SLACK_APP_TOKEN"); // xapp-...
  const filterChannelId = optionalEnv("SLACK_CHANNEL_ID");
  const configuredMyUserId = optionalEnv("SLACK_MY_USER_ID");
  const skipMessageContains = parseCommaList(optionalEnv("SLACK_SKIP_MESSAGE_CONTAINS"));
  const skipMessageRegexStr = optionalEnv("SLACK_SKIP_MESSAGE_REGEX");
  const skipMessageRegex = skipMessageRegexStr ? new RegExp(skipMessageRegexStr, "i") : undefined;
  const debugSkip = optionalEnv("SLACK_DEBUG_SKIP") === "1";
  const reactionBlacklistExact = parseListOrJsonArray(optionalEnv("SLACK_REACTION_BLACKLIST")).map(normalizeReactionName);
  const reactionBlacklistContains = parseListOrJsonArray(optionalEnv("SLACK_REACTION_BLACKLIST_CONTAINS")).map(
    normalizeReactionName,
  );
  const reactionBlacklistRegexStr = optionalEnv("SLACK_REACTION_BLACKLIST_REGEX");
  const reactionBlacklistRegex = reactionBlacklistRegexStr ? new RegExp(reactionBlacklistRegexStr, "i") : undefined;

  const web = new WebClient(slackUserToken);
  const auth = await withRateLimitRetry(() => web.auth.test());
  const authedUserId = auth.user_id;
  const authedUserName = typeof auth.user === "string" ? auth.user : undefined;
  if (!authedUserId) throw new Error("Could not determine user_id from auth.test()");

  const skipUserId = configuredMyUserId ?? authedUserId;
  if (configuredMyUserId && configuredMyUserId !== authedUserId) {
    // eslint-disable-next-line no-console
    console.warn(
      `SLACK_MY_USER_ID=${configuredMyUserId} does not match token user_id=${authedUserId}; using SLACK_MY_USER_ID only for skip logic`,
    );
  }

  const baseAliases =
    skipUserId === authedUserId && authedUserName ? [authedUserName, `@${authedUserName}`] : [];
  let userInfoAliases: string[] = [];
  try {
    const userInfo = await withRateLimitRetry(() => web.users.info({ user: skipUserId }));
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

  const skipCfg: SkipConfig = {
    skipUserId,
    skipUserAliases: [...baseAliases, ...userInfoAliases].filter((v, i, arr) => arr.indexOf(v) === i),
    skipMessageRegex,
    skipMessageContains,
    debugSkip,
  };

  const reactionFilterCfg: ReactionFilterConfig = {
    blacklistExact: new Set(reactionBlacklistExact),
    blacklistContains: reactionBlacklistContains.filter((v, i, arr) => arr.indexOf(v) === i),
    blacklistRegex: reactionBlacklistRegex,
    debug: debugSkip,
  };

  // eslint-disable-next-line no-console
  console.log(
    [
      `watching as user=${authedUserId}`,
      skipUserId !== authedUserId ? `skipUser=${skipUserId}` : undefined,
      filterChannelId ? `channelFilter=${filterChannelId}` : "channelFilter=none",
    ].join(" "),
  );

  const socketClient = new SocketModeClient({ appToken: slackAppToken });

  socketClient.on("events_api", async ({ body, ack }) => {
    await ack();

    const event = body.event as Partial<ReactionAddedEvent> | undefined;
    if (!event || event.type !== "reaction_added") return;
    if (!event.item || event.item.type !== "message") return;

    const channel = event.item.channel;
    const ts = event.item.ts;
    const reaction = event.reaction;
    const reactingUser = event.user;

    if (!channel || !ts || !reaction || !reactingUser) return;
    if (reactingUser === authedUserId) return; // prevent loops: ignore our own adds
    if (filterChannelId && channel !== filterChannelId) return;
    const canonicalReaction = canonicalizeReactionName(reaction);
    if (isReactionBlocked(reaction, reactionFilterCfg) || isReactionBlocked(canonicalReaction, reactionFilterCfg)) {
      if (reactionFilterCfg.debug) console.log(`[blocklist] skip :${reaction}: for ${channel} @ ${ts}`);
      return;
    }

    try {
      const authorId = event.item_user;
      if (authorId === skipCfg.skipUserId) {
        if (skipCfg.debugSkip) console.log(`[skip] ${channel} @ ${ts} reason=item_user`);
        return; // skip reacting on our own messages
      }

      const { message, reactions } = await getMessageWithReactions(web, channel, ts);
      if (!message) return;

      const skip = shouldSkipMessage(message, skipCfg);
      if (skip.skip) {
        if (skipCfg.debugSkip) console.log(`[skip] ${channel} @ ${ts} reason=${skip.reason ?? "unknown"}`);
        return;
      }

      const alreadyReactedAnyVariant = reactions.some((r) => {
        const n = r.name;
        if (!n) return false;
        if (canonicalizeReactionName(n) !== canonicalReaction) return false;
        return (r.users ?? []).includes(authedUserId);
      });
      if (alreadyReactedAnyVariant) return;

      await withRateLimitRetry(() => web.reactions.add({ name: canonicalReaction, channel, timestamp: ts }));
      // eslint-disable-next-line no-console
      console.log(`added :${canonicalReaction}: to ${channel} @ ${ts}`);
    } catch (err) {
      const errorCode = getSlackApiErrorCode(err);
      if (errorCode === "already_reacted") return;
      if (errorCode === "too_many_reactions") {
        // eslint-disable-next-line no-console
        console.log(`[skip] too_many_reactions for ${channel} @ ${ts}; cannot add :${canonicalReaction}:`);
        return;
      }
      // eslint-disable-next-line no-console
      console.error(`failed to add :${canonicalReaction}: to ${channel} @ ${ts}`, err);
    }
  });

  await socketClient.start();
  // eslint-disable-next-line no-console
  console.log("socket mode connected; listening for reaction_added...");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
