// T&S Dashboard - Client-side JavaScript

// Auto-dismiss flash messages after 5 seconds
document.querySelectorAll('[data-auto-dismiss]').forEach(el => {
  setTimeout(() => el.remove(), 5000);
});

// Confirm before delete actions
document.querySelectorAll('form[data-confirm]').forEach(form => {
  form.addEventListener('submit', (e) => {
    if (!confirm(form.dataset.confirm || 'Are you sure?')) {
      e.preventDefault();
    }
  });
});

// Tab navigation (for job detail page)
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
