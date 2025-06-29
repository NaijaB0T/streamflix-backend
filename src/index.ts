import { Hono } from 'hono';

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

import admin from './routes/admin';
import auth from './routes/auth';
import internal from './routes/internal';
import tournaments from './routes/tournaments';
import users from './routes/users';
import webhooks from './routes/webhooks';

export { MatchStateDO } from './durable-objects/MatchStateDO';
export { UserSessionDO } from './durable-objects/UserSessionDO';

const app = new Hono<{ Bindings: Bindings }>();

app.get('/', (c) => {
  return c.text('Hello from StreamFlix API!');
});

// Modular routes
app.route('/api/auth', auth);
app.route('/api/tournaments', tournaments);
app.route('/api/users', users);
app.route('/api/admin', admin);
app.route('/api/webhooks', webhooks);
app.route('/api/internal', internal);

export default app;
