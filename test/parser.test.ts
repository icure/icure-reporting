import { describe, it, expect } from 'vitest'
import * as peggy from 'peggy'
import * as fs from 'node:fs'
import * as path from 'node:path'

const grammar = fs.readFileSync(
	path.resolve(__dirname, '../grammar/icure-reporting-parser.peggy'),
	'utf8',
)
const parser = peggy.generate(grammar)

function parse(input: string, hcpId = 'test-hcp-id') {
	return parser.parse(input, { hcpId })
}

describe('PEG.js parser', () => {
	it('should parse a simple patient filter with age', () => {
		const result = parse('PAT[age<2y]')
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('PAT')
		expect(result.filter.$type).toBe('PatientByHcPartyDateOfBirthBetweenFilter')
	})

	it('should parse a patient filter with gender', () => {
		const result = parse('PAT[gender == male]')
		expect(result.$type).toBe('request')
		expect(result.filter.$type).toBe('PatientByHcPartyGenderEducationProfession')
		expect(result.filter.gender).toBe('male')
	})

	it('should parse intersection (AND) filters', () => {
		const result = parse('PAT[age<50y & gender == male]')
		expect(result.filter.$type).toBe('IntersectionFilter')
		expect(result.filter.filters).toHaveLength(2)
	})

	it('should parse service filters with ICPC codes', () => {
		const result = parse('SVC[ICPC == T89]')
		expect(result.entity).toBe('SVC')
		expect(result.filter.key).toBe('ICPC')
		expect(result.filter.value).toBe('T89')
	})

	it('should parse filters with colon-prefixed keys', () => {
		const result = parse('SVC[:CD-ITEM == diagnosis]')
		expect(result.filter.colonKey).toBe('CD-ITEM')
		expect(result.filter.colonValue).toBe('diagnosis')
	})

	it('should parse union (OR) filters', () => {
		const result = parse('PAT[gender == male | gender == female]')
		expect(result.filter.$type).toBe('UnionFilter')
		expect(result.filter.filters).toHaveLength(2)
	})

	it('should parse subtract operations', () => {
		const result = parse('PAT[age<50y - gender == female]')
		expect(result.filter.$type).toBe('request')
		expect(result.filter.entity).toBe('SUBTRACT')
	})

	it('should parse negation', () => {
		const result = parse('!PAT[gender == male]')
		expect(result.$type).toBe('ComplementFilter')
		expect(result.subSet.$type).toBe('request')
	})

	it('should parse pipe reducers', () => {
		const result = parse('PAT[age<50y] | count')
		expect(result.reducers).toHaveLength(1)
		expect(result.reducers[0].reducer).toBe('count')
	})

	it('should parse reducers with parameters', () => {
		const result = parse('PAT[age<50y] | select(firstName, lastName)')
		expect(result.reducers).toHaveLength(1)
		expect(result.reducers[0].reducer).toBe('select')
		expect(result.reducers[0].params).toEqual(['firstName', 'lastName'])
	})

	it('should parse variables', () => {
		const result = parse('PAT[age>$maxAge]')
		expect(result.filter.maxDateOfBirth).toEqual({ variable: '$maxAge' })
	})

	it('should parse date ranges', () => {
		const result = parse('SVC[ICPC == T89{19500101 -> 20000101}]')
		expect(result.filter.startDate).toBe('19500101')
		expect(result.filter.endDate).toBe('20000101')
	})

	it('should parse relative date ranges with less-than', () => {
		const result = parse('SVC[ICPC == T89{<3y}]')
		expect(result.filter.startDate).toBeDefined()
		// <3y means "less than 3 years ago", endDate is empty string in the grammar
		expect(result.filter.endDate).toBeDefined()
	})

	it('should parse nested subqueries', () => {
		const result = parse('PAT[age>45y & SVC[ICPC == T89 & :CD-ITEM == diagnosis]]')
		expect(result.filter.$type).toBe('IntersectionFilter')
		const svcFilter = result.filter.filters[1]
		expect(svcFilter.entity).toBe('SVC')
	})
})
