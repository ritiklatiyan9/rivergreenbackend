-- Add layout_config JSONB column to colony_maps for quadrant-based layouts
-- This stores the grid configuration: topLeft, topRight, bottomLeft, bottomRight (rows/cols), roadEvery
ALTER TABLE colony_maps ADD COLUMN IF NOT EXISTS layout_config JSONB DEFAULT '{}'::jsonb;
