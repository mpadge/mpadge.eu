// Choose the social preview ("card") image for a blog post or note: the first
// landscape image in its markdown. Returns '' if there is none, in which case
// the page gets a text-only card built from its title and description (see
// `textcard` in src/layouts/default.html) instead of the site-wide image.
import fs from 'fs';
import path from 'path';

const IMG_EXT = /\.(png|jpe?g|gif|webp)$/i;

// Width/height read straight from the file header: PNG (IHDR chunk) and JPEG
// (SOFn segment). Returns null for other formats or unreadable files.
export function imageDimensions(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (e) { /* fall through */ }
  return null;
}

// `md`: markdown (or HTML) source. Only root-absolute paths (/assets/img/x.png)
// to files that exist under `srcDir` are considered, because the layout turns
// the path into https://mpadge.eu<path>. Portrait images are skipped: link
// cards (Bluesky and others) force-crop previews into a landscape frame, which
// mangles them.
export function pickOgImage(md, srcDir = 'src') {
  const re = /!\[[^\]]*\]\(\s*([^\s)]+)|<img[^>]+src="([^"]+)"/g;
  for (let m; (m = re.exec(md));) {
    const ref = m[1] || m[2];
    if (!ref.startsWith('/') || !IMG_EXT.test(ref)) continue;
    const file = path.join(srcDir, ref);
    if (!fs.existsSync(file)) continue;
    const dims = imageDimensions(file);
    if (dims && dims.height > dims.width) continue;
    return ref;
  }
  return '';
}
