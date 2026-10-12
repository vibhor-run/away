// Minimal declarations for the parts of noise-handshake 4.2.0 used by Away.
declare module "noise-handshake" {
  interface KeyPair {
    publicKey: Buffer;
    secretKey: Buffer;
  }
  class Noise {
    constructor(pattern: "IK", initiator: boolean, staticKeyPair?: KeyPair);
    readonly s: KeyPair;
    readonly complete: boolean;
    /** Remote static public key, known after the handshake. */
    readonly rs: Buffer | null;
    readonly tx: Buffer;
    readonly rx: Buffer;
    initialise(prologue: Buffer, remoteStatic?: Buffer): void;
    send(payload?: Buffer): Buffer;
    recv(message: Buffer): Buffer;
  }
  export = Noise;
}

declare module "noise-handshake/cipher.js" {
  class CipherState {
    constructor(key: Buffer);
    encrypt(plaintext: Buffer, ad?: Buffer): Buffer;
    decrypt(ciphertext: Buffer, ad?: Buffer): Buffer;
  }
  export = CipherState;
}

declare module "noise-handshake/dh.js" {
  export function generateKeyPair(secretKey?: Buffer): { publicKey: Buffer; secretKey: Buffer };
}
