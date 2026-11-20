const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Body parsing
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));

// ─── ADMIN AUTH & SESSION HELPERS ───────────────────────────────────
function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach(cookie => {
    const idx = cookie.indexOf('=');
    if (idx > 0) {
      const name = cookie.slice(0, idx).trim();
      try {
        list[name] = decodeURIComponent(cookie.slice(idx + 1).trim());
      } catch {
        list[name] = cookie.slice(idx + 1).trim();
      }
    }
  });
  return list;
}

function signSessionToken(username, secret) {
  const exp = Date.now() + 12 * 60 * 60 * 1000; // 12 hours
  const payload = Buffer.from(JSON.stringify({ u: username, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token, secret, expectedUsername) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.exp || Date.now() > data.exp) return null;
    if (expectedUsername && data.u !== expectedUsername) return null;
    return data;
  } catch {
    return null;
  }
}

function getSafeRedirectTarget(target, fallback = '/') {
  if (typeof target === 'string' && target.startsWith('/') && !target.startsWith('//')) {
    return target;
  }
  return fallback;
}

// Attach isAdmin & adminUsername to every request/template
app.use((req, res, next) => {
  const cookies = parseCookies(req);
  const adminCfg = db.getAdminConfig();
  const tokenData = adminCfg
    ? verifySessionToken(cookies.uic_admin_session, adminCfg.session_secret, adminCfg.username)
    : null;
  req.isAdmin = !!tokenData;
  req.adminUsername = tokenData ? tokenData.u : null;
  res.locals.isAdmin = req.isAdmin;
  res.locals.adminUsername = req.adminUsername;
  res.locals.historyStatus = req.isAdmin
    ? db.getHistoryStatus()
    : { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0, undoLabel: '', redoLabel: '' };
  res.locals.pendingDocCount = req.isAdmin ? db.getUnreadDocumentCount() : 0;
  res.locals.pendingProfileReqCount = req.isAdmin ? db.getPendingProfileRequestsCount() : 0;
  res.locals.rosColor = rosColor;
  res.locals.rosLabel = rosLabel;
  res.locals.getStarRating = getStarRating;
  res.locals.renderStarsHtml = renderStarsHtml;
  res.locals.getMemberTypeTheme = getMemberTypeTheme;
  next();
});

// In-memory store for detailed Pending / Unmatched Faculty reports from Master Excel uploads
const pendingMasterUploads = new Map();
function savePendingMasterReport(report) {
  const id = 'pend_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  pendingMasterUploads.set(id, { id, createdAt: new Date().toISOString(), ...report });
  if (pendingMasterUploads.size > 20) {
    const oldestKey = pendingMasterUploads.keys().next().value;
    pendingMasterUploads.delete(oldestKey);
  }
  return id;
}

// Middleware guarding all editing/adding/uploading/deleting routes
function requireAdmin(req, res, next) {
  if (req.isAdmin) return next();
  if (req.method === 'GET') {
    return res.redirect('/?admin_login_required=1');
  }
  return res.status(403).send(`
    <!DOCTYPE html>
    <html lang="en"><head><meta charset="UTF-8"><title>Admin Access Required</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet"></head>
    <body class="bg-light d-flex align-items-center justify-content-center" style="min-height:100vh;">
      <div class="card shadow p-4 text-center" style="max-width:460px;">
        <h4 class="text-danger fw-bold mb-2">Admin Access Required</h4>
        <p class="text-muted small mb-3">Adding, editing, uploading, or deleting faculty &amp; publication records is restricted to Admin only. Visitors have read-only viewing access.</p>
        <div class="d-flex justify-content-center gap-2">
          <a href="/?admin_login_required=1" class="btn btn-primary btn-sm">Admin Login (Home)</a>
          <a href="/portal" class="btn btn-outline-secondary btn-sm">Back to Directory</a>
        </div>
      </div>
    </body></html>
  `);
}

// Multer storage
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }
});

// Multer for research proof documents (PDF / DOCX only)
const docUploadDir = path.join(__dirname, 'uploads', 'documents');
if (!fs.existsSync(docUploadDir)) fs.mkdirSync(docUploadDir, { recursive: true });

const docStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, docUploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + ext);
  }
});
const uploadDoc = multer({
  storage: docStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error('Only PDF, DOC, or DOCX files are allowed'));
  }
});

// Helper for Document Type → Publication Category
function resolvePubTypeFromDocType(docTypeRaw) {
  const dt = String(docTypeRaw || '').toLowerCase().trim();
  if (dt.includes('article') || dt.includes('review') || dt.includes('journal') || dt.includes('letter') || dt.includes('note') || dt.includes('short survey')) {
    return 'Journal';
  }
  if (dt.includes('conference') || dt.includes('proceedings')) {
    return 'Conference';
  }
  if (dt.includes('book chapter') || dt.includes('chapter') || dt.includes('book')) {
    return 'Book Chapter';
  }
  if (dt.includes('patent')) {
    return 'Patent';
  }
  return 'Journal';
}

function normalizeDocType(docTypeRaw) {
  const dt = String(docTypeRaw || '').trim();
  if (!dt) return 'Article';
  const lower = dt.toLowerCase();
  if (lower.includes('review')) return 'Review';
  if (lower.includes('conference')) return 'Conference Paper';
  if (lower.includes('chapter')) return 'Book Chapter';
  if (lower.includes('patent')) return 'Patent';
  if (lower.includes('article')) return 'Article';
  return dt;
}

function normalizeQuartileForPubType(quartRaw, pubType) {
  const quart = String(quartRaw || 'N/A').trim().toUpperCase();
  if (pubType === 'Conference') {
    return ['Q1', 'Q2', 'Q3', 'Q4'].includes(quart) ? quart : 'Q4';
  }
  return ['Q1', 'Q2', 'Q3', 'Q4'].includes(quart) ? quart : 'N/A';
}

// Helper to parse date / month
function parseMonthFromAPN(apn, fallbackMonth) {
  if (fallbackMonth && fallbackMonth.length >= 7) return fallbackMonth.substring(0, 7);
  if (!apn) return new Date().toISOString().substring(0, 7);

  const parts = String(apn).split(/[\/\-\s]+/);
  const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
  let foundYear = parts.find(p => p.length === 4 && !isNaN(p));
  let foundMonth = parts.find(p => months[p.toLowerCase().substring(0, 3)]);
  if (foundYear && foundMonth) {
    return `${foundYear}-${months[foundMonth.toLowerCase().substring(0, 3)]}`;
  }
  return new Date().toISOString().substring(0, 7);
}

// Helpers
function rosColor(ros) {
  if (ros <= 0) return 'danger';
  if (ros < 0.3) return 'warning';
  if (ros < 0.6) return 'info';
  return 'success';
}

function rosLabel(ros) {
  if (ros <= 0) return 'Zero / No Publications';
  if (ros < 0.3) return 'Low';
  if (ros < 0.6) return 'Moderate';
  if (ros < 0.8) return 'Good';
  return 'High Output';
}

// ── Star Rating based on ROS (Out of 5 Stars) ──
function getStarRating(ros) {
  const r = parseFloat(ros) || 0;
  if (r >= 1.5) return { stars: 5.0, full: 5, half: 0, empty: 0, label: '5.0 / 5.0', text: '5.0' };
  if (r >= 1.0) return { stars: 4.5, full: 4, half: 1, empty: 0, label: '4.5 / 5.0', text: '4.5' };
  if (r >= 0.7) return { stars: 4.0, full: 4, half: 0, empty: 1, label: '4.0 / 5.0', text: '4.0' };
  if (r >= 0.5) return { stars: 3.5, full: 3, half: 1, empty: 1, label: '3.5 / 5.0', text: '3.5' };
  if (r >= 0.3) return { stars: 3.0, full: 3, half: 0, empty: 2, label: '3.0 / 5.0', text: '3.0' };
  if (r >= 0.2) return { stars: 2.5, full: 2, half: 1, empty: 2, label: '2.5 / 5.0', text: '2.5' };
  if (r >= 0.1) return { stars: 2.0, full: 2, half: 0, empty: 3, label: '2.0 / 5.0', text: '2.0' };
  if (r > 0)    return { stars: 1.0, full: 1, half: 0, empty: 4, label: '1.0 / 5.0', text: '1.0' };
  return { stars: 0.0, full: 0, half: 0, empty: 5, label: '0.0 / 5.0', text: '0.0' };
}

function renderStarsHtml(ros, size = 'sm') {
  const rating = getStarRating(ros);
  let starsHtml = '';
  for (let i = 0; i < rating.full; i++) {
    starsHtml += '<i class="fas fa-star" style="color: #f59e0b;"></i>';
  }
  if (rating.half > 0) {
    starsHtml += '<i class="fas fa-star-half-alt" style="color: #f59e0b;"></i>';
  }
  for (let i = 0; i < rating.empty; i++) {
    starsHtml += '<i class="far fa-star" style="color: #cbd5e1;"></i>';
  }
  const fsStyle = size === 'lg' ? 'font-size: 1.05rem;' : (size === 'md' ? 'font-size: 0.88rem;' : 'font-size: 0.75rem;');
  return `
    <span class="star-rating d-inline-flex align-items-center gap-1" style="${fsStyle}" title="Research Rating: ${rating.label} based on ROS (${parseFloat(ros || 0).toFixed(2)})">
      <span class="stars-icons text-nowrap d-inline-flex gap-0.5">${starsHtml}</span>
      <span class="rating-num fw-bold ${rating.stars > 0 ? 'text-dark' : 'text-muted'}" style="font-size: 0.85em; margin-left: 2px;">${rating.stars > 0 ? rating.stars.toFixed(1) : '0.0'}</span>
    </span>
  `;
}

// ── Distinct Theme Colors for Roles (Faculty, Research Fellow, Student, Other) ──
function getMemberTypeTheme(memberType) {
  const t = String(memberType || 'Faculty').trim();
  if (t === 'Student') {
    return {
      type: 'Student',
      name: 'Student',
      color: '#059669',          // Emerald Green
      colorLight: '#ecfdf5',
      borderColor: '#10b981',
      badgeClass: 'badge-role-student',
      badgeStyle: 'background: linear-gradient(135deg, #059669, #10b981); color: #fff;',
      cardAccent: 'linear-gradient(90deg, #059669, #34d399)',
      avatarBg: '#059669',
      borderStyle: 'border-top: 3px solid #059669;',
      icon: 'fas fa-user-graduate',
      pillClass: 'bg-success-subtle text-success border border-success'
    };
  }
  if (t === 'Research Fellow') {
    return {
      type: 'Research Fellow',
      name: 'Research Fellow',
      color: '#7c3aed',          // Purple / Violet
      colorLight: '#f5f3ff',
      borderColor: '#8b5cf6',
      badgeClass: 'badge-role-research-fellow',
      badgeStyle: 'background: linear-gradient(135deg, #7c3aed, #8b5cf6); color: #fff;',
      cardAccent: 'linear-gradient(90deg, #7c3aed, #a855f7)',
      avatarBg: '#7c3aed',
      borderStyle: 'border-top: 3px solid #7c3aed;',
      icon: 'fas fa-microscope',
      pillClass: 'bg-purple-subtle text-purple border border-purple'
    };
  }
  if (t === 'Other') {
    return {
      type: 'Other',
      name: 'Other',
      color: '#ea580c',          // Orange / Amber
      colorLight: '#fff7ed',
      borderColor: '#f97316',
      badgeClass: 'badge-role-other',
      badgeStyle: 'background: linear-gradient(135deg, #ea580c, #f97316); color: #fff;',
      cardAccent: 'linear-gradient(90deg, #ea580c, #fb923c)',
      avatarBg: '#ea580c',
      borderStyle: 'border-top: 3px solid #ea580c;',
      icon: 'fas fa-user-tag',
      pillClass: 'bg-warning-subtle text-dark border border-warning'
    };
  }
  return {
    type: 'Faculty',
    name: 'Faculty',
    color: '#2563eb',            // Royal Blue
    colorLight: '#eff6ff',
    borderColor: '#3b82f6',
    badgeClass: 'badge-role-faculty',
    badgeStyle: 'background: linear-gradient(135deg, #2563eb, #3b82f6); color: #fff;',
    cardAccent: 'linear-gradient(90deg, #2563eb, #60a5fa)',
    avatarBg: '#2563eb',
    borderStyle: 'border-top: 3px solid #2563eb;',
    icon: 'fas fa-chalkboard-teacher',
    pillClass: 'bg-primary-subtle text-primary border border-primary-subtle'
  };
}

// ─── ROUTES ────────────────────────────────────────────────────────

// ─── AUTH ROUTES (Admin Login / Logout / Update Credentials) ────────
app.post('/admin/login', (req, res) => {
  try {
    const { username, password, return_to } = req.body;
    const nextUrl = getSafeRedirectTarget(return_to, '/');
    const result = db.verifyAdminLogin(username, password);
    if (!result.ok) {
      const sep = nextUrl.includes('?') ? '&' : '?';
      return res.redirect(`${nextUrl}${sep}login_err=Invalid+username+or+password`);
    }

    const cfg = db.getAdminConfig();
    const token = signSessionToken(result.username, cfg.session_secret);
    res.setHeader(
      'Set-Cookie',
      `uic_admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 60 * 60}`
    );
    const sep = nextUrl.includes('?') ? '&' : '?';
    res.redirect(`${nextUrl}${sep}admin_logged_in=1`);
  } catch (err) {
    res.redirect('/?login_err=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/logout', (req, res) => {
  const nextUrl = getSafeRedirectTarget(req.body.return_to, '/');
  res.setHeader('Set-Cookie', 'uic_admin_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  const sep = nextUrl.includes('?') ? '&' : '?';
  res.redirect(`${nextUrl}${sep}admin_logged_out=1`);
});

app.post('/admin/update-credentials', requireAdmin, (req, res) => {
  try {
    const { current_password, new_username, new_password, return_to } = req.body;
    const nextUrl = getSafeRedirectTarget(return_to, '/');
    const check = db.verifyAdminLogin(req.adminUsername, current_password);
    if (!check.ok) {
      const sep = nextUrl.includes('?') ? '&' : '?';
      return res.redirect(`${nextUrl}${sep}cred_err=Current+password+is+incorrect`);
    }
    if (!new_username || !new_username.trim()) {
      const sep = nextUrl.includes('?') ? '&' : '?';
      return res.redirect(`${nextUrl}${sep}cred_err=New+username+cannot+be+empty`);
    }
    const updatedUser = db.updateAdminCredentials(new_username.trim(), new_password || '');
    const cfg = db.getAdminConfig();
    const token = signSessionToken(updatedUser, cfg.session_secret);
    res.setHeader(
      'Set-Cookie',
      `uic_admin_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${12 * 60 * 60}`
    );
    const sep = nextUrl.includes('?') ? '&' : '?';
    res.redirect(`${nextUrl}${sep}cred_updated=1`);
  } catch (err) {
    res.redirect('/?cred_err=' + encodeURIComponent(err.message));
  }
});

app.post('/admin/settings/counting-mode', requireAdmin, (req, res) => {
  try {
    const mode = req.body.mode === 'separate' ? 'separate' : 'unique';
    db.recordUndoState(`Change Counting Mode to ${mode === 'separate' ? 'Separate' : '1 Paper (Unique)'}`);
    db.setPubCountingMode(mode);
    const nextUrl = getSafeRedirectTarget(req.body.return_to, '/portal');
    const [basePath, hashPart] = nextUrl.split('#');
    const sep = basePath.includes('?') ? '&' : '?';
    const hashSuffix = hashPart ? `#${hashPart}` : '';
    res.redirect(`${basePath}${sep}counting_updated=1&counting_mode=${mode}${hashSuffix}`);
  } catch (err) {
    res.redirect('/portal?master_err=' + encodeURIComponent(err.message));
  }
});

// Admin Undo / Redo actions
app.post('/admin/undo', requireAdmin, (req, res) => {
  const nextUrl = getSafeRedirectTarget(req.body.return_to, '/portal');
  const [basePath, hashPart] = nextUrl.split('#');
  const hashSuffix = hashPart ? `#${hashPart}` : '';
  const result = db.undoAction();
  const sep = basePath.includes('?') ? '&' : '?';
  if (!result.ok) {
    return res.redirect(`${basePath}${sep}history_err=${encodeURIComponent(result.message)}${hashSuffix}`);
  }
  res.redirect(`${basePath}${sep}undo_done=${encodeURIComponent(result.label)}${hashSuffix}`);
});

app.post('/admin/redo', requireAdmin, (req, res) => {
  const nextUrl = getSafeRedirectTarget(req.body.return_to, '/portal');
  const [basePath, hashPart] = nextUrl.split('#');
  const hashSuffix = hashPart ? `#${hashPart}` : '';
  const result = db.redoAction();
  const sep = basePath.includes('?') ? '&' : '?';
  if (!result.ok) {
    return res.redirect(`${basePath}${sep}history_err=${encodeURIComponent(result.message)}${hashSuffix}`);
  }
  res.redirect(`${basePath}${sep}redo_done=${encodeURIComponent(result.label)}${hashSuffix}`);
});

// 1. First Page / Landing Page: Introduction to UIC Department Research, Director, Campus, Heads, Coordinator
app.get('/', (req, res) => {
  try {
    const faculty = db.getAllFacultyWithStats();
    const totalFaculty = faculty.length;
    const pubCountingMode = db.getPubCountingMode();
    const overview = db.getDepartmentPublicationOverview(pubCountingMode);
    const totalPubs = overview.totalPubs;
    const q1Count = overview.q1Count;
    const activeCount = faculty.filter(f => f.ros > 0).length;
    const avgROS = totalFaculty ? (faculty.reduce((s, f) => s + f.ros, 0) / totalFaculty).toFixed(2) : '0.00';

    // Support dropdown selection of reporting year (e.g. 2024, 2025, 2026, 2027, 2028, 2029, 2030)
    const yearsList = [2024, 2025, 2026, 2027, 2028, 2029, 2030];
    const selectedYear = parseInt(req.query.year, 10) || 2026;
    const splitDeptROS = db.getAllYearsSplitDepartmentROS(yearsList, pubCountingMode);
    const allYearsROS = splitDeptROS.all;
    const monthlyROS = allYearsROS[selectedYear] || db.getDepartmentMonthlyROS(selectedYear, pubCountingMode, 'all');
    const uicMonthlyROS = splitDeptROS.uic[selectedYear] || db.getDepartmentMonthlyROS(selectedYear, pubCountingMode, 'uic');
    const otherMonthlyROS = splitDeptROS.other[selectedYear] || db.getDepartmentMonthlyROS(selectedYear, pubCountingMode, 'other');
    const allYearsTopPerformers = db.getAllYearsTopPerformers(yearsList, 20, pubCountingMode);
    const topPerformers = allYearsTopPerformers[selectedYear] || db.getTopPerformersByYear(selectedYear, 20, pubCountingMode);

    const memberStats = db.getMemberBifurcationStats(faculty);
    const pendingDocCount = req.isAdmin ? db.getUnreadDocumentCount() : 0;

    res.render('home', {
      totalFaculty,
      memberStats,
      totalPubs,
      q1Count,
      activeCount,
      avgROS,
      pubCountingMode,
      selectedYear,
      splitDeptROS,
      allYearsROS,
      monthlyROS,
      uicMonthlyROS,
      otherMonthlyROS,
      allYearsTopPerformers,
      topPerformers,
      pendingDocCount,
      query: req.query
    });
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// 2. Faculty Research Management Portal Directory (Visitors: Read-Only; Admin: Full Edit)
app.get('/portal', (req, res) => {
  try {
    let faculty = db.getAllFacultyWithStats();
    const sortMode = req.query.sort || 'name_asc';

    faculty = [...faculty].sort((a, b) => {
      if (sortMode === 'emp_asc') {
        return String(a.employee_code || '').localeCompare(String(b.employee_code || ''), undefined, { numeric: true, sensitivity: 'base' });
      }
      if (sortMode === 'emp_desc') {
        return String(b.employee_code || '').localeCompare(String(a.employee_code || ''), undefined, { numeric: true, sensitivity: 'base' });
      }
      if (sortMode === 'ros_desc') {
        return (b.ros - a.ros) || a.name.localeCompare(b.name);
      }
      if (sortMode === 'ros_asc') {
        return (a.ros - b.ros) || a.name.localeCompare(b.name);
      }
      return a.name.localeCompare(b.name);
    });

    const totalFaculty = faculty.length;
    const avgROS = totalFaculty ? (faculty.reduce((s, f) => s + f.ros, 0) / totalFaculty).toFixed(2) : 0;
    const zeroCount = faculty.filter(f => f.ros === 0).length;
    const activeCount = faculty.filter(f => f.ros > 0).length;
    const viewMode = req.query.view || 'grid';
    const pubCountingMode = db.getPubCountingMode();
    const memberStats = db.getMemberBifurcationStats(faculty);
    const pendingReport = (req.isAdmin && req.query.pending_id)
      ? (pendingMasterUploads.get(String(req.query.pending_id)) || null)
      : null;

    res.render('index', {
      faculty,
      totalFaculty,
      memberStats,
      avgROS,
      zeroCount,
      activeCount,
      rosColor,
      rosLabel,
      viewMode,
      sortMode,
      pubCountingMode,
      pendingReport,
      query: req.query
    });
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Redirect /dashboard to /portal for seamless backward navigation
app.get('/dashboard', (req, res) => {
  res.redirect('/portal');
});

// 3. Dedicated Publications Database (Master Published Papers Table with Academic Year Filter)
app.get('/publications', (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const filters = {
      search: req.query.search || '',
      year: req.query.year || 'all',
      month: req.query.month || 'all',
      quartile: req.query.quartile || 'all',
      department: req.query.department || 'all',
      document_type: req.query.document_type || 'all'
    };

    const publications = db.getMasterPublications();
    const stats = db.getMasterPublicationsStats(filters);

    res.render('publications', {
      publications,
      stats,
      filters,
      query: req.query
    });
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Download Master Publications Excel Sheet (.xlsx) with optional year filter
app.get(['/publications/download', '/export/master-publications'], (req, res) => {
  try {
    const yearParam = req.query.year || 'all';
    const filePath = path.join(__dirname, 'public', 'downloads', 'Published_Paper_2026.xlsx');
    if (yearParam === 'all' && fs.existsSync(filePath)) {
      res.setHeader('Content-Disposition', 'attachment; filename="Published_Paper_2026.xlsx"');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return res.sendFile(filePath);
    }

    const rows = db.getMasterPublications(yearParam !== 'all' ? { year: yearParam } : {});
    const exportData = [];
    exportData.push([
      'Sr. No.', 'Title', 'Year', 'Academic Session', 'Source title', 'Author names (CU)',
      'Scopus ID', 'Cluster', 'Institute', 'Department', 'ROS',
      'Source quartile (Q)', 'DOI', 'Link', 'Document Type',
      'EID', 'EID based Scopus Link', 'APN'
    ]);

    let lastMonth = '';
    rows.forEach(r => {
      if (r.month_section && r.month_section !== lastMonth) {
        lastMonth = r.month_section;
        exportData.push([lastMonth]);
      }
      exportData.push([
        r.sr_no ? (isNaN(Number(r.sr_no)) ? r.sr_no : Number(r.sr_no)) : '',
        r.title,
        r.year ? (isNaN(Number(r.year)) ? r.year : Number(r.year)) : '',
        r.academic_year || '',
        r.source_title,
        r.author_name,
        r.scopus_id ? (isNaN(Number(r.scopus_id)) ? r.scopus_id : Number(r.scopus_id)) : '',
        r.cluster,
        r.institute,
        r.department,
        r.ros ? (isNaN(Number(r.ros)) ? r.ros : Number(r.ros)) : '',
        r.quartile,
        r.doi,
        r.link,
        r.document_type,
        r.eid ? (isNaN(Number(r.eid)) ? r.eid : Number(r.eid)) : '',
        r.scopus_link,
        r.apn
      ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(exportData);
    const sheetName = yearParam !== 'all' ? `Papers_${yearParam.replace(/[^a-zA-Z0-9_-]/g, '_')}` : 'Published Papers';
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const filename = yearParam !== 'all' ? `Published_Papers_${yearParam}.xlsx` : 'Published_Paper_2026.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Export error: ' + err.message);
  }
});

// Admin upload/replace Master Publications Excel Sheet for a chosen academic year
app.post('/publications/upload-master', requireAdmin, upload.single('master_excel'), (req, res) => {
  try {
    if (!req.file) {
      return res.redirect('/publications?upload_err=' + encodeURIComponent('No file selected.'));
    }
    const targetYear = req.body.academic_year || '2025-26';
    const count = db.replaceMasterPublications(req.file.path, targetYear);
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    res.redirect('/publications?year=' + encodeURIComponent(targetYear) + '&uploaded=' + encodeURIComponent(count));
  } catch (err) {
    res.redirect('/publications?upload_err=' + encodeURIComponent(err.message));
  }
});

// API Get single master publication by id (JSON for modal editing)
app.get('/api/publications/:id', (req, res) => {
  try {
    const pub = db.getMasterPublicationById(req.params.id);
    if (!pub) return res.status(404).json({ ok: false, error: 'Publication not found' });
    res.json({ ok: true, publication: pub });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin add new publication entry
app.post('/publications/add', requireAdmin, (req, res) => {
  try {
    const newId = db.addMasterPublication(req.body);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true, id: newId });
    }
    res.redirect('/publications?added=1');
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.redirect('/publications?err=' + encodeURIComponent(err.message));
  }
});

// Admin edit publication entry - supports both POST /publications/:id/edit and POST /publications/edit
app.post(['/publications/:id/edit', '/publications/edit', '/api/publications/:id/edit'], requireAdmin, (req, res) => {
  try {
    const id = req.params.id || req.body.id || req.body.pub_id;
    if (!id) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ ok: false, error: 'Missing publication ID' });
      }
      return res.redirect('/publications?err=' + encodeURIComponent('Missing publication ID'));
    }
    const updated = db.updateMasterPublication(id, req.body);
    if (req.xhr || req.headers.accept?.includes('application/json') || req.is('json')) {
      return res.json({ ok: true, message: 'Publication updated successfully', publication: updated });
    }
    res.redirect('/publications?edited=' + encodeURIComponent(id));
  } catch (err) {
    console.error('Error editing master publication:', err);
    if (req.xhr || req.headers.accept?.includes('application/json') || req.is('json')) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.redirect('/publications?err=' + encodeURIComponent(err.message));
  }
});

// Fallback POST /publications (for forms submitting to current URL)
app.post('/publications', requireAdmin, (req, res) => {
  try {
    const id = req.body.id || req.body.pub_id;
    if (id) {
      const updated = db.updateMasterPublication(id, req.body);
      if (req.xhr || req.headers.accept?.includes('application/json') || req.is('json')) {
        return res.json({ ok: true, message: 'Publication updated successfully', publication: updated });
      }
      return res.redirect('/publications?edited=' + encodeURIComponent(id));
    }
    db.addMasterPublication(req.body);
    res.redirect('/publications?added=1');
  } catch (err) {
    console.error('Error in POST /publications:', err);
    if (req.xhr || req.headers.accept?.includes('application/json') || req.is('json')) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.redirect('/publications?err=' + encodeURIComponent(err.message));
  }
});

// Admin delete single publication entry
app.post(['/publications/:id/delete', '/publications/delete', '/api/publications/:id/delete'], requireAdmin, (req, res) => {
  try {
    const id = req.params.id || req.body.id || req.body.pub_id;
    const deleted = db.deleteMasterPublication(id);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true, message: 'Publication deleted successfully', deleted });
    }
    res.redirect('/publications?deleted=1');
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.redirect('/publications?err=' + encodeURIComponent(err.message));
  }
});

// Admin delete multiple publication entries
app.post(['/publications/delete-multiple', '/api/publications/delete-multiple'], requireAdmin, (req, res) => {
  try {
    let ids = req.body.ids;
    if (typeof ids === 'string') {
      ids = ids.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      if (req.xhr || req.headers.accept?.includes('application/json')) {
        return res.status(400).json({ ok: false, error: 'No publications selected for deletion.' });
      }
      return res.redirect('/publications?err=' + encodeURIComponent('No publications selected for deletion.'));
    }
    const count = db.deleteMasterPublicationsMultiple(ids);
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.json({ ok: true, message: `${count} publications deleted`, count });
    }
    res.redirect('/publications?deleted_multiple=' + count);
  } catch (err) {
    if (req.xhr || req.headers.accept?.includes('application/json')) {
      return res.status(500).json({ ok: false, error: err.message });
    }
    res.redirect('/publications?err=' + encodeURIComponent(err.message));
  }
});

// ─── UPCOMING CONFERENCES ROUTES ───────────────────────────────────
// 4. Dedicated Upcoming Conferences Page
app.get('/conferences', (req, res) => {
  try {
    const filters = {
      search: req.query.search || '',
      status: req.query.status || 'all',
      indexing: req.query.indexing || 'all'
    };
    const conferences = db.getAllConferences(filters);
    const stats = db.getConferenceStats();
    res.render('conferences', {
      conferences,
      stats,
      filters,
      query: req.query
    });
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// API Get single conference
app.get('/api/conferences/:id', (req, res) => {
  try {
    const conf = db.getConferenceById(req.params.id);
    if (!conf) return res.status(404).json({ ok: false, error: 'Conference not found' });
    res.json({ ok: true, conference: conf });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Admin Add Conference
app.post('/conferences/add', requireAdmin, (req, res) => {
  try {
    db.addConference(req.body);
    res.redirect('/conferences?added=1');
  } catch (err) {
    res.redirect('/conferences?err=' + encodeURIComponent(err.message));
  }
});

// Admin Edit Conference
app.post('/conferences/:id/edit', requireAdmin, (req, res) => {
  try {
    db.updateConference(req.params.id, req.body);
    res.redirect('/conferences?edited=1');
  } catch (err) {
    res.redirect('/conferences?err=' + encodeURIComponent(err.message));
  }
});

// Admin Delete Conference
app.post('/conferences/:id/delete', requireAdmin, (req, res) => {
  try {
    db.deleteConference(req.params.id);
    res.redirect('/conferences?deleted=1');
  } catch (err) {
    res.redirect('/conferences?err=' + encodeURIComponent(err.message));
  }
});

// Admin Delete Multiple Conferences
app.post('/conferences/delete-multiple', requireAdmin, (req, res) => {
  try {
    let ids = req.body.ids;
    if (typeof ids === 'string') {
      ids = ids.split(',').map(s => s.trim()).filter(Boolean);
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.redirect('/conferences?err=' + encodeURIComponent('No conferences selected for deletion.'));
    }
    const count = db.deleteConferencesMultiple(ids);
    res.redirect('/conferences?deleted_multiple=' + count);
  } catch (err) {
    res.redirect('/conferences?err=' + encodeURIComponent(err.message));
  }
});

// Excel Download Route
app.get('/export/excel', (req, res) => {
  try {
    const faculty = db.getAllFacultyWithStats();

    const allMonthsSet = new Set();
    faculty.forEach(f => {
      if (f.month_ros) {
        Object.keys(f.month_ros).forEach(m => allMonthsSet.add(m));
      }
    });
    const sortedMonths = Array.from(allMonthsSet).sort();

    // Sheet 1: All Faculty Summary & Month-wise ROS
    const allFacultyRows = faculty.map((f, idx) => {
      const row = {
        'S.No': idx + 1,
        'Employee Code': f.employee_code,
        'Faculty Name': f.name,
        'Category': f.member_type || 'Faculty',
        'Scopus ID': f.scopus_id || '',
        'Member Status': f.status || 'Active',
        'Designation': f.designation || 'N/A',
        'Department': f.department || 'N/A',
        'Total Publications': f.total_pubs,
        'Journals (Article/Review)': f.journal_count,
        'Conferences': f.conf_count,
        'Book Chapters': f.book_count,
        'Patents': f.patent_count,
        'Q1 Papers': f.q1,
        'Q2 Papers': f.q2,
        'Q3 Papers': f.q3,
        'Q4 Papers': f.q4,
        'Total ROS Score': f.ros,
        'Status': f.ros === 0 ? 'Zero Publications' : (f.ros >= 0.8 ? 'High Output' : (f.ros >= 0.4 ? 'Moderate' : 'Low Output'))
      };

      sortedMonths.forEach(m => {
        row[`ROS (${m})`] = (f.month_ros && f.month_ros[m]) ? parseFloat(f.month_ros[m].toFixed(2)) : 0;
      });

      return row;
    });

    // Sheet 2: Zero Publications Track Sheet
    const zeroFaculty = faculty.filter(f => f.ros === 0 || f.total_pubs === 0);
    const zeroRows = zeroFaculty.map((f, idx) => ({
      'S.No': idx + 1,
      'Employee Code': f.employee_code,
      'Faculty Name': f.name,
      'Designation': f.designation || 'N/A',
      'Department': f.department || 'N/A',
      'Total Publications': 0,
      'ROS Score': 0.00,
      'Status': 'Zero Publication Alert',
      'Action Required': 'Submission Pending / Follow-up Needed'
    }));

    // Sheet 3: Highest ROS Ranking
    const rankedFaculty = [...faculty].sort((a, b) => b.ros - a.ros);
    const rankedRows = rankedFaculty.map((f, idx) => ({
      'Rank': idx + 1,
      'Faculty Name': f.name,
      'Employee Code': f.employee_code,
      'Department': f.department || 'N/A',
      'Total ROS Score': f.ros,
      'Total Publications': f.total_pubs,
      'Journals': f.journal_count,
      'Conferences': f.conf_count,
      'Book Chapters': f.book_count,
      'Patents': f.patent_count,
      'Q1 Papers': f.q1,
      'Q2 Papers': f.q2
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(allFacultyRows), 'All Faculty & Month ROS');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(zeroRows), 'Zero Publications Track');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rankedRows), 'Highest ROS Ranking');

    const fileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `UIC_Faculty_Research_Report_${new Date().toISOString().substring(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fileBuffer);
  } catch (err) {
    res.status(500).send('Error generating Excel file: ' + err.message);
  }
});

// Saturday Roster Off Eligibility Excel Download Route
app.get('/export/saturday-roster', (req, res) => {
  try {
    const rawThreshold = parseFloat(req.query.threshold);
    const threshold = isNaN(rawThreshold) ? 0.5 : Math.max(0, rawThreshold);
    const thresholdFixed = threshold.toFixed(2);
    const thresholdScaled = Math.round(threshold * 10000);

    const faculty = db.getAllFacultyWithStats();
    const sorted = [...faculty].sort((a, b) => (b.ros - a.ros) || a.name.localeCompare(b.name));

    const eligible = sorted.filter(f => Math.round((parseFloat(f.ros) || 0) * 10000) >= thresholdScaled);
    const notEligible = sorted.filter(f => Math.round((parseFloat(f.ros) || 0) * 10000) < thresholdScaled);

    const eligibleRows = eligible.map((f, idx) => ({
      'S.No': idx + 1,
      'Employee Code': f.employee_code,
      'Faculty Name': f.name,
      'Designation': f.designation || 'N/A',
      'Department': f.department || 'N/A',
      'Total Publications': f.total_pubs,
      'Q1 Papers': f.q1,
      'Q2 Papers': f.q2,
      'Q3 Papers': f.q3,
      'Q4 Papers': f.q4,
      'Total ROS Score': parseFloat(f.ros.toFixed(2)),
      'Threshold ROS': parseFloat(thresholdFixed),
      'Saturday Roster Off Status': `Eligible (ROS >= ${thresholdFixed})`
    }));

    const eligibleSheet = eligibleRows.length > 0
      ? XLSX.utils.json_to_sheet(eligibleRows)
      : XLSX.utils.json_to_sheet([{
          'S.No': '', 'Employee Code': '', 'Faculty Name': 'No faculty met the threshold',
          'Designation': '', 'Department': '', 'Total Publications': '',
          'Q1 Papers': '', 'Q2 Papers': '', 'Q3 Papers': '', 'Q4 Papers': '',
          'Total ROS Score': '', 'Threshold ROS': parseFloat(thresholdFixed),
          'Saturday Roster Off Status': `No faculty >= ${thresholdFixed}`
        }]);

    const notEligibleRows = notEligible.map((f, idx) => ({
      'S.No': idx + 1,
      'Employee Code': f.employee_code,
      'Faculty Name': f.name,
      'Designation': f.designation || 'N/A',
      'Department': f.department || 'N/A',
      'Total Publications': f.total_pubs,
      'Total ROS Score': parseFloat(f.ros.toFixed(2)),
      'Threshold ROS': parseFloat(thresholdFixed),
      'ROS Shortfall': parseFloat(Math.max(0, threshold - f.ros).toFixed(2)),
      'Saturday Roster Off Status': `Not Eligible (ROS < ${thresholdFixed})`
    }));

    const summaryRows = [
      { 'Metric': 'Portal', 'Value': 'UIC Research Portal — University Institute of Computing, Chandigarh University' },
      { 'Metric': 'ROS Threshold Applied', 'Value': parseFloat(thresholdFixed) },
      { 'Metric': 'Total Registered Faculty', 'Value': faculty.length },
      { 'Metric': 'Eligible for Saturday Roster Off', 'Value': eligible.length },
      { 'Metric': 'Not Eligible', 'Value': notEligible.length },
      { 'Metric': 'Report Generated On', 'Value': new Date().toISOString().substring(0, 10) }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, eligibleSheet, 'Eligible Saturday Off');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(notEligibleRows), 'Not Eligible Faculty');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Roster Summary');

    const fileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `UIC_Saturday_Roster_Off_ROS_${thresholdFixed}_${new Date().toISOString().substring(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fileBuffer);
  } catch (err) {
    res.status(500).send('Error generating Saturday Roster Off Excel: ' + err.message);
  }
});

// Top Performers & Department Growth Excel Download Route
app.get('/export/top-performers', (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || 2026;
    const perfData = db.getTopPerformersByYear(year, 0);
    const rosData = db.getDepartmentMonthlyROS(year);

    function flattenPeriodRows(periods, periodLabelFn) {
      const rows = [];
      periods.forEach(p => {
        if (!p.top || p.top.length === 0) {
          rows.push({
            'Period': periodLabelFn(p),
            'Rank': '-',
            'Employee Code': '-',
            'Faculty Name': 'No publications recorded',
            'Designation': '-',
            'Publications': 0,
            'Q1': 0,
            'Q2': 0,
            'Q3': 0,
            'Q4': 0,
            'ROS Score': 0,
            'Dept Period ROS': 0
          });
          return;
        }
        p.top.forEach(f => {
          rows.push({
            'Period': periodLabelFn(p),
            'Rank': f.rank,
            'Employee Code': f.employee_code,
            'Faculty Name': f.name,
            'Designation': f.designation || 'N/A',
            'Publications': f.total_pubs,
            'Q1': f.q1,
            'Q2': f.q2,
            'Q3': f.q3,
            'Q4': f.q4,
            'ROS Score': f.ros,
            'Dept Period ROS': p.dept_ros
          });
        });
      });
      return rows;
    }

    const monthlyRows = flattenPeriodRows(perfData.monthly, p => p.label);
    const quarterlyRows = flattenPeriodRows(perfData.quarterly, p => `${p.label} (${p.range})`);
    const sixMonthlyRows = flattenPeriodRows(perfData.sixMonthly, p => `${p.label} (${p.range})`);
    const annualRows = flattenPeriodRows([perfData.annual], p => p.range);
    const growthRows = rosData.rows.map(r => ({
      'Month': r.month,
      'Q1 ROS': r.q1_ros,
      'Q2 ROS': r.q2_ros,
      'Q3 ROS': r.q3_ros,
      'Q4 ROS': r.q4_ros,
      'Papers': r.total,
      'Monthly Dept ROS': r.ros,
      'Cumulative Dept ROS': r.cumulative_ros,
      'MoM ROS Change': r.mom_diff === null ? '-' : r.mom_diff,
      'MoM Growth (%)': r.mom_growth_pct === null ? '-' : `${r.mom_growth_pct}%`
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(monthlyRows), 'Monthly Top Performers');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(quarterlyRows), 'Quarterly Top Performers');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sixMonthlyRows), 'Six-Monthly Performers');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(annualRows), 'Annual Top Performers');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(growthRows), 'Dept ROS Growth');

    const uicRosData = db.getDepartmentMonthlyROS(year, db.getPubCountingMode(), 'uic');
    const otherRosData = db.getDepartmentMonthlyROS(year, db.getPubCountingMode(), 'other');
    const formatDeptSheet = (d, deptLabel) => d.rows.map(r => ({
      'Department': deptLabel,
      'Month': r.month,
      'Q1 ROS': r.q1_ros,
      'Q1 Papers': r.q1,
      'Q2 ROS': r.q2_ros,
      'Q2 Papers': r.q2,
      'Q3 ROS': r.q3_ros,
      'Q3 Papers': r.q3,
      'Q4 ROS': r.q4_ros,
      'Q4 Papers': r.q4,
      'Total Papers': r.total,
      'Total ROS': r.ros
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(formatDeptSheet(uicRosData, 'UIC')), 'UIC Monthly ROS');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(formatDeptSheet(otherRosData, 'Other Dept Deputed')), 'Other Dept ROS');

    const fileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const filename = `UIC_Top_Performers_Growth_${year}_${new Date().toISOString().substring(0, 10)}.xlsx`;

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(fileBuffer);
  } catch (err) {
    res.status(500).send('Error generating Top Performers Excel: ' + err.message);
  }
});

// Download sample Excel template for Main Dashboard Master Upload (matches user screenshot)
app.get('/download-master-publications-template', (req, res) => {
  try {
    const sampleRows = [
      {
        'Title': 'Biosurfactants as green solutions for sustainable farming: Mechanisms, challenges, and future directions in agroecology',
        'Source title': 'European Journal of Agronomy',
        'Author names (CU)': 'Neeraj Narwat',
        'ROS': 0.34,
        'Source quartile (Q)': 'Q1',
        'Link': 'https://www.sciencedirect.com/article/example',
        'Document Type': 'Review',
        'APN': '1/Oct/2026',
        'EID based Scopus Link': 'https://www.scopus.com/example',
        'EID': '105053427146',
        'Department': 'UIC'
      },
      {
        'Title': 'Deep Learning Architectures for Autonomous Edge Sensors',
        'Source title': 'IEEE International Conference on Smart Sensors',
        'Author names (CU)': 'Dr. Sarah Ahmed',
        'ROS': 0.25,
        'Source quartile (Q)': 'Q4',
        'Link': 'https://ieeexplore.ieee.org/document/example',
        'Document Type': 'Conference Paper',
        'APN': '15/May/2026',
        'EID based Scopus Link': 'https://www.scopus.com/example2',
        'EID': '2-s2.0-85192837190',
        'Department': 'UIC'
      },
      {
        'Title': 'Microbial Bioremediation of Heavy Metals in Industrial Soil',
        'Source title': 'Springer Handbook of Ecological Biotechnology',
        'Author names (CU)': 'Dr. Sarah Ahmed',
        'ROS': 0.20,
        'Source quartile (Q)': 'N/A',
        'Link': 'https://link.springer.com/example',
        'Document Type': 'Book Chapter',
        'APN': '20/Jul/2026',
        'EID based Scopus Link': 'https://www.scopus.com/example3',
        'EID': '2-s2.0-85201928371',
        'Department': 'CSE'
      }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sampleRows), 'Publications_Master_Format');
    const fileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Publications_Master_Template.xlsx"');
    res.send(fileBuffer);
  } catch (err) {
    res.status(500).send('Error downloading template: ' + err.message);
  }
});

// Download sample Excel template for faculty / research fellow / student list
app.get('/download-template', (req, res) => {
  try {
    const sampleRows = [
      { 'Sr. No': 1, 'Faculty Name': 'Neeraj Narwat', 'Employee Code': 'EMP101', 'Designation': 'Associate Professor', 'Department': 'UIC', 'Category': 'Faculty', 'Scopus ID': '57201234567', 'Status': 'Active' },
      { 'Sr. No': 2, 'Faculty Name': 'Ms. Damanpreet Kaur', 'Employee Code': 'R258', 'Designation': 'Research Scholar', 'Department': 'UIC', 'Category': 'Research Fellow', 'Scopus ID': '57219876543', 'Status': 'Active' },
      { 'Sr. No': 3, 'Faculty Name': 'Vipin Bansal', 'Employee Code': '20MCA10254', 'Designation': 'Student', 'Department': 'UIC', 'Category': 'Student', 'Scopus ID': '', 'Status': 'Active' },
      { 'Sr. No': 4, 'Faculty Name': 'Dr. Former Faculty', 'Employee Code': 'EMP099', 'Designation': 'Assistant Professor', 'Department': 'UIC', 'Category': 'Faculty', 'Scopus ID': '57190001122', 'Status': 'Inactive' }
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sampleRows), 'Faculty_List_Template');
    const fileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Faculty_List_Template.xlsx"');
    res.send(fileBuffer);
  } catch (err) {
    res.status(500).send('Error downloading template: ' + err.message);
  }
});

// Shared helper to parse a publication row from Excel
function parseExcelPublicationRow(r, fallbackAuthor = '') {
  const title = r['Title'] || r['title'] || r['Paper Title'];
  if (!title || !String(title).trim()) return null;

  const docTypeRaw = r['Document Type'] || r['Document type'] || r['document_type'] || r['Type'] || 'Article';
  const docType = normalizeDocType(docTypeRaw);
  const pubType = resolvePubTypeFromDocType(docTypeRaw);
  const sourceTitle = r['Source title'] || r['Source Title'] || r['source_title'] || r['Journal Name'] || '';
  const authorRaw = r['Author names (CU)'] || r['Author names'] || r['Author Name'] || r['Author'] || r['Name'] || r['Faculty Name'] || fallbackAuthor;
  const rosVal = parseFloat(r['ROS'] || r['ros'] || 0) || 0.0;
  const quart = normalizeQuartileForPubType(
    r['Source quartile (Q)'] || r['Quartile'] || r['quartile'] || 'N/A',
    pubType
  );
  const link = r['Link'] || r['link'] || '';
  const apn = r['APN'] || r['apn'] || '';
  const scopusLink = r['EID based Scopus Link'] || r['Scopus Link'] || '';
  const eid = r['EID'] || r['eid'] || '';
  const monthStr = parseMonthFromAPN(apn, r['Month'] || r['month']);
  const deptRaw =
    r['Department Name'] ||
    r['department name'] ||
    r['Department'] ||
    r['department'] ||
    r['Dept'] ||
    r['dept'] ||
    r['DEPT'] ||
    '';
  const pubDepartment = db.normalizePubDepartment(deptRaw);

  return {
    pub_type: pubType,
    document_type: docType,
    title: String(title).trim(),
    source_title: String(sourceTitle).trim(),
    author_name: String(authorRaw).trim(),
    ros: rosVal,
    quartile: quart,
    link: String(link).trim(),
    apn: String(apn).trim(),
    scopus_link: String(scopusLink).trim(),
    eid: String(eid).trim(),
    month: monthStr,
    pub_department: pubDepartment
  };
}

// ─── MASTER DASHBOARD EXCEL UPLOAD ──────────────────────────────────
// Matches Column D: "Author names (CU)" to faculty name, separates found vs pending/not-found names, and checks duplicates
app.post('/dashboard/upload-publications-master', requireAdmin, upload.single('master_excel'), (req, res) => {
  try {
    if (!req.file) {
      return res.redirect('/portal?master_err=No file uploaded');
    }

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const itemsToImport = [];
    const pendingRows = [];
    const pendingNameMap = new Map();

    rawData.forEach((r, idx) => {
      const pubData = parseExcelPublicationRow(r);
      if (!pubData) return;

      const excelRowNum = idx + 2;
      const authorQuery = pubData.author_name;
      if (!authorQuery) {
        pendingRows.push({
          rowNo: excelRowNum,
          authorName: '(Blank Author)',
          pubDepartment: pubData.pub_department,
          title: pubData.title,
          sourceTitle: pubData.source_title,
          documentType: pubData.document_type,
          quartile: pubData.quartile,
          ros: pubData.ros,
          apn: pubData.apn,
          month: pubData.month,
          link: pubData.link,
          scopusLink: pubData.scopus_link,
          eid: pubData.eid,
          reason: 'Author name missing in Excel'
        });
        return;
      }

      const faculty = db.findFacultyByName(authorQuery);
      if (!faculty) {
        pendingRows.push({
          rowNo: excelRowNum,
          authorName: authorQuery,
          pubDepartment: pubData.pub_department,
          title: pubData.title,
          sourceTitle: pubData.source_title,
          documentType: pubData.document_type,
          quartile: pubData.quartile,
          ros: pubData.ros,
          apn: pubData.apn,
          month: pubData.month,
          link: pubData.link,
          scopusLink: pubData.scopus_link,
          eid: pubData.eid,
          reason: 'Faculty not found in Directory'
        });
        const key = authorQuery.toLowerCase();
        if (!pendingNameMap.has(key)) {
          pendingNameMap.set(key, { name: authorQuery, department: pubData.pub_department, count: 0 });
        }
        pendingNameMap.get(key).count += 1;
        return;
      }

      itemsToImport.push({
        facultyId: faculty.id,
        facultyName: faculty.name,
        facultyCode: faculty.employee_code,
        pubData
      });
    });

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    const unmatchedCount = pendingRows.length;
    const uniquePendingNames = Array.from(pendingNameMap.values());
    const sampleUnmatched = uniquePendingNames.map(x => x.name).slice(0, 5).join(', ');
    const pendingId = unmatchedCount > 0
      ? savePendingMasterReport({
          unmatchedCount,
          pendingRows,
          uniquePendingNames
        })
      : '';

    const analysis = db.analyzePublicationsUpload(itemsToImport);

    if (analysis.duplicateItems.length > 0) {
      return res.render('pub_upload_confirm', {
        scopeTitle: 'Master Publications Excel',
        confirmAction: '/dashboard/upload-publications-master/confirm',
        backUrl: '/portal',
        newItems: analysis.newItems,
        duplicateItems: analysis.duplicateItems,
        newItemsJson: JSON.stringify(analysis.newItems),
        duplicateItemsJson: JSON.stringify(analysis.duplicateItems),
        unmatchedCount,
        unmatchedNames: sampleUnmatched,
        pendingId,
        pendingRows,
        uniquePendingNames
      });
    }

    if (analysis.newItems.length > 0) {
      db.recordUndoState(`Master Excel Upload (+${analysis.newItems.length} pubs)`);
    }
    const result = db.applyPublicationsUpload(analysis.newItems, [], 'skip');
    let redirectUrl = `/portal?master_success=1&matched=${result.addedCount}&replaced=0&skipped=0&unmatched=${unmatchedCount}`;
    if (sampleUnmatched) {
      redirectUrl += `&unmatched_names=${encodeURIComponent(sampleUnmatched)}`;
    }
    if (pendingId) {
      redirectUrl += `&pending_id=${encodeURIComponent(pendingId)}`;
    }
    res.redirect(redirectUrl);
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.redirect('/portal?master_err=' + encodeURIComponent(err.message));
  }
});

// Download Pending / Unmatched Rows from Master Publication Excel Upload
app.get('/dashboard/download-pending-master', requireAdmin, (req, res) => {
  try {
    const pendingId = String(req.query.pending_id || '');
    const report = pendingMasterUploads.get(pendingId);
    if (!report || !report.pendingRows || report.pendingRows.length === 0) {
      return res.redirect('/portal?master_err=Pending+report+expired+or+empty');
    }

    const excelRows = report.pendingRows.map(p => ({
      'Excel Row': p.rowNo,
      'Title': p.title,
      'Source title': p.sourceTitle || '',
      'Author names (CU)': p.authorName,
      'ROS': p.ros,
      'Source quartile (Q)': p.quartile,
      'Link': p.link || '',
      'Document Type': p.documentType,
      'APN': p.apn || '',
      'EID based Scopus Link': p.scopusLink || '',
      'EID': p.eid || '',
      'Department': p.pubDepartment || 'UIC',
      'Status / Reason': p.reason
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(excelRows), 'Pending Faculty Publications');
    const fileBuffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="UIC_Pending_Faculty_Publications_${new Date().toISOString().substring(0, 10)}.xlsx"`);
    res.send(fileBuffer);
  } catch (err) {
    res.status(500).send('Error generating pending report Excel: ' + err.message);
  }
});

// Confirm Master Publications Excel Upload (Replace / Skip / Add All)
app.post('/dashboard/upload-publications-master/confirm', requireAdmin, (req, res) => {
  try {
    const { new_items_json, duplicate_items_json, decision, unmatched_count, unmatched_names, pending_id } = req.body;
    const newItems = JSON.parse(new_items_json || '[]');
    const duplicateItems = JSON.parse(duplicate_items_json || '[]');
    if (newItems.length > 0 || (duplicateItems.length > 0 && decision !== 'skip')) {
      db.recordUndoState(`Master Excel Confirm (${newItems.length} new, ${duplicateItems.length} dup=${decision})`);
    }
    const result = db.applyPublicationsUpload(newItems, duplicateItems, decision);

    let redirectUrl = `/portal?master_success=1&matched=${result.addedCount}&replaced=${result.replacedCount}&skipped=${result.skippedCount}&unmatched=${unmatched_count || 0}`;
    if (unmatched_names) {
      redirectUrl += `&unmatched_names=${encodeURIComponent(unmatched_names)}`;
    }
    if (pending_id) {
      redirectUrl += `&pending_id=${encodeURIComponent(pending_id)}`;
    }
    res.redirect(redirectUrl);
  } catch (err) {
    res.redirect('/portal?master_err=' + encodeURIComponent(err.message));
  }
});

// Bulk Upload Faculty List (checks duplicates by BOTH Name and Employee Code)
app.post('/faculty/upload-excel', requireAdmin, upload.single('faculty_excel'), (req, res) => {
  try {
    if (!req.file) return res.redirect('/portal?upload_err=No file uploaded');

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const parsedRows = rawData.map(r => {
      const name = r['Faculty Name'] || r['Name of faculty'] || r['Name'] || r['faculty_name'] || r['name'];
      const code = r['Employee Code'] || r['employee code'] || r['Code'] || r['employee_code'] || r['EMP Code'] || r['emp_code'] || r['UID'] || r['Roll No'];
      const designation = r['Designation'] || r['designation'] || '';
      const department = r['Department'] || r['department'] || '';
      const scopusId = r['Scopus ID'] || r['scopus_id'] || r['Scopus Author ID'] || r['Scopus'] || '';
      const memberType = r['Category'] || r['category'] || r['Member Type'] || r['member_type'] || r['Role'] || r['Type'] || '';
      const status = r['Status'] || r['status'] || r['Active Status'] || r['Active/Inactive'] || r['Member Status'] || 'Active';

      return {
        name: name ? String(name).trim() : '',
        employee_code: code ? String(code).trim() : '',
        designation: designation ? String(designation).trim() : '',
        department: department ? String(department).trim() : '',
        scopus_id: scopusId ? String(scopusId).trim() : '',
        member_type: db.normalizeMemberType(memberType, designation, code),
        status: db.normalizeMemberStatus(status)
      };
    }).filter(r => r.name && r.employee_code);

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    if (parsedRows.length === 0) {
      return res.redirect('/portal?upload_err=No valid faculty entries found. Ensure column headers include "Faculty Name" and "Employee Code".');
    }

    const analysis = db.analyzeFacultyUpload(parsedRows);

    // If duplicates found (by Name or Employee Code), ask user whether to replace existing records
    if (analysis.duplicateRows.length > 0) {
      return res.render('upload_confirm', {
        newRows: analysis.newRows,
        duplicateRows: analysis.duplicateRows,
        newRowsJson: JSON.stringify(analysis.newRows),
        duplicateRowsJson: JSON.stringify(analysis.duplicateRows)
      });
    }

    if (analysis.newRows.length > 0) {
      db.recordUndoState(`Bulk Faculty Upload (+${analysis.newRows.length} faculty)`);
    }
    const result = db.applyFacultyUpload(analysis.newRows, [], false);
    res.redirect(`/portal?upload_success=1&added=${result.addedCount}&replaced=${result.replacedCount}&skipped=${result.skippedCount}`);
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.redirect('/portal?upload_err=' + encodeURIComponent(err.message));
  }
});

// Confirm Bulk Faculty Upload (Replace Existing or Skip Existing)
app.post('/faculty/upload-excel/confirm', requireAdmin, (req, res) => {
  try {
    const { new_rows_json, duplicate_rows_json, decision } = req.body;
    const newRows = JSON.parse(new_rows_json || '[]');
    const duplicateRows = JSON.parse(duplicate_rows_json || '[]');
    const replaceExisting = (decision === 'replace');

    if (newRows.length > 0 || (replaceExisting && duplicateRows.length > 0)) {
      db.recordUndoState(`Bulk Faculty Confirm (${newRows.length} new, replace=${replaceExisting})`);
    }
    const result = db.applyFacultyUpload(newRows, duplicateRows, replaceExisting);
    res.redirect(`/portal?upload_success=1&added=${result.addedCount}&replaced=${result.replacedCount}&skipped=${result.skippedCount}`);
  } catch (err) {
    res.redirect('/portal?upload_err=' + encodeURIComponent(err.message));
  }
});

// Delete Multiple Selected Faculty
app.post('/faculty/delete-multiple', requireAdmin, (req, res) => {
  try {
    let { faculty_ids } = req.body;
    if (!faculty_ids) return res.redirect('/portal');
    if (!Array.isArray(faculty_ids)) faculty_ids = [faculty_ids];
    const ids = faculty_ids.map(id => parseInt(id, 10)).filter(id => !isNaN(id));

    if (ids.length > 0) {
      db.recordUndoState(`Delete ${ids.length} Selected Faculty`);
    }
    const result = db.deleteFacultyMultiple(ids);

    res.redirect(`/portal?bulk_deleted=${result.deletedCount}`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Delete ALL Faculty
app.post('/faculty/delete-all', requireAdmin, (req, res) => {
  try {
    db.recordUndoState('Delete All Faculty');
    const result = db.deleteAllFaculty();

    res.redirect(`/portal?all_deleted=${result.deletedCount}`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Add single faculty form
app.get('/faculty/add', requireAdmin, (req, res) => {
  const formData = {
    name: req.query.name ? String(req.query.name).trim() : '',
    department: req.query.department ? String(req.query.department).trim() : ''
  };
  res.render('add', { error: null, duplicateMatch: null, formData });
});

// Add single faculty POST (checks BOTH Name and Employee Code and asks to replace if existing)
app.post('/faculty/add', requireAdmin, upload.single('photo'), (req, res) => {
  try {
    const { name, employee_code, designation, department, scopus_id, member_type, status, visibility, confirm_replace, replace_id, pending_photo } = req.body;

    if (!name || !employee_code) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.render('add', {
        error: 'Name and Employee Code are required.',
        duplicateMatch: null,
        formData: { name, employee_code, designation, department, scopus_id, member_type, status, visibility }
      });
    }

    // Confirmed replacement of an existing faculty record
    if (confirm_replace === '1' && replace_id) {
      const targetId = parseInt(replace_id, 10);
      const codeOwner = db.getFacultyByEmployeeCode(employee_code.trim());
      if (codeOwner && codeOwner.id !== targetId) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.render('add', {
          error: `Cannot replace: Employee code "${employee_code.trim()}" is already assigned to another faculty member (${codeOwner.name}).`,
          duplicateMatch: null,
          formData: { name, employee_code, designation, department, scopus_id, member_type, status, visibility }
        });
      }

      const newPhoto = req.file ? req.file.filename : (pending_photo || null);
      db.recordUndoState(`Replace Faculty: ${name.trim()}`);
      db.updateFaculty(targetId, {
        name: name.trim(),
        employee_code: employee_code.trim(),
        designation: designation || '',
        department: department || '',
        scopus_id: scopus_id || '',
        member_type,
        status,
        visibility,
        photo: newPhoto
      });

      return res.redirect(`/faculty/${targetId}?replaced=1`);
    }

    // Check duplicate by BOTH Name and Employee Code
    const dup = db.findDuplicateFaculty(name, employee_code);
    if (dup) {
      const savedPendingPhoto = req.file ? req.file.filename : (pending_photo || '');
      return res.render('add', {
        error: null,
        duplicateMatch: {
          existing: dup.existing,
          matchReason: dup.matchReason
        },
        formData: {
          name: name.trim(),
          employee_code: employee_code.trim(),
          designation: designation || '',
          department: department || '',
          scopus_id: scopus_id || '',
          member_type: member_type || 'Faculty',
          status: status || 'Active',
          visibility: visibility || 'public',
          pending_photo: savedPendingPhoto
        }
      });
    }

    const photo = req.file ? req.file.filename : (pending_photo || null);
    db.recordUndoState(`Add Faculty: ${name.trim()}`);
    const newId = db.addFaculty({
      name: name.trim(),
      employee_code: employee_code.trim(),
      designation,
      department,
      scopus_id,
      member_type,
      status,
      visibility,
      photo
    });

    res.redirect(`/faculty/${newId}?added=1`);
  } catch (err) {
    res.render('add', {
      error: err.message,
      duplicateMatch: null,
      formData: req.body || {}
    });
  }
});

// View faculty detail
app.get('/faculty/:id', (req, res) => {
  try {
    const faculty = db.getFacultyById(parseInt(req.params.id));
    if (!faculty) return res.status(404).render('404', {});

    const isPrivate = (faculty.visibility || 'public') === 'private';
    if (isPrivate && !req.isAdmin) {
      const pendingReq = db.getPendingRequestForFaculty(faculty.id);
      return res.render('private_profile', {
        faculty,
        pendingReq,
        requestSubmitted: req.query.requested === '1',
        query: req.query
      });
    }

    res.render('detail', { faculty, rosColor, rosLabel, query: req.query, pendingDuplicatePub: null });
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Request to make private profile public (submitted by faculty/visitor)
app.post('/faculty/:id/request-public', (req, res) => {
  try {
    const facultyId = parseInt(req.params.id);
    const faculty = db.getFacultyById(facultyId);
    if (!faculty) return res.status(404).render('404', {});

    const { requester_email, message } = req.body;
    db.addProfileRequest({
      faculty_id: facultyId,
      faculty_name: faculty.name,
      employee_code: faculty.employee_code,
      requester_email,
      message
    });

    res.redirect(`/faculty/${facultyId}?requested=1`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Admin toggle/set faculty profile visibility (Public vs Private)
app.post('/faculty/:id/visibility', requireAdmin, (req, res) => {
  try {
    const facultyId = parseInt(req.params.id);
    const faculty = db.getFacultyById(facultyId);
    if (!faculty) return res.status(404).render('404', {});

    const currentVis = (faculty.visibility || 'public').toLowerCase();
    const newVis = req.body.visibility ? req.body.visibility.toLowerCase() : (currentVis === 'private' ? 'public' : 'private');
    db.setFacultyVisibility(facultyId, newVis);

    const returnTo = req.body.return_to || `/faculty/${facultyId}`;
    res.redirect(returnTo);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Add single publication record (with duplicate check & Add / Replace option)
app.post('/faculty/:id/publications', requireAdmin, (req, res) => {
  try {
    const facultyId = parseInt(req.params.id);
    const faculty = db.getFacultyById(facultyId);
    if (!faculty) return res.status(404).render('404', {});

    const {
      document_type, title, source_title, author_name, ros, quartile,
      link, apn, scopus_link, eid, month, pub_department, dup_action, replace_pub_id
    } = req.body;

    if (!title || !title.trim()) {
      return res.redirect(`/faculty/${facultyId}?error=missing_title`);
    }

    const docType = normalizeDocType(document_type);
    const pubType = resolvePubTypeFromDocType(docType);
    const resolvedQuartile = normalizeQuartileForPubType(quartile, pubType);
    const pubData = {
      pub_type: pubType,
      document_type: docType,
      title: title.trim(),
      source_title: (source_title || '').trim(),
      author_name: (author_name || '').trim(),
      ros: parseFloat(ros) || 0.0,
      quartile: resolvedQuartile,
      link: (link || '').trim(),
      apn: (apn || '').trim(),
      scopus_link: (scopus_link || '').trim(),
      eid: (eid || '').trim(),
      month: month || new Date().toISOString().substring(0, 7),
      pub_department: db.normalizePubDepartment(pub_department)
    };

    if (dup_action === 'replace' && replace_pub_id) {
      db.recordUndoState(`Replace Publication: ${pubData.title.slice(0, 35)}`);
      db.updatePublication(parseInt(replace_pub_id, 10), pubData);
      return res.redirect(`/faculty/${facultyId}?pub_replaced=1`);
    }

    if (dup_action !== 'add_new') {
      const dup = db.findDuplicatePublication(facultyId, pubData.title, pubData.eid);
      if (dup) {
        const faculty = db.getFacultyById(facultyId);
        if (!faculty) return res.status(404).render('404', {});
        return res.render('detail', {
          faculty,
          rosColor,
          rosLabel,
          query: req.query,
          pendingDuplicatePub: {
            existing: dup.existing,
            matchReason: dup.matchReason,
            incoming: pubData
          }
        });
      }
    }

    db.recordUndoState(`Add Publication: ${pubData.title.slice(0, 35)}`);
    db.addPublication(facultyId, pubData);
    res.redirect(`/faculty/${facultyId}?pub_added=1`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Edit single publication record
app.post('/faculty/:id/publications/:pubId/edit', requireAdmin, (req, res) => {
  try {
    const facultyId = parseInt(req.params.id);
    const pubId = parseInt(req.params.pubId);
    const { document_type, title, source_title, author_name, ros, quartile, link, apn, scopus_link, eid, month, pub_department } = req.body;

    if (!title || !title.trim()) {
      return res.redirect(`/faculty/${facultyId}?error=missing_title`);
    }

    const docType = normalizeDocType(document_type);
    const pubType = resolvePubTypeFromDocType(docType);
    const resolvedQuartile = normalizeQuartileForPubType(quartile, pubType);

    db.recordUndoState(`Edit Publication: ${title.trim().slice(0, 35)}`);
    db.updatePublication(pubId, {
      pub_type: pubType,
      document_type: docType,
      title: title.trim(),
      source_title: (source_title || '').trim(),
      author_name: (author_name || '').trim(),
      ros: parseFloat(ros) || 0.0,
      quartile: resolvedQuartile,
      link: (link || '').trim(),
      apn: (apn || '').trim(),
      scopus_link: (scopus_link || '').trim(),
      eid: (eid || '').trim(),
      month: month || new Date().toISOString().substring(0, 7),
      pub_department: db.normalizePubDepartment(pub_department)
    });

    res.redirect(`/faculty/${facultyId}?pub_updated=1`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Upload Publications Excel for a single faculty member (with duplicate check)
app.post('/faculty/:id/upload-publications-excel', requireAdmin, upload.single('publications_excel'), (req, res) => {
  const facultyId = parseInt(req.params.id);
  try {
    if (!req.file) {
      return res.redirect(`/faculty/${facultyId}?pub_err=No file uploaded`);
    }

    const faculty = db.getFacultyById(facultyId);
    if (!faculty) {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      return res.status(404).render('404', {});
    }

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rawData = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const itemsToImport = rawData
      .map(r => parseExcelPublicationRow(r, faculty.name))
      .filter(Boolean)
      .map(pubData => ({
        facultyId,
        facultyName: faculty.name,
        facultyCode: faculty.employee_code,
        pubData
      }));

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    if (itemsToImport.length === 0) {
      return res.redirect(`/faculty/${facultyId}?pub_err=No valid publication records found.`);
    }

    const analysis = db.analyzePublicationsUpload(itemsToImport);
    if (analysis.duplicateItems.length > 0) {
      return res.render('pub_upload_confirm', {
        scopeTitle: faculty.name,
        confirmAction: `/faculty/${facultyId}/upload-publications-excel/confirm`,
        backUrl: `/faculty/${facultyId}`,
        newItems: analysis.newItems,
        duplicateItems: analysis.duplicateItems,
        newItemsJson: JSON.stringify(analysis.newItems),
        duplicateItemsJson: JSON.stringify(analysis.duplicateItems),
        unmatchedCount: 0,
        unmatchedNames: ''
      });
    }

    if (analysis.newItems.length > 0) {
      db.recordUndoState(`Faculty Excel Upload: ${faculty.name} (+${analysis.newItems.length})`);
    }
    const result = db.applyPublicationsUpload(analysis.newItems, [], 'skip');
    res.redirect(`/faculty/${facultyId}?pub_upload_success=1&count=${result.addedCount}&replaced=0&skipped=0`);
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.redirect(`/faculty/${facultyId}?pub_err=` + encodeURIComponent(err.message));
  }
});

// Confirm Single Faculty Publications Excel Upload (Replace / Skip / Add All)
app.post('/faculty/:id/upload-publications-excel/confirm', requireAdmin, (req, res) => {
  const facultyId = parseInt(req.params.id);
  try {
    const { new_items_json, duplicate_items_json, decision } = req.body;
    const newItems = JSON.parse(new_items_json || '[]');
    const duplicateItems = JSON.parse(duplicate_items_json || '[]');
    if (newItems.length > 0 || (duplicateItems.length > 0 && decision !== 'skip')) {
      db.recordUndoState(`Confirm Faculty Pub Upload (${newItems.length} new, dup=${decision})`);
    }
    const result = db.applyPublicationsUpload(newItems, duplicateItems, decision);

    res.redirect(`/faculty/${facultyId}?pub_upload_success=1&count=${result.addedCount}&replaced=${result.replacedCount}&skipped=${result.skippedCount}`);
  } catch (err) {
    res.redirect(`/faculty/${facultyId}?pub_err=` + encodeURIComponent(err.message));
  }
});

// Delete single publication
app.post('/faculty/:id/publications/:pubId/delete', requireAdmin, (req, res) => {
  try {
    const facultyId = parseInt(req.params.id);
    const pubId = parseInt(req.params.pubId);
    db.recordUndoState('Delete Publication');
    db.deletePublication(pubId);
    res.redirect(`/faculty/${facultyId}?deleted_single=1`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Delete multiple publications at once
app.post('/faculty/:id/publications/delete-multiple', requireAdmin, (req, res) => {
  try {
    const facultyId = parseInt(req.params.id);
    let { pub_ids } = req.body;

    if (!pub_ids) return res.redirect(`/faculty/${facultyId}`);

    if (!Array.isArray(pub_ids)) pub_ids = [pub_ids];
    const ids = pub_ids.map(id => parseInt(id)).filter(id => !isNaN(id));

    if (ids.length > 0) {
      db.recordUndoState(`Delete ${ids.length} Publications`);
    }
    const count = db.deletePublicationsMultiple(ids);
    res.redirect(`/faculty/${facultyId}?deleted_multiple=${count}`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Edit faculty form
app.get('/faculty/:id/edit', requireAdmin, (req, res) => {
  try {
    const faculty = db.getFacultyById(parseInt(req.params.id));
    if (!faculty) return res.status(404).render('404', {});
    res.render('edit', { faculty, error: null });
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Edit faculty POST
app.post('/faculty/:id/edit', requireAdmin, upload.single('photo'), (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, employee_code, designation, department, scopus_id, member_type, status, visibility } = req.body;

    if (!name || !employee_code) {
      const faculty = db.getFacultyById(id);
      return res.render('edit', { faculty, error: 'Name and Employee Code are required.' });
    }

    const existing = db.getFacultyByEmployeeCode(employee_code.trim());
    if (existing && existing.id !== id) {
      if (req.file) fs.unlinkSync(req.file.path);
      const faculty = db.getFacultyById(id);
      return res.render('edit', { faculty, error: `Employee code "${employee_code}" is already used.` });
    }

    const photo = req.file ? req.file.filename : null;
    db.recordUndoState(`Edit Faculty: ${name.trim()}`);
    db.updateFaculty(id, {
      name: name.trim(),
      employee_code: employee_code.trim(),
      designation,
      department,
      scopus_id,
      member_type,
      status,
      visibility,
      photo
    });

    res.redirect(`/faculty/${id}?updated=1`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Delete faculty POST
app.post('/faculty/:id/delete', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const faculty = db.getFacultyById(id);
    db.recordUndoState(`Delete Faculty: ${faculty ? faculty.name : id}`);
    db.deleteFaculty(id);
    res.redirect('/portal?deleted=1');
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// API endpoint
app.get('/api/faculty', (req, res) => {
  try {
    const { ros, search } = req.query;
    let faculty = db.getAllFacultyWithStats();
    if (ros !== undefined) {
      const maxRos = parseFloat(ros) || 0;
      faculty = faculty.filter(f => f.ros <= maxRos);
    }
    if (search) {
      const q = search.toLowerCase();
      faculty = faculty.filter(f =>
        f.name.toLowerCase().includes(q) || f.employee_code.toLowerCase().includes(q)
      );
    }
    res.json(faculty);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Drill-down endpoint for clicking any ROS / paper count cell in Home ROS tables
app.get('/api/ros-cell-details', (req, res) => {
  try {
    const { year, month, scope, quartile } = req.query;
    const details = db.getRosCellDetails({ year, month, scope, quartile });
    res.json(details);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 404
// ─── RESEARCH PROOF DOCUMENT ROUTES ─────────────────────────────────────────

// API: unread document count (for notification badge)
app.get('/api/documents/unread-count', requireAdmin, (req, res) => {
  try {
    const count = db.getUnreadDocumentCount();
    res.json({ count });
  } catch (e) {
    res.json({ count: 0 });
  }
});

// Faculty uploads their own document (PUBLIC - no login needed)
app.post('/faculty/:id/upload-doc', uploadDoc.single('doc_file'), (req, res) => {
  const id = parseInt(req.params.id);
  const isAdmin = req.isAdmin;
  try {
    if (!req.file) {
      return res.redirect(`/faculty/${id}?tab=docs&doc_error=No+file+selected+or+invalid+file+type`);
    }
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const fileType = ext === 'pdf' ? 'pdf' : 'docx';
    db.addFacultyDocument(id, {
      uploader_type: isAdmin ? 'admin' : 'faculty',
      original_name: req.file.originalname,
      stored_filename: req.file.filename,
      file_type: fileType,
      file_size: req.file.size,
      description: (req.body.doc_description || '').trim()
    });
    res.redirect(`/faculty/${id}?tab=docs&doc_success=1`);
  } catch (e) {
    console.error('Doc upload error:', e);
    // If file was saved, delete it on error
    if (req.file) {
      try { fs.unlinkSync(req.file.path); } catch (_) {}
    }
    res.redirect(`/faculty/${id}?tab=docs&doc_error=${encodeURIComponent(e.message)}`);
  }
});

// Admin: view all documents panel
app.get('/admin/documents', requireAdmin, (req, res) => {
  try {
    const filters = {
      status: req.query.status || 'all',
      search: req.query.search || '',
      uploader_type: req.query.uploader_type || 'all'
    };
    const documents = db.getAllFacultyDocuments(filters);
    const pendingCount = db.getUnreadDocumentCount();
    res.render('admin_documents', {
      documents,
      pendingCount,
      filters,
      query: req.query,
      isAdmin: true,
      success: req.query.success || null,
      error: req.query.error || null
    });
  } catch (e) {
    console.error('Admin docs error:', e);
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
});

// Admin: download a document
app.get('/admin/documents/:id/download', requireAdmin, (req, res) => {
  try {
    const docs = db.getAllFacultyDocuments({});
    const doc = docs.find(d => d.id === parseInt(req.params.id));
    if (!doc) return res.status(404).send('Document not found');
    const filePath = path.join(__dirname, 'uploads', 'documents', doc.stored_filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found on disk');
    res.download(filePath, doc.original_name);
  } catch (e) {
    res.status(500).send('Download error: ' + e.message);
  }
});

// Admin: mark document as reviewed
app.post('/admin/documents/:id/mark-reviewed', requireAdmin, (req, res) => {
  try {
    db.markDocumentReviewed(parseInt(req.params.id));
    const back = req.body.return_to || req.headers.referer || '/admin/documents';
    res.redirect(back + (back.includes('?') ? '&' : '?') + 'success=Document+marked+as+reviewed');
  } catch (e) {
    res.redirect('/admin/documents?error=' + encodeURIComponent(e.message));
  }
});

// Admin: delete a document
app.post('/admin/documents/:id/delete', requireAdmin, (req, res) => {
  try {
    const doc = db.deleteFacultyDocument(parseInt(req.params.id));
    // Remove file from disk
    const filePath = path.join(__dirname, 'uploads', 'documents', doc.stored_filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (_) {}
    }
    const back = req.body.return_to || req.headers.referer || '/admin/documents';
    res.redirect(back + (back.includes('?') ? '&' : '?') + 'success=Document+deleted');
  } catch (e) {
    res.redirect('/admin/documents?error=' + encodeURIComponent(e.message));
  }
});

// Admin: Profile Visibility Requests Panel
app.get('/admin/profile-requests', requireAdmin, (req, res) => {
  try {
    const filters = {
      status: req.query.status || 'all',
      search: req.query.search || ''
    };
    const requests = db.getAllProfileRequests(filters);
    const stats = db.getProfileRequestStats();

    // Attach current faculty visibility to each request for display
    requests.forEach(r => {
      const fac = db.getFacultyById(r.faculty_id);
      r.faculty_visibility = fac ? (fac.visibility || 'public') : 'unknown';
    });

    res.render('admin_profile_requests', {
      requests,
      stats,
      filters,
      query: req.query,
      isAdmin: true
    });
  } catch (e) {
    console.error('Admin profile requests error:', e);
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
});

// Admin: Decide profile request (approve -> makes profile public, or reject)
app.post('/admin/profile-requests/:id/decide', requireAdmin, (req, res) => {
  try {
    const { action, admin_note } = req.body;
    db.decideProfileRequest(parseInt(req.params.id), action, admin_note);
    const back = req.body.return_to || '/admin/profile-requests';
    const flag = action === 'approve' ? 'approved=1' : 'rejected=1';
    res.redirect(back + (back.includes('?') ? '&' : '?') + flag);
  } catch (e) {
    res.redirect('/admin/profile-requests?error=' + encodeURIComponent(e.message));
  }
});

// Admin: Delete profile request
app.post('/admin/profile-requests/:id/delete', requireAdmin, (req, res) => {
  try {
    db.deleteProfileRequest(parseInt(req.params.id));
    const back = req.body.return_to || '/admin/profile-requests';
    res.redirect(back + (back.includes('?') ? '&' : '?') + 'deleted=1');
  } catch (e) {
    res.redirect('/admin/profile-requests?error=' + encodeURIComponent(e.message));
  }
});

// API: Pending profile requests count
app.get('/api/profile-requests/pending-count', requireAdmin, (req, res) => {
  try {
    const count = db.getPendingProfileRequestsCount();
    res.json({ ok: true, count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.use((req, res) => {
  res.status(404).render('404', {});
});

// Start
async function start() {
  await db.initDB();
  db.seedIfEmpty();
  app.listen(PORT, () => {
    console.log(`\n🔬 UIC Research Portal running at http://localhost:${PORT}\n`);
  });
}

start().catch(err => {
  console.error("Failed to start server:", err);
});
