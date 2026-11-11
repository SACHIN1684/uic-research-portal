const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'research_portal.db');

let db = null;
let isBrandNewDB = false;

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

  saveDB();
  return db;
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
  const allPubs = queryAll('SELECT id, pub_type, quartile, ros, title, eid FROM publications');
  const stats = computeDepartmentQuartileStats(allPubs, mode);
  return {
    totalPubs: stats.total,
    q1Count: stats.q1
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

  return {
    ...f,
    publications: pubs,
    month_wise: monthWise,
    total_pubs: pubs.length,
    journal_count: journalCount,
    conf_count: confCount,
    book_count: bookCount,
    patent_count: patentCount,
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
    if (dup) {
      duplicateRows.push({
        incoming: {
          name,
          employee_code: code,
          designation: (row.designation || '').trim(),
          department: (row.department || '').trim()
        },
        existing: {
          id: dup.existing.id,
          name: dup.existing.name,
          employee_code: dup.existing.employee_code,
          designation: dup.existing.designation,
          department: dup.existing.department
        },
        matchReason: dup.matchReason
      });
    } else {
      newRows.push({
        name,
        employee_code: code,
        designation: (row.designation || '').trim(),
        department: (row.department || '').trim()
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
  db.run(`
    INSERT INTO faculty (name, employee_code, designation, department, photo)
    VALUES (?, ?, ?, ?, ?)
  `, [
    data.name.trim(), data.employee_code.trim(), data.designation || '', data.department || '',
    data.photo || null
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
      department: (row.department || '').trim()
    });
    addedCount++;
  }

  saveDB();
  return { addedCount, skippedCount, errors };
}

function updateFaculty(id, data) {
  const existing = getFacultyById(id);
  const photo = data.photo || (existing ? existing.photo : null);
  db.run(`
    UPDATE faculty SET
      name = ?, employee_code = ?, designation = ?, department = ?, photo = ?
    WHERE id = ?
  `, [
    data.name.trim(), data.employee_code.trim(), (data.designation || '').trim(), (data.department || '').trim(),
    photo, id
  ]);
  saveDB();
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
  db.run(`
    INSERT INTO publications (faculty_id, pub_type, document_type, title, source_title, author_name, ros, quartile, link, apn, scopus_link, eid, month)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    data.month || new Date().toISOString().substring(0, 7)
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
      month = ?
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

function getDepartmentMonthlyROS(year = 2026, mode = getPubCountingMode()) {
  const y = parseInt(year, 10) || 2026;
  const allPubs = queryAll('SELECT * FROM publications');

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

  // For full-year totals in 'unique' mode, deduplicate across the year cleanly if a paper spans entries,
  // otherwise match sum of monthly deduplicated rows (both are identical for same-month co-authors)
  const yearPubs = allPubs.filter(p => {
    const parsed = parsePublicationYearMonth(p.month);
    return parsed && parsed.year === y;
  });
  const yearStats = computeDepartmentQuartileStats(yearPubs, mode);

  const totals = {
    q1: yearStats.q1,
    q2: yearStats.q2,
    q3: yearStats.q3,
    q4: yearStats.q4,
    q1_ros: parseFloat(rows.reduce((s, r) => s + r.q1_ros, 0).toFixed(2)),
    q2_ros: parseFloat(rows.reduce((s, r) => s + r.q2_ros, 0).toFixed(2)),
    q3_ros: parseFloat(rows.reduce((s, r) => s + r.q3_ros, 0).toFixed(2)),
    q4_ros: parseFloat(rows.reduce((s, r) => s + r.q4_ros, 0).toFixed(2)),
    total: yearStats.total,
    ros: parseFloat(rows.reduce((s, r) => s + r.ros, 0).toFixed(2))
  };

  return { year: y, mode, rows, totals };
}

function getAllYearsMonthlyROS(yearsList = [2024, 2025, 2026, 2027, 2028, 2029, 2030], mode = getPubCountingMode()) {
  const result = {};
  yearsList.forEach(y => {
    result[y] = getDepartmentMonthlyROS(y, mode);
  });
  return result;
}

function getDepartmentMonthlyROS2026() {
  return getDepartmentMonthlyROS(2026);
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

module.exports = {
  initDB,
  getAdminConfig,
  verifyAdminLogin,
  updateAdminCredentials,
  getPubCountingMode,
  setPubCountingMode,
  getDepartmentPublicationOverview,
  getAllFacultyWithStats,
  getDepartmentMonthlyROS,
  getAllYearsMonthlyROS,
  getDepartmentMonthlyROS2026,
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
  seedIfEmpty
};
