/**
 * UIC Research Portal — Dark & Light Theme Switcher
 * Supports automatic system detection, persistence via localStorage,
 * anti-flicker on page load, and synchronized UI controls.
 */
(function () {
  'use strict';

  var THEME_KEY = 'uic-theme';

  function getStoredTheme() {
    try {
      return localStorage.getItem(THEME_KEY);
    } catch (e) {
      return null;
    }
  }

  function getPreferredTheme() {
    var stored = getStoredTheme();
    if (stored === 'dark' || stored === 'light') return stored;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  function applyTheme(theme, save) {
    if (theme !== 'dark' && theme !== 'light') theme = 'light';
    document.documentElement.setAttribute('data-bs-theme', theme);
    document.documentElement.setAttribute('data-theme', theme);

    if (save) {
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (e) {}
    }

    updateToggleButtons(theme);

    // Notify any page listeners (e.g. Chart.js)
    try {
      window.dispatchEvent(new CustomEvent('uicThemeChanged', { detail: { theme: theme } }));
    } catch (e) {}
  }

  function updateToggleButtons(theme) {
    var isDark = theme === 'dark';
    var buttons = document.querySelectorAll('.theme-toggle-btn');
    buttons.forEach(function (btn) {
      var icon = btn.querySelector('.theme-icon') || btn.querySelector('i');
      var label = btn.querySelector('.theme-label');

      if (isDark) {
        if (icon) {
          icon.className = 'fas fa-sun text-warning theme-icon';
        }
        if (label) {
          label.textContent = 'Light Mode';
        }
        btn.setAttribute('title', 'Switch to Light Theme');
        btn.setAttribute('aria-label', 'Switch to Light Theme');
      } else {
        if (icon) {
          icon.className = 'fas fa-moon text-primary theme-icon';
        }
        if (label) {
          label.textContent = 'Dark Mode';
        }
        btn.setAttribute('title', 'Switch to Dark Theme');
        btn.setAttribute('aria-label', 'Switch to Dark Theme');
      }
    });
  }

  function toggleTheme() {
    var current = document.documentElement.getAttribute('data-bs-theme') || 'light';
    var next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next, true);
  }

  // Expose toggle on window
  window.toggleUicTheme = toggleTheme;
  window.setUicTheme = function(t) { applyTheme(t, true); };

  // 1. Immediate execution: apply theme as early as script parses (anti-flicker)
  var initialTheme = getPreferredTheme();
  document.documentElement.setAttribute('data-bs-theme', initialTheme);
  document.documentElement.setAttribute('data-theme', initialTheme);

  // 2. DOM Ready setup: attach click handlers and inject floating button
  function initThemeUI() {
    applyTheme(document.documentElement.getAttribute('data-bs-theme') || initialTheme, false);

    // Event delegation for any theme toggle button
    document.addEventListener('click', function (e) {
      var btn = e.target.closest('.theme-toggle-btn') || e.target.closest('[data-theme-toggle]');
      if (btn) {
        e.preventDefault();
        toggleTheme();
      }
    });

    // Inject floating toggle if not already present
    if (!document.getElementById('floatingThemeToggle')) {
      var floatBtn = document.createElement('button');
      floatBtn.id = 'floatingThemeToggle';
      floatBtn.type = 'button';
      floatBtn.className = 'theme-toggle-btn floating-theme-btn shadow';
      floatBtn.setAttribute('title', initialTheme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme');
      floatBtn.setAttribute('aria-label', 'Toggle Dark / Light Theme');
      floatBtn.innerHTML = '<i class="' + (initialTheme === 'dark' ? 'fas fa-sun text-warning theme-icon' : 'fas fa-moon text-primary theme-icon') + '"></i>';
      document.body.appendChild(floatBtn);
    }

    // System preference change listener (only if user hasn't explicitly chosen)
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
        if (!getStoredTheme()) {
          applyTheme(e.matches ? 'dark' : 'light', false);
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initThemeUI);
  } else {
    initThemeUI();
  }
})();
