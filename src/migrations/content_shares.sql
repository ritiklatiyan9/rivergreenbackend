-- Content Share table for agents to save content (message + optional PDF)
CREATE TABLE IF NOT EXISTS content_shares (
    id          SERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       VARCHAR(255),
    message     TEXT,
    file_url    TEXT,
    file_name   VARCHAR(255),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_shares_user ON content_shares(user_id);
