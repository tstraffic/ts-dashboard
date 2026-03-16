// T&S Dashboard - Client-side JavaScript

// ===== Mobile Sidebar Toggle =====
(function() {
  const toggle = document.getElementById('sidebar-toggle');
  const closeBtn = document.getElementById('sidebar-close');
  const sidebar = document.getElementById('sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');

  if (sidebar && backdrop) {
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

    if (toggle) {
      toggle.addEventListener('click', function(e) {
        e.stopPropagation();
        if (sidebar.classList.contains('sidebar-open')) {
          closeSidebar();
        } else {
          openSidebar();
        }
      });
    }

    // Close button inside sidebar
    if (closeBtn) {
      closeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        closeSidebar();
      });
    }

    // Close on backdrop tap
    backdrop.addEventListener('click', closeSidebar);

    // Close on Escape key
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeSidebar();
    });

    // Close sidebar when a nav link is tapped (mobile)
    sidebar.querySelectorAll('nav a').forEach(function(link) {
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

    // Handle swipe-to-close on mobile
    var touchStartX = 0;
    sidebar.addEventListener('touchstart', function(e) {
      touchStartX = e.touches[0].clientX;
    }, { passive: true });

    sidebar.addEventListener('touchend', function(e) {
      var touchEndX = e.changedTouches[0].clientX;
      var diff = touchStartX - touchEndX;
      // Swipe left to close (>80px threshold)
      if (diff > 80 && window.innerWidth < 1024) {
        closeSidebar();
      }
    }, { passive: true });
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

// ===== Push Notification Subscription =====
(function() {
  // Only run for logged-in users (notification bell exists) and browsers that support push
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.log('[Push] Browser does not support push notifications');
    return;
  }
  if (!document.getElementById('notif-bell')) {
    console.log('[Push] No notif-bell found — user not logged in');
    return;
  }

  console.log('[Push] Initializing push subscription flow...');

  // Wait for service worker to be ready, then check/request push permission
  navigator.serviceWorker.ready.then(function(registration) {
    console.log('[Push] Service worker ready:', registration.scope);

    // Check existing subscription
    registration.pushManager.getSubscription().then(function(subscription) {
      if (subscription) {
        console.log('[Push] Already subscribed, syncing with server...');
        sendSubscriptionToServer(subscription);
        // Update any push status indicator
        updatePushStatus(true);
        return;
      }

      console.log('[Push] Not subscribed yet. Permission:', Notification.permission);

      // Not subscribed yet — show a prompt after a short delay (non-intrusive)
      if (Notification.permission === 'granted') {
        subscribeToPush(registration);
      } else if (Notification.permission !== 'denied') {
        // Ask after 3 seconds so it's not immediate on page load
        setTimeout(function() { showPushPrompt(registration); }, 3000);
      } else {
        console.log('[Push] Permission denied by user');
      }
    }).catch(function(err) {
      console.error('[Push] Error checking subscription:', err);
    });
  }).catch(function(err) {
    console.error('[Push] Service worker not ready:', err);
  });

  function showPushPrompt(registration) {
    // Don't show if already dismissed this session
    if (sessionStorage.getItem('push-dismissed')) {
      console.log('[Push] Prompt dismissed this session, skipping');
      return;
    }

    // Create a subtle in-app banner instead of relying solely on browser prompt
    var banner = document.createElement('div');
    banner.id = 'push-prompt';
    banner.className = 'fixed bottom-4 left-4 right-4 sm:left-auto sm:right-4 sm:w-96 bg-white border border-gray-200 rounded-xl shadow-xl p-4 z-50 flex items-start gap-3';
    banner.innerHTML = '<div class="flex-shrink-0 w-10 h-10 bg-brand-50 rounded-full flex items-center justify-center">' +
      '<svg class="w-5 h-5 text-brand-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"/></svg>' +
      '</div>' +
      '<div class="flex-1">' +
      '<p class="text-sm font-semibold text-gray-900">Enable notifications?</p>' +
      '<p class="text-xs text-gray-500 mt-0.5">Get alerts for task assignments, deadlines, and updates on your phone.</p>' +
      '<div class="flex gap-2 mt-2">' +
      '<button id="push-enable" class="px-3 py-1.5 bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold rounded-lg">Enable</button>' +
      '<button id="push-dismiss" class="px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-gray-600 text-xs font-medium rounded-lg">Not now</button>' +
      '</div></div>';
    document.body.appendChild(banner);

    document.getElementById('push-enable').addEventListener('click', function() {
      banner.remove();
      subscribeToPush(registration);
    });
    document.getElementById('push-dismiss').addEventListener('click', function() {
      banner.remove();
      sessionStorage.setItem('push-dismissed', '1');
    });
  }

  function subscribeToPush(registration) {
    console.log('[Push] Fetching VAPID key...');
    // Fetch VAPID public key from server
    fetch('/notifications/push/vapid-key')
      .then(function(res) {
        if (!res.ok) {
          throw new Error('VAPID key request failed: ' + res.status);
        }
        return res.json();
      })
      .then(function(data) {
        if (!data.publicKey) {
          console.error('[Push] No public key returned from server');
          return;
        }
        console.log('[Push] Got VAPID key, subscribing to push manager...');

        var key = urlBase64ToUint8Array(data.publicKey);
        return registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key
        });
      })
      .then(function(subscription) {
        if (subscription) {
          console.log('[Push] Subscribed! Sending to server...');
          sendSubscriptionToServer(subscription);
          updatePushStatus(true);
        }
      })
      .catch(function(err) {
        console.error('[Push] Subscribe error:', err);
      });
  }

  function sendSubscriptionToServer(subscription) {
    fetch('/notifications/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription)
    })
    .then(function(res) {
      if (!res.ok) {
        console.error('[Push] Server rejected subscription:', res.status);
      } else {
        console.log('[Push] Subscription saved to server');
      }
    })
    .catch(function(err) {
      console.error('[Push] Failed to send subscription to server:', err);
    });
  }

  // Update push status indicator on profile page (if present)
  function updatePushStatus(subscribed) {
    var statusEl = document.getElementById('push-status');
    if (statusEl) {
      statusEl.textContent = subscribed ? 'Enabled' : 'Disabled';
      statusEl.className = subscribed
        ? 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20'
        : 'inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-500';
    }
  }

  // Expose for test button on profile page
  window.sendTestPush = function() {
    fetch('/notifications/push/test', { method: 'POST' })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.success) {
          alert('Test notification sent! You should receive it in a few seconds.');
        } else {
          alert('Failed: ' + (data.error || 'Unknown error'));
        }
      })
      .catch(function(err) {
        alert('Error: ' + err.message);
      });
  };

  // Convert base64 VAPID key to Uint8Array for the Push API
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }
})();
