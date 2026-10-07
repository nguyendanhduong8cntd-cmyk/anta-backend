import sharp from 'sharp';

/** Decode and re-encode untrusted court photos; never publish the original bytes. */
export async function sanitizeCourtImage(input: Buffer) {
  const jpeg = input.length >= 3 && input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
  const png = input.length >= 8 && input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const webp = input.length >= 12 && input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) throw new Error('Unsupported image signature');
  const source = sharp(input, { failOn: 'error', limitInputPixels: 16_000_000, animated: false });
  const metadata = await source.metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format || '') || !metadata.width || !metadata.height ||
      metadata.width > 8000 || metadata.height > 8000 || (metadata.pages || 1) !== 1) {
    throw new Error('Unsupported raster image');
  }
  const output = await source.rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82, effort: 4 }).toBuffer({ resolveWithObject: true });
  if (!output.data.length || output.data.length > 10_485_760) throw new Error('Processed image is too large');
  return { body: output.data, width: output.info.width, height: output.info.height };
}
