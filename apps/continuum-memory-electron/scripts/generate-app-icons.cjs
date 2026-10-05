// Run with Electron. Extract the approved artwork without regenerating its geometry or lighting.
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const application = path.resolve(__dirname, '..');
const sourcePath = path.join(application, 'resources/branding/continuum-icons-approved-v1.png');
const destination = path.join(application, 'src/renderer/public/brand/icons');
const tiles = [
  { id: 'thread-teal', x: 130, y: 142, width: 275, height: 266 },
  { id: 'thread-copper', x: 629, y: 142, width: 276, height: 266 },
  { id: 'thread-ink', x: 1131, y: 142, width: 276, height: 267 },
  { id: 'network-ice', x: 130, y: 604, width: 277, height: 264 },
  { id: 'network-violet', x: 631, y: 604, width: 277, height: 264 },
  { id: 'network-polar', x: 1132, y: 605, width: 276, height: 264 },
];
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const at = 6 + index * 16;
    header[at] = size === 256 ? 0 : size; header[at + 1] = header[at];
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += png.length;
  });
  return Buffer.concat([header, ...images.map(image => image.png)]);
}
fs.mkdirSync(destination, { recursive: true });
app.setPath('userData', path.join(app.getPath('temp'), `continuum-icon-build-${process.pid}`));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 300, height: 300, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
  try {
    const source = fs.readFileSync(sourcePath);
    const imageUrl = 'data:image/png;base64,' + source.toString('base64');
    await window.loadURL('data:text/html,<html><body></body></html>');
    const rendered = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src = ${JSON.stringify(imageUrl)}; await image.decode();
      const output = [];
      for (const tile of ${JSON.stringify(tiles)}) {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
        const context = canvas.getContext('2d');
        const scale = 248 / Math.max(tile.width, tile.height);
        context.translate((256 - tile.width * scale) / 2, (256 - tile.height * scale) / 2); context.scale(scale, scale);
        const w = tile.width, h = tile.height, radius = 63;
        context.beginPath(); context.moveTo(radius, 0); context.lineTo(w-radius, 0);
        context.bezierCurveTo(w-20,0,w,20,w,radius); context.lineTo(w,h-radius);
        context.bezierCurveTo(w,h-20,w-20,h,w-radius,h); context.lineTo(radius,h);
        context.bezierCurveTo(20,h,0,h-20,0,h-radius); context.lineTo(0,radius);
        context.bezierCurveTo(0,20,20,0,radius,0); context.closePath(); context.clip();
        context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
        context.drawImage(image,tile.x,tile.y,tile.width,tile.height,0,0,tile.width,tile.height);
        output.push({ id: tile.id, image: canvas.toDataURL('image/png') });
      }
      return output;
    })()`);
    for (const item of rendered) {
      const image = nativeImage.createFromDataURL(item.image);
      if (image.isEmpty()) throw new Error(`Empty icon: ${item.id}`);
      fs.writeFileSync(path.join(destination, `${item.id}.png`), image.toPNG());
      fs.writeFileSync(path.join(destination, `${item.id}.ico`), ico(sizes.map(size => ({ size, png: image.resize({ width: size, height: size, quality: 'best' }).toPNG() }))));
    }
    fs.copyFileSync(path.join(destination, 'thread-teal.ico'), path.join(destination, 'continuum-memory-v1.ico'));
    fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ version: 1, sourceSha256: crypto.createHash('sha256').update(source).digest('hex'), sizes, tiles }, null, 2) + '\n');
    app.exit(0);
  } catch (error) {
    fs.writeFileSync(path.join(destination, 'generation-error.log'), String(error.stack || error)); app.exit(1);
  }
});
