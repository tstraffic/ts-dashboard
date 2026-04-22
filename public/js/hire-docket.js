// Hire docket v2 — client behaviour:
//   - Pill radio groups toggle `.is-active` styling without page reload
//   - Equipment-type <select> change pushes a soft note (the server controls the
//     actual photo-slot layout; the user has to save the item for it to apply)
//   - Photo inputs auto-submit when files are chosen
//   - Attachment "Upload" button injects a hidden file input + form and
//     auto-submits when the user picks files, scoped to the category clicked
//   - Canvas signature pad: touch + mouse drawing, Clear/Save buttons,
//     POSTs base64 PNG to the signature endpoint

(function () {
  'use strict';

  // ----- CSRF token -----
  const csrfMeta = document.querySelector('meta[name="csrf-token"]');
  const csrfToken = csrfMeta ? csrfMeta.getAttribute('content') : '';

  // ---------- Pill toggles ----------
  function wirePills(root) {
    root.querySelectorAll('.hd-pill').forEach(function (pill) {
      const input = pill.querySelector('input[type="radio"], input[type="checkbox"]');
      if (!input) return;
      pill.addEventListener('click', function (e) {
        // Let the native input handle check state (label/input association).
        // Radios: after the change, sync `.is-active` across the whole group.
        // Checkboxes: just toggle `.is-active` on self.
        setTimeout(function () {
          if (input.type === 'radio') {
            const group = input.name;
            document.querySelectorAll('input[name="' + CSS.escape(group) + '"]').forEach(function (r) {
              const lbl = r.closest('.hd-pill');
              if (!lbl) return;
              lbl.classList.toggle('is-active', r.checked);
            });
          } else {
            pill.classList.toggle('is-active', input.checked);
          }
        }, 0);
      });
    });
  }
  wirePills(document);

  // ---------- Auto-submit photo uploads when files are chosen ----------
  document.querySelectorAll('.hd-photo-upload').forEach(function (form) {
    const trigger = form.querySelector('.hd-photo-trigger');
    const input = form.querySelector('.hd-photo-input');
    if (!trigger || !input) return;
    trigger.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (input.files && input.files.length > 0) {
        form.submit();
      }
    });
  });

  // ---------- Attachment upload buttons (docket-level) ----------
  document.querySelectorAll('.hire-attachment-upload').forEach(function (wrap) {
    const trigger = wrap.querySelector('[data-trigger-upload]');
    if (!trigger) return;
    trigger.addEventListener('click', function () {
      const docketId = wrap.dataset.docket;
      const category = wrap.dataset.category;
      // Build a one-shot form
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/equipment/hire-dockets/' + docketId + '/attachments';
      form.enctype = 'multipart/form-data';
      form.style.display = 'none';
      const csrf = document.createElement('input');
      csrf.type = 'hidden';
      csrf.name = '_csrf';
      csrf.value = csrfToken;
      const cat = document.createElement('input');
      cat.type = 'hidden';
      cat.name = 'category';
      cat.value = category;
      const file = document.createElement('input');
      file.type = 'file';
      file.name = 'files';
      file.multiple = true;
      file.accept = 'image/*,application/pdf';
      form.appendChild(csrf);
      form.appendChild(cat);
      form.appendChild(file);
      document.body.appendChild(form);
      file.addEventListener('change', function () {
        if (file.files && file.files.length > 0) form.submit();
      });
      file.click();
    });
  });

  // ---------- Equipment-type select — nudge the user to save so the photo checklist reloads ----------
  document.querySelectorAll('.hd-type-select').forEach(function (sel) {
    sel.addEventListener('change', function () {
      // Show a small hint next to the select that the user needs to Save Item
      // for the photo-slot checklist to update (render is server-side).
      let hint = sel.parentElement.querySelector('.hd-type-hint');
      if (!hint) {
        hint = document.createElement('p');
        hint.className = 'hd-type-hint text-[11px] text-amber-700 mt-1';
        sel.parentElement.appendChild(hint);
      }
      hint.textContent = 'Save item to load the matching photo checklist.';
    });
  });

  // ---------- Canvas signature pad ----------
  // Lightweight: captures mouse + touch, draws smoothed lines, supports Clear
  // and Save (POSTs data URL to the signature endpoint, refreshes the page).
  function initSignature(container) {
    const canvas = container.querySelector('.hd-signature-pad');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let drawing = false;
    let dirty = false;
    let lastX = 0, lastY = 0;

    // Make the backing store match display pixels for crisper strokes.
    function resizeCanvas() {
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = '#111827';
    }
    resizeCanvas();
    // Resize again next frame (browsers sometimes report 0-width initially).
    setTimeout(resizeCanvas, 50);
    window.addEventListener('resize', resizeCanvas);

    function pointer(e) {
      const rect = canvas.getBoundingClientRect();
      const t = e.touches ? e.touches[0] : e;
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }

    function start(e) {
      drawing = true;
      dirty = true;
      const p = pointer(e);
      lastX = p.x; lastY = p.y;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      e.preventDefault();
    }
    function move(e) {
      if (!drawing) return;
      const p = pointer(e);
      // Smooth with quadratic midpoint
      const midX = (lastX + p.x) / 2;
      const midY = (lastY + p.y) / 2;
      ctx.quadraticCurveTo(lastX, lastY, midX, midY);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(midX, midY);
      lastX = p.x; lastY = p.y;
      e.preventDefault();
    }
    function end(e) {
      if (!drawing) return;
      drawing = false;
      e && e.preventDefault && e.preventDefault();
    }

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    canvas.addEventListener('touchcancel', end);

    const clearBtn = container.querySelector('.hd-sig-clear');
    const saveBtn = container.querySelector('.hd-sig-save');
    const status = container.querySelector('.hd-sig-status');

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        dirty = false;
        if (status) { status.textContent = ''; status.className = 'hd-sig-status text-gray-400'; }
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        if (!dirty) {
          if (status) { status.textContent = 'Draw something first.'; status.className = 'hd-sig-status is-error'; }
          return;
        }
        if (status) { status.textContent = 'Saving…'; status.className = 'hd-sig-status is-saving'; }
        const dataUrl = canvas.toDataURL('image/png');
        const docketId = container.dataset.docket;
        const kind = container.dataset.kind;
        const slot = container.dataset.slot;
        const url = kind === 'item'
          ? '/equipment/hire-dockets/' + docketId + '/items/' + container.dataset.item + '/signature'
          : '/equipment/hire-dockets/' + docketId + '/signature';

        const fd = new URLSearchParams();
        fd.append('_csrf', csrfToken);
        fd.append('slot', slot);
        fd.append('signature_data', dataUrl);
        fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'x-csrf-token': csrfToken,
          },
          credentials: 'same-origin',
          body: fd.toString(),
        }).then(function (r) {
          if (r.ok || r.redirected) {
            if (status) { status.textContent = 'Saved — refreshing…'; status.className = 'hd-sig-status is-saved'; }
            setTimeout(function () { window.location.reload(); }, 400);
          } else {
            if (status) { status.textContent = 'Save failed (' + r.status + ').'; status.className = 'hd-sig-status is-error'; }
          }
        }).catch(function () {
          if (status) { status.textContent = 'Save failed — check connection.'; status.className = 'hd-sig-status is-error'; }
        });
      });
    }
  }

  document.querySelectorAll('.hd-signature').forEach(initSignature);
})();
