-- ============================================================
-- COLONY MAPS TABLE (layout images for each site)
-- ============================================================
CREATE TABLE IF NOT EXISTS colony_maps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  image_url TEXT NOT NULL,
  image_width INTEGER NOT NULL DEFAULT 0,
  image_height INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_colony_maps_site_id ON colony_maps(site_id);
CREATE INDEX IF NOT EXISTS idx_colony_maps_created_by ON colony_maps(created_by);

-- ============================================================
-- MAP PLOTS TABLE (individual plot polygons on a colony map)
-- ============================================================
CREATE TABLE IF NOT EXISTS map_plots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  colony_map_id UUID NOT NULL REFERENCES colony_maps(id) ON DELETE CASCADE,
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,

  -- Plot Identity
  plot_number VARCHAR(50) NOT NULL,               -- e.g. "A-1", "B-32", "PARK"
  block VARCHAR(50),                               -- e.g. "A", "B", "C"
  plot_type VARCHAR(30) DEFAULT 'RESIDENTIAL'
    CHECK (plot_type IN ('RESIDENTIAL', 'COMMERCIAL', 'PARK', 'ROAD', 'AMENITY', 'OTHER')),

  -- Polygon data (array of {x, y} as percentages of image dimensions for responsiveness)
  polygon_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  fill_color VARCHAR(30) DEFAULT '#4A90D9',

  -- Dimensions & Pricing
  area_sqft DECIMAL(10,2),
  area_sqm DECIMAL(10,2),
  dimensions VARCHAR(100),                         -- e.g. "25' × 45'"
  facing VARCHAR(50),                              -- e.g. "East", "North-West"
  price_per_sqft DECIMAL(12,2),
  total_price DECIMAL(14,2),

  -- Ownership & Status
  status VARCHAR(20) DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE', 'SOLD', 'RESERVED', 'BLOCKED', 'MORTGAGE', 'REGISTRY_PENDING')),
  owner_name VARCHAR(255),
  owner_phone VARCHAR(50),
  owner_email VARCHAR(255),
  owner_address TEXT,

  -- Booking & Payment Info
  booking_date DATE,
  booking_amount DECIMAL(14,2),
  payment_plan TEXT,
  registry_date DATE,
  registry_number VARCHAR(100),

  -- Lead / Agent Tracking
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  assigned_agent UUID REFERENCES users(id) ON DELETE SET NULL,
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,

  -- Misc
  notes TEXT,
  documents JSONB DEFAULT '[]'::jsonb,             -- array of {name, url} uploaded docs

  -- Audit
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_map_plots_colony_map_id ON map_plots(colony_map_id);
CREATE INDEX IF NOT EXISTS idx_map_plots_site_id ON map_plots(site_id);
CREATE INDEX IF NOT EXISTS idx_map_plots_status ON map_plots(status);
CREATE INDEX IF NOT EXISTS idx_map_plots_plot_number ON map_plots(plot_number);
CREATE INDEX IF NOT EXISTS idx_map_plots_lead_id ON map_plots(lead_id);
CREATE INDEX IF NOT EXISTS idx_map_plots_assigned_agent ON map_plots(assigned_agent);

-- Triggers
DROP TRIGGER IF EXISTS update_colony_maps_updated_at ON colony_maps;
CREATE TRIGGER update_colony_maps_updated_at
  BEFORE UPDATE ON colony_maps
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_map_plots_updated_at ON map_plots;
CREATE TRIGGER update_map_plots_updated_at
  BEFORE UPDATE ON map_plots
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
