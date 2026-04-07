/**
 * Reusable drag-and-drop file upload zones.
 * Add data-dropzone to any container wrapping a <input type="file">.
 * The input gets hidden, replaced with a visual drop zone.
 */
(function() {
  document.addEventListener('DOMContentLoaded', function() {
    document.querySelectorAll('[data-dropzone]').forEach(function(zone) {
      var input = zone.querySelector('input[type="file"]');
      if (!input) return;

      // Prevent default drag behaviors on the whole page
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(function(evt) {
        zone.addEventListener(evt, function(e) { e.preventDefault(); e.stopPropagation(); });
      });

      // Visual hover state
      ['dragenter', 'dragover'].forEach(function(evt) {
        zone.addEventListener(evt, function() { zone.classList.add('drag-over'); });
      });
      ['dragleave', 'drop'].forEach(function(evt) {
        zone.addEventListener(evt, function() { zone.classList.remove('drag-over'); });
      });

      // Handle dropped files
      zone.addEventListener('drop', function(e) {
        var files = e.dataTransfer.files;
        if (files.length > 0) {
          input.files = files;
          updateFileList(zone, files);
          // Trigger change event so any listeners pick it up
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });

      // Also update file list on normal click-to-browse
      input.addEventListener('change', function() {
        if (input.files.length > 0) updateFileList(zone, input.files);
      });

      // Click anywhere in the zone to trigger file picker
      zone.addEventListener('click', function(e) {
        if (e.target === input || e.target.tagName === 'BUTTON') return;
        input.click();
      });
    });
  });

  function updateFileList(zone, files) {
    var listEl = zone.querySelector('.dropzone-file-list');
    if (!listEl) {
      listEl = document.createElement('div');
      listEl.className = 'dropzone-file-list mt-2 space-y-1';
      zone.appendChild(listEl);
    }
    listEl.innerHTML = '';
    var input = zone.querySelector('input[type="file"]');
    Array.from(files).forEach(function(f) {
      var row = document.createElement('div');
      row.className = 'flex items-center gap-2 text-xs text-gray-600';
      var sizeKB = (f.size / 1024).toFixed(0);
      row.innerHTML = '<svg class="w-3.5 h-3.5 text-brand-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>' +
        '<span class="truncate flex-1">' + f.name + '</span>' +
        '<span class="text-gray-400 flex-shrink-0">' + sizeKB + ' KB</span>' +
        '<button type="button" class="dropzone-remove text-gray-300 hover:text-red-500 transition flex-shrink-0" title="Remove">' +
          '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>' +
        '</button>';
      listEl.appendChild(row);
    });
    // Remove file button — clears the input
    listEl.querySelectorAll('.dropzone-remove').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (input) { input.value = ''; }
        listEl.innerHTML = '';
      });
    });
  }
})();
