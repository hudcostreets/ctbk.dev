import { describe, expect, test } from 'vitest'
import { factorLabel, parseSize, radiusFactor, zoomFactor } from './timelapseSize'

describe('sizing', () => {
  test('parseSize: default 1, clamped to [0.25, 2]', () => {
    expect([undefined, '', 'x', '0', '-1', '0.5', '0.1', '3', '1.4'].map((v) => parseSize(v))).toEqual([1, 1, 1, 1, 1, 0.5, 0.25, 2, 1.4])
  })
  test('zoomFactor: full size from z11, halving every 2 levels below, floored', () => {
    expect([13, 11, 10, 9, 7, 3].map((z) => Number(zoomFactor(z).toFixed(3)))).toEqual([1, 1, 0.707, 0.5, 0.35, 0.35])
  })
  test('radiusFactor = sz × zoomFactor', () => {
    expect(radiusFactor(2, 9)).toEqual(1)
    expect(radiusFactor(0.5, 12)).toEqual(0.5)
  })
  test('factorLabel', () => {
    expect([0.25, 0.5, 1, 1.4, 0.7071, 2].map(factorLabel)).toEqual(['×0.25', '×0.5', '×1', '×1.4', '×0.71', '×2'])
  })
})
