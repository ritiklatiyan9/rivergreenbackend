    -- Chat Groups Migration
    -- Adds support for group conversations in chat module

    ALTER TABLE chat_conversations
    ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS group_name VARCHAR(120);

    CREATE INDEX IF NOT EXISTS idx_chat_conversations_is_group
    ON chat_conversations(is_group);