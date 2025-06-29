// src/middleware/adminAuth.ts
import { createMiddleware } from 'hono/factory';

export const adminAuth = createMiddleware(async (c, next) => {
  const secret = c.req.header('X-Admin-Secret');

  if (!secret || secret !== c.env.ADMIN_SECRET) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
});
