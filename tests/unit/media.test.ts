import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { sanitizeCourtImage } from '../../modules/media/processing';

test('court photo sanitizer re-encodes raster bytes as bounded WebP', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#34aa55' } }).png().toBuffer();
  const result = await sanitizeCourtImage(png);
  assert.equal(result.width, 2);
  assert.equal(result.height, 2);
  assert.equal(result.body.toString('ascii', 0, 4), 'RIFF');
  assert.equal(result.body.toString('ascii', 8, 12), 'WEBP');
  const metadata = await sharp(result.body).metadata();
  assert.equal(metadata.format, 'webp');
});

test('court photo sanitizer rejects disguised SVG and non-images', async () => {
  await assert.rejects(sanitizeCourtImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')));
  await assert.rejects(sanitizeCourtImage(Buffer.from('not an image')));
});
