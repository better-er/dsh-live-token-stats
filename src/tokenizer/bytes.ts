/**
 * ByteLevel 字节↔unicode 映射，GPT-2 风格，与 HuggingFace tokenizers 的 ByteLevel pre-tokenizer 逐字节一致。
 *
 * 语义：0x21-0x7E、0xA1-0xAC、0xAE-0xFF 映射到自身，其余字节按序映射到 0x100 起的 unicode 码位，如空格映射为 `Ġ`。
 *
 * @module dsh-live-token-stats/tokenizer/bytes
 */

/** 构建双向映射表，模块加载时执行一次。 */
function buildMaps(): { byteToUnicode: Map<number, number>; unicodeToByte: Map<number, number> } {
  const byteToUnicode = new Map<number, number>()
  const unicodeToByte = new Map<number, number>()
  const ranges: ReadonlyArray<readonly [number, number]> = [
    [0x21, 0x7e],
    [0xa1, 0xac],
    [0xae, 0xff],
  ]
  const native = new Set<number>()
  for (const [lo, hi] of ranges) {
    for (let b = lo; b <= hi; b += 1) {
      native.add(b)
      byteToUnicode.set(b, b)
      unicodeToByte.set(b, b)
    }
  }
  let n = 0
  for (let b = 0; b < 256; b += 1) {
    if (native.has(b)) continue
    const u = 256 + n
    n += 1
    byteToUnicode.set(b, u)
    unicodeToByte.set(u, b)
  }
  return { byteToUnicode, unicodeToByte }
}

const { byteToUnicode, unicodeToByte } = buildMaps()

/** 把 UTF-8 字节序列映射为 unicode 字符串，作为 BPE 操作的载体，1 字节等于 1 码位。 */
export function bytesToChars(bytes: Uint8Array): number[] {
  const out = new Array<number>(bytes.length)
  for (let i = 0; i < bytes.length; i += 1) out[i] = byteToUnicode.get(bytes[i])!
  return out
}

/** 把文本编码为 UTF-8 字节。 */
export function charToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** 供对照测试：单字节映射表长度恒为 256。 */
export const BYTE_MAP_SIZE = unicodeToByte.size
export { unicodeToByte }