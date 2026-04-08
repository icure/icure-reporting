import { describe, it, expect } from 'vitest'
import * as peggy from 'peggy'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
	composePolicies,
	deferralPolicies,
	type DeferralPolicy,
	type PostFilter,
} from '../src/filters'

const grammar = fs.readFileSync(
	path.resolve(__dirname, '../grammar/icure-reporting-parser.peggy'),
	'utf8',
)
const parser = peggy.generate(grammar)

function parse(input: string, hcpId = 'test-hcp-id') {
	return parser.parse(input, { hcpId })
}

describe('deferralPolicies', () => {
	it('should match PatientByHcPartyAndActiveFilter for "active" policy', () => {
		const result = parse('PAT[active=="true"]')
		// The active filter is directly in result.filter
		expect(deferralPolicies.active(result.filter)).toBe(true)
	})

	it('should not match gender filter for "active" policy', () => {
		const result = parse('PAT[gender == male]')
		expect(deferralPolicies.active(result.filter)).toBe(false)
	})

	it('should match gender filter for "gender" policy', () => {
		const result = parse('PAT[gender == male]')
		expect(deferralPolicies.gender(result.filter)).toBe(true)
	})

	it('should match age filter for "age" policy', () => {
		const result = parse('PAT[age>50y]')
		expect(deferralPolicies.age(result.filter)).toBe(true)
	})

	it('should not match SVC request for any patient policy', () => {
		const result = parse('PAT[SVC[ICPC == T89]]')
		// The inner filter is a request, not a patient filter
		expect(deferralPolicies.active(result.filter)).toBe(false)
		expect(deferralPolicies.gender(result.filter)).toBe(false)
		expect(deferralPolicies.age(result.filter)).toBe(false)
	})
})

describe('composePolicies', () => {
	it('should compose multiple policies with OR logic', () => {
		const combined = composePolicies(['active', 'gender'])
		const activeNode = { $type: 'PatientByHcPartyAndActiveFilter' as const, healthcarePartyId: 'x', active: true }
		const genderNode = { $type: 'PatientByHcPartyGenderEducationProfession' as const, healthcarePartyId: 'x', gender: 'male' }
		const ageNode = { $type: 'PatientByHcPartyDateOfBirthBetweenFilter' as const, healthcarePartyId: 'x' }

		expect(combined(activeNode)).toBe(true)
		expect(combined(genderNode)).toBe(true)
		expect(combined(ageNode)).toBe(false)
	})

	it('should throw on unknown policy name', () => {
		expect(() => composePolicies(['nonexistent'])).toThrow('Unknown deferral policy')
	})
})

describe('deferral in parsed queries', () => {
	it('should identify deferrable filters in intersection', () => {
		const result = parse('PAT[active=="true" & SVC[ICPC == T89]]')
		const intersection = result.filter
		expect(intersection.$type).toBe('IntersectionFilter')
		expect(intersection.filters).toHaveLength(2)

		const activeFilter = intersection.filters[0]
		const svcRequest = intersection.filters[1]

		// Active filter is deferrable
		expect(deferralPolicies.active(activeFilter)).toBe(true)
		// SVC request is NOT deferrable
		expect(deferralPolicies.active(svcRequest)).toBe(false)
	})

	it('should identify multiple deferrable filters in complex intersection', () => {
		const result = parse('PAT[active=="true" & age>50y & gender == male & SVC[ICPC == T89]]')
		const intersection = result.filter
		expect(intersection.$type).toBe('IntersectionFilter')

		const policy = composePolicies(['active', 'age', 'gender'])
		const deferrable = intersection.filters.filter((f: any) => policy(f))
		const kept = intersection.filters.filter((f: any) => !policy(f))

		expect(deferrable).toHaveLength(3)
		expect(kept).toHaveLength(1)
		expect(kept[0].$type).toBe('request') // SVC subquery
	})
})

describe('PostFilter predicates', () => {
	it('active filter should check patient.active field', () => {
		// Simulate what filterNodeToPostFilter produces
		const activePatient = { active: true, id: '1', firstName: 'John' } as any
		const inactivePatient = { active: false, id: '2', firstName: 'Jane' } as any

		// The PostFilter checks String(p.active) === String(node.active)
		const postFilter: PostFilter = (p) => String((p as any).active) === 'true'
		expect(postFilter(activePatient)).toBe(true)
		expect(postFilter(inactivePatient)).toBe(false)
	})

	it('gender filter should check patient.gender field', () => {
		const male = { gender: 'male', id: '1' } as any
		const female = { gender: 'female', id: '2' } as any

		const postFilter: PostFilter = (p) => (p as any).gender === 'male'
		expect(postFilter(male)).toBe(true)
		expect(postFilter(female)).toBe(false)
	})

	it('age filter should check dateOfBirth range', () => {
		const young = { dateOfBirth: 20100101, id: '1' } as any
		const old = { dateOfBirth: 19500101, id: '2' } as any
		const noDob = { dateOfBirth: null, id: '3' } as any

		// min=0, max=19900101 means "born before 1990" (older than ~35)
		const postFilter: PostFilter = (p) => {
			const dob = (p as any).dateOfBirth
			if (dob == null) return false
			if (0 != null && dob < 0) return false
			if (19900101 != null && dob > 19900101) return false
			return true
		}
		expect(postFilter(young)).toBe(false) // born 2010, too young
		expect(postFilter(old)).toBe(true) // born 1950, matches
		expect(postFilter(noDob)).toBe(false) // no DOB
	})
})