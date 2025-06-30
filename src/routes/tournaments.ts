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

// Get live/upcoming tournaments for homepage - MUST be before /:id route
tournaments.get('/live', async (c) => {
  try {
    const liveTournaments = await c.env.DB.prepare(
      `SELECT * FROM Tournaments 
       WHERE status IN ('LEAGUE_PHASE', 'KNOCKOUTS') 
       ORDER BY created_at DESC`
    ).all();

    return c.json(liveTournaments.results || []);
  } catch (error: any) {
    return c.json({ error: 'Failed to fetch live tournaments' }, 500);
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

// Get tournament matches (public endpoint) - includes player names
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
           ua.twitch_username as player_a_username,
           ub.twitch_username as player_b_username
         FROM Matches m
         LEFT JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
         LEFT JOIN Users ua ON pa.user_id = ua.id
         LEFT JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id  
         LEFT JOIN Users ub ON pb.user_id = ub.id
         WHERE m.tournament_id = ?
         ORDER BY m.scheduled_at`
      ).bind(tournamentId).all();

      // Format matches for frontend
      const formattedMatches = (matches.results || []).map(match => ({
        id: match.id,
        phase: match.phase,
        status: match.status,
        scheduled_at: match.scheduled_at,
        player_a_score: match.player_a_score,
        player_b_score: match.player_b_score,
        player_a: {
          twitch_username: match.player_a_username
        },
        player_b: {
          twitch_username: match.player_b_username
        }
      }));

      return c.json(formattedMatches);
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
      // Get all confirmed participants
      const confirmedParticipants = await c.env.DB.prepare(
        `SELECT tp.id as participant_id, u.id as user_id, u.twitch_username, u.twitch_profile_image_url
         FROM TournamentParticipants tp
         JOIN Users u ON tp.user_id = u.id 
         WHERE tp.tournament_id = ? AND tp.status = 'ACTIVE'
         ORDER BY u.twitch_username`
      ).bind(tournamentId).all();

      const participants = confirmedParticipants.results || [];
      
      // Initialize standings for each participant
      const standings = participants.map(participant => ({
        participant_id: participant.participant_id,
        user_id: participant.user_id,
        twitch_username: participant.twitch_username,
        twitch_profile_image_url: participant.twitch_profile_image_url,
        matches_played: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goals_for: 0,
        goals_against: 0,
        goal_difference: 0,
        points: 0
      }));

      // Get all completed matches for this tournament
      const completedMatches = await c.env.DB.prepare(
        `SELECT player_a_participant_id, player_b_participant_id, 
                player_a_score, player_b_score, winner_participant_id
         FROM Matches 
         WHERE tournament_id = ? AND status = 'COMPLETED' 
         AND player_a_score IS NOT NULL AND player_b_score IS NOT NULL`
      ).bind(tournamentId).all();

      // Calculate standings from match results
      for (const match of (completedMatches.results || [])) {
        const playerAIndex = standings.findIndex(s => s.participant_id === match.player_a_participant_id);
        const playerBIndex = standings.findIndex(s => s.participant_id === match.player_b_participant_id);
        
        if (playerAIndex !== -1 && playerBIndex !== -1) {
          const playerA = standings[playerAIndex];
          const playerB = standings[playerBIndex];
          
          // Update matches played
          playerA.matches_played++;
          playerB.matches_played++;
          
          // Update goals
          playerA.goals_for += match.player_a_score;
          playerA.goals_against += match.player_b_score;
          playerB.goals_for += match.player_b_score;
          playerB.goals_against += match.player_a_score;
          
          // Update results
          if (match.player_a_score > match.player_b_score) {
            // Player A wins
            playerA.wins++;
            playerA.points += 3;
            playerB.losses++;
          } else if (match.player_b_score > match.player_a_score) {
            // Player B wins
            playerB.wins++;
            playerB.points += 3;
            playerA.losses++;
          } else {
            // Draw
            playerA.draws++;
            playerA.points += 1;
            playerB.draws++;
            playerB.points += 1;
          }
          
          // Update goal difference
          playerA.goal_difference = playerA.goals_for - playerA.goals_against;
          playerB.goal_difference = playerB.goals_for - playerB.goals_against;
        }
      }

      // Sort standings by: 1) Points, 2) Goal difference, 3) Goals for, 4) Username
      standings.sort((a, b) => {
        if (b.points !== a.points) return b.points - a.points;
        if (b.goal_difference !== a.goal_difference) return b.goal_difference - a.goal_difference;
        if (b.goals_for !== a.goals_for) return b.goals_for - a.goals_for;
        return a.twitch_username.localeCompare(b.twitch_username);
      });

      // Add position numbers
      standings.forEach((standing, index) => {
        standing.position = index + 1;
      });

      return c.json(standings);
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

// Create or update user prediction for a match
tournaments.post(
  '/matches/:matchId/predict',
  userAuth,
  zValidator(
    'param',
    z.object({
      matchId: z.string().regex(/^\d+$/),
    })
  ),
  zValidator(
    'json',
    z.object({
      predicted_winner_participant_id: z.number(),
      points_wagered: z.number().min(1).max(1000)
    })
  ),
  async (c) => {
    const matchId = c.req.param('matchId');
    const { predicted_winner_participant_id, points_wagered } = c.req.valid('json');
    const { sub: userId } = c.get('jwtPayload');

    try {
      // Check if match is still open for predictions
      const match = await c.env.DB.prepare(
        'SELECT status, scheduled_at FROM Matches WHERE id = ?'
      ).bind(matchId).first();

      if (!match || match.status !== 'SCHEDULED') {
        return c.json({ error: 'Match is not available for predictions' }, 400);
      }

      // Check user has enough points
      const user = await c.env.DB.prepare(
        'SELECT points_balance FROM Users WHERE id = ?'
      ).bind(userId).first();

      if (!user || user.points_balance < points_wagered) {
        return c.json({ error: 'Insufficient points balance' }, 400);
      }

      // Create or update prediction
      await c.env.DB.prepare(`
        INSERT INTO Predictions (user_id, match_id, predicted_winner_participant_id, points_wagered)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(user_id, match_id) DO UPDATE SET
          predicted_winner_participant_id = ?,
          points_wagered = ?
      `).bind(
        userId, matchId, predicted_winner_participant_id, points_wagered,
        predicted_winner_participant_id, points_wagered
      ).run();

      return c.json({ message: 'Prediction saved successfully' });
    } catch (error: any) {
      return c.json({ error: 'Failed to save prediction', details: error.message }, 500);
    }
  }
);

// Get user's predictions for a tournament
tournaments.get(
  '/:id/my-predictions',
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

    try {
      const predictions = await c.env.DB.prepare(`
        SELECT 
          p.match_id, p.predicted_winner_participant_id, p.points_wagered,
          m.status as match_status, m.scheduled_at, m.winner_participant_id,
          ua.twitch_username as player_a_username,
          ub.twitch_username as player_b_username,
          pw.twitch_username as predicted_winner_username
        FROM Predictions p
        JOIN Matches m ON p.match_id = m.id
        LEFT JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
        LEFT JOIN Users ua ON pa.user_id = ua.id
        LEFT JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id  
        LEFT JOIN Users ub ON pb.user_id = ub.id
        LEFT JOIN TournamentParticipants ppw ON p.predicted_winner_participant_id = ppw.id
        LEFT JOIN Users pw ON ppw.user_id = pw.id
        WHERE p.user_id = ? AND m.tournament_id = ?
        ORDER BY m.scheduled_at ASC
      `).bind(userId, tournamentId).all();

      return c.json(predictions.results || []);
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch predictions', details: error.message }, 500);
    }
  }
);

// Get knockout bracket for a tournament (public endpoint)
tournaments.get(
  '/:id/knockout',
  zValidator(
    'param',
    z.object({
      id: z.string().regex(/^\d+$/),
    })
  ),
  async (c) => {
    const tournamentId = c.req.param('id');

    try {
      // Get playoff matches
      const playoffMatches = await c.env.DB.prepare(
        `SELECT 
           m.id, m.phase, m.status, m.scheduled_at, m.player_a_score, m.player_b_score,
           m.winner_participant_id,
           ua.twitch_username as player_a_username,
           ub.twitch_username as player_b_username
         FROM Matches m
         LEFT JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
         LEFT JOIN Users ua ON pa.user_id = ua.id
         LEFT JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id  
         LEFT JOIN Users ub ON pb.user_id = ub.id
         WHERE m.tournament_id = ? AND m.phase = 'PLAYOFF'
         ORDER BY m.scheduled_at`
      ).bind(tournamentId).all();

      // Get Round of 16 matches
      const roundOf16Matches = await c.env.DB.prepare(
        `SELECT 
           m.id, m.phase, m.status, m.scheduled_at, m.player_a_score, m.player_b_score,
           m.winner_participant_id,
           ua.twitch_username as player_a_username,
           ub.twitch_username as player_b_username
         FROM Matches m
         LEFT JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
         LEFT JOIN Users ua ON pa.user_id = ua.id
         LEFT JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id  
         LEFT JOIN Users ub ON pb.user_id = ub.id
         WHERE m.tournament_id = ? AND m.phase = 'ROUND_OF_16'
         ORDER BY m.scheduled_at`
      ).bind(tournamentId).all();

      // Get qualification status from participants
      const qualificationStatus = await c.env.DB.prepare(
        `SELECT 
           tp.status,
           COUNT(*) as count
         FROM TournamentParticipants tp
         WHERE tp.tournament_id = ?
         GROUP BY tp.status`
      ).bind(tournamentId).all();

      return c.json({
        playoff_matches: playoffMatches.results || [],
        round_of_16_matches: roundOf16Matches.results || [],
        qualification_status: (qualificationStatus.results || []).reduce((acc, item) => {
          acc[item.status] = item.count;
          return acc;
        }, {})
      });
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch knockout bracket' }, 500);
    }
  }
);

export default tournaments;
