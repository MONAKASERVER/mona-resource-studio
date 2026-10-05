export type Rgba = readonly [number, number, number, number];
export interface PixelLayer { id: string; name: string; visible: boolean; opacity: number; pixels: Uint8ClampedArray; }

export const SUPPORTED_TEXTURE_SIZES = [16, 32, 64] as const;
export const MAX_HISTORY = 50;
export const MAX_LAYERS = 16;

export function createPixels(size: number): Uint8ClampedArray { return new Uint8ClampedArray(size * size * 4); }
export function pixelOffset(size: number, x: number, y: number): number { return (y * size + x) * 4; }
export function colorAt(pixels: Uint8ClampedArray, size: number, x: number, y: number): Rgba {
  const offset = pixelOffset(size, x, y); return [pixels[offset] ?? 0, pixels[offset + 1] ?? 0, pixels[offset + 2] ?? 0, pixels[offset + 3] ?? 0];
}
export function colorsEqual(left: Rgba, right: Rgba): boolean { return left.every((value, index) => value === right[index]); }
export function setPixel(pixels: Uint8ClampedArray, size: number, x: number, y: number, color: Rgba): boolean {
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  const offset = pixelOffset(size, x, y); let changed = false;
  for (let index = 0; index < 4; index += 1) { if (pixels[offset + index] !== color[index]) changed = true; pixels[offset + index] = color[index]!; }
  return changed;
}
export function drawPoint(pixels: Uint8ClampedArray, size: number, x: number, y: number, color: Rgba, mirrorX = false, mirrorY = false): boolean {
  const points = new Set([`${x},${y}`]);
  if (mirrorX) points.add(`${size - 1 - x},${y}`); if (mirrorY) points.add(`${x},${size - 1 - y}`); if (mirrorX && mirrorY) points.add(`${size - 1 - x},${size - 1 - y}`);
  let changed = false; for (const point of points) { const [px, py] = point.split(",").map(Number); changed = setPixel(pixels, size, px!, py!, color) || changed; } return changed;
}
export function linePoints(x0: number, y0: number, x1: number, y1: number): Array<[number, number]> {
  const points: Array<[number, number]> = []; let x = x0; let y = y0; const dx = Math.abs(x1 - x0); const sx = x0 < x1 ? 1 : -1; const dy = -Math.abs(y1 - y0); const sy = y0 < y1 ? 1 : -1; let error = dx + dy;
  while (true) { points.push([x, y]); if (x === x1 && y === y1) break; const doubled = 2 * error; if (doubled >= dy) { error += dy; x += sx; } if (doubled <= dx) { error += dx; y += sy; } } return points;
}
export function floodFill(pixels: Uint8ClampedArray, size: number, startX: number, startY: number, replacement: Rgba): boolean {
  const target = colorAt(pixels, size, startX, startY); if (colorsEqual(target, replacement)) return false; const queue: Array<[number, number]> = [[startX, startY]]; const visited = new Uint8Array(size * size); let changed = false;
  while (queue.length) { const [x, y] = queue.pop()!; if (x < 0 || y < 0 || x >= size || y >= size) continue; const index = y * size + x; if (visited[index]) continue; visited[index] = 1; if (!colorsEqual(colorAt(pixels, size, x, y), target)) continue; changed = setPixel(pixels, size, x, y, replacement) || changed; queue.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]); } return changed;
}
export function transformPixels(pixels: Uint8ClampedArray, size: number, transform: "flip-x" | "flip-y" | "rotate-cw"): Uint8ClampedArray {
  const result = createPixels(size); for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) { const [targetX, targetY] = transform === "flip-x" ? [size - 1 - x, y] : transform === "flip-y" ? [x, size - 1 - y] : [size - 1 - y, x]; setPixel(result, size, targetX, targetY, colorAt(pixels, size, x, y)); } return result;
}
export function compositeLayers(layers: readonly PixelLayer[], size: number): Uint8ClampedArray {
  const result = createPixels(size);
  for (const layer of layers) {
    if (!layer.visible || layer.opacity <= 0) continue;
    for (let offset = 0; offset < result.length; offset += 4) {
      const sourceAlpha = ((layer.pixels[offset + 3] ?? 0) / 255) * Math.max(0, Math.min(1, layer.opacity)); if (sourceAlpha === 0) continue; const destinationAlpha = (result[offset + 3] ?? 0) / 255; const outputAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel += 1) result[offset + channel] = Math.round((((layer.pixels[offset + channel] ?? 0) * sourceAlpha) + ((result[offset + channel] ?? 0) * destinationAlpha * (1 - sourceAlpha))) / outputAlpha);
      result[offset + 3] = Math.round(outputAlpha * 255);
    }
  }
  return result;
}
export function rgbaToHex(color: Rgba): string { return `#${color.slice(0, 3).map((channel) => channel.toString(16).padStart(2, "0")).join("")}`; }
export function hexToRgba(hex: string, alpha = 255): Rgba { const value = hex.replace(/^#/, ""); if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error("invalid_hex"); return [Number.parseInt(value.slice(0, 2), 16), Number.parseInt(value.slice(2, 4), 16), Number.parseInt(value.slice(4, 6), 16), alpha]; }
export function cloneLayers(layers: readonly PixelLayer[]): PixelLayer[] { return layers.map((layer) => ({ ...layer, pixels: layer.pixels.slice() })); }

