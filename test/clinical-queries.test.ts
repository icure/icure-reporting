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

describe('Clinical queries — screening', () => {
	it('should parse colon cancer screening (SVC with PAT age filters)', () => {
		const result = parse(
			'SVC[((BE-THESAURUS-PROCEDURES=="D36.002"{<2y} | BE-THESAURUS-PROCEDURES=="D40.001"{<5y}) & (PAT[active=="true"] & PAT[age>50y] & PAT[age<75y]))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('IntersectionFilter')
		// Left: union of two procedure codes
		const union = result.filter.filters[0]
		expect(union.$type).toBe('UnionFilter')
		expect(union.filters).toHaveLength(2)
		expect(union.filters[0].key).toBe('BE-THESAURUS-PROCEDURES')
		expect(union.filters[0].value).toBe('D36.002')
		expect(union.filters[0].startDate).toBeDefined()
		// Right: intersection of active + age constraints
		const patFilters = result.filter.filters[1]
		expect(patFilters.$type).toBe('IntersectionFilter')
	})

	it('should parse breast cancer screening (SVC with gender and age filters)', () => {
		const result = parse(
			'SVC[(((BE-THESAURUS-PROCEDURES=="X41.002"{<2y} | BE-THESAURUS-PROCEDURES=="X41.005"{<2y} | BE-THESAURUS-PROCEDURES=="X41.007"{<2y} | BE-THESAURUS-PROCEDURES=="X41.006"{<2y} | BE-THESAURUS-PROCEDURES=="X41.008"{<2y} | BE-THESAURUS-PROCEDURES=="X41.004"{<2y})) & (PAT[active=="true"] & PAT[age>50y] & PAT[age<70y] & PAT[(gender=="female" | gender=="changedToMale")]))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		// Top-level intersection: procedures & patient criteria
		expect(result.filter.$type).toBe('IntersectionFilter')
		const procedureUnion = result.filter.filters[0]
		expect(procedureUnion.$type).toBe('UnionFilter')
		expect(procedureUnion.filters).toHaveLength(6)
		procedureUnion.filters.forEach((f: any) => {
			expect(f.key).toBe('BE-THESAURUS-PROCEDURES')
			expect(f.startDate).toBeDefined()
		})
	})

	it('should parse cervical cancer screening (SVC with age-stratified criteria)', () => {
		const result = parse(
			'SVC[((PAT[active=="true"] & PAT[age>25y] & PAT[age<30y] & PAT[(gender=="female" | gender=="changedToMale")] & (BE-THESAURUS-PROCEDURES=="X37.002"{<3y} | BE-THESAURUS-PROCEDURES=="X37.003"{<3y})) | (PAT[active=="true"] & PAT[age>30y] & PAT[age<65y] & PAT[(gender=="female" | gender=="changedToMale")] & (BE-THESAURUS-PROCEDURES=="MSP008065"{<5y} | BE-THESAURUS-PROCEDURES=="X37.002"{<5y} | BE-THESAURUS-PROCEDURES=="X37.003"{<5y} | BE-THESAURUS-PROCEDURES=="MSP008181"{<5y})))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		// Two age strata combined with union
		expect(result.filter.$type).toBe('UnionFilter')
		expect(result.filter.filters).toHaveLength(2)
		// Each stratum is an intersection
		result.filter.filters.forEach((f: any) => {
			expect(f.$type).toBe('IntersectionFilter')
		})
	})
})

describe('Clinical queries — active patients with consultations', () => {
	it('should parse PAT with CTC consultation subquery (2-year window)', () => {
		const result = parse(
			'PAT[active=="true" & CTC[((:CD-TRANSACTION=="consult"{<2y} | :CD-TRANSACTION=="homevisit"{<2y} | :CD-TRANSACTION=="hospitalvisit"{<2y} | :CD-TRANSACTION=="resthomevisit"{<2y}) | (:CD-ENCOUNTER=="consult"{<2y} | :CD-ENCOUNTER=="homevisit"{<2y} | :CD-ENCOUNTER=="hospitalvisit"{<2y} | :CD-ENCOUNTER=="resthomevisit"{<2y}) | (:CD-ITEM-EXT=="consult"{<2y} | :CD-ITEM-EXT=="homevisit"{<2y} | :CD-ITEM-EXT=="hospitalvisit"{<2y} | :CD-ITEM-EXT=="resthomevisit"{<2y}))]]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('PAT')
		expect(result.filter.$type).toBe('IntersectionFilter')
		// One filter is active==true, the other is a CTC subquery
		const ctcSubquery = result.filter.filters.find((f: any) => f.entity === 'CTC')
		expect(ctcSubquery).toBeDefined()
		expect(ctcSubquery.filter.$type).toBe('UnionFilter')
		// Three groups of contact types
		expect(ctcSubquery.filter.filters).toHaveLength(3)
	})

	it('should parse CTC with PAT active intersection (contacts target)', () => {
		const result = parse(
			'CTC[((:CD-TRANSACTION=="consult"{<2y} | :CD-TRANSACTION=="homevisit"{<2y} | :CD-TRANSACTION=="hospitalvisit"{<2y} | :CD-TRANSACTION=="resthomevisit"{<2y}) | (:CD-ENCOUNTER=="consult"{<2y} | :CD-ENCOUNTER=="homevisit"{<2y} | :CD-ENCOUNTER=="hospitalvisit"{<2y} | :CD-ENCOUNTER=="resthomevisit"{<2y}) | (:CD-ITEM-EXT=="consult"{<2y} | :CD-ITEM-EXT=="homevisit"{<2y} | :CD-ITEM-EXT=="hospitalvisit"{<2y} | :CD-ITEM-EXT=="resthomevisit"{<2y})) & PAT[active=="true"]]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('CTC')
		expect(result.filter.$type).toBe('IntersectionFilter')
	})

	it('should parse SVC wrapping CTC consultation subquery', () => {
		const result = parse(
			'SVC[CTC[((:CD-TRANSACTION=="consult"{<2y} | :CD-TRANSACTION=="homevisit"{<2y} | :CD-TRANSACTION=="hospitalvisit"{<2y} | :CD-TRANSACTION=="resthomevisit"{<2y}) | (:CD-ENCOUNTER=="consult"{<2y} | :CD-ENCOUNTER=="homevisit"{<2y} | :CD-ENCOUNTER=="hospitalvisit"{<2y} | :CD-ENCOUNTER=="resthomevisit"{<2y}) | (:CD-ITEM-EXT=="consult"{<2y} | :CD-ITEM-EXT=="homevisit"{<2y} | :CD-ITEM-EXT=="hospitalvisit"{<2y} | :CD-ITEM-EXT=="resthomevisit"{<2y}))]]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		// Inner filter is a CTC request
		expect(result.filter.$type).toBe('request')
		expect(result.filter.entity).toBe('CTC')
	})
})

describe('Clinical queries — health elements (HE)', () => {
	it('should parse diabetes HE with subtract (T89/T90 minus familyrisk)', () => {
		const result = parse(
			'HE[((PAT[active=="true"] & ((ICPC=="T90" | ICPC=="T89") & (:status == active-relevant | :status == active-irrelevant))) - (((ICPC=="T90" | ICPC=="T89") & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('HE')
		// Top-level is a subtract
		expect(result.filter.$type).toBe('request')
		expect(result.filter.entity).toBe('SUBTRACT')
	})

	it('should parse diabetes type 2 HE (T90 only, with subtract)', () => {
		const result = parse(
			'HE[((PAT[active=="true"] & (ICPC=="T90" & (:status == active-relevant | :status == active-irrelevant))) - ((ICPC=="T90" & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('HE')
		expect(result.filter.$type).toBe('request')
		expect(result.filter.entity).toBe('SUBTRACT')
	})

	it('should parse smoking HE (P17 minus familyrisk)', () => {
		const result = parse(
			'HE[((PAT[active=="true"] & ICPC=="P17") - ((ICPC=="P17" & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('HE')
		expect(result.filter.$type).toBe('request')
		expect(result.filter.entity).toBe('SUBTRACT')
		// Left side of subtract includes PAT active + ICPC P17
		expect(result.filter.left.$type).toBe('IntersectionFilter')
	})

	it('should parse hypertension HE (K86 + many BE-THESAURUS codes, with subtract)', () => {
		const result = parse(
			'HE[((((PAT[active=="true"]) & ((ICPC=="K86" & (:status == active-relevant | :status == active-irrelevant)) | ((BE-THESAURUS=="10043606" | BE-THESAURUS=="10013853" | BE-THESAURUS=="10039772" | BE-THESAURUS=="10043652" | BE-THESAURUS=="10043668" | BE-THESAURUS=="10086344" | BE-THESAURUS=="10111305" | BE-THESAURUS=="20000236" | BE-THESAURUS=="10029438" | BE-THESAURUS=="10043673" | BE-THESAURUS=="30000588" | BE-THESAURUS=="10039693" | BE-THESAURUS=="10043640" | BE-THESAURUS=="10043641" | BE-THESAURUS=="10113513" | BE-THESAURUS=="10119107" | BE-THESAURUS=="30000586" | BE-THESAURUS=="10024744" | BE-THESAURUS=="10043656" | BE-THESAURUS=="10116950" | BE-THESAURUS=="10118335" | BE-THESAURUS=="10119091" | BE-THESAURUS=="10118313" | BE-THESAURUS=="10119105" | BE-THESAURUS=="10122976" | BE-THESAURUS=="15002717" | BE-THESAURUS=="30000570" | BE-THESAURUS=="30000583" | BE-THESAURUS=="30000584" | BE-THESAURUS=="30000585" | BE-THESAURUS=="10043610" | BE-THESAURUS=="10118291" | BE-THESAURUS=="10118299" | BE-THESAURUS=="10118316" | BE-THESAURUS=="10118317" | BE-THESAURUS=="10118319" | BE-THESAURUS=="10118323" | BE-THESAURUS=="30000587" | BE-THESAURUS=="10024244" | BE-THESAURUS=="10046901" | BE-THESAURUS=="10122977" | BE-THESAURUS=="10032035" | BE-THESAURUS=="10118297" | BE-THESAURUS=="10118322" | BE-THESAURUS=="10118324" | BE-THESAURUS=="10118326" | BE-THESAURUS=="10024231" | BE-THESAURUS=="10032036" | BE-THESAURUS=="10115770" | BE-THESAURUS=="10118312" | BE-THESAURUS=="10118325" | BE-THESAURUS=="15002733" | BE-THESAURUS=="10024233" | BE-THESAURUS=="10118293" | BE-THESAURUS=="10116951" | BE-THESAURUS=="10119109" | BE-THESAURUS=="10122952" | BE-THESAURUS=="10115628") & (:status == active-relevant | :status == active-irrelevant))))) - ((ICPC=="K86" & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk)) | ((BE-THESAURUS=="10043606" | BE-THESAURUS=="10013853" | BE-THESAURUS=="10039772" | BE-THESAURUS=="10043652" | BE-THESAURUS=="10111305" | BE-THESAURUS=="20000236" | BE-THESAURUS=="10029438" | BE-THESAURUS=="10043673" | BE-THESAURUS=="30000588" | BE-THESAURUS=="10039693" | BE-THESAURUS=="10043640" | BE-THESAURUS=="10043641" | BE-THESAURUS=="10113513" | BE-THESAURUS=="10119107" | BE-THESAURUS=="30000586" | BE-THESAURUS=="10024744" | BE-THESAURUS=="10043656" | BE-THESAURUS=="10116950" | BE-THESAURUS=="10118335" | BE-THESAURUS=="10119091" | BE-THESAURUS=="10118313" | BE-THESAURUS=="10119105" | BE-THESAURUS=="10122976" | BE-THESAURUS=="15002717" | BE-THESAURUS=="30000570" | BE-THESAURUS=="30000583" | BE-THESAURUS=="30000584" | BE-THESAURUS=="30000585" | BE-THESAURUS=="10043610" | BE-THESAURUS=="10118291" | BE-THESAURUS=="10118299" | BE-THESAURUS=="10118316" | BE-THESAURUS=="10118317" | BE-THESAURUS=="10118319" | BE-THESAURUS=="10118323" | BE-THESAURUS=="30000587" | BE-THESAURUS=="10024244" | BE-THESAURUS=="10046901" | BE-THESAURUS=="10122977" | BE-THESAURUS=="10032035" | BE-THESAURUS=="10118297" | BE-THESAURUS=="10118322" | BE-THESAURUS=="10118324" | BE-THESAURUS=="10118326" | BE-THESAURUS=="10024231" | BE-THESAURUS=="10032036" | BE-THESAURUS=="10115770" | BE-THESAURUS=="10118312" | BE-THESAURUS=="10118325" | BE-THESAURUS=="15002733" | BE-THESAURUS=="10024233" | BE-THESAURUS=="10118293" | BE-THESAURUS=="10116951" | BE-THESAURUS=="10119109" | BE-THESAURUS=="10122952" | BE-THESAURUS=="10115628" | BE-THESAURUS=="10043668" | BE-THESAURUS=="10086344") & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('HE')
		expect(result.filter.$type).toBe('request')
		expect(result.filter.entity).toBe('SUBTRACT')
	})

	it('should parse cancers HE (D75/X75/X76 minus familyrisk)', () => {
		const result = parse(
			'HE[((PAT[active=="true"] & (ICPC=="D75" | ICPC=="X75" | ICPC=="X76")) - (((ICPC=="D75" | ICPC=="X75" | ICPC=="X76") & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('HE')
		expect(result.filter.$type).toBe('request')
		expect(result.filter.entity).toBe('SUBTRACT')
		// Left has intersection of active PAT + cancer codes union
		const left = result.filter.left
		expect(left.$type).toBe('IntersectionFilter')
	})
})

describe('Clinical queries — CTC contacts with date ranges', () => {
	it('should parse 2025 consultations by specific HCPs', () => {
		const result = parse(
			'CTC[((((:CD-TRANSACTION=="consult"{20250101->20251231} | :CD-TRANSACTION=="homevisit"{20250101->20251231} | :CD-TRANSACTION=="hospitalvisit"{20250101->20251231} | :CD-TRANSACTION=="resthomevisit"{20250101->20251231}) | (:CD-ENCOUNTER=="consult"{20250101->20251231} | :CD-ENCOUNTER=="homevisit"{20250101->20251231} | :CD-ENCOUNTER=="hospitalvisit"{20250101->20251231} | :CD-ENCOUNTER=="resthomevisit"{20250101->20251231}) | (:CD-ITEM-EXT=="consult"{20250101->20251231} | :CD-ITEM-EXT=="homevisit"{20250101->20251231} | :CD-ITEM-EXT=="hospitalvisit"{20250101->20251231} | :CD-ITEM-EXT=="resthomevisit"{20250101->20251231}))) & (hcp=="e5cc8099-eb9b-4ac7-8c80-99eb9b0ac7be" | hcp=="b0d9398e-f7ee-4501-9939-8ef7ee95016b" | hcp=="4e98c074-8b4b-426d-a8ac-25d610f9c6f6"))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('CTC')
		expect(result.filter.$type).toBe('IntersectionFilter')
		// Second filter is hcp union
		const hcpUnion = result.filter.filters[1]
		expect(hcpUnion.$type).toBe('UnionFilter')
		expect(hcpUnion.filters).toHaveLength(3)
		hcpUnion.filters.forEach((f: any) => {
			expect(f.key).toBe('hcp')
		})
	})
})

describe('Clinical queries — vaccination', () => {
	it('should parse flu vaccination tracking (seasonal influenza + refused lifecycle)', () => {
		const result = parse(
			'SVC[((CD-VACCINEINDICATION=="seasonalinfluenza"{20250701->20260131} | CD-VACCINEINDICATION==SEASONALINFLUENZA{20250701->20260131} | BE-THESAURUS-PROCEDURES=="R44.003"{20250701->20260131} | (BE-THESAURUS-PROCEDURES=="R44.003" & (:CD-LIFECYCLE == refused | :CD-LIFECYCLE-EXT == refused))) & (PAT[active=="true"] & PAT[age>64y]))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('IntersectionFilter')
		// Left: union of vaccine indicators
		const vaccineUnion = result.filter.filters[0]
		expect(vaccineUnion.$type).toBe('UnionFilter')
		// Right: active + age>64y
		const patCriteria = result.filter.filters[1]
		expect(patCriteria.$type).toBe('IntersectionFilter')
	})

	it('should parse simple flu vaccination tracking (without PAT filters)', () => {
		const result = parse(
			'SVC[CD-VACCINEINDICATION=="seasonalinfluenza"{20250701->20260131} | CD-VACCINEINDICATION==SEASONALINFLUENZA{20250701->20260131} | BE-THESAURUS-PROCEDURES=="R44.003"{20250701->20260131} | (BE-THESAURUS-PROCEDURES=="R44.003" & (:CD-LIFECYCLE == refused | :CD-LIFECYCLE-EXT == refused))]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('UnionFilter')
		// Check date ranges on first indicator
		const first = result.filter.filters[0]
		expect(first.startDate).toBe('20250701')
		expect(first.endDate).toBe('20260131')
	})
})

describe('Clinical queries — medication (SVC)', () => {
	it('should parse GLP-1 analogues with active PAT filter', () => {
		const result = parse(
			'SVC[(CD-DRUG-CNK=="3831153" | CD-DRUG-CNK=="4239737" | CD-DRUG-CNK=="4200572" | CD-DRUG-CNK=="3831138" | CD-DRUG-CNK=="3831146" | CD-DRUG-CNK=="4271649" | CD-DRUG-CNK=="4213724" | CD-DRUG-CNK=="4271771" | CD-DRUG-CNK=="4216321" | CD-DRUG-CNK=="4271789" | CD-DRUG-CNK=="4216347" | CD-DRUG-CNK=="4235453" | CD-DRUG-CNK=="3275989" | CD-DRUG-CNK=="4201984" | CD-DRUG-CNK=="3275971" | CD-DRUG-CNK=="2652121" | CD-DRUG-CNK=="3340478") & PAT[active=="true"]]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('IntersectionFilter')
		const cnkUnion = result.filter.filters[0]
		expect(cnkUnion.$type).toBe('UnionFilter')
		expect(cnkUnion.filters).toHaveLength(17)
		cnkUnion.filters.forEach((f: any) => {
			expect(f.key).toBe('CD-DRUG-CNK')
		})
	})

	it('should parse simple GLP-1 analogues (without PAT filter)', () => {
		const result = parse(
			'SVC[(CD-DRUG-CNK=="3831153" | CD-DRUG-CNK=="4239737" | CD-DRUG-CNK=="4200572" | CD-DRUG-CNK=="3831138" | CD-DRUG-CNK=="3831146" | CD-DRUG-CNK=="4271649" | CD-DRUG-CNK=="4213724" | CD-DRUG-CNK=="4271771" | CD-DRUG-CNK=="4216321" | CD-DRUG-CNK=="4271789" | CD-DRUG-CNK=="4216347" | CD-DRUG-CNK=="4235453" | CD-DRUG-CNK=="3275989" | CD-DRUG-CNK=="4201984" | CD-DRUG-CNK=="3275971" | CD-DRUG-CNK=="2652121" | CD-DRUG-CNK=="3340478")]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('UnionFilter')
		expect(result.filter.filters).toHaveLength(17)
	})

	it('should parse antidepressants with active PAT and date ranges (many ATC codes)', () => {
		const result = parse(
			'SVC[(CD-ATC=="N06A"{20180101->20260331} | CD-ATC=="N06AA01"{20180101->20260331} | CD-ATC=="N06AA02"{20180101->20260331} | CD-ATC=="N06AA04"{20180101->20260331} | CD-ATC=="N06AA05"{20180101->20260331} | CD-ATC=="N06AA06"{20180101->20260331} | CD-ATC=="N06AA07"{20180101->20260331} | CD-ATC=="N06AA08"{20180101->20260331} | CD-ATC=="N06AA09"{20180101->20260331} | CD-ATC=="N06AA10"{20180101->20260331} | CD-ATC=="N06AA11"{20180101->20260331} | CD-ATC=="N06AA12"{20180101->20260331} | CD-ATC=="N06AA13"{20180101->20260331} | CD-ATC=="N06AA14"{20180101->20260331} | CD-ATC=="N06AA15"{20180101->20260331} | CD-ATC=="N06AA16"{20180101->20260331} | CD-ATC=="N06AA17"{20180101->20260331} | CD-ATC=="N06AA18"{20180101->20260331} | CD-ATC=="N06AA19"{20180101->20260331} | CD-ATC=="N06AA21"{20180101->20260331} | CD-ATC=="N06AA23"{20180101->20260331} | CD-ATC=="N06AB02"{20180101->20260331} | CD-ATC=="N06AB03"{20180101->20260331} | CD-ATC=="N06AB04"{20180101->20260331} | CD-ATC=="N06AB05"{20180101->20260331} | CD-ATC=="N06AB06"{20180101->20260331} | CD-ATC=="N06AB07"{20180101->20260331} | CD-ATC=="N06AB08"{20180101->20260331} | CD-ATC=="N06AB09"{20180101->20260331} | CD-ATC=="N06AB10"{20180101->20260331} | CD-ATC=="N06AF01"{20180101->20260331} | CD-ATC=="N06AF02"{20180101->20260331} | CD-ATC=="N06AF03"{20180101->20260331} | CD-ATC=="N06AF04"{20180101->20260331} | CD-ATC=="N06AF05"{20180101->20260331} | CD-ATC=="N06AF06"{20180101->20260331} | CD-ATC=="N06AG02"{20180101->20260331} | CD-ATC=="N06AG03"{20180101->20260331} | CD-ATC=="N06AX01"{20180101->20260331} | CD-ATC=="N06AX02"{20180101->20260331} | CD-ATC=="N06AX03"{20180101->20260331} | CD-ATC=="N06AX04"{20180101->20260331} | CD-ATC=="N06AX06"{20180101->20260331} | CD-ATC=="N06AX07"{20180101->20260331} | CD-ATC=="N06AX08"{20180101->20260331} | CD-ATC=="N06AX09"{20180101->20260331} | CD-ATC=="N06AX10"{20180101->20260331} | CD-ATC=="N06AX11"{20180101->20260331} | CD-ATC=="N06AX12"{20180101->20260331} | CD-ATC=="N06AX13"{20180101->20260331} | CD-ATC=="N06AX14"{20180101->20260331} | CD-ATC=="N06AX15"{20180101->20260331} | CD-ATC=="N06AX16"{20180101->20260331} | CD-ATC=="N06AX17"{20180101->20260331} | CD-ATC=="N06AX18"{20180101->20260331} | CD-ATC=="N06AX19"{20180101->20260331} | CD-ATC=="N06AX21"{20180101->20260331} | CD-ATC=="N06AX22"{20180101->20260331} | CD-ATC=="N06AX23"{20180101->20260331} | CD-ATC=="N06AX24"{20180101->20260331} | CD-ATC=="N06AX26"{20180101->20260331} | CD-ATC=="N06AX27"{20180101->20260331} | CD-ATC=="N06AX28"{20180101->20260331} | CD-ATC=="N06AX29"{20180101->20260331} | CD-ATC=="N06AX31"{20180101->20260331} | CD-ATC=="N06AA03"{20180101->20260331} | CD-ATC=="N06AX"{20180101->20260331} | CD-ATC=="N06AX25"{20180101->20260331} | CD-ATC=="N06AX62"{20180101->20260331} | CD-ATC=="N06AA"{20180101->20260331} | CD-ATC=="N06AB"{20180101->20260331} | CD-ATC=="N06AF"{20180101->20260331} | CD-ATC=="N06AG"{20180101->20260331}) & PAT[active=="true"]]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('IntersectionFilter')
		const atcUnion = result.filter.filters[0]
		expect(atcUnion.$type).toBe('UnionFilter')
		expect(atcUnion.filters.length).toBeGreaterThan(70)
		// Verify all have correct date range
		atcUnion.filters.forEach((f: any) => {
			expect(f.key).toBe('CD-ATC')
			expect(f.startDate).toBe('20180101')
			expect(f.endDate).toBe('20260331')
		})
	})

	it('should parse simple antidepressants (without PAT filter)', () => {
		const result = parse(
			'SVC[(CD-ATC=="N06A"{20180101->20260331} | CD-ATC=="N06AA01"{20180101->20260331} | CD-ATC=="N06AA02"{20180101->20260331} | CD-ATC=="N06AA04"{20180101->20260331} | CD-ATC=="N06AA05"{20180101->20260331} | CD-ATC=="N06AA06"{20180101->20260331} | CD-ATC=="N06AA07"{20180101->20260331} | CD-ATC=="N06AA08"{20180101->20260331} | CD-ATC=="N06AA09"{20180101->20260331} | CD-ATC=="N06AA10"{20180101->20260331} | CD-ATC=="N06AA11"{20180101->20260331} | CD-ATC=="N06AA12"{20180101->20260331} | CD-ATC=="N06AA13"{20180101->20260331} | CD-ATC=="N06AA14"{20180101->20260331} | CD-ATC=="N06AA15"{20180101->20260331} | CD-ATC=="N06AA16"{20180101->20260331} | CD-ATC=="N06AA17"{20180101->20260331} | CD-ATC=="N06AA18"{20180101->20260331} | CD-ATC=="N06AA19"{20180101->20260331} | CD-ATC=="N06AA21"{20180101->20260331} | CD-ATC=="N06AA23"{20180101->20260331} | CD-ATC=="N06AB02"{20180101->20260331} | CD-ATC=="N06AB03"{20180101->20260331} | CD-ATC=="N06AB04"{20180101->20260331} | CD-ATC=="N06AB05"{20180101->20260331} | CD-ATC=="N06AB06"{20180101->20260331} | CD-ATC=="N06AB07"{20180101->20260331} | CD-ATC=="N06AB08"{20180101->20260331} | CD-ATC=="N06AB09"{20180101->20260331} | CD-ATC=="N06AB10"{20180101->20260331} | CD-ATC=="N06AF01"{20180101->20260331} | CD-ATC=="N06AF02"{20180101->20260331} | CD-ATC=="N06AF03"{20180101->20260331} | CD-ATC=="N06AF04"{20180101->20260331} | CD-ATC=="N06AF05"{20180101->20260331} | CD-ATC=="N06AF06"{20180101->20260331} | CD-ATC=="N06AG02"{20180101->20260331} | CD-ATC=="N06AG03"{20180101->20260331} | CD-ATC=="N06AX01"{20180101->20260331} | CD-ATC=="N06AX02"{20180101->20260331} | CD-ATC=="N06AX03"{20180101->20260331} | CD-ATC=="N06AX04"{20180101->20260331} | CD-ATC=="N06AX06"{20180101->20260331} | CD-ATC=="N06AX07"{20180101->20260331} | CD-ATC=="N06AX08"{20180101->20260331} | CD-ATC=="N06AX09"{20180101->20260331} | CD-ATC=="N06AX10"{20180101->20260331} | CD-ATC=="N06AX11"{20180101->20260331} | CD-ATC=="N06AX12"{20180101->20260331} | CD-ATC=="N06AX13"{20180101->20260331} | CD-ATC=="N06AX14"{20180101->20260331} | CD-ATC=="N06AX15"{20180101->20260331} | CD-ATC=="N06AX16"{20180101->20260331} | CD-ATC=="N06AX17"{20180101->20260331} | CD-ATC=="N06AX18"{20180101->20260331} | CD-ATC=="N06AX19"{20180101->20260331} | CD-ATC=="N06AX21"{20180101->20260331} | CD-ATC=="N06AX22"{20180101->20260331} | CD-ATC=="N06AX23"{20180101->20260331} | CD-ATC=="N06AX24"{20180101->20260331} | CD-ATC=="N06AX26"{20180101->20260331} | CD-ATC=="N06AX27"{20180101->20260331} | CD-ATC=="N06AX28"{20180101->20260331} | CD-ATC=="N06AX29"{20180101->20260331} | CD-ATC=="N06AX31"{20180101->20260331} | CD-ATC=="N06AA03"{20180101->20260331} | CD-ATC=="N06AX"{20180101->20260331} | CD-ATC=="N06AX25"{20180101->20260331} | CD-ATC=="N06AX62"{20180101->20260331} | CD-ATC=="N06AA"{20180101->20260331} | CD-ATC=="N06AB"{20180101->20260331} | CD-ATC=="N06AF"{20180101->20260331} | CD-ATC=="N06AG"{20180101->20260331})]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('UnionFilter')
		expect(result.filter.filters.length).toBeGreaterThan(70)
	})
})

describe('Clinical queries — simple screening variants', () => {
	it('should parse simple colon cancer screening (SVC without PAT filter)', () => {
		const result = parse(
			'SVC[BE-THESAURUS-PROCEDURES=="D36.002"{<2y} | BE-THESAURUS-PROCEDURES=="D40.001"{<5y}]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('UnionFilter')
		expect(result.filter.filters).toHaveLength(2)
	})

	it('should parse simple breast cancer screening (SVC without PAT filter)', () => {
		const result = parse(
			'SVC[(BE-THESAURUS-PROCEDURES=="X41.002"{<2y} | BE-THESAURUS-PROCEDURES=="X41.005"{<2y} | BE-THESAURUS-PROCEDURES=="X41.007"{<2y} | BE-THESAURUS-PROCEDURES=="X41.006"{<2y} | BE-THESAURUS-PROCEDURES=="X41.008"{<2y} | BE-THESAURUS-PROCEDURES=="X41.004"{<2y})]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('UnionFilter')
		expect(result.filter.filters).toHaveLength(6)
	})

	it('should parse simple cervical cancer screening (SVC without PAT filter)', () => {
		const result = parse(
			'SVC[(BE-THESAURUS-PROCEDURES=="X37.002"{<5y} | BE-THESAURUS-PROCEDURES=="X37.003"{<5y}) | (BE-THESAURUS-PROCEDURES=="MSP008065"{<5y} | BE-THESAURUS-PROCEDURES=="MSP008181"{<5y})]',
		)
		expect(result.$type).toBe('request')
		expect(result.entity).toBe('SVC')
		expect(result.filter.$type).toBe('UnionFilter')
	})
})