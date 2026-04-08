import type { CryptoStrategies } from '@icure/api/icc-x-api/crypto/CryptoStrategies'
import type { CryptoActorStubWithType } from '@icure/api/icc-api/model/CryptoActorStub'
import { type KeyPair, ShaVersion } from '@icure/api/icc-x-api/crypto/RSA'

/** In-memory store of imported key pairs, keyed by data owner ID. */
export type KeyMap = Map<string, { publicKey: JsonWebKey; privateKey: JsonWebKey }>

/**
 * Creates CryptoStrategies for the reporting CLI that recover unavailable keys from an in-memory map.
 * - Recovers private keys from the provided keyMap
 * - Trusts all delegate public keys (this is a read-only reporting tool)
 * - Patients require anonymous delegations
 */
export function createCryptoStrategies(keyMap: KeyMap): CryptoStrategies {
	return {
		async recoverAndVerifySelfHierarchyKeys(keysData, cryptoPrimitives) {
			const result: {
				[dataOwnerId: string]: {
					recoveredKeys: { [keyPairFingerprint: string]: KeyPair<CryptoKey> }
					keyAuthenticity: { [keyPairFingerprint: string]: boolean }
				}
			} = {}
			for (const { dataOwner, unknownKeys, unavailableKeys } of keysData) {
				const keyAuthenticity: { [fp: string]: boolean } = {}
				for (const key of unknownKeys) {
					keyAuthenticity[key] = true
				}

				const recoveredKeys: { [keyPairFingerprint: string]: KeyPair<CryptoKey> } = {}
				if (unavailableKeys.length > 0) {
					const storedPair = keyMap.get(dataOwner.dataOwner.id!)
					if (storedPair) {
						const keyPair = await cryptoPrimitives.RSA.importKeyPair(
							'jwk',
							storedPair.privateKey,
							'jwk',
							storedPair.publicKey,
							ShaVersion.Sha256,
						)
						// Export public key to SPKI hex to compute fingerprint
						const publicKeySpkiBuf = await cryptoPrimitives.RSA.exportKeys(
							keyPair,
							'pkcs8',
							'spki',
						)
						const spkiHex = Array.from(
							new Uint8Array(publicKeySpkiBuf.publicKey as ArrayBuffer),
						)
							.map((b) => b.toString(16).padStart(2, '0'))
							.join('')
						const fingerprint = spkiHex.slice(-32)

						if (unavailableKeys.some((k) => k.slice(-32) === fingerprint)) {
							recoveredKeys[fingerprint] = keyPair
							keyAuthenticity[fingerprint] = true
						}
					}
				}

				result[dataOwner.dataOwner.id!] = {
					recoveredKeys,
					keyAuthenticity,
				}
			}
			return result
		},

		async generateNewKeyForDataOwner(): Promise<KeyPair<CryptoKey> | boolean | 'keyless'> {
			return true
		},

		async verifyDelegatePublicKeys(
			delegate: CryptoActorStubWithType,
			publicKeys: string[],
		): Promise<string[]> {
			void delegate
			return publicKeys
		},

		dataOwnerRequiresAnonymousDelegation(dataOwner: CryptoActorStubWithType): boolean {
			return dataOwner.type === 'patient'
		},
	}
}
