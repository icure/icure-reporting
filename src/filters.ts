import fetch from 'node-fetch'
import { HealthElementDto, ServiceDto, PatientDto, UserDto } from 'icc-api'
import { flatMap } from 'lodash'
import * as Peg from 'pegjs'
import { Api } from './api'
require('node-json-color-stringify')

const fs = require('fs')
const vorpal = new (require('vorpal'))()
import { Args, CommandInstance } from 'vorpal'

const localStorage = (global as any).localStorage = new (require('node-localstorage').LocalStorage)('/tmp')
;(global as any).Storage = ''

const options = {
	username: '',
	password: '',
	host: 'https://backendb.svc.icure.cloud/rest/v1'
}

let api = new Api(options.host, { Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}` }, fetch as any)
let hcpartyId: string = ''

api.hcpartyicc.getCurrentHealthcareParty().then(hcp => {
	hcpartyId = hcp.id
	if (hcp.id === '782f1bcd-9f3f-408a-af1b-cd9f3f908a98') {
		const privateKey = ''
		api.cryptoicc.loadKeyPairsAsTextInBrowserLocalStorage(hcpartyId, api.cryptoicc.utils.hex2ua(privateKey))
	}
})

vorpal
	.command('login <username> <password> [host]', 'Login to iCure')
	.action(async function(this: CommandInstance, args: Args) {
		options.username = args.username
		options.password = args.password
		args.host && (options.host = args.host)

		api = new Api(options.host, { Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}` }, fetch as any)
	})

vorpal
	.command('pki <hcpId> <key>', 'Private Key Import')
	.action(async function(this: CommandInstance, args: Args) {
		const hcpId = args.hcpId
		const key = args.key

		await api.cryptoicc.loadKeyPairsAsTextInBrowserLocalStorage(hcpId, api.cryptoicc.utils.hex2ua(key))
		if (await api.cryptoicc.checkPrivateKeyValidity(await api.hcpartyicc.getHealthcareParty(hcpId))) {
			this.log('Key is valid')
		} else {
			this.log('Key is invalid')
		}
	})

vorpal
	.command('lpkis', 'List Private Keys')
	.action(async function(this: CommandInstance, args: Args) {
		const users = (await api.usericc.listUsers(undefined, undefined, undefined)).rows
		users.reduce(async (p: Promise<any>, u: UserDto) => {
			await p
			if (u.healthcarePartyId) {
				const hcp = await api.hcpartyicc.getHealthcareParty(u.healthcarePartyId)
				try {
					if (hcp.publicKey && await api.cryptoicc.checkPrivateKeyValidity(hcp)) {
						this.log(`√ ${hcp.id}: ${hcp.firstName} ${hcp.lastName}`)
					} else {
						this.log(`X ${hcp.id}: ${hcp.firstName} ${hcp.lastName}`)
					}
				} catch (e) {
					this.log(`X ${hcp.id}: ${hcp.firstName} ${hcp.lastName}`)
				}
			}
		}, Promise.resolve())
	})

vorpal
	.command('query [input...]', 'Queries iCure')
	.action(async function(this: CommandInstance, args: Args) {
		try {
			const start = +new Date()
			const hcp = await api.hcpartyicc.getCurrentHealthcareParty()
			if (!hcp) {
				console.error('You are not logged in')
				return
			}
			const input = args.input.join(' ')
			this.log('Parsing query: ' + input)
			const parsedInput = parser.parse(input, { hcpId: hcp.parentId || hcp.id })
			const output = await rewriteFilter(parsedInput, true, '', '')
			const finalResult = await handleFinalRequest(output)
			this.log((JSON as any).colorStringify(finalResult.rows.map((p: PatientDto) => ({
				id: p.id,
				firstName: p.firstName,
				lastName: p.lastName,
				dateOfBirth: p.dateOfBirth
			})), null, ' '))
			const stop = +new Date()
			this.log(`${finalResult.rows.length} items returned in ${stop - start} ms`)
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal
	.command('whoami', 'Logged user info')
	.action(async function(this: CommandInstance, args: Args) {
		this.log((await api.usericc.getCurrentUser()).login + '@' + options.host)
	})

vorpal
	.command('ex', 'Example queries')
	.action(async function(this: CommandInstance, args: Args) {
		this.log('PAT[age<25y]')
		this.log('PAT[(age>45y & SVC[ICPC == T89 & :CD-ITEM == diagnosis]) - SVC[LOINC == Hba1c & :CD-ITEM == diagnosis]]')
		this.log('PAT[age>25y & age<65y - SVC[CISP == X75{19000101 -> 20200101} & :CD-ITEM == diagnosis] - SVC[CISP == X37.002] - SVC[CISP == X37.003]]')
		this.log('PAT[age>25y & age<65y - (SVC[CISP == X75{<3y} & :CD-ITEM == diagnosis] | HE[CISP == X75 | HE[CISP == X75]]) - SVC[CISP == X37.002] - SVC[CISP == X37.003]]')
		this.log('PAT[age>45y & SVC[ICPC == T89{>1m} & :CD-ITEM == diagnosis | ICPC == T90] - SVC[ICPC == T90]]')
	})

vorpal
	.delimiter('icure-reporting$')
	.show()

const grammar = fs.readFileSync('./pegjs', 'utf8')
const parser = Peg.generate(grammar)

const debug = false

const requestToFilterTypeMap = { 'SVC': 'ServiceByHcPartyTagCodeDateFilter', 'HE': 'HealthElementByHcPartyTagCodeFilter' }

async function rewriteFilter(filter: any, first: boolean, mainEntity: string, subEntity: string): Promise<any> {
	try {
		if (debug) console.log('Rewriting ' + JSON.stringify(filter))
		if (filter.$type === 'request' && first && filter.entity && filter.filter) {
			return {
				$type: 'request',
				entity: filter.entity,
				filter: await rewriteFilter(filter.filter, false, filter.entity, subEntity)
			}
		} else if (filter.$type === 'request') {
			if (filter.entity === 'SVC') {
				const rewritten = await rewriteFilter(filter.filter, first, mainEntity, filter.entity || subEntity)
				const body = { filter: rewritten }
				if (debug) console.log('Request SVC: ' + JSON.stringify(body))
				const servicesOutput = await api.contacticc.filterServicesBy(undefined, undefined, undefined, body) // TODO here and elsewhere or any
				if (mainEntity === 'PAT') {
					const patientIds: string[] = await servicesToPatientIds(servicesOutput)
					return { $type: 'PatientByIdsFilter', ids: patientIds }
				}
			} else if (filter.entity === 'HE') {
				const rewritten = await rewriteFilter(filter.filter, first, mainEntity, filter.entity || subEntity)
				const body = { filter: rewritten }
				// Use a logger instead console.log("Request HE: " + JSON.stringify(body))
				const helementOutput = await api.helementicc.filterBy(body)
				if (mainEntity === 'PAT') {
					// console.log("helement body: " + JSON.stringify(helementOutput))
					// console.log("helementOutput: " + JSON.stringify(helementOutput))
					const patientIds: string[] = await helementsToPatientIds(helementOutput)
					return { $type: 'PatientByIdsFilter', ids: patientIds }
					// return {}
				}
			}
			if (filter.entity === 'SUBTRACT') {
				if (debug) console.log('Subtract')
				const left = await rewriteFilter(filter.left, first, mainEntity, subEntity)
				const right = await rewriteFilter(filter.right, first, mainEntity, subEntity)
				return { $type: 'ComplementFilter', superSet: left, subSet: right }
			}
			console.error('Filter not supported yet: ' + filter)
			return Promise.reject()
		} else if (filter.$type !== 'request') {
			if (filter.filters) {
				let target = JSON.parse(JSON.stringify(filter))
				target.filters = await Promise.all(filter.filters.map(async (f: any) => rewriteFilter(f, first, mainEntity, subEntity)))
				return target
			} else if (filter.subSet || filter.superSet) {
				let target = JSON.parse(JSON.stringify(filter))
				if (filter.subSet) target.subSet = await rewriteFilter(target.subSet, first, mainEntity, subEntity)
				if (filter.superSet) target.superSet = await rewriteFilter(target.superSet, first, mainEntity, subEntity)
				return target
			} else { // TODO maybe other conditions here
				// @ts-ignore
				if (filter.$type === 'PLACEHOLDER') filter.$type = requestToFilterTypeMap[subEntity]
				if (debug) console.log('Leaf filter: ' + JSON.stringify(filter))
				return filter
			}
		} else { // never hits this
			console.error('Failed to parse filter: ' + JSON.stringify(filter))
			return Promise.reject()
		}
	} catch (error) {
		console.error('Error occurred while rewriting filter: ' + JSON.stringify(filter))
		console.error(error)
		return Promise.reject()
	}
}

async function handleFinalRequest(filter: any): Promise<any> {
	if (filter.$type === 'request' && filter.entity && filter.filter) {
		if (filter.entity === 'PAT') {
			return api.patienticc.filterByWithUser(await api.usericc.getCurrentUser(), undefined, undefined, undefined, undefined, undefined, undefined, { filter: filter.filter })
		} else {
			console.error('Entity not supported yet: ' + filter.entity)
			return Promise.reject()
		}
	} else {
		console.error('Filter not valid: ' + JSON.stringify(filter, null, ' '))
		return {}
	}
}

async function servicesToPatientIds(servicesOutput: any): Promise<string[]> {
	try {
		const services: ServiceDto[] = servicesOutput.rows
		const extractPromises = services.map((svc: ServiceDto) => api.cryptoicc.extractKeysFromDelegationsForHcpHierarchy(hcpartyId, svc.contactId || '', svc.cryptedForeignKeys || {}))
		return [...new Set(flatMap(await Promise.all(extractPromises), it => it.extractedKeys))] // set to remove duplicates
		// return await patienticc.getPatients({ids: patientIds})
	} catch (error) {
		console.error('Error while converting services to patients')
		console.error(error)
		return Promise.reject()
	}
}

async function helementsToPatientIds(helementOutput: any): Promise<string[]> {
	try {
		const helements: HealthElementDto[] = helementOutput
		const extractPromises = helements.map((he: HealthElementDto) => api.cryptoicc.extractKeysFromDelegationsForHcpHierarchy(hcpartyId, he.id || '', he.cryptedForeignKeys || {}))
		return [...new Set(flatMap(await Promise.all(extractPromises), it => it.extractedKeys))] // set to remove duplicates
	} catch (error) {
		console.error('Error while converting health elements to patients')
		console.error(error)
		return Promise.reject()
	}
}

async function run(): Promise<boolean> {
	// if (!(await tests())) return false
	try {
		// TODO labresult instead of diagnosis
		// const input = "PAT[(age>45y & SVC[ICPC == T89 & :CD-ITEM == diagnosis]) - SVC[LOINC == Hba1c & :CD-ITEM == diagnosis]]"
		const input = 'PAT[age>45y & SVC[ICPC == T89{>1m} & :CD-ITEM == diagnosis | ICPC == T90] - SVC[ICPC == T90]]'
		const parsedInput = parser.parse(input)
		if (debug) console.log('ParsedInput (first test): ' + JSON.stringify(parsedInput))
		const output = await rewriteFilter(parsedInput, true, '', '')
		console.log('Rewritten filter (first test): ' + JSON.stringify(output))
		const finalResult = await handleFinalRequest(output)
		if (debug) console.log(finalResult)
		console.log(finalResult.totalSize)

		// femme de 25-65 sans cancer du col, sans procédure 002 ou 003 faite ou refusée(?) dans les 3 dernières années
		const input2 = 'PAT[age>25y & age<65y - (SVC[CISP == X75{<3y} & :CD-ITEM == diagnosis] | HE[CISP == X75 | HE[CISP == X75]]) - SVC[CISP == X37.002] - SVC[CISP == X37.003]]'
		// const input2 = "PAT[age>25y & age<65y - SVC[CISP == X75{19000101 -> 20200101} & :CD-ITEM == diagnosis] - SVC[CISP == X37.002] - SVC[CISP == X37.003]]"
		const parsedInput2 = parser.parse(input2)
		console.log('-> ParsedInput: ' + JSON.stringify(parsedInput2))
		const output2 = await rewriteFilter(parsedInput2, true, '', '')
		console.log('-> Rewritten filter: ' + JSON.stringify(output2))
		const finalResult2 = await handleFinalRequest(output2)
		// console.log(finalResult2)
		console.log('-> ' + finalResult2.totalSize)

		// console.log(JSON.stringify(parsedInput))
		// const test = await servicesToPatientIds(servicesOutput)
		// console.log('PatientIds: ' + JSON.stringify(test))
		// const filter = {"filter":{"$type":"IntersectionFilter","filters":[{"$type":"ServiceByHcPartyTagCodeDateFilter","healthcarePartyId":"782f1bcd-9f3f-408a-af1b-cd9f3f908a98","codeCode":"T89","codeType":"ICPC"},{"$type":"ServiceByHcPartyTagCodeDateFilter","healthcarePartyId":"782f1bcd-9f3f-408a-af1b-cd9f3f908a98","tagCode":"diagnosis","tagType":"CD-ITEM"}]}}
		// console.log('test: ' + JSON.stringify(await contacticc.filterServicesBy(undefined, undefined, undefined, filter)))
		// console.log('Initial filter: ' + JSON.stringify(filter) + ', output: ')

		// console.log(JSON.stringify(parsed))
		// const output = await rewriteFilter(parsed, true, "", "")
		// console.log('Rewritten filter: ' + JSON.stringify(output))
		//
		// const finalResult = await handleFinalRequest(output)
		// console.log('Final result: ' + JSON.stringify(finalResult))
	} catch (e) {
		console.error('Error occurred while running main function')
		console.error(e)
	}
	return true
}