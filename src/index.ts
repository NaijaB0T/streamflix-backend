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

// Test score endpoint with full Durable Object integration AND database persistence
app.post('/api/admin/matches/:id/score', async (c) => {
  console.log('=== REAL-TIME SCORE ENDPOINT HIT ===');
  const matchId = c.req.param('id');
  
  // Check admin auth
  const secret = c.req.header('X-Admin-Secret');
  if (!secret || secret !== c.env.ADMIN_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  
  try {
    const updates = await c.req.json();
    console.log('Match ID:', matchId);
    console.log('Score Updates:', updates);
    
    // 1. Update the database first for persistence
    const updateFields = [];
    const values = [];
    
    if (updates.player_a_score !== undefined) {
      updateFields.push('player_a_score = ?');
      values.push(updates.player_a_score);
    }
    if (updates.player_b_score !== undefined) {
      updateFields.push('player_b_score = ?');
      values.push(updates.player_b_score);
    }
    
    if (updateFields.length > 0) {
      values.push(matchId);
      await c.env.DB.prepare(
        `UPDATE Matches SET ${updateFields.join(', ')} WHERE id = ?`
      ).bind(...values).run();
      console.log('✅ Database updated with new scores');
    }
    
    // 2. Update the Durable Object for real-time broadcasting
    const doId = c.env.MATCH_STATE_DO.idFromName(`match-${matchId}`);
    const doStub = c.env.MATCH_STATE_DO.get(doId);
    
    // Send score update to Durable Object
    const doResponse = await doStub.fetch(`https://match-state-do/update-score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    
    if (!doResponse.ok) {
      const errorText = await doResponse.text();
      console.error('Durable Object error:', errorText);
      throw new Error(`Durable Object returned ${doResponse.status}: ${errorText}`);
    }
    
    const result = await doResponse.json();
    console.log('Durable Object response:', result);
    
    return c.json({ 
      success: true, 
      message: 'Real-time score update sent and persisted!', 
      matchId, 
      updates,
      doResult: result
    });
  } catch (error) {
    console.error('Real-time score endpoint error:', error);
    return c.json({ error: 'Failed to update score', details: error.message }, 500);
  }
});

// Simple test endpoint
app.get('/api/test', (c) => {
  return c.json({ message: 'Test endpoint works!' });
});

// WebSocket endpoint for match real-time updates
app.get('/api/matches/:id/connect', async (c) => {
  const matchId = c.req.param('id');
  
  console.log('WebSocket connection request for match:', matchId);
  console.log('Request headers:', Object.fromEntries(c.req.headers.entries()));
  
  // Validate matchId
  if (!matchId || !/^\d+$/.test(matchId)) {
    console.error('Invalid match ID:', matchId);
    return c.json({ error: 'Invalid match ID' }, 400);
  }
  
  // Check if this is a WebSocket upgrade request
  const upgradeHeader = c.req.header('upgrade');
  if (upgradeHeader?.toLowerCase() !== 'websocket') {
    console.error('Expected WebSocket upgrade, got:', upgradeHeader);
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }
  
  try {
    // Get the Durable Object for this match
    const doId = c.env.MATCH_STATE_DO.idFromName(`match-${matchId}`);
    const doStub = c.env.MATCH_STATE_DO.get(doId);
    
    console.log('Forwarding WebSocket connection to Durable Object for match:', matchId);
    
    // Create the correct URL for the Durable Object WebSocket endpoint
    const doUrl = new URL(c.req.url);
    doUrl.pathname = '/connect';
    
    // Forward the WebSocket upgrade request to the Durable Object
    const doResponse = await doStub.fetch(doUrl.toString(), {
      method: 'GET',
      headers: c.req.headers
    });
    
    console.log('Durable Object WebSocket response status:', doResponse.status);
    return doResponse;
    
  } catch (error: any) {
    console.error('WebSocket connection error:', error);
    return c.json({ error: 'Failed to connect to match updates', details: error.message }, 500);
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