// src/middleware/userAuth.ts
import { createMiddleware } from 'hono/factory';
import { verify } from 'hono/jwt';
import { getCookie } from 'hono/cookie';

export const userAuth = createMiddleware(async (c, next) => {
  // Try to get token from Authorization header first, then fallback to cookie
  const authHeader = c.req.header('Authorization');
  let token = null;
  
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7); // Remove 'Bearer ' prefix
  } else {
    token = getCookie(c, 'auth_token');
  }

  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  try {
    const secret = c.env.JWT_SECRET;
    const payload = await verify(token, secret);
    c.set('jwtPayload', payload);
  } catch (e) {
    return c.json({ error: 'Invalid token' }, 401);
  }

  await next();
});
