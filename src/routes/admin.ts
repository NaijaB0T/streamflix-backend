// src/routes/admin.ts
import { Hono } from 'hono';
import { Bindings } from '..';
import { adminAuth } from '../middleware/adminAuth';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const admin = new Hono<{ Bindings: Bindings }>();

admin.use('*', adminAuth);

// Admin creates a new tournament
admin.post(
  '/tournaments',
  zValidator(
    'json',
    z.object({
      name: z.string().min(1),
      status: z.enum(['REGISTRATION_OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
    })
  ),
  async (c) => {
    const { name, status } = c.req.valid('json');
    try {
      const { meta } = await c.env.DB.prepare(
        'INSERT INTO Tournaments (name, status) VALUES (?, ?)'
      )
        .bind(name, status)
        .run();
      const newTournament = { id: meta.last_row_id, name, status };
      return c.json({ message: 'Tournament created successfully', tournament: newTournament }, 201);
    } catch (e: any) {
      return c.json({ error: 'Failed to create tournament', details: e.message }, 500);
    }
  }
);

// Get all registrations for a tournament
admin.get(
  '/:id/registrations',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');
    const { results } = await c.env.DB.prepare(
      `SELECT r.id, r.status, u.twitch_username
       FROM TournamentRegistrations r
       JOIN Users u ON r.user_id = u.id
       WHERE r.tournament_id = ?`
    ).bind(tournamentId).all();

    return c.json(results);
  }
);

// Confirm the 36 participants for a tournament
admin.post(
  '/:id/confirm-participants',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  zValidator(
    'json',
    z.object({
      participantIds: z.array(z.number()).min(1).max(36),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');
    const { participantIds } = c.req.valid('json');

    // This should be a transaction
    const db = c.env.DB;
    
    // Update the selected registrations to CONFIRMED status
    // The frontend sends registration IDs, not user IDs
    if (participantIds.length > 0) {
      const placeholders = participantIds.map(() => '?').join(',');
      
      // Set selected participants to CONFIRMED
      await db.prepare(
        `UPDATE TournamentRegistrations
         SET status = 'CONFIRMED'
         WHERE tournament_id = ? AND id IN (${placeholders})`
      ).bind(tournamentId, ...participantIds).run();

      // Get the confirmed registrations to create participants
      const confirmedRegistrations = await db.prepare(
        `SELECT id, user_id FROM TournamentRegistrations 
         WHERE tournament_id = ? AND id IN (${placeholders})`
      ).bind(tournamentId, ...participantIds).all();

      // Create TournamentParticipants for each confirmed registration
      for (const registration of confirmedRegistrations.results || []) {
        await db.prepare(
          'INSERT INTO TournamentParticipants (registration_id, user_id, tournament_id, status) VALUES (?, ?, ?, ?)'
        ).bind(registration.id, registration.user_id, tournamentId, 'ACTIVE').run();
      }

      // Create initial league standings for participants
      const participants = await db.prepare(
        `SELECT id FROM TournamentParticipants 
         WHERE tournament_id = ? AND status = 'ACTIVE'`
      ).bind(tournamentId).all();

      for (const participant of participants.results || []) {
        await db.prepare(
          `INSERT INTO LeagueStandings 
           (participant_id, matches_played, wins, draws, losses, goal_difference, points) 
           VALUES (?, 0, 0, 0, 0, 0, 0)`
        ).bind(participant.id).run();
      }
    }

    return c.json({ message: 'Participants confirmed and initialized' });
  }
);

// Simple SQL migration for all tournaments
admin.post(
  '/migrate-all-data',
  async (c) => {
    const db = c.env.DB;

    try {
      // Step 1: Create TournamentParticipants for all confirmed registrations
      const participantsResult = await db.prepare(`
        INSERT INTO TournamentParticipants (registration_id, user_id, tournament_id, status)
        SELECT 
            tr.id as registration_id,
            tr.user_id,
            tr.tournament_id,
            'ACTIVE' as status
        FROM TournamentRegistrations tr
        WHERE tr.status = 'CONFIRMED'
        AND NOT EXISTS (
            SELECT 1 FROM TournamentParticipants tp 
            WHERE tp.registration_id = tr.id AND tp.tournament_id = tr.tournament_id
        )
      `).run();

      // Step 2: Create LeagueStandings for all participants
      const standingsResult = await db.prepare(`
        INSERT INTO LeagueStandings (participant_id, matches_played, wins, draws, losses, goal_difference, points)
        SELECT 
            tp.id as participant_id,
            0 as matches_played,
            0 as wins, 
            0 as draws,
            0 as losses,
            0 as goal_difference,
            0 as points
        FROM TournamentParticipants tp
        WHERE tp.status = 'ACTIVE'
        AND NOT EXISTS (
            SELECT 1 FROM LeagueStandings ls 
            WHERE ls.participant_id = tp.id
        )
      `).run();

      // Step 3: Get verification data
      const verificationData = await db.prepare(`
        SELECT 
            tp.tournament_id,
            COUNT(*) as participant_count,
            GROUP_CONCAT(u.twitch_username) as usernames
        FROM TournamentParticipants tp
        JOIN Users u ON tp.user_id = u.id  
        WHERE tp.status = 'ACTIVE'
        GROUP BY tp.tournament_id
        ORDER BY tp.tournament_id
      `).all();

      return c.json({ 
        message: 'Migration completed successfully',
        participants_created: participantsResult.meta?.changes || 0,
        standings_created: standingsResult.meta?.changes || 0,
        tournaments_data: verificationData.results || []
      });

    } catch (error: any) {
      return c.json({ error: 'Migration failed', details: error.message }, 500);
    }
  }
);

// Admin creates a new tournament registration
admin.post(
  '/registrations',
  zValidator(
    'json',
    z.object({
      user_id: z.number().int().positive(),
      tournament_id: z.number().int().positive(),
      status: z.enum(['PENDING', 'CONFIRMED', 'NOT_SELECTED']).default('PENDING'),
    })
  ),
  async (c) => {
    const { user_id, tournament_id, status } = c.req.valid('json');
    try {
      const { meta } = await c.env.DB.prepare(
        'INSERT INTO TournamentRegistrations (user_id, tournament_id, status) VALUES (?, ?, ?)'
      )
        .bind(user_id, tournament_id, status)
        .run();
      const newRegistration = { id: meta.last_row_id, user_id, tournament_id, status };
      return c.json({ message: 'Registration created successfully', registration: newRegistration }, 201);
    } catch (e: any) {
      return c.json({ error: 'Failed to create registration', details: e.message }, 500);
    }
  }
);

// Admin creates a new tournament participant
admin.post(
  '/participants',
  zValidator(
    'json',
    z.object({
      registration_id: z.number().int().positive(),
      user_id: z.number().int().positive(),
      tournament_id: z.number().int().positive(),
      status: z.enum(['ACTIVE', 'ELIMINATED', 'WINNER']).default('ACTIVE'),
    })
  ),
  async (c) => {
    const { registration_id, user_id, tournament_id, status } = c.req.valid('json');
    try {
      const { meta } = await c.env.DB.prepare(
        'INSERT INTO TournamentParticipants (registration_id, user_id, tournament_id, status) VALUES (?, ?, ?, ?)'
      )
        .bind(registration_id, user_id, tournament_id, status)
        .run();
      const newParticipant = { id: meta.last_row_id, registration_id, user_id, tournament_id, status };
      return c.json({ message: 'Participant created successfully', participant: newParticipant }, 201);
    } catch (e: any) {
      return c.json({ error: 'Failed to create participant', details: e.message }, 500);
    }
  }
);

// Admin creates a new match
admin.post(
  '/matches',
  zValidator(
    'json',
    z.object({
      tournament_id: z.number().int().positive(),
      phase: z.enum(['LEAGUE', 'KNOCKOUT']),
      status: z.enum(['SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']),
      player_a_participant_id: z.number().int().positive(),
      player_b_participant_id: z.number().int().positive(),
      scheduled_at: z.string().datetime(),
    })
  ),
  async (c) => {
    const { tournament_id, phase, status, player_a_participant_id, player_b_participant_id, scheduled_at } = c.req.valid('json');
    try {
      const { meta } = await c.env.DB.prepare(
        'INSERT INTO Matches (tournament_id, phase, status, player_a_participant_id, player_b_participant_id, scheduled_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
        .bind(tournament_id, phase, status, player_a_participant_id, player_b_participant_id, scheduled_at)
        .run();
      const newMatch = { id: meta.last_row_id, tournament_id, phase, status, player_a_participant_id, player_b_participant_id, scheduled_at };
      return c.json({ message: 'Match created successfully', match: newMatch }, 201);
    } catch (e: any) {
      return c.json({ error: 'Failed to create match', details: e.message }, 500);
    }
  }
);

// Admin deletes a tournament
admin.delete(
  '/tournaments/:id',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');
    try {
      await c.env.DB.prepare('DELETE FROM Tournaments WHERE id = ?').bind(tournamentId).run();
      return c.json({ message: 'Tournament deleted successfully' }, 200);
    } catch (e: any) {
      return c.json({ error: 'Failed to delete tournament', details: e.message }, 500);
    }
  }
);

// Admin deletes a match
admin.delete(
  '/matches/:id',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const matchId = c.req.param('id');
    try {
      await c.env.DB.prepare('DELETE FROM Matches WHERE id = ?').bind(matchId).run();
      return c.json({ message: 'Match deleted successfully' }, 200);
    } catch (e: any) {
      return c.json({ error: 'Failed to delete match', details: e.message }, 500);
    }
  }
);

// Admin deletes a tournament participant
admin.delete(
  '/participants/:id',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const participantId = c.req.param('id');
    try {
      await c.env.DB.prepare('DELETE FROM TournamentParticipants WHERE id = ?').bind(participantId).run();
      return c.json({ message: 'Tournament participant deleted successfully' }, 200);
    } catch (e: any) {
      return c.json({ error: 'Failed to delete tournament participant', details: e.message }, 500);
    }
  }
);

// Admin deletes a tournament registration
admin.delete(
  '/registrations/:id',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const registrationId = c.req.param('id');
    try {
      await c.env.DB.prepare('DELETE FROM TournamentRegistrations WHERE id = ?').bind(registrationId).run();
      return c.json({ message: 'Tournament registration deleted successfully' }, 200);
    } catch (e: any) {
      return c.json({ error: 'Failed to delete tournament registration', details: e.message }, 500);
    }
  }
);

// Admin gets a tournament registration by user_id and tournament_id
admin.get(
  '/registrations/user/:userId/tournament/:tournamentId',
  zValidator(
    'param',
    z.object({
      userId: z.string().regex(/^\d+$/),
      tournamentId: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const userId = c.req.param('userId');
    const tournamentId = c.req.param('tournamentId');
    try {
      const registration = await c.env.DB.prepare(
        'SELECT id FROM TournamentRegistrations WHERE user_id = ? AND tournament_id = ?'
      )
        .bind(userId, tournamentId)
        .first();
      if (!registration) {
        return c.json({ error: 'Registration not found' }, 404);
      }
      return c.json({ registration_id: registration.id }, 200);
    } catch (e: any) {
      return c.json({ error: 'Failed to get registration', details: e.message }, 500);
    }
  }
);

// Start a vote in a match
admin.post(
  '/matches/:matchId/start-vote',
  zValidator(
    'param',
    z.object({
      matchId: z.string().regex(/^\d+$/),
    })
  ),
  zValidator(
    'json',
    z.object({
      points_award: z.number().int().positive(),
      cost_per_vote: z.number().int().positive(),
      duration_seconds: z.number().int().positive(),
    })
  ),
  async (c) => {
    const matchId = c.req.param('matchId');
    const { points_award, cost_per_vote, duration_seconds } = c.req.valid('json');

    // 1. Create a VoteEvent in the database
    // NOTE: This assumes a match with the given matchId already exists.
    // A FOREIGN KEY constraint will fail otherwise.
    const timeModifier = `+${duration_seconds} seconds`;
    const { meta } = await c.env.DB.prepare(
      `INSERT INTO VoteEvents (match_id, points_award, cost_per_vote, end_time) VALUES (?, ?, ?, datetime('now', ?))`
    )
      .bind(matchId, points_award, cost_per_vote, timeModifier)
      .run();
    
    // Fetch the newly created VoteEvent to get the exact end_time from the DB
    const dbVoteEvent = await c.env.DB.prepare(
      'SELECT * FROM VoteEvents WHERE id = ?'
    ).bind(meta.last_row_id).first();

    if (!dbVoteEvent) {
      return c.json({ error: 'Failed to retrieve created vote event' }, 500);
    }

    const voteEventForDO = {
      id: dbVoteEvent.id,
      points_award: dbVoteEvent.points_award,
      cost_per_vote: dbVoteEvent.cost_per_vote,
      // Add a 5-second buffer to the end_time to account for processing delays and ensure it's in the future
      end_time: new Date(new Date(dbVoteEvent.end_time as string).getTime() + 5000).getTime(),
    };

    // 2. Get the MatchStateDO and send it the command
    const id = c.env.MATCH_STATE_DO.idFromName(matchId);
    const stub = c.env.MATCH_STATE_DO.get(id);

    await stub.fetch('http://do/start-vote', {
      method: 'POST',
      body: JSON.stringify({ event: voteEventForDO }),
    });

    return c.json({ message: 'Vote started', event: dbVoteEvent });
  }
);

// Admin gets all users
admin.get('/users', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, twitch_id, twitch_username, twitch_profile_image_url, points_balance, is_banned, created_at, updated_at FROM Users ORDER BY created_at DESC'
    ).all();
    return c.json(results);
  } catch (e: any) {
    return c.json({ error: 'Failed to fetch users', details: e.message }, 500);
  }
});

// Admin creates a new user
admin.post(
  '/users',
  zValidator(
    'json',
    z.object({
      twitch_id: z.string().min(1),
      twitch_username: z.string().min(1),
      twitch_profile_image_url: z.string().url().optional(),
      points_balance: z.number().int().min(0).default(0),
      is_banned: z.number().int().min(0).max(1).default(0),
    })
  ),
  async (c) => {
    const { twitch_id, twitch_username, twitch_profile_image_url, points_balance, is_banned } = c.req.valid('json');
    try {
      const { meta } = await c.env.DB.prepare(
        'INSERT INTO Users (twitch_id, twitch_username, twitch_profile_image_url, points_balance, is_banned) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(twitch_id, twitch_username, twitch_profile_image_url, points_balance, is_banned)
        .run();
      const newUser = { id: meta.last_row_id, twitch_id, twitch_username, twitch_profile_image_url, points_balance, is_banned };
      return c.json({ message: 'User created successfully', user: newUser }, 201);
    } catch (e: any) {
      return c.json({ error: 'Failed to create user', details: e.message }, 500);
    }
  }
);

// Admin deletes a user
admin.delete(
  '/users/:id',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const userId = c.req.param('id');
    try {
      await c.env.DB.prepare('DELETE FROM Users WHERE id = ?').bind(userId).run();
      return c.json({ message: 'User deleted successfully' }, 200);
    } catch (e: any) {
      return c.json({ error: 'Failed to delete user', details: e.message }, 500);
    }
  }
);

export default admin;
