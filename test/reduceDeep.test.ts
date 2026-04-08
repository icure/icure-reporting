import { describe, it, expect } from 'vitest'
import { forEachDeep, mapDeep } from '../src/reduceDeep'

describe('forEachDeep', () => {
	it('should visit all values in a flat object', () => {
		const visited: any[] = []
		forEachDeep({ a: 1, b: 2 }, (obj) => visited.push(obj))
		expect(visited).toEqual([1, 2])
	})

	it('should visit nested objects recursively', () => {
		const visited: any[] = []
		forEachDeep({ a: { b: 1 } }, (obj) => {
			if (typeof obj !== 'object') visited.push(obj)
		})
		expect(visited).toEqual([1])
	})

	it('should visit array elements', () => {
		const visited: any[] = []
		forEachDeep([1, 2, 3], (obj) => visited.push(obj))
		expect(visited).toEqual([1, 2, 3])
	})

	it('should visit deeply nested arrays and objects', () => {
		const visited: any[] = []
		forEachDeep({ a: [{ b: 'hello' }] }, (obj) => {
			if (typeof obj === 'string') visited.push(obj)
		})
		expect(visited).toEqual(['hello'])
	})
})

describe('mapDeep', () => {
	it('should map values in a flat object', () => {
		const result = mapDeep({ a: 1, b: 2 }, (obj) => (typeof obj === 'number' ? obj * 2 : obj))
		expect(result).toEqual({ a: 2, b: 4 })
	})

	it('should map nested values', () => {
		const result = mapDeep({ a: { b: 1 } }, (obj) =>
			typeof obj === 'number' ? obj * 10 : obj,
		)
		expect(result).toEqual({ a: { b: 10 } })
	})

	it('should map array elements', () => {
		const result = mapDeep([1, 2, 3], (obj) => (typeof obj === 'number' ? obj + 1 : obj))
		expect(result).toEqual([2, 3, 4])
	})

	it('should replace objects with primitives', () => {
		const result = mapDeep({ a: { variable: '$x' } }, (obj) =>
			typeof obj === 'object' && obj?.variable === '$x' ? 42 : obj,
		)
		expect(result).toEqual({ a: 42 })
	})
})
