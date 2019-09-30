import fetch from 'node-fetch'
import {
	UserDto
} from 'icc-api'
import { forEachDeep, mapDeep } from './reduceDeep'
import { isObject } from 'lodash'
import * as Peg from 'pegjs'
import { Api } from './api'
import { format, addMonths, addYears } from 'date-fns'

import * as colors from 'colors/safe'
import { Args, CommandInstance } from 'vorpal'
import { filter } from './filters'

require('node-json-color-stringify')

const path = require('path')
const fs = require('fs')
const vorpal = new (require('vorpal'))()

// TODO use a logger
// TODO patient merges
// add filter for sex: male, female, unknown

const tmp = require('os').tmpdir()
console.log('Tmp dir: ' + tmp)
;(global as any).localStorage = new (require('node-localstorage').LocalStorage)(tmp, 5 * 1024 * 1024 * 1024)
;(global as any).Storage = ''

const options = {
	username: '',
	password: '',
	host: 'https://backendb.svc.icure.cloud/rest/v1',
	repoUsername: null,
	repoPassword: null,
	repoHost: null,
	repoHeader: {}
}

let api = new Api(options.host, { Authorization: `Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}` }, fetch as any)
let hcpartyId: string = ''
let latestQuery: string | null = null

const grammar = fs.readFileSync(path.resolve(__dirname, '../icure-reporting.pegjs'), 'utf8')
const parser = Peg.generate(grammar)

api.hcpartyicc.getCurrentHealthcareParty().then(hcp => {
	hcpartyId = hcp.id
	if (hcp.id === '782f1bcd-9f3f-408a-af1b-cd9f3f908a98') {
		const privateKey = ''
		api.cryptoicc.loadKeyPairsAsTextInBrowserLocalStorage(hcpartyId, api.cryptoicc.utils.hex2ua(privateKey))
			.catch(error => {
				console.error('Error: in loadKeyPairsAsTextInBrowserLocalStorage')
				console.error(error)
			})
	}
})

vorpal
	.command('repo <username> <password> [host]', 'Login to Queries repository')
	.action(async function(this: CommandInstance, args: Args) {
		args.host && (options.repoHost = args.host)
		options.repoHeader = { Authorization: `Basic ${Buffer.from(`${args.username}:${args.password}`).toString('base64')}` }
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
		return Number(format(addMonths(new Date(), -Number(text.substr(0, text.length - 1))), 'yyyyMMdd'))
	} else if (text.endsWith('y')) {
		return Number(format(addYears(new Date(), -Number(text.substr(0, text.length - 1))), 'yyyyMMdd'))
	}
	return text
}

async function executeInput(cmd: CommandInstance, input: string) {
	const start = +new Date()
	const hcp = await api.hcpartyicc.getCurrentHealthcareParty()
	if (!hcp) {
		console.error('You are not logged in')
		return
	}
	let parsedInput
	try {
		parsedInput = parser.parse(input, { hcpId: hcp.parentId || hcp.id })
	} catch (e) {
		e.location && e.location.start.column && cmd.log(' '.repeat(e.location.start.column + 14) + colors.red('↑'))
		cmd.log(colors.red(`Cannot parse : ${e.location !== undefined
			? 'Line ' + e.location.start.line + ', column ' + e.location.start.column + ': ' + e.message
			: e.message}`))
		return
	}
	console.log('Filter pre-rewriting: ' + JSON.stringify(parsedInput))

	const vars: { [index: string]: any } = {}
	forEachDeep(parsedInput, (obj, parent, idx) => {
		if (isObject(obj) && (obj as any).variable && (obj as any).variable.startsWith && (obj as any).variable.startsWith('$')) {
			vars[(obj as any).variable.substr(1)] = ''
		}
	})

	await Object.keys(vars).reduce(async (p, v) => {
		await p
		vars[v] = convertVariable((await cmd.prompt({ type: 'input', 'message': `${v} : `, 'name': 'value' })).value)
	}, Promise.resolve())

	const finalResult = await filter(
		mapDeep(parsedInput, (obj) => (isObject(obj) && (obj as any).variable && (obj as any).variable.startsWith && (obj as any).variable.startsWith('$')) ? vars[(obj as any).variable.substr(1)] : obj),
		api,
		hcpartyId,
		false
	)
	cmd.log((JSON as any).colorStringify(finalResult.rows, null, '\t'))
	const stop = +new Date()
	cmd.log(`${(finalResult.rows || []).length} items returned in ${stop - start} ms`)
}

vorpal
	.command('query [input...]', 'Queries iCure')
	.action(async function(this: CommandInstance, args: Args) {
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
	.command('save <name> <description> [input...]', 'Save iCure query')
	.action(async function(this: CommandInstance, args: Args) {
		try {
			const input = args.input && args.input.length && args.input.join(' ') || latestQuery

			if (options.repoHost) {
				const existing: any = await (await fetch(`${options.repoHost}/${args.name}`, {
					method: 'GET',
					headers: options.repoHeader,
					redirect: 'follow'
				})).json()
				if (existing.error || (await this.prompt({ type: 'confirm', 'message': `${args.name} already exists, do you want to overwrite it ?`, 'name': 'confirmation' })).confirmation) {
					(await fetch(`${options.repoHost}/${args.name}`, {
						method: 'PUT',
						headers: options.repoHeader,
						redirect: 'follow',
						body: JSON.stringify(Object.assign({ _id: args.name, description: args.description, query: input }, existing ? { _rev: existing._rev } : {}))
					}))
				}
			} else {
				this.log(colors.red('You are not logged to the repository. Use repo command first.'))
			}
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal
	.command('ls', 'Load iCure query')
	.action(async function(this: CommandInstance, args: Args) {
		try {
			if (options.repoHost) {
				const existing: any = await (await fetch(`${options.repoHost}/_all_docs`, {
					method: 'GET',
					headers: options.repoHeader,
					redirect: 'follow'
				})).json()
				if (existing && existing.rows) {
					this.log(colors.yellow(existing.rows.map((r: any) => r.id).join('\n')))
				}
			} else {
				this.log(colors.red('You are not logged to the repository. Use repo command first.'))
			}
		} catch (e) {
			console.error('Unexpected error', e)
		}
	})

vorpal
	.command('load <name>', 'Load iCure query')
	.autocomplete({
		data: () => !options.repoHost ? Promise.resolve([]) : fetch(`${options.repoHost}/_all_docs`, {
			method: 'GET',
			headers: options.repoHeader,
			redirect: 'follow'
		}).then(res => res.json()).then(commands => {
			return commands.rows.map((r: any) => r.id)
		})
	}).action(async function(this: CommandInstance, args: Args) {
		try {
			if (options.repoHost) {
				const existing: any = await (await fetch(`${options.repoHost}/${args.name}`, {
					method: 'GET',
					headers: options.repoHeader,
					redirect: 'follow'
				})).json()
				if (existing && existing.query) {
					await executeInput(this, existing.query)
				}
			} else {
				this.log(colors.red('You are not logged to the repository. Use repo command first.'))
			}
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
		this.log('PAT[age>25y & age<26y - SVC[CISP == X75{19000101 -> 20200101} & :CD-ITEM == diagnosis] - SVC[CISP == X37.002] - SVC[CISP == X37.003]]')
		this.log('PAT[age>25y & age<26y - (SVC[CISP == X75{<3y} & :CD-ITEM == diagnosis] | HE[CISP == X75 | HE[CISP == X75]]) - SVC[CISP == X37.002] - SVC[CISP == X37.003]]')
		this.log('PAT[age>45y & SVC[ICPC == T89{>1m} & :CD-ITEM == diagnosis | ICPC == T90] - SVC[ICPC == T90]]')
	})

vorpal
	.delimiter('icure-reporting$')
	.history('icrprt')
	.show()