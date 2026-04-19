-- Inventory Management module
-- Supports category management, product stock ledger, and atomic stock in/out transactions

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TABLE IF NOT EXISTS inventory_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inventory_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  category_id UUID NOT NULL REFERENCES inventory_categories(id) ON DELETE RESTRICT,
  name VARCHAR(180) NOT NULL,
  current_stock INTEGER NOT NULL DEFAULT 0 CHECK (current_stock >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stock_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES inventory_products(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL CHECK (type IN ('IN', 'OUT')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  note TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_categories_site_name
  ON inventory_categories(site_id, LOWER(name));

CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_products_site_name
  ON inventory_products(site_id, LOWER(name));

CREATE INDEX IF NOT EXISTS idx_inventory_categories_site
  ON inventory_categories(site_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_products_site_category
  ON inventory_products(site_id, category_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_transactions_site_product
  ON stock_transactions(site_id, product_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_stock_transactions_product_type
  ON stock_transactions(product_id, type, created_at DESC);

DROP TRIGGER IF EXISTS update_inventory_categories_updated_at ON inventory_categories;
CREATE TRIGGER update_inventory_categories_updated_at
  BEFORE UPDATE ON inventory_categories
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_inventory_products_updated_at ON inventory_products;
CREATE TRIGGER update_inventory_products_updated_at
  BEFORE UPDATE ON inventory_products
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
