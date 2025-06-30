// src/routes/tournaments.ts
import { Hono } from 'hono';
import { Bindings } from '..';
import { userAuth } from '../middleware/userAuth';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const tournaments = new Hono<{ Bindings: Bindings }>();

// Get all tournaments (public endpoint)
tournaments.get('/', async (c) => {
  try {
    const allTournaments = await c.env.DB.prepare(
      'SELECT * FROM Tournaments ORDER BY created_at DESC'
    ).all();
    
    return c.json(allTournaments.results);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch tournaments' }, 500);
  }
});

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
      return c.json({ status: 'NOT_REGISTERED' }, 200);
    }

    return c.json({ status: registration.status });
  }
);

// Get tournament details (public endpoint)
tournaments.get(
  '/:id',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');

    try {
      const tournament = await c.env.DB.prepare(
        'SELECT * FROM Tournaments WHERE id = ?'
      ).bind(tournamentId).first();

      if (!tournament) {
        return c.json({ error: 'Tournament not found' }, 404);
      }

      return c.json(tournament);
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch tournament details' }, 500);
    }
  }
);

// Get tournament participants (public endpoint) - queries confirmed registrations directly
tournaments.get(
  '/:id/participants',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');

    try {
      const participants = await c.env.DB.prepare(
        `SELECT tr.id, tr.status, u.twitch_username, u.twitch_profile_image_url
         FROM TournamentRegistrations tr 
         JOIN Users u ON tr.user_id = u.id 
         WHERE tr.tournament_id = ? AND tr.status = 'CONFIRMED'
         ORDER BY u.twitch_username`
      ).bind(tournamentId).all();

      return c.json(participants.results || []);
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch tournament participants' }, 500);
    }
  }
);

// Get tournament matches (public endpoint) - simplified for now
tournaments.get(
  '/:id/matches',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');

    try {
      // For now, return matches directly from the Matches table if they exist
      const matches = await c.env.DB.prepare(
        `SELECT 
           m.id, m.phase, m.status, m.scheduled_at, m.player_a_score, m.player_b_score
         FROM Matches m
         WHERE m.tournament_id = ?
         ORDER BY m.scheduled_at`
      ).bind(tournamentId).all();

      return c.json(matches.results || []);
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch tournament matches' }, 500);
    }
  }
);

// Get tournament standings (public endpoint) - creates initial standings from confirmed registrations
tournaments.get(
  '/:id/standings',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');

    try {
      // Create initial standings from confirmed registrations
      const confirmedParticipants = await c.env.DB.prepare(
        `SELECT u.id, u.twitch_username, u.twitch_profile_image_url
         FROM TournamentRegistrations tr 
         JOIN Users u ON tr.user_id = u.id 
         WHERE tr.tournament_id = ? AND tr.status = 'CONFIRMED'
         ORDER BY u.twitch_username`
      ).bind(tournamentId).all();

      // Return initial standings with zero values
      const initialStandings = (confirmedParticipants.results || []).map(participant => ({
        participant_id: participant.id,
        matches_played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goal_difference: 0,
        points: 0,
        twitch_username: participant.twitch_username,
        twitch_profile_image_url: participant.twitch_profile_image_url
      }));

      return c.json(initialStandings);
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch tournament standings' }, 500);
    }
  }
);

// Get tournament registration count (public endpoint)
tournaments.get(
  '/:id/registration-count',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');

    try {
      const registrationCount = await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM TournamentRegistrations WHERE tournament_id = ?'
      ).bind(tournamentId).first();

      const confirmedCount = await c.env.DB.prepare(
        'SELECT COUNT(*) as count FROM TournamentRegistrations WHERE tournament_id = ? AND status = ?'
      ).bind(tournamentId, 'CONFIRMED').first();

      return c.json({
        total_registrations: registrationCount?.count || 0,
        confirmed_participants: confirmedCount?.count || 0
      });
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch registration count' }, 500);
    }
  }
);

export default tournaments;
