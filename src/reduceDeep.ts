import { isObject, isArray } from 'lodash'

type DeepStructure = Record<string, unknown> | unknown[]

export function forEachDeep<T extends DeepStructure>(
	objOrArray: T,
	action: (obj: unknown, parent: DeepStructure, idx: number) => void,
): void {
	if (isArray(objOrArray)) {
		objOrArray.forEach((child, idx) => {
			action(child, objOrArray, idx)
			;(isObject(child) || isArray(child)) && forEachDeep(child as DeepStructure, action)
		})
	} else if (isObject(objOrArray)) {
		Object.keys(objOrArray).forEach((k, idx) => {
			const child = (objOrArray as Record<string, unknown>)[k]
			action(child, objOrArray, idx)
			;(isObject(child) || isArray(child)) && forEachDeep(child as DeepStructure, action)
		})
	}
}

export function mapDeep<T extends DeepStructure>(
	objOrArray: T,
	map: (obj: unknown, parent: DeepStructure, idx: number) => unknown,
): T {
	if (isArray(objOrArray)) {
		return (objOrArray as unknown[]).map((child, idx) => {
			const res = map(child, objOrArray, idx)
			return isObject(res) || isArray(res) ? mapDeep(res as DeepStructure, map) : res
		}) as T
	} else if (isObject(objOrArray)) {
		return Object.keys(objOrArray).reduce(
			(acc: Record<string, unknown>, k: string, idx: number) => {
				const child = (objOrArray as Record<string, unknown>)[k]
				const res = map(child, objOrArray, idx)
				acc[k] = isObject(res) || isArray(res) ? mapDeep(res as DeepStructure, map) : res
				return acc
			},
			{},
		) as T
	}
	return objOrArray
}
