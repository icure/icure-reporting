/* eslint-disable @typescript-eslint/no-var-requires */
// noinspection RequiredAttributes

import fetch from 'node-fetch'
import { User, Api, hex2ua } from '@icure/api'
import { crypto } from '@icure/api/node-compat'

import { forEachDeep, mapDeep } from './reduceDeep'
import { isObject } from 'lodash'
import * as Peg from 'pegjs'
import { format, addMonths, addYears } from 'date-fns'

import * as colors from 'colors/safe'
import { Args, CommandInstance } from 'vorpal'
import { filter } from './filters'
import { writeExcel } from './xls'

require('node-json-color-stringify')

const path = require('path')
const fs = require('fs')
const vorpal = new (require('vorpal'))()

// TODO use a logger
// TODO patient merges
// TODO more examples, with invoices/health elements/contacts, at first level

const debug = false
const tmp = require('os').tmpdir()
if (debug) {
	console.log('Tmp dir: ' + tmp)
}
;(global as any).localStorage = new (require('node-localstorage').LocalStorage)(
	tmp,
	5 * 1024 * 1024 * 1024
)
;(global as any).Storage = ''

const options = {
	username: '',
	password: '',
	host: 'https://backendb.svc.icure.cloud/rest/v1',
	repoUsername: null,
	repoPassword: null,
	repoHost: null,
	repoHeader: {},
}

let {
	healthcarePartyApi,
	cryptoApi,
	userApi,
	healthcareElementApi,
	invoiceApi,
	patientApi,
	contactApi,
} = Api(options.host, options.username, options.password, crypto)
let hcpartyId = ''
let latestQuery: string | null = null
const existingVariables = new Map<string, string>()

const grammar = fs.readFileSync(
	path.resolve(__dirname, '../grammar/icure-reporting-parser.pegjs'),
	'utf8'
)
const parser = Peg.generate(grammar)

healthcarePartyApi.getCurrentHealthcareParty().then((hcp) => {
	hcpartyId = hcp.id
	if (hcp.id === '782f1bcd-9f3f-408a-af1b-cd9f3f908a98') {
		const privateKey =
			''
		cryptoApi
			.loadKeyPairsAsTextInBrowserLocalStorage(hcpartyId, hex2ua(privateKey))
			.catch((error) => {
				console.error('Error: in loadKeyPairsAsTextInBrowserLocalStorage')
				console.error(error)
			})
	}
})

vorpal
	.command('repo <username> <password> [host]', 'Login to Queries repository')
	.action(async function (this: CommandInstance, args: Args) {
		args.host && (options.repoHost = args.host)
		options.repoHeader = {
			Authorization: `Basic ${Buffer.from(`${args.username}:${args.password}`).toString(
				'base64'
			)}`,
		}
	})

vorpal
	.command('login <username> <password> [host]', 'Login to iCure')
	.action(async function (this: CommandInstance, args: Args) {
		options.username = args.username
		options.password = args.password
		args.host && (options.host = args.host)
		;({
			healthcarePartyApi,
			cryptoApi,
			userApi,
			healthcareElementApi,
			invoiceApi,
			patientApi,
			contactApi,
		} = Api(options.host, options.username, options.password, crypto))
		healthcarePartyApi.getCurrentHealthcareParty().then((hcp) => {
			hcpartyId = hcp.id
		})
	})

vorpal
	.command('pki <hcpId> <key>', 'Private Key Import')
	.action(async function (this: CommandInstance, args: Args) {
		const hcpId = args.hcpId
		const key = args.key

		await cryptoApi.loadKeyPairsAsTextInBrowserLocalStorage(hcpId, hex2ua(key))
		if (
			await cryptoApi.checkPrivateKeyValidity(
				await healthcarePartyApi.getHealthcareParty(hcpId)
			)
		) {
			this.log('Key is valid')
		} else {
			this.log('Key is invalid')
		}
	})

vorpal.command('lpkis', 'List Private Keys').action(async function (this: CommandInstance) {
	const users = (await userApi.listUsers(undefined, undefined, undefined))?.rows || []
	await users.reduce(async (p: Promise<any>, u: User) => {
		await p
		if (u.healthcarePartyId) {
			const hcp = await healthcarePartyApi.getHealthcareParty(u.healthcarePartyId)
			try {
				if (hcp.publicKey && (await cryptoApi.checkPrivateKeyValidity(hcp))) {
					this.log(`${colors.green('√')} ${hcp.id}: ${hcp.firstName} ${hcp.lastName}`)
				} else {
					this.log(`${colors.red('X')} ${hcp.id}: ${hcp.firstName} ${hcp.lastName}`)
				}
			} catch (e) {
				this.log(`X ${hcp.id}: ${hcp.firstName} ${hcp.lastName}`)
			}
		}
	}, Promise.resolve())
})

function convertVariable(text: string): number | string {
	if (text.endsWith('m')) {
		return Number(
			format(addMonths(new Date(), -Number(text.substr(0, text.length - 1))), 'yyyyMMdd')
		)
	} else if (text.endsWith('y')) {
		return Number(
			format(addYears(new Date(), -Number(text.substr(0, text.length - 1))), 'yyyyMMdd')
		)
	}
	return text
}

async function executeInput(cmd: CommandInstance, input: string, path?: string) {
	const start = +new Date()
	const hcp = await healthcarePartyApi.getCurrentHealthcareParty()
	if (!hcp) {
		console.error('You are not logged in')
		return
	}
	let parsedInput
	try {
		parsedInput = parser.parse(input, { hcpId: hcp.parentId || hcp.id })
	} catch (e) {
		e.location &&
			e.location.start.column &&
			cmd.log(' '.repeat(e.location.start.column + 14) + colors.red('↑'))
		cmd.log(
			colors.red(
				`Cannot parse : ${
					e.location !== undefined
						? 'Line ' +
						  e.location.start.line +
						  ', column ' +
						  e.location.start.column +
						  ': ' +
						  e.message
						: e.message
				}`
			)
		)
		return
	}
	if (debug) console.log('Filter pre-rewriting: ' + JSON.stringify(parsedInput))

	const vars: { [index: string]: any } = {}
	forEachDeep(parsedInput, (obj) => {
		if (
			isObject(obj) &&
			(obj as any).variable &&
			(obj as any).variable.startsWith &&
			(obj as any).variable.startsWith('$')
		) {
			vars[(obj as any).variable.substr(1)] = ''
		}
	})

	await Object.keys(vars).reduce(async (p, v) => {
		await p
		if (existingVariables.has(v)) {
			vars[v] = convertVariable(existingVariables.get(v) || '')
		} else {
			vars[v] = convertVariable(
				(await cmd.prompt({ type: 'input', message: `${v} : `, name: 'value' })).value
			)
		}
		console.log(vars[v])
	}, Promise.resolve())

	const finalResult = await filter(
		mapDeep(parsedInput, (obj) =>
			isObject(obj) &&
			(obj as any).variable &&
			(obj as any).variable.startsWith &&
			(obj as any).variable.startsWith('$')
				? vars[(obj as any).variable.substr(1)]
				: obj
		),
		{
			healthcarePartyApi,
			cryptoApi,
			userApi,
			contactApi,
			healthcareElementApi,
			invoiceApi,
			patientApi,
		},
		hcpartyId,
		debug
	)

	if (path && finalResult.rows) {
		path.endsWith('.xls') || path.endsWith('.xlsx')
			? writeExcel(finalResult.rows, path.replace(/\.xls$/, '.xlsx'))
			: fs.writeFileSync(path, JSON.stringify(finalResult.rows, undefined, ' '))
	}

	cmd.log((JSON as any).colorStringify(finalResult.rows, null, '\t'))
	const stop = +new Date()
	cmd.log(`${(finalResult.rows || []).length} items returned in ${stop - start} ms`)
}

vorpal
	.command(
		'query [input...]',
		'Query iCure. A query typically has the PAT[...] structure. Complex queries should be enclosed between single quotes. Variable ($var) can be used instead of values.'
	)
	.action(async function (this: CommandInstance, args: Args) {
		try {
			const input = args.input.join(' ')
			this.log('Parsing query: ' + input)
			latestQuery = input

			await executeInput(this, input)
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal
	.command('export <path> [input...]', 'Export executed query to file (.xls(x) or .json)')
	.action(async function (this: CommandInstance, args: Args) {
		try {
			const input = args.input.join(' ')
			this.log('Parsing query: ' + input)
			latestQuery = input

			await executeInput(this, input, args.path)
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal
	.command(
		'save <name> <description> [input...]',
		'Save iCure query to queries repository. In case no query is provided the latest executed query is saved.'
	)
	.action(async function (this: CommandInstance, args: Args) {
		try {
			const input = (args.input && args.input.length && args.input.join(' ')) || latestQuery

			if (options.repoHost) {
				const existing: any = await (
					await fetch(`${options.repoHost}/${args.name}`, {
						method: 'GET',
						headers: options.repoHeader,
						redirect: 'follow',
					})
				).json()
				if (
					existing.error ||
					(
						await this.prompt({
							type: 'confirm',
							message: `${args.name} already exists, do you want to overwrite it ?`,
							name: 'confirmation',
						})
					).confirmation
				) {
					await fetch(`${options.repoHost}/${args.name}`, {
						method: 'PUT',
						headers: options.repoHeader,
						redirect: 'follow',
						body: JSON.stringify(
							Object.assign(
								{ _id: args.name, description: args.description, query: input },
								existing ? { _rev: existing._rev } : {}
							)
						),
					})
				}
			} else {
				this.log(
					colors.red('You are not logged to the repository. Use repo command first.')
				)
			}
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal
	.command('ls', 'List iCure queries on repository server')
	.action(async function (this: CommandInstance) {
		try {
			if (options.repoHost) {
				const existing: any = await (
					await fetch(`${options.repoHost}/_all_docs`, {
						method: 'GET',
						headers: options.repoHeader,
						redirect: 'follow',
					})
				).json()
				if (existing && existing.rows) {
					this.log(colors.yellow(existing.rows.map((r: any) => r.id).join('\n')))
				}
			} else {
				this.log(
					colors.red('You are not logged to the repository. Use repo command first.')
				)
			}
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal
	.command('loadexec <name>', 'Load and execute iCure query from repository server')
	.autocomplete({
		data: () =>
			!options.repoHost
				? Promise.resolve([])
				: fetch(`${options.repoHost}/_all_docs`, {
						method: 'GET',
						headers: options.repoHeader,
						redirect: 'follow',
				  })
						.then((res) => res.json())
						.then((commands) => {
							return commands.rows.map((r: any) => r.id)
						}),
	})
	.action(async function (this: CommandInstance, args: Args) {
		try {
			if (options.repoHost) {
				const existing: any = await (
					await fetch(`${options.repoHost}/${args.name}`, {
						method: 'GET',
						headers: options.repoHeader,
						redirect: 'follow',
					})
				).json()
				if (existing && existing.query) {
					await executeInput(this, existing.query)
				}
			} else {
				this.log(
					colors.red('You are not logged to the repository. Use repo command first.')
				)
			}
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal
	.command(
		'loadexport <name> <path>',
		'Load, execute and export to file (.xls(x) or .json) iCure query from repository server'
	)
	.autocomplete({
		data: () =>
			!options.repoHost
				? Promise.resolve([])
				: fetch(`${options.repoHost}/_all_docs`, {
						method: 'GET',
						headers: options.repoHeader,
						redirect: 'follow',
				  })
						.then((res) => res.json())
						.then((commands) => {
							return commands.rows.map((r: any) => r.id)
						}),
	})
	.action(async function (this: CommandInstance, args: Args) {
		try {
			if (options.repoHost) {
				const existing: any = await (
					await fetch(`${options.repoHost}/${args.name}`, {
						method: 'GET',
						headers: options.repoHeader,
						redirect: 'follow',
					})
				).json()
				if (existing && existing.query) {
					await executeInput(this, existing.query, args.path)
				}
			} else {
				this.log(
					colors.red('You are not logged to the repository. Use repo command first.')
				)
			}
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal.command('whoami', 'Logged user info').action(async function (this: CommandInstance) {
	this.log((await userApi.getCurrentUser()).login + '@' + options.host)
})

// TODO PAT[] (no condition) ?
// TODO PAT[age == 15] ? (maybe useless)
// TODO | max(dateOfBirth) -> select name? who is the oldest patient?
vorpal.command('ex', 'Show example queries').action(async function (this: CommandInstance) {
	this.log("query 'PAT[age<2y]'")
	this.log("query 'PAT[age<50y & gender == male] | count'")
	this.log("query 'PAT[age>50y] | min(dateOfBirth)'")
	this.log("query 'PAT[age>75y - gender == female] | select(firstName, lastName, gender)'")
	this.log("query 'SVC[ICPC == T89 & :CD-ITEM == diagnosis]'")
	this.log(
		"query 'PAT[(age>45y & SVC[ICPC == T89 & :CD-ITEM == diagnosis]) - SVC[LOINC == Hba1c & :CD-ITEM == diagnosis]]'"
	)
	this.log(
		"query 'PAT[age>25y & age<26y - SVC[CISP == X75{19500101 -> 20000101} & :CD-ITEM == diagnosis]]'"
	)
	this.log(
		"query 'PAT[age>25y & age<26y - (SVC[CISP == X75{<3y} & :CD-ITEM == diagnosis] | HE[CISP == X75{<3y}]) - SVC[CISP == X37.002] - SVC[CISP == X37.003]]'"
	)
	this.log(
		"query 'PAT[age>45y & SVC[ICPC == T89{>6m} & :CD-ITEM == diagnosis | ICPC == T90{<2y} & :CD-ITEM == diagnosis]] | select(lastName)'"
	)
})

vorpal
	.command('grammar', 'Print the grammar used to parse queries')
	.action(async function (this: CommandInstance) {
		const grammar = fs.readFileSync(
			path.resolve(__dirname, '../grammar/icure-reporting-parser.pegjs'),
			'utf8'
		)
		this.log(grammar)
	})

vorpal
	.command('var [input...]', 'Set a variable, e.g. var x = 5y')
	.action(async function (this: CommandInstance, args: Args) {
		const input: string = args.input.join(' ').replace(/'/g, '') // remove single quotes as a workaround to a vorpal bug
		const elements = input.split(';')
		elements.forEach((element) => {
			if (element.trim().length > 0) {
				const cut = element.trim().split('=')
				if (cut.length === 2) {
					const variable = cut[0].trim()
					const value = cut[1].trim()
					this.log(`Setting variable $${variable} to ${value}`)
					existingVariables.set(variable, value)
				} else {
					this.log('Invalid element: ' + element)
				}
			}
		})
	})

vorpal
	.command('variables', 'Print existing variables')
	.action(async function (this: CommandInstance) {
		const output = Array.from(existingVariables).map(([key, value]) => key + '=' + value)
		this.log('var ' + output.join(';'))
	})

vorpal.delimiter('icure-reporting$').history('icrprt').show()