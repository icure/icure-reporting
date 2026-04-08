import { isObject, isArray, groupBy, mapValues } from 'lodash'
import { utils, WorkBook, writeFile } from 'xlsx'

const groups: Record<string, (item: Record<string, unknown>) => unknown> = {
	addresses: (a) => a.addressType,
	telecoms: (t) => t.telecomType,
}

const extractKeys = function (
	dataset: Array<Record<string, unknown>>,
	prefix = '',
): { spec: Record<string, { displayName: string }>; convDataset: Array<Record<string, unknown>> } {
	return dataset.reduce(
		(
			{
				spec,
				convDataset,
			}: {
				spec: Record<string, { displayName: string }>
				convDataset: Array<Record<string, unknown>>
			},
			r,
		) => {
			const row = Object.keys(r).reduce((row: Record<string, unknown>, k: string) => {
				const val = r[k]

				const prefixK = prefix + k

				if (isArray(val) && val.length) {
					const grouper = k in groups ? groups[k] : undefined
					if (!grouper) {
						row[prefixK] = JSON.stringify(val)
						Object.assign(spec, {
							[prefixK]: { displayName: prefixK.replace(/_/g, ' ') },
						})
					} else {
						const obj = mapValues(
							groupBy(val as Array<Record<string, unknown>>, grouper),
							(a) => a[0],
						)
						const {
							spec: subSpec,
							convDataset: [subRow],
						} = extractKeys([obj as Record<string, unknown>], `${prefixK}_`)
						Object.assign(row, subRow)
						Object.assign(spec, subSpec)
					}
				} else if (isObject(val)) {
					const {
						spec: subSpec,
						convDataset: [subRow],
					} = extractKeys([val as Record<string, unknown>], `${prefixK}_`)
					Object.assign(row, subRow)
					Object.assign(spec, subSpec)
				} else {
					row[prefixK] = val
					Object.assign(spec, { [prefixK]: { displayName: prefixK.replace(/_/g, ' ') } })
				}
				return row
			}, {})
			convDataset.push(row)
			return { spec, convDataset }
		},
		{
			spec: {} as Record<string, { displayName: string }>,
			convDataset: [] as Array<Record<string, unknown>>,
		},
	)
}

export function writeExcel(dataset: Array<Record<string, unknown>>, filePath: string): void {
	const { convDataset } = extractKeys(dataset)
	const sheet = utils.json_to_sheet(convDataset)
	const wb: WorkBook = utils.book_new()
	utils.book_append_sheet(wb, sheet, filePath.replace(/.+[\/\\]/, '').replace(/\.xlsx?$/, ''))
	writeFile(wb, filePath)
}
