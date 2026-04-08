import { describe, it, expect, beforeAll } from 'vitest'
import { IcureApi, hex2ua } from '@icure/api'
import type { Apis, Patient } from '@icure/api'
import * as nodeCrypto from 'node:crypto'
import * as peggy from 'peggy'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { isObject } from 'lodash'

import { filter, composePolicies } from '../src/filters.js'
import { forEachDeep } from '../src/reduceDeep.js'
import { createCryptoStrategies, type KeyMap } from '../src/crypto-strategies.js'
import { FileStorageFacade, FileKeyStorageFacade } from '../src/local-storage-shim.js'

// Load .env file (Node 22 built-in)
try {
	process.loadEnvFile(path.resolve(__dirname, '../.env'))
} catch {
	// .env may not exist in CI — rely on environment variables
}

const {
	ICURE_USERNAME,
	ICURE_PASSWORD,
	ICURE_HOST,
	ICURE_HCP_ID,
	ICURE_PRIVATE_KEY,
	ICURE_PARENT_HCP_ID,
	ICURE_PARENT_PRIVATE_KEY,
} = process.env

const hasCredentials = ICURE_USERNAME && ICURE_PASSWORD && ICURE_HCP_ID && ICURE_PRIVATE_KEY

const grammar = fs.readFileSync(
	path.resolve(__dirname, '../grammar/icure-reporting-parser.peggy'),
	'utf8',
)
const parser = peggy.generate(grammar)

describe.skipIf(!hasCredentials)('E2E — query execution', () => {
	let api: Apis
	let hcpartyId: string

	beforeAll(async () => {
		const host = ICURE_HOST || 'https://qa.icure.cloud'
		const storage = new FileStorageFacade()
		const keyStorage = new FileKeyStorageFacade()
		const keyMap: KeyMap = new Map()

		// Import private key into in-memory map (same as cmdPki)
		const keyBytes = hex2ua(ICURE_PRIVATE_KEY!)
		const privateJwk = await nodeCrypto.webcrypto.subtle
			.importKey('pkcs8', keyBytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, ['decrypt'])
			.then((k) => nodeCrypto.webcrypto.subtle.exportKey('jwk', k))
		delete privateJwk.alg
		const publicJwk: JsonWebKey = {
			kty: privateJwk.kty,
			n: privateJwk.n,
			e: privateJwk.e,
			ext: true,
			key_ops: ['encrypt'],
		}
		keyMap.set(ICURE_HCP_ID!, { privateKey: privateJwk, publicKey: publicJwk })

		// Import parent keys into in-memory map
		if (ICURE_PARENT_HCP_ID && ICURE_PARENT_PRIVATE_KEY) {
			const parentKeyBytes = hex2ua(ICURE_PARENT_PRIVATE_KEY)
			const parentPrivateJwk = await nodeCrypto.webcrypto.subtle
				.importKey('pkcs8', parentKeyBytes, { name: 'RSA-OAEP', hash: 'SHA-256' }, true, [
					'decrypt',
				])
				.then((k) => nodeCrypto.webcrypto.subtle.exportKey('jwk', k))
			delete parentPrivateJwk.alg
			const parentPublicJwk: JsonWebKey = {
				kty: parentPrivateJwk.kty,
				n: parentPrivateJwk.n,
				e: parentPrivateJwk.e,
				ext: true,
				key_ops: ['encrypt'],
			}
			keyMap.set(ICURE_PARENT_HCP_ID, {
				privateKey: parentPrivateJwk,
				publicKey: parentPublicJwk,
			})
		}

		// Initialize API (same as cmdLogin)
		api = await IcureApi.initialise(
			host,
			{ username: ICURE_USERNAME!, password: ICURE_PASSWORD! },
			createCryptoStrategies(keyMap),
			nodeCrypto.webcrypto as any,
			undefined,
			{ storage, keyStorage },
		)

		const hcp = await api.healthcarePartyApi.getCurrentHealthcareParty()
		hcpartyId = hcp.id!
	}, 30_000)

	/** Parse a query string and execute it through the filter pipeline. */
	async function executeQuery(input: string, deferPolicies?: string[]) {
		const hcp = await api.healthcarePartyApi.getCurrentHealthcareParty()
		const parsedInput = parser.parse(input, { hcpId: hcp.parentId || hcp.id })

		// Verify no unresolved variables
		const vars: string[] = []
		forEachDeep(parsedInput, (obj) => {
			if (
				isObject(obj) &&
				(obj as any).variable &&
				(obj as any).variable.startsWith?.('$')
			) {
				vars.push((obj as any).variable)
			}
		})
		if (vars.length > 0) {
			throw new Error(`Unresolved variables in query: ${vars.join(', ')}`)
		}

		const deferPolicy = deferPolicies ? composePolicies(deferPolicies) : undefined

		return filter(parsedInput, api, hcpartyId, false, deferPolicy)
	}

	// --- Patient queries ---

	it('should query patients by age', async () => {
		const result = await executeQuery('PAT[age<120y]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 30_000)

	it('should query patients by age with count reducer', async () => {
		const result = await executeQuery('PAT[age<120y] | count')
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows!).toHaveLength(1)
		expect(typeof result.rows![0]).toBe('number')
		expect(result.rows![0]).toBeGreaterThanOrEqual(0)
	}, 30_000)

	it('should query patients by gender', async () => {
		const result = await executeQuery('PAT[gender == male]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
		for (const patient of result as Patient[]) {
			expect(patient.gender).toBe('male')
		}
	}, 30_000)

	it('should query patients by intersection of age and gender', async () => {
		const result = await executeQuery('PAT[age<120y & gender == female]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
		for (const patient of result as Patient[]) {
			expect(patient.gender).toBe('female')
		}
	}, 30_000)

	it('should query patients with select reducer', async () => {
		const result = await executeQuery(
			'PAT[age<120y & gender == male] | select(firstName, lastName, gender)',
		)
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		for (const row of result.rows!) {
			expect(Object.keys(row as object).every((k) => ['firstName', 'lastName', 'gender'].includes(k))).toBe(
				true,
			)
		}
	}, 30_000)

	it('should query patients with min reducer on dateOfBirth', async () => {
		const result = await executeQuery('PAT[age<120y] | min(dateOfBirth)')
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows!).toHaveLength(1)
		expect(typeof result.rows![0]).toBe('number')
	}, 30_000)

	it('should query patients with max reducer on dateOfBirth', async () => {
		const result = await executeQuery('PAT[age<120y] | max(dateOfBirth)')
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows!).toHaveLength(1)
		expect(typeof result.rows![0]).toBe('number')
	}, 30_000)

	// --- Set operations ---

	it('should handle subtraction (PAT minus gender)', async () => {
		const result = await executeQuery('PAT[age<120y - gender == male]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
		for (const patient of result as Patient[]) {
			expect(patient.gender).not.toBe('male')
		}
	}, 30_000)

	it('should handle union of patient filters', async () => {
		const result = await executeQuery('PAT[(gender == male | gender == female)] | count')
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows![0]).toBeGreaterThanOrEqual(0)
	}, 30_000)

	// --- Service queries ---

	it('should query services by code', async () => {
		const result = await executeQuery('SVC[:CD-ITEM == diagnosis]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 60_000)

	it('should query services with count reducer', async () => {
		const result = await executeQuery('SVC[:CD-ITEM == diagnosis] | count')
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows!).toHaveLength(1)
		expect(typeof result.rows![0]).toBe('number')
	}, 60_000)

	// --- Nested queries (SVC inside PAT) ---

	it('should query patients having specific services', async () => {
		const result = await executeQuery('PAT[SVC[:CD-ITEM == diagnosis]]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
		for (const patient of result as Patient[]) {
			expect(patient.id).toBeDefined()
			expect(patient.lastName || patient.firstName).toBeDefined()
		}
	}, 60_000)

	it('should query patients having services with count', async () => {
		const result = await executeQuery('PAT[SVC[:CD-ITEM == diagnosis]] | count')
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows![0]).toBeGreaterThanOrEqual(0)
	}, 60_000)

	// --- Health element queries ---

	it('should query health elements', async () => {
		const result = await executeQuery('HE[:CD-ITEM == diagnosis]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 60_000)

	it('should query patients having health elements', async () => {
		const result = await executeQuery('PAT[HE[:CD-ITEM == diagnosis]]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 60_000)

	// --- Contact queries ---

	it('should query contacts', async () => {
		const result = await executeQuery('CTC[:CD-ITEM == diagnosis]')
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 60_000)

	// --- Deferral queries ---

	it('should query with deferred active filter', async () => {
		const result = await executeQuery('PAT[age<120y & active=="true"]', ['active'])
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
		for (const patient of result as Patient[]) {
			expect(String(patient.active)).toBe('true')
		}
	}, 30_000)

	it('should query with deferred gender filter', async () => {
		const result = await executeQuery('PAT[age<120y & gender == female]', ['gender'])
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
		for (const patient of result as Patient[]) {
			expect(patient.gender).toBe('female')
		}
	}, 30_000)

	it('should query with deferred age filter', async () => {
		const result = await executeQuery('PAT[age<120y & gender == male]', ['age'])
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
		for (const patient of result as Patient[]) {
			expect(patient.gender).toBe('male')
		}
	}, 30_000)

	// --- Complex clinical queries ---

	it('should execute a complex screening query with nested SVC and PAT age filters', async () => {
		const result = await executeQuery(
			'PAT[age>50y & age<75y & SVC[:CD-ITEM == diagnosis]] | count',
		)
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows![0]).toBeGreaterThanOrEqual(0)
	}, 60_000)

	it('should execute subtract with nested service query', async () => {
		const result = await executeQuery(
			'PAT[age>45y & SVC[:CD-ITEM == diagnosis] - gender == female] | count',
		)
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows![0]).toBeGreaterThanOrEqual(0)
	}, 60_000)

	// --- Reducer pipeline ---

	it('should chain select then count', async () => {
		const result = await executeQuery('PAT[age<120y] | select(firstName, lastName)')
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		for (const row of result.rows!) {
			expect(row).toHaveProperty('firstName')
			expect(row).toHaveProperty('lastName')
			expect(Object.keys(row as object).length).toBeLessThanOrEqual(2)
		}
	}, 30_000)

	it('should compute mean of dateOfBirth', async () => {
		const result = await executeQuery('PAT[age<120y] | mean(dateOfBirth)')
		expect(result).toBeDefined()
		expect(result.rows).toBeDefined()
		expect(result.rows!).toHaveLength(1)
		expect(typeof result.rows![0]).toBe('number')
	}, 30_000)

	// --- Clinical queries — screening ---

	it('should execute colon cancer screening (SVC with PAT age filters)', async () => {
		const result = await executeQuery(
			'SVC[((BE-THESAURUS-PROCEDURES=="D36.002"{<2y} | BE-THESAURUS-PROCEDURES=="D40.001"{<5y}) & (PAT[active=="true"] & PAT[age>50y] & PAT[age<75y]))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute breast cancer screening (SVC with gender and age filters)', async () => {
		const result = await executeQuery(
			'SVC[(((BE-THESAURUS-PROCEDURES=="X41.002"{<2y} | BE-THESAURUS-PROCEDURES=="X41.005"{<2y} | BE-THESAURUS-PROCEDURES=="X41.007"{<2y} | BE-THESAURUS-PROCEDURES=="X41.006"{<2y} | BE-THESAURUS-PROCEDURES=="X41.008"{<2y} | BE-THESAURUS-PROCEDURES=="X41.004"{<2y})) & (PAT[active=="true"] & PAT[age>50y] & PAT[age<70y] & PAT[(gender=="female" | gender=="changedToMale")]))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute cervical cancer screening (SVC with age-stratified criteria)', async () => {
		const result = await executeQuery(
			'SVC[((PAT[active=="true"] & PAT[age>25y] & PAT[age<30y] & PAT[(gender=="female" | gender=="changedToMale")] & (BE-THESAURUS-PROCEDURES=="X37.002"{<3y} | BE-THESAURUS-PROCEDURES=="X37.003"{<3y})) | (PAT[active=="true"] & PAT[age>30y] & PAT[age<65y] & PAT[(gender=="female" | gender=="changedToMale")] & (BE-THESAURUS-PROCEDURES=="MSP008065"{<5y} | BE-THESAURUS-PROCEDURES=="X37.002"{<5y} | BE-THESAURUS-PROCEDURES=="X37.003"{<5y} | BE-THESAURUS-PROCEDURES=="MSP008181"{<5y})))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	// --- Clinical queries — active patients with consultations ---

	it('should execute PAT with CTC consultation subquery (2-year window)', async () => {
		const result = await executeQuery(
			'PAT[active=="true" & CTC[((:CD-TRANSACTION=="consult"{<2y} | :CD-TRANSACTION=="homevisit"{<2y} | :CD-TRANSACTION=="hospitalvisit"{<2y} | :CD-TRANSACTION=="resthomevisit"{<2y}) | (:CD-ENCOUNTER=="consult"{<2y} | :CD-ENCOUNTER=="homevisit"{<2y} | :CD-ENCOUNTER=="hospitalvisit"{<2y} | :CD-ENCOUNTER=="resthomevisit"{<2y}) | (:CD-ITEM-EXT=="consult"{<2y} | :CD-ITEM-EXT=="homevisit"{<2y} | :CD-ITEM-EXT=="hospitalvisit"{<2y} | :CD-ITEM-EXT=="resthomevisit"{<2y}))]]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute CTC with PAT active intersection (contacts target)', async () => {
		const result = await executeQuery(
			'CTC[((:CD-TRANSACTION=="consult"{<2y} | :CD-TRANSACTION=="homevisit"{<2y} | :CD-TRANSACTION=="hospitalvisit"{<2y} | :CD-TRANSACTION=="resthomevisit"{<2y}) | (:CD-ENCOUNTER=="consult"{<2y} | :CD-ENCOUNTER=="homevisit"{<2y} | :CD-ENCOUNTER=="hospitalvisit"{<2y} | :CD-ENCOUNTER=="resthomevisit"{<2y}) | (:CD-ITEM-EXT=="consult"{<2y} | :CD-ITEM-EXT=="homevisit"{<2y} | :CD-ITEM-EXT=="hospitalvisit"{<2y} | :CD-ITEM-EXT=="resthomevisit"{<2y})) & PAT[active=="true"]]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute SVC wrapping CTC consultation subquery', async () => {
		const result = await executeQuery(
			'SVC[CTC[((:CD-TRANSACTION=="consult"{<2y} | :CD-TRANSACTION=="homevisit"{<2y} | :CD-TRANSACTION=="hospitalvisit"{<2y} | :CD-TRANSACTION=="resthomevisit"{<2y}) | (:CD-ENCOUNTER=="consult"{<2y} | :CD-ENCOUNTER=="homevisit"{<2y} | :CD-ENCOUNTER=="hospitalvisit"{<2y} | :CD-ENCOUNTER=="resthomevisit"{<2y}) | (:CD-ITEM-EXT=="consult"{<2y} | :CD-ITEM-EXT=="homevisit"{<2y} | :CD-ITEM-EXT=="hospitalvisit"{<2y} | :CD-ITEM-EXT=="resthomevisit"{<2y}))]]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	// --- Clinical queries — health elements (HE) ---

	it('should execute diabetes HE with subtract (T89/T90 minus familyrisk)', async () => {
		const result = await executeQuery(
			'HE[((PAT[active=="true"] & ((ICPC=="T90" | ICPC=="T89") & (:status == active-relevant | :status == active-irrelevant))) - (((ICPC=="T90" | ICPC=="T89") & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute diabetes type 2 HE (T90 only, with subtract)', async () => {
		const result = await executeQuery(
			'HE[((PAT[active=="true"] & (ICPC=="T90" & (:status == active-relevant | :status == active-irrelevant))) - ((ICPC=="T90" & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute smoking HE (P17 minus familyrisk)', async () => {
		const result = await executeQuery(
			'HE[((PAT[active=="true"] & ICPC=="P17") - ((ICPC=="P17" & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute hypertension HE (K86 + BE-THESAURUS codes, with subtract)', async () => {
		const result = await executeQuery(
			'HE[((((PAT[active=="true"]) & ((ICPC=="K86" & (:status == active-relevant | :status == active-irrelevant)) | ((BE-THESAURUS=="10043606" | BE-THESAURUS=="10013853" | BE-THESAURUS=="10039772" | BE-THESAURUS=="10043652" | BE-THESAURUS=="10043668" | BE-THESAURUS=="10086344" | BE-THESAURUS=="10111305" | BE-THESAURUS=="20000236" | BE-THESAURUS=="10029438" | BE-THESAURUS=="10043673" | BE-THESAURUS=="30000588" | BE-THESAURUS=="10039693" | BE-THESAURUS=="10043640" | BE-THESAURUS=="10043641" | BE-THESAURUS=="10113513" | BE-THESAURUS=="10119107" | BE-THESAURUS=="30000586" | BE-THESAURUS=="10024744" | BE-THESAURUS=="10043656" | BE-THESAURUS=="10116950" | BE-THESAURUS=="10118335" | BE-THESAURUS=="10119091" | BE-THESAURUS=="10118313" | BE-THESAURUS=="10119105" | BE-THESAURUS=="10122976" | BE-THESAURUS=="15002717" | BE-THESAURUS=="30000570" | BE-THESAURUS=="30000583" | BE-THESAURUS=="30000584" | BE-THESAURUS=="30000585" | BE-THESAURUS=="10043610" | BE-THESAURUS=="10118291" | BE-THESAURUS=="10118299" | BE-THESAURUS=="10118316" | BE-THESAURUS=="10118317" | BE-THESAURUS=="10118319" | BE-THESAURUS=="10118323" | BE-THESAURUS=="30000587" | BE-THESAURUS=="10024244" | BE-THESAURUS=="10046901" | BE-THESAURUS=="10122977" | BE-THESAURUS=="10032035" | BE-THESAURUS=="10118297" | BE-THESAURUS=="10118322" | BE-THESAURUS=="10118324" | BE-THESAURUS=="10118326" | BE-THESAURUS=="10024231" | BE-THESAURUS=="10032036" | BE-THESAURUS=="10115770" | BE-THESAURUS=="10118312" | BE-THESAURUS=="10118325" | BE-THESAURUS=="15002733" | BE-THESAURUS=="10024233" | BE-THESAURUS=="10118293" | BE-THESAURUS=="10116951" | BE-THESAURUS=="10119109" | BE-THESAURUS=="10122952" | BE-THESAURUS=="10115628") & (:status == active-relevant | :status == active-irrelevant))))) - ((ICPC=="K86" & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk)) | ((BE-THESAURUS=="10043606" | BE-THESAURUS=="10013853" | BE-THESAURUS=="10039772" | BE-THESAURUS=="10043652" | BE-THESAURUS=="10111305" | BE-THESAURUS=="20000236" | BE-THESAURUS=="10029438" | BE-THESAURUS=="10043673" | BE-THESAURUS=="30000588" | BE-THESAURUS=="10039693" | BE-THESAURUS=="10043640" | BE-THESAURUS=="10043641" | BE-THESAURUS=="10113513" | BE-THESAURUS=="10119107" | BE-THESAURUS=="30000586" | BE-THESAURUS=="10024744" | BE-THESAURUS=="10043656" | BE-THESAURUS=="10116950" | BE-THESAURUS=="10118335" | BE-THESAURUS=="10119091" | BE-THESAURUS=="10118313" | BE-THESAURUS=="10119105" | BE-THESAURUS=="10122976" | BE-THESAURUS=="15002717" | BE-THESAURUS=="30000570" | BE-THESAURUS=="30000583" | BE-THESAURUS=="30000584" | BE-THESAURUS=="30000585" | BE-THESAURUS=="10043610" | BE-THESAURUS=="10118291" | BE-THESAURUS=="10118299" | BE-THESAURUS=="10118316" | BE-THESAURUS=="10118317" | BE-THESAURUS=="10118319" | BE-THESAURUS=="10118323" | BE-THESAURUS=="30000587" | BE-THESAURUS=="10024244" | BE-THESAURUS=="10046901" | BE-THESAURUS=="10122977" | BE-THESAURUS=="10032035" | BE-THESAURUS=="10118297" | BE-THESAURUS=="10118322" | BE-THESAURUS=="10118324" | BE-THESAURUS=="10118326" | BE-THESAURUS=="10024231" | BE-THESAURUS=="10032036" | BE-THESAURUS=="10115770" | BE-THESAURUS=="10118312" | BE-THESAURUS=="10118325" | BE-THESAURUS=="15002733" | BE-THESAURUS=="10024233" | BE-THESAURUS=="10118293" | BE-THESAURUS=="10116951" | BE-THESAURUS=="10119109" | BE-THESAURUS=="10122952" | BE-THESAURUS=="10115628" | BE-THESAURUS=="10043668" | BE-THESAURUS=="10086344") & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute cancers HE (D75/X75/X76 minus familyrisk)', async () => {
		const result = await executeQuery(
			'HE[((PAT[active=="true"] & (ICPC=="D75" | ICPC=="X75" | ICPC=="X76")) - (((ICPC=="D75" | ICPC=="X75" | ICPC=="X76") & (:CD-ITEM == familyrisk | :CD-ITEM-EXT-HE-TYPE == familyrisk))))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	// --- Clinical queries — CTC contacts with date ranges ---

	it('should execute 2025 consultations by specific HCPs', async () => {
		const result = await executeQuery(
			'CTC[((((:CD-TRANSACTION=="consult"{20250101->20251231} | :CD-TRANSACTION=="homevisit"{20250101->20251231} | :CD-TRANSACTION=="hospitalvisit"{20250101->20251231} | :CD-TRANSACTION=="resthomevisit"{20250101->20251231}) | (:CD-ENCOUNTER=="consult"{20250101->20251231} | :CD-ENCOUNTER=="homevisit"{20250101->20251231} | :CD-ENCOUNTER=="hospitalvisit"{20250101->20251231} | :CD-ENCOUNTER=="resthomevisit"{20250101->20251231}) | (:CD-ITEM-EXT=="consult"{20250101->20251231} | :CD-ITEM-EXT=="homevisit"{20250101->20251231} | :CD-ITEM-EXT=="hospitalvisit"{20250101->20251231} | :CD-ITEM-EXT=="resthomevisit"{20250101->20251231}))) & (hcp=="e5cc8099-eb9b-4ac7-8c80-99eb9b0ac7be" | hcp=="b0d9398e-f7ee-4501-9939-8ef7ee95016b" | hcp=="4e98c074-8b4b-426d-a8ac-25d610f9c6f6"))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	// --- Clinical queries — vaccination ---

	it('should execute flu vaccination tracking (seasonal influenza + refused lifecycle)', async () => {
		const result = await executeQuery(
			'SVC[((CD-VACCINEINDICATION=="seasonalinfluenza"{20250701->20260131} | CD-VACCINEINDICATION==SEASONALINFLUENZA{20250701->20260131} | BE-THESAURUS-PROCEDURES=="R44.003"{20250701->20260131} | (BE-THESAURUS-PROCEDURES=="R44.003" & (:CD-LIFECYCLE == refused | :CD-LIFECYCLE-EXT == refused))) & (PAT[active=="true"] & PAT[age>64y]))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute simple flu vaccination tracking (without PAT filters)', async () => {
		const result = await executeQuery(
			'SVC[CD-VACCINEINDICATION=="seasonalinfluenza"{20250701->20260131} | CD-VACCINEINDICATION==SEASONALINFLUENZA{20250701->20260131} | BE-THESAURUS-PROCEDURES=="R44.003"{20250701->20260131} | (BE-THESAURUS-PROCEDURES=="R44.003" & (:CD-LIFECYCLE == refused | :CD-LIFECYCLE-EXT == refused))]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	// --- Clinical queries — medication (SVC) ---

	it('should execute GLP-1 analogues with active PAT filter', async () => {
		const result = await executeQuery(
			'SVC[(CD-DRUG-CNK=="3831153" | CD-DRUG-CNK=="4239737" | CD-DRUG-CNK=="4200572" | CD-DRUG-CNK=="3831138" | CD-DRUG-CNK=="3831146" | CD-DRUG-CNK=="4271649" | CD-DRUG-CNK=="4213724" | CD-DRUG-CNK=="4271771" | CD-DRUG-CNK=="4216321" | CD-DRUG-CNK=="4271789" | CD-DRUG-CNK=="4216347" | CD-DRUG-CNK=="4235453" | CD-DRUG-CNK=="3275989" | CD-DRUG-CNK=="4201984" | CD-DRUG-CNK=="3275971" | CD-DRUG-CNK=="2652121" | CD-DRUG-CNK=="3340478") & PAT[active=="true"]]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute simple GLP-1 analogues (without PAT filter)', async () => {
		const result = await executeQuery(
			'SVC[(CD-DRUG-CNK=="3831153" | CD-DRUG-CNK=="4239737" | CD-DRUG-CNK=="4200572" | CD-DRUG-CNK=="3831138" | CD-DRUG-CNK=="3831146" | CD-DRUG-CNK=="4271649" | CD-DRUG-CNK=="4213724" | CD-DRUG-CNK=="4271771" | CD-DRUG-CNK=="4216321" | CD-DRUG-CNK=="4271789" | CD-DRUG-CNK=="4216347" | CD-DRUG-CNK=="4235453" | CD-DRUG-CNK=="3275989" | CD-DRUG-CNK=="4201984" | CD-DRUG-CNK=="3275971" | CD-DRUG-CNK=="2652121" | CD-DRUG-CNK=="3340478")]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute antidepressants with active PAT and date ranges', async () => {
		const result = await executeQuery(
			'SVC[(CD-ATC=="N06A"{20180101->20260331} | CD-ATC=="N06AA01"{20180101->20260331} | CD-ATC=="N06AA02"{20180101->20260331} | CD-ATC=="N06AA04"{20180101->20260331} | CD-ATC=="N06AA05"{20180101->20260331} | CD-ATC=="N06AA06"{20180101->20260331} | CD-ATC=="N06AA07"{20180101->20260331} | CD-ATC=="N06AA08"{20180101->20260331} | CD-ATC=="N06AA09"{20180101->20260331} | CD-ATC=="N06AA10"{20180101->20260331} | CD-ATC=="N06AA11"{20180101->20260331} | CD-ATC=="N06AA12"{20180101->20260331} | CD-ATC=="N06AA13"{20180101->20260331} | CD-ATC=="N06AA14"{20180101->20260331} | CD-ATC=="N06AA15"{20180101->20260331} | CD-ATC=="N06AA16"{20180101->20260331} | CD-ATC=="N06AA17"{20180101->20260331} | CD-ATC=="N06AA18"{20180101->20260331} | CD-ATC=="N06AA19"{20180101->20260331} | CD-ATC=="N06AA21"{20180101->20260331} | CD-ATC=="N06AA23"{20180101->20260331} | CD-ATC=="N06AB02"{20180101->20260331} | CD-ATC=="N06AB03"{20180101->20260331} | CD-ATC=="N06AB04"{20180101->20260331} | CD-ATC=="N06AB05"{20180101->20260331} | CD-ATC=="N06AB06"{20180101->20260331} | CD-ATC=="N06AB07"{20180101->20260331} | CD-ATC=="N06AB08"{20180101->20260331} | CD-ATC=="N06AB09"{20180101->20260331} | CD-ATC=="N06AB10"{20180101->20260331} | CD-ATC=="N06AF01"{20180101->20260331} | CD-ATC=="N06AF02"{20180101->20260331} | CD-ATC=="N06AF03"{20180101->20260331} | CD-ATC=="N06AF04"{20180101->20260331} | CD-ATC=="N06AF05"{20180101->20260331} | CD-ATC=="N06AF06"{20180101->20260331} | CD-ATC=="N06AG02"{20180101->20260331} | CD-ATC=="N06AG03"{20180101->20260331} | CD-ATC=="N06AX01"{20180101->20260331} | CD-ATC=="N06AX02"{20180101->20260331} | CD-ATC=="N06AX03"{20180101->20260331} | CD-ATC=="N06AX04"{20180101->20260331} | CD-ATC=="N06AX06"{20180101->20260331} | CD-ATC=="N06AX07"{20180101->20260331} | CD-ATC=="N06AX08"{20180101->20260331} | CD-ATC=="N06AX09"{20180101->20260331} | CD-ATC=="N06AX10"{20180101->20260331} | CD-ATC=="N06AX11"{20180101->20260331} | CD-ATC=="N06AX12"{20180101->20260331} | CD-ATC=="N06AX13"{20180101->20260331} | CD-ATC=="N06AX14"{20180101->20260331} | CD-ATC=="N06AX15"{20180101->20260331} | CD-ATC=="N06AX16"{20180101->20260331} | CD-ATC=="N06AX17"{20180101->20260331} | CD-ATC=="N06AX18"{20180101->20260331} | CD-ATC=="N06AX19"{20180101->20260331} | CD-ATC=="N06AX21"{20180101->20260331} | CD-ATC=="N06AX22"{20180101->20260331} | CD-ATC=="N06AX23"{20180101->20260331} | CD-ATC=="N06AX24"{20180101->20260331} | CD-ATC=="N06AX26"{20180101->20260331} | CD-ATC=="N06AX27"{20180101->20260331} | CD-ATC=="N06AX28"{20180101->20260331} | CD-ATC=="N06AX29"{20180101->20260331} | CD-ATC=="N06AX31"{20180101->20260331} | CD-ATC=="N06AA03"{20180101->20260331} | CD-ATC=="N06AX"{20180101->20260331} | CD-ATC=="N06AX25"{20180101->20260331} | CD-ATC=="N06AX62"{20180101->20260331} | CD-ATC=="N06AA"{20180101->20260331} | CD-ATC=="N06AB"{20180101->20260331} | CD-ATC=="N06AF"{20180101->20260331} | CD-ATC=="N06AG"{20180101->20260331}) & PAT[active=="true"]]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute simple antidepressants (without PAT filter)', async () => {
		const result = await executeQuery(
			'SVC[(CD-ATC=="N06A"{20180101->20260331} | CD-ATC=="N06AA01"{20180101->20260331} | CD-ATC=="N06AA02"{20180101->20260331} | CD-ATC=="N06AA04"{20180101->20260331} | CD-ATC=="N06AA05"{20180101->20260331} | CD-ATC=="N06AA06"{20180101->20260331} | CD-ATC=="N06AA07"{20180101->20260331} | CD-ATC=="N06AA08"{20180101->20260331} | CD-ATC=="N06AA09"{20180101->20260331} | CD-ATC=="N06AA10"{20180101->20260331} | CD-ATC=="N06AA11"{20180101->20260331} | CD-ATC=="N06AA12"{20180101->20260331} | CD-ATC=="N06AA13"{20180101->20260331} | CD-ATC=="N06AA14"{20180101->20260331} | CD-ATC=="N06AA15"{20180101->20260331} | CD-ATC=="N06AA16"{20180101->20260331} | CD-ATC=="N06AA17"{20180101->20260331} | CD-ATC=="N06AA18"{20180101->20260331} | CD-ATC=="N06AA19"{20180101->20260331} | CD-ATC=="N06AA21"{20180101->20260331} | CD-ATC=="N06AA23"{20180101->20260331} | CD-ATC=="N06AB02"{20180101->20260331} | CD-ATC=="N06AB03"{20180101->20260331} | CD-ATC=="N06AB04"{20180101->20260331} | CD-ATC=="N06AB05"{20180101->20260331} | CD-ATC=="N06AB06"{20180101->20260331} | CD-ATC=="N06AB07"{20180101->20260331} | CD-ATC=="N06AB08"{20180101->20260331} | CD-ATC=="N06AB09"{20180101->20260331} | CD-ATC=="N06AB10"{20180101->20260331} | CD-ATC=="N06AF01"{20180101->20260331} | CD-ATC=="N06AF02"{20180101->20260331} | CD-ATC=="N06AF03"{20180101->20260331} | CD-ATC=="N06AF04"{20180101->20260331} | CD-ATC=="N06AF05"{20180101->20260331} | CD-ATC=="N06AF06"{20180101->20260331} | CD-ATC=="N06AG02"{20180101->20260331} | CD-ATC=="N06AG03"{20180101->20260331} | CD-ATC=="N06AX01"{20180101->20260331} | CD-ATC=="N06AX02"{20180101->20260331} | CD-ATC=="N06AX03"{20180101->20260331} | CD-ATC=="N06AX04"{20180101->20260331} | CD-ATC=="N06AX06"{20180101->20260331} | CD-ATC=="N06AX07"{20180101->20260331} | CD-ATC=="N06AX08"{20180101->20260331} | CD-ATC=="N06AX09"{20180101->20260331} | CD-ATC=="N06AX10"{20180101->20260331} | CD-ATC=="N06AX11"{20180101->20260331} | CD-ATC=="N06AX12"{20180101->20260331} | CD-ATC=="N06AX13"{20180101->20260331} | CD-ATC=="N06AX14"{20180101->20260331} | CD-ATC=="N06AX15"{20180101->20260331} | CD-ATC=="N06AX16"{20180101->20260331} | CD-ATC=="N06AX17"{20180101->20260331} | CD-ATC=="N06AX18"{20180101->20260331} | CD-ATC=="N06AX19"{20180101->20260331} | CD-ATC=="N06AX21"{20180101->20260331} | CD-ATC=="N06AX22"{20180101->20260331} | CD-ATC=="N06AX23"{20180101->20260331} | CD-ATC=="N06AX24"{20180101->20260331} | CD-ATC=="N06AX26"{20180101->20260331} | CD-ATC=="N06AX27"{20180101->20260331} | CD-ATC=="N06AX28"{20180101->20260331} | CD-ATC=="N06AX29"{20180101->20260331} | CD-ATC=="N06AX31"{20180101->20260331} | CD-ATC=="N06AA03"{20180101->20260331} | CD-ATC=="N06AX"{20180101->20260331} | CD-ATC=="N06AX25"{20180101->20260331} | CD-ATC=="N06AX62"{20180101->20260331} | CD-ATC=="N06AA"{20180101->20260331} | CD-ATC=="N06AB"{20180101->20260331} | CD-ATC=="N06AF"{20180101->20260331} | CD-ATC=="N06AG"{20180101->20260331})]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	// --- Clinical queries — simple screening variants ---

	it('should execute simple colon cancer screening (SVC without PAT filter)', async () => {
		const result = await executeQuery(
			'SVC[BE-THESAURUS-PROCEDURES=="D36.002"{<2y} | BE-THESAURUS-PROCEDURES=="D40.001"{<5y}]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute simple breast cancer screening (SVC without PAT filter)', async () => {
		const result = await executeQuery(
			'SVC[(BE-THESAURUS-PROCEDURES=="X41.002"{<2y} | BE-THESAURUS-PROCEDURES=="X41.005"{<2y} | BE-THESAURUS-PROCEDURES=="X41.007"{<2y} | BE-THESAURUS-PROCEDURES=="X41.006"{<2y} | BE-THESAURUS-PROCEDURES=="X41.008"{<2y} | BE-THESAURUS-PROCEDURES=="X41.004"{<2y})]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)

	it('should execute simple cervical cancer screening (SVC without PAT filter)', async () => {
		const result = await executeQuery(
			'SVC[(BE-THESAURUS-PROCEDURES=="X37.002"{<5y} | BE-THESAURUS-PROCEDURES=="X37.003"{<5y}) | (BE-THESAURUS-PROCEDURES=="MSP008065"{<5y} | BE-THESAURUS-PROCEDURES=="MSP008181"{<5y})]',
		)
		expect(result).toBeDefined()
		expect(Array.isArray(result)).toBe(true)
	}, 120_000)
})
