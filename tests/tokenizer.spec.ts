/**
 * tokenizer 模块单测：黄金对照（transformers 逐 token id）+ 增量一致性 + 模块行为。
 *
 * 黄金数据由 deepseek_v3_tokenizer/scripts/export_fixtures.py 生成
 * （基于 DeepSeek V4-Flash tokenizer，词表与 V3 逐字节相同）。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { bpeMerge, encodeText, preTokenize, tokenCount } from '../src/tokenizer/bpe.ts'
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
    // 注意 R3 分支2 的可选前缀会吃掉单个空格 + 字母（' abc' 一段，与 Rust 一致）
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
    // 注意制表符被 R3 分支2 的可选前缀吃进 'd' 段（与 Rust 一致）
    expect(segs.map((s) => s.text)).toEqual(['a', '\r\n', 'b', '\n', 'c', '\td'])
  })
})

describe('bpeMerge', () => {
  it('hello 合并后 token 数少于字符数', () => {
    const ids = bpeMerge(preTokenize('hello')[0].codes)
    expect(ids.length).toBeLessThan(5)
    expect(ids.every((n) => Number.isInteger(n) && n >= 0)).toBe(true)
  })

  it('中文多字 token 存在（习近平新时代中国特色社会主义思想 一词）', () => {
    const ids = encodeText('习近平新时代中国特色社会主义思想')
    expect(ids.length).toBe(1)
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
        const frameLen = (i % 3) + 1 // 1..3 字符一帧（跨词边界）
        const frame = c.text.slice(i, i + frameLen)
        const r = incrementalFeed(state, frame)
        state = r.state
        i += frameLen
      }
      expect(incrementalTotal(state), c.name).toBe(c.ids.length)
      expect(tokenCount(c.text), c.name).toBe(c.ids.length)
    }
  })

  it('超长 buffer 截断后仍与一次性切分一致（有界误差容忍内）', () => {
    // 构造一个单一段超长的中文串（覆盖 truncateTail 路径），验证不抛错且计数接近
    const long = '中'.repeat(20_000) + '尾' + '文'.repeat(5)
    let state = EMPTY_INCREMENTAL
    for (let i = 0; i < long.length; i += 7) {
      state = incrementalFeed(state, long.slice(i, i + 7)).state
    }
    const total = incrementalTotal(state)
    expect(total).toBeGreaterThan(0)
    // 截断处最多损失一个段内合并的计数，误差 ≤ 1 段 token 数（此处为 +1 补偿会偏大，
    // 断言总数不超过一次性计数 + 5）
    const oneShot = tokenCount(long)
    expect(Math.abs(total - oneShot)).toBeLessThanOrEqual(5)
  })

  it('空帧不变', () => {
    const r = incrementalFeed(EMPTY_INCREMENTAL, '')
    expect(r.added).toBe(0)
    expect(r.state).toBe(EMPTY_INCREMENTAL)
  })
})