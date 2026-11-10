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
  next();
});

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

// 1. First Page / Landing Page: Introduction to UIC Department Research, Director, Campus, Heads, Coordinator
app.get('/', (req, res) => {
  try {
    const faculty = db.getAllFacultyWithStats();
    const totalFaculty = faculty.length;
    const totalPubs = faculty.reduce((sum, f) => sum + (f.total_pubs || 0), 0);
    const q1Count = faculty.reduce((sum, f) => sum + (f.q1 || 0), 0);
    const activeCount = faculty.filter(f => f.ros > 0).length;
    const avgROS = totalFaculty ? (faculty.reduce((s, f) => s + f.ros, 0) / totalFaculty).toFixed(2) : '0.00';

    // Support dropdown selection of reporting year (e.g. 2024, 2025, 2026, 2027, 2028, 2029, 2030)
    const yearsList = [2024, 2025, 2026, 2027, 2028, 2029, 2030];
    const selectedYear = parseInt(req.query.year, 10) || 2026;
    const allYearsROS = db.getAllYearsMonthlyROS(yearsList);
    const monthlyROS = allYearsROS[selectedYear] || db.getDepartmentMonthlyROS(selectedYear);
    const allYearsTopPerformers = db.getAllYearsTopPerformers(yearsList, 20);
    const topPerformers = allYearsTopPerformers[selectedYear] || db.getTopPerformersByYear(selectedYear, 20);

    res.render('home', {
      totalFaculty,
      totalPubs,
      q1Count,
      activeCount,
      avgROS,
      selectedYear,
      allYearsROS,
      monthlyROS,
      allYearsTopPerformers,
      topPerformers,
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

    res.render('index', {
      faculty,
      totalFaculty,
      avgROS,
      zeroCount,
      activeCount,
      rosColor,
      rosLabel,
      viewMode,
      sortMode,
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
        'EID': '105053427146'
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
        'EID': '2-s2.0-85192837190'
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
        'EID': '2-s2.0-85201928371'
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

// Download sample Excel template for faculty members list
app.get('/download-template', (req, res) => {
  try {
    const sampleRows = [
      { 'Sr. No': 1, 'Faculty Name': 'Neeraj Narwat', 'Employee Code': 'EMP101', 'Designation': 'Associate Professor', 'Department': 'Agriculture' },
      { 'Sr. No': 2, 'Faculty Name': 'Dr. Sarah Ahmed', 'Employee Code': 'EMP102', 'Designation': 'Professor', 'Department': 'Computer Science' }
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
    month: monthStr
  };
}

// ─── MASTER DASHBOARD EXCEL UPLOAD ──────────────────────────────────
// Matches Column D: "Author names (CU)" to faculty name and checks duplicate publications
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
    let unmatchedCount = 0;
    const unmatchedNames = new Set();

    rawData.forEach(r => {
      const pubData = parseExcelPublicationRow(r);
      if (!pubData) return;

      const authorQuery = pubData.author_name;
      if (!authorQuery) {
        unmatchedCount++;
        return;
      }

      const faculty = db.findFacultyByName(authorQuery);
      if (!faculty) {
        unmatchedCount++;
        unmatchedNames.add(authorQuery);
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

    const analysis = db.analyzePublicationsUpload(itemsToImport);
    const sampleUnmatched = Array.from(unmatchedNames).slice(0, 3).join(', ');

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
        unmatchedNames: sampleUnmatched
      });
    }

    const result = db.applyPublicationsUpload(analysis.newItems, [], 'skip');
    let redirectUrl = `/portal?master_success=1&matched=${result.addedCount}&replaced=0&skipped=0&unmatched=${unmatchedCount}`;
    if (sampleUnmatched) {
      redirectUrl += `&unmatched_names=${encodeURIComponent(sampleUnmatched)}`;
    }
    res.redirect(redirectUrl);
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.redirect('/portal?master_err=' + encodeURIComponent(err.message));
  }
});

// Confirm Master Publications Excel Upload (Replace / Skip / Add All)
app.post('/dashboard/upload-publications-master/confirm', requireAdmin, (req, res) => {
  try {
    const { new_items_json, duplicate_items_json, decision, unmatched_count, unmatched_names } = req.body;
    const newItems = JSON.parse(new_items_json || '[]');
    const duplicateItems = JSON.parse(duplicate_items_json || '[]');
    const result = db.applyPublicationsUpload(newItems, duplicateItems, decision);

    let redirectUrl = `/portal?master_success=1&matched=${result.addedCount}&replaced=${result.replacedCount}&skipped=${result.skippedCount}&unmatched=${unmatched_count || 0}`;
    if (unmatched_names) {
      redirectUrl += `&unmatched_names=${encodeURIComponent(unmatched_names)}`;
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
      const code = r['Employee Code'] || r['employee code'] || r['Code'] || r['employee_code'] || r['EMP Code'] || r['emp_code'];
      const designation = r['Designation'] || r['designation'] || '';
      const department = r['Department'] || r['department'] || '';

      return {
        name: name ? String(name).trim() : '',
        employee_code: code ? String(code).trim() : '',
        designation: designation ? String(designation).trim() : '',
        department: department ? String(department).trim() : ''
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

    const result = db.deleteFacultyMultiple(ids);
    result.photos.forEach(photo => {
      const p = path.join(__dirname, 'uploads', photo);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    res.redirect(`/portal?bulk_deleted=${result.deletedCount}`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Delete ALL Faculty
app.post('/faculty/delete-all', requireAdmin, (req, res) => {
  try {
    const result = db.deleteAllFaculty();
    result.photos.forEach(photo => {
      const p = path.join(__dirname, 'uploads', photo);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    });

    res.redirect(`/portal?all_deleted=${result.deletedCount}`);
  } catch (err) {
    res.status(500).send('Server error: ' + err.message);
  }
});

// Add single faculty form
app.get('/faculty/add', requireAdmin, (req, res) => {
  res.render('add', { error: null, duplicateMatch: null, formData: {} });
});

// Add single faculty POST (checks BOTH Name and Employee Code and asks to replace if existing)
app.post('/faculty/add', requireAdmin, upload.single('photo'), (req, res) => {
  try {
    const { name, employee_code, designation, department, confirm_replace, replace_id, pending_photo } = req.body;

    if (!name || !employee_code) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.render('add', {
        error: 'Name and Employee Code are required.',
        duplicateMatch: null,
        formData: { name, employee_code, designation, department }
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
          formData: { name, employee_code, designation, department }
        });
      }

      const newPhoto = req.file ? req.file.filename : (pending_photo || null);
      const oldFaculty = db.getFacultyById(targetId);
      if (newPhoto && oldFaculty && oldFaculty.photo && oldFaculty.photo !== newPhoto) {
        const oldPath = path.join(__dirname, 'uploads', oldFaculty.photo);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      db.updateFaculty(targetId, {
        name: name.trim(),
        employee_code: employee_code.trim(),
        designation: designation || '',
        department: department || '',
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
          pending_photo: savedPendingPhoto
        }
      });
    }

    const photo = req.file ? req.file.filename : (pending_photo || null);
    const newId = db.addFaculty({
      name: name.trim(),
      employee_code: employee_code.trim(),
      designation,
      department,
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
    res.render('detail', { faculty, rosColor, rosLabel, query: req.query, pendingDuplicatePub: null });
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
      link, apn, scopus_link, eid, month, dup_action, replace_pub_id
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
      month: month || new Date().toISOString().substring(0, 7)
    };

    if (dup_action === 'replace' && replace_pub_id) {
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
    const { document_type, title, source_title, author_name, ros, quartile, link, apn, scopus_link, eid, month } = req.body;

    if (!title || !title.trim()) {
      return res.redirect(`/faculty/${facultyId}?error=missing_title`);
    }

    const docType = normalizeDocType(document_type);
    const pubType = resolvePubTypeFromDocType(docType);
    const resolvedQuartile = normalizeQuartileForPubType(quartile, pubType);

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
      month: month || new Date().toISOString().substring(0, 7)
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
    const { name, employee_code, designation, department } = req.body;

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
    db.updateFaculty(id, {
      name: name.trim(),
      employee_code: employee_code.trim(),
      designation,
      department,
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
    if (faculty && faculty.photo) {
      const photoPath = path.join(__dirname, 'uploads', faculty.photo);
      if (fs.existsSync(photoPath)) fs.unlinkSync(photoPath);
    }
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

// 404
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
