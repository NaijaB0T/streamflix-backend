// src/routes/notifications.ts
import { Hono } from 'hono';
import { Bindings } from '..';
import { userAuth } from '../middleware/userAuth';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';

const notifications = new Hono<{ Bindings: Bindings }>();

// In-memory notifications store (for demonstration)
// In production, this would be a database table
const userNotifications = new Map<number, any[]>();

// Get user notifications
notifications.get(
  '/',
  userAuth,
  async (c) => {
    const { sub: userId } = c.get('jwtPayload');
    
    try {
      // Get recent match alerts for user's tournaments
      const userTournaments = await c.env.DB.prepare(`
        SELECT DISTINCT tr.tournament_id, t.name as tournament_name
        FROM TournamentRegistrations tr
        JOIN Tournaments t ON tr.tournament_id = t.id
        WHERE tr.user_id = ? AND tr.status = 'CONFIRMED'
      `).bind(userId).all();
      
      const notifications = [];
      
      for (const tournament of (userTournaments.results || [])) {
        // Get live matches in this tournament
        const liveMatches = await c.env.DB.prepare(`
          SELECT 
            m.id, m.status, m.scheduled_at,
            ua.twitch_username as player_a_username,
            ub.twitch_username as player_b_username
          FROM Matches m
          LEFT JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
          LEFT JOIN Users ua ON pa.user_id = ua.id
          LEFT JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id  
          LEFT JOIN Users ub ON pb.user_id = ub.id
          WHERE m.tournament_id = ? AND m.status = 'LIVE'
        `).bind(tournament.tournament_id).all();
        
        // Get upcoming matches (within next 24 hours)
        const upcomingMatches = await c.env.DB.prepare(`
          SELECT 
            m.id, m.status, m.scheduled_at,
            ua.twitch_username as player_a_username,
            ub.twitch_username as player_b_username
          FROM Matches m
          LEFT JOIN TournamentParticipants pa ON m.player_a_participant_id = pa.id
          LEFT JOIN Users ua ON pa.user_id = ua.id
          LEFT JOIN TournamentParticipants pb ON m.player_b_participant_id = pb.id  
          LEFT JOIN Users ub ON pb.user_id = ub.id
          WHERE m.tournament_id = ? AND m.status = 'SCHEDULED'
          AND datetime(m.scheduled_at) BETWEEN datetime('now') AND datetime('now', '+1 day')
        `).bind(tournament.tournament_id).all();
        
        // Add live match notifications
        for (const match of (liveMatches.results || [])) {
          notifications.push({
            id: `live-${match.id}`,
            type: 'MATCH_LIVE',
            title: '🔴 Match Live Now!',
            message: `${match.player_a_username} vs ${match.player_b_username} in ${tournament.tournament_name}`,
            tournament_id: tournament.tournament_id,
            tournament_name: tournament.tournament_name,
            match_id: match.id,
            created_at: new Date().toISOString(),
            priority: 'high'
          });
        }
        
        // Add upcoming match notifications
        for (const match of (upcomingMatches.results || [])) {
          const timeUntil = new Date(match.scheduled_at).getTime() - new Date().getTime();
          const hoursUntil = Math.round(timeUntil / (1000 * 60 * 60));
          
          if (hoursUntil <= 24) {
            notifications.push({
              id: `upcoming-${match.id}`,
              type: 'MATCH_UPCOMING',
              title: '⏰ Match Starting Soon',
              message: `${match.player_a_username} vs ${match.player_b_username} starts in ${hoursUntil}h`,
              tournament_id: tournament.tournament_id,
              tournament_name: tournament.tournament_name,
              match_id: match.id,
              scheduled_at: match.scheduled_at,
              created_at: new Date().toISOString(),
              priority: hoursUntil <= 1 ? 'high' : 'medium'
            });
          }
        }
      }
      
      // Check for tournament status changes
      const recentTournaments = await c.env.DB.prepare(`
        SELECT t.id, t.name, t.status, t.created_at
        FROM Tournaments t
        JOIN TournamentRegistrations tr ON t.id = tr.tournament_id
        WHERE tr.user_id = ? AND tr.status = 'CONFIRMED'
        AND datetime(t.created_at) > datetime('now', '-1 day')
        ORDER BY t.created_at DESC
      `).bind(userId).all();
      
      for (const tournament of (recentTournaments.results || [])) {
        if (tournament.status === 'LEAGUE_PHASE') {
          notifications.push({
            id: `tournament-${tournament.id}`,
            type: 'TOURNAMENT_STATUS',
            title: '🏁 Tournament Started!',
            message: `${tournament.name} has entered the League Phase`,
            tournament_id: tournament.id,
            tournament_name: tournament.name,
            created_at: new Date().toISOString(),
            priority: 'medium'
          });
        } else if (tournament.status === 'KNOCKOUTS') {
          notifications.push({
            id: `knockout-${tournament.id}`,
            type: 'TOURNAMENT_STATUS',
            title: '🏆 Knockout Stage!',
            message: `${tournament.name} has reached the Knockout Stage`,
            tournament_id: tournament.id,
            tournament_name: tournament.name,
            created_at: new Date().toISOString(),
            priority: 'high'
          });
        }
      }
      
      // Sort by priority and time
      notifications.sort((a, b) => {
        const priorityOrder = { high: 3, medium: 2, low: 1 };
        if (priorityOrder[a.priority] !== priorityOrder[b.priority]) {
          return priorityOrder[b.priority] - priorityOrder[a.priority];
        }
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });
      
      return c.json({
        notifications: notifications.slice(0, 20), // Limit to 20 most recent
        unread_count: notifications.filter(n => n.priority === 'high').length
      });
    } catch (error: any) {
      return c.json({ error: 'Failed to fetch notifications', details: error.message }, 500);
    }
  }
);

// Mark notification as read (placeholder for future implementation)
notifications.post(
  '/:id/read',
  userAuth,
  zValidator(
    'param',
    z.object({
      id: z.string(),
    })
  ),
  async (c) => {
    const notificationId = c.req.param('id');
    const { sub: userId } = c.get('jwtPayload');
    
    // For now, just return success
    // In a full implementation, this would update a database record
    return c.json({ message: 'Notification marked as read' });
  }
);

export default notifications;