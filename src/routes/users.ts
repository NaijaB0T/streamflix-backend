// src/routes/users.ts
import { Hono } from 'hono';
import { Bindings } from '..';
import { userAuth } from '../middleware/userAuth';

const users = new Hono<{ Bindings: Bindings }>();

users.get('/connect', userAuth, async (c) => {
  const { sub: userId } = c.get('jwtPayload');

  if (!userId) {
    return c.json({ error: 'User ID not found in token' }, 400);
  }

  const id = c.env.USER_SESSION_DO.idFromName(userId.toString());
  const stub = c.env.USER_SESSION_DO.get(id);

  // The request to the DO must be a new request object
  const request = new Request(c.req.raw.url, c.req.raw);
  
  return stub.fetch(request);
});

export default users;
