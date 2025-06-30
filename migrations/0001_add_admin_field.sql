-- Add is_admin field to Users table
ALTER TABLE Users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Make the first user (you) an admin
UPDATE Users SET is_admin = 1 WHERE twitch_id = '613680880';