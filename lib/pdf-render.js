// Render each page of a PDF to a PNG so the mobile sign page can display
// the SOP inline as a stack of images — much nicer than embedding a PDF in
// an iframe (which doesn't render well on iOS).
//
// Uses pdfjs-dist (legacy/CJS build) + node-canvas. Both are bundled into
// node_modules; no system tools required.

const fs = require('fs');
const path = require('path');

let pdfjs;
let canvasMod;
let pdfjsLoadError;
let canvasLoadError;
try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js'); }
catch (e) { pdfjsLoadError = e.message; console.warn('[pdf-render] pdfjs-dist load failed:', e.message); }
// node-canvas needs cairo/pango at the OS level. If the host (e.g. Railway's
// default Nixpacks build) doesn't have them, the require fails and we fall
// back to an iframe on the sign page (still functional, just less polished).
try { canvasMod = require('canvas'); }
catch (e) { canvasLoadError = e.message; console.warn('[pdf-render] node-canvas load failed:', e.message); }

// Render a PDF to PNGs. Returns array of relative filenames (just the basename).
// Output PNGs go into <outDir>/<basename>__page_N.png. Throws on failure so
// the caller can capture the real reason (don't silently return []).
async function renderPdfToPngs(pdfPath, outDir, opts = {}) {
  if (!pdfjs) throw new Error('pdfjs-dist not loaded: ' + (pdfjsLoadError || 'unknown'));
  if (!canvasMod) throw new Error('node-canvas not loaded (this happens when the native module did not build on the host): ' + (canvasLoadError || 'unknown'));
  const scale = opts.scale || 1.7;
  fs.mkdirSync(outDir, { recursive: true });
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false }).promise;
  if (!doc.numPages) throw new Error('PDF has 0 pages');
  const baseName = path.basename(pdfPath).replace(/\.[^.]+$/, '');
  const out = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale });
    const canvas = canvasMod.createCanvas(vp.width, vp.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const fname = `${baseName}__page_${i}.png`;
    fs.writeFileSync(path.join(outDir, fname), canvas.toBuffer('image/png'));
    out.push(fname);
  }
  return out;
}

module.exports = { renderPdfToPngs };
