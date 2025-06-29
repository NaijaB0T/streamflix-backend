Project Document: Twitch Champions League API Architecture - STREAMFLIX
1. Executive Overview
This document outlines the complete backend architecture for a sophisticated, real-time Twitch tournament management platform. The system is designed to run entirely on the Cloudflare serverless ecosystem, providing a highly scalable, low-latency, and secure API to manage a complex FIFA tournament for a streamer's subscriber community.
The platform supports a 36-player tournament format inspired by the UEFA Champions League's new Swiss model. It manages the entire lifecycle of the tournament, from user registration and subscriber verification to a multi-stage competition including a league phase, knockout play-offs, and a final.
A key feature is the admin curation process. While any subscriber can register their interest in a tournament, the administrator has the final authority to select the 36 participants from the pool of registered users. This ensures a well-managed and potentially balanced final roster.
The system is built for deep user engagement. During live matches, administrators can trigger interactive voting events where viewers spend in-app points to award their favorite player with valuable league points. Furthermore, the architecture provides real-time updates of a user's points balance directly to their client application, ensuring a seamless and responsive user experience whenever points are earned or spent.
2. Core Technology Stack
Compute: Cloudflare Workers provide the serverless execution environment, running the API at the edge for global low-latency.
Web Framework: Hono is used for its lightweight, high-performance routing and middleware, designed specifically for edge environments.
Database: Cloudflare D1, a serverless SQL database, provides persistent storage for all application data.
Real-time & State Management: Cloudflare Durable Objects are used for two distinct purposes:
MatchStateDO: For managing stateful, real-time match-specific events (like votes) and broadcasting them to all viewers of that match.
UserSessionDO: For managing persistent, per-user WebSocket connections to push private, real-time data updates (like points balance) to an individual client.
Language: TypeScript is used for its static typing, enhancing code quality, maintainability, and developer experience.
3. API Architecture
3.1. System & Tournament Flow
The API orchestrates the tournament lifecycle with the following key flows:
Tournament Setup: An administrator creates a new tournament, which starts in a DRAFT status.
Registration Phase: The admin opens registration. Users can now call the /api/tournaments/:id/register endpoint.
User Registration (Expression of Interest):
Any subscribed user can register. The API verifies their subscriber status (via a Twitch API call) and that they haven't registered for too many other tournaments.
A successful registration creates a record in the TournamentRegistrations table with a PENDING status.
Admin Selection Phase:
The admin closes registration and uses GET /api/admin/tournaments/:id/registrations to view all pending registrations.
Using POST /api/admin/tournaments/:id/confirm-participants, the admin submits a list of 36 userIds to be confirmed.
Confirmation & Roster Finalization:
The API receives the list of 36 selected players. For each selected player, it updates their status in TournamentRegistrations to CONFIRMED and creates corresponding records in TournamentParticipants and LeagueStandings.
All other pending registrants are automatically marked as NOT_SELECTED. The roster is now locked.
User Session Connection: When a user logs into a client application, the client establishes a persistent WebSocket connection to /api/user/connect. This connection is handled by a dedicated UserSessionDO for that user.
Earning Points (Credit Flow):
A user redeems a Channel Point reward on Twitch.
A webhook is sent to the API's /api/webhooks/twitch endpoint.
The API validates the webhook, updates the user's balance in the database, and creates a transaction log.
Live Update: The API then signals the user's UserSessionDO to push the new, updated points balance to their connected client.
Spending Points (Debit Flow):
A user casts a vote or makes a prediction via an API endpoint.
The API authenticates the user, checks their balance, and performs an atomic database transaction to deduct points and record the action.
Live Update: The API then signals the user's UserSessionDO to push their new, lower points balance to their client.
League Draw, Match Execution & Knockouts: The tournament proceeds through its phases, with admins managing draws and resolving matches. The real-time voting events are managed by the MatchStateDO.
3.2. Modular Structure
index.ts (Entry Point): Initializes Hono, applies global middleware (csrf), and delegates requests.
auth.ts: Handles the Twitch OAuth 2.0 flow, requesting the channel:read:subscriptions scope.
tournaments.ts (User-Facing): Endpoints for users, e.g., POST /:id/register, GET /:id/my-registration-status.
users.ts: Contains the WebSocket endpoint GET /api/user/connect for individual user sessions.
admin.ts (Control Panel): Endpoints for admins, e.g., GET /:id/registrations, POST /:id/confirm-participants, POST /:id/run-league-draw, POST /:matchId/resolve-match, POST /:matchId/start-vote.
webhooks.ts: Manages incoming Twitch EventSub webhooks (e.g., for Channel Point redemptions). Must perform signature verification.
internal.ts: A private router for inter-service communication, primarily the /resolve-vote endpoint called by MatchStateDO.
middleware/: Shared middleware functions: userAuth (verifies JWT from cookie) and adminAuth (verifies a secret header key).
3.3. Real-Time Subsystem (Durable Objects)
The architecture uses two distinct types of Durable Objects to cleanly separate concerns.
3.3.1. MatchStateDO (Broadcasts / Many-to-Many Communication)
Purpose: To manage events related to a single match and broadcast them to all connected viewers.
Scope: Instantiated per-match (e.g., by matchId).
Function: Handles WebSocket connections for match viewers, manages voting event timers using Alarms, and broadcasts public state changes like VOTE_STARTED, VOTE_ENDED, and SCORE_UPDATE.
3.3.2. UserSessionDO (Unicast / One-to-One Communication)
Purpose: To manage the WebSocket connection for a single authenticated user and push them private, real-time updates.
Scope: Instantiated per-user (e.g., by userId).
Function:
Holds a single, persistent WebSocket connection for one user.
Its fetch() handler is designed to receive internal, authenticated commands from the main stateless Worker (e.g., a POST request to a path like /update-balance).
Upon receiving such a command, it sends a message (e.g., { "type": "POINTS_UPDATE", "balance": 1250 }) over its WebSocket directly to that user's client.
3.4. Security
Authentication: User sessions via JWTs in secure, httpOnly cookies. Admin access via a separate secret key.
CSRF Protection: Global middleware protects against cross-site request forgery.
Webhook Security: The webhook endpoint validates the signature of every request to ensure authenticity.
Input Validation: Zod validates all incoming request bodies and parameters.
4. Database Architecture
The database is designed using Cloudflare D1 (SQLite) to be relational, normalized, and indexed for performance.
4.1. Conceptual Schema Diagram
Generated code
Tournaments --< TournamentRegistrations >-- Users
    |
    '--< TournamentParticipants >-- Users (via Registration)
           |
           '--< LeagueStandings (1-to-1)
           |
           '--< Matches >-- TournamentParticipants (Player A & Player B)
                   |
                   '--< VoteEvents >-- UserVotes >-- Users
                   |
                   '--< Predictions >-- Users

Users --< Transactions
Use code with caution.
4.2. Detailed Table Definitions
1. Users
Stores information about each unique user.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| twitch_id | TEXT | NOT NULL, UNIQUE |
| twitch_username | TEXT | NOT NULL |
| points_balance | INTEGER | NOT NULL, DEFAULT 0 |
| is_banned | INTEGER | NOT NULL, DEFAULT 0 - (0=false, 1=true) |
| created_at | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
| updated_at | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
2. Tournaments
Stores high-level information about each tournament.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| name | TEXT | NOT NULL |
| status | TEXT | NOT NULL, DEFAULT 'DRAFT' - Enum: DRAFT, REGISTRATION_OPEN, REGISTRATION_CLOSED, AWAITING_SELECTION, LEAGUE_PHASE, KNOCKOUTS, COMPLETED. |
| max_participants | INTEGER | NOT NULL, DEFAULT 36 |
| created_at | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
3. TournamentRegistrations
Acts as the waiting room for all users who have expressed interest in a tournament.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| user_id | INTEGER | NOT NULL, FOREIGN KEY(user_id) REFERENCES Users(id) |
| tournament_id | INTEGER | NOT NULL, FOREIGN KEY(tournament_id) REFERENCES Tournaments(id) |
| status | TEXT | NOT NULL, DEFAULT 'PENDING' - Enum: PENDING, CONFIRMED, NOT_SELECTED. |
| registered_at| TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
Constraint: CONSTRAINT uq_user_tournament_registration UNIQUE (user_id, tournament_id)
4. TournamentParticipants
Represents the final, confirmed roster of 36 players.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| registration_id| INTEGER | NOT NULL, UNIQUE, FOREIGN KEY(registration_id) REFERENCES TournamentRegistrations(id) |
| user_id | INTEGER | NOT NULL, FOREIGN KEY(user_id) REFERENCES Users(id) |
| tournament_id | INTEGER | NOT NULL, FOREIGN KEY(tournament_id) REFERENCES Tournaments(id) |
| status | TEXT | NOT NULL, DEFAULT 'ACTIVE' - Enum: ACTIVE, ELIMINATED, WINNER. |
| confirmed_at | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
5. LeagueStandings
The live leaderboard for the league phase of a tournament.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| participant_id| INTEGER | NOT NULL, UNIQUE, FOREIGN KEY(participant_id) REFERENCES TournamentParticipants(id) |
| points | INTEGER | NOT NULL, DEFAULT 0 |
| matches_played| INTEGER | NOT NULL, DEFAULT 0 |
| wins | INTEGER | NOT NULL, DEFAULT 0 |
| draws | INTEGER | NOT NULL, DEFAULT 0 |
| losses | INTEGER | NOT NULL, DEFAULT 0 |
| updated_at| TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
6. Matches
Stores details for a single match between two participants.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| tournament_id | INTEGER | NOT NULL, FOREIGN KEY(tournament_id) REFERENCES Tournaments(id) |
| phase | TEXT | NOT NULL - Enum: LEAGUE, PLAYOFF_LEG_1, ..., FINAL. |
| status | TEXT | NOT NULL, DEFAULT 'SCHEDULED' - Enum: SCHEDULED, LIVE, COMPLETED. |
| player_a_participant_id | INTEGER | NOT NULL, FOREIGN KEY(...) REFERENCES TournamentParticipants(id) |
| player_b_participant_id | INTEGER | NOT NULL, FOREIGN KEY(...) REFERENCES TournamentParticipants(id) |
| player_a_score| INTEGER| NULL |
| player_b_score| INTEGER| NULL |
| winner_participant_id| INTEGER| NULL, FOREIGN KEY(...) |
| scheduled_at | TEXT | NOT NULL |
7. Transactions
An append-only audit log for every change to a user's points balance.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| user_id | INTEGER | NOT NULL, FOREIGN KEY(user_id) REFERENCES Users(id) |
| type | TEXT | NOT NULL - Enum: TWITCH_REWARD_REDEMPTION, VOTE_SPEND, etc. |
| amount | INTEGER | NOT NULL - Positive for credits, negative for debits. |
| description | TEXT | NOT NULL |
| related_entity_id| INTEGER| NULL - e.g., VoteEvents.id. |
| created_at | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
8. VoteEvents
Represents a single, time-limited voting "pop-up" during a match.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| match_id | INTEGER | NOT NULL, FOREIGN KEY(match_id) REFERENCES Matches(id) |
| points_award | INTEGER | NOT NULL |
| cost_per_vote| INTEGER | NOT NULL |
| status | TEXT | NOT NULL, DEFAULT 'ACTIVE' - Enum: ACTIVE, COMPLETED. |
| end_time | TEXT | NOT NULL |
| created_at | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
9. UserVotes
Logs each individual vote cast by a user during a VoteEvent.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| user_id | INTEGER | NOT NULL, FOREIGN KEY(user_id) REFERENCES Users(id) |
| vote_event_id | INTEGER | NOT NULL, FOREIGN KEY(vote_event_id) REFERENCES VoteEvents(id) |
| voted_for_participant_id| INTEGER| NOT NULL, FOREIGN KEY(...) |
| created_at | TEXT | NOT NULL, DEFAULT CURRENT_TIMESTAMP |
10. Predictions
Logs a user's wager on a match outcome.
| Column Name | Data Type | Constraints & Notes |
| :--- | :--- | :--- |
| id | INTEGER | PRIMARY KEY AUTOINCREMENT |
| user_id | INTEGER | NOT NULL, FOREIGN KEY(...) |
| match_id | INTEGER | NOT NULL, FOREIGN KEY(...) |
| predicted_winner_participant_id| INTEGER | NOT NULL, FOREIGN KEY(...) |
| points_wagered| INTEGER | NOT NULL |
Constraint: CONSTRAINT uq_user_match_prediction UNIQUE (user_id, match_id)