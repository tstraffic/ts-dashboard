// T&S Dashboard - Client-side JavaScript

// ===== Mobile Sidebar Toggle =====
(function() {
  const toggle = document.getElementById('sidebar-toggle');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');

  if (toggle && sidebar && backdrop) {
    function openSidebar() {
      sidebar.classList.add('sidebar-open');
      backdrop.classList.add('backdrop-visible');
      document.body.style.overflow = 'hidden';
    }

    function closeSidebar() {
      sidebar.classList.remove('sidebar-open');
      backdrop.classList.remove('backdrop-visible');
      document.body.style.overflow = '';
    }

    toggle.addEventListener('click', function(e) {
      e.stopPropagation();
      if (sidebar.classList.contains('sidebar-open')) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });

    // Close on backdrop tap
    backdrop.addEventListener('click', closeSidebar);

    // Close on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeSidebar();
    });

    // Close sidebar when a nav link is tapped (mobile)
    sidebar.querySelectorAll('a').forEach(function(link) {
      link.addEventListener('click', function() {
        if (window.innerWidth < 1024) {
          closeSidebar();
        }
      });
    });

    // Close sidebar on window resize to desktop
    window.addEventListener('resize', function() {
      if (window.innerWidth >= 1024) {
        closeSidebar();
      }
    });
  }
})();

// ===== Auto-dismiss flash messages after 5 seconds =====
document.querySelectorAll('[data-auto-dismiss]').forEach(el => {
  setTimeout(() => el.remove(), 5000);
});

// ===== Confirm before delete actions =====
document.querySelectorAll('form[data-confirm]').forEach(form => {
  form.addEventListener('submit', (e) => {
    if (!confirm(form.dataset.confirm || 'Are you sure?')) {
      e.preventDefault();
    }
  });
});

// ===== Tab navigation (for job detail page) =====
function initTabs() {
  const tabLinks = document.querySelectorAll('[data-tab]');
  const tabPanels = document.querySelectorAll('[data-tab-panel]');

  if (tabLinks.length === 0) return;

  function activateTab(tabName) {
    tabLinks.forEach(link => {
      const isActive = link.dataset.tab === tabName;
      link.classList.toggle('border-brand-600', isActive);
      link.classList.toggle('text-brand-700', isActive);
      link.classList.toggle('border-transparent', !isActive);
      link.classList.toggle('text-gray-500', !isActive);
    });
    tabPanels.forEach(panel => {
      panel.classList.toggle('hidden', panel.dataset.tabPanel !== tabName);
    });
  }

  tabLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const tabName = link.dataset.tab;
      activateTab(tabName);
      history.replaceState(null, '', '#' + tabName);
    });
  });

  // Activate from hash or default to first tab
  const hash = window.location.hash.slice(1);
  const validTab = [...tabLinks].find(l => l.dataset.tab === hash);
  activateTab(validTab ? hash : tabLinks[0].dataset.tab);
}

document.addEventListener('DOMContentLoaded', initTabs);
