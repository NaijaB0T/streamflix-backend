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

// Test score endpoint with exact path match
app.post('/api/admin/matches/:id/score', async (c) => {
  console.log('=== SCORE ENDPOINT HIT ===');
  const matchId = c.req.param('id');
  
  try {
    const updates = await c.req.json();
    console.log('Match ID:', matchId);
    console.log('Updates:', updates);
    
    return c.json({ 
      success: true, 
      message: 'Score endpoint working!', 
      matchId, 
      updates 
    });
  } catch (error) {
    console.error('Score endpoint error:', error);
    return c.json({ error: 'Failed', details: error.message }, 400);
  }
});

// Simple test endpoint
app.get('/api/test', (c) => {
  return c.json({ message: 'Test endpoint works!' });
});

// WebSocket endpoint for match real-time updates
app.get('/api/matches/:id/connect', async (c) => {
  const matchId = c.req.param('id');
  
  // Validate matchId
  if (!matchId || !/^\d+$/.test(matchId)) {
    return c.json({ error: 'Invalid match ID' }, 400);
  }
  
  try {
    // Get the Durable Object for this match
    const doId = c.env.MATCH_STATE_DO.idFromName(`match-${matchId}`);
    const doStub = c.env.MATCH_STATE_DO.get(doId);
    
    // Forward the WebSocket connection to the Durable Object
    return doStub.fetch(`https://match-state-do/connect`, {
      headers: c.req.headers
    });
  } catch (error: any) {
    console.error('WebSocket connection error:', error);
    return c.json({ error: 'Failed to connect to match updates' }, 500);
  }
});

// Modular routes  
app.route('/api/auth', auth);
app.route('/api/tournaments', tournaments);
app.route('/api/users', users);
// NOTE: admin route is AFTER the specific score endpoint
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