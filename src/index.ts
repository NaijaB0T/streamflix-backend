import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Bindings } from './bindings';

// Export Bindings for other modules
export { Bindings };

import admin from './routes/admin';
import auth from './routes/auth';
import internal from './routes/internal';
import tournaments from './routes/tournaments';
import users from './routes/users';
import webhooks from './routes/webhooks';
import notifications from './routes/notifications';

import { MatchStateDO, UserSessionDO } from './objects';

const app = new Hono<{ Bindings: Bindings }>();

// Add CORS middleware
app.use('*', cors({
  origin: ['http://localhost:3000', 'http://localhost:5173', 'https://streamflix.femitaofeeq.com'], // Allow local development and production
  credentials: true, // Allow cookies to be sent
  allowHeaders: ['Content-Type', 'Authorization', 'X-Admin-Secret'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}));

app.get('/', (c) => {
  return c.text('Hello from StreamFlix API!');
});

// Test endpoint for match updates (bypassing admin router)
app.patch('/api/admin/matches/:id', async (c) => {
  const matchId = c.req.param('id');
  console.log('Direct patch endpoint hit, matchId:', matchId);
  
  try {
    const updates = await c.req.json();
    console.log('Direct endpoint - received updates:', updates);
    
    return c.json({ success: true, message: 'Test endpoint works', data: updates });
  } catch (error) {
    console.error('Direct endpoint error:', error);
    return c.json({ error: 'Test endpoint failed', details: error.message }, 400);
  }
});

// Modular routes
app.route('/api/auth', auth);
app.route('/api/tournaments', tournaments);
app.route('/api/users', users);
app.route('/api/admin', admin);
app.route('/api/webhooks', webhooks);
app.route('/api/internal', internal);
app.route('/api/notifications', notifications);

// Default export for the fetch handler
export default {
  fetch: app.fetch,
};

// Named exports for your Durable Objects
export { MatchStateDO, UserSessionDO };