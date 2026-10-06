// Minimal QR code generator (ISO/IEC 18004): byte mode, error correction level M, versions 1–10 (up to 213 bytes).
// Used for the authenticator setup link, so staff scan it instead of typing the secret. qr(text) -> boolean[][] (true = dark).

// [data codewords per block for group 1, blocks in group 1, data codewords per block for group 2, blocks in group 2, EC codewords per block]
const BLOCKS = [null, [16, 1, 0, 0, 10], [28, 1, 0, 0, 16], [44, 1, 0, 0, 26], [32, 2, 0, 0, 18], [43, 2, 0, 0, 24], [27, 4, 0, 0, 16],
  [31, 4, 0, 0, 18], [38, 2, 39, 2, 22], [36, 3, 37, 2, 22], [43, 4, 44, 1, 26]];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

// GF(256) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1
const EXP = new Array(512), LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function ecCodewords(data, n) {
  let gen = [1];                                     // (x - a^0)(x - a^1)...(x - a^(n-1))
  for (let i = 0; i < n; i++) { const next = new Array(gen.length + 1).fill(0); gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, EXP[i]); }); gen = next; }
  const rem = [...data, ...new Array(n).fill(0)];
  for (let i = 0; i < data.length; i++) { const c = rem[i]; if (c) for (let j = 0; j < gen.length; j++) rem[i + j] ^= mul(gen[j], c); }
  return rem.slice(data.length);
}
// BCH remainder for format and version information
function bch(value, poly, bits) { let v = value << bits; const top = Math.floor(Math.log2(poly)); while (Math.floor(Math.log2(v || 1)) >= top && v) v ^= poly << (Math.floor(Math.log2(v)) - top); return (value << bits) | v; }

export function qr(text) {
  const bytes = [...new TextEncoder().encode(text)];
  let ver = 1;
  for (; ver <= 10; ver++) { const [a, b, c, d] = BLOCKS[ver]; if (4 + (ver < 10 ? 8 : 16) + bytes.length * 8 <= (a * b + c * d) * 8) break; }
  if (ver > 10) throw new Error('Text too long for a QR code');
  const [d1, n1, d2, n2, ec] = BLOCKS[ver], capacity = d1 * n1 + d2 * n2;
  // data bits: mode, length, bytes, terminator, padding
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(4, 4); put(bytes.length, ver < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
  put(0, Math.min(4, capacity * 8 - bits.length)); while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let p = 0; data.length < capacity; p++) data.push(p % 2 ? 0x11 : 0xec);
  // split into blocks, add error correction, interleave
  const blocks = []; let at = 0;
  for (let i = 0; i < n1 + n2; i++) { const len = i < n1 ? d1 : d2; const b = data.slice(at, at + len); at += len; blocks.push({ b, e: ecCodewords(b, ec) }); }
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++) blocks.forEach(x => { if (i < x.b.length) out.push(x.b[i]); });
  for (let i = 0; i < ec; i++) blocks.forEach(x => out.push(x.e[i]));

  const size = 17 + ver * 4;
  const m = Array.from({ length: size }, () => new Array(size).fill(null));      // null = not yet set
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => { m[r][c] = v; fixed[r][c] = true; };
  const finder = (r, c) => { for (let i = -1; i <= 7; i++) for (let j = -1; j <= 7; j++) { const y = r + i, x = c + j; if (y < 0 || x < 0 || y >= size || x >= size) continue;
    set(y, x, i >= 0 && i <= 6 && j >= 0 && j <= 6 && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4))); } };
  finder(0, 0); finder(0, size - 7); finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const al = ALIGN[ver];
  for (const r of al) for (const c of al) {
    if ((r === 6 && c === 6) || (r === 6 && c === al[al.length - 1]) || (r === al[al.length - 1] && c === 6)) continue;
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) set(r + i, c + j, Math.max(Math.abs(i), Math.abs(j)) !== 1);
  }
  for (let i = 0; i < 9; i++) { if (!fixed[8][i]) set(8, i, false); if (!fixed[i][8]) set(i, 8, false); }   // format areas, filled later
  for (let i = 0; i < 8; i++) { set(8, size - 1 - i, false); set(size - 1 - i, 8, false); }
  set(size - 8, 8, true);                                                            // the dark module
  if (ver >= 7) { const v = bch(ver, 0x1f25, 12);
    for (let i = 0; i < 18; i++) { const b = !!((v >> i) & 1), r = Math.floor(i / 3), c = size - 11 + (i % 3); set(r, c, b); set(c, r, b); } }
  // data, in the zigzag order, right to left in pairs of columns
  const dataBits = []; out.forEach(b => { for (let i = 7; i >= 0; i--) dataBits.push((b >> i) & 1); });
  let k = 0;
  for (let c = size - 1; c > 0; c -= 2) {
    if (c === 6) c--;
    for (let n = 0; n < size; n++) {
      const up = ((size - 1 - c) >> 1) % 2 === 0, r = up ? size - 1 - n : n;
      for (const x of [c, c - 1]) if (!fixed[r][x]) { m[r][x] = k < dataBits.length ? dataBits[k] === 1 : false; k++; }
    }
  }
  // the mask with the lowest penalty
  const MASKS = [(r, c) => (r + c) % 2 === 0, r => r % 2 === 0, (r, c) => c % 3 === 0, (r, c) => (r + c) % 3 === 0, (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0, (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0, (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0];
  let best = null, bestScore = Infinity;
  for (let mk = 0; mk < 8; mk++) {
    const g = m.map((row, r) => row.map((v, c) => (fixed[r][c] ? v : v !== MASKS[mk](r, c))));
    const f = bch((0 << 3) | mk, 0x537, 10) ^ 0x5412;                             // level M = 00
    for (let i = 0; i < 15; i++) {
      const b = !!((f >> i) & 1);
      if (i < 6) g[i][8] = b; else if (i === 6) g[7][8] = b; else if (i === 7) g[8][8] = b; else if (i === 8) g[8][7] = b; else g[8][14 - i] = b;   // beside the top-left finder
      if (i < 8) g[8][size - 1 - i] = b; else g[size - 15 + i][8] = b;                                                                  // and split over the other two
    }
    const s = penalty(g);
    if (s < bestScore) { bestScore = s; best = g; }
  }
  return best;
}
function penalty(g) {
  const n = g.length; let s = 0, dark = 0;
  for (let i = 0; i < n; i++) for (const line of [g[i], g.map(r => r[i])]) {
    let run = 1;
    for (let j = 1; j <= n; j++) { if (j < n && line[j] === line[j - 1]) run++; else { if (run >= 5) s += run - 2; run = 1; } }
    const t = line.map(v => (v ? 1 : 0)).join('');
    s += 40 * ((t.match(/(?=10111010000|00001011101)/g) || []).length);
  }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) { const v = g[r][c]; if (v === g[r + 1][c] && v === g[r][c + 1] && v === g[r + 1][c + 1]) s += 3; }
  g.forEach(row => row.forEach(v => { if (v) dark++; }));
  return s + Math.floor(Math.abs(dark * 100 / (n * n) - 50) / 5) * 10;
}
// SVG markup for a QR code, with the 4-module quiet zone
export function qrSvg(text, px = 4) {
  const g = qr(text), n = g.length + 8;
  let d = '';
  g.forEach((row, r) => row.forEach((v, c) => { if (v) d += `M${c + 4} ${r + 4}h1v1h-1z`; }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" width="${n * px}" height="${n * px}" shape-rendering="crispEdges"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
