// Global Web Crypto API types needed by @icure/api v8 interfaces.
// Node 22 provides these at runtime but TypeScript needs them declared
// when the "dom" lib is not included.
declare type CryptoKey = import('node:crypto').webcrypto.CryptoKey
declare type JsonWebKey = import('node:crypto').webcrypto.JsonWebKey
