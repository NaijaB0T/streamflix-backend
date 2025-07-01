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
    
    // Simply update the selected registrations to CONFIRMED status
    // The frontend sends registration IDs, not user IDs
    if (participantIds.length > 0) {
      const placeholders = participantIds.map(() => '?').join(',');
      
      // Set selected participants to CONFIRMED
      await db.prepare(
        `UPDATE TournamentRegistrations
         SET status = 'CONFIRMED'
         WHERE tournament_id = ? AND id IN (${placeholders})`
      ).bind(tournamentId, ...participantIds).run();
    }

    return c.json({ message: 'Participants confirmed successfully' });
  }
);

// Update tournament status
admin.patch(
  '/tournaments/:id/status',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  zValidator(
    'json',
    z.object({
      status: z.enum(['DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'AWAITING_SELECTION', 'LEAGUE_PHASE', 'KNOCKOUTS', 'COMPLETED'])
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');
    const { status } = c.req.valid('json');
    
    try {
      await c.env.DB.prepare(
        'UPDATE Tournaments SET status = ? WHERE id = ?'
      ).bind(status, tournamentId).run();

      return c.json({ 
        message: `Tournament status updated to ${status}`,
        status: status 
      });
    } catch (error: any) {
      return c.json({ error: 'Failed to update tournament status', details: error.message }, 500);
    }
  }
);

// Save tournament fixtures to database
admin.post(
  '/:id/save-fixtures',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  zValidator(
    'json',
    z.object({
      fixtures: z.array(z.object({
        homePlayerRegistrationId: z.number(),
        awayPlayerRegistrationId: z.number(),
        pot: z.string(),
        phase: z.string().default('LEAGUE')
      }))
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');
    const { fixtures } = c.req.valid('json');
    const db = c.env.DB;

    try {
      // Delete existing fixtures for this tournament
      await db.prepare('DELETE FROM Matches WHERE tournament_id = ?').bind(tournamentId).run();

      // Insert new fixtures - using registration IDs to get user IDs
      for (const fixture of fixtures) {
        // Get user IDs from registration IDs
        const homePlayerReg = await db.prepare(
          'SELECT user_id FROM TournamentRegistrations WHERE id = ?'
        ).bind(fixture.homePlayerRegistrationId).first();
        
        const awayPlayerReg = await db.prepare(
          'SELECT user_id FROM TournamentRegistrations WHERE id = ?'
        ).bind(fixture.awayPlayerRegistrationId).first();

        if (homePlayerReg && awayPlayerReg) {
          // First ensure we have participant records (needed for matches table schema)
          let homeParticipant = await db.prepare(
            'SELECT id FROM TournamentParticipants WHERE user_id = ? AND tournament_id = ?'
          ).bind(homePlayerReg.user_id, tournamentId).first();

          let awayParticipant = await db.prepare(
            'SELECT id FROM TournamentParticipants WHERE user_id = ? AND tournament_id = ?'
          ).bind(awayPlayerReg.user_id, tournamentId).first();

          // Create participant records if they don't exist
          if (!homeParticipant) {
            const result = await db.prepare(
              'INSERT INTO TournamentParticipants (registration_id, user_id, tournament_id, status) VALUES (?, ?, ?, ?)'
            ).bind(fixture.homePlayerRegistrationId, homePlayerReg.user_id, tournamentId, 'ACTIVE').run();
            homeParticipant = { id: result.meta.last_row_id };
          }

          if (!awayParticipant) {
            const result = await db.prepare(
              'INSERT INTO TournamentParticipants (registration_id, user_id, tournament_id, status) VALUES (?, ?, ?, ?)'
            ).bind(fixture.awayPlayerRegistrationId, awayPlayerReg.user_id, tournamentId, 'ACTIVE').run();
            awayParticipant = { id: result.meta.last_row_id };
          }

          // Create the match
          await db.prepare(
            `INSERT INTO Matches 
             (tournament_id, phase, status, player_a_participant_id, player_b_participant_id, scheduled_at) 
             VALUES (?, ?, 'SCHEDULED', ?, ?, datetime('now', '+7 days'))`
          ).bind(
            tournamentId, 
            fixture.phase, 
            homeParticipant.id, 
            awayParticipant.id
          ).run();
        }
      }

      return c.json({ 
        message: 'Fixtures saved successfully',
        fixtures_count: fixtures.length 
      });

    } catch (error: any) {
      return c.json({ error: 'Failed to save fixtures', details: error.message }, 500);
    }
  }
);

// Update match details (schedule, scores, status)
admin.patch(
  '/matches/:id',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  zValidator(
    'json',
    z.object({
      scheduled_at: z.string().optional(),
      status: z.enum(['SCHEDULED', 'LIVE', 'COMPLETED']).optional(),
      player_a_score: z.number().optional(),
      player_b_score: z.number().optional(),
      winner_participant_id: z.number().optional()
    })
  ),
  async (c) => {
    const matchId = c.req.param('id');
    const updates = c.req.valid('json');
    const db = c.env.DB;

    try {
      // Build dynamic update query
      const updateFields = [];
      const values = [];
      
      if (updates.scheduled_at) {
        updateFields.push('scheduled_at = ?');
        values.push(updates.scheduled_at);
      }
      if (updates.status) {
        updateFields.push('status = ?');
        values.push(updates.status);
      }
      if (updates.player_a_score !== undefined) {
        updateFields.push('player_a_score = ?');
        values.push(updates.player_a_score);
      }
      if (updates.player_b_score !== undefined) {
        updateFields.push('player_b_score = ?');
        values.push(updates.player_b_score);
      }
      if (updates.winner_participant_id) {
        updateFields.push('winner_participant_id = ?');
        values.push(updates.winner_participant_id);
      }

      if (updateFields.length === 0) {
        return c.json({ error: 'No fields to update' }, 400);
      }

      values.push(matchId);
      
      await db.prepare(
        `UPDATE Matches SET ${updateFields.join(', ')} WHERE id = ?`
      ).bind(...values).run();

      // If match is completed, update league standings
      if (updates.status === 'COMPLETED' && updates.player_a_score !== undefined && updates.player_b_score !== undefined) {
        await updateLeagueStandings(db, matchId, updates.player_a_score, updates.player_b_score, updates.winner_participant_id);
      }

      return c.json({ message: 'Match updated successfully' });
    } catch (error: any) {
      return c.json({ error: 'Failed to update match', details: error.message }, 500);
    }
  }
);

// Get matches for a tournament with detailed info
admin.get(
  '/tournaments/:id/matches',
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
           m.winner_participant_id,
           pa.id as player_a_participant_id, ua.twitch_username as player_a_username, ua.twitch_profile_image_url as player_a_image,
           pb.id as player_b_participant_id, ub.twitch_username as player_b_username, ub.twitch_profile_image_url as player_b_image
         FROM Matches m
         LEFT JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
         LEFT JOIN Users ua ON pa.user_id = ua.id
         LEFT JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id  
         LEFT JOIN Users ub ON pb.user_id = ub.id
         WHERE m.tournament_id = ?
         ORDER BY m.scheduled_at ASC`
      ).bind(tournamentId).all();

      const formattedMatches = (matches.results || []).map(match => ({
        id: match.id,
        phase: match.phase,
        status: match.status,
        scheduled_at: match.scheduled_at,
        player_a_score: match.player_a_score,
        player_b_score: match.player_b_score,
        winner_participant_id: match.winner_participant_id,
        player_a: {
          participant_id: match.player_a_participant_id,
          twitch_username: match.player_a_username,
          twitch_profile_image_url: match.player_a_image
        },
        player_b: {
          participant_id: match.player_b_participant_id,
          twitch_username: match.player_b_username,
          twitch_profile_image_url: match.player_b_image
        }
      }));

      return c.json(formattedMatches);
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch matches', details: error.message }, 500);
    }
  }
);

// Helper function to update league standings after match completion
async function updateLeagueStandings(db: any, matchId: number, scoreA: number, scoreB: number, winnerId?: number) {
  // Get match participants
  const match = await db.prepare(
    'SELECT player_a_participant_id, player_b_participant_id FROM Matches WHERE id = ?'
  ).bind(matchId).first();

  if (!match) return;

  const participantA = match.player_a_participant_id;
  const participantB = match.player_b_participant_id;

  // Determine match result
  let aPoints = 0, bPoints = 0, aWins = 0, bWins = 0, aDraws = 0, bDraws = 0, aLosses = 0, bLosses = 0;

  if (scoreA > scoreB) {
    aPoints = 3; bPoints = 0; aWins = 1; bLosses = 1;
  } else if (scoreB > scoreA) {
    bPoints = 3; aPoints = 0; bWins = 1; aLosses = 1;
  } else {
    aPoints = 1; bPoints = 1; aDraws = 1; bDraws = 1;
  }

  // Update standings for both participants
  for (const [participantId, points, wins, draws, losses, goalsFor, goalsAgainst] of [
    [participantA, aPoints, aWins, aDraws, aLosses, scoreA, scoreB],
    [participantB, bPoints, bWins, bDraws, bLosses, scoreB, scoreA]
  ]) {
    await db.prepare(`
      INSERT INTO LeagueStandings (participant_id, points, matches_played, wins, draws, losses)
      VALUES (?, ?, 1, ?, ?, ?)
      ON CONFLICT(participant_id) DO UPDATE SET
        points = points + ?,
        matches_played = matches_played + 1,
        wins = wins + ?,
        draws = draws + ?,
        losses = losses + ?
    `).bind(
      participantId, points, wins, draws, losses,
      points, wins, draws, losses
    ).run();
  }
}

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
      status: z.enum(['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED']),
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

// Admin updates a match
admin.patch('/matches/:id', adminAuth, async (c) => {
    const matchId = c.req.param('id');
    
    // Validate matchId parameter
    if (!matchId || !/^\d+$/.test(matchId)) {
      return c.json({ error: 'Invalid match ID' }, 400);
    }
    
    let updates;
    try {
      updates = await c.req.json();
      console.log('Received updates:', updates);
      
      // Simple validation without Zod for now
      const allowedFields = ['status', 'player_a_score', 'player_b_score', 'winner_participant_id'];
      const validStatuses = ['SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED'];
      
      for (const [key, value] of Object.entries(updates)) {
        if (!allowedFields.includes(key)) {
          return c.json({ error: `Invalid field: ${key}` }, 400);
        }
        
        if (key === 'status' && !validStatuses.includes(value)) {
          return c.json({ error: `Invalid status: ${value}` }, 400);
        }
        
        if ((key === 'player_a_score' || key === 'player_b_score') && 
            (typeof value !== 'number' || value < 0 || !Number.isInteger(value))) {
          return c.json({ error: `Invalid ${key}: must be a non-negative integer` }, 400);
        }
        
        if (key === 'winner_participant_id' && value !== null && 
            (typeof value !== 'number' || value <= 0 || !Number.isInteger(value))) {
          return c.json({ error: `Invalid winner_participant_id: must be a positive integer or null` }, 400);
        }
      }
      
    } catch (error) {
      console.error('JSON parse error:', error);
      return c.json({ error: 'Invalid JSON in request body', details: error.message }, 400);
    }
    
    try {
      // Build the SQL update query dynamically based on provided fields
      const setClause = [];
      const values = [];
      
      if (updates.status !== undefined) {
        setClause.push('status = ?');
        values.push(updates.status);
      }
      
      if (updates.player_a_score !== undefined) {
        setClause.push('player_a_score = ?');
        values.push(updates.player_a_score);
      }
      
      if (updates.player_b_score !== undefined) {
        setClause.push('player_b_score = ?');
        values.push(updates.player_b_score);
      }
      
      if (updates.winner_participant_id !== undefined) {
        setClause.push('winner_participant_id = ?');
        values.push(updates.winner_participant_id);
      }
      
      if (setClause.length === 0) {
        return c.json({ error: 'No valid update fields provided' }, 400);
      }
      
      values.push(matchId);
      
      const query = `UPDATE Matches SET ${setClause.join(', ')} WHERE id = ?`;
      await c.env.DB.prepare(query).bind(...values).run();
      
      // If match is completed, update league standings
      if (updates.status === 'COMPLETED' && updates.winner_participant_id) {
        const match = await c.env.DB.prepare(
          'SELECT tournament_id, player_a_participant_id, player_b_participant_id FROM Matches WHERE id = ?'
        ).bind(matchId).first();
        
        if (match) {
          // Update standings for both players
          const updateStandings = async (participantId: number, isWinner: boolean, isDraw: boolean) => {
            const updateQuery = isDraw 
              ? 'INSERT OR REPLACE INTO LeagueStandings (participant_id, points, matches_played, draws) VALUES (?, COALESCE((SELECT points FROM LeagueStandings WHERE participant_id = ?), 0) + 1, COALESCE((SELECT matches_played FROM LeagueStandings WHERE participant_id = ?), 0) + 1, COALESCE((SELECT draws FROM LeagueStandings WHERE participant_id = ?), 0) + 1)'
              : isWinner
                ? 'INSERT OR REPLACE INTO LeagueStandings (participant_id, points, matches_played, wins) VALUES (?, COALESCE((SELECT points FROM LeagueStandings WHERE participant_id = ?), 0) + 3, COALESCE((SELECT matches_played FROM LeagueStandings WHERE participant_id = ?), 0) + 1, COALESCE((SELECT wins FROM LeagueStandings WHERE participant_id = ?), 0) + 1)'
                : 'INSERT OR REPLACE INTO LeagueStandings (participant_id, points, matches_played, losses) VALUES (?, COALESCE((SELECT points FROM LeagueStandings WHERE participant_id = ?), 0), COALESCE((SELECT matches_played FROM LeagueStandings WHERE participant_id = ?), 0) + 1, COALESCE((SELECT losses FROM LeagueStandings WHERE participant_id = ?), 0) + 1)';
            
            await c.env.DB.prepare(updateQuery).bind(participantId, participantId, participantId, participantId).run();
          };
          
          const isDraw = updates.player_a_score === updates.player_b_score;
          await updateStandings(match.player_a_participant_id, !isDraw && updates.winner_participant_id === match.player_a_participant_id, isDraw);
          await updateStandings(match.player_b_participant_id, !isDraw && updates.winner_participant_id === match.player_b_participant_id, isDraw);
        }
      }
      
      return c.json({ message: 'Match updated successfully' });
    } catch (e: any) {
      return c.json({ error: 'Failed to update match', details: e.message }, 500);
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
    const db = c.env.DB;
    
    try {
      // Complete cascade delete based on actual database schema
      // Delete in dependency order (children first, parents last)
      
      // 1. Delete user votes for matches in this tournament
      await db.prepare(`
        DELETE FROM UserVotes 
        WHERE vote_event_id IN (
          SELECT ve.id FROM VoteEvents ve 
          JOIN Matches m ON ve.match_id = m.id 
          WHERE m.tournament_id = ?
        )
      `).bind(tournamentId).run();
      
      // 2. Delete predictions for matches in this tournament
      await db.prepare(`
        DELETE FROM Predictions 
        WHERE match_id IN (
          SELECT id FROM Matches WHERE tournament_id = ?
        )
      `).bind(tournamentId).run();
      
      // 3. Delete vote events for matches in this tournament
      await db.prepare(`
        DELETE FROM VoteEvents 
        WHERE match_id IN (
          SELECT id FROM Matches WHERE tournament_id = ?
        )
      `).bind(tournamentId).run();
      
      // 4. Delete league standings for participants in this tournament
      await db.prepare(`
        DELETE FROM LeagueStandings 
        WHERE participant_id IN (
          SELECT id FROM TournamentParticipants WHERE tournament_id = ?
        )
      `).bind(tournamentId).run();
      
      // 5. Delete matches for this tournament
      await db.prepare('DELETE FROM Matches WHERE tournament_id = ?').bind(tournamentId).run();
      
      // 6. Delete tournament participants
      await db.prepare('DELETE FROM TournamentParticipants WHERE tournament_id = ?').bind(tournamentId).run();
      
      // 7. Delete tournament registrations
      await db.prepare('DELETE FROM TournamentRegistrations WHERE tournament_id = ?').bind(tournamentId).run();
      
      // 8. Finally delete the tournament itself
      await db.prepare('DELETE FROM Tournaments WHERE id = ?').bind(tournamentId).run();
      
      return c.json({ message: 'Tournament and all related data deleted successfully' }, 200);
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

// Generate knockout bracket from league standings
admin.post(
  '/tournaments/:id/generate-knockout',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');
    const db = c.env.DB;

    try {
      // Get final league standings (sorted by points, GD, etc.)
      const standings = await db.prepare(`
        SELECT 
          tp.id as participant_id, 
          u.twitch_username,
          COALESCE(ls.points, 0) as points,
          COALESCE(ls.matches_played, 0) as matches_played,
          COALESCE(ls.wins, 0) as wins,
          COALESCE(ls.draws, 0) as draws,
          COALESCE(ls.losses, 0) as losses,
          (COALESCE(ls.wins, 0) * 3 + COALESCE(ls.draws, 0)) as calculated_points,
          COALESCE((
            SELECT SUM(CASE 
              WHEN m.player_a_participant_id = tp.id THEN COALESCE(m.player_a_score, 0)
              WHEN m.player_b_participant_id = tp.id THEN COALESCE(m.player_b_score, 0)
              ELSE 0 END) -
            SUM(CASE 
              WHEN m.player_a_participant_id = tp.id THEN COALESCE(m.player_b_score, 0)
              WHEN m.player_b_participant_id = tp.id THEN COALESCE(m.player_a_score, 0)
              ELSE 0 END)
            FROM Matches m 
            WHERE (m.player_a_participant_id = tp.id OR m.player_b_participant_id = tp.id) 
            AND m.status = 'COMPLETED'
          ), 0) as goal_difference
        FROM TournamentParticipants tp
        JOIN Users u ON tp.user_id = u.id
        LEFT JOIN LeagueStandings ls ON ls.participant_id = tp.id
        WHERE tp.tournament_id = ?
        ORDER BY calculated_points DESC, goal_difference DESC, u.twitch_username ASC
      `).bind(tournamentId).all();

      const participants = standings.results || [];
      
      if (participants.length < 16) {
        return c.json({ error: 'Need at least 16 participants to generate knockout bracket' }, 400);
      }

      // Champions League knockout qualification:
      // Positions 1-8: Direct to Round of 16
      // Positions 9-24: Playoff round (9th vs 24th, 10th vs 23rd, etc.)
      // Positions 25-36: Eliminated
      
      const directQualifiers = participants.slice(0, 8);      // 1st-8th
      const playoffTeams = participants.slice(8, 24);        // 9th-24th
      const eliminated = participants.slice(24);             // 25th-36th

      // Update participant statuses
      for (const participant of directQualifiers) {
        await db.prepare(
          'UPDATE TournamentParticipants SET status = ? WHERE id = ?'
        ).bind('QUALIFIED_DIRECT', participant.participant_id).run();
      }
      
      for (const participant of playoffTeams) {
        await db.prepare(
          'UPDATE TournamentParticipants SET status = ? WHERE id = ?'
        ).bind('QUALIFIED_PLAYOFF', participant.participant_id).run();
      }
      
      for (const participant of eliminated) {
        await db.prepare(
          'UPDATE TournamentParticipants SET status = ? WHERE id = ?'
        ).bind('ELIMINATED', participant.participant_id).run();
      }

      // Generate playoff matches (9th vs 24th, 10th vs 23rd, etc.)
      const playoffMatches = [];
      for (let i = 0; i < playoffTeams.length / 2; i++) {
        const higherSeed = playoffTeams[i];
        const lowerSeed = playoffTeams[playoffTeams.length - 1 - i];
        
        const matchResult = await db.prepare(`
          INSERT INTO Matches (tournament_id, phase, status, player_a_participant_id, player_b_participant_id, scheduled_at)
          VALUES (?, 'PLAYOFF', 'SCHEDULED', ?, ?, datetime('now', '+1 day'))
        `).bind(
          tournamentId,
          higherSeed.participant_id,
          lowerSeed.participant_id
        ).run();
        
        playoffMatches.push({
          id: matchResult.meta.last_row_id,
          player_a: higherSeed.twitch_username,
          player_b: lowerSeed.twitch_username,
          seeding: `${i + 9} vs ${24 - i}`
        });
      }

      // Generate Round of 16 placeholder matches
      const roundOf16Matches = [];
      
      // First 4 matches: Direct qualifiers (1 vs 8, 2 vs 7, 3 vs 6, 4 vs 5)
      const r16Pairings = [
        [0, 7], [1, 6], [2, 5], [3, 4] // Indexes in directQualifiers array
      ];
      
      for (const [aIndex, bIndex] of r16Pairings) {
        const matchResult = await db.prepare(`
          INSERT INTO Matches (tournament_id, phase, status, player_a_participant_id, player_b_participant_id, scheduled_at)
          VALUES (?, 'ROUND_OF_16', 'SCHEDULED', ?, ?, datetime('now', '+3 days'))
        `).bind(
          tournamentId,
          directQualifiers[aIndex].participant_id,
          directQualifiers[bIndex].participant_id
        ).run();
        
        roundOf16Matches.push({
          id: matchResult.meta.last_row_id,
          player_a: directQualifiers[aIndex].twitch_username,
          player_b: directQualifiers[bIndex].twitch_username,
          seeding: `${aIndex + 1} vs ${bIndex + 1}`
        });
      }

      // Remaining 4 matches: Playoff winners (TBD)
      for (let i = 0; i < 4; i++) {
        const matchResult = await db.prepare(`
          INSERT INTO Matches (tournament_id, phase, status, player_a_participant_id, player_b_participant_id, scheduled_at)
          VALUES (?, 'ROUND_OF_16', 'SCHEDULED', NULL, NULL, datetime('now', '+5 days'))
        `).bind(tournamentId).run();
        
        roundOf16Matches.push({
          id: matchResult.meta.last_row_id,
          player_a: 'Playoff Winner TBD',
          player_b: 'Playoff Winner TBD',
          seeding: 'Playoff Winners'
        });
      }

      return c.json({
        message: 'Knockout bracket generated successfully',
        qualification_summary: {
          direct_qualifiers: directQualifiers.length,
          playoff_teams: playoffTeams.length,
          eliminated: eliminated.length
        },
        playoff_matches: playoffMatches,
        round_of_16_matches: roundOf16Matches
      });

    } catch (error: any) {
      return c.json({ error: 'Failed to generate knockout bracket', details: error.message }, 500);
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
      twitch_profile_image_url: z.string().optional().refine(
        (val) => !val || val === '' || z.string().url().safeParse(val).success,
        { message: "Must be a valid URL or empty string" }
      ),
      points_balance: z.number().int().min(0).default(0),
      is_banned: z.number().int().min(0).max(1).default(0),
    })
  ),
  async (c) => {
    const { twitch_id, twitch_username, twitch_profile_image_url, points_balance, is_banned } = c.req.valid('json');
    
    console.log('Creating user with data:', { twitch_id, twitch_username, twitch_profile_image_url, points_balance, is_banned });
    
    try {
      // Handle empty string for profile image URL
      const profileImageUrl = twitch_profile_image_url && twitch_profile_image_url.trim() !== '' ? twitch_profile_image_url : null;
      
      console.log('Processed profile image URL:', profileImageUrl);
      
      const { meta } = await c.env.DB.prepare(
        'INSERT INTO Users (twitch_id, twitch_username, twitch_profile_image_url, points_balance, is_banned) VALUES (?, ?, ?, ?, ?)'
      )
        .bind(twitch_id, twitch_username, profileImageUrl, points_balance, is_banned)
        .run();
      
      const newUser = { id: meta.last_row_id, twitch_id, twitch_username, twitch_profile_image_url: profileImageUrl, points_balance, is_banned };
      
      console.log('User created successfully:', newUser);
      return c.json({ message: 'User created successfully', user: newUser }, 201);
    } catch (e: any) {
      console.error('Failed to create user:', e);
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
