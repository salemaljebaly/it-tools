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
  return v && v.trim().length > 0 ? v : undefined;
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
  item: { type: string; channel?: string; ts?: string };
};

async function main(): Promise<void> {
  const slackUserToken = requiredEnv("SLACK_USER_TOKEN");
  const slackAppToken = requiredEnv("SLACK_APP_TOKEN"); // xapp-...
  const filterChannelId = optionalEnv("SLACK_CHANNEL_ID");

  const web = new WebClient(slackUserToken);
  const auth = await withRateLimitRetry(() => web.auth.test());
  const myUserId = auth.user_id;
  if (!myUserId) throw new Error("Could not determine user_id from auth.test()");

  // eslint-disable-next-line no-console
  console.log(
    [
      `watching as user=${myUserId}`,
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
    if (reactingUser === myUserId) return; // prevent loops: ignore our own adds
    if (filterChannelId && channel !== filterChannelId) return;

    try {
      await withRateLimitRetry(() => web.reactions.add({ name: reaction, channel, timestamp: ts }));
      // eslint-disable-next-line no-console
      console.log(`added :${reaction}: to ${channel} @ ${ts}`);
    } catch (err) {
      const anyErr = err as { data?: { error?: string } };
      if (anyErr?.data?.error === "already_reacted") return;
      // eslint-disable-next-line no-console
      console.error(`failed to add :${reaction}: to ${channel} @ ${ts}`, err);
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

