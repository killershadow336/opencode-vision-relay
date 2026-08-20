/**
 * Ambient type declarations for the pure-JS image libraries used by resize.ts.
 * Both packages ship no bundled types; these cover only the APIs we use.
 */

declare module "pngjs" {
  export interface PNGOptions {
    width?: number
    height?: number
    fill?: boolean
  }
  export class PNG {
    constructor(options?: PNGOptions)
    readonly width: number
    readonly height: number
    data: Buffer
    static sync: {
      read(buffer: Buffer | Uint8Array, options?: { skipRescale?: boolean }): PNG
      write(png: PNG): Buffer
    }
  }
}

declare module "jpeg-js" {
  export interface DecodedJpeg {
    width: number
    height: number
    data: Uint8Array
  }
  export function decode(
    jpegData: Buffer | Uint8Array,
    options?: { useTArray?: boolean; maxMemoryUsageInMB?: number },
  ): DecodedJpeg
  export function encode(
    image: { width: number; height: number; data: Buffer | Uint8Array },
    quality?: number,
  ): { data: Buffer; width: number; height: number }
}