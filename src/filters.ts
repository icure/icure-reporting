import { flatMap, get, pick, uniqBy } from 'lodash'
import { format, fromUnixTime, getUnixTime, parse } from 'date-fns'

import type { Apis } from '@icure/api'
import {
	Contact,
	Patient,
	HealthElement,
	Invoice,
	Service,
	FilterChainService,
	FilterChainContact,
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
} from './types.js'

export type { PostFilter, DeferralPolicy }

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

export async function filter(
	parsedInput: RequestNode | FilterNode,
	api: Apis,
	hcpartyId: string,
	debug: boolean,
	deferralPolicy?: DeferralPolicy,
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
			const val = params && params[0] ? get(x, params[0]) : x
			return acc === undefined ? [0] : [((await acc) as number[])[0] + (val as number)]
		},
		mean: (params?: string[]) => async (acc?: unknown[], x?: unknown, idx?: number) => {
			const val = params && params[0] ? get(x, params[0]) : x
			return acc === undefined
				? [0]
				: [
						((await acc) as number[])[0] +
							((val as number) - ((await acc) as number[])[0]) / ((idx || 0) + 1),
					]
		},
		min: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? get(x, params[0]) : x
			return acc === undefined
				? [999999999999]
				: [
						(val as number) < ((await acc) as number[])[0]
							? val
							: ((await acc) as number[])[0],
					]
		},
		max: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? get(x, params[0]) : x
			return acc === undefined
				? [-999999999999]
				: [
						(val as number) > ((await acc) as number[])[0]
							? val
							: ((await acc) as number[])[0],
					]
		},
		s2d: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? get(x, params[0]) : x
			const d = val && Number(format(fromUnixTime(val as number), 'yyyyMMdd'))
			return acc === undefined ? [] : ((await acc) as unknown[]).concat([d])
		},
		d2s: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? get(x, params[0]) : x
			const d = (val && getUnixTime(parse((val as number).toString(), 'yyyyMMdd', 0))) || 0
			return acc === undefined ? [] : ((await acc) as unknown[]).concat([d])
		},
		d2y: (params?: string[]) => async (acc?: unknown[], x?: unknown) => {
			const val = params && params[0] ? get(x, params[0]) : x
			const d = (val && getUnixTime(parse((val as number).toString(), 'yyyyMMdd', 0))) || 0
			return acc === undefined
				? []
				: ((await acc) as unknown[]).concat([
						(+new Date() / 1000 - d) / (365.25 * 24 * 3600),
					])
		},
		select: (params?: string[]) => async (acc?: unknown[], x?: unknown) =>
			acc === undefined
				? []
				: ((await acc) as unknown[]).concat([params ? pick(x, params) : x]),
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
				const withHcpId = (hcpId: string) => ({
					filter: Object.assign({}, body.filter, { healthcarePartyId: hcpId }),
				})
				try {
					if (req.entity === 'SVC') {
						if (debug) console.error('Request SVC: ' + JSON.stringify(body))
						const servicesOutput = uniqBy(
							flatMap(
								(await Promise.all(
									hcpHierarchy.map((hcpId) =>
										api.contactApi.filterServicesByWithUser(
											currentUser,
											undefined,
											10000,
											withHcpId(hcpId) as unknown as FilterChainService,
										),
									),
								)) as Array<{ rows?: Service[] }>,
								(pl) => pl.rows || [],
							),
							(x: Service) => x.id,
						)
						if (mainEntity === 'PAT') {
							const patientIds: string[] = await servicesToPatientIds(servicesOutput)
							if (debug) console.log('Patient Ids: ' + patientIds)
							return wrap(
								{ $type: 'PatientByIdsFilter', ids: patientIds },
								rewritten.postFilters,
							)
						}
					} else if (req.entity === 'HE') {
						if (debug) console.log('Request HE: ' + JSON.stringify(body))
						const helementOutput = uniqBy(
							flatMap(
								await Promise.all(
									hcpHierarchy.map((hcpId) =>
										api.healthcareElementApi.filterByWithUser(
											currentUser,
											undefined,
											undefined,
											withHcpId(hcpId) as unknown as FilterChainHealthElement,
										),
									),
								),
								(pl: { rows?: HealthElement[] }) => pl.rows || [],
							),
							(x: HealthElement) => x.id,
						)
						if (mainEntity === 'PAT') {
							const patientIds: string[] = await helementsToPatientIds(
								helementOutput || [],
							)
							return wrap(
								{ $type: 'PatientByIdsFilter', ids: patientIds },
								rewritten.postFilters,
							)
						}
					} else if (req.entity === 'INV') {
						if (debug) console.log('Request INV: ' + JSON.stringify(body))
						const invoiceOutput = uniqBy(
							flatMap(
								await Promise.all(
									hcpHierarchy.map((hcpId) =>
										api.invoiceApi.filterInvoicesBy(
											withHcpId(hcpId) as unknown as FilterChainInvoice,
										),
									),
								),
							),
							(x: Invoice) => x.id,
						)
						if (mainEntity === 'PAT') {
							const patientIds: string[] = await invoicesToPatientIds(
								invoiceOutput || [],
							)
							return wrap(
								{ $type: 'PatientByIdsFilter', ids: patientIds },
								rewritten.postFilters,
							)
						}
					} else if (req.entity === 'CTC') {
						if (debug) console.log('Request CTC: ' + JSON.stringify(body))

						const contactOutput = uniqBy(
							flatMap(
								(await Promise.all(
									hcpHierarchy.map((hcpId) =>
										api.contactApi.filterByWithUser(
											currentUser,
											undefined,
											10000,
											withHcpId(hcpId) as unknown as FilterChainContact,
										),
									),
								)) as Array<{ rows?: Contact[] }>,
								(pl) => pl.rows || [],
							),
							(x: Contact) => x.id,
						)
						if (mainEntity === 'PAT') {
							const patientIds: string[] = await contactsToPatientIds(contactOutput)
							return wrap(
								{ $type: 'PatientByIdsFilter', ids: patientIds },
								rewritten.postFilters,
							)
						}
					}
				} catch (error) {
					console.error(
						'Error occurred while handling entity ' +
							req.entity +
							' with body: ' +
							JSON.stringify(body),
					)
					console.error(error)
					return Promise.reject()
				}
				console.error('Filter not supported yet: ' + filter)
				return Promise.reject()
			} else {
				const fNode = filter as FilterNode
				// --- IntersectionFilter with deferral ---
				if ('filters' in fNode && fNode.filters) {
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
			return Promise.reject()
		}
	}

	async function handleFinalRequest(
		filter: RequestNode,
		postFilters: PostFilter[],
	): Promise<IcureEntity[] & { rows?: unknown[] }> {
		if (debug) console.log('Final request: ' + JSON.stringify(filter))
		if (filter.$type === 'request' && filter.entity && filter.filter) {
			let res: IcureEntity[]
			const filterChain = { filter: filter.filter as FilterNode }
			if (filter.entity === 'PAT') {
				res =
					(
						await api.patientApi.filterByWithUser(
							currentUser,
							filterChain as unknown as FilterChainPatient,
						)
					)?.rows || []
			} else if (filter.entity === 'HE') {
				res =
					(
						await api.healthcareElementApi.filterByWithUser(
							currentUser,
							undefined,
							undefined,
							filterChain as unknown as FilterChainHealthElement,
						)
					)?.rows || []
			} else if (filter.entity === 'SVC') {
				res =
					(
						(await api.contactApi.filterServicesByWithUser(
							currentUser,
							undefined,
							undefined,
							filterChain as unknown as FilterChainService,
						)) as { rows?: Service[] }
					)?.rows || []
			} else if (filter.entity === 'INV') {
				res = await api.invoiceApi.filterInvoicesBy(
					filterChain as unknown as FilterChainInvoice,
				)
			} else if (filter.entity === 'CTC') {
				res =
					(
						(await api.contactApi.filterByWithUser(
							currentUser,
							undefined,
							undefined,
							filterChain as unknown as FilterChainContact,
						)) as { rows?: Contact[] }
					)?.rows || []
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

	async function servicesToPatientIds(services: Array<Service>): Promise<string[]> {
		try {
			const extractPromises = services.map((svc: Service) =>
				api.contactApi.decryptPatientIdOfService(svc).catch((e: unknown) => {
					console.error(
						'Skipped error while converting service to patient id (might be due to missing patient)',
					)
					console.error(e)
					return [] as string[]
				}),
			)
			return [...new Set(flatMap(await Promise.all(extractPromises)))]
		} catch (error) {
			console.error('Error while converting services to patient ids')
			console.error(error)
			return Promise.reject()
		}
	}

	async function helementsToPatientIds(helements: HealthElement[]): Promise<string[]> {
		try {
			const extractPromises = helements.map((he: HealthElement) =>
				api.healthcareElementApi.decryptPatientIdOf(he),
			)
			return [...new Set(flatMap(await Promise.all(extractPromises)))]
		} catch (error) {
			console.error('Error while converting health elements to patient ids')
			console.error(error)
			return Promise.reject()
		}
	}

	async function invoicesToPatientIds(invoices: Invoice[]): Promise<string[]> {
		try {
			const extractPromises = invoices.map((inv: Invoice) =>
				api.invoiceApi.decryptPatientIdOf(inv),
			)
			return [...new Set(flatMap(await Promise.all(extractPromises)))]
		} catch (error) {
			console.error('Error while converting invoices to patient ids')
			console.error(error)
			return Promise.reject()
		}
	}

	async function contactsToPatientIds(contacts: Contact[]): Promise<string[]> {
		try {
			const extractPromises = contacts.map((ctc: Contact) =>
				api.contactApi.decryptPatientIdOf(ctc),
			)
			return [...new Set(flatMap(await Promise.all(extractPromises)))]
		} catch (error) {
			console.error('Error while converting contacts to patient ids')
			console.error(error)
			return Promise.reject()
		}
	}

	const { filter: treatedFilter, postFilters } = await rewriteFilter(parsedInput, true, '', '')
	return handleFinalRequest(treatedFilter as RequestNode, postFilters)
}
