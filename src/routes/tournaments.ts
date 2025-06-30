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

// Get tournament participants (public endpoint)
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
        `SELECT tp.id, tp.status, u.twitch_username, u.twitch_profile_image_url
         FROM TournamentParticipants tp 
         JOIN Users u ON tp.user_id = u.id 
         WHERE tp.tournament_id = ? AND tp.status = 'ACTIVE'
         ORDER BY u.twitch_username`
      ).bind(tournamentId).all();

      return c.json(participants.results || []);
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch tournament participants' }, 500);
    }
  }
);

// Get tournament matches (public endpoint)
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
      const matches = await c.env.DB.prepare(
        `SELECT 
           m.id, m.phase, m.status, m.scheduled_at, m.player_a_score, m.player_b_score,
           pa.id as player_a_id, ua.twitch_username as player_a_username,
           pb.id as player_b_id, ub.twitch_username as player_b_username
         FROM Matches m
         LEFT JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
         LEFT JOIN Users ua ON pa.user_id = ua.id
         LEFT JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id  
         LEFT JOIN Users ub ON pb.user_id = ub.id
         WHERE m.tournament_id = ?
         ORDER BY m.scheduled_at`
      ).bind(tournamentId).all();

      // Transform the data to match expected format
      const formattedMatches = (matches.results || []).map(match => ({
        id: match.id,
        phase: match.phase,
        status: match.status,
        scheduled_at: match.scheduled_at,
        player_a_score: match.player_a_score,
        player_b_score: match.player_b_score,
        player_a: match.player_a_id ? {
          id: match.player_a_id,
          twitch_username: match.player_a_username
        } : null,
        player_b: match.player_b_id ? {
          id: match.player_b_id,
          twitch_username: match.player_b_username
        } : null
      }));

      return c.json(formattedMatches);
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch tournament matches' }, 500);
    }
  }
);

// Get tournament standings (public endpoint)
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
      const standings = await c.env.DB.prepare(
        `SELECT 
           ls.*, u.twitch_username, u.twitch_profile_image_url
         FROM LeagueStandings ls
         JOIN TournamentParticipants tp ON ls.participant_id = tp.id
         JOIN Users u ON tp.user_id = u.id
         WHERE tp.tournament_id = ?
         ORDER BY ls.points DESC, ls.goal_difference DESC, ls.goals_for DESC`
      ).bind(tournamentId).all();

      return c.json(standings.results || []);
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
