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

  // ---------- Dispute gate: show detail fields only when the top Yes/No is Yes ----------
  (function () {
    const detailBlock = document.querySelector('.hd-dispute-details');
    if (!detailBlock) return;
    const radios = document.querySelectorAll('input[name="dispute_alleged_damage"]');
    function sync() {
      const selected = document.querySelector('input[name="dispute_alleged_damage"]:checked');
      const isYes = selected && selected.value === '1';
      detailBlock.classList.toggle('hidden', !isYes);
    }
    radios.forEach(function (r) { r.addEventListener('change', sync); });
  })();

  // ---------- Draft autosave (localStorage) ----------
  // Any form marked with data-draft-key="<unique-key>" gets its field values
  // shadowed to localStorage on change, debounced. On successful submit the
  // draft is cleared. On page load, if a draft exists AND differs from the
  // rendered values, we show a yellow restore banner above the form so the
  // crew can choose to restore or discard.
  (function () {
    var DRAFT_PREFIX = 'hd-draft/';
    var DEBOUNCE_MS = 600;

    function formFields(form) {
      return form.querySelectorAll('input, textarea, select');
    }
    function isDraftable(el) {
      if (!el.name || el.name.startsWith('_')) return false;
      if (el.type === 'file' || el.type === 'hidden' || el.type === 'submit' || el.type === 'button') return false;
      if (el.closest('[data-draft-skip]')) return false;
      return true;
    }
    function snapshot(form) {
      var data = {};
      formFields(form).forEach(function (el) {
        if (!isDraftable(el)) return;
        if (el.type === 'checkbox') {
          data[el.name] = el.checked ? (el.value || '1') : '';
        } else if (el.type === 'radio') {
          if (el.checked) data[el.name] = el.value;
          else if (!(el.name in data)) data[el.name] = data[el.name] || '';
        } else {
          data[el.name] = el.value;
        }
      });
      return data;
    }
    function restore(form, data) {
      formFields(form).forEach(function (el) {
        if (!isDraftable(el)) return;
        if (!(el.name in data)) return;
        var v = data[el.name];
        if (el.type === 'checkbox') {
          el.checked = !!v;
        } else if (el.type === 'radio') {
          el.checked = el.value === v;
        } else {
          el.value = v == null ? '' : v;
        }
        // Keep pill visual state in sync with restored radios/checkboxes
        var pill = el.closest('.hd-pill');
        if (pill) pill.classList.toggle('is-active', !!el.checked);
      });
    }
    function isDraftDifferent(form, data) {
      var current = snapshot(form);
      var keys = Object.keys(Object.assign({}, current, data));
      for (var i = 0; i < keys.length; i++) {
        if ((current[keys[i]] || '') !== (data[keys[i]] || '')) return true;
      }
      return false;
    }
    function showRestoreBanner(form, key, saved) {
      var savedAt = saved.__savedAt || 'earlier';
      var banner = document.createElement('div');
      banner.className = 'mb-3 p-3 rounded-lg bg-amber-50 border border-amber-300 text-sm text-amber-900 flex items-center gap-3 print:hidden';
      banner.innerHTML =
        '<svg class="w-5 h-5 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' +
        '<div class="flex-1">Unsaved changes from ' + savedAt + ' are available for this form.</div>' +
        '<button type="button" data-restore class="px-3 py-1 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-500">Restore</button>' +
        '<button type="button" data-discard class="px-3 py-1 text-xs font-medium rounded-md bg-white border border-amber-300 text-amber-800 hover:bg-amber-100">Discard</button>';
      form.parentNode.insertBefore(banner, form);
      banner.querySelector('[data-restore]').addEventListener('click', function () {
        var copy = Object.assign({}, saved); delete copy.__savedAt;
        restore(form, copy);
        banner.remove();
      });
      banner.querySelector('[data-discard]').addEventListener('click', function () {
        try { localStorage.removeItem(key); } catch (e) {}
        banner.remove();
      });
    }
    function wire(form) {
      var key = DRAFT_PREFIX + form.dataset.draftKey;
      // Restore check
      try {
        var raw = localStorage.getItem(key);
        if (raw) {
          var saved = JSON.parse(raw);
          if (saved && typeof saved === 'object' && isDraftDifferent(form, saved)) {
            showRestoreBanner(form, key, saved);
          }
        }
      } catch (e) { /* ignore corrupt draft */ }

      // Debounced save on change / input
      var timer = null;
      function queueSave() {
        clearTimeout(timer);
        timer = setTimeout(function () {
          try {
            var data = snapshot(form);
            data.__savedAt = new Date().toLocaleString();
            localStorage.setItem(key, JSON.stringify(data));
          } catch (e) { /* quota / privacy mode — silent */ }
        }, DEBOUNCE_MS);
      }
      form.addEventListener('input', queueSave);
      form.addEventListener('change', queueSave);
      // On submit, clear the draft (the server's the source of truth after save).
      form.addEventListener('submit', function () {
        try { localStorage.removeItem(key); } catch (e) {}
      });
    }
    document.querySelectorAll('form[data-draft-key]').forEach(wire);
  })();

  // ---------- Soft validators (non-blocking warnings for date + odometer order) ----------
  // Drop-off date/time before pick-up date/time = warn.
  // Drop-off odometer/hours below pick-up odometer/hours = warn.
  // Pure UX — server doesn't reject, crews can still save (the reading may be
  // genuinely correct, e.g. an odometer rollover).
  (function () {
    function warningEl(field) {
      var sibling = field.parentElement.querySelector('.hd-softwarn');
      if (sibling) return sibling;
      var p = document.createElement('p');
      p.className = 'hd-softwarn text-[11px] text-amber-700 mt-1 print:hidden';
      field.parentElement.appendChild(p);
      return p;
    }
    function clearWarn(field) {
      var existing = field.parentElement.querySelector('.hd-softwarn');
      if (existing) existing.remove();
    }

    document.querySelectorAll('form[action*="/items/"][method="post"], form[action*="/items/"][method="POST"]').forEach(function (form) {
      // Only wire the per-item inspection forms — the ones that carry both
      // pickup_datetime and dropoff_datetime. Skip the /accessories / /photos /
      // /duplicate / /delete forms.
      if (!form.querySelector('[name="pickup_datetime"]') && !form.querySelector('[name="dropoff_datetime"]')) return;

      var pUp = form.querySelector('[name="pickup_datetime"]');
      var dUp = form.querySelector('[name="dropoff_datetime"]');
      var pHrs = form.querySelector('[name="pickup_hours_odometer"]');
      var dHrs = form.querySelector('[name="dropoff_hours_odometer"]');

      function checkDates() {
        if (!pUp || !dUp) return;
        clearWarn(dUp);
        if (pUp.value && dUp.value && dUp.value < pUp.value) {
          warningEl(dUp).textContent = '⚠ Drop-off is before pick-up. Double-check the date/time.';
        }
      }
      function firstNumber(v) {
        var m = String(v || '').match(/[-+]?\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : null;
      }
      function checkHours() {
        if (!pHrs || !dHrs) return;
        clearWarn(dHrs);
        var pv = firstNumber(pHrs.value);
        var dv = firstNumber(dHrs.value);
        if (pv != null && dv != null && dv < pv) {
          warningEl(dHrs).textContent = '⚠ Drop-off reading is lower than pick-up (' + pv + ' → ' + dv + '). Odometer rollover? Confirm before saving.';
        }
      }
      [pUp, dUp].forEach(function (el) { if (el) el.addEventListener('change', checkDates); });
      [pHrs, dHrs].forEach(function (el) { if (el) el.addEventListener('input', checkHours); });
      // Run once at load so stored-but-suspect values are flagged too.
      checkDates();
      checkHours();
    });
  })();

  // ---------- Pre-print blank-field guard ----------
  // Intercept the Print link. If any of the docket's core fields (the ones
  // marked data-print-required) are blank, confirm with the crew before
  // opening the print view — offer to jump to the first blank instead.
  (function () {
    var link = document.querySelector('[data-print-check]');
    if (!link) return;
    link.addEventListener('click', function (e) {
      var blanks = [];
      document.querySelectorAll('[data-print-required]').forEach(function (el) {
        // A field is "blank" if it has no value; radios are blank if no sibling
        // in the same name-group is checked.
        if (el.type === 'radio') {
          var any = document.querySelector('input[name="' + CSS.escape(el.name) + '"]:checked');
          if (!any) blanks.push(el);
        } else {
          if (!String(el.value || '').trim()) blanks.push(el);
        }
      });
      if (blanks.length === 0) return; // let the default open-in-new-tab happen
      e.preventDefault();
      var names = blanks.slice(0, 4).map(function (f) {
        var lbl = f.closest('div')?.querySelector('.hd-label');
        return lbl ? lbl.textContent.replace('*', '').trim() : (f.name || 'field');
      });
      var suffix = blanks.length > 4 ? (' and ' + (blanks.length - 4) + ' more') : '';
      var msg = blanks.length + ' core field' + (blanks.length === 1 ? ' is' : 's are') +
        ' still blank: ' + names.join(', ') + suffix + '.\n\nPrint anyway, or cancel to jump to the first blank?';
      if (confirm(msg)) {
        // User chose Print anyway — open the print view manually.
        window.open(link.href, '_blank');
      } else {
        blanks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        blanks[0].focus();
      }
    });
  })();

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
