// TODO patient merges?
// npm link /Users/simon/Documents/taktik/icc-api
import * as WebCrypto from "node-webcrypto-ossl"
import fetch from "node-fetch"
import {iccContactApi, IccCryptoXApi, IccHcpartyXApi, iccPatientApi, ServiceDto} from 'icc-api'
import {flatMap, isEqual, omit} from 'lodash'
import * as Peg from 'pegjs'

const fs = require('fs')

const LocalStorage: any = require('node-localstorage').LocalStorage
// @ts-ignore
global.localStorage = new LocalStorage('/tmp')
// @ts-ignore
global.Storage = ''

const grammar = fs.readFileSync('./pegjs', 'utf8')
const parser = Peg.generate(grammar)

const host = 'https://backendb.svc.icure.cloud/rest/v1'
const username = ''
const password = ''
const headers = {Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`}

// @ts-ignore // todo should not have to use ts-ignore here?
let hcpartyicc = new IccHcpartyXApi(host, headers, fetch);
// @ts-ignore
const patienticc = new iccPatientApi(host, headers, fetch)
const cryptoicc = new IccCryptoXApi(host, headers, hcpartyicc, patienticc, new WebCrypto())
// @ts-ignore
const contacticc = new iccContactApi(host, headers, fetch)

const hcpartyId = "782f1bcd-9f3f-408a-af1b-cd9f3f908a98"
const privateKey = ''

async function rewriteFilter(filter: any, first: boolean, mainEntity: string = ""): Promise<any> {
	try {
		if (filter.$type === "request" && first && filter.entity && filter.filter) {
			return {
				$type: "request",
				entity: filter.entity,
				filter: await rewriteFilter(filter.filter, false, filter.entity)
			}
		} else if (filter.$type === "request") {
			if (filter.entity === "SVC") {
				const body = {filter: filter.filter}
				const servicesOutput = await contacticc.filterServicesBy(undefined, undefined, undefined, body) // TODO here and elsewhere or any
				if (mainEntity === "PAT") {
					const patientIds: string[] = await servicesToPatientIds(servicesOutput)
					return {$type: "PatientByIdsFilter", ids: patientIds}
				}
			}
			console.error("Filter not supported yet: " + filter)
			return Promise.reject()
		} else if (filter.$type !== "request") {
			if (filter.filters) { // TODO also filter.filter or other?
				let target = Object.assign({}, filter)
				target.filters = await Promise.all(filter.filters.map(async (f: any) => await rewriteFilter(f, first, mainEntity))) // TODO cleaner way ?
				return target
			} else {
				return filter
			}
		} else { // never hits this
			console.error("Failed to parse filter: " + JSON.stringify(filter))
			return Promise.reject()
		}
	} catch (e) {
		console.error('Error occurred while rewriting filter: ')
		console.error(e)
		return Promise.reject()
	}
}

async function handleFinalRequest(filter: any): Promise<any> {
	if (filter.$type === "request" && filter.entity && filter.filter) {
		if (filter.entity == 'PAT') {
			//console.log('Final filter: ' + JSON.stringify(filter.filter))
			return await patienticc.filterBy(undefined, undefined, undefined, undefined, undefined, undefined, {filter: filter.filter})
		} else {
			console.error("Entity not supported yet: " + filter.entity)
			return Promise.reject()
		}
	} else {
		console.error('Filter not valid: ' + filter)
		return {}
	}
}

async function servicesToPatientIds(servicesOutput: any): Promise<string[]> {
	try {
		const services: ServiceDto[] = servicesOutput.rows
		const extractPromises = services.map((svc: ServiceDto) => cryptoicc.extractKeysFromDelegationsForHcpHierarchy(hcpartyId, svc.contactId || "", svc.cryptedForeignKeys || {}))
		return [...new Set(flatMap(await Promise.all(extractPromises), it => it.extractedKeys))] // set to remove duplicates
		//return await patienticc.getPatients({ids: patientIds})
	} catch (error) {
		console.error('Error while converting services to patients')
		console.error(error)
		return Promise.reject()
	}
}

async function run(): Promise<boolean> {
	if (!(await tests())) return false

	try {
		//console.log(JSON.stringify(parsedInput))
		//const test = await servicesToPatientIds(servicesOutput)
		//console.log('PatientIds: ' + JSON.stringify(test))
		//const filter = {"filter":{"$type":"IntersectionFilter","filters":[{"$type":"ServiceByHcPartyTagCodeDateFilter","healthcarePartyId":"782f1bcd-9f3f-408a-af1b-cd9f3f908a98","codeCode":"T89","codeType":"ICPC"},{"$type":"ServiceByHcPartyTagCodeDateFilter","healthcarePartyId":"782f1bcd-9f3f-408a-af1b-cd9f3f908a98","tagCode":"diagnosis","tagType":"CD-ITEM"}]}}
		//console.log('test: ' + JSON.stringify(await contacticc.filterServicesBy(undefined, undefined, undefined, filter)))
		//console.log('Initial filter: ' + JSON.stringify(filter) + ', output: ')

		// console.log(JSON.stringify(parsed))
		// const output = await rewriteFilter(parsed, true, "")
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

async function tests(): Promise<boolean> {
	await cryptoicc.loadKeyPairsAsTextInBrowserLocalStorage(hcpartyId, cryptoicc.utils.hex2ua(privateKey))
	if (!cryptoicc.checkPrivateKeyValidity(await hcpartyicc.getCurrentHealthcareParty())) {
		console.error('Private key validity test failed!')
		return false
	}

	const filter = {
		"$type": "request",
		"entity": "PAT",
		"filter": {
			"$type": "IntersectionFilter",
			"filters": [
				{
					"$type": "PatientByHcPartyDateOfBirthBetweenFilter",
					"healthcarePartyId": "782f1bcd-9f3f-408a-af1b-cd9f3f908a98",
					"minDateOfBirth": 0,
					"maxDateOfBirth": "19740920"
				},
				{
					"$type": "request",
					"entity": "SVC",
					"filter": {
						"$type": "IntersectionFilter",
						"filters": [
							{
								"$type": "ServiceByHcPartyTagCodeDateFilter",
								"healthcarePartyId": "782f1bcd-9f3f-408a-af1b-cd9f3f908a98",
								"codeCode": "T89",
								"codeType": "ICPC"
							},
							{
								"$type": "ServiceByHcPartyTagCodeDateFilter",
								"healthcarePartyId": "782f1bcd-9f3f-408a-af1b-cd9f3f908a98",
								"tagCode": "diagnosis",
								"tagType": "CD-ITEM"
							}
						]
					}
				}
			]
		}
	}
	const input = "PAT[age>45y & SVC[ICPC == T89 & :CD-ITEM == diagnosis]]"
	const parsedInput = parser.parse(input)

	const p = JSON.parse(JSON.stringify(parsedInput)) // deep copy since omit mutates its inputs without telling us in the doc !!!
	const passed = isEqual(omit(p, ['filter.filters[0].maxDateOfBirth']), omit(filter, ['filter.filters[0].maxDateOfBirth']))
	if (!passed) {
		console.error('PegJS test failed!')
		return false
	}

	const output = await rewriteFilter(parsedInput, true, "")
	const finalResult = await handleFinalRequest(output)
	if (finalResult.totalSize !== 3) {
		console.error('Full test failed, totalSize=' + finalResult.totalSize + ' (should be 3)')
	}

	return true
}

run()