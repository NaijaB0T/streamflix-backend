// src/routes/webhooks.ts
import { Hono } from 'hono';
import { Bindings } from '..';
import { HTTPException } from 'hono/http-exception';

const webhooks = new Hono<{ Bindings: Bindings }>();

// Middleware to verify Twitch webhook signature
const verifyTwitchSignature = async (c: any, next: any) => {
  const messageId = c.req.header('Twitch-Eventsub-Message-Id');
  const timestamp = c.req.header('Twitch-Eventsub-Message-Timestamp');
  const signature = c.req.header('Twitch-Eventsub-Message-Signature');
  const body = await c.req.text();

  if (!messageId || !timestamp || !signature || !body) {
    throw new HTTPException(400, { message: 'Missing signature headers or body' });
  }

  const hmacMessage = messageId + timestamp + body;
  const secret = c.env.TWITCH_WEBHOOK_SECRET; // You'll need to add this secret

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const expectedSignature = `sha256=${Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(hmacMessage))))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`;

  if (signature !== expectedSignature) {
    throw new HTTPException(403, { message: 'Invalid signature' });
  }

  await next();
};

webhooks.post('/twitch', verifyTwitchSignature, async (c) => {
  const body = await c.req.json();
  const messageType = c.req.header('Twitch-Eventsub-Message-Type');

  // Handle webhook verification challenge
  if (messageType === 'webhook_callback_verification') {
    return c.text(body.challenge);
  }

  // Process other notifications
  if (messageType === 'notification') {
    const { event } = body;
    
    // TODO: Process the event (e.g., channel point redemption)
    console.log('Received event:', event);

    // Example: Update user points
    if (event.reward?.id === 'YOUR_REWARD_ID') {
      const twitchUserId = event.user_id;
      // 1. Find user in DB
      // 2. Update points
      // 3. Create transaction record
      // 4. Signal UserSessionDO to push update
    }
  }

  return c.status(204);
});

export default webhooks;
