/* =========================================================
   UIC Research Portal — app.js (client-side)
   ========================================================= */

// ── ROS helpers ──────────────────────────────────────────
function rosColorClass(ros) {
  if (ros <= 0)   return 'danger';
  if (ros < 0.3)  return 'warning';
  if (ros < 0.6)  return 'info';
  return 'success';
}

function rosLabel(ros) {
  if (ros <= 0)   return 'No Publications';
  if (ros < 0.3)  return 'Low';
  if (ros < 0.6)  return 'Moderate';
  if (ros < 0.8)  return 'Good';
  return 'Excellent';
}

// ── ROS Manual Display (Add/Edit forms) ──────────────────
function updateROSDisplay(val) {
  const ros = Math.min(Math.max(parseFloat(val) || 0, 0), 1);
  const pct = Math.round(ros * 100);
  const color = rosColorClass(ros);
  const label = rosLabel(ros);

  const colorMap = {
    danger:  '#dc2626',
    warning: '#d97706',
    info:    '#0891b2',
    success: '#16a34a'
  };
  const fillClass = `ros-bar-fill ros-fill-${color}`;

  const fill   = document.getElementById('rosBarFill');
  const badge  = document.getElementById('rosDisplayBadge');
  const slider = document.getElementById('rosSlider');
  const input  = document.getElementById('rosInput');

  if (fill)   { fill.style.width = pct + '%'; fill.className = fillClass; }
  if (badge)  {
    badge.textContent = `${ros.toFixed(2)} — ${label}`;
    badge.className = `ros-display-badge badge-${color}`;
  }
  if (slider) slider.value = ros;
  if (input && document.activeElement !== input) input.value = ros.toFixed(2);
}

// Sync slider → number input
function syncSlider(val) {
  const ros = parseFloat(val) || 0;
  const input = document.getElementById('rosInput');
  if (input) { input.value = ros.toFixed(2); }
  updateROSDisplay(ros);
}

// Initialize ROS display on page load
function initROSDisplay() {
  const input = document.getElementById('rosInput');
  if (input) updateROSDisplay(input.value);
}

// ── Photo Preview ────────────────────────────────────────
function setupPhotoPreview() {
  const fileInput   = document.getElementById('photo');
  const preview     = document.getElementById('photoPreview');
  const placeholder = document.getElementById('photoPlaceholder');
  const wrap        = document.getElementById('photoPreviewWrap');

  if (!fileInput) return;

  if (wrap) {
    wrap.addEventListener('click', () => fileInput.click());
  }

  fileInput.addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      if (preview) {
        preview.src = e.target.result;
        preview.style.display = 'block';
      }
      if (placeholder) placeholder.style.display = 'none';
    };
    reader.readAsDataURL(file);
  });
}

// ── Dashboard Filter ─────────────────────────────────────
function setupFilters() {
  const filterBtns = document.querySelectorAll('.filter-btn');
  filterBtns.forEach(btn => {
    btn.addEventListener('click', function () {
      filterBtns.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      applyFilters();
    });
  });

  const catBtns = document.querySelectorAll('.cat-filter-btn');
  catBtns.forEach(btn => {
    btn.addEventListener('click', function () {
      catBtns.forEach(b => b.classList.remove('active', 'btn-primary', 'text-white'));
      catBtns.forEach(b => b.classList.add('btn-outline-primary'));
      this.classList.remove('btn-outline-primary');
      this.classList.add('active', 'btn-primary', 'text-white');
      applyFilters();
    });
  });

  const statusBtns = document.querySelectorAll('.status-filter-btn');
  statusBtns.forEach(btn => {
    btn.addEventListener('click', function () {
      statusBtns.forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      applyFilters();
    });
  });
}

function setupSearch() {
  const searchInput = document.getElementById('searchInput');
  const clearBtn    = document.getElementById('clearSearch');
  if (!searchInput) return;

  searchInput.addEventListener('input', function () {
    if (clearBtn) clearBtn.classList.toggle('visible', this.value.length > 0);
    applyFilters();
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      searchInput.value = '';
      clearBtn.classList.remove('visible');
      applyFilters();
    });
  }
}

function applyFilters() {
  const activeBtn   = document.querySelector('.filter-btn.active');
  const filterType  = activeBtn ? activeBtn.dataset.filter : 'all';
  const activeCatBtn = document.querySelector('.cat-filter-btn.active');
  const catType     = activeCatBtn ? activeCatBtn.dataset.cat : 'all';
  const activeStatusBtn = document.querySelector('.status-filter-btn.active');
  const statusType  = activeStatusBtn ? activeStatusBtn.dataset.statusFilter : 'all';
  const searchQuery = (document.getElementById('searchInput')?.value || '').toLowerCase().trim();

  const cards = document.querySelectorAll('.faculty-card-wrap');
  let visibleCount = 0;

  cards.forEach(card => {
    const ros  = parseFloat(card.dataset.ros) || 0;
    const name = card.dataset.name || '';
    const code = card.dataset.code || '';
    const scopus = card.dataset.scopus || '';
    const memberType = card.dataset.memberType || 'Faculty';
    const memberStatus = card.dataset.status || 'Active';

    let rosMatch = true;
    if (filterType === 'zero')          rosMatch = ros === 0;
    else if (filterType === 'low')      rosMatch = ros > 0 && ros < 0.3;
    else if (filterType === 'moderate') rosMatch = ros >= 0.3 && ros < 0.6;
    else if (filterType === 'good')     rosMatch = ros >= 0.6;

    const catMatch = catType === 'all' || memberType === catType;
    const statusMatch = statusType === 'all' || memberStatus === statusType;
    const searchMatch = !searchQuery || name.includes(searchQuery) || code.includes(searchQuery) || scopus.includes(searchQuery);

    const show = rosMatch && catMatch && statusMatch && searchMatch;
    card.style.display = show ? '' : 'none';
    if (show) visibleCount++;
  });

  const noResults = document.getElementById('noResults');
  const grid      = document.getElementById('facultyGrid');
  if (noResults) {
    if (visibleCount === 0 && cards.length > 0) {
      noResults.style.display = 'block';
      if (grid) grid.style.display = 'none';
    } else {
      noResults.style.display = 'none';
      if (grid) grid.style.display = '';
    }
  }
  if (typeof window.updateFacultySelectionUI === 'function') {
    window.updateFacultySelectionUI();
  }
}

// ── URL param toasts ─────────────────────────────────────
function checkURLParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get('added')   === '1') showToast('Faculty record added successfully!', 'success');
  if (params.get('updated') === '1') showToast('Faculty record updated!', 'info');
  if (params.get('deleted') === '1') showToast('Faculty record deleted.', 'warning');
  if (params.has('added') || params.has('updated') || params.has('deleted')) {
    history.replaceState({}, '', window.location.pathname);
  }
}

function showToast(msg, type) {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const bgMap = { success: '#16a34a', info: '#0891b2', warning: '#d97706', danger: '#dc2626' };
  const html = `
    <div class="toast show align-items-center text-white border-0" style="background:${bgMap[type]||'#1a3a5c'};min-width:260px" role="alert">
      <div class="d-flex">
        <div class="toast-body fw-semibold">${msg}</div>
        <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
      </div>
    </div>`;
  container.insertAdjacentHTML('beforeend', html);
  const toast = container.lastElementChild;
  setTimeout(() => toast.remove(), 4000);
}

// ── Init ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  setupPhotoPreview();
  setupFilters();
  setupSearch();
  initROSDisplay();
  checkURLParams();
});
