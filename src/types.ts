import type { Contact, HealthElement, Invoice, Patient, Service } from '@icure/api'

// --- Entity types ---

export type EntityKey = 'PAT' | 'SVC' | 'HE' | 'INV' | 'CTC'
export type IcureEntity = Patient | Contact | Service | HealthElement | Invoice

// --- Filter AST node types (produced by the Peggy parser) ---

interface FilterNodeBase {
	$type: string
	desc?: string
	healthcarePartyId?: string
}

export interface PlaceholderFilter extends FilterNodeBase {
	$type: 'PLACEHOLDER'
	healthcarePartyId: string
	key?: string
	value?: string
	colonKey?: string
	colonValue?: string
	startDate?: string
	endDate?: string
}

export interface PatientByHcPartyFilter extends FilterNodeBase {
	$type: 'PatientByHcPartyFilter'
	healthcarePartyId: string
}

export interface PatientByIdsFilter extends FilterNodeBase {
	$type: 'PatientByIdsFilter'
	ids: string[]
}

export interface PatientByHcPartyAndActiveFilter extends FilterNodeBase {
	$type: 'PatientByHcPartyAndActiveFilter'
	healthcarePartyId: string
	active: boolean | string
}

export interface PatientByHcPartyGenderEducationProfession extends FilterNodeBase {
	$type: 'PatientByHcPartyGenderEducationProfession'
	healthcarePartyId: string
	gender: string
}

export interface PatientByHcPartyDateOfBirthBetweenFilter extends FilterNodeBase {
	$type: 'PatientByHcPartyDateOfBirthBetweenFilter'
	healthcarePartyId: string
	minDateOfBirth?: number | string
	maxDateOfBirth?: number | string
}

export interface IntersectionFilter extends FilterNodeBase {
	$type: 'IntersectionFilter'
	filters: FilterNode[]
}

export interface UnionFilter extends FilterNodeBase {
	$type: 'UnionFilter'
	filters: FilterNode[]
}

export interface ComplementFilter extends FilterNodeBase {
	$type: 'ComplementFilter'
	superSet?: FilterNode
	subSet?: FilterNode | RequestNode
}

export interface ServiceByHcPartyTagCodeDateFilter extends FilterNodeBase {
	$type: 'ServiceByHcPartyTagCodeDateFilter'
	codeType?: string
	codeCode?: string
	tagType?: string
	tagCode?: string
	startValueDate?: string
	endValueDate?: string
}

export interface HealthElementByHcPartyTagCodeFilter extends FilterNodeBase {
	$type: 'HealthElementByHcPartyTagCodeFilter'
	codeType?: string
	codeNumber?: string
	tagType?: string
	tagCode?: string
}

export interface InvoiceByHcPartyCodeDateFilter extends FilterNodeBase {
	$type: 'InvoiceByHcPartyCodeDateFilter'
	code?: string
	startInvoiceDate?: string
	endInvoiceDate?: string
}

export interface ContactByHcPartyTagCodeDateFilter extends FilterNodeBase {
	$type: 'ContactByHcPartyTagCodeDateFilter'
	codeType?: string
	codeCode?: string
	tagType?: string
	tagCode?: string
	startServiceValueDate?: string
	endServiceValueDate?: string
}

export interface ServiceBySecretForeignKeys extends FilterNodeBase {
	$type: 'ServiceBySecretForeignKeys'
	patientSecretForeignKeys?: string[]
}

export interface ServiceByHcPartyCodesFilter extends FilterNodeBase {
	$type: 'ServiceByHcPartyCodesFilter'
	codeCodes: Record<string, string[]>
	startValueDate?: number
	endValueDate?: number
}

export interface ServiceByHcPartyTagCodesFilter extends FilterNodeBase {
	$type: 'ServiceByHcPartyTagCodesFilter'
	tagCodes: Record<string, string[]>
	startValueDate?: number
	endValueDate?: number
}

export interface ServiceByHcPartyPatientCodesFilter extends FilterNodeBase {
	$type: 'ServiceByHcPartyPatientCodesFilter'
	patientSecretForeignKeys: string[]
	codeCodes: Record<string, string[]>
	startValueDate?: number
	endValueDate?: number
}

export interface ServiceByHcPartyPatientTagCodesFilter extends FilterNodeBase {
	$type: 'ServiceByHcPartyPatientTagCodesFilter'
	patientSecretForeignKeys: string[]
	tagCodes: Record<string, string[]>
	startValueDate?: number
	endValueDate?: number
}

export interface HealthElementByHcPartySecretForeignKeysFilter extends FilterNodeBase {
	$type: 'HealthElementByHcPartySecretForeignKeysFilter'
	patientSecretForeignKeys?: string[]
}

export interface ContactByHcPartyPatientTagCodeDateFilter extends FilterNodeBase {
	$type: 'ContactByHcPartyPatientTagCodeDateFilter'
	patientSecretForeignKeys?: string[]
}

export interface ServiceByIdsFilter extends FilterNodeBase {
	$type: 'ServiceByIdsFilter'
	ids: string[]
}

export interface ServiceByContactsAndSubcontactsFilter extends FilterNodeBase {
	$type: 'ServiceByContactsAndSubcontactsFilter'
	contacts?: string[]
	subContacts?: string[]
	startValueDate?: number
	endValueDate?: number
}

export type FilterNode =
	| PlaceholderFilter
	| PatientByHcPartyFilter
	| PatientByIdsFilter
	| PatientByHcPartyAndActiveFilter
	| PatientByHcPartyGenderEducationProfession
	| PatientByHcPartyDateOfBirthBetweenFilter
	| IntersectionFilter
	| UnionFilter
	| ComplementFilter
	| ServiceByHcPartyTagCodeDateFilter
	| HealthElementByHcPartyTagCodeFilter
	| InvoiceByHcPartyCodeDateFilter
	| ContactByHcPartyTagCodeDateFilter
	| ServiceBySecretForeignKeys
	| ServiceByHcPartyCodesFilter
	| ServiceByHcPartyTagCodesFilter
	| ServiceByHcPartyPatientCodesFilter
	| ServiceByHcPartyPatientTagCodesFilter
	| HealthElementByHcPartySecretForeignKeysFilter
	| ContactByHcPartyPatientTagCodeDateFilter
	| ServiceByIdsFilter
	| ServiceByContactsAndSubcontactsFilter

// --- Variable reference (from parser $varName syntax) ---

export interface VariableRef {
	variable: string
}

// --- Request node (top-level parser output) ---

export interface RequestNode {
	$type: 'request'
	entity?: EntityKey | 'SUBTRACT'
	filter?: FilterNode | RequestNode
	reducers?: ReducerDef[]
	left?: FilterNode | RequestNode
	right?: Array<FilterNode | RequestNode>
}

// --- Reducer types ---

export type ReducerName =
	| 'count'
	| 'sum'
	| 'min'
	| 'max'
	| 'mean'
	| 'd2s'
	| 'd2y'
	| 's2d'
	| 'select'
	| 'share'

export interface ReducerDef {
	reducer: ReducerName
	params?: string[]
}

export type ReducerFn = (acc?: unknown[], x?: unknown, idx?: number) => Promise<unknown[]>
export type ReducerFactory = (params?: string[]) => ReducerFn

// --- Filter execution types ---

export type PostFilter = (entity: IcureEntity) => boolean
export type DeferralPolicy = (filterNode: FilterNode) => boolean

export interface RewriteResult {
	filter: FilterNode | RequestNode
	postFilters: PostFilter[]
}

// --- Resolution strategy types ---

/** Statistics about the database, used by strategy weight calculators. */
export interface DatabaseStats {
	patientCount: number
	serviceCount: number
	healthElementCount: number
	contactCount: number
	invoiceCount: number
}

/** A strategy for converting entities of one type into a filter for another. */
export interface ResolutionStrategy {
	/** Human-readable description of the approach. */
	description: string
	/** Cost heuristic — lower is preferred. Takes database stats as context. */
	weight: (stats: DatabaseStats) => number
	/** Execute: fetch sub-entities, convert to a FilterNode for mainEntity. */
	resolve: (body: { filter: FilterNode }, rewritten: RewriteResult) => Promise<RewriteResult>
}

// --- Peggy parse error ---

export interface PeggyParseError {
	location?: { start: { column: number; line: number } }
	message: string
}

// --- CouchDB query repo types ---

export interface RepoDocument {
	_id: string
	_rev?: string
	description?: string
	query?: string
	error?: string
}

export interface RepoAllDocsResponse {
	rows?: Array<{ id: string }>
}
