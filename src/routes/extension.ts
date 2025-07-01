// src/routes/extension.ts
// Extension-specific endpoints that handle Twitch Extension authentication
import { Hono } from 'hono';
import { Bindings } from '..';

const extension = new Hono<{ Bindings: Bindings }>();

// Middleware to validate Twitch Extension JWT
const validateExtensionAuth = async (c: any, next: any) => {
    try {
        const authHeader = c.req.header('Authorization');
        const extensionUserId = c.req.header('X-Extension-User-ID');
        const extensionChannelId = c.req.header('X-Extension-Channel-ID');

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return c.json({ error: 'Missing or invalid authorization header' }, 401);
        }

        if (!extensionUserId) {
            return c.json({ error: 'Extension user ID is required' }, 401);
        }

        // For now, we'll accept the Twitch extension token as-is
        // In production, you should verify the JWT signature with your extension secret
        const token = authHeader.substring(7);
        
        // Store extension context for use in handlers
        c.set('extensionUserId', extensionUserId);
        c.set('extensionChannelId', extensionChannelId);
        c.set('extensionToken', token);

        await next();
    } catch (error) {
        console.error('Extension auth validation error:', error);
        return c.json({ error: 'Authentication failed' }, 401);
    }
};

// Get or create extension user based on Twitch User ID
const getOrCreateExtensionUser = async (c: any, twitchUserId: string) => {
    try {
        // Check if user exists
        let user = await c.env.DB.prepare('SELECT * FROM Users WHERE twitch_id = ?')
            .bind(twitchUserId)
            .first();

        if (!user) {
            // Create new user with default starting points
            const { results } = await c.env.DB.prepare(
                'INSERT INTO Users (twitch_id, twitch_username, points_balance) VALUES (?, ?, ?) RETURNING *'
            )
            .bind(twitchUserId, `User_${twitchUserId}`, 1000) // Start with 1000 points
            .run();
            user = results[0];
        }

        return user;
    } catch (error) {
        console.error('Error getting/creating extension user:', error);
        throw error;
    }
};

// Get user balance
extension.get('/user/balance', validateExtensionAuth, async (c) => {
    try {
        const twitchUserId = c.get('extensionUserId');
        const user = await getOrCreateExtensionUser(c, twitchUserId);

        return c.json({
            balance: user.points_balance || 0,
            twitch_id: user.twitch_id
        });
    } catch (error) {
        console.error('Error getting user balance:', error);
        return c.json({ error: 'Failed to get user balance' }, 500);
    }
});

// Get user's existing bet for a match
extension.get('/matches/:matchId/bet', validateExtensionAuth, async (c) => {
    try {
        const matchId = c.req.param('matchId');
        const twitchUserId = c.get('extensionUserId');
        const user = await getOrCreateExtensionUser(c, twitchUserId);

        const bet = await c.env.DB.prepare(
            'SELECT * FROM Predictions WHERE user_id = ? AND match_id = ?'
        )
        .bind(user.id, matchId)
        .first();

        if (bet) {
            return c.json({ bet });
        } else {
            return c.json({ bet: null });
        }
    } catch (error) {
        console.error('Error getting existing bet:', error);
        return c.json({ error: 'Failed to get bet' }, 500);
    }
});

// Place a bet
extension.post('/bets', validateExtensionAuth, async (c) => {
    try {
        const twitchUserId = c.get('extensionUserId');
        const user = await getOrCreateExtensionUser(c, twitchUserId);
        
        const { match_id, predicted_winner_participant_id, points_wagered } = await c.req.json();

        // Validate input
        if (!match_id || !predicted_winner_participant_id || !points_wagered) {
            return c.json({ error: 'Missing required fields' }, 400);
        }

        if (points_wagered <= 0) {
            return c.json({ error: 'Points wagered must be positive' }, 400);
        }

        // Check if user has enough points
        if (user.points_balance < points_wagered) {
            return c.json({ error: 'Insufficient points' }, 400);
        }

        // Check if match exists and is live
        const match = await c.env.DB.prepare('SELECT * FROM Matches WHERE id = ?')
            .bind(match_id)
            .first();

        if (!match) {
            return c.json({ error: 'Match not found' }, 404);
        }

        if (match.status !== 'LIVE') {
            return c.json({ error: 'Betting is only available for live matches' }, 400);
        }

        // Check if user already has a bet for this match
        const existingBet = await c.env.DB.prepare(
            'SELECT * FROM Predictions WHERE user_id = ? AND match_id = ?'
        )
        .bind(user.id, match_id)
        .first();

        if (existingBet) {
            return c.json({ error: 'You already have a bet for this match' }, 400);
        }

        // Validate participant ID belongs to this match
        if (predicted_winner_participant_id !== match.player_a_participant_id && 
            predicted_winner_participant_id !== match.player_b_participant_id) {
            return c.json({ error: 'Invalid participant selection' }, 400);
        }

        // Start transaction
        await c.env.DB.prepare('BEGIN TRANSACTION').run();

        try {
            // Deduct points from user
            await c.env.DB.prepare(
                'UPDATE Users SET points_balance = points_balance - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
            )
            .bind(points_wagered, user.id)
            .run();

            // Create the bet
            const { results } = await c.env.DB.prepare(
                'INSERT INTO Predictions (user_id, match_id, predicted_winner_participant_id, points_wagered) VALUES (?, ?, ?, ?) RETURNING *'
            )
            .bind(user.id, match_id, predicted_winner_participant_id, points_wagered)
            .run();

            const bet = results[0];

            // Create transaction record
            await c.env.DB.prepare(
                'INSERT INTO Transactions (user_id, type, amount, description, related_entity_id) VALUES (?, ?, ?, ?, ?)'
            )
            .bind(user.id, 'EXTENSION_BET_PLACED', -points_wagered, `Bet placed on match ${match_id}`, match_id)
            .run();

            // Commit transaction
            await c.env.DB.prepare('COMMIT').run();

            return c.json({ 
                success: true, 
                bet,
                message: 'Bet placed successfully!'
            });

        } catch (error) {
            // Rollback on error
            await c.env.DB.prepare('ROLLBACK').run();
            throw error;
        }

    } catch (error) {
        console.error('Error placing bet:', error);
        return c.json({ error: 'Failed to place bet' }, 500);
    }
});

// Get current live matches (for extension to discover what to show)
extension.get('/live-matches', async (c) => {
    try {
        // Get all live matches with participant details
        const matches = await c.env.DB.prepare(`
            SELECT 
                m.*,
                t.name as tournament_name,
                pa.user_id as player_a_user_id,
                pb.user_id as player_b_user_id,
                ua.twitch_username as player_a_name,
                ub.twitch_username as player_b_name
            FROM Matches m
            JOIN Tournaments t ON m.tournament_id = t.id
            JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
            JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id
            JOIN Users ua ON pa.user_id = ua.id
            JOIN Users ub ON pb.user_id = ub.id
            WHERE m.status = 'LIVE'
            ORDER BY m.scheduled_at DESC
            LIMIT 1
        `).all();

        return c.json({ 
            matches: matches.results || [],
            count: matches.results?.length || 0
        });
    } catch (error) {
        console.error('Error getting live matches:', error);
        return c.json({ error: 'Failed to get live matches' }, 500);
    }
});

export default extension;