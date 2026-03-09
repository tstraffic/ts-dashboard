// Worker Portal — Client-side JavaScript

// Auto-dismiss flash messages after 5 seconds
document.addEventListener('DOMContentLoaded', function() {
  const flashMessages = document.querySelectorAll('[class*="bg-emerald-50"], [class*="bg-red-50"]');
  flashMessages.forEach(function(msg) {
    // Only auto-dismiss if it has a close button (flash messages)
    if (msg.querySelector('button')) {
      setTimeout(function() {
        msg.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        msg.style.opacity = '0';
        msg.style.transform = 'translateY(-10px)';
        setTimeout(function() { msg.remove(); }, 300);
      }, 5000);
    }
  });
});

// Confirm prompts for destructive actions
function confirmAction(message) {
  return confirm(message || 'Are you sure?');
}

// Register service worker for PWA
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/js/worker-sw.js').then(function(registration) {
      console.log('SW registered:', registration.scope);
    }).catch(function(error) {
      console.log('SW registration failed:', error);
    });
  });
}
