type DeepStructure = Record<string, unknown> | unknown[]

function isDeep(x: unknown): x is DeepStructure {
	return x != null && typeof x === 'object'
}

export function forEachDeep<T extends DeepStructure>(
	objOrArray: T,
	action: (obj: unknown, parent: DeepStructure, idx: number) => void,
): void {
	if (Array.isArray(objOrArray)) {
		objOrArray.forEach((child, idx) => {
			action(child, objOrArray, idx)
			if (isDeep(child)) forEachDeep(child, action)
		})
	} else if (isDeep(objOrArray)) {
		Object.keys(objOrArray).forEach((k, idx) => {
			const child = (objOrArray as Record<string, unknown>)[k]
			action(child, objOrArray, idx)
			if (isDeep(child)) forEachDeep(child, action)
		})
	}
}

export function mapDeep<T extends DeepStructure>(
	objOrArray: T,
	map: (obj: unknown, parent: DeepStructure, idx: number) => unknown,
): T {
	if (Array.isArray(objOrArray)) {
		return (objOrArray as unknown[]).map((child, idx) => {
			const res = map(child, objOrArray, idx)
			return isDeep(res) ? mapDeep(res, map) : res
		}) as T
	} else if (isDeep(objOrArray)) {
		return Object.keys(objOrArray).reduce(
			(acc: Record<string, unknown>, k: string, idx: number) => {
				const child = (objOrArray as Record<string, unknown>)[k]
				const res = map(child, objOrArray, idx)
				acc[k] = isDeep(res) ? mapDeep(res, map) : res
				return acc
			},
			{},
		) as T
	}
	return objOrArray
}
