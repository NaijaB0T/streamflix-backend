-- Initial Schema for StreamFlix

-- Drop tables if they exist to ensure a clean slate
DROP TABLE IF EXISTS UserVotes;
DROP TABLE IF EXISTS Predictions;
DROP TABLE IF EXISTS VoteEvents;
DROP TABLE IF EXISTS Transactions;
DROP TABLE IF EXISTS LeagueStandings;
DROP TABLE IF EXISTS Matches;
DROP TABLE IF EXISTS TournamentParticipants;
DROP TABLE IF EXISTS TournamentRegistrations;
DROP TABLE IF EXISTS Tournaments;
DROP TABLE IF EXISTS Users;

-- Table: Users
CREATE TABLE Users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    twitch_id TEXT NOT NULL UNIQUE,
    twitch_username TEXT NOT NULL,
    points_balance INTEGER NOT NULL DEFAULT 0,
    is_banned INTEGER NOT NULL DEFAULT 0, -- 0=false, 1=true
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    twitch_profile_image_url TEXT
);

-- Table: Tournaments
CREATE TABLE Tournaments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT', -- DRAFT, REGISTRATION_OPEN, REGISTRATION_CLOSED, AWAITING_SELECTION, LEAGUE_PHASE, KNOCKOUTS, COMPLETED
    max_participants INTEGER NOT NULL DEFAULT 36,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Table: TournamentRegistrations
CREATE TABLE TournamentRegistrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    tournament_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING, CONFIRMED, NOT_SELECTED
    registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES Users(id),
    FOREIGN KEY(tournament_id) REFERENCES Tournaments(id),
    CONSTRAINT uq_user_tournament_registration UNIQUE (user_id, tournament_id)
);

-- Table: TournamentParticipants
CREATE TABLE TournamentParticipants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    registration_id INTEGER NOT NULL UNIQUE,
    user_id INTEGER NOT NULL,
    tournament_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, ELIMINATED, WINNER
    confirmed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(registration_id) REFERENCES TournamentRegistrations(id),
    FOREIGN KEY(user_id) REFERENCES Users(id),
    FOREIGN KEY(tournament_id) REFERENCES Tournaments(id)
);

-- Table: LeagueStandings
CREATE TABLE LeagueStandings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id INTEGER NOT NULL UNIQUE,
    points INTEGER NOT NULL DEFAULT 0,
    matches_played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    draws INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(participant_id) REFERENCES TournamentParticipants(id)
);

-- Table: Matches
CREATE TABLE Matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id INTEGER NOT NULL,
    phase TEXT NOT NULL, -- LEAGUE, PLAYOFF_LEG_1, ..., FINAL
    status TEXT NOT NULL DEFAULT 'SCHEDULED', -- SCHEDULED, LIVE, COMPLETED
    player_a_participant_id INTEGER NOT NULL,
    player_b_participant_id INTEGER NOT NULL,
    player_a_score INTEGER,
    player_b_score INTEGER,
    winner_participant_id INTEGER,
    scheduled_at TEXT NOT NULL,
    FOREIGN KEY(tournament_id) REFERENCES Tournaments(id),
    FOREIGN KEY(player_a_participant_id) REFERENCES TournamentParticipants(id),
    FOREIGN KEY(player_b_participant_id) REFERENCES TournamentParticipants(id),
    FOREIGN KEY(winner_participant_id) REFERENCES TournamentParticipants(id)
);

-- Table: Transactions
CREATE TABLE Transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    type TEXT NOT NULL, -- TWITCH_REWARD_REDEMPTION, VOTE_SPEND, etc.
    amount INTEGER NOT NULL, -- Positive for credits, negative for debits
    description TEXT NOT NULL,
    related_entity_id INTEGER,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES Users(id)
);

-- Table: VoteEvents
CREATE TABLE VoteEvents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    points_award INTEGER NOT NULL,
    cost_per_vote INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'ACTIVE', -- ACTIVE, COMPLETED
    end_time TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(match_id) REFERENCES Matches(id)
);

-- Table: UserVotes
CREATE TABLE UserVotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    vote_event_id INTEGER NOT NULL,
    voted_for_participant_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES Users(id),
    FOREIGN KEY(vote_event_id) REFERENCES VoteEvents(id),
    FOREIGN KEY(voted_for_participant_id) REFERENCES TournamentParticipants(id)
);

-- Table: Predictions
CREATE TABLE Predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    match_id INTEGER NOT NULL,
    predicted_winner_participant_id INTEGER NOT NULL,
    points_wagered INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES Users(id),
    FOREIGN KEY(match_id) REFERENCES Matches(id),
    FOREIGN KEY(predicted_winner_participant_id) REFERENCES TournamentParticipants(id),
    CONSTRAINT uq_user_match_prediction UNIQUE (user_id, match_id)
);
