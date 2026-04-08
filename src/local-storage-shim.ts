import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import type { StorageFacade } from '@icure/api/icc-x-api/storage/StorageFacade'
import type { KeyStorageFacade } from '@icure/api/icc-x-api/storage/KeyStorageFacade'

const localStorageDir = path.join(os.tmpdir(), '.icure-localstorage')

function ensureDir() {
	fs.mkdirSync(localStorageDir, { recursive: true })
}

function filePath(key: string): string {
	return path.join(localStorageDir, encodeURIComponent(key))
}

export class FileStorageFacade implements StorageFacade<string> {
	constructor() {
		ensureDir()
	}

	async getItem(key: string): Promise<string | undefined> {
		try {
			return fs.readFileSync(filePath(key), 'utf8')
		} catch {
			return undefined
		}
	}

	async setItem(key: string, value: string): Promise<void> {
		ensureDir()
		fs.writeFileSync(filePath(key), value)
	}

	async removeItem(key: string): Promise<void> {
		try {
			fs.unlinkSync(filePath(key))
		} catch {
			// ignore
		}
	}
}

export class FileKeyStorageFacade implements KeyStorageFacade {
	private storage = new FileStorageFacade()

	private keyPrefix(key: string, suffix: string): string {
		return `keypair.${key}.${suffix}`
	}

	async getPublicKey(key: string): Promise<JsonWebKey | undefined> {
		const raw = await this.storage.getItem(this.keyPrefix(key, 'pub'))
		return raw ? JSON.parse(raw) : undefined
	}

	async getPrivateKey(key: string): Promise<JsonWebKey | undefined> {
		const raw = await this.storage.getItem(this.keyPrefix(key, 'priv'))
		return raw ? JSON.parse(raw) : undefined
	}

	async getKeypair(
		key: string,
	): Promise<{ publicKey: JsonWebKey; privateKey: JsonWebKey } | undefined> {
		const [publicKey, privateKey] = await Promise.all([
			this.getPublicKey(key),
			this.getPrivateKey(key),
		])
		if (publicKey && privateKey) return { publicKey, privateKey }
		return undefined
	}

	async deleteKeypair(key: string): Promise<void> {
		await Promise.all([
			this.storage.removeItem(this.keyPrefix(key, 'pub')),
			this.storage.removeItem(this.keyPrefix(key, 'priv')),
		])
	}

	async storeKeyPair(
		key: string,
		keyPair: { publicKey: JsonWebKey; privateKey: JsonWebKey },
	): Promise<void> {
		await Promise.all([
			this.storage.setItem(this.keyPrefix(key, 'pub'), JSON.stringify(keyPair.publicKey)),
			this.storage.setItem(this.keyPrefix(key, 'priv'), JSON.stringify(keyPair.privateKey)),
		])
	}

	async storePublicKey(key: string, publicKey: JsonWebKey): Promise<void> {
		await this.storage.setItem(this.keyPrefix(key, 'pub'), JSON.stringify(publicKey))
	}

	async storePrivateKey(key: string, privateKey: JsonWebKey): Promise<void> {
		await this.storage.setItem(this.keyPrefix(key, 'priv'), JSON.stringify(privateKey))
	}
}
