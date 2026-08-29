/**
 * tokenizer 模块单测：黄金对照、增量一致性、模块行为。
 * 黄金对照即与 transformers 逐 token id 比对，含 added tokens 特殊匹配用例。
 *
 * 黄金数据由 deepseek_v3_tokenizer/scripts/export_fixtures.py 生成，基于 DeepSeek V4-Flash tokenizer，其词表与 V3 逐字节相同。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bpeMerge, encodeText, preTokenize, splitWithAdded, tokenCount } from '../src/tokenizer/bpe.ts'
import { BYTE_MAP_SIZE } from '../src/tokenizer/bytes.ts'
import { EMPTY_INCREMENTAL, incrementalFeed, incrementalTotal } from '../src/tokenizer/incremental.ts'

interface GoldenCase { name: string; text: string; ids: number[] }
const golden: GoldenCase[] = JSON.parse(
  readFileSync(new URL('./fixtures/dsv3-golden.json', import.meta.url), 'utf-8'),
)

describe('字节映射', () => {
  it('映射表恒为 256 项', () => {
    expect(BYTE_MAP_SIZE).toBe(256)
  })
})

describe('preTokenize 分段', () => {
  it('数字 1-3 位独立成段（R1）', () => {
    const segs = preTokenize('12345 abc 6789')
    // 注意 R3 分支2 的可选前缀会吃掉单个空格加字母，' abc' 成一段，与 Rust 一致
    expect(segs.map((s) => s.text)).toEqual(['123', '45', ' abc', ' ', '678', '9'])
  })

  it('中文连段与标点分开（R2/R3）', () => {
    const segs = preTokenize('苹果 - 你好')
    // 苹果(1 段) / ' -'(空格+负号) / ' '(前置空格) / 你好(1 段)；与 Rust 逐字节一致
    expect(segs.map((s) => s.text)).toEqual(['苹果', ' -', ' ', '你好'])
  })

  it('空格+负号合成一段（R3 分支 3，与 Rust 一致）', () => {
    const segs = preTokenize(' -')
    expect(segs.map((s) => s.text)).toEqual([' -'])
    // 合并产物：Ġ- 是一个 token (id 565 = 256 + rank 309)
    expect(bpeMerge(segs[0].codes)).toEqual([565])
  })

  it('换行与制表符独立成段（R3 分支 4/5/6）', () => {
    const segs = preTokenize('a\r\nb\nc\td')
    // 注意制表符被 R3 分支2 的可选前缀吃进 'd' 段，与 Rust 一致
    expect(segs.map((s) => s.text)).toEqual(['a', '\r\n', 'b', '\n', 'c', '\td'])
  })
})

describe('bpeMerge', () => {
  it('hello 合并为单 token，id 与官方 transformers 一致', () => {
    const ids = bpeMerge(preTokenize('hello')[0].codes)
    // 官方标准 V4-Flash tokenizer 对 'hello'(add_special_tokens=false) 输出单 token [33310]
    expect(ids).toEqual([33310])
  })

  it('中文多字 token 存在（习近平新时代中国特色社会主义思想 一词）', () => {
    const ids = encodeText('习近平新时代中国特色社会主义思想')
    expect(ids.length).toBe(1)
  })
})

describe('splitWithAdded 分段', () => {
  const PH0 = '\u003c\uff5cplace\u2581holder\u2581no\u25810\uff5c\u003e' // 全角占位符，与 data 内容一致

  it('special 全角占位符成为独立段', () => {
    const segs = splitWithAdded(`${PH0}测试`)
    expect(segs.map((s) => s.kind)).toEqual(['added', 'bpe'])
    expect(segs[0]).toMatchObject({ kind: 'added', id: 128000 })
  })

  it('占位符后接空格+中文拆成独立 bpe 段（空格与中文在 pre-tokenizer 下分开）', () => {
    const segs = splitWithAdded(`${PH0} 测试`)
    expect(segs.map((s) => s.kind)).toEqual(['added', 'bpe', 'bpe'])
    expect(encodeText(`${PH0} 测试`)).toEqual([128000, 223, 10251])
  })

  it('占位符在不同位置均成段（前/中/后）', () => {
    const segs = splitWithAdded(`先${PH0}后`)
    expect(segs.map((s) => s.kind)).toEqual(['bpe', 'added', 'bpe'])
    expect(segs[1]).toMatchObject({ kind: 'added', id: 128000 })
  })

  it('半角写法不匹配（内容是全角变体）', () => {
    const segs = splitWithAdded('<|placeholder_no_0|> 测试')
    expect(segs.every((s) => s.kind === 'bpe')).toBe(true)
  })

  it('非特殊 added token（response）命中后仍按 bpe 段处理', () => {
    const segs = splitWithAdded(' response')
    expect(segs.map((s) => s.kind)).toEqual(['bpe'])
    expect(encodeText(' response')).toEqual([4256]) // BPE 的 Ġresponse，非 128822
  })

  it('相邻占位符连续出现各成一段', () => {
    const segs = splitWithAdded(`${PH0}${PH0}`)
    expect(segs).toHaveLength(2)
    expect(segs[0]).toMatchObject({ kind: 'added', id: 128000 })
    expect(segs[1]).toMatchObject({ kind: 'added', id: 128000 })
  })
})

describe('tokenCount / encodeText', () => {
  it('空文本为零', () => {
    expect(tokenCount('')).toBe(0)
    expect(encodeText('')).toEqual([])
  })

  it('golden 对照：逐 token id 与 transformers 一致', () => {
    for (const c of golden) {
      const ids = encodeText(c.text)
      expect(ids, c.name).toEqual(c.ids)
    }
  })

  it('性能冒烟：长文本（120K 字符）毫秒级完成', () => {
    const big = golden[0].text.repeat(28).slice(0, 120_000)
    const start = performance.now()
    const n = tokenCount(big)
    const ms = performance.now() - start
    expect(n).toBeGreaterThan(10_000)
    expect(ms).toBeLessThan(5000)
  })
})

describe('IncrementalTokenizer 增量一致性', () => {
  it('分帧 feed 与一次性切分逐 token 一致', () => {
    for (const c of golden) {
      let state = EMPTY_INCREMENTAL
      let i = 0
      while (i < c.text.length) {
        const frameLen = (i % 3) + 1 // 1..3 字符一帧，可跨词边界
        const frame = c.text.slice(i, i + frameLen)
        const r = incrementalFeed(state, frame)
        state = r.state
        i += frameLen
      }
      expect(incrementalTotal(state), c.name).toBe(c.ids.length)
      expect(tokenCount(c.text), c.name).toBe(c.ids.length)
    }
  })

  it('真实长句重复 100 次：增量、一次性、官方三者精确一致（覆盖截断路径）', () => {
    // 真实混合中英长句（含空格/标点，pre-token 拆成多段，有真实词级合并），重复 100 次
    // 总长 10700 字符远超 MAX_TAIL_CHARS，覆盖 truncateTail 截断路径
    const sentence =
      '深度学习的 Tokenizer 需要高效处理中英文混排，比如把 Hello, 你好 这样的文本正确切分，' +
      '同时保持字节级 BPE 的无损对齐。代码片段也应被精确计数：let x = 42; return x + 1;'
    const long = sentence.repeat(100)
    // 官方 V4-Flash tokenizer 对同文一次性计数 5600（已核实），本地无上限一次性切分逐字对齐
    expect(tokenCount(long)).toBe(5_600)
    let state = EMPTY_INCREMENTAL
    for (let i = 0; i < long.length; i += 7) {
      state = incrementalFeed(state, long.slice(i, i + 7)).state
    }
    // 增量截断只整段结算不切开，无跨边界合并损失，故精确等于官方与一次性，而非容差
    expect(incrementalTotal(state)).toBe(5_600)
  })

  it('空帧不变', () => {
    const r = incrementalFeed(EMPTY_INCREMENTAL, '')
    expect(r.added).toBe(0)
    expect(r.state).toBe(EMPTY_INCREMENTAL)
  })
})