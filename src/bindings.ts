export type Bindings = {
  DB: D1Database;
  KV: KVNamespace;
  MATCH_STATE_DO: DurableObjectNamespace;
  USER_SESSION_DO: DurableObjectNamespace;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  ADMIN_SECRET: string;
  JWT_SECRET: string;
  TWITCH_WEBHOOK_SECRET: string;
};