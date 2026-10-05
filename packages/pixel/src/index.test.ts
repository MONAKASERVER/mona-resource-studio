import { describe, expect, it } from "vitest";
import { colorAt, compositeLayers, createPixels, drawPoint, floodFill, linePoints, setPixel, transformPixels, type PixelLayer } from "./index.js";

describe("pixel editor core", () => {
  it("draws mirrored points and lines", () => { const pixels = createPixels(4); drawPoint(pixels, 4, 0, 1, [255, 0, 0, 255], true, true); expect(colorAt(pixels, 4, 3, 2)).toEqual([255, 0, 0, 255]); expect(linePoints(0, 0, 3, 3)).toEqual([[0,0],[1,1],[2,2],[3,3]]); });
  it("fills only connected pixels", () => { const pixels = createPixels(3); for (let y = 0; y < 3; y += 1) setPixel(pixels, 3, 1, y, [0,0,0,255]); floodFill(pixels, 3, 0, 0, [1,2,3,255]); expect(colorAt(pixels, 3, 0, 2)).toEqual([1,2,3,255]); expect(colorAt(pixels, 3, 2, 2)).toEqual([0,0,0,0]); });
  it("transforms pixels without losing alpha", () => { const pixels = createPixels(2); setPixel(pixels, 2, 0, 0, [1,2,3,128]); expect(colorAt(transformPixels(pixels, 2, "rotate-cw"), 2, 1, 0)).toEqual([1,2,3,128]); });
  it("alpha-composites visible layers", () => { const bottom = createPixels(1); const top = createPixels(1); setPixel(bottom, 1, 0, 0, [0,0,255,255]); setPixel(top, 1, 0, 0, [255,0,0,255]); const layers: PixelLayer[] = [{ id:"a",name:"a",visible:true,opacity:1,pixels:bottom },{ id:"b",name:"b",visible:true,opacity:.5,pixels:top }]; expect(colorAt(compositeLayers(layers, 1), 1, 0, 0)).toEqual([128,0,128,255]); });
});

