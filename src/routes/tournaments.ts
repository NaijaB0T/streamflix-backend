// src/routes/tournaments.ts
import { Hono } from 'hono';
import { Bindings } from '..';
import { userAuth } from '../middleware/userAuth';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const tournaments = new Hono<{ Bindings: Bindings }>();

// User registers for a tournament
tournaments.post(
  '/:id/register',
  userAuth,
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');
    const { sub: userId } = c.get('jwtPayload');

    // 1. Check if tournament exists and is open for registration
    const tournament = await c.env.DB.prepare(
      'SELECT * FROM Tournaments WHERE id = ? AND status = ?'
    ).bind(tournamentId, 'REGISTRATION_OPEN').first();

    if (!tournament) {
      return c.json({ error: 'Tournament not found or not open for registration' }, 404);
    }

    // 2. TODO: Verify subscriber status via Twitch API
    // For now, we'll assume the user is a subscriber

    // 3. Create registration record
    try {
      await c.env.DB.prepare(
        'INSERT INTO TournamentRegistrations (user_id, tournament_id) VALUES (?, ?)'
      )
        .bind(userId, tournamentId)
        .run();
    } catch (e: any) {
      if (e.message.includes('UNIQUE constraint failed')) {
        return c.json({ error: 'Already registered for this tournament' }, 409);
      }
      return c.json({ error: 'Failed to register for tournament', details: e.message }, 500);
    }

    return c.json({ message: 'Successfully registered for the tournament' }, 201);
  }
);

// User checks their registration status
tournaments.get(
  '/:id/my-registration-status',
  userAuth,
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');
    const { sub: userId } = c.get('jwtPayload');

    const registration = await c.env.DB.prepare(
      'SELECT status FROM TournamentRegistrations WHERE user_id = ? AND tournament_id = ?'
    )
      .bind(userId, tournamentId)
      .first();

    if (!registration) {
      return c.json({ status: 'NOT_REGISTERED' }, 404);
    }

    return c.json({ status: registration.status });
  }
);

export default tournaments;
