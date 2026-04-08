import { IcureApi, hex2ua } from '@icure/api'
import type { Apis } from '@icure/api'
import * as nodeCrypto from 'node:crypto'

import { forEachDeep, mapDeep } from './reduceDeep.js'
import { isObject } from 'lodash'
import * as peggy from 'peggy'
import { format, addMonths, addYears } from 'date-fns'

import pc from 'picocolors'
import { filter, composePolicies } from './filters.js'
import type { DeferralPolicy } from './filters.js'
import type { PeggyParseError, RepoDocument, RepoAllDocsResponse } from './types.js'
import { writeExcel } from './xls.js'

import * as path from 'node:path'
import * as fs from 'node:fs'
import { inspect } from 'node:util'
import * as readline from 'node:readline/promises'
import { FileStorageFacade, FileKeyStorageFacade } from './local-storage-shim.js'
import { createCryptoStrategies } from './crypto-strategies.js'

// TODO use a logger
// TODO patient merges
// TODO more examples, with invoices/health elements/contacts, at first level

const debug = false

const storage = new FileStorageFacade()
const keyStorage = new FileKeyStorageFacade()
const keyMap: Map<string, { publicKey: JsonWebKey; privateKey: JsonWebKey }> = new Map()

const options: {
	username: string
	password: string
	host: string
	repoUsername: string | null
	repoPassword: string | null
	repoHost: string | null
	repoHeader: Record<string, string>
} = {
	username: '',
	password: '',
	host: 'https://qa.icure.cloud',
	repoUsername: null,
	repoPassword: null,
	repoHost: null,
	repoHeader: {},
}

let api: Apis
let hcpartyId = ''

async function initApis() {
	api = await IcureApi.initialise(
		options.host,
		{ username: options.username, password: options.password },
		createCryptoStrategies(keyMap),
		nodeCrypto.webcrypto as any,
		undefined,
		{ storage, keyStorage },
	)
}
let latestQuery: string | null = null
const existingVariables = new Map<string, string>()

const grammar = fs.readFileSync(
	path.resolve(__dirname, '../grammar/icure-reporting-parser.peggy'),
	'utf8',
)
const parser = peggy.generate(grammar)

let rl: readline.Interface

function log(msg: string) {
	console.log(msg)
}

async function question(prompt: string): Promise<string> {
	return rl.question(prompt)
}

// --- Command Handlers ---

async function cmdRepo(args: string[]) {
	const [username, password, host] = args
	if (!username || !password) {
		log(pc.red('Usage: repo <username> <password> [host]'))
		return
	}
	if (host) options.repoHost = host
	options.repoHeader = {
		Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
	}
}

async function cmdLogin(args: string[]) {
	const [username, password, host] = args
	if (!username || !password) {
		log(pc.red('Usage: login <username> <password> [host]'))
		return
	}
	options.username = username
	options.password = password
	if (host) options.host = host
	await initApis()
	const hcp = await api.healthcarePartyApi.getCurrentHealthcareParty()
	hcpartyId = hcp.id!
}

async function cmdPki(args: string[]) {
	const [hcpId, key] = args
	if (!hcpId || !key) {
		log(pc.red('Usage: pki <hcpId> <key>'))
		return
	}
	// In v8, keys are managed via KeyStorageFacade + CryptoStrategies.
	// Store the raw private key in key storage, then re-init the API so CryptoStrategies picks it up.
	const keyBytes = hex2ua(key)
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
	keyMap.set(hcpId, { privateKey: privateJwk, publicKey: publicJwk })
	log('Key stored. Re-initializing API...')
	await initApis()
	log('Key imported successfully')
}

async function cmdLpkis() {
	const pubKeys = await api.cryptoApi.getCurrentUserHierarchyAvailablePublicKeysHex()
	if (pubKeys.length > 0) {
		for (const pk of pubKeys) {
			log(`${pc.green('√')} ${pk.substring(0, 32)}...`)
		}
	} else {
		log(pc.red('No key pairs available'))
	}
}

function convertVariable(text: string): number | string {
	if (text.endsWith('m')) {
		return Number(format(addMonths(new Date(), -Number(text.slice(0, -1))), 'yyyyMMdd'))
	} else if (text.endsWith('y')) {
		return Number(format(addYears(new Date(), -Number(text.slice(0, -1))), 'yyyyMMdd'))
	}
	return text
}

async function executeInput(input: string, exportPath?: string, deferPolicy?: DeferralPolicy) {
	const start = +new Date()
	const hcp = await api.healthcarePartyApi.getCurrentHealthcareParty()
	if (!hcp) {
		console.error('You are not logged in')
		return
	}
	let parsedInput
	try {
		parsedInput = parser.parse(input, { hcpId: hcp.parentId || hcp.id })
	} catch (e: unknown) {
		const err = e as PeggyParseError
		err.location &&
			err.location.start.column &&
			log(' '.repeat(err.location.start.column + 14) + pc.red('↑'))
		log(
			pc.red(
				`Cannot parse : ${
					err.location !== undefined
						? 'Line ' +
							err.location.start.line +
							', column ' +
							err.location.start.column +
							': ' +
							err.message
						: err.message
				}`,
			),
		)
		return
	}
	if (debug) console.log('Filter pre-rewriting: ' + JSON.stringify(parsedInput))

	const vars: Record<string, string | number> = {}
	forEachDeep(parsedInput, (obj) => {
		if (isObject(obj)) {
			const node = obj as Record<string, unknown>
			if (typeof node.variable === 'string' && node.variable.startsWith('$')) {
				vars[node.variable.slice(1)] = ''
			}
		}
	})

	await Object.keys(vars).reduce(async (p, v) => {
		await p
		if (existingVariables.has(v)) {
			vars[v] = convertVariable(existingVariables.get(v) || '')
		} else {
			vars[v] = convertVariable(await question(`${v} : `))
		}
		console.log(vars[v])
	}, Promise.resolve())

	const finalResult = await filter(
		mapDeep(parsedInput, (obj) => {
			if (isObject(obj)) {
				const node = obj as Record<string, unknown>
				if (typeof node.variable === 'string' && node.variable.startsWith('$')) {
					return vars[node.variable.slice(1)]
				}
			}
			return obj
		}),
		api,
		hcpartyId,
		debug,
		deferPolicy,
	)

	if (exportPath && finalResult.rows) {
		exportPath.endsWith('.xls') || exportPath.endsWith('.xlsx')
			? writeExcel(
					finalResult.rows as Array<Record<string, unknown>>,
					exportPath.replace(/\.xls$/, '.xlsx'),
				)
			: fs.writeFileSync(exportPath, JSON.stringify(finalResult.rows, undefined, ' '))
	}

	log(inspect(finalResult.rows, { colors: true, depth: null }))
	const stop = +new Date()
	log(`${(finalResult.rows || []).length} items returned in ${stop - start} ms`)
}

function parseDeferFlag(args: string[]): {
	remaining: string[]
	deferPolicy?: DeferralPolicy
} {
	const idx = args.indexOf('--defer')
	if (idx === -1) return { remaining: args }
	if (idx + 1 >= args.length) {
		log(
			pc.red(
				'--defer requires a comma-separated list of policies: active,gender,age,all-patients',
			),
		)
		return { remaining: args.filter((_, i) => i !== idx) }
	}
	const policyNames = args[idx + 1].split(',')
	const remaining = args.filter((_, i) => i !== idx && i !== idx + 1)
	return { remaining, deferPolicy: composePolicies(policyNames) }
}

async function cmdQuery(args: string[]) {
	const { remaining, deferPolicy } = parseDeferFlag(args)
	const input = remaining.join(' ')
	if (!input) {
		log(pc.red('Usage: query [--defer active,gender,age] <expression>'))
		return
	}
	log('Parsing query: ' + input)
	latestQuery = input
	await executeInput(input, undefined, deferPolicy)
}

async function cmdExport(args: string[]) {
	const { remaining, deferPolicy } = parseDeferFlag(args)
	const [exportPath, ...rest] = remaining
	if (!exportPath || rest.length === 0) {
		log(pc.red('Usage: export [--defer active,gender,age] <path> <expression>'))
		return
	}
	const input = rest.join(' ')
	log('Parsing query: ' + input)
	latestQuery = input
	await executeInput(input, exportPath, deferPolicy)
}

async function cmdSave(args: string[]) {
	const [name, description, ...rest] = args
	if (!name || !description) {
		log(pc.red('Usage: save <name> <description> [expression]'))
		return
	}
	const input = (rest.length > 0 && rest.join(' ')) || latestQuery
	if (!input) {
		log(pc.red('No query to save. Run a query first or provide one.'))
		return
	}

	if (options.repoHost) {
		const existing = (await (
			await fetch(`${options.repoHost}/${name}`, {
				method: 'GET',
				headers: options.repoHeader,
				redirect: 'follow',
			})
		).json()) as RepoDocument
		if (existing.error) {
			await fetch(`${options.repoHost}/${name}`, {
				method: 'PUT',
				headers: options.repoHeader,
				redirect: 'follow',
				body: JSON.stringify(
					Object.assign(
						{ _id: name, description, query: input },
						existing ? { _rev: existing._rev } : {},
					),
				),
			})
		} else {
			const answer = await question(
				`${name} already exists, do you want to overwrite it ? (y/n) `,
			)
			if (answer.toLowerCase().startsWith('y')) {
				await fetch(`${options.repoHost}/${name}`, {
					method: 'PUT',
					headers: options.repoHeader,
					redirect: 'follow',
					body: JSON.stringify(
						Object.assign(
							{ _id: name, description, query: input },
							existing ? { _rev: existing._rev } : {},
						),
					),
				})
			}
		}
	} else {
		log(pc.red('You are not logged to the repository. Use repo command first.'))
	}
}

async function cmdLs() {
	if (options.repoHost) {
		const existing = (await (
			await fetch(`${options.repoHost}/_all_docs`, {
				method: 'GET',
				headers: options.repoHeader,
				redirect: 'follow',
			})
		).json()) as RepoAllDocsResponse
		if (existing && existing.rows) {
			log(pc.yellow(existing.rows.map((r) => r.id).join('\n')))
		}
	} else {
		log(pc.red('You are not logged to the repository. Use repo command first.'))
	}
}

async function cmdLoadexec(args: string[]) {
	const [name] = args
	if (!name) {
		log(pc.red('Usage: loadexec <name>'))
		return
	}
	if (options.repoHost) {
		const existing = (await (
			await fetch(`${options.repoHost}/${name}`, {
				method: 'GET',
				headers: options.repoHeader,
				redirect: 'follow',
			})
		).json()) as RepoDocument
		if (existing && existing.query) {
			await executeInput(existing.query)
		}
	} else {
		log(pc.red('You are not logged to the repository. Use repo command first.'))
	}
}

async function cmdLoadexport(args: string[]) {
	const [name, exportPath] = args
	if (!name || !exportPath) {
		log(pc.red('Usage: loadexport <name> <path>'))
		return
	}
	if (options.repoHost) {
		const existing = (await (
			await fetch(`${options.repoHost}/${name}`, {
				method: 'GET',
				headers: options.repoHeader,
				redirect: 'follow',
			})
		).json()) as RepoDocument
		if (existing && existing.query) {
			await executeInput(existing.query, exportPath)
		}
	} else {
		log(pc.red('You are not logged to the repository. Use repo command first.'))
	}
}

async function cmdWhoami() {
	log((await api.userApi.getCurrentUser()).login + '@' + options.host)
}

function cmdEx() {
	log("query 'PAT[age<2y]'")
	log("query 'PAT[age<50y & gender == male] | count'")
	log("query 'PAT[age>50y] | min(dateOfBirth)'")
	log("query 'PAT[age>75y - gender == female] | select(firstName, lastName, gender)'")
	log("query 'SVC[ICPC == T89 & :CD-ITEM == diagnosis]'")
	log(
		"query 'PAT[(age>45y & SVC[ICPC == T89 & :CD-ITEM == diagnosis]) - SVC[LOINC == Hba1c & :CD-ITEM == diagnosis]]'",
	)
	log(
		"query 'PAT[age>25y & age<26y - SVC[CISP == X75{19500101 -> 20000101} & :CD-ITEM == diagnosis]]'",
	)
	log(
		"query 'PAT[age>25y & age<26y - (SVC[CISP == X75{<3y} & :CD-ITEM == diagnosis] | HE[CISP == X75{<3y}]) - SVC[CISP == X37.002] - SVC[CISP == X37.003]]'",
	)
	log(
		"query 'PAT[age>45y & SVC[ICPC == T89{>6m} & :CD-ITEM == diagnosis | ICPC == T90{<2y} & :CD-ITEM == diagnosis]] | select(lastName)'",
	)
}

function cmdGrammar() {
	const g = fs.readFileSync(
		path.resolve(__dirname, '../grammar/icure-reporting-parser.peggy'),
		'utf8',
	)
	log(g)
}

function cmdVar(args: string[]) {
	const input = args.join(' ').replace(/'/g, '')
	const elements = input.split(';')
	elements.forEach((element) => {
		if (element.trim().length > 0) {
			const cut = element.trim().split('=')
			if (cut.length === 2) {
				const variable = cut[0].trim()
				const value = cut[1].trim()
				log(`Setting variable $${variable} to ${value}`)
				existingVariables.set(variable, value)
			} else {
				log('Invalid element: ' + element)
			}
		}
	})
}

function cmdVariables() {
	const output = Array.from(existingVariables).map(([key, value]) => key + '=' + value)
	log('var ' + output.join(';'))
}

function printHelp() {
	log('Available commands:')
	log('  login <username> <password> [host]  Login to iCure')
	log('  repo <username> <password> [host]   Login to Queries repository')
	log('  pki <hcpId> <key>                   Private Key Import')
	log('  lpkis                               List Private Keys')
	log('  query <expression>                  Query iCure')
	log('  export <path> <expression>          Export query results to file (.xls(x) or .json)')
	log('  save <name> <desc> [expression]     Save query to repository')
	log('  ls                                  List queries on repository server')
	log('  loadexec <name>                     Load and execute query from repository')
	log('  loadexport <name> <path>            Load, execute and export query from repository')
	log('  whoami                              Logged user info')
	log('  ex                                  Show example queries')
	log('  grammar                             Print the query grammar')
	log('  var <input>                         Set a variable, e.g. var x = 5y')
	log('  variables                           Print existing variables')
	log('  help                                Show this help')
	log('  exit                                Exit the application')
}

// --- Command dispatch ---

const commands: Record<string, (args: string[]) => Promise<void> | void> = {
	repo: cmdRepo,
	login: cmdLogin,
	pki: cmdPki,
	lpkis: () => cmdLpkis(),
	query: cmdQuery,
	export: cmdExport,
	save: cmdSave,
	ls: () => cmdLs(),
	loadexec: cmdLoadexec,
	loadexport: cmdLoadexport,
	whoami: () => cmdWhoami(),
	ex: () => cmdEx(),
	grammar: () => cmdGrammar(),
	var: cmdVar,
	variables: () => cmdVariables(),
	help: () => printHelp(),
}

function parseCommandLine(line: string): { command: string; args: string[] } {
	const trimmed = line.trim()
	if (!trimmed) return { command: '', args: [] }

	// Handle quoted arguments (single and double quotes)
	const parts: string[] = []
	let current = ''
	let inSingle = false
	let inDouble = false

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i]
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle
		} else if (ch === '"' && !inSingle) {
			inDouble = !inDouble
		} else if (ch === ' ' && !inSingle && !inDouble) {
			if (current) {
				parts.push(current)
				current = ''
			}
		} else {
			current += ch
		}
	}
	if (current) parts.push(current)

	const [command, ...args] = parts
	return { command: command.toLowerCase(), args }
}

async function main() {
	rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
		history: [],
		terminal: true,
	})

	printHelp()
	log('')

	while (true) {
		let line: string
		try {
			line = await rl.question('icure-reporting$ ')
		} catch {
			// EOF or closed
			break
		}

		const { command, args } = parseCommandLine(line)
		if (!command) continue
		if (command === 'exit' || command === 'quit') break

		const handler = commands[command]
		if (!handler) {
			log(pc.red(`Unknown command: ${command}. Type 'help' for available commands.`))
			continue
		}

		try {
			await handler(args)
		} catch (e) {
			console.error('Unexpected error', e)
		}
	}

	rl.close()
	process.exit(0)
}

main()
