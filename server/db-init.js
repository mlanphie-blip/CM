const { getDb } = require('./database');

function initializeDatabase() {
  const db = getDb();

  db.exec(`
    -- Users table
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'reviewer')) DEFAULT 'reviewer',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Contracts table
    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      original_filename TEXT,
      file_path TEXT,
      file_type TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Contract sections/clauses
    CREATE TABLE IF NOT EXISTS contract_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      section_number TEXT NOT NULL,
      title TEXT,
      content TEXT NOT NULL,
      parent_section_id INTEGER REFERENCES contract_sections(id),
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Contract versions
    CREATE TABLE IF NOT EXISTS contract_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      version_label TEXT,
      change_summary TEXT,
      full_text TEXT,
      sections_snapshot TEXT,
      created_by INTEGER REFERENCES users(id),
      branch_name TEXT DEFAULT 'main',
      parent_version_id INTEGER REFERENCES contract_versions(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Amendment proposals
    CREATE TABLE IF NOT EXISTS proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      section_id INTEGER REFERENCES contract_sections(id),
      title TEXT NOT NULL,
      original_text TEXT NOT NULL,
      proposed_text TEXT NOT NULL,
      rationale TEXT,
      proposer_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('draft', 'under_review', 'approved', 'rejected', 'withdrawn')) DEFAULT 'draft',
      priority TEXT CHECK(priority IN ('low', 'medium', 'high', 'critical')) DEFAULT 'medium',
      bundle_id INTEGER REFERENCES amendment_bundles(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Amendment bundles (group related amendments)
    CREATE TABLE IF NOT EXISTS amendment_bundles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL CHECK(status IN ('open', 'under_review', 'approved', 'rejected')) DEFAULT 'open',
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Feedback/comments on proposals
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      commenter_id INTEGER NOT NULL REFERENCES users(id),
      comment_text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open', 'addressed', 'resolved')) DEFAULT 'open',
      parent_feedback_id INTEGER REFERENCES feedback(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Approval tracking
    CREATE TABLE IF NOT EXISTS approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proposal_id INTEGER NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
      reviewer_id INTEGER NOT NULL REFERENCES users(id),
      decision TEXT CHECK(decision IN ('approved', 'rejected', 'pending')) DEFAULT 'pending',
      comments TEXT,
      required BOOLEAN DEFAULT 0,
      decided_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(proposal_id, reviewer_id)
    );

    -- Amendment templates
    CREATE TABLE IF NOT EXISTS amendment_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      template_text TEXT NOT NULL,
      category TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Notifications
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      reference_type TEXT,
      reference_id INTEGER,
      read BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Audit trail
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Cross-reference tracking
    CREATE TABLE IF NOT EXISTS cross_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      section_id INTEGER NOT NULL REFERENCES contract_sections(id) ON DELETE CASCADE,
      referenced_section_id INTEGER NOT NULL REFERENCES contract_sections(id) ON DELETE CASCADE,
      reference_type TEXT DEFAULT 'mentions',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Create indexes for performance
    CREATE INDEX IF NOT EXISTS idx_sections_contract ON contract_sections(contract_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_contract ON proposals(contract_id);
    CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
    CREATE INDEX IF NOT EXISTS idx_feedback_proposal ON feedback(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_proposal ON approvals(proposal_id);
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
    CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_versions_contract ON contract_versions(contract_id);
  `);

  // Seed default admin user (password: admin123)
  const bcrypt = require('bcryptjs');
  const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare(`
      INSERT INTO users (username, email, password_hash, full_name, role)
      VALUES (?, ?, ?, ?, ?)
    `).run('admin', 'admin@example.com', hash, 'System Administrator', 'admin');

    const editorHash = bcrypt.hashSync('editor123', 10);
    db.prepare(`
      INSERT INTO users (username, email, password_hash, full_name, role)
      VALUES (?, ?, ?, ?, ?)
    `).run('editor', 'editor@example.com', editorHash, 'Contract Editor', 'editor');

    const reviewerHash = bcrypt.hashSync('reviewer123', 10);
    db.prepare(`
      INSERT INTO users (username, email, password_hash, full_name, role)
      VALUES (?, ?, ?, ?, ?)
    `).run('reviewer', 'reviewer@example.com', reviewerHash, 'Contract Reviewer', 'reviewer');

    console.log('Default users created:');
    console.log('  admin/admin123 (admin)');
    console.log('  editor/editor123 (editor)');
    console.log('  reviewer/reviewer123 (reviewer)');
  }

  // Seed amendment templates
  const templatesExist = db.prepare('SELECT COUNT(*) as count FROM amendment_templates').get();
  if (templatesExist.count === 0) {
    const templates = [
      { name: 'Term Extension', description: 'Extend the contract duration', template: 'The term of this Agreement shall be extended from [ORIGINAL_TERM] to [NEW_TERM], effective [EFFECTIVE_DATE].', category: 'Duration' },
      { name: 'Fee Adjustment', description: 'Modify pricing or fees', template: 'Section [SECTION] is hereby amended to replace the fee of [ORIGINAL_FEE] with [NEW_FEE], effective [EFFECTIVE_DATE].', category: 'Financial' },
      { name: 'Scope Change', description: 'Modify scope of work', template: 'The scope of services described in Section [SECTION] is hereby amended to include/exclude the following: [DESCRIPTION].', category: 'Scope' },
      { name: 'Party Addition', description: 'Add a new party to the contract', template: '[NEW_PARTY_NAME], located at [ADDRESS], is hereby added as a party to this Agreement with the following rights and obligations: [DETAILS].', category: 'Parties' },
    ];
    const insertTemplate = db.prepare('INSERT INTO amendment_templates (name, description, template_text, category, created_by) VALUES (?, ?, ?, ?, 1)');
    for (const t of templates) {
      insertTemplate.run(t.name, t.description, t.template, t.category);
    }
    console.log('Default amendment templates created.');
  }

  console.log('Database initialized successfully.');
}

initializeDatabase();
