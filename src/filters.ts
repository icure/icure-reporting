// TODO patient merges?
// npm link /Users/simon/Documents/taktik/icc-api
import * as WebCrypto from "node-webcrypto-ossl"
import fetch from "node-fetch"
import {iccContactApi, IccCryptoXApi, IccHcpartyXApi, iccPatientApi, ServiceDto, iccHelementApi, HealthElementDto} from 'icc-api'
import {flatMap, isEqual, omit} from 'lodash'
import * as Peg from 'pegjs'

const fs = require('fs')
const vorpal = new (require('vorpal'))()
import {Args, CommandInstance} from "vorpal";

vorpal
	.command('query [input...]', 'Queries iCure')
	.action(async function (this: CommandInstance, args: Args) {
		const input = args.input.join(' ')
		this.log('Parsing query: ' + input)
		const parsedInput = parser.parse(input)
		const output = await rewriteFilter(parsedInput, true, "", "")
		const finalResult = await handleFinalRequest(output)
		this.log(finalResult)
	});

vorpal
	.delimiter('icure-reporting$')
	.show();

const LocalStorage: any = require('node-localstorage').LocalStorage
// @ts-ignore
global.localStorage = new LocalStorage('/tmp')
// @ts-ignore
global.Storage = ''

const grammar = fs.readFileSync('./pegjs', 'utf8')
const parser = Peg.generate(grammar)

const debug = false
const host = 'https://backendb.svc.icure.cloud/rest/v1'
const username = ''
const password = ''
const headers = {Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`}

// @ts-ignore // todo should not have to use ts-ignore here?
let hcpartyicc = new IccHcpartyXApi(host, headers, fetch)
// @ts-ignore
const patienticc = new iccPatientApi(host, headers, fetch)
const cryptoicc = new IccCryptoXApi(host, headers, hcpartyicc, patienticc, new WebCrypto())
// @ts-ignore
const contacticc = new iccContactApi(host, headers, fetch)
// @ts-ignore
const helementicc = new iccHelementApi(host, headers, fetch)

const hcpartyId = "782f1bcd-9f3f-408a-af1b-cd9f3f908a98"
const privateKey = ''

const requestToFilterTypeMap = {'SVC': 'ServiceByHcPartyTagCodeDateFilter', 'HE': 'HealthElementByHcPartyTagCodeFilter'}



async function rewriteFilter(filter: any, first: boolean, mainEntity: string, subEntity: string): Promise<any> {
	try {
		if (debug) console.log("Rewriting " + JSON.stringify(filter))
		if (filter.$type === "request" && first && filter.entity && filter.filter) {
			return {
				$type: "request",
				entity: filter.entity,
				filter: await rewriteFilter(filter.filter, false, filter.entity, subEntity)
			}
		} else if (filter.$type === "request") {
			if (filter.entity === "SVC") {
				const rewritten = await rewriteFilter(filter.filter, first, mainEntity, filter.entity || subEntity)
				const body = {filter: rewritten}
				if (debug) console.log("Request SVC: " + JSON.stringify(body))
				const servicesOutput = await contacticc.filterServicesBy(undefined, undefined, undefined, body) // TODO here and elsewhere or any
				if (mainEntity === "PAT") {
					const patientIds: string[] = await servicesToPatientIds(servicesOutput)
					return {$type: "PatientByIdsFilter", ids: patientIds}
				}
			} else if (filter.entity === "HE") {
				const rewritten = await rewriteFilter(filter.filter, first, mainEntity, filter.entity || subEntity)
				const body = {filter: rewritten}
				console.log("Request HE: " + JSON.stringify(body))
				const helementOutput = await helementicc.filterBy(body)
				if (mainEntity === "PAT") {
					console.log("helement body: " + JSON.stringify(helementOutput))
					console.log("helementOutput: " + JSON.stringify(helementOutput))
					const patientIds: string[] = await helementsToPatientIds(helementOutput)
					return {$type: "PatientByIdsFilter", ids: patientIds}
					//return {}
				}
			}
			if (filter.entity === "SUBTRACT") {
				if (debug) console.log("Subtract")
				const left = await rewriteFilter(filter.left, first, mainEntity, subEntity)
				const right = await rewriteFilter(filter.right, first, mainEntity, subEntity)
				return {$type: "ComplementFilter", superSet: left, subSet: right}
			}
			console.error("Filter not supported yet: " + filter)
			return Promise.reject()
		} else if (filter.$type !== "request") {
			if (filter.filters) {
				let target = JSON.parse(JSON.stringify(filter))
				target.filters = await Promise.all(filter.filters.map(async (f: any) => await rewriteFilter(f, first, mainEntity, subEntity)))
				return target
			} else if (filter.subSet || filter.superSet) {
				let target = JSON.parse(JSON.stringify(filter))
				if (filter.subSet) target.subSet = await rewriteFilter(target.subSet, first, mainEntity, subEntity)
				if (filter.superSet) target.superSet = await rewriteFilter(target.superSet, first, mainEntity, subEntity)
				return target
			} else { // TODO maybe other conditions here
				// @ts-ignore
				if (filter.$type === "PLACEHOLDER") filter.$type = requestToFilterTypeMap[subEntity]
				if (debug) console.log("Leaf filter: " + JSON.stringify(filter))
				return filter
			}
		} else { // never hits this
			console.error("Failed to parse filter: " + JSON.stringify(filter))
			return Promise.reject()
		}
	} catch (error) {
		console.error('Error occurred while rewriting filter: ' + JSON.stringify(filter))
		console.error(error)
		return Promise.reject()
	}
}

async function handleFinalRequest(filter: any): Promise<any> {
	if (filter.$type === "request" && filter.entity && filter.filter) {
		if (filter.entity == 'PAT') {
			return await patienticc.filterBy(undefined, undefined, undefined, undefined, undefined, undefined, {filter: filter.filter})
		} else {
			console.error("Entity not supported yet: " + filter.entity)
			return Promise.reject()
		}
	} else {
		console.error('Filter not valid: ' + JSON.stringify(filter))
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

async function helementsToPatientIds(helementOutput: any): Promise<string[]> {
	try {
		const helements: HealthElementDto[] = helementOutput
		const extractPromises = helements.map((he: HealthElementDto) => cryptoicc.extractKeysFromDelegationsForHcpHierarchy(hcpartyId, he.id || "", he.cryptedForeignKeys || {}))
		return [...new Set(flatMap(await Promise.all(extractPromises), it => it.extractedKeys))] // set to remove duplicates
	} catch (error) {
		console.error('Error while converting health elements to patients')
		console.error(error)
		return Promise.reject()
	}
}

async function run(): Promise<boolean> {
	//if (!(await tests())) return false
	await tests()
	try {
		// TODO labresult instead of diagnosis
		//const input = "PAT[(age>45y & SVC[ICPC == T89 & :CD-ITEM == diagnosis]) - SVC[LOINC == Hba1c & :CD-ITEM == diagnosis]]"
		const input = "PAT[age>45y & SVC[ICPC == T89{>1m} & :CD-ITEM == diagnosis | ICPC == T90] - SVC[ICPC == T90]]"
		const parsedInput = parser.parse(input)
		if (debug) console.log('ParsedInput (first test): ' + JSON.stringify(parsedInput))
		const output = await rewriteFilter(parsedInput, true, "", "")
		console.log('Rewritten filter (first test): ' + JSON.stringify(output))
		const finalResult = await handleFinalRequest(output)
		if (debug) console.log(finalResult)
		console.log(finalResult.totalSize)

		// femme de 25-65 sans cancer du col, sans procédure 002 ou 003 faite ou refusée(?) dans les 3 dernières années
		const input2 = "PAT[age>25y & age<65y - (SVC[CISP == X75{<3y} & :CD-ITEM == diagnosis] | HE[CISP == X75 | HE[CISP == X75]]) - SVC[CISP == X37.002] - SVC[CISP == X37.003]]"
		//const input2 = "PAT[age>25y & age<65y - SVC[CISP == X75{19000101 -> 20200101} & :CD-ITEM == diagnosis] - SVC[CISP == X37.002] - SVC[CISP == X37.003]]"
		const parsedInput2 = parser.parse(input2)
		console.log('-> ParsedInput: ' + JSON.stringify(parsedInput2))
		const output2 = await rewriteFilter(parsedInput2, true, "", "")
		console.log('-> Rewritten filter: ' + JSON.stringify(output2))
		const finalResult2 = await handleFinalRequest(output2)
		//console.log(finalResult2)
		console.log('-> ' + finalResult2.totalSize)

		//console.log(JSON.stringify(parsedInput))
		//const test = await servicesToPatientIds(servicesOutput)
		//console.log('PatientIds: ' + JSON.stringify(test))
		//const filter = {"filter":{"$type":"IntersectionFilter","filters":[{"$type":"ServiceByHcPartyTagCodeDateFilter","healthcarePartyId":"782f1bcd-9f3f-408a-af1b-cd9f3f908a98","codeCode":"T89","codeType":"ICPC"},{"$type":"ServiceByHcPartyTagCodeDateFilter","healthcarePartyId":"782f1bcd-9f3f-408a-af1b-cd9f3f908a98","tagCode":"diagnosis","tagType":"CD-ITEM"}]}}
		//console.log('test: ' + JSON.stringify(await contacticc.filterServicesBy(undefined, undefined, undefined, filter)))
		//console.log('Initial filter: ' + JSON.stringify(filter) + ', output: ')

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
								"$type": "PLACEHOLDER", //"ServiceByHcPartyTagCodeDateFilter",
								"healthcarePartyId": "782f1bcd-9f3f-408a-af1b-cd9f3f908a98",
								"codeCode": "T89", // D6Aqqch
								"codeType": "ICPC" // "LOINC"
								//"dateSTart" // à faire
							},
							{
								"$type": "PLACEHOLDER", //"ServiceByHcPartyTagCodeDateFilter",
								"healthcarePartyId": "782f1bcd-9f3f-408a-af1b-cd9f3f908a98",
								"tagCode": "diagnosis", // "labresult"
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
		console.error('PegJS test failed! Output: ' + JSON.stringify(p))
		return false
	}

	const output = await rewriteFilter(parsedInput, true, "", "")
	//console.log('Rewritten filter: ' + JSON.stringify(output))
	const finalResult = await handleFinalRequest(output)
	//console.log(finalResult)
	if (finalResult.totalSize !== 3) {
		console.error('Full test failed, totalSize=' + finalResult.totalSize + ' (should be 3)')
		return false
	}

	return true
}

<<<<<<< HEAD
run()
=======
//run()
>>>>>>> d50e932 (use vorpal)
