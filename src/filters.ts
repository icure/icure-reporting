/** Deep property access by dot-separated path (replaces lodash `get`). */
function getPath(obj: unknown, path: string): unknown {
	return path.split('.').reduce((acc, key) => (acc != null ? (acc as any)[key] : undefined), obj)
}

/** Pick specified keys from an object (replaces lodash `pick`). */
function pick<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
	const result = {} as Partial<T>
	for (const key of keys) {
		if (key in obj) result[key] = obj[key]
	}
	return result
}

/** Deduplicate by a key function (replaces lodash `uniqBy`). */
function uniqBy<T>(array: T[], fn: (item: T) => unknown): T[] {
	const seen = new Set()
	return array.filter((item) => {
		const key = fn(item)
		if (seen.has(key)) return false
		seen.add(key)
		return true
	})
}
import { format, fromUnixTime, getUnixTime, parse } from 'date-fns'

import type { Apis } from '@icure/api'
import {
	Contact,
	Patient,
	HealthElement,
	Invoice,
	Service,
	FilterChainService,
	FilterChainHealthElement,
	FilterChainInvoice,
	FilterChainPatient,
} from '@icure/api'

import type {
	FilterNode,
	RequestNode,
	PlaceholderFilter,
	IcureEntity,
	EntityKey,
	PostFilter,
	DeferralPolicy,
	RewriteResult,
	ReducerName,
	ReducerFactory,
	DatabaseStats,
	ResolutionStrategy,
	IntersectionFilter,
	UnionFilter,
	ComplementFilter,
	ServiceByHcPartyTagCodeDateFilter,
	ServiceBySecretForeignKeys,
} from './types.js'

export type { PostFilter, DeferralPolicy }

// --- Filter description helpers ---

/** Generate a kebab-case description for a filter node. */
function describeFilter(node: FilterNode): string {
	switch (node.$type) {
		case 'PLACEHOLDER':
			return 'placeholder-filter'
		case 'PatientByHcPartyFilter':
			return 'all-patients-for-hcp'
		case 'PatientByIdsFilter':
			return 'patients-by-ids'
		case 'PatientByHcPartyAndActiveFilter':
			return `patients-active-${(node as { active?: unknown }).active}`
		case 'PatientByHcPartyGenderEducationProfession':
			return `patients-gender-${(node as { gender?: string }).gender}`
		case 'PatientByHcPartyDateOfBirthBetweenFilter':
			return 'patients-by-date-of-birth-range'
		case 'IntersectionFilter':
			return 'intersection'
		case 'UnionFilter':
			return 'union'
		case 'ComplementFilter':
			return 'complement'
		case 'ServiceByHcPartyTagCodeDateFilter':
			return 'services-by-tag-code-date'
		case 'ServiceByHcPartyCodesFilter':
			return 'services-by-codes'
		case 'ServiceByHcPartyTagCodesFilter':
			return 'services-by-tag-codes'
		case 'ServiceByHcPartyPatientCodesFilter':
			return 'services-by-patient-codes'
		case 'ServiceByHcPartyPatientTagCodesFilter':
			return 'services-by-patient-tag-codes'
		case 'ServiceBySecretForeignKeys':
			return 'services-by-patient-secret-keys'
		case 'ServiceByIdsFilter':
			return 'services-by-ids'
		case 'ServiceByContactsAndSubcontactsFilter':
			return 'services-by-contacts-and-subcontacts'
		case 'HealthElementByHcPartyTagCodeFilter':
			return 'health-elements-by-tag-code'
		case 'HealthElementByHcPartySecretForeignKeysFilter':
			return 'health-elements-by-patient-secret-keys'
		case 'InvoiceByHcPartyCodeDateFilter':
			return 'invoices-by-code-date'
		case 'ContactByHcPartyTagCodeDateFilter':
			return 'contacts-by-tag-code-date'
		case 'ContactByHcPartyPatientTagCodeDateFilter':
			return 'contacts-by-patient-tag-code-date'
		default:
			return (node as { $type: string }).$type
	}
}

/**
 * Recursively walk a filter tree and ensure every FilterNode has a `desc`
 * property. Mutates nodes in place. Call this before sending filters to the API.
 */
export function ensureDesc(node: FilterNode | RequestNode): void {
	if (node.$type === 'request') {
		const req = node as RequestNode
		if (req.filter) ensureDesc(req.filter)
		if (req.left) ensureDesc(req.left)
		if (req.right) req.right.forEach(ensureDesc)
		return
	}
	const f = node as FilterNode
	if (!f.desc) {
		f.desc = describeFilter(f)
	}
	const asAny = f as FilterNode & {
		filters?: FilterNode[]
		superSet?: FilterNode
		subSet?: FilterNode | RequestNode
	}
	if (asAny.filters) {
		asAny.filters.forEach(ensureDesc)
	}
	if (asAny.superSet) ensureDesc(asAny.superSet)
	if (asAny.subSet) ensureDesc(asAny.subSet)
}

// --- Deferral types and policies ---

/** Convert a deferred filter AST node to a client-side predicate. */
function filterNodeToPostFilter(node: FilterNode): PostFilter {
	switch (node.$type) {
		case 'PatientByHcPartyAndActiveFilter':
			return (p) => String((p as Patient).active) === String(node.active)
		case 'PatientByHcPartyFilter':
			return () => true
		case 'PatientByHcPartyGenderEducationProfession':
			return (p) => (p as Patient).gender === node.gender
		case 'PatientByHcPartyDateOfBirthBetweenFilter':
			return (p) => {
				const dob = (p as Patient).dateOfBirth
				if (dob == null) return false
				if (node.minDateOfBirth != null && dob < Number(node.minDateOfBirth)) return false
				if (node.maxDateOfBirth != null && dob > Number(node.maxDateOfBirth)) return false
				return true
			}
		default:
			throw new Error(
				`Cannot defer filter of type ${node.$type} — no post-filter implementation`,
			)
	}
}

/** Built-in deferral policies, keyed by CLI flag name. */
export const deferralPolicies: Record<string, DeferralPolicy> = {
	active: (node) => node.$type === 'PatientByHcPartyAndActiveFilter',
	gender: (node) => node.$type === 'PatientByHcPartyGenderEducationProfession',
	age: (node) => node.$type === 'PatientByHcPartyDateOfBirthBetweenFilter',
	'all-patients': (node) => node.$type === 'PatientByHcPartyFilter',
}

/** Compose multiple policies: defer if any policy matches. */
export function composePolicies(names: string[]): DeferralPolicy {
	const policies = names.map((name) => {
		const p = deferralPolicies[name]
		if (!p)
			throw new Error(
				`Unknown deferral policy: ${name}. Available: ${Object.keys(deferralPolicies).join(', ')}`,
			)
		return p
	})
	return (node) => policies.some((p) => p(node))
}

// --- Post-rewrite service-filter optimization ---

/**
 * Collapse a ServiceByHcPartyTagCodeDateFilter into one (or two) of the
 * targeted iCure v8 filter types. If `sfks` is defined, the filter is scoped
 * to those patient secret foreign keys (patient-aware variant); otherwise the
 * non-patient variant is emitted.
 *
 * When both a code and a tag are present:
 *   - default: return an intersection of the codes and tagCodes filters
 *   - deferServiceTag: return just the codes filter plus a post-filter that
 *     checks the tag client-side.
 */
function collapseTagCodeDate(
	tagCodeDate: ServiceByHcPartyTagCodeDateFilter,
	sfks: string[] | undefined,
	opts: { deferServiceTag: boolean; hcpartyId: string },
): { filter: FilterNode; postFilter?: PostFilter } {
	const hasCode = tagCodeDate.codeType != null && tagCodeDate.codeCode != null
	const hasTag = tagCodeDate.tagType != null && tagCodeDate.tagCode != null
	const startValueDate =
		tagCodeDate.startValueDate != null ? Number(tagCodeDate.startValueDate) : undefined
	const endValueDate =
		tagCodeDate.endValueDate != null ? Number(tagCodeDate.endValueDate) : undefined
	const hcpartyId = tagCodeDate.healthcarePartyId ?? opts.hcpartyId

	const codeCodes: Record<string, string[]> = hasCode
		? { [tagCodeDate.codeType!]: [tagCodeDate.codeCode!] }
		: {}
	const tagCodes: Record<string, string[]> = hasTag
		? { [tagCodeDate.tagType!]: [tagCodeDate.tagCode!] }
		: {}

	const makeCodesFilter = (): FilterNode =>
		sfks !== undefined
			? {
					$type: 'ServiceByHcPartyPatientCodesFilter',
					healthcarePartyId: hcpartyId,
					patientSecretForeignKeys: sfks,
					codeCodes,
					startValueDate,
					endValueDate,
				}
			: {
					$type: 'ServiceByHcPartyCodesFilter',
					healthcarePartyId: hcpartyId,
					codeCodes,
					startValueDate,
					endValueDate,
				}

	const makeTagCodesFilter = (): FilterNode =>
		sfks !== undefined
			? {
					$type: 'ServiceByHcPartyPatientTagCodesFilter',
					healthcarePartyId: hcpartyId,
					patientSecretForeignKeys: sfks,
					tagCodes,
					startValueDate,
					endValueDate,
				}
			: {
					$type: 'ServiceByHcPartyTagCodesFilter',
					healthcarePartyId: hcpartyId,
					tagCodes,
					startValueDate,
					endValueDate,
				}

	if (hasCode && !hasTag) return { filter: makeCodesFilter() }
	if (!hasCode && hasTag) return { filter: makeTagCodesFilter() }

	if (hasCode && hasTag) {
		if (opts.deferServiceTag) {
			const tagType = tagCodeDate.tagType!
			const tagCode = tagCodeDate.tagCode!
			const postFilter: PostFilter = (entity) => {
				const svc = entity as { tags?: Array<{ type?: string; code?: string }> }
				return (svc.tags ?? []).some((t) => t.type === tagType && t.code === tagCode)
			}
			return { filter: makeCodesFilter(), postFilter }
		}
		return {
			filter: {
				$type: 'IntersectionFilter',
				filters: [makeTagCodesFilter(), makeCodesFilter()],
			} as FilterNode,
		}
	}

	// No code and no tag — nothing to collapse.
	return { filter: tagCodeDate as FilterNode }
}

interface OptimizeResult {
	filter: FilterNode | RequestNode
	postFilters: PostFilter[]
}

/**
 * Walk a rewritten filter tree and rewrite service filters into the more
 * specific iCure v8 variants (ServiceByHcPartyCodesFilter,
 * ServiceByHcPartyTagCodesFilter, and the patient-aware counterparts). Inside
 * an IntersectionFilter, any ServiceByHcPartyTagCodeDateFilter is paired with
 * a ServiceBySecretForeignKeys sibling (if present) to produce a single
 * patient-aware filter instead of an intersection executed by the server.
 *
 * The pass is pure: it returns the rewritten tree plus any post-filters that
 * were introduced by `--defer svc-tag`. Returned post-filters must be applied
 * to the fetched entities before reducers run.
 */
export function optimizeServiceFilters(
	node: FilterNode | RequestNode,
	opts: { deferServiceTag: boolean; hcpartyId: string },
): OptimizeResult {
	// Standalone ServiceByHcPartyTagCodeDateFilter leaf — no SFKs in context.
	if (node.$type === 'ServiceByHcPartyTagCodeDateFilter') {
		const { filter, postFilter } = collapseTagCodeDate(
			node as ServiceByHcPartyTagCodeDateFilter,
			undefined,
			opts,
		)
		return { filter, postFilters: postFilter ? [postFilter] : [] }
	}

	if (node.$type === 'request') {
		const req = node as RequestNode
		if (!req.filter) return { filter: node, postFilters: [] }
		const inner = optimizeServiceFilters(req.filter, opts)
		return {
			filter: { ...req, filter: inner.filter } as RequestNode,
			postFilters: inner.postFilters,
		}
	}

	if (node.$type === 'ComplementFilter') {
		const comp = node as ComplementFilter
		const collected: PostFilter[] = []
		const copy: ComplementFilter = { ...comp }
		if (comp.superSet) {
			const r = optimizeServiceFilters(comp.superSet, opts)
			copy.superSet = r.filter as FilterNode
			collected.push(...r.postFilters)
		}
		if (comp.subSet) {
			const r = optimizeServiceFilters(comp.subSet, opts)
			copy.subSet = r.filter
			collected.push(...r.postFilters)
		}
		return { filter: copy, postFilters: collected }
	}

	if (node.$type === 'UnionFilter') {
		const u = node as UnionFilter
		const results = u.filters.map((c) => optimizeServiceFilters(c, opts))
		return {
			filter: { ...u, filters: results.map((r) => r.filter) as FilterNode[] },
			postFilters: results.flatMap((r) => r.postFilters),
		}
	}

	if (node.$type === 'IntersectionFilter') {
		const inter = node as IntersectionFilter
		const tagCodeDates: ServiceByHcPartyTagCodeDateFilter[] = []
		const sfks: ServiceBySecretForeignKeys[] = []
		const rest: FilterNode[] = []
		for (const child of inter.filters) {
			if (child.$type === 'ServiceByHcPartyTagCodeDateFilter') {
				tagCodeDates.push(child as ServiceByHcPartyTagCodeDateFilter)
			} else if (child.$type === 'ServiceBySecretForeignKeys') {
				sfks.push(child as ServiceBySecretForeignKeys)
			} else {
				rest.push(child)
			}
		}

		const collected: PostFilter[] = []
		const collapsed: FilterNode[] = []
		const leftoverSfks: ServiceBySecretForeignKeys[] = [...sfks]

		for (const tcd of tagCodeDates) {
			const pairedSfk = leftoverSfks.shift()
			const sfkValues = pairedSfk?.patientSecretForeignKeys
			const { filter, postFilter } = collapseTagCodeDate(tcd, sfkValues, opts)
			// Flatten nested intersections produced by the collapse (code+tag default case)
			if (filter.$type === 'IntersectionFilter') {
				collapsed.push(...(filter as IntersectionFilter).filters)
			} else {
				collapsed.push(filter)
			}
			if (postFilter) collected.push(postFilter)
		}

		const restResults = rest.map((c) => optimizeServiceFilters(c, opts))
		for (const r of restResults) collected.push(...r.postFilters)

		const allChildren: FilterNode[] = [
			...collapsed,
			...restResults.map((r) => r.filter as FilterNode),
			...leftoverSfks,
		]

		const resultFilter: FilterNode =
			allChildren.length === 1
				? allChildren[0]
				: ({ ...inter, filters: allChildren } as FilterNode)
		return { filter: resultFilter, postFilters: collected }
	}

	return { filter: node, postFilters: [] }
}

/** Default database stats stub — rough order-of-magnitude estimates. */
const defaultDbStats: DatabaseStats = {
	patientCount: 10000,
	serviceCount: 10000000,
	healthElementCount: 50000,
	contactCount: 200000,
	invoiceCount: 100000,
}

/** Pick the best strategy: override by description match, or lowest weight. */
function selectStrategy(
	strategies: ResolutionStrategy[],
	stats: DatabaseStats,
	override?: string,
): ResolutionStrategy {
	if (override) {
		const match = strategies.find((s) => s.description.toLowerCase() === override.toLowerCase())
		if (match) return match
		console.error(
			`Strategy override "${override}" not found, available: ${strategies.map((s) => s.description).join(', ')}`,
		)
	}
	return strategies.reduce((best, s) => (s.weight(stats) < best.weight(stats) ? s : best))
}

export async function filter(
	parsedInput: RequestNode | FilterNode,
	api: Apis,
	hcpartyId: string,
	debug: boolean,
	deferralPolicy?: DeferralPolicy,
	strategyOverride?: string,
	deferServiceTag: boolean = false,
): Promise<IcureEntity[] & { rows?: unknown[] }> {
	let hcpHierarchy = [hcpartyId]
	const currentUser = await api.userApi.getCurrentUser()

	let hcp
	while ((hcp = await api.healthcarePartyApi.getHealthcareParty(hcpHierarchy[0])).parentId) {
		hcpHierarchy.unshift(hcp.parentId)
	}

	hcpHierarchy = hcpHierarchy.filter((id) => id !== hcpartyId) // remove self from hierarchy for filtering purposes, but keep for API calls

	const requestToFilterTypeMap: Record<string, string> = {
		SVC: 'ServiceByHcPartyTagCodeDateFilter',
		HE: 'HealthElementByHcPartyTagCodeFilter',
		INV: 'InvoiceByHcPartyCodeDateFilter',
		CTC: 'ContactByHcPartyTagCodeDateFilter',
	}

	const reducers: Record<ReducerName, ReducerFactory> = {
		count: () => async (acc?: unknown[]) =>
			acc === undefined ? [0] : [((await acc) as number[])[0] + 1],
		sum: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? getPath(x, params[0]) : x
			return acc === undefined ? [0] : [((await acc) as number[])[0] + (val as number)]
		},
		mean: (params?: string[]) => async (acc?: unknown[], x?: unknown, idx?: number) => {
			const val = params && params[0] ? getPath(x, params[0]) : x
			return acc === undefined
				? [0]
				: [
						((await acc) as number[])[0] +
							((val as number) - ((await acc) as number[])[0]) / ((idx || 0) + 1),
					]
		},
		min: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? getPath(x, params[0]) : x
			return acc === undefined
				? [999999999999]
				: [
						(val as number) < ((await acc) as number[])[0]
							? val
							: ((await acc) as number[])[0],
					]
		},
		max: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? getPath(x, params[0]) : x
			return acc === undefined
				? [-999999999999]
				: [
						(val as number) > ((await acc) as number[])[0]
							? val
							: ((await acc) as number[])[0],
					]
		},
		s2d: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? getPath(x, params[0]) : x
			const d = val && Number(format(fromUnixTime(val as number), 'yyyyMMdd'))
			return acc === undefined ? [] : ((await acc) as unknown[]).concat([d])
		},
		d2s: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? getPath(x, params[0]) : x
			const d = Number(val ? getUnixTime(parse(String(val), 'yyyyMMdd', 0)) : 0) || 0
			return acc === undefined ? [] : ((await acc) as unknown[]).concat([d])
		},
		d2y: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? getPath(x, params[0]) : x
			const d = Number(val ? getUnixTime(parse(String(val), 'yyyyMMdd', 0)) : 0) || 0
			return acc === undefined
				? []
				: ((await acc) as unknown[]).concat([
						(+new Date() / 1000 - d) / (365.25 * 24 * 3600),
					])
		},
		select: (params?: string[]) => async (acc?: unknown[], x?: unknown) =>
			acc === undefined
				? []
				: ((await acc) as unknown[]).concat([
						params ? pick(x as Record<string, unknown>, params) : x,
					]),
		share: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const hcpId = currentUser.healthcarePartyId
			return acc === undefined || !currentUser || !hcpId
				? []
				: ((await acc) as unknown[]).concat([
						await api.patientApi.share(
							currentUser,
							(x as IcureEntity).id!,
							hcpId,
							params || [],
							(params || []).reduce(
								(tags, k) => {
									tags[k] = ['all']
									return tags
								},
								{} as { [key: string]: Array<string> },
							),
						),
					])
		},
	}

	const converters: Record<EntityKey, (filter: PlaceholderFilter) => FilterNode> = {
		PAT: (filter) => filter, // PAT placeholders are handled elsewhere
		SVC: (filter) =>
			Object.assign(
				{},
				pick(filter, ['healthcarePartyId']),
				{ $type: requestToFilterTypeMap['SVC'] },
				{
					codeType: filter.key,
					codeCode: filter.value,
					tagType: filter.colonKey,
					tagCode: filter.colonValue,
					startValueDate:
						filter.startDate && filter.startDate.length <= 8
							? filter.startDate + '000000'
							: filter.startDate,
					endValueDate:
						filter.endDate && filter.endDate.length <= 8
							? filter.endDate + '000000'
							: filter.startDate,
				},
			) as FilterNode,
		HE: (filter) =>
			Object.assign(
				{},
				pick(filter, ['healthcarePartyId']),
				{ $type: requestToFilterTypeMap['HE'] },
				{
					codeType: filter.key,
					codeNumber: filter.value,
					tagType: filter.colonKey,
					tagCode: filter.colonValue,
				},
			) as FilterNode,
		INV: (filter) =>
			Object.assign(
				{},
				pick(filter, ['healthcarePartyId']),
				{ $type: requestToFilterTypeMap['INV'] },
				{
					code: filter.value,
					startInvoiceDate: filter.startDate,
					endInvoiceDate: filter.endDate,
				},
			) as FilterNode, // TODO add zeroes?
		CTC: (filter) =>
			Object.assign(
				{},
				pick(filter, ['healthcarePartyId']),
				{ $type: requestToFilterTypeMap['CTC'] },
				{
					// TODO patientSecretForeignKey(s)
					codeType: filter.key,
					codeCode: filter.value,
					tagType: filter.colonKey,
					tagCode: filter.colonValue,
					startServiceValueDate:
						filter.startDate && filter.startDate.length <= 8
							? filter.startDate + '000000'
							: filter.startDate,
					endServiceValueDate:
						filter.endDate && filter.endDate.length <= 8
							? filter.endDate + '000000'
							: filter.startDate,
				},
			) as FilterNode,
	}

	function wrap(filter: FilterNode | RequestNode, postFilters: PostFilter[] = []): RewriteResult {
		return { filter, postFilters }
	}

	function mergePostFilters(...results: RewriteResult[]): PostFilter[] {
		return results.flatMap((r) => r.postFilters)
	}

	/**
	 * Execute PAT subqueries: combine inner filters into a single PAT request,
	 * apply deferral for filters that don't work well as API filters (active, etc.),
	 * and return the matching patients.
	 */
	async function resolvePatients(patChildren: RequestNode[]): Promise<Patient[]> {
		// Collect inner filters from each PAT request (independent, so parallel)
		const innerFilters: FilterNode[] = (
			await Promise.all(
				patChildren.map((patReq) => rewriteFilter(patReq.filter, false, 'PAT', 'PAT')),
			)
		).map((r) => r.filter as FilterNode)

		// Combine into a single filter (or intersection if multiple)
		const combined: FilterNode =
			innerFilters.length === 1
				? innerFilters[0]
				: ({ $type: 'IntersectionFilter', filters: innerFilters } as FilterNode)

		// Separate API-friendly filters from those needing client-side evaluation
		const apiFilters: FilterNode[] = []
		const clientFilters: PostFilter[] = []
		const leaves =
			'filters' in combined && (combined as { filters?: FilterNode[] }).filters
				? (combined as { filters: FilterNode[] }).filters
				: [combined]

		for (const f of leaves) {
			try {
				// Try to convert to a post-filter — if it works, defer it
				const pf = filterNodeToPostFilter(f)
				clientFilters.push(pf)
			} catch {
				// Not deferrable — send to the API
				apiFilters.push(f)
			}
		}

		// Ensure at least one filter goes to the API
		if (apiFilters.length === 0) {
			apiFilters.push({
				$type: 'PatientByHcPartyFilter',
				healthcarePartyId: hcpartyId,
			})
		}

		const apiFilter: FilterNode =
			apiFilters.length === 1
				? apiFilters[0]
				: ({ $type: 'IntersectionFilter', filters: apiFilters } as FilterNode)

		let patients = await matchAndFetchPatients(apiFilter)

		// Apply client-side filters
		if (clientFilters.length > 0) {
			patients = patients.filter((p: Patient) => clientFilters.every((pf) => pf(p)))
		}

		return patients
	}

	/** Convert patients to secret foreign keys for entity-level filtering. */
	async function patientsToSecretForeignKeys(patients: Patient[]): Promise<string[]> {
		return (
			await Promise.all(
				patients.map((p: Patient) =>
					api.patientApi.decryptSecretIdsOf(p).catch(() => [] as string[]),
				),
			)
		).flat()
	}

	/** Build a BySecretForeignKeys filter node for the given entity type. */
	function buildSecretForeignKeysFilter(
		entityType: string,
		sfks: string[],
	): FilterNode | undefined {
		if (entityType === 'SVC') {
			return {
				$type: 'ServiceBySecretForeignKeys',
				healthcarePartyId: hcpartyId,
				patientSecretForeignKeys: sfks,
			}
		} else if (entityType === 'HE') {
			return {
				$type: 'HealthElementByHcPartySecretForeignKeysFilter',
				healthcarePartyId: hcpartyId,
				patientSecretForeignKeys: sfks,
			}
		} else if (entityType === 'CTC') {
			return {
				$type: 'ContactByHcPartyPatientTagCodeDateFilter',
				healthcarePartyId: hcpartyId,
				patientSecretForeignKeys: sfks,
			}
		}
		return undefined
	}

	async function rewriteFilter(
		filter: FilterNode | RequestNode | undefined,
		first: boolean,
		mainEntity: string,
		subEntity: string,
	): Promise<RewriteResult> {
		try {
			if (debug) console.error('Rewriting ' + JSON.stringify(filter))
			if (!filter) {
				if (subEntity === 'PAT') {
					return wrap({
						$type: 'PatientByHcPartyFilter',
						healthcarePartyId: hcpartyId,
					})
				} else if (subEntity === 'CTC') {
					return wrap({
						$type: 'ContactByHcPartyTagCodeDateFilter',
						healthcarePartyId: hcpartyId,
					})
				}
			}
			if (filter!.$type === 'request' && first && (filter as RequestNode).entity) {
				const req = filter as RequestNode
				const inner = await rewriteFilter(req.filter, false, req.entity!, subEntity)
				return wrap(
					{
						$type: 'request',
						entity: req.entity,
						filter: inner.filter,
						reducers: req.reducers,
					} as RequestNode,
					inner.postFilters,
				)
			} else if (filter!.$type === 'request') {
				const req = filter as RequestNode
				if (req.entity === 'SUBTRACT') {
					if (debug) console.log('Subtract')
					const leftResult = await rewriteFilter(req.left, first, mainEntity, subEntity)
					let rightResult: RewriteResult
					if (req.right!.length > 1) {
						const rightResults = await Promise.all(
							req.right!.map((f) => rewriteFilter(f, first, mainEntity, subEntity)),
						)
						rightResult = wrap(
							{
								$type: 'UnionFilter',
								filters: rightResults.map((r) => r.filter) as FilterNode[],
							},
							mergePostFilters(...rightResults),
						)
					} else {
						rightResult = await rewriteFilter(
							req.right![0],
							first,
							mainEntity,
							subEntity,
						)
					}
					return wrap(
						{
							$type: 'ComplementFilter',
							superSet: leftResult.filter as FilterNode,
							subSet: rightResult.filter,
						},
						mergePostFilters(leftResult, rightResult),
					)
				}
				const rewritten = await rewriteFilter(req.filter, first, mainEntity, req.entity!)
				const body = { filter: rewritten.filter as FilterNode }

				const key = `${req.entity}→${mainEntity}`
				const strategies = strategyRegistry.get(key)
				if (!strategies?.length) {
					console.error(`No resolution strategy for ${key}`)
					return Promise.reject(new Error(`No resolution strategy for ${key}`))
				}
				const strategy = selectStrategy(strategies, defaultDbStats, strategyOverride)
				if (debug) console.log(`Using strategy "${strategy.description}" for ${key}`)
				try {
					return await strategy.resolve(body, rewritten)
				} catch (error) {
					console.error(
						'Error occurred while handling entity ' +
							req.entity +
							' with body: ' +
							JSON.stringify(body),
					)
					console.error(error)
					return Promise.reject(error)
				}
			} else {
				const fNode = filter as FilterNode
				// --- IntersectionFilter / UnionFilter ---
				if ('filters' in fNode && fNode.filters) {
					// Case A: detect PAT children in an IntersectionFilter
					if (fNode.$type === 'IntersectionFilter' && mainEntity) {
						const patChildren: RequestNode[] = []
						const nonPatChildren: (FilterNode | RequestNode)[] = []
						for (const child of fNode.filters as (FilterNode | RequestNode)[]) {
							if (
								(child as RequestNode).$type === 'request' &&
								(child as RequestNode).entity === 'PAT'
							) {
								patChildren.push(child as RequestNode)
							} else {
								nonPatChildren.push(child)
							}
						}

						if (patChildren.length > 0 && mainEntity !== 'PAT') {
							// Resolve PAT children to a BySecretForeignKeys filter
							const patients = await resolvePatients(patChildren)
							const sfks = await patientsToSecretForeignKeys(patients)
							const sfkFilter = buildSecretForeignKeysFilter(mainEntity, sfks)

							if (sfkFilter) {
								if (nonPatChildren.length > 0) {
									// Case A: PAT mixed with non-PAT — add SFK filter to intersection
									const childResults = await Promise.all(
										nonPatChildren.map((f) =>
											rewriteFilter(
												f as FilterNode,
												first,
												mainEntity,
												subEntity,
											),
										),
									)
									const allFilters = [
										...childResults.map((r) => r.filter),
										sfkFilter,
									] as FilterNode[]

									return wrap(
										{
											$type: 'IntersectionFilter',
											filters: allFilters,
										} as FilterNode,
										mergePostFilters(...childResults),
									)
								} else {
									// All-PAT intersection — just return the SFK filter
									return wrap(sfkFilter)
								}
							}
						}
					}

					// Standard path: rewrite all children
					const childResults = await Promise.all(
						fNode.filters.map(async (f: FilterNode) =>
							rewriteFilter(f, first, mainEntity, subEntity),
						),
					)
					const allPostFilters = mergePostFilters(...childResults)

					if (
						deferralPolicy &&
						fNode.$type === 'IntersectionFilter' &&
						childResults.length > 1
					) {
						const kept: FilterNode[] = []
						const deferred: PostFilter[] = []

						for (const child of childResults) {
							if (
								deferralPolicy(child.filter as FilterNode) &&
								!(
									'filters' in child.filter &&
									(child.filter as FilterNode & { filters?: unknown }).filters
								)
							) {
								// Leaf node matched by policy — defer it
								if (debug)
									console.log('Deferring filter: ' + JSON.stringify(child.filter))
								deferred.push(filterNodeToPostFilter(child.filter as FilterNode))
							} else {
								kept.push(child.filter as FilterNode)
							}
						}

						// Never defer ALL children — keep at least one for the API
						if (kept.length === 0) {
							kept.push(childResults[0].filter as FilterNode)
							deferred.shift()
						}

						const apiFilter =
							kept.length === 1
								? kept[0]
								: ({ $type: fNode.$type, filters: kept } as FilterNode)

						return wrap(apiFilter, [...allPostFilters, ...deferred])
					}

					// No deferral — standard rewrite
					const target = JSON.parse(JSON.stringify(fNode)) as FilterNode & {
						filters: FilterNode[]
					}
					target.filters = childResults.map((r) => r.filter) as FilterNode[]
					return wrap(target, allPostFilters)
				} else if (
					('subSet' in fNode && fNode.subSet) ||
					('superSet' in fNode && fNode.superSet)
				) {
					const comp = fNode as typeof fNode & {
						subSet?: FilterNode | RequestNode
						superSet?: FilterNode
					}
					const target = JSON.parse(JSON.stringify(comp)) as typeof comp
					const collected: PostFilter[] = []
					if (comp.subSet) {
						const sub = await rewriteFilter(target.subSet, first, mainEntity, subEntity)
						target.subSet = sub.filter
						collected.push(...sub.postFilters)
					}
					if (comp.superSet) {
						const sup = await rewriteFilter(
							target.superSet,
							first,
							mainEntity,
							subEntity,
						)
						target.superSet = sup.filter as FilterNode
						collected.push(...sup.postFilters)
					}
					return wrap(target, collected)
				} else {
					// TODO maybe other conditions here
					if (fNode.$type === 'PLACEHOLDER') {
						const key = (subEntity || mainEntity) as EntityKey
						const newFilter = converters[key](fNode as PlaceholderFilter)
						if (debug) console.log('Leaf filter: ' + JSON.stringify(fNode))
						return wrap(newFilter)
					}
					if (debug) console.error('Leaf filter: ' + JSON.stringify(fNode))
					return wrap(fNode)
				}
			}
		} catch (error) {
			console.error('Error occurred while rewriting filter: ' + JSON.stringify(filter))
			console.error(error)
			return Promise.reject(error)
		}
	}

	async function handleFinalRequest(
		filter: RequestNode,
		postFilters: PostFilter[],
	): Promise<IcureEntity[] & { rows?: unknown[] }> {
		if (debug) console.log('Final request: ' + JSON.stringify(filter))
		if (filter.$type === 'request' && filter.entity && filter.filter) {
			let res: IcureEntity[]
			const filterNode = filter.filter as FilterNode
			if (filter.entity === 'PAT') {
				res = await matchAndFetchPatients(filterNode)
			} else if (filter.entity === 'HE') {
				res = await matchAndFetchHealthElements(filterNode)
			} else if (filter.entity === 'SVC') {
				res = await matchAndFetchServices(filterNode)
			} else if (filter.entity === 'INV') {
				ensureDesc(filterNode)
				res = await api.invoiceApi.filterInvoicesBy({
					filter: filterNode,
				} as unknown as FilterChainInvoice)
			} else if (filter.entity === 'CTC') {
				res = await matchAndFetchContacts(filterNode)
			} else {
				console.error('Entity not supported yet: ' + filter.entity)
				return Promise.reject()
			}

			// Apply deferred post-filters before reducers
			if (postFilters.length > 0 && Array.isArray(res)) {
				const before = res.length
				res = (res as IcureEntity[]).filter((entity) =>
					postFilters.every((pf) => pf(entity)),
				)
				if (debug)
					console.log(
						`Post-filter: ${before} → ${res.length} (removed ${before - res.length})`,
					)
			}

			if (res && filter.reducers) {
				for (const r of filter.reducers) {
					const reducer = reducers[r.reducer] && reducers[r.reducer](r.params)
					if (reducer) {
						let acc = await reducer()
						for (let i = 0; i < res.length; i++) {
							acc = await reducer(acc, res[i], i)
						}
						res = Object.assign(res, { rows: acc })
					}
				}
			}
			return res as IcureEntity[] & { rows?: unknown[] }
		} else {
			console.error('Filter not valid: ' + JSON.stringify(filter, null, ' '))
			return {} as IcureEntity[] & { rows?: unknown[] }
		}
	}

	// --- Batch helpers ---

	/** Split an array into chunks of the given size. */
	function chunk<T>(array: T[], size: number): T[][] {
		const chunks: T[][] = []
		for (let i = 0; i < array.length; i += size) {
			chunks.push(array.slice(i, i + size))
		}
		return chunks
	}

	/** Run async tasks in groups with limited parallelism. */
	async function runParallel<T>(tasks: (() => Promise<T>)[], concurrency: number): Promise<T[]> {
		const results: T[] = []
		for (let i = 0; i < tasks.length; i += concurrency) {
			const batch = tasks.slice(i, i + concurrency)
			results.push(...(await Promise.all(batch.map((t) => t()))))
		}
		return results
	}

	const BATCH_SIZE = 1000
	const PARALLELISM = 4

	/** Match patient IDs then fetch in batches. */
	async function matchAndFetchPatients(filterNode: FilterNode): Promise<Patient[]> {
		ensureDesc(filterNode)
		const ids = await api.patientApi.matchPatientsBy(filterNode as any)
		if (ids.length === 0) return []
		const batches = chunk(ids, BATCH_SIZE)
		const results = await runParallel(
			batches.map(
				(batchIds) => () =>
					api.patientApi
						.filterByWithUser(currentUser, {
							filter: {
								$type: 'PatientByIdsFilter',
								ids: batchIds,
								desc: 'patients-by-ids',
							},
						} as unknown as FilterChainPatient)
						.then((r) => (r?.rows || []) as Patient[]),
			),
			PARALLELISM,
		)
		return results.flat()
	}

	/** Match service IDs then fetch in batches. */
	async function matchAndFetchServices(filterNode: FilterNode): Promise<Service[]> {
		ensureDesc(filterNode)
		const ids = await api.contactApi.matchServicesBy(filterNode as any)
		if (ids.length === 0) return []
		const batches = chunk(ids, BATCH_SIZE)
		const results = await runParallel(
			batches.map(
				(batchIds) => () =>
					(
						api.contactApi.filterServicesByWithUser(
							currentUser,
							undefined,
							BATCH_SIZE,
							{
								filter: {
									$type: 'ServiceByIdsFilter',
									ids: batchIds,
									desc: 'services-by-ids',
								},
							} as unknown as FilterChainService,
						) as Promise<{ rows?: Service[] }>
					).then((r) => r?.rows || []),
			),
			PARALLELISM,
		)
		return results.flat()
	}

	/** Match health element IDs then fetch in batches. */
	async function matchAndFetchHealthElements(filterNode: FilterNode): Promise<HealthElement[]> {
		ensureDesc(filterNode)
		const ids = await api.healthcareElementApi.matchHealthElementsBy(filterNode as any)
		if (ids.length === 0) return []
		const batches = chunk(ids, BATCH_SIZE)
		const results = await runParallel(
			batches.map(
				(batchIds) => () =>
					api.healthcareElementApi
						.filterByWithUser(currentUser, undefined, BATCH_SIZE, {
							filter: {
								$type: 'HealthElementByIdsFilter',
								ids: batchIds,
								desc: 'health-elements-by-ids',
							},
						} as unknown as FilterChainHealthElement)
						.then((r) => (r?.rows || []) as HealthElement[]),
			),
			PARALLELISM,
		)
		return results.flat()
	}

	/** Match contact IDs then fetch in batches. */
	async function matchAndFetchContacts(filterNode: FilterNode): Promise<Contact[]> {
		ensureDesc(filterNode)
		const ids = await api.contactApi.matchContactsBy(filterNode as any)
		if (ids.length === 0) return []
		const batches = chunk(ids, BATCH_SIZE)
		const results = await runParallel(
			batches.map(
				(batchIds) => () =>
					api.contactApi
						.getContactsWithUser(currentUser, { ids: batchIds } as any)
						.then((r) => (r || []) as Contact[]),
			),
			PARALLELISM,
		)
		return results.flat()
	}

	// --- Fetch helpers ---

	function withHcpId(body: { filter: FilterNode }, hcpId: string) {
		return { filter: Object.assign({}, body.filter, { healthcarePartyId: hcpId }) }
	}

	async function fetchServices(body: { filter: FilterNode }): Promise<Service[]> {
		ensureDesc(body.filter)
		const allIds = (
			await Promise.all(
				hcpHierarchy.map((hcpId) => {
					const f = Object.assign({}, body.filter, { healthcarePartyId: hcpId })
					return api.contactApi.matchServicesBy(f as any)
				}),
			)
		).flat()
		const uniqueIds = [...new Set(allIds)]
		if (uniqueIds.length === 0) return []
		const batches = chunk(uniqueIds, BATCH_SIZE)
		const results = await runParallel(
			batches.map(
				(batchIds) => () =>
					(
						api.contactApi.filterServicesByWithUser(
							currentUser,
							undefined,
							BATCH_SIZE,
							{
								filter: {
									$type: 'ServiceByIdsFilter',
									ids: batchIds,
									desc: 'services-by-ids',
								},
							} as unknown as FilterChainService,
						) as Promise<{ rows?: Service[] }>
					).then((r) => r?.rows || []),
			),
			PARALLELISM,
		)
		return uniqBy(results.flat(), (x: Service) => x.id)
	}

	async function fetchHealthElements(body: { filter: FilterNode }): Promise<HealthElement[]> {
		ensureDesc(body.filter)
		const allIds = (
			await Promise.all(
				hcpHierarchy.map((hcpId) => {
					const f = Object.assign({}, body.filter, { healthcarePartyId: hcpId })
					return api.healthcareElementApi.matchHealthElementsBy(f as any)
				}),
			)
		).flat()
		const uniqueIds = [...new Set(allIds)]
		if (uniqueIds.length === 0) return []
		const batches = chunk(uniqueIds, BATCH_SIZE)
		const results = await runParallel(
			batches.map(
				(batchIds) => () =>
					api.healthcareElementApi
						.filterByWithUser(currentUser, undefined, BATCH_SIZE, {
							filter: {
								$type: 'HealthElementByIdsFilter',
								ids: batchIds,
								desc: 'health-elements-by-ids',
							},
						} as unknown as FilterChainHealthElement)
						.then((r) => (r?.rows || []) as HealthElement[]),
			),
			PARALLELISM,
		)
		return uniqBy(results.flat(), (x: HealthElement) => x.id)
	}

	async function fetchInvoices(body: { filter: FilterNode }): Promise<Invoice[]> {
		ensureDesc(body.filter)
		return uniqBy(
			(
				await Promise.all(
					hcpHierarchy.map((hcpId) =>
						api.invoiceApi.filterInvoicesBy(
							withHcpId(body, hcpId) as unknown as FilterChainInvoice,
						),
					),
				)
			).flat(),
			(x: Invoice) => x.id,
		)
	}

	async function fetchContacts(body: { filter: FilterNode }): Promise<Contact[]> {
		ensureDesc(body.filter)
		const allIds = (
			await Promise.all(
				hcpHierarchy.map((hcpId) => {
					const f = Object.assign({}, body.filter, { healthcarePartyId: hcpId })
					return api.contactApi.matchContactsBy(f as any)
				}),
			)
		).flat()
		const uniqueIds = [...new Set(allIds)]
		if (uniqueIds.length === 0) return []
		const batches = chunk(uniqueIds, BATCH_SIZE)
		const results = await runParallel(
			batches.map(
				(batchIds) => () =>
					api.contactApi
						.getContactsWithUser(currentUser, { ids: batchIds } as any)
						.then((r) => (r || []) as Contact[]),
			),
			PARALLELISM,
		)
		return uniqBy(results.flat(), (x: Contact) => x.id)
	}

	// --- Entity-to-patient-IDs ---

	async function entitiesToPatientIds(
		entities: IcureEntity[],
		entityType: EntityKey,
	): Promise<string[]> {
		const extractPromises = entities.map((e) => {
			switch (entityType) {
				case 'SVC':
					return api.contactApi
						.decryptPatientIdOfService(e as Service)
						.catch(() => [] as string[])
				case 'HE':
					return api.healthcareElementApi.decryptPatientIdOf(e as HealthElement)
				case 'CTC':
					return api.contactApi.decryptPatientIdOf(e as Contact)
				case 'INV':
					return api.invoiceApi.decryptPatientIdOf(e as Invoice)
				default:
					return Promise.resolve([] as string[])
			}
		})
		return [...new Set((await Promise.all(extractPromises)).flat())]
	}

	// --- Strategy registry ---

	/** Factory: fetch entities of one type, extract patient IDs → PatientByIdsFilter. */
	function entityToPatStrategy(
		entityKey: EntityKey,
		fetcher: (body: { filter: FilterNode }) => Promise<IcureEntity[]>,
	): ResolutionStrategy {
		return {
			description: `Fetch ${entityKey}, extract patient IDs`,
			weight: () => 1,
			resolve: async (body, rewritten) => {
				const entities = await fetcher(body)
				const patientIds = await entitiesToPatientIds(entities, entityKey)
				return wrap({ $type: 'PatientByIdsFilter', ids: patientIds }, rewritten.postFilters)
			},
		}
	}

	/** Factory: resolve patients → secret foreign keys → BySecretForeignKeys filter. */
	function patToEntityStrategy(targetFilterType: string): ResolutionStrategy {
		return {
			description: `Resolve patients via secret foreign keys → ${targetFilterType}`,
			weight: () => 1,
			resolve: async (body, rewritten) => {
				let patients = await matchAndFetchPatients(body.filter)
				if (rewritten.postFilters.length > 0) {
					patients = patients.filter((p: Patient) =>
						rewritten.postFilters.every((pf) => pf(p)),
					)
				}
				const sfks = await patientsToSecretForeignKeys(patients)
				return wrap({
					$type: targetFilterType,
					healthcarePartyId: hcpartyId,
					patientSecretForeignKeys: sfks,
				} as FilterNode)
			},
		}
	}

	const strategyRegistry = new Map<string, ResolutionStrategy[]>([
		['SVC→PAT', [entityToPatStrategy('SVC', fetchServices)]],
		['HE→PAT', [entityToPatStrategy('HE', fetchHealthElements)]],
		['INV→PAT', [entityToPatStrategy('INV', fetchInvoices)]],
		['CTC→PAT', [entityToPatStrategy('CTC', fetchContacts)]],
		[
			'CTC→SVC',
			[
				{
					description: 'Fetch contacts, extract service IDs from contact.services',
					weight: () => 1,
					resolve: async (body, rewritten) => {
						const contacts = await fetchContacts(body)
						const serviceIds = contacts.flatMap(
							(c: Contact) =>
								(c.services || [])
									.map((s: Service) => s.id)
									.filter(Boolean) as string[],
						)
						return wrap(
							{ $type: 'ServiceByIdsFilter', ids: serviceIds } as FilterNode,
							rewritten.postFilters,
						)
					},
				},
			],
		],
		['PAT→SVC', [patToEntityStrategy('ServiceBySecretForeignKeys')]],
		['PAT→HE', [patToEntityStrategy('HealthElementByHcPartySecretForeignKeysFilter')]],
		['PAT→CTC', [patToEntityStrategy('ContactByHcPartyPatientTagCodeDateFilter')]],
	])

	const { filter: treatedFilter, postFilters } = await rewriteFilter(parsedInput, true, '', '')
	const optimized = optimizeServiceFilters(treatedFilter, { deferServiceTag, hcpartyId })
	if (debug && optimized.postFilters.length > 0)
		console.log(`optimizeServiceFilters added ${optimized.postFilters.length} post-filter(s)`)
	return handleFinalRequest(optimized.filter as RequestNode, [
		...postFilters,
		...optimized.postFilters,
	])
}
