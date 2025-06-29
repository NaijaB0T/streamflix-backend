import { Hono } from 'hono';
import { Bindings } from './bindings';

import admin from './routes/admin';
import auth from './routes/auth';
import internal from './routes/internal';
import tournaments from './routes/tournaments';
import users from './routes/users';
import webhooks from './routes/webhooks';

import { MatchStateDO, UserSessionDO } from './objects';

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

// Default export for the fetch handler
export default {
  fetch: app.fetch,
};

// Named exports for your Durable Objects
export { MatchStateDO, UserSessionDO };