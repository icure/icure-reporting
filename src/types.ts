import type { Contact, HealthElement, Invoice, Patient, Service } from '@icure/api'

// --- Entity types ---

export type EntityKey = 'PAT' | 'SVC' | 'HE' | 'INV' | 'CTC'
export type IcureEntity = Patient | Contact | Service | HealthElement | Invoice

// --- Filter AST node types (produced by the Peggy parser) ---

interface FilterNodeBase {
	$type: string
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
