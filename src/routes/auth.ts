// src/routes/auth.ts
import { Hono } from 'hono';
import { Bindings } from '..';
import { sign } from 'hono/jwt';
import { setCookie } from 'hono/cookie';

const auth = new Hono<{ Bindings: Bindings }>();

// Redirect to Twitch for authorization
auth.get('/login', (c) => {
  const twitchAuthUrl = new URL('https://id.twitch.tv/oauth2/authorize');
  twitchAuthUrl.searchParams.set('client_id', c.env.TWITCH_CLIENT_ID);
  twitchAuthUrl.searchParams.set('redirect_uri', 'https://streamflix-backend.femivideograph.workers.dev/api/auth/callback');
  twitchAuthUrl.searchParams.set('response_type', 'code');
  twitchAuthUrl.searchParams.set('scope', 'channel:read:subscriptions user:read:email');

  return c.redirect(twitchAuthUrl.toString());
});

// Handle the callback from Twitch
auth.get('/callback', async (c) => {
  const code = c.req.query('code');

  if (!code) {
    return c.json({ error: 'Authorization code is missing' }, 400);
  }

  // Exchange authorization code for an access token
  const tokenResponse = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      client_id: c.env.TWITCH_CLIENT_ID,
      client_secret: c.env.TWITCH_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
      redirect_uri: 'https://streamflix-backend.femivideograph.workers.dev/api/auth/callback',
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    return c.json({ error: 'Failed to exchange code for token', details: errorBody }, 500);
  }

  const tokenData = await tokenResponse.json() as { access_token: string };
  const accessToken = tokenData.access_token;

  // Get user info from Twitch
  const userResponse = await fetch('https://api.twitch.tv/helix/users', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Client-Id': c.env.TWITCH_CLIENT_ID,
    },
  });

  if (!userResponse.ok) {
    return c.json({ error: 'Failed to get user info from Twitch' }, 500);
  }

  const userData = await userResponse.json() as { data: { id: string, login: string, profile_image_url: string }[] };
  const twitchUser = userData.data[0];

  // Check if user exists in our DB, create if not
  let user = await c.env.DB.prepare('SELECT * FROM Users WHERE twitch_id = ?').bind(twitchUser.id).first();

  if (!user) {
    const { results } = await c.env.DB.prepare(
      'INSERT INTO Users (twitch_id, twitch_username, twitch_profile_image_url) VALUES (?, ?, ?) RETURNING *'
    )
      .bind(twitchUser.id, twitchUser.login, twitchUser.profile_image_url)
      .run();
    user = results[0];
  } else {
    // Update user's profile image if it has changed
    await c.env.DB.prepare(
      'UPDATE Users SET twitch_profile_image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE twitch_id = ?'
    )
      .bind(twitchUser.profile_image_url, twitchUser.id)
      .run();
    // Re-fetch the user to get the updated data
    user = await c.env.DB.prepare('SELECT * FROM Users WHERE twitch_id = ?').bind(twitchUser.id).first();
  }

  if (!user) {
    return c.json({ error: 'Failed to retrieve user data after authentication' }, 500);
  }

  // Create a JWT
  const payload = {
    sub: user.id,
    twitch_id: user.twitch_id,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 7, // 7 days
  };
  const secret = c.env.JWT_SECRET; // You'll need to add JWT_SECRET to your secrets
  const token = await sign(payload, secret);

  // For cross-domain setup, send token as URL parameter instead of cookie
  // The frontend will then store it in localStorage and send it in headers
  const frontendUrl = new URL('http://localhost:3000');
  frontendUrl.searchParams.set('token', token);
  
  return c.redirect(frontendUrl.toString());
});

export default auth;
