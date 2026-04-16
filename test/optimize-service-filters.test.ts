import { describe, it, expect } from 'vitest'
import { optimizeServiceFilters } from '../src/filters'
import type {
	FilterNode,
	IntersectionFilter,
	RequestNode,
	ServiceByHcPartyCodesFilter,
	ServiceByHcPartyPatientCodesFilter,
	ServiceByHcPartyPatientTagCodesFilter,
	ServiceByHcPartyTagCodeDateFilter,
	ServiceByHcPartyTagCodesFilter,
	ServiceBySecretForeignKeys,
	UnionFilter,
} from '../src/types'

const HCP = 'hcp-1'
const OPTS = { deferServiceTag: false, hcpartyId: HCP }
const OPTS_DEFER = { deferServiceTag: true, hcpartyId: HCP }

function tagCodeDate(
	overrides: Partial<ServiceByHcPartyTagCodeDateFilter> = {},
): ServiceByHcPartyTagCodeDateFilter {
	return {
		$type: 'ServiceByHcPartyTagCodeDateFilter',
		healthcarePartyId: HCP,
		...overrides,
	}
}

function sfks(patientSecretForeignKeys: string[]): ServiceBySecretForeignKeys {
	return {
		$type: 'ServiceBySecretForeignKeys',
		healthcarePartyId: HCP,
		patientSecretForeignKeys,
	}
}

describe('optimizeServiceFilters: standalone leaves', () => {
	it('rewrites code-only TagCodeDate to ServiceByHcPartyCodesFilter', () => {
		const result = optimizeServiceFilters(
			tagCodeDate({ codeType: 'ICPC', codeCode: 'T89' }),
			OPTS,
		)
		const f = result.filter as ServiceByHcPartyCodesFilter
		expect(f.$type).toBe('ServiceByHcPartyCodesFilter')
		expect(f.codeCodes).toEqual({ ICPC: ['T89'] })
		expect(f.healthcarePartyId).toBe(HCP)
		expect(result.postFilters).toEqual([])
	})

	it('rewrites tag-only TagCodeDate to ServiceByHcPartyTagCodesFilter', () => {
		const result = optimizeServiceFilters(
			tagCodeDate({ tagType: 'CD-ITEM', tagCode: 'diagnosis' }),
			OPTS,
		)
		const f = result.filter as ServiceByHcPartyTagCodesFilter
		expect(f.$type).toBe('ServiceByHcPartyTagCodesFilter')
		expect(f.tagCodes).toEqual({ 'CD-ITEM': ['diagnosis'] })
		expect(result.postFilters).toEqual([])
	})

	it('rewrites code+tag TagCodeDate to intersection of both non-patient filters by default', () => {
		const result = optimizeServiceFilters(
			tagCodeDate({
				codeType: 'ICPC',
				codeCode: 'T89',
				tagType: 'CD-ITEM',
				tagCode: 'diagnosis',
			}),
			OPTS,
		)
		const f = result.filter as IntersectionFilter
		expect(f.$type).toBe('IntersectionFilter')
		expect(f.filters).toHaveLength(2)
		expect(f.filters[0].$type).toBe('ServiceByHcPartyTagCodesFilter')
		expect(f.filters[1].$type).toBe('ServiceByHcPartyCodesFilter')
		expect(result.postFilters).toEqual([])
	})

	it('rewrites code+tag to codes-only + tag post-filter when deferServiceTag is set', () => {
		const result = optimizeServiceFilters(
			tagCodeDate({
				codeType: 'ICPC',
				codeCode: 'T89',
				tagType: 'CD-ITEM',
				tagCode: 'diagnosis',
			}),
			OPTS_DEFER,
		)
		const f = result.filter as ServiceByHcPartyCodesFilter
		expect(f.$type).toBe('ServiceByHcPartyCodesFilter')
		expect(f.codeCodes).toEqual({ ICPC: ['T89'] })
		expect(result.postFilters).toHaveLength(1)

		// The post-filter checks for the tag on the service
		const pf = result.postFilters[0]
		expect(pf({ tags: [{ type: 'CD-ITEM', code: 'diagnosis' }] } as never)).toBe(true)
		expect(pf({ tags: [{ type: 'CD-ITEM', code: 'other' }] } as never)).toBe(false)
		expect(pf({ tags: [] } as never)).toBe(false)
		expect(pf({} as never)).toBe(false)
	})

	it('converts string dates to numbers', () => {
		const result = optimizeServiceFilters(
			tagCodeDate({
				codeType: 'ICPC',
				codeCode: 'T89',
				startValueDate: '20240101000000',
				endValueDate: '20241231000000',
			}),
			OPTS,
		)
		const f = result.filter as ServiceByHcPartyCodesFilter
		expect(f.startValueDate).toBe(20240101000000)
		expect(f.endValueDate).toBe(20241231000000)
	})

	it('leaves a TagCodeDate with no code and no tag unchanged', () => {
		const input = tagCodeDate({})
		const result = optimizeServiceFilters(input, OPTS)
		expect(result.filter).toBe(input)
		expect(result.postFilters).toEqual([])
	})
})

describe('optimizeServiceFilters: intersection collapse', () => {
	it('collapses Intersection[TagCodeDate(code), SFKs] to ServiceByHcPartyPatientCodesFilter', () => {
		const inter: IntersectionFilter = {
			$type: 'IntersectionFilter',
			filters: [
				tagCodeDate({ codeType: 'ICPC', codeCode: 'T89' }),
				sfks(['sfk1', 'sfk2']),
			],
		}
		const result = optimizeServiceFilters(inter, OPTS)
		const f = result.filter as ServiceByHcPartyPatientCodesFilter
		expect(f.$type).toBe('ServiceByHcPartyPatientCodesFilter')
		expect(f.codeCodes).toEqual({ ICPC: ['T89'] })
		expect(f.patientSecretForeignKeys).toEqual(['sfk1', 'sfk2'])
		expect(result.postFilters).toEqual([])
	})

	it('collapses Intersection[TagCodeDate(tag), SFKs] to ServiceByHcPartyPatientTagCodesFilter', () => {
		const inter: IntersectionFilter = {
			$type: 'IntersectionFilter',
			filters: [
				tagCodeDate({ tagType: 'CD-ITEM', tagCode: 'diagnosis' }),
				sfks(['sfk1']),
			],
		}
		const result = optimizeServiceFilters(inter, OPTS)
		const f = result.filter as ServiceByHcPartyPatientTagCodesFilter
		expect(f.$type).toBe('ServiceByHcPartyPatientTagCodesFilter')
		expect(f.tagCodes).toEqual({ 'CD-ITEM': ['diagnosis'] })
		expect(f.patientSecretForeignKeys).toEqual(['sfk1'])
	})

	it('collapses Intersection[TagCodeDate(code+tag), SFKs] to flat intersection of both patient filters', () => {
		const inter: IntersectionFilter = {
			$type: 'IntersectionFilter',
			filters: [
				tagCodeDate({
					codeType: 'ICPC',
					codeCode: 'T89',
					tagType: 'CD-ITEM',
					tagCode: 'diagnosis',
				}),
				sfks(['sfk1']),
			],
		}
		const result = optimizeServiceFilters(inter, OPTS)
		const f = result.filter as IntersectionFilter
		expect(f.$type).toBe('IntersectionFilter')
		expect(f.filters).toHaveLength(2)
		expect(f.filters[0].$type).toBe('ServiceByHcPartyPatientTagCodesFilter')
		expect(f.filters[1].$type).toBe('ServiceByHcPartyPatientCodesFilter')
		const codesFilter = f.filters[1] as ServiceByHcPartyPatientCodesFilter
		expect(codesFilter.patientSecretForeignKeys).toEqual(['sfk1'])
		expect(result.postFilters).toEqual([])
	})

	it('collapses Intersection[TagCodeDate(code+tag), SFKs] with deferServiceTag to single filter + post-filter', () => {
		const inter: IntersectionFilter = {
			$type: 'IntersectionFilter',
			filters: [
				tagCodeDate({
					codeType: 'ICPC',
					codeCode: 'T89',
					tagType: 'CD-ITEM',
					tagCode: 'diagnosis',
				}),
				sfks(['sfk1']),
			],
		}
		const result = optimizeServiceFilters(inter, OPTS_DEFER)
		const f = result.filter as ServiceByHcPartyPatientCodesFilter
		expect(f.$type).toBe('ServiceByHcPartyPatientCodesFilter')
		expect(f.patientSecretForeignKeys).toEqual(['sfk1'])
		expect(result.postFilters).toHaveLength(1)
	})

	it('keeps unrelated siblings in the collapsed intersection', () => {
		const unrelated: FilterNode = {
			$type: 'PatientByIdsFilter',
			ids: ['p1'],
		}
		const inter: IntersectionFilter = {
			$type: 'IntersectionFilter',
			filters: [
				tagCodeDate({ codeType: 'ICPC', codeCode: 'T89' }),
				sfks(['sfk1']),
				unrelated,
			],
		}
		const result = optimizeServiceFilters(inter, OPTS)
		const f = result.filter as IntersectionFilter
		expect(f.$type).toBe('IntersectionFilter')
		expect(f.filters).toHaveLength(2)
		expect(f.filters[0].$type).toBe('ServiceByHcPartyPatientCodesFilter')
		expect(f.filters[1]).toBe(unrelated)
	})

	it('leaves SFKs unpaired if no TagCodeDate sibling exists', () => {
		const inter: IntersectionFilter = {
			$type: 'IntersectionFilter',
			filters: [
				sfks(['sfk1']),
				{ $type: 'PatientByIdsFilter', ids: ['p1'] } as FilterNode,
			],
		}
		const result = optimizeServiceFilters(inter, OPTS)
		const f = result.filter as IntersectionFilter
		expect(f.$type).toBe('IntersectionFilter')
		expect(f.filters).toHaveLength(2)
		// SFKs untouched
		expect(f.filters.some((c) => c.$type === 'ServiceBySecretForeignKeys')).toBe(true)
	})
})

describe('optimizeServiceFilters: tree walking', () => {
	it('descends into Request filters', () => {
		const req: RequestNode = {
			$type: 'request',
			entity: 'SVC',
			filter: tagCodeDate({ codeType: 'ICPC', codeCode: 'T89' }),
		}
		const result = optimizeServiceFilters(req, OPTS)
		const f = result.filter as RequestNode
		expect(f.$type).toBe('request')
		expect((f.filter as FilterNode).$type).toBe('ServiceByHcPartyCodesFilter')
	})

	it('collapses nested Intersection inside a Union inside a Request', () => {
		const req: RequestNode = {
			$type: 'request',
			entity: 'SVC',
			filter: {
				$type: 'UnionFilter',
				filters: [
					{
						$type: 'IntersectionFilter',
						filters: [
							tagCodeDate({ codeType: 'ICPC', codeCode: 'T89' }),
							sfks(['sfk1']),
						],
					} as FilterNode,
					tagCodeDate({ tagType: 'CD-ITEM', tagCode: 'other' }),
				],
			} as UnionFilter,
		}
		const result = optimizeServiceFilters(req, OPTS)
		const req2 = result.filter as RequestNode
		const union = req2.filter as UnionFilter
		expect(union.$type).toBe('UnionFilter')
		expect(union.filters[0].$type).toBe('ServiceByHcPartyPatientCodesFilter')
		expect(union.filters[1].$type).toBe('ServiceByHcPartyTagCodesFilter')
	})
})
