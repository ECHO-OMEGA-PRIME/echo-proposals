-- Echo Proposals v1.0.0 Schema

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo_url TEXT,
  brand_color TEXT DEFAULT '#14b8a6',
  website TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  default_currency TEXT DEFAULT 'USD',
  default_tax_rate REAL DEFAULT 0,
  payment_terms TEXT DEFAULT 'Due on acceptance',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  company TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  notes TEXT,
  total_proposals INTEGER DEFAULT 0,
  total_value REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  sections TEXT DEFAULT '[]',
  pricing_table TEXT DEFAULT '[]',
  terms TEXT,
  is_default INTEGER DEFAULT 0,
  use_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  client_id TEXT,
  template_id TEXT,
  number TEXT,
  title TEXT NOT NULL,
  slug TEXT UNIQUE,
  status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','viewed','accepted','declined','expired','revised')),
  sections TEXT DEFAULT '[]',
  pricing_table TEXT DEFAULT '[]',
  subtotal REAL DEFAULT 0,
  discount_type TEXT CHECK(discount_type IN ('fixed','percent')),
  discount_value REAL DEFAULT 0,
  tax_rate REAL DEFAULT 0,
  total REAL DEFAULT 0,
  currency TEXT DEFAULT 'USD',
  terms TEXT,
  payment_terms TEXT,
  valid_until TEXT,
  cover_image_url TEXT,
  custom_css TEXT,
  sent_at TEXT,
  viewed_at TEXT,
  first_viewed_at TEXT,
  view_count INTEGER DEFAULT 0,
  total_view_time_sec INTEGER DEFAULT 0,
  accepted_at TEXT,
  accepted_by TEXT,
  accepted_ip TEXT,
  signature_data TEXT,
  declined_at TEXT,
  decline_reason TEXT,
  version INTEGER DEFAULT 1,
  parent_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (client_id) REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS proposal_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id TEXT NOT NULL,
  viewer_ip TEXT,
  viewer_ua TEXT,
  duration_sec INTEGER DEFAULT 0,
  sections_viewed TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (proposal_id) REFERENCES proposals(id)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  author_name TEXT NOT NULL,
  author_type TEXT DEFAULT 'owner' CHECK(author_type IN ('owner','client')),
  body TEXT NOT NULL,
  section_ref TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (proposal_id) REFERENCES proposals(id)
);

CREATE TABLE IF NOT EXISTS content_blocks (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'text' CHECK(type IN ('text','pricing','image','divider','testimonial','faq','team','timeline','video')),
  content TEXT DEFAULT '{}',
  use_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  date TEXT NOT NULL,
  proposals_created INTEGER DEFAULT 0,
  proposals_sent INTEGER DEFAULT 0,
  proposals_viewed INTEGER DEFAULT 0,
  proposals_accepted INTEGER DEFAULT 0,
  proposals_declined INTEGER DEFAULT 0,
  total_value_sent REAL DEFAULT 0,
  total_value_won REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(tenant_id, date)
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL,
  proposal_id TEXT,
  action TEXT NOT NULL,
  details TEXT DEFAULT '{}',
  actor TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_proposals_tenant ON proposals(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_proposals_client ON proposals(client_id);
CREATE INDEX IF NOT EXISTS idx_proposals_slug ON proposals(slug);
CREATE INDEX IF NOT EXISTS idx_clients_tenant ON clients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_views_proposal ON proposal_views(proposal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_proposal ON comments(proposal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_analytics_tenant ON analytics_daily(tenant_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_activity_tenant ON activity_log(tenant_id, created_at DESC);
