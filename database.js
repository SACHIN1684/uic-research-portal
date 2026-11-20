const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'research_portal.db');

let db = null;
let SQLRef = null;
let isBrandNewDB = false;

const MAX_HISTORY_STEPS = 30;
let undoStack = [];
let redoStack = [];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
  const parts = String(storedHash || '').split(':');
  if (parts.length !== 2) return false;
  const [salt, keyHex] = parts;
  const keyBuf = Buffer.from(keyHex, 'hex');
  const derivedBuf = crypto.scryptSync(String(password), salt, 64);
  if (keyBuf.length !== derivedBuf.length) return false;
  return crypto.timingSafeEqual(keyBuf, derivedBuf);
}

async function initDB() {
  const SQL = await initSqlJs();
  SQLRef = SQL;

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
    isBrandNewDB = false;
  } else {
    db = new SQL.Database();
    isBrandNewDB = true;
  }

  // Faculty table
  db.run(`
    CREATE TABLE IF NOT EXISTS faculty (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      employee_code TEXT UNIQUE NOT NULL,
      designation TEXT DEFAULT '',
      department TEXT DEFAULT '',
      photo TEXT DEFAULT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Publications table with Document Type & Author Name
  db.run(`
    CREATE TABLE IF NOT EXISTS publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faculty_id INTEGER NOT NULL,
      pub_type TEXT NOT NULL DEFAULT 'Journal', -- 'Journal', 'Conference', 'Book Chapter', 'Patent'
      document_type TEXT DEFAULT 'Article',     -- 'Article', 'Review', 'Conference Paper', 'Book Chapter', 'Patent', etc.
      title TEXT NOT NULL,
      source_title TEXT DEFAULT '',
      author_name TEXT DEFAULT '',             -- Column D: Author names (CU)
      ros REAL DEFAULT 0.0,
      quartile TEXT DEFAULT 'Q1',              -- Q1, Q2, Q3, Q4, or N/A
      link TEXT DEFAULT '',
      apn TEXT DEFAULT '',
      scopus_link TEXT DEFAULT '',             -- EID based Scopus Link
      eid TEXT DEFAULT '',
      month TEXT NOT NULL,                     -- YYYY-MM
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (faculty_id) REFERENCES faculty (id) ON DELETE CASCADE
    );
  `);

  // Admin credentials & session secret table
  db.run(`
    CREATE TABLE IF NOT EXISTS admin_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      session_secret TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const existingAdmin = queryOne('SELECT id FROM admin_config WHERE id = 1');
  if (!existingAdmin) {
    const defaultSecret = crypto.randomBytes(32).toString('hex');
    const defaultPassHash = hashPassword('uic@2026');
    db.run(
      'INSERT INTO admin_config (id, username, password_hash, session_secret) VALUES (1, ?, ?, ?)',
      ['admin', defaultPassHash, defaultSecret]
    );
  }

  // Portal configuration settings (e.g. unique vs separate co-author paper counting)
  db.run(`
    CREATE TABLE IF NOT EXISTS portal_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const existingMode = queryOne("SELECT value FROM portal_settings WHERE key = 'pub_counting_mode'");
  if (!existingMode) {
    db.run(
      "INSERT INTO portal_settings (key, value) VALUES ('pub_counting_mode', 'unique')"
    );
  }

  // Safe migration: add pub_department column to publications if absent
  const pubCols = queryAll("PRAGMA table_info('publications')");
  if (!pubCols.some(c => c.name === 'pub_department')) {
    db.run("ALTER TABLE publications ADD COLUMN pub_department TEXT DEFAULT 'UIC'");
    db.run("UPDATE publications SET pub_department = 'UIC' WHERE pub_department IS NULL OR TRIM(pub_department) = ''");
  }

  // Master publications table representing the exact uploaded master spreadsheet
  db.run(`
    CREATE TABLE IF NOT EXISTS master_publications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_order INTEGER DEFAULT 0,
      month_section TEXT DEFAULT '',
      sr_no TEXT DEFAULT '',
      title TEXT DEFAULT '',
      year TEXT DEFAULT '',
      source_title TEXT DEFAULT '',
      author_name TEXT DEFAULT '',
      scopus_id TEXT DEFAULT '',
      cluster TEXT DEFAULT '',
      institute TEXT DEFAULT '',
      department TEXT DEFAULT '',
      ros TEXT DEFAULT '',
      quartile TEXT DEFAULT '',
      doi TEXT DEFAULT '',
      link TEXT DEFAULT '',
      document_type TEXT DEFAULT '',
      eid TEXT DEFAULT '',
      scopus_link TEXT DEFAULT '',
      apn TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Upcoming Conferences table
  db.run(`
    CREATE TABLE IF NOT EXISTS upcoming_conferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      acronym TEXT DEFAULT '',
      organizer TEXT DEFAULT '',
      venue TEXT DEFAULT '',
      conference_date TEXT DEFAULT '',
      submission_deadline TEXT DEFAULT '',
      notification_date TEXT DEFAULT '',
      indexing TEXT DEFAULT 'Scopus',
      website_url TEXT DEFAULT '',
      cfp_link TEXT DEFAULT '',
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'Upcoming',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Faculty Research Proof Documents table
  db.run(`
    CREATE TABLE IF NOT EXISTS faculty_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faculty_id INTEGER NOT NULL,
      faculty_name TEXT DEFAULT '',
      uploader_type TEXT DEFAULT 'faculty',
      original_name TEXT NOT NULL,
      stored_filename TEXT NOT NULL,
      file_type TEXT DEFAULT 'pdf',
      file_size INTEGER DEFAULT 0,
      description TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (faculty_id) REFERENCES faculty (id) ON DELETE CASCADE
    );
  `);

  // Faculty Profile Public Requests table
  db.run(`
    CREATE TABLE IF NOT EXISTS profile_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faculty_id INTEGER NOT NULL,
      faculty_name TEXT DEFAULT '',
      employee_code TEXT DEFAULT '',
      requester_email TEXT DEFAULT '',
      message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected'
      admin_note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_at DATETIME DEFAULT NULL,
      FOREIGN KEY (faculty_id) REFERENCES faculty (id) ON DELETE CASCADE
    );
  `);

  ensureFacultySchemaColumns(true);
  seedMasterPublicationsFromExcel();
  seedConferencesIfEmpty();

  saveDB();
  return db;
}

function normalizeMemberType(rawType, designation = '', employeeCode = '') {
  const t = String(rawType || '').trim().toLowerCase();
  if (t) {
    if (t.includes('student')) return 'Student';
    if (t.includes('fellow') || t.includes('scholar') || t.includes('jrf') || t.includes('srf') || t.includes('phd')) {
      return 'Research Fellow';
    }
    if (t.includes('other') || t.includes('visiting') || t.includes('guest') || t.includes('postdoc') || t.includes('adjunct')) {
      return 'Other';
    }
    if (t.includes('faculty') || t.includes('prof') || t.includes('teacher') || t.includes('staff')) {
      return 'Faculty';
    }
  }
  const d = String(designation || '').trim().toLowerCase();
  const c = String(employeeCode || '').trim();
  if (/research\s*(scholar|fellow)|reseach\s*scholar|jrf|srf|phd/i.test(d) || /^R\d+/i.test(c)) {
    return 'Research Fellow';
  }
  if (/student/i.test(d) || /^\d{2}[a-z]{2,}\d+/i.test(c)) {
    return 'Student';
  }
  if (/visiting|adjunct|guest|postdoc/i.test(d)) {
    return 'Other';
  }
  return 'Faculty';
}

function normalizeMemberStatus(rawStatus) {
  const s = String(rawStatus || '').trim().toLowerCase();
  if (!s) return 'Active';
  if (/(inactive|left|resigned|relieved|ex\b|former|no|0|false)/i.test(s)) {
    return 'Inactive';
  }
  return 'Active';
}

function ensureFacultySchemaColumns(backfillTypes = false) {
  const facCols = queryAll("PRAGMA table_info('faculty')");
  const hasScopus = facCols.some(c => c.name === 'scopus_id');
  const hasType = facCols.some(c => c.name === 'member_type');
  const hasStatus = facCols.some(c => c.name === 'status');

  if (!hasScopus) {
    db.run("ALTER TABLE faculty ADD COLUMN scopus_id TEXT DEFAULT ''");
  }
  if (!hasType) {
    db.run("ALTER TABLE faculty ADD COLUMN member_type TEXT DEFAULT 'Faculty'");
    if (backfillTypes) {
      const all = queryAll('SELECT id, employee_code, designation FROM faculty');
      all.forEach(f => {
        const inferred = normalizeMemberType('', f.designation, f.employee_code);
        if (inferred !== 'Faculty') {
          db.run('UPDATE faculty SET member_type = ? WHERE id = ?', [inferred, f.id]);
        }
      });
    }
  }
  if (!hasStatus) {
    db.run("ALTER TABLE faculty ADD COLUMN status TEXT DEFAULT 'Active'");
    db.run("UPDATE faculty SET status = 'Active' WHERE status IS NULL OR TRIM(status) = ''");
  }

  const hasVisibility = facCols.some(c => c.name === 'visibility');
  if (!hasVisibility) {
    db.run("ALTER TABLE faculty ADD COLUMN visibility TEXT DEFAULT 'public'");
    db.run("UPDATE faculty SET visibility = 'public' WHERE visibility IS NULL OR TRIM(visibility) = ''");
  }
}

function captureSnapshot(label) {
  if (!db) return null;
  return {
    label: String(label || 'Change'),
    timestamp: new Date().toISOString(),
    buffer: Buffer.from(db.export())
  };
}

function recordUndoState(label) {
  const snap = captureSnapshot(label);
  if (!snap) return;
  undoStack.push(snap);
  if (undoStack.length > MAX_HISTORY_STEPS) {
    undoStack.shift();
  }
  redoStack = [];
}

function restoreSnapshot(snap) {
  if (!snap || !SQLRef) return false;
  // Preserve active admin credentials/session secret so undo/redo never logs out admin
  const currentAdmin = queryOne('SELECT username, password_hash, session_secret, updated_at FROM admin_config WHERE id = 1');
  db = new SQLRef.Database(snap.buffer);

  // Ensure schema compatibility
  const pubCols = queryAll("PRAGMA table_info('publications')");
  if (!pubCols.some(c => c.name === 'pub_department')) {
    db.run("ALTER TABLE publications ADD COLUMN pub_department TEXT DEFAULT 'UIC'");
  }
  ensureFacultySchemaColumns(false);

  if (currentAdmin) {
    db.run(
      'UPDATE admin_config SET username = ?, password_hash = ?, session_secret = ?, updated_at = ? WHERE id = 1',
      [currentAdmin.username, currentAdmin.password_hash, currentAdmin.session_secret, currentAdmin.updated_at]
    );
  }
  saveDB();
  return true;
}

function undoAction() {
  if (undoStack.length === 0) {
    return { ok: false, message: 'Nothing to undo.' };
  }
  const targetSnap = undoStack.pop();
  const currentSnap = captureSnapshot(targetSnap.label);
  if (currentSnap) redoStack.push(currentSnap);
  restoreSnapshot(targetSnap);
  return { ok: true, label: targetSnap.label };
}

function redoAction() {
  if (redoStack.length === 0) {
    return { ok: false, message: 'Nothing to redo.' };
  }
  const targetSnap = redoStack.pop();
  const currentSnap = captureSnapshot(targetSnap.label);
  if (currentSnap) undoStack.push(currentSnap);
  restoreSnapshot(targetSnap);
  return { ok: true, label: targetSnap.label };
}

function getHistoryStatus() {
  return {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    undoCount: undoStack.length,
    redoCount: redoStack.length,
    undoLabel: undoStack.length > 0 ? undoStack[undoStack.length - 1].label : '',
    redoLabel: redoStack.length > 0 ? redoStack[redoStack.length - 1].label : ''
  };
}

function saveDB() {
  if (!db) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function queryAll(sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const results = [];
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function queryOne(sql, params) {
  const results = queryAll(sql, params);
  return results.length > 0 ? results[0] : null;
}

function getEffectiveQuartile(p) {
  // Always check the Quartile column (Q1-Q4) first across all document types;
  // only fall back to Q4 for Conference papers when Quartile is N/A or blank
  const q = String(p.quartile || '').trim().toUpperCase();
  if (['Q1', 'Q2', 'Q3', 'Q4'].includes(q)) return q;
  if (p.pub_type === 'Conference') return 'Q4';
  return 'N/A';
}

function computeQuartileStats(pubs) {
  const counts = { q1: 0, q2: 0, q3: 0, q4: 0 };
  const ros = { q1: 0, q2: 0, q3: 0, q4: 0 };

  pubs.forEach(p => {
    const eq = getEffectiveQuartile(p);
    const val = parseFloat(p.ros) || 0;
    if (eq === 'Q1') { counts.q1 += 1; ros.q1 += val; }
    else if (eq === 'Q2') { counts.q2 += 1; ros.q2 += val; }
    else if (eq === 'Q3') { counts.q3 += 1; ros.q3 += val; }
    else if (eq === 'Q4') { counts.q4 += 1; ros.q4 += val; }
  });

  return {
    q1: counts.q1,
    q2: counts.q2,
    q3: counts.q3,
    q4: counts.q4,
    q1_ros: parseFloat(ros.q1.toFixed(2)),
    q2_ros: parseFloat(ros.q2.toFixed(2)),
    q3_ros: parseFloat(ros.q3.toFixed(2)),
    q4_ros: parseFloat(ros.q4.toFixed(2))
  };
}

function getPubCountingMode() {
  const row = queryOne("SELECT value FROM portal_settings WHERE key = 'pub_counting_mode'");
  const val = row ? String(row.value || '').trim().toLowerCase() : 'unique';
  return val === 'separate' ? 'separate' : 'unique';
}

function normalizePubDepartment(deptRaw) {
  const d = String(deptRaw || '').trim();
  return d || 'UIC';
}

function isUicDepartment(deptRaw) {
  const d = String(deptRaw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!d) return true;
  return (
    d === 'UIC' ||
    d === 'UIC DEPARTMENT' ||
    d === 'UNIVERSITY INSTITUTE OF COMPUTING' ||
    d === 'UNIVERSITY INSTITUTE OF COMPUTING (UIC)'
  );
}

function setPubCountingMode(mode) {
  const normalized = String(mode || '').trim().toLowerCase() === 'separate' ? 'separate' : 'unique';
  db.run(
    "INSERT INTO portal_settings (key, value, updated_at) VALUES ('pub_counting_mode', ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP",
    [normalized]
  );
  saveDB();
  return normalized;
}

function getPaperDedupKey(p) {
  const eidNorm = String(p.eid || '').trim().toLowerCase().replace(/\s+/g, '');
  if (eidNorm) return `eid:${eidNorm}`;
  const titleNorm = String(p.title || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (titleNorm) return `title:${titleNorm}`;
  return `id:${p.id}`;
}

function computeDepartmentQuartileStats(pubs, mode = getPubCountingMode()) {
  const qStats = computeQuartileStats(pubs);
  const ros = parseFloat(pubs.reduce((sum, p) => sum + (parseFloat(p.ros) || 0), 0).toFixed(2));

  if (mode === 'separate') {
    return {
      ...qStats,
      total: pubs.length,
      ros
    };
  }

  // Unique Paper Mode: group multi-author entries sharing the same EID or Title as 1 publication
  const quartilePriority = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, 'N/A': 5 };
  const uniquePapers = new Map();

  pubs.forEach(p => {
    const key = getPaperDedupKey(p);
    const eq = getEffectiveQuartile(p);
    if (!uniquePapers.has(key)) {
      uniquePapers.set(key, eq);
    } else {
      const existingEq = uniquePapers.get(key);
      if ((quartilePriority[eq] || 9) < (quartilePriority[existingEq] || 9)) {
        uniquePapers.set(key, eq);
      }
    }
  });

  const uniqueCounts = { q1: 0, q2: 0, q3: 0, q4: 0 };
  uniquePapers.forEach(eq => {
    if (eq === 'Q1') uniqueCounts.q1 += 1;
    else if (eq === 'Q2') uniqueCounts.q2 += 1;
    else if (eq === 'Q3') uniqueCounts.q3 += 1;
    else if (eq === 'Q4') uniqueCounts.q4 += 1;
  });

  return {
    q1: uniqueCounts.q1,
    q2: uniqueCounts.q2,
    q3: uniqueCounts.q3,
    q4: uniqueCounts.q4,
    q1_ros: qStats.q1_ros,
    q2_ros: qStats.q2_ros,
    q3_ros: qStats.q3_ros,
    q4_ros: qStats.q4_ros,
    total: uniquePapers.size,
    ros
  };
}

function getDepartmentPublicationOverview(mode = getPubCountingMode()) {
  const allPubs = queryAll('SELECT id, pub_type, quartile, ros, title, eid, month, pub_department FROM publications');
  const buckets = new Map();

  allPubs.forEach(p => {
    const scope = isUicDepartment(p.pub_department) ? 'uic' : 'other';
    const parsed = parsePublicationYearMonth(p.month);
    const ymKey = parsed ? `${parsed.year}-${String(parsed.month).padStart(2, '0')}` : 'unspec';
    const bKey = `${scope}|${ymKey}`;
    if (!buckets.has(bKey)) buckets.set(bKey, []);
    buckets.get(bKey).push(p);
  });

  let totalPubs = 0;
  let q1Count = 0;
  buckets.forEach(list => {
    const st = computeDepartmentQuartileStats(list, mode);
    totalPubs += st.total;
    q1Count += st.q1;
  });

  return {
    totalPubs,
    q1Count
  };
}

function getAllFacultyWithStats() {
  const list = queryAll('SELECT * FROM faculty ORDER BY name ASC');
  return list.map(f => {
    const pubs = queryAll('SELECT * FROM publications WHERE faculty_id = ? ORDER BY month DESC, id DESC', [f.id]);
    const journalCount = pubs.filter(p => p.pub_type === 'Journal').length;
    const confCount = pubs.filter(p => p.pub_type === 'Conference').length;
    const bookCount = pubs.filter(p => p.pub_type === 'Book Chapter').length;
    const patentCount = pubs.filter(p => p.pub_type === 'Patent').length;

    const qStats = computeQuartileStats(pubs);

    const totalRos = pubs.reduce((sum, p) => sum + (parseFloat(p.ros) || 0), 0);

    const monthMap = {};
    pubs.forEach(p => {
      const m = p.month || 'Unspecified';
      monthMap[m] = (monthMap[m] || 0) + (parseFloat(p.ros) || 0);
    });

    return {
      ...f,
      total_pubs: pubs.length,
      journal_count: journalCount,
      conf_count: confCount,
      book_count: bookCount,
      patent_count: patentCount,
      ...qStats,
      ros: parseFloat(totalRos.toFixed(2)),
      month_ros: monthMap
    };
  });
}

function getFacultyById(id) {
  const f = queryOne('SELECT * FROM faculty WHERE id = ?', [id]);
  if (!f) return null;

  const pubs = queryAll('SELECT * FROM publications WHERE faculty_id = ? ORDER BY month DESC, id DESC', [id]);
  const journalCount = pubs.filter(p => p.pub_type === 'Journal').length;
  const confCount = pubs.filter(p => p.pub_type === 'Conference').length;
  const bookCount = pubs.filter(p => p.pub_type === 'Book Chapter').length;
  const patentCount = pubs.filter(p => p.pub_type === 'Patent').length;

  const qStats = computeQuartileStats(pubs);

  const totalRos = pubs.reduce((sum, p) => sum + (parseFloat(p.ros) || 0), 0);

  // Month-wise aggregation
  const monthMap = {};
  pubs.forEach(p => {
    const m = p.month || 'Unspecified';
    if (!monthMap[m]) {
      monthMap[m] = {
        month: m,
        count: 0,
        ros: 0,
        q1: 0, q2: 0, q3: 0, q4: 0,
        q1_ros: 0, q2_ros: 0, q3_ros: 0, q4_ros: 0,
        journal: 0, conf: 0, book: 0, patent: 0,
        pubs: []
      };
    }
    const pubRos = parseFloat(p.ros) || 0;
    monthMap[m].count += 1;
    monthMap[m].ros += pubRos;
    const eq = getEffectiveQuartile(p);
    if (eq === 'Q1') { monthMap[m].q1 += 1; monthMap[m].q1_ros += pubRos; }
    else if (eq === 'Q2') { monthMap[m].q2 += 1; monthMap[m].q2_ros += pubRos; }
    else if (eq === 'Q3') { monthMap[m].q3 += 1; monthMap[m].q3_ros += pubRos; }
    else if (eq === 'Q4') { monthMap[m].q4 += 1; monthMap[m].q4_ros += pubRos; }

    if (p.pub_type === 'Journal') {
      monthMap[m].journal += 1;
    } else if (p.pub_type === 'Conference') {
      monthMap[m].conf += 1;
    } else if (p.pub_type === 'Book Chapter') {
      monthMap[m].book += 1;
    } else if (p.pub_type === 'Patent') {
      monthMap[m].patent += 1;
    }
    monthMap[m].pubs.push(p);
  });

  const monthWise = Object.values(monthMap).sort((a, b) => b.month.localeCompare(a.month));
  monthWise.forEach(mw => {
    mw.ros = parseFloat(mw.ros.toFixed(2));
    mw.q1_ros = parseFloat(mw.q1_ros.toFixed(2));
    mw.q2_ros = parseFloat(mw.q2_ros.toFixed(2));
    mw.q3_ros = parseFloat(mw.q3_ros.toFixed(2));
    mw.q4_ros = parseFloat(mw.q4_ros.toFixed(2));
  });

  // Load research proof documents for this faculty
  const documents = queryAll(
    'SELECT * FROM faculty_documents WHERE faculty_id = ? ORDER BY uploaded_at DESC',
    [Number(id)]
  );

  return {
    ...f,
    publications: pubs,
    month_wise: monthWise,
    total_pubs: pubs.length,
    journal_count: journalCount,
    conf_count: confCount,
    book_count: bookCount,
    patent_count: patentCount,
    documents,
    ...qStats,
    ros: parseFloat(totalRos.toFixed(2))
  };
}

function getFacultyByEmployeeCode(code) {
  return queryOne('SELECT * FROM faculty WHERE employee_code = ?', [code]);
}

// Case-insensitive & normalized name matching
function findFacultyByName(nameQuery) {
  if (!nameQuery || !nameQuery.trim()) return null;
  const cleanQ = nameQuery.toLowerCase()
    .replace(/^(dr\.|dr|prof\.|prof|mr\.|mr|mrs\.|mrs|ms\.|ms)\s+/i, '')
    .trim();

  const all = queryAll('SELECT * FROM faculty');
  // 1. Direct match
  for (const f of all) {
    const cleanName = f.name.toLowerCase()
      .replace(/^(dr\.|dr|prof\.|prof|mr\.|mr|mrs\.|mrs|ms\.|ms)\s+/i, '')
      .trim();
    if (cleanName === cleanQ) return f;
  }
  // 2. Partial/contains match
  for (const f of all) {
    const cleanName = f.name.toLowerCase()
      .replace(/^(dr\.|dr|prof\.|prof|mr\.|mr|mrs\.|mrs|ms\.|ms)\s+/i, '')
      .trim();
    if (cleanName.includes(cleanQ) || cleanQ.includes(cleanName)) return f;
  }
  return null;
}

function normalizeNameForDupCheck(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/^(dr\.|dr|prof\.|prof|mr\.|mr|mrs\.|mrs|ms\.|ms)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function findDuplicateFaculty(name, employeeCode) {
  const codeTrim = String(employeeCode || '').trim().toLowerCase();
  const nameExact = String(name || '').trim().toLowerCase();
  const nameNorm = normalizeNameForDupCheck(name);

  const all = queryAll('SELECT * FROM faculty');
  let codeMatch = null;
  let nameMatch = null;

  for (const f of all) {
    if (codeTrim && String(f.employee_code || '').trim().toLowerCase() === codeTrim) {
      codeMatch = f;
    }
    const fExact = String(f.name || '').trim().toLowerCase();
    const fNorm = normalizeNameForDupCheck(f.name);
    if (nameExact && (fExact === nameExact || (nameNorm && fNorm === nameNorm))) {
      nameMatch = f;
    }
  }

  if (codeMatch && nameMatch && codeMatch.id === nameMatch.id) {
    return { existing: codeMatch, matchReason: 'Both Name & Employee Code' };
  }
  if (codeMatch) {
    return { existing: codeMatch, matchReason: 'Employee Code' };
  }
  if (nameMatch) {
    return { existing: nameMatch, matchReason: 'Faculty Name' };
  }
  return null;
}

function analyzeFacultyUpload(rows) {
  const newRows = [];
  const duplicateRows = [];
  const seenCodes = new Set();

  for (const row of rows) {
    const name = (row.name || '').trim();
    const code = (row.employee_code || '').trim();
    if (!name || !code) continue;

    const codeKey = code.toLowerCase();
    if (seenCodes.has(codeKey)) continue;
    seenCodes.add(codeKey);

    const dup = findDuplicateFaculty(name, code);
    const desig = (row.designation || '').trim();
    const dept = (row.department || '').trim();
    const scopusId = (row.scopus_id || '').trim();
    const memberType = normalizeMemberType(row.member_type, desig, code);
    const status = normalizeMemberStatus(row.status);

    if (dup) {
      duplicateRows.push({
        incoming: {
          name,
          employee_code: code,
          designation: desig,
          department: dept,
          scopus_id: scopusId,
          member_type: memberType,
          status
        },
        existing: {
          id: dup.existing.id,
          name: dup.existing.name,
          employee_code: dup.existing.employee_code,
          designation: dup.existing.designation,
          department: dup.existing.department,
          scopus_id: dup.existing.scopus_id || '',
          member_type: dup.existing.member_type || 'Faculty',
          status: dup.existing.status || 'Active'
        },
        matchReason: dup.matchReason
      });
    } else {
      newRows.push({
        name,
        employee_code: code,
        designation: desig,
        department: dept,
        scopus_id: scopusId,
        member_type: memberType,
        status
      });
    }
  }

  return { newRows, duplicateRows };
}

function applyFacultyUpload(newRows, duplicateRows, replaceExisting) {
  let addedCount = 0;
  let replacedCount = 0;
  let skippedCount = 0;

  for (const row of (newRows || [])) {
    const existing = getFacultyByEmployeeCode(row.employee_code);
    if (existing) {
      if (replaceExisting) {
        updateFaculty(existing.id, row);
        replacedCount++;
      } else {
        skippedCount++;
      }
    } else {
      addFaculty(row);
      addedCount++;
    }
  }

  for (const item of (duplicateRows || [])) {
    if (replaceExisting) {
      const targetId = item.existing.id;
      const incoming = item.incoming;
      const codeOwner = getFacultyByEmployeeCode(incoming.employee_code);
      if (codeOwner && codeOwner.id !== targetId) {
        updateFaculty(codeOwner.id, incoming);
      } else {
        updateFaculty(targetId, incoming);
      }
      replacedCount++;
    } else {
      skippedCount++;
    }
  }

  saveDB();
  return { addedCount, replacedCount, skippedCount };
}

function addFaculty(data) {
  const memberType = normalizeMemberType(data.member_type, data.designation, data.employee_code);
  const status = normalizeMemberStatus(data.status);
  const visibility = (data.visibility && String(data.visibility).trim().toLowerCase() === 'private') ? 'private' : 'public';
  db.run(`
    INSERT INTO faculty (name, employee_code, designation, department, scopus_id, member_type, status, photo, visibility)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.name.trim(),
    data.employee_code.trim(),
    data.designation || '',
    data.department || '',
    (data.scopus_id || '').trim(),
    memberType,
    status,
    data.photo || null,
    visibility
  ]);
  saveDB();
  const res = queryOne('SELECT last_insert_rowid() as id');
  return res ? res.id : null;
}

function addFacultyBulk(rows) {
  let addedCount = 0;
  let skippedCount = 0;
  const errors = [];

  for (const row of rows) {
    const name = (row.name || '').trim();
    const code = (row.employee_code || '').trim();
    if (!name || !code) {
      skippedCount++;
      continue;
    }

    const existing = getFacultyByEmployeeCode(code);
    if (existing) {
      skippedCount++;
      errors.push(`Skipped code "${code}": already exists (${existing.name})`);
      continue;
    }

    addFaculty({
      name,
      employee_code: code,
      designation: (row.designation || '').trim(),
      department: (row.department || '').trim(),
      scopus_id: (row.scopus_id || '').trim(),
      member_type: row.member_type,
      status: row.status,
      visibility: row.visibility
    });
    addedCount++;
  }

  saveDB();
  return { addedCount, skippedCount, errors };
}

function updateFaculty(id, data) {
  const existing = getFacultyById(id);
  const photo = data.photo || (existing ? existing.photo : null);
  const scopusId = data.scopus_id !== undefined ? String(data.scopus_id || '').trim() : (existing ? (existing.scopus_id || '') : '');
  const memberType = data.member_type !== undefined
    ? normalizeMemberType(data.member_type, data.designation, data.employee_code)
    : (existing ? (existing.member_type || 'Faculty') : 'Faculty');
  const status = data.status !== undefined
    ? normalizeMemberStatus(data.status)
    : (existing ? (existing.status || 'Active') : 'Active');
  const visibility = data.visibility !== undefined
    ? ((String(data.visibility).trim().toLowerCase() === 'private') ? 'private' : 'public')
    : (existing ? (existing.visibility || 'public') : 'public');

  db.run(`
    UPDATE faculty SET
      name = ?, employee_code = ?, designation = ?, department = ?, scopus_id = ?, member_type = ?, status = ?, photo = ?, visibility = ?
    WHERE id = ?
  `, [
    data.name.trim(),
    data.employee_code.trim(),
    (data.designation || '').trim(),
    (data.department || '').trim(),
    scopusId,
    memberType,
    status,
    photo,
    visibility,
    id
  ]);
  saveDB();
}

function setFacultyVisibility(facultyId, visibility) {
  const normVis = String(visibility || '').trim().toLowerCase() === 'private' ? 'private' : 'public';
  recordUndoState(`Set Faculty #${facultyId} visibility to ${normVis}`);
  db.run('UPDATE faculty SET visibility = ? WHERE id = ?', [normVis, Number(facultyId)]);
  saveDB();
  return getFacultyById(facultyId);
}

function getMemberBifurcationStats(facultyList) {
  const list = facultyList || getAllFacultyWithStats();
  const facultyCount = list.filter(f => (f.member_type || 'Faculty') === 'Faculty').length;
  const fellowCount = list.filter(f => f.member_type === 'Research Fellow').length;
  const studentCount = list.filter(f => f.member_type === 'Student').length;
  const otherCount = list.filter(f => f.member_type === 'Other').length;
  const activeStatusCount = list.filter(f => (f.status || 'Active') !== 'Inactive').length;
  const inactiveStatusCount = list.filter(f => f.status === 'Inactive').length;
  const publicCount = list.filter(f => (f.visibility || 'public') !== 'private').length;
  const privateCount = list.filter(f => (f.visibility || 'public') === 'private').length;
  return {
    totalCount: list.length,
    facultyCount,
    fellowCount,
    studentCount,
    otherCount,
    activeStatusCount,
    inactiveStatusCount,
    publicCount,
    privateCount
  };
}

function deleteFaculty(id) {
  db.run('DELETE FROM publications WHERE faculty_id = ?', [id]);
  db.run('DELETE FROM faculty WHERE id = ?', [id]);
  saveDB();
}

function deleteFacultyMultiple(ids) {
  if (!ids || ids.length === 0) return { deletedCount: 0, photos: [] };
  const placeholders = ids.map(() => '?').join(',');
  const toDelete = queryAll(`SELECT id, photo FROM faculty WHERE id IN (${placeholders})`, ids);
  const photos = toDelete.map(f => f.photo).filter(Boolean);

  db.run(`DELETE FROM publications WHERE faculty_id IN (${placeholders})`, ids);
  db.run(`DELETE FROM faculty WHERE id IN (${placeholders})`, ids);
  saveDB();
  return { deletedCount: toDelete.length, photos };
}

function deleteAllFaculty() {
  const toDelete = queryAll('SELECT id, photo FROM faculty');
  const photos = toDelete.map(f => f.photo).filter(Boolean);

  db.run('DELETE FROM publications');
  db.run('DELETE FROM faculty');
  saveDB();
  return { deletedCount: toDelete.length, photos };
}

function addPublication(facultyId, data) {
  const ros = parseFloat(data.ros) || 0.0;
  const pubDept = normalizePubDepartment(data.pub_department);
  db.run(`
    INSERT INTO publications (faculty_id, pub_type, document_type, title, source_title, author_name, ros, quartile, link, apn, scopus_link, eid, month, pub_department)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    facultyId,
    data.pub_type || 'Journal',
    data.document_type || 'Article',
    data.title.trim(),
    (data.source_title || '').trim(),
    (data.author_name || '').trim(),
    ros,
    data.quartile || 'N/A',
    (data.link || '').trim(),
    (data.apn || '').trim(),
    (data.scopus_link || '').trim(),
    (data.eid || '').trim(),
    data.month || new Date().toISOString().substring(0, 7),
    pubDept
  ]);
  saveDB();
}

function addPublicationsBulk(facultyId, rows) {
  let addedCount = 0;
  for (const r of rows) {
    if (!r.title || !r.title.trim()) continue;
    addPublication(facultyId, r);
    addedCount++;
  }
  return addedCount;
}

function normalizeTitleForDupCheck(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '')
    .trim();
}

function normalizeEidForDupCheck(eid) {
  const e = String(eid || '').trim().toLowerCase();
  return (e && e !== 'n/a' && e !== '-' && e !== 'na') ? e : '';
}

function findDuplicatePublication(facultyId, title, eid) {
  const titleNorm = normalizeTitleForDupCheck(title);
  const eidNorm = normalizeEidForDupCheck(eid);
  if (!titleNorm && !eidNorm) return null;

  const existingList = queryAll('SELECT * FROM publications WHERE faculty_id = ?', [facultyId]);
  let eidMatch = null;
  let titleMatch = null;

  for (const p of existingList) {
    if (eidNorm && normalizeEidForDupCheck(p.eid) === eidNorm) {
      eidMatch = p;
    }
    if (titleNorm && normalizeTitleForDupCheck(p.title) === titleNorm) {
      titleMatch = p;
    }
  }

  if (eidMatch && titleMatch && eidMatch.id === titleMatch.id) {
    return { existing: titleMatch, matchReason: 'Both Title & EID' };
  }
  if (eidMatch) {
    return { existing: eidMatch, matchReason: 'EID' };
  }
  if (titleMatch) {
    return { existing: titleMatch, matchReason: 'Paper Title' };
  }
  return null;
}

function analyzePublicationsUpload(items) {
  const newItems = [];
  const duplicateItems = [];
  const seenKeys = new Set();

  for (const item of items) {
    const titleNorm = normalizeTitleForDupCheck(item.pubData.title);
    const eidNorm = normalizeEidForDupCheck(item.pubData.eid);
    const tKey = `${item.facultyId}|t|${titleNorm}`;
    const eKey = eidNorm ? `${item.facultyId}|e|${eidNorm}` : null;

    if (seenKeys.has(tKey) || (eKey && seenKeys.has(eKey))) {
      continue;
    }
    seenKeys.add(tKey);
    if (eKey) seenKeys.add(eKey);

    const dup = findDuplicatePublication(item.facultyId, item.pubData.title, item.pubData.eid);
    if (dup) {
      duplicateItems.push({
        facultyId: item.facultyId,
        facultyName: item.facultyName,
        facultyCode: item.facultyCode,
        incoming: item.pubData,
        existing: dup.existing,
        matchReason: dup.matchReason
      });
    } else {
      newItems.push(item);
    }
  }

  return { newItems, duplicateItems };
}

function applyPublicationsUpload(newItems, duplicateItems, decision) {
  let addedCount = 0;
  let replacedCount = 0;
  let skippedCount = 0;

  for (const item of (newItems || [])) {
    addPublication(item.facultyId, item.pubData);
    addedCount++;
  }

  for (const dup of (duplicateItems || [])) {
    if (decision === 'replace') {
      updatePublication(dup.existing.id, dup.incoming);
      replacedCount++;
    } else if (decision === 'add_all') {
      addPublication(dup.facultyId, dup.incoming);
      addedCount++;
    } else {
      skippedCount++;
    }
  }

  saveDB();
  return { addedCount, replacedCount, skippedCount };
}

function getPublicationById(pubId) {
  return queryOne('SELECT * FROM publications WHERE id = ?', [pubId]);
}

function updatePublication(pubId, data) {
  const ros = parseFloat(data.ros) || 0.0;
  const pubDept = normalizePubDepartment(data.pub_department);
  db.run(`
    UPDATE publications SET
      pub_type = ?,
      document_type = ?,
      title = ?,
      source_title = ?,
      author_name = ?,
      ros = ?,
      quartile = ?,
      link = ?,
      apn = ?,
      scopus_link = ?,
      eid = ?,
      month = ?,
      pub_department = ?
    WHERE id = ?
  `, [
    data.pub_type || 'Journal',
    data.document_type || 'Article',
    (data.title || '').trim(),
    (data.source_title || '').trim(),
    (data.author_name || '').trim(),
    ros,
    data.quartile || 'N/A',
    (data.link || '').trim(),
    (data.apn || '').trim(),
    (data.scopus_link || '').trim(),
    (data.eid || '').trim(),
    data.month || new Date().toISOString().substring(0, 7),
    pubDept,
    pubId
  ]);
  saveDB();
}

function deletePublication(pubId) {
  db.run('DELETE FROM publications WHERE id = ?', [pubId]);
  saveDB();
}

function deletePublicationsMultiple(pubIds) {
  if (!pubIds || pubIds.length === 0) return 0;
  const placeholders = pubIds.map(() => '?').join(',');
  db.run(`DELETE FROM publications WHERE id IN (${placeholders})`, pubIds);
  saveDB();
  return pubIds.length;
}

// Seed clean demo data only on first database creation
function seedIfEmpty() {
  if (!isBrandNewDB) return;
  const result = queryOne('SELECT COUNT(*) as c FROM faculty');
  if (result && result.c === 0) {
    const f1Id = addFaculty({ name: 'Neeraj Narwat', employee_code: 'EMP001', designation: 'Professor', department: 'Agriculture & Bio-Tech' });
    addPublication(f1Id, {
      pub_type: 'Journal',
      document_type: 'Review',
      title: 'Biosurfactants as green solutions for sustainable farming: Mechanisms, challenges, and future directions in agroecology',
      source_title: 'European Journal of Agronomy',
      author_name: 'Neeraj Narwat',
      ros: 0.34,
      quartile: 'Q1',
      link: 'https://www.sciencedirect.com/science/article/pii/S116103012600045X',
      apn: '1/Oct/2026',
      scopus_link: 'https://www.scopus.com/inward/record.uri?partnerID=HzOxMe3b&scp=85215014423',
      eid: '105053427146',
      month: '2026-10'
    });

    const f2Id = addFaculty({ name: 'Dr. Sarah Ahmed', employee_code: 'EMP002', designation: 'Professor', department: 'Computer Science' });
    addPublication(f2Id, {
      pub_type: 'Conference',
      document_type: 'Conference Paper',
      title: 'Reinforcement Learning in Edge Cloud Computing Networks',
      source_title: 'IEEE International Conference on Cloud Computing (CLOUD 2026)',
      author_name: 'Dr. Sarah Ahmed',
      ros: 0.25,
      quartile: 'N/A',
      link: 'https://ieeexplore.ieee.org/document/9128301',
      apn: '15/May/2026',
      scopus_link: 'https://www.scopus.com/record/display.uri?eid=2-s2.0-85192837190',
      eid: '2-s2.0-85192837190',
      month: '2026-05'
    });
    addPublication(f2Id, {
      pub_type: 'Book Chapter',
      document_type: 'Book Chapter',
      title: 'Machine Learning Paradigms for Precision Agro-Informatics',
      source_title: 'Springer Advances in Smart Agricultural Systems',
      author_name: 'Dr. Sarah Ahmed',
      ros: 0.20,
      quartile: 'N/A',
      link: 'https://link.springer.com/chapter/10.1007/978-3-030-91234',
      apn: '20/Jul/2026',
      scopus_link: 'https://www.scopus.com/record/display.uri?eid=2-s2.0-85201928371',
      eid: '2-s2.0-85201928371',
      month: '2026-07'
    });

    const f3Id = addFaculty({ name: 'Dr. Khalid Mehmood', employee_code: 'EMP003', designation: 'Associate Professor', department: 'Mathematics' });
    // Zero publications

    const f4Id = addFaculty({ name: 'Dr. Fatima Noor', employee_code: 'EMP004', designation: 'Assistant Professor', department: 'Physics' });
    addPublication(f4Id, {
      pub_type: 'Journal',
      document_type: 'Article',
      title: 'Quantum Entanglement in Solid-State Photonic Channels',
      source_title: 'Physical Review Applied',
      author_name: 'Dr. Fatima Noor',
      ros: 0.70,
      quartile: 'Q2',
      link: 'https://journals.aps.org/prapplied/abstract/10.1103',
      apn: '10/Jan/2026',
      scopus_link: 'https://www.scopus.com/record?eid=2-s2.0-85102938120',
      eid: '2-s2.0-85102938120',
      month: '2026-01'
    });

    const f5Id = addFaculty({ name: 'Dr. Imran Butt', employee_code: 'EMP005', designation: 'Associate Professor', department: 'Chemistry' });
    addPublication(f5Id, {
      pub_type: 'Journal',
      document_type: 'Article',
      title: 'Novel Nanocatalysts for Green Hydrogen Generation via Water Splitting',
      source_title: 'ACS Sustainable Chemistry & Engineering',
      author_name: 'Dr. Imran Butt',
      ros: 0.60,
      quartile: 'Q1',
      link: 'https://pubs.acs.org/doi/10.1021/acssuschemeng',
      apn: '04/Feb/2026',
      scopus_link: 'https://www.scopus.com/record?eid=2-s2.0-85119283019',
      eid: '2-s2.0-85119283019',
      month: '2026-02'
    });

    console.log('✅ Seeded faculty with complete publication and author records.');
  }
}

const MONTH_DEFS = [
  { num: 1, pad: '01', short: 'Jan', full: 'January' },
  { num: 2, pad: '02', short: 'Feb', full: 'February' },
  { num: 3, pad: '03', short: 'Mar', full: 'March' },
  { num: 4, pad: '04', short: 'Apr', full: 'April' },
  { num: 5, pad: '05', short: 'May', full: 'May' },
  { num: 6, pad: '06', short: 'Jun', full: 'June' },
  { num: 7, pad: '07', short: 'Jul', full: 'July' },
  { num: 8, pad: '08', short: 'Aug', full: 'August' },
  { num: 9, pad: '09', short: 'Sep', full: 'September' },
  { num: 10, pad: '10', short: 'Oct', full: 'October' },
  { num: 11, pad: '11', short: 'Nov', full: 'November' },
  { num: 12, pad: '12', short: 'Dec', full: 'December' }
];

function parsePublicationYearMonth(monthStr) {
  const raw = String(monthStr || '').trim();
  if (!raw) return null;

  // Match YYYY-MM, YYYY/MM, YYYY-M, YYYY-MM-DD
  let m = raw.match(/^(\d{4})[-\/](\d{1,2})(?:[-\/]\d{1,2})?$/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month >= 1 && month <= 12) return { year, month };
  }

  // Fallback: look for 4-digit year + short month name (or 2-digit year like Oct-26)
  const lower = raw.toLowerCase();
  let foundMonth = null;
  for (const def of MONTH_DEFS) {
    if (lower.includes(def.short.toLowerCase())) {
      foundMonth = def.num;
      break;
    }
  }
  if (foundMonth) {
    const y4 = raw.match(/\b(20\d{2})\b/);
    if (y4) return { year: parseInt(y4[1], 10), month: foundMonth };
    const y2 = raw.match(/(?:^|[\s\-\/])(\d{2})$/);
    if (y2) return { year: 2000 + parseInt(y2[1], 10), month: foundMonth };
  }

  return null;
}

function filterPubsByDeptScope(pubs, deptScope = 'all') {
  if (deptScope === 'uic') {
    return pubs.filter(p => isUicDepartment(p.pub_department));
  }
  if (deptScope === 'other') {
    return pubs.filter(p => !isUicDepartment(p.pub_department));
  }
  return pubs;
}

function combineSplitDepartmentYear(uicData, otherData) {
  const y = uicData.year;
  let runningRos = 0;
  let runningPubs = 0;
  let prevRos = null;

  const rows = uicData.rows.map((u, idx) => {
    const o = otherData.rows[idx] || {};
    const q1 = u.q1 + (o.q1 || 0);
    const q2 = u.q2 + (o.q2 || 0);
    const q3 = u.q3 + (o.q3 || 0);
    const q4 = u.q4 + (o.q4 || 0);
    const q1_ros = parseFloat((u.q1_ros + (o.q1_ros || 0)).toFixed(2));
    const q2_ros = parseFloat((u.q2_ros + (o.q2_ros || 0)).toFixed(2));
    const q3_ros = parseFloat((u.q3_ros + (o.q3_ros || 0)).toFixed(2));
    const q4_ros = parseFloat((u.q4_ros + (o.q4_ros || 0)).toFixed(2));
    const total = u.total + (o.total || 0);
    const ros = parseFloat((u.ros + (o.ros || 0)).toFixed(2));

    runningRos = parseFloat((runningRos + ros).toFixed(2));
    runningPubs += total;
    const momDiff = prevRos === null ? null : parseFloat((ros - prevRos).toFixed(2));
    const momGrowthPct = (prevRos !== null && prevRos > 0)
      ? parseFloat((((ros - prevRos) / prevRos) * 100).toFixed(1))
      : null;
    prevRos = ros;

    return {
      monthNum: u.monthNum,
      month: u.month,
      monthShort: u.monthShort,
      monthFull: u.monthFull,
      key: u.key,
      departments: Array.from(new Set([...(u.departments || []), ...(o.departments || [])])),
      q1, q2, q3, q4,
      q1_ros, q2_ros, q3_ros, q4_ros,
      total,
      ros,
      cumulative_ros: runningRos,
      cumulative_pubs: runningPubs,
      mom_diff: momDiff,
      mom_growth_pct: momGrowthPct
    };
  });

  const totals = {
    q1: rows.reduce((s, r) => s + r.q1, 0),
    q2: rows.reduce((s, r) => s + r.q2, 0),
    q3: rows.reduce((s, r) => s + r.q3, 0),
    q4: rows.reduce((s, r) => s + r.q4, 0),
    q1_ros: parseFloat(rows.reduce((s, r) => s + r.q1_ros, 0).toFixed(2)),
    q2_ros: parseFloat(rows.reduce((s, r) => s + r.q2_ros, 0).toFixed(2)),
    q3_ros: parseFloat(rows.reduce((s, r) => s + r.q3_ros, 0).toFixed(2)),
    q4_ros: parseFloat(rows.reduce((s, r) => s + r.q4_ros, 0).toFixed(2)),
    total: rows.reduce((s, r) => s + r.total, 0),
    ros: parseFloat(rows.reduce((s, r) => s + r.ros, 0).toFixed(2))
  };

  return {
    year: y,
    mode: uicData.mode,
    deptScope: 'all',
    departments: Array.from(new Set([...(uicData.departments || []), ...(otherData.departments || [])])),
    rows,
    totals
  };
}

function getDepartmentMonthlyROS(year = 2026, mode = getPubCountingMode(), deptScope = 'all') {
  if (deptScope === 'all') {
    const uicData = getDepartmentMonthlyROS(year, mode, 'uic');
    const otherData = getDepartmentMonthlyROS(year, mode, 'other');
    return combineSplitDepartmentYear(uicData, otherData);
  }

  const y = parseInt(year, 10) || 2026;
  const allPubs = filterPubsByDeptScope(queryAll('SELECT * FROM publications'), deptScope);

  let runningRos = 0;
  let runningPubs = 0;
  let prevRos = null;

  const rows = MONTH_DEFS.map(m => {
    const key = `${y}-${m.pad}`;
    const monthPubs = allPubs.filter(p => {
      const parsed = parsePublicationYearMonth(p.month);
      return parsed && parsed.year === y && parsed.month === m.num;
    });

    const stats = computeDepartmentQuartileStats(monthPubs, mode);
    const total = stats.total;
    const ros = stats.ros;

    const deptSet = Array.from(
      new Set(monthPubs.map(p => normalizePubDepartment(p.pub_department)))
    );

    runningRos = parseFloat((runningRos + ros).toFixed(2));
    runningPubs += total;

    const momDiff = prevRos === null ? null : parseFloat((ros - prevRos).toFixed(2));
    const momGrowthPct = (prevRos !== null && prevRos > 0)
      ? parseFloat((((ros - prevRos) / prevRos) * 100).toFixed(1))
      : null;
    prevRos = ros;

    return {
      monthNum: m.num,
      month: `${m.short} ${y}`,
      monthShort: m.short,
      monthFull: `${m.full} ${y}`,
      key,
      departments: deptSet,
      q1: stats.q1,
      q2: stats.q2,
      q3: stats.q3,
      q4: stats.q4,
      q1_ros: stats.q1_ros,
      q2_ros: stats.q2_ros,
      q3_ros: stats.q3_ros,
      q4_ros: stats.q4_ros,
      total,
      ros,
      cumulative_ros: runningRos,
      cumulative_pubs: runningPubs,
      mom_diff: momDiff,
      mom_growth_pct: momGrowthPct
    };
  });

  const yearPubs = allPubs.filter(p => {
    const parsed = parsePublicationYearMonth(p.month);
    return parsed && parsed.year === y;
  });
  const yearDepts = Array.from(new Set(yearPubs.map(p => normalizePubDepartment(p.pub_department))));

  const totals = {
    q1: rows.reduce((s, r) => s + r.q1, 0),
    q2: rows.reduce((s, r) => s + r.q2, 0),
    q3: rows.reduce((s, r) => s + r.q3, 0),
    q4: rows.reduce((s, r) => s + r.q4, 0),
    q1_ros: parseFloat(rows.reduce((s, r) => s + r.q1_ros, 0).toFixed(2)),
    q2_ros: parseFloat(rows.reduce((s, r) => s + r.q2_ros, 0).toFixed(2)),
    q3_ros: parseFloat(rows.reduce((s, r) => s + r.q3_ros, 0).toFixed(2)),
    q4_ros: parseFloat(rows.reduce((s, r) => s + r.q4_ros, 0).toFixed(2)),
    total: rows.reduce((s, r) => s + r.total, 0),
    ros: parseFloat(rows.reduce((s, r) => s + r.ros, 0).toFixed(2))
  };

  return { year: y, mode, deptScope, departments: yearDepts, rows, totals };
}

function getAllYearsMonthlyROS(yearsList = [2024, 2025, 2026, 2027, 2028, 2029, 2030], mode = getPubCountingMode(), deptScope = 'all') {
  const result = {};
  yearsList.forEach(y => {
    result[y] = getDepartmentMonthlyROS(y, mode, deptScope);
  });
  return result;
}

function getAllYearsSplitDepartmentROS(yearsList = [2024, 2025, 2026, 2027, 2028, 2029, 2030], mode = getPubCountingMode()) {
  const uic = getAllYearsMonthlyROS(yearsList, mode, 'uic');
  const other = getAllYearsMonthlyROS(yearsList, mode, 'other');
  const all = {};
  yearsList.forEach(y => {
    all[y] = combineSplitDepartmentYear(uic[y], other[y]);
  });
  return { uic, other, all };
}

function getDepartmentMonthlyROS2026() {
  return getDepartmentMonthlyROS(2026);
}

function getRosCellDetails({ year = 2026, month = 'ALL', scope = 'uic', quartile = 'ALL' }) {
  const y = parseInt(year, 10) || 2026;
  const mNum = String(month || '').toUpperCase() === 'ALL' ? null : parseInt(month, 10);
  const qTarget = String(quartile || 'ALL').trim().toUpperCase();
  const sTarget = String(scope || 'uic').trim().toLowerCase();
  const countingMode = getPubCountingMode();

  const rows = queryAll(`
    SELECT p.*, f.name AS faculty_name, f.employee_code AS faculty_code, f.designation AS faculty_designation
    FROM publications p
    JOIN faculty f ON f.id = p.faculty_id
  `);

  const filtered = rows.filter(p => {
    if (sTarget === 'uic' && !isUicDepartment(p.pub_department)) return false;
    if (sTarget === 'other' && isUicDepartment(p.pub_department)) return false;

    const parsed = parsePublicationYearMonth(p.month);
    if (!parsed || parsed.year !== y) return false;
    if (mNum && parsed.month !== mNum) return false;

    if (['Q1', 'Q2', 'Q3', 'Q4'].includes(qTarget) && getEffectiveQuartile(p) !== qTarget) {
      return false;
    }
    return true;
  });

  // Sort entries by ROS descending, then faculty name, then title
  filtered.sort((a, b) => {
    const rDiff = (parseFloat(b.ros) || 0) - (parseFloat(a.ros) || 0);
    if (Math.abs(rDiff) > 1e-6) return rDiff;
    const nCmp = String(a.faculty_name || '').localeCompare(String(b.faculty_name || ''));
    if (nCmp !== 0) return nCmp;
    return String(a.title || '').localeCompare(String(b.title || ''));
  });

  // Summarize per concerned faculty member
  const facMap = new Map();
  filtered.forEach(p => {
    if (!facMap.has(p.faculty_id)) {
      facMap.set(p.faculty_id, {
        faculty_id: p.faculty_id,
        faculty_name: p.faculty_name,
        faculty_code: p.faculty_code,
        faculty_designation: p.faculty_designation || '',
        paper_count: 0,
        ros_sum: 0
      });
    }
    const f = facMap.get(p.faculty_id);
    f.paper_count += 1;
    f.ros_sum = parseFloat((f.ros_sum + (parseFloat(p.ros) || 0)).toFixed(2));
  });

  const facultySummary = Array.from(facMap.values()).sort(
    (a, b) => (b.ros_sum - a.ros_sum) || a.faculty_name.localeCompare(b.faculty_name)
  );

  // Respect unique/separate paper count per month bucket consistently with ROS table
  let uniquePaperCount = 0;
  if (mNum) {
    uniquePaperCount = computeDepartmentQuartileStats(filtered, countingMode).total;
  } else {
    const byM = new Map();
    filtered.forEach(p => {
      const parsed = parsePublicationYearMonth(p.month);
      const mk = parsed ? parsed.month : 0;
      if (!byM.has(mk)) byM.set(mk, []);
      byM.get(mk).push(p);
    });
    byM.forEach(list => {
      uniquePaperCount += computeDepartmentQuartileStats(list, countingMode).total;
    });
  }

  const totalRos = parseFloat(filtered.reduce((s, p) => s + (parseFloat(p.ros) || 0), 0).toFixed(2));
  const monthDef = mNum ? MONTH_DEFS.find(m => m.num === mNum) : null;

  return {
    year: y,
    month: mNum || 'ALL',
    monthLabel: monthDef ? `${monthDef.full} ${y}` : `Jan – Dec ${y}`,
    scope: sTarget,
    scopeLabel: sTarget === 'other' ? 'Other Department Deputed in UIC' : (sTarget === 'uic' ? 'UIC Department' : 'All Departments'),
    quartile: qTarget,
    countingMode,
    summary: {
      rowCount: filtered.length,
      paperCount: uniquePaperCount,
      facultyCount: facultySummary.length,
      totalRos
    },
    facultySummary,
    entries: filtered.map(p => ({
      id: p.id,
      faculty_id: p.faculty_id,
      faculty_name: p.faculty_name,
      faculty_code: p.faculty_code,
      faculty_designation: p.faculty_designation || '',
      pub_department: normalizePubDepartment(p.pub_department),
      title: p.title,
      source_title: p.source_title || '',
      document_type: p.document_type || 'Article',
      quartile: getEffectiveQuartile(p),
      ros: parseFloat((parseFloat(p.ros) || 0).toFixed(2)),
      month: p.month,
      apn: p.apn || '',
      link: p.link || '',
      eid: p.eid || ''
    }))
  };
}

function buildRankedPerformers(pubsSubset, facultyMap, limit = 25, mode = getPubCountingMode()) {
  const byFac = new Map();

  pubsSubset.forEach(p => {
    const f = facultyMap.get(p.faculty_id);
    if (!f) return;
    if (!byFac.has(f.id)) {
      byFac.set(f.id, {
        id: f.id,
        name: f.name,
        employee_code: f.employee_code,
        designation: f.designation || '',
        department: f.department || '',
        member_type: f.member_type || 'Faculty',
        photo: f.photo || null,
        pubs: []
      });
    }
    byFac.get(f.id).pubs.push(p);
  });

  const ranked = Array.from(byFac.values()).map(entry => {
    const qStats = computeQuartileStats(entry.pubs);
    const totalRos = parseFloat(entry.pubs.reduce((s, p) => s + (parseFloat(p.ros) || 0), 0).toFixed(2));
    return {
      id: entry.id,
      name: entry.name,
      employee_code: entry.employee_code,
      designation: entry.designation,
      department: entry.department,
      member_type: entry.member_type,
      photo: entry.photo,
      total_pubs: entry.pubs.length,
      ros: totalRos,
      ...qStats
    };
  });

  ranked.sort((a, b) => {
    const rosDiff = Math.round(b.ros * 10000) - Math.round(a.ros * 10000);
    if (rosDiff !== 0) return rosDiff;
    if (b.total_pubs !== a.total_pubs) return b.total_pubs - a.total_pubs;
    if (b.q1 !== a.q1) return b.q1 - a.q1;
    return a.name.localeCompare(b.name);
  });

  // Assign competition rank (ties on exact ROS share rank)
  let currentRank = 0;
  let lastRosScaled = null;
  ranked.forEach((item, idx) => {
    const scaled = Math.round(item.ros * 10000);
    if (scaled !== lastRosScaled) {
      currentRank = idx + 1;
      lastRosScaled = scaled;
    }
    item.rank = currentRank;
  });

  const periodStats = computeDepartmentQuartileStats(pubsSubset, mode);
  const winners = ranked.filter(item => item.rank === 1);

  return {
    total_pubs: periodStats.total,
    active_faculty: ranked.length,
    dept_ros: periodStats.ros,
    winners,
    winner: ranked.length > 0 ? ranked[0] : null,
    top: limit > 0 ? ranked.slice(0, limit) : ranked
  };
}

function getTopPerformersByYear(year = 2026, limit = 25, mode = getPubCountingMode()) {
  const y = parseInt(year, 10) || 2026;
  const facultyList = queryAll('SELECT id, name, employee_code, designation, department, photo FROM faculty');
  const facultyMap = new Map(facultyList.map(f => [f.id, f]));

  const allPubs = queryAll('SELECT id, faculty_id, title, eid, pub_type, ros, quartile, month FROM publications');
  const yearPubs = [];
  const byMonth = new Map();
  for (let m = 1; m <= 12; m++) byMonth.set(m, []);

  allPubs.forEach(p => {
    const parsed = parsePublicationYearMonth(p.month);
    if (parsed && parsed.year === y) {
      yearPubs.push({ ...p, _m: parsed.month });
      byMonth.get(parsed.month).push(p);
    }
  });

  const monthly = MONTH_DEFS.map(m => {
    const stats = buildRankedPerformers(byMonth.get(m.num), facultyMap, limit, mode);
    return {
      key: `${y}-${m.pad}`,
      monthNum: m.num,
      short: m.short,
      label: `${m.short} ${y}`,
      full: `${m.full} ${y}`,
      ...stats
    };
  });

  const quarterDefs = [
    { key: 'Q1', label: `Q1 ${y}`, range: `Jan – Mar ${y}`, months: [1, 2, 3] },
    { key: 'Q2', label: `Q2 ${y}`, range: `Apr – Jun ${y}`, months: [4, 5, 6] },
    { key: 'Q3', label: `Q3 ${y}`, range: `Jul – Sep ${y}`, months: [7, 8, 9] },
    { key: 'Q4', label: `Q4 ${y}`, range: `Oct – Dec ${y}`, months: [10, 11, 12] }
  ];
  const quarterly = quarterDefs.map(q => {
    const subset = yearPubs.filter(p => q.months.includes(p._m));
    const stats = buildRankedPerformers(subset, facultyMap, limit, mode);
    return { key: q.key, label: q.label, range: q.range, months: q.months, ...stats };
  });

  const halfDefs = [
    { key: 'H1', label: `H1 ${y} (First Half)`, range: `Jan – Jun ${y}`, months: [1, 2, 3, 4, 5, 6] },
    { key: 'H2', label: `H2 ${y} (Second Half)`, range: `Jul – Dec ${y}`, months: [7, 8, 9, 10, 11, 12] }
  ];
  const sixMonthly = halfDefs.map(h => {
    const subset = yearPubs.filter(p => h.months.includes(p._m));
    const stats = buildRankedPerformers(subset, facultyMap, limit, mode);
    return { key: h.key, label: h.label, range: h.range, months: h.months, ...stats };
  });

  const annualStats = buildRankedPerformers(yearPubs, facultyMap, limit, mode);
  const annual = {
    key: String(y),
    label: `Annual ${y}`,
    range: `Jan – Dec ${y}`,
    ...annualStats
  };

  // Pick smart defaults: latest period in the year that actually has publications
  const activeMonths = monthly.filter(m => m.total_pubs > 0);
  const defaultMonthKey = activeMonths.length > 0 ? activeMonths[activeMonths.length - 1].key : monthly[0].key;
  const activeQuarters = quarterly.filter(q => q.total_pubs > 0);
  const defaultQuarterKey = activeQuarters.length > 0 ? activeQuarters[activeQuarters.length - 1].key : 'Q1';
  const activeHalves = sixMonthly.filter(h => h.total_pubs > 0);
  const defaultHalfKey = activeHalves.length > 0 ? activeHalves[activeHalves.length - 1].key : 'H1';

  return {
    year: y,
    monthly,
    quarterly,
    sixMonthly,
    annual,
    defaults: {
      monthKey: defaultMonthKey,
      quarterKey: defaultQuarterKey,
      halfKey: defaultHalfKey
    }
  };
}

function getAllYearsTopPerformers(yearsList = [2024, 2025, 2026, 2027, 2028, 2029, 2030], limit = 20, mode = getPubCountingMode()) {
  const result = {};
  yearsList.forEach(y => {
    result[y] = getTopPerformersByYear(y, limit, mode);
  });
  return result;
}

function getAdminConfig() {
  return queryOne('SELECT id, username, session_secret, updated_at FROM admin_config WHERE id = 1');
}

function verifyAdminLogin(username, password) {
  const row = queryOne('SELECT * FROM admin_config WHERE id = 1');
  if (!row) return { ok: false };
  const u = String(username || '').trim().toLowerCase();
  if (u !== String(row.username).trim().toLowerCase()) return { ok: false };
  if (!verifyPassword(password, row.password_hash)) return { ok: false };
  return { ok: true, username: row.username };
}

function updateAdminCredentials(newUsername, newPassword) {
  const uname = String(newUsername || '').trim();
  if (!uname) throw new Error('Username cannot be empty.');
  const row = queryOne('SELECT * FROM admin_config WHERE id = 1');
  const passHash = (newPassword && String(newPassword).length > 0)
    ? hashPassword(newPassword)
    : row.password_hash;
  db.run(
    'UPDATE admin_config SET username = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1',
    [uname, passHash]
  );
  saveDB();
  return uname;
}

function seedMasterPublicationsFromExcel(excelPath = path.join(__dirname, 'public', 'downloads', 'Published_Paper_2026.xlsx')) {
  if (!db) return;
  const countRow = queryOne('SELECT COUNT(*) as c FROM master_publications');
  if (countRow && countRow.c > 0) return;

  let sourcePath = excelPath;
  if (!fs.existsSync(sourcePath)) {
    const fallbackPath = 'C:/Users/sachi/.gemini/antigravity/brain/6a9810d4-f537-4d26-9f66-fa00f61621c8/.user_uploaded/media_1794904047244_ee376e2c.xlsx';
    if (fs.existsSync(fallbackPath)) {
      const dir = path.dirname(excelPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(fallbackPath, excelPath);
      sourcePath = excelPath;
    } else {
      return;
    }
  }

  const xlsx = require('xlsx');
  const wb = xlsx.readFile(sourcePath);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, {header: 1, defval: ''});

  let curMonth = '';
  let order = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => String(c).trim() === '')) continue;
    const nonEmpties = r.filter(c => String(c).trim() !== '');
    if (nonEmpties.length === 1 && typeof r[0] === 'string' && isNaN(Number(r[0]))) {
      curMonth = String(r[0]).trim();
      continue;
    }

    order++;
    db.run(
      `INSERT INTO master_publications (
        row_order, month_section, sr_no, title, year, source_title,
        author_name, scopus_id, cluster, institute, department,
        ros, quartile, doi, link, document_type, eid, scopus_link, apn
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order,
        curMonth,
        r[0] !== undefined && r[0] !== null ? String(r[0]).trim() : '',
        r[1] !== undefined && r[1] !== null ? String(r[1]).trim() : '',
        r[2] !== undefined && r[2] !== null ? String(r[2]).trim() : '',
        r[3] !== undefined && r[3] !== null ? String(r[3]).trim() : '',
        r[4] !== undefined && r[4] !== null ? String(r[4]).trim() : '',
        r[5] !== undefined && r[5] !== null ? String(r[5]).trim() : '',
        r[6] !== undefined && r[6] !== null ? String(r[6]).trim() : '',
        r[7] !== undefined && r[7] !== null ? String(r[7]).trim() : '',
        r[8] !== undefined && r[8] !== null ? String(r[8]).trim() : '',
        r[9] !== undefined && r[9] !== null ? String(r[9]).trim() : '',
        r[10] !== undefined && r[10] !== null ? String(r[10]).trim() : '',
        r[11] !== undefined && r[11] !== null ? String(r[11]).trim() : '',
        r[12] !== undefined && r[12] !== null ? String(r[12]).trim() : '',
        r[13] !== undefined && r[13] !== null ? String(r[13]).trim() : '',
        r[14] !== undefined && r[14] !== null ? String(r[14]).trim() : '',
        r[15] !== undefined && r[15] !== null ? String(r[15]).trim() : '',
        r[16] !== undefined && r[16] !== null ? String(r[16]).trim() : ''
      ]
    );
  }
  saveDB();
}

function getMasterPublications(filters = {}) {
  let sql = 'SELECT * FROM master_publications WHERE 1=1';
  const params = [];

  if (filters.month && filters.month !== 'all') {
    sql += ' AND LOWER(month_section) = LOWER(?)';
    params.push(filters.month);
  }

  if (filters.quartile && filters.quartile !== 'all') {
    sql += ' AND UPPER(quartile) = UPPER(?)';
    params.push(filters.quartile);
  }

  if (filters.department && filters.department !== 'all') {
    if (filters.department.toLowerCase() === 'uic') {
      sql += " AND (UPPER(department) = 'UIC' OR UPPER(department) LIKE '%UIC%')";
    } else if (filters.department.toLowerCase() === 'other') {
      sql += " AND (UPPER(department) != 'UIC' AND UPPER(department) NOT LIKE '%UIC%')";
    } else {
      sql += ' AND LOWER(department) = LOWER(?)';
      params.push(filters.department);
    }
  }

  if (filters.document_type && filters.document_type !== 'all') {
    sql += ' AND LOWER(document_type) = LOWER(?)';
    params.push(filters.document_type);
  }

  if (filters.search) {
    const q = `%${filters.search.trim().toLowerCase()}%`;
    sql += ` AND (
      LOWER(title) LIKE ? OR
      LOWER(author_name) LIKE ? OR
      LOWER(source_title) LIKE ? OR
      LOWER(scopus_id) LIKE ? OR
      LOWER(doi) LIKE ? OR
      LOWER(apn) LIKE ? OR
      LOWER(eid) LIKE ? OR
      LOWER(department) LIKE ?
    )`;
    params.push(q, q, q, q, q, q, q, q);
  }

  sql += ' ORDER BY row_order ASC';
  return queryAll(sql, params);
}

function getMasterPublicationsStats() {
  const all = queryAll('SELECT * FROM master_publications ORDER BY row_order ASC');
  const totalRecords = all.length;
  const uniquePapers = all.filter(r => r.sr_no && r.sr_no.trim() !== '').length;

  let q1 = 0, q2 = 0, q3 = 0, q4 = 0;
  let uicCount = 0, otherCount = 0;
  const monthsMap = {};
  const deptsSet = new Set();
  const docTypesSet = new Set();

  all.forEach(r => {
    const q = (r.quartile || '').toUpperCase().trim();
    if (q === 'Q1') q1++;
    else if (q === 'Q2') q2++;
    else if (q === 'Q3') q3++;
    else if (q === 'Q4') q4++;

    const dept = (r.department || '').trim();
    if (dept) deptsSet.add(dept);
    if (/uic/i.test(dept)) uicCount++;
    else otherCount++;

    const m = (r.month_section || '').trim();
    if (m) {
      monthsMap[m] = (monthsMap[m] || 0) + 1;
    }

    const dt = (r.document_type || '').trim();
    if (dt && !dt.includes('http') && !dt.includes('/') && dt.length < 30) {
      docTypesSet.add(dt);
    }
  });

  return {
    totalRecords,
    uniquePapers,
    q1Count: q1,
    q2Count: q2,
    q3Count: q3,
    q4Count: q4,
    uicCount,
    otherCount,
    monthsMap,
    departments: Array.from(deptsSet).sort(),
    documentTypes: Array.from(docTypesSet).sort()
  };
}

function replaceMasterPublications(fileInput) {
  recordUndoState('Update Master Publications Excel');
  const xlsx = require('xlsx');
  let wb;
  if (Buffer.isBuffer(fileInput)) {
    wb = xlsx.read(fileInput, { type: 'buffer' });
  } else {
    wb = xlsx.readFile(fileInput);
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet, {header: 1, defval: ''});

  db.run('DELETE FROM master_publications');

  let curMonth = '';
  let order = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every(c => String(c).trim() === '')) continue;
    const nonEmpties = r.filter(c => String(c).trim() !== '');
    if (nonEmpties.length === 1 && typeof r[0] === 'string' && isNaN(Number(r[0]))) {
      curMonth = String(r[0]).trim();
      continue;
    }

    order++;
    db.run(
      `INSERT INTO master_publications (
        row_order, month_section, sr_no, title, year, source_title,
        author_name, scopus_id, cluster, institute, department,
        ros, quartile, doi, link, document_type, eid, scopus_link, apn
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order,
        curMonth,
        r[0] !== undefined && r[0] !== null ? String(r[0]).trim() : '',
        r[1] !== undefined && r[1] !== null ? String(r[1]).trim() : '',
        r[2] !== undefined && r[2] !== null ? String(r[2]).trim() : '',
        r[3] !== undefined && r[3] !== null ? String(r[3]).trim() : '',
        r[4] !== undefined && r[4] !== null ? String(r[4]).trim() : '',
        r[5] !== undefined && r[5] !== null ? String(r[5]).trim() : '',
        r[6] !== undefined && r[6] !== null ? String(r[6]).trim() : '',
        r[7] !== undefined && r[7] !== null ? String(r[7]).trim() : '',
        r[8] !== undefined && r[8] !== null ? String(r[8]).trim() : '',
        r[9] !== undefined && r[9] !== null ? String(r[9]).trim() : '',
        r[10] !== undefined && r[10] !== null ? String(r[10]).trim() : '',
        r[11] !== undefined && r[11] !== null ? String(r[11]).trim() : '',
        r[12] !== undefined && r[12] !== null ? String(r[12]).trim() : '',
        r[13] !== undefined && r[13] !== null ? String(r[13]).trim() : '',
        r[14] !== undefined && r[14] !== null ? String(r[14]).trim() : '',
        r[15] !== undefined && r[15] !== null ? String(r[15]).trim() : '',
        r[16] !== undefined && r[16] !== null ? String(r[16]).trim() : ''
      ]
    );
  }

  try {
    const dlPath = path.join(__dirname, 'public', 'downloads', 'Published_Paper_2026.xlsx');
    if (Buffer.isBuffer(fileInput)) {
      fs.writeFileSync(dlPath, fileInput);
    } else {
      fs.copyFileSync(fileInput, dlPath);
    }
  } catch (e) {
    console.error('Failed to update public download copy:', e.message);
  }

  saveDB();
  return order;
}

function updateMasterPublicationsMonth(monthName, newRows) {
  recordUndoState(`Update ${monthName} Master Publications`);

  // First delete rows for that month
  db.run('DELETE FROM master_publications WHERE LOWER(month_section) = LOWER(?)', [monthName]);

  newRows.forEach((r, idx) => {
    db.run(
      `INSERT INTO master_publications (
        row_order, month_section, sr_no, title, year, source_title,
        author_name, scopus_id, cluster, institute, department,
        ros, quartile, doi, link, document_type, eid, scopus_link, apn
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        r.row_order || (idx + 1),
        monthName,
        r.sr_no !== undefined && r.sr_no !== null ? String(r.sr_no).trim() : '',
        r.title !== undefined && r.title !== null ? String(r.title).trim() : '',
        r.year !== undefined && r.year !== null ? String(r.year).trim() : '',
        r.source_title !== undefined && r.source_title !== null ? String(r.source_title).trim() : '',
        r.author_name !== undefined && r.author_name !== null ? String(r.author_name).trim() : '',
        r.scopus_id !== undefined && r.scopus_id !== null ? String(r.scopus_id).trim() : '',
        r.cluster !== undefined && r.cluster !== null ? String(r.cluster).trim() : '',
        r.institute !== undefined && r.institute !== null ? String(r.institute).trim() : '',
        r.department !== undefined && r.department !== null ? String(r.department).trim() : '',
        r.ros !== undefined && r.ros !== null ? String(r.ros).trim() : '',
        r.quartile !== undefined && r.quartile !== null ? String(r.quartile).trim() : '',
        r.doi !== undefined && r.doi !== null ? String(r.doi).trim() : '',
        r.link !== undefined && r.link !== null ? String(r.link).trim() : '',
        r.document_type !== undefined && r.document_type !== null ? String(r.document_type).trim() : '',
        r.eid !== undefined && r.eid !== null ? String(r.eid).trim() : '',
        r.scopus_link !== undefined && r.scopus_link !== null ? String(r.scopus_link).trim() : '',
        r.apn !== undefined && r.apn !== null ? String(r.apn).trim() : ''
      ]
    );
  });

  // Re-generate and sync the Excel file in public/downloads/Published_Paper_2026.xlsx
  try {
    const allRows = getMasterPublications();
    const xlsx = require('xlsx');
    const exportData = [];
    exportData.push([
      'Sr. No.', 'Title', 'Year', 'Source title', 'Author names (CU)',
      'Scopus ID', 'Cluster', 'Institute', 'Department', 'ROS',
      'Source quartile (Q)', 'DOI', 'Link', 'Document Type',
      'EID', 'EID based Scopus Link', 'APN'
    ]);

    let lastMonth = '';
    allRows.forEach(row => {
      if (row.month_section && row.month_section !== lastMonth) {
        lastMonth = row.month_section;
        exportData.push([lastMonth]);
      }
      exportData.push([
        row.sr_no ? (isNaN(Number(row.sr_no)) ? row.sr_no : Number(row.sr_no)) : '',
        row.title,
        row.year ? (isNaN(Number(row.year)) ? row.year : Number(row.year)) : '',
        row.source_title,
        row.author_name,
        row.scopus_id ? (isNaN(Number(row.scopus_id)) ? row.scopus_id : Number(row.scopus_id)) : '',
        row.cluster,
        row.institute,
        row.department,
        row.ros ? (isNaN(Number(row.ros)) ? row.ros : Number(row.ros)) : '',
        row.quartile,
        row.doi,
        row.link,
        row.document_type,
        row.eid ? (isNaN(Number(row.eid)) ? row.eid : Number(row.eid)) : '',
        row.scopus_link,
        row.apn
      ]);
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(exportData);
    xlsx.utils.book_append_sheet(wb, ws, 'Published Paper 2026');
    const dlPath = path.join(__dirname, 'public', 'downloads', 'Published_Paper_2026.xlsx');
    xlsx.writeFile(wb, dlPath);
  } catch (e) {
    console.error('Failed to sync Published_Paper_2026.xlsx:', e.message);
  }

  saveDB();
  return newRows.length;
}

function syncMasterPublicationsToExcel() {
  try {
    const allRows = getMasterPublications();
    const xlsx = require('xlsx');
    const exportData = [];
    exportData.push([
      'Sr. No.', 'Title', 'Year', 'Source title', 'Author names (CU)',
      'Scopus ID', 'Cluster', 'Institute', 'Department', 'ROS',
      'Source quartile (Q)', 'DOI', 'Link', 'Document Type',
      'EID', 'EID based Scopus Link', 'APN'
    ]);

    let lastMonth = '';
    allRows.forEach(row => {
      if (row.month_section && row.month_section !== lastMonth) {
        lastMonth = row.month_section;
        exportData.push([lastMonth]);
      }
      exportData.push([
        row.sr_no ? (isNaN(Number(row.sr_no)) ? row.sr_no : Number(row.sr_no)) : '',
        row.title,
        row.year ? (isNaN(Number(row.year)) ? row.year : Number(row.year)) : '',
        row.source_title,
        row.author_name,
        row.scopus_id ? (isNaN(Number(row.scopus_id)) ? row.scopus_id : Number(row.scopus_id)) : '',
        row.cluster,
        row.institute,
        row.department,
        row.ros ? (isNaN(Number(row.ros)) ? row.ros : Number(row.ros)) : '',
        row.quartile,
        row.doi,
        row.link,
        row.document_type,
        row.eid ? (isNaN(Number(row.eid)) ? row.eid : Number(row.eid)) : '',
        row.scopus_link,
        row.apn
      ]);
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.aoa_to_sheet(exportData);
    xlsx.utils.book_append_sheet(wb, ws, 'Published Paper 2026');
    const dlPath = path.join(__dirname, 'public', 'downloads', 'Published_Paper_2026.xlsx');
    const dir = path.dirname(dlPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    xlsx.writeFile(wb, dlPath);
  } catch (e) {
    console.error('Failed to sync Published_Paper_2026.xlsx:', e.message);
  }
}

function getMasterPublicationById(id) {
  return queryOne('SELECT * FROM master_publications WHERE id = ?', [Number(id)]);
}

function updateMasterPublication(id, data) {
  const numId = Number(id);
  const existing = getMasterPublicationById(numId);
  if (!existing) throw new Error('Publication entry not found (id: ' + id + ')');
  recordUndoState(`Edit Publication #${existing.sr_no || existing.id} (${(existing.title || '').slice(0, 25)})`);

  const updatedSrNo = data.sr_no !== undefined ? String(data.sr_no).trim() : (existing.sr_no || '');
  const updatedTitle = data.title !== undefined ? String(data.title).trim() : (existing.title || '');
  const updatedYear = data.year !== undefined ? String(data.year).trim() : (existing.year || '');
  const updatedSourceTitle = data.source_title !== undefined ? String(data.source_title).trim() : (existing.source_title || '');
  const updatedAuthor = data.author_name !== undefined ? String(data.author_name).trim() : (existing.author_name || '');
  const updatedScopusId = data.scopus_id !== undefined ? String(data.scopus_id).trim() : (existing.scopus_id || '');
  const updatedCluster = data.cluster !== undefined ? String(data.cluster).trim() : (existing.cluster || 'Engineering');
  const updatedInstitute = data.institute !== undefined ? String(data.institute).trim() : (existing.institute || 'UIC');
  const updatedDepartment = data.department !== undefined ? String(data.department).trim() : (existing.department || 'UIC');
  const updatedRos = data.ros !== undefined ? String(data.ros).trim() : (existing.ros || '0');
  const updatedQuartile = data.quartile !== undefined ? String(data.quartile).trim() : (existing.quartile || 'Q1');
  const updatedDoi = data.doi !== undefined ? String(data.doi).trim() : (existing.doi || '');
  const updatedLink = data.link !== undefined ? String(data.link).trim() : (existing.link || '');
  const updatedDocType = data.document_type !== undefined ? String(data.document_type).trim() : (existing.document_type || 'Article');
  const updatedEid = data.eid !== undefined ? String(data.eid).trim() : (existing.eid || '');
  const updatedScopusLink = data.scopus_link !== undefined ? String(data.scopus_link).trim() : (existing.scopus_link || '');
  const updatedApn = data.apn !== undefined ? String(data.apn).trim() : (existing.apn || '');
  const updatedMonth = data.month_section !== undefined ? String(data.month_section).trim() : (existing.month_section || 'January');

  db.run(
    `UPDATE master_publications SET
      sr_no = ?, title = ?, year = ?, source_title = ?, author_name = ?,
      scopus_id = ?, cluster = ?, institute = ?, department = ?, ros = ?,
      quartile = ?, doi = ?, link = ?, document_type = ?, eid = ?,
      scopus_link = ?, apn = ?, month_section = ?
    WHERE id = ?`,
    [
      updatedSrNo, updatedTitle, updatedYear, updatedSourceTitle, updatedAuthor,
      updatedScopusId, updatedCluster, updatedInstitute, updatedDepartment, updatedRos,
      updatedQuartile, updatedDoi, updatedLink, updatedDocType, updatedEid,
      updatedScopusLink, updatedApn, updatedMonth,
      numId
    ]
  );

  // If this paper has co-author continuation rows right after it (sr_no is empty), update their title/source_title too
  if (updatedSrNo && updatedTitle) {
    try {
      const coAuthors = queryAll(
        'SELECT id, sr_no FROM master_publications WHERE row_order > ? ORDER BY row_order ASC',
        [existing.row_order]
      );
      for (const row of coAuthors) {
        if (row.sr_no && String(row.sr_no).trim() !== '') break;
        db.run('UPDATE master_publications SET title = ?, source_title = ?, year = ? WHERE id = ?', [
          updatedTitle,
          updatedSourceTitle,
          updatedYear,
          row.id
        ]);
      }
    } catch (e) {
      console.warn('Could not sync co-author rows:', e.message);
    }
  }

  syncMasterPublicationsToExcel();
  saveDB();
  return getMasterPublicationById(numId);
}

function deleteMasterPublication(id) {
  const existing = getMasterPublicationById(id);
  if (!existing) throw new Error('Publication entry not found');
  recordUndoState(`Delete Publication #${existing.sr_no || existing.id} (${(existing.title || '').slice(0, 25)})`);
  db.run('DELETE FROM master_publications WHERE id = ?', [Number(id)]);
  syncMasterPublicationsToExcel();
  saveDB();
  return existing;
}

function deleteMasterPublicationsMultiple(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const cleanIds = ids.map(Number).filter(n => !isNaN(n) && n > 0);
  if (cleanIds.length === 0) return 0;
  recordUndoState(`Delete ${cleanIds.length} Publications`);
  const placeholders = cleanIds.map(() => '?').join(',');
  db.run(`DELETE FROM master_publications WHERE id IN (${placeholders})`, cleanIds);
  syncMasterPublicationsToExcel();
  saveDB();
  return cleanIds.length;
}

function addMasterPublication(data) {
  recordUndoState(`Add Publication: ${(data.title || '').slice(0, 25)}`);
  const maxOrderRow = queryOne('SELECT MAX(row_order) as m FROM master_publications');
  const nextOrder = (maxOrderRow && maxOrderRow.m ? maxOrderRow.m : 0) + 1;
  db.run(
    `INSERT INTO master_publications (
      row_order, month_section, sr_no, title, year, source_title,
      author_name, scopus_id, cluster, institute, department,
      ros, quartile, doi, link, document_type, eid, scopus_link, apn
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      nextOrder,
      String(data.month_section || 'January').trim(),
      String(data.sr_no || '').trim(),
      String(data.title || '').trim(),
      String(data.year || '2026').trim(),
      String(data.source_title || '').trim(),
      String(data.author_name || '').trim(),
      String(data.scopus_id || '').trim(),
      String(data.cluster || 'Engineering').trim(),
      String(data.institute || 'UIC').trim(),
      String(data.department || 'UIC').trim(),
      String(data.ros || '1').trim(),
      String(data.quartile || 'Q1').trim(),
      String(data.doi || '').trim(),
      String(data.link || '').trim(),
      String(data.document_type || 'Article').trim(),
      String(data.eid || '').trim(),
      String(data.scopus_link || '').trim(),
      String(data.apn || '').trim()
    ]
  );
  syncMasterPublicationsToExcel();
  saveDB();
  const lastId = queryOne('SELECT last_insert_rowid() as id');
  return lastId ? lastId.id : null;
}

// ─── UPCOMING CONFERENCES ──────────────────────────────────────────
function seedConferencesIfEmpty() {
  if (!db) return;
  const countRow = queryOne('SELECT COUNT(*) as c FROM upcoming_conferences');
  if (countRow && countRow.c > 0) return;

  const seeds = [
    {
      title: "2026 IEEE International Conference on Computing, Communication and Automation",
      acronym: "IEEE ICCCA 2026",
      organizer: "IEEE & Chandigarh University",
      venue: "Chandigarh University, Mohali (Hybrid)",
      conference_date: "18-20 December 2026",
      submission_deadline: "30 October 2026",
      notification_date: "15 November 2026",
      indexing: "IEEE Xplore, Scopus, Web of Science",
      website_url: "https://ieee.org",
      cfp_link: "https://easychair.org",
      description: "Premier international forum for academic and industrial researchers in Artificial Intelligence, Cloud Systems, Autonomous Computing, and Next-Gen Cyber Defense.",
      status: "Call for Papers Open"
    },
    {
      title: "16th International Conference on Advances in Computing, Control, and Telecommunication Technologies",
      acronym: "ACT 2026",
      organizer: "ACEEE & Springer Nature",
      venue: "New Delhi / Hybrid",
      conference_date: "22-24 January 2027",
      submission_deadline: "10 December 2026",
      notification_date: "28 December 2026",
      indexing: "Scopus, Springer CCIS / LNCS",
      website_url: "https://springer.com",
      cfp_link: "https://cmt3.research.microsoft.com",
      description: "Covering advanced algorithms in Machine Learning, 6G communications, edge robotics, and intelligent software engineering.",
      status: "Call for Papers Open"
    },
    {
      title: "2027 International Conference on Intelligent and Secure Engineering Solutions",
      acronym: "IEEE CISES 2027",
      organizer: "IEEE Computer Society",
      venue: "Chandigarh, India",
      conference_date: "12-14 February 2027",
      submission_deadline: "15 December 2026",
      notification_date: "10 January 2027",
      indexing: "IEEE Xplore, Scopus Indexed",
      website_url: "https://ieee.org",
      cfp_link: "https://easychair.org",
      description: "Focuses on trustworthy AI, zero-trust architectures, quantum cryptography, and resilient socio-technical frameworks.",
      status: "Upcoming"
    },
    {
      title: "14th International Conference on Computing for Sustainable Global Development",
      acronym: "INDIACom 2027",
      organizer: "BVICAM & IEEE Delhi Section",
      venue: "Bharati Vidyapeeth, New Delhi",
      conference_date: "11-13 March 2027",
      submission_deadline: "15 January 2027",
      notification_date: "05 February 2027",
      indexing: "IEEE Xplore, Scopus, WoS",
      website_url: "https://bvicam.ac.in/indiacom",
      cfp_link: "https://bvicam.ac.in/indiacom",
      description: "High-visibility conference bridging computing technologies with UN Sustainable Development Goals (SDGs), Green AI, and Smart Cities.",
      status: "Upcoming"
    }
  ];

  seeds.forEach(s => {
    db.run(
      `INSERT INTO upcoming_conferences (
        title, acronym, organizer, venue, conference_date,
        submission_deadline, notification_date, indexing,
        website_url, cfp_link, description, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        s.title, s.acronym, s.organizer, s.venue, s.conference_date,
        s.submission_deadline, s.notification_date, s.indexing,
        s.website_url, s.cfp_link, s.description, s.status
      ]
    );
  });
  saveDB();
}

function getAllConferences(filters = {}) {
  let sql = 'SELECT * FROM upcoming_conferences WHERE 1=1';
  const params = [];

  if (filters.search) {
    const q = `%${filters.search.trim().toLowerCase()}%`;
    sql += ' AND (LOWER(title) LIKE ? OR LOWER(acronym) LIKE ? OR LOWER(organizer) LIKE ? OR LOWER(venue) LIKE ? OR LOWER(indexing) LIKE ? OR LOWER(description) LIKE ?)';
    params.push(q, q, q, q, q, q);
  }

  if (filters.status && filters.status !== 'all') {
    sql += ' AND LOWER(status) = LOWER(?)';
    params.push(filters.status);
  }

  if (filters.indexing && filters.indexing !== 'all') {
    sql += ' AND LOWER(indexing) LIKE ?';
    params.push(`%${filters.indexing.toLowerCase()}%`);
  }

  sql += ' ORDER BY id DESC';
  return queryAll(sql, params);
}

function getConferenceById(id) {
  return queryOne('SELECT * FROM upcoming_conferences WHERE id = ?', [Number(id)]);
}

function addConference(data) {
  recordUndoState(`Add Conference: ${(data.title || '').slice(0, 25)}`);
  db.run(
    `INSERT INTO upcoming_conferences (
      title, acronym, organizer, venue, conference_date,
      submission_deadline, notification_date, indexing,
      website_url, cfp_link, description, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(data.title || '').trim(),
      String(data.acronym || '').trim(),
      String(data.organizer || '').trim(),
      String(data.venue || '').trim(),
      String(data.conference_date || '').trim(),
      String(data.submission_deadline || '').trim(),
      String(data.notification_date || '').trim(),
      String(data.indexing || 'Scopus').trim(),
      String(data.website_url || '').trim(),
      String(data.cfp_link || '').trim(),
      String(data.description || '').trim(),
      String(data.status || 'Upcoming').trim()
    ]
  );
  saveDB();
  const last = queryOne('SELECT last_insert_rowid() as id');
  return last ? last.id : null;
}

function updateConference(id, data) {
  const existing = getConferenceById(id);
  if (!existing) throw new Error('Conference not found');
  recordUndoState(`Edit Conference: ${(existing.title || '').slice(0, 25)}`);
  db.run(
    `UPDATE upcoming_conferences SET
      title = ?, acronym = ?, organizer = ?, venue = ?, conference_date = ?,
      submission_deadline = ?, notification_date = ?, indexing = ?,
      website_url = ?, cfp_link = ?, description = ?, status = ?
    WHERE id = ?`,
    [
      data.title !== undefined ? String(data.title).trim() : existing.title,
      data.acronym !== undefined ? String(data.acronym).trim() : existing.acronym,
      data.organizer !== undefined ? String(data.organizer).trim() : existing.organizer,
      data.venue !== undefined ? String(data.venue).trim() : existing.venue,
      data.conference_date !== undefined ? String(data.conference_date).trim() : existing.conference_date,
      data.submission_deadline !== undefined ? String(data.submission_deadline).trim() : existing.submission_deadline,
      data.notification_date !== undefined ? String(data.notification_date).trim() : existing.notification_date,
      data.indexing !== undefined ? String(data.indexing).trim() : existing.indexing,
      data.website_url !== undefined ? String(data.website_url).trim() : existing.website_url,
      data.cfp_link !== undefined ? String(data.cfp_link).trim() : existing.cfp_link,
      data.description !== undefined ? String(data.description).trim() : existing.description,
      data.status !== undefined ? String(data.status).trim() : existing.status,
      Number(id)
    ]
  );
  saveDB();
  return getConferenceById(id);
}

function deleteConference(id) {
  const existing = getConferenceById(id);
  if (!existing) throw new Error('Conference not found');
  recordUndoState(`Delete Conference: ${(existing.title || '').slice(0, 25)}`);
  db.run('DELETE FROM upcoming_conferences WHERE id = ?', [Number(id)]);
  saveDB();
  return existing;
}

function deleteConferencesMultiple(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return 0;
  const cleanIds = ids.map(Number).filter(n => !isNaN(n) && n > 0);
  if (cleanIds.length === 0) return 0;
  recordUndoState(`Delete ${cleanIds.length} Conferences`);
  const placeholders = cleanIds.map(() => '?').join(',');
  db.run(`DELETE FROM upcoming_conferences WHERE id IN (${placeholders})`, cleanIds);
  saveDB();
  return cleanIds.length;
}

function getConferenceStats() {
  const all = queryAll('SELECT * FROM upcoming_conferences');
  const total = all.length;
  let scopusCount = 0;
  let openCfpCount = 0;
  all.forEach(c => {
    if (/scopus/i.test(c.indexing || '')) scopusCount++;
    if (/open/i.test(c.status || '') || /extended/i.test(c.status || '')) openCfpCount++;
  });
  return {
    total,
    scopusCount,
    openCfpCount
  };
}

module.exports = {
  initDB,
  getAdminConfig,
  verifyAdminLogin,
  updateAdminCredentials,
  recordUndoState,
  undoAction,
  redoAction,
  getHistoryStatus,
  getPubCountingMode,
  setPubCountingMode,
  normalizePubDepartment,
  isUicDepartment,
  normalizeMemberType,
  normalizeMemberStatus,
  getMemberBifurcationStats,
  getDepartmentPublicationOverview,
  getAllFacultyWithStats,
  getDepartmentMonthlyROS,
  getAllYearsMonthlyROS,
  getAllYearsSplitDepartmentROS,
  getDepartmentMonthlyROS2026,
  getRosCellDetails,
  getTopPerformersByYear,
  getAllYearsTopPerformers,
  getFacultyById,
  getFacultyByEmployeeCode,
  findFacultyByName,
  findDuplicateFaculty,
  analyzeFacultyUpload,
  applyFacultyUpload,
  addFaculty,
  addFacultyBulk,
  updateFaculty,
  deleteFaculty,
  deleteFacultyMultiple,
  deleteAllFaculty,
  addPublication,
  addPublicationsBulk,
  findDuplicatePublication,
  analyzePublicationsUpload,
  applyPublicationsUpload,
  updatePublication,
  deletePublication,
  getPublicationById,
  deletePublicationsMultiple,
  seedIfEmpty,
  seedMasterPublicationsFromExcel,
  getMasterPublications,
  getMasterPublicationsStats,
  replaceMasterPublications,
  updateMasterPublicationsMonth,
  syncMasterPublicationsToExcel,
  getMasterPublicationById,
  updateMasterPublication,
  deleteMasterPublication,
  deleteMasterPublicationsMultiple,
  addMasterPublication,
  seedConferencesIfEmpty,
  getAllConferences,
  getConferenceById,
  addConference,
  updateConference,
  deleteConference,
  deleteConferencesMultiple,
  getConferenceStats,
  addFacultyDocument,
  getFacultyDocuments,
  getAllFacultyDocuments,
  deleteFacultyDocument,
  markDocumentReviewed,
  getUnreadDocumentCount,
  setFacultyVisibility,
  addProfileRequest,
  getPendingProfileRequestsCount,
  getPendingRequestForFaculty,
  getAllProfileRequests,
  getProfileRequestStats,
  decideProfileRequest,
  deleteProfileRequest
};

// ─── FACULTY DOCUMENTS FUNCTIONS ────────────────────────────────────────────

function addFacultyDocument(facultyId, data) {
  const faculty = queryOne('SELECT id, name FROM faculty WHERE id = ?', [Number(facultyId)]);
  if (!faculty) throw new Error('Faculty not found');
  db.run(
    `INSERT INTO faculty_documents
      (faculty_id, faculty_name, uploader_type, original_name, stored_filename,
       file_type, file_size, description, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      Number(facultyId),
      data.faculty_name || faculty.name,
      data.uploader_type || 'faculty',
      String(data.original_name || '').trim(),
      String(data.stored_filename || '').trim(),
      String(data.file_type || 'pdf').trim(),
      Number(data.file_size || 0),
      String(data.description || '').trim()
    ]
  );
  saveDB();
  return queryOne('SELECT * FROM faculty_documents WHERE stored_filename = ? AND faculty_id = ?',
    [data.stored_filename, Number(facultyId)]);
}

function getFacultyDocuments(facultyId) {
  return queryAll(
    'SELECT * FROM faculty_documents WHERE faculty_id = ? ORDER BY uploaded_at DESC',
    [Number(facultyId)]
  );
}

function getAllFacultyDocuments(filters = {}) {
  let sql = `
    SELECT d.*, f.designation, f.department
    FROM faculty_documents d
    LEFT JOIN faculty f ON f.id = d.faculty_id
    WHERE 1=1
  `;
  const params = [];

  if (filters.status && filters.status !== 'all') {
    sql += ' AND d.status = ?';
    params.push(filters.status);
  }
  if (filters.search) {
    sql += ' AND (LOWER(d.faculty_name) LIKE ? OR LOWER(d.original_name) LIKE ? OR LOWER(d.description) LIKE ?)';
    const s = '%' + filters.search.toLowerCase() + '%';
    params.push(s, s, s);
  }
  if (filters.uploader_type && filters.uploader_type !== 'all') {
    sql += ' AND d.uploader_type = ?';
    params.push(filters.uploader_type);
  }

  sql += ' ORDER BY d.uploaded_at DESC';
  return queryAll(sql, params);
}

function deleteFacultyDocument(id) {
  const doc = queryOne('SELECT * FROM faculty_documents WHERE id = ?', [Number(id)]);
  if (!doc) throw new Error('Document not found');
  db.run('DELETE FROM faculty_documents WHERE id = ?', [Number(id)]);
  saveDB();
  return doc;
}

function markDocumentReviewed(id) {
  const doc = queryOne('SELECT * FROM faculty_documents WHERE id = ?', [Number(id)]);
  if (!doc) throw new Error('Document not found');
  db.run("UPDATE faculty_documents SET status = 'reviewed' WHERE id = ?", [Number(id)]);
  saveDB();
  return queryOne('SELECT * FROM faculty_documents WHERE id = ?', [Number(id)]);
}

function getUnreadDocumentCount() {
  const row = queryOne("SELECT COUNT(*) as c FROM faculty_documents WHERE status = 'pending'");
  return row ? row.c : 0;
}

// ─── PROFILE PUBLIC REQUESTS FUNCTIONS ───────────────────────────────────────

function addProfileRequest(data) {
  const facultyId = Number(data.faculty_id);
  const faculty = queryOne('SELECT id, name, employee_code FROM faculty WHERE id = ?', [facultyId]);
  const facultyName = faculty ? faculty.name : (data.faculty_name || '');
  const employeeCode = faculty ? faculty.employee_code : (data.employee_code || '');
  const email = String(data.requester_email || '').trim();
  const message = String(data.message || '').trim();

  // If there is already a pending request for this faculty, update it
  const existingPending = queryOne(
    "SELECT id FROM profile_requests WHERE faculty_id = ? AND status = 'pending'",
    [facultyId]
  );
  if (existingPending) {
    db.run(
      "UPDATE profile_requests SET requester_email = ?, message = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?",
      [email, message, existingPending.id]
    );
    saveDB();
    return queryOne('SELECT * FROM profile_requests WHERE id = ?', [existingPending.id]);
  }

  db.run(`
    INSERT INTO profile_requests (faculty_id, faculty_name, employee_code, requester_email, message, status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `, [facultyId, facultyName, employeeCode, email, message]);
  saveDB();

  return queryOne('SELECT * FROM profile_requests WHERE id = last_insert_rowid()');
}

function getPendingProfileRequestsCount() {
  const row = queryOne("SELECT COUNT(*) as c FROM profile_requests WHERE status = 'pending'");
  return row ? (row.c || 0) : 0;
}

function getPendingRequestForFaculty(facultyId) {
  return queryOne(
    "SELECT * FROM profile_requests WHERE faculty_id = ? AND status = 'pending' ORDER BY created_at DESC",
    [Number(facultyId)]
  );
}

function getAllProfileRequests(filters = {}) {
  let sql = 'SELECT * FROM profile_requests WHERE 1=1';
  const params = [];

  if (filters.status && filters.status !== 'all') {
    sql += ' AND status = ?';
    params.push(filters.status);
  }

  if (filters.search && filters.search.trim()) {
    const s = `%${filters.search.trim().toLowerCase()}%`;
    sql += ' AND (LOWER(faculty_name) LIKE ? OR LOWER(employee_code) LIKE ? OR LOWER(requester_email) LIKE ? OR LOWER(message) LIKE ?)';
    params.push(s, s, s, s);
  }

  sql += ' ORDER BY created_at DESC';
  return queryAll(sql, params);
}

function getProfileRequestStats() {
  const all = queryAll('SELECT status FROM profile_requests');
  return {
    total: all.length,
    pending: all.filter(r => r.status === 'pending').length,
    approved: all.filter(r => r.status === 'approved').length,
    rejected: all.filter(r => r.status === 'rejected').length
  };
}

function decideProfileRequest(id, action, adminNote = '') {
  const req = queryOne('SELECT * FROM profile_requests WHERE id = ?', [Number(id)]);
  if (!req) throw new Error('Request not found');

  recordUndoState(`${action === 'approve' ? 'Approved' : 'Rejected'} Profile Request #${id}`);
  const status = action === 'approve' ? 'approved' : 'rejected';
  db.run(
    'UPDATE profile_requests SET status = ?, admin_note = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?',
    [status, String(adminNote || '').trim(), Number(id)]
  );

  if (action === 'approve') {
    db.run("UPDATE faculty SET visibility = 'public' WHERE id = ?", [req.faculty_id]);
  }

  saveDB();
  return queryOne('SELECT * FROM profile_requests WHERE id = ?', [Number(id)]);
}

function deleteProfileRequest(id) {
  recordUndoState(`Deleted Profile Request #${id}`);
  db.run('DELETE FROM profile_requests WHERE id = ?', [Number(id)]);
  saveDB();
}
