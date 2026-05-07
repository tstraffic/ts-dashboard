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
try {
  pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  canvasMod = require('canvas');
} catch (e) {
  console.warn('[pdf-render] pdfjs-dist or canvas not installed — page rendering disabled.', e.message);
}

// Render a PDF to PNGs. Returns array of relative filenames (just the basename).
// Output PNGs go into <outDir>/<basename>__page_N.png. Idempotent — caller
// decides when to re-render (e.g. on upload).
async function renderPdfToPngs(pdfPath, outDir, opts = {}) {
  if (!pdfjs || !canvasMod) return [];
  const scale = opts.scale || 1.7;
  fs.mkdirSync(outDir, { recursive: true });
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const doc = await pdfjs.getDocument({ data, disableFontFace: true, useSystemFonts: false }).promise;
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
