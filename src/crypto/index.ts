// Public surface of the crypto core. Nothing outside src/crypto/ should
// import from the individual modules directly.

export type {
	KeyPair,
	IdentityKeyPair,
	IdentityPublicKeys,
	SignedPreKey,
	OneTimePreKey,
	PreKeyBundle,
	X3DHInitiatorParams,
	X3DHInitiatorResult,
	X3DHResponderParams,
	X3DHResponderResult,
	RatchetHeader,
	RatchetEncryptResult,
	RatchetState,
} from './types';

export {
	generateIdentityKeyPair,
	generateSignedPreKey,
	verifySignedPreKey,
	generateOneTimePreKeys,
	initiateX3DH,
	respondX3DH,
} from './x3dh';

export { initRatchetAsInitiator, initRatchetAsResponder, ratchetEncrypt, ratchetDecrypt, tryRatchetDecrypt } from './doubleRatchet';

export { sealBox, openBox } from './sealedBox';

export { computeSafetyNumber, formatSafetyNumber } from './safetyNumber';
export type { SafetyNumberIdentity } from './safetyNumber';

export {
	generateSenderKey,
	senderKeyDistribution,
	initReceiverSenderKey,
	senderKeyEncrypt,
	senderKeyDecrypt,
} from './senderKey';
export type { SenderKeyState, ReceiverSenderKeyState, SenderKeyDistribution, SenderKeyMessage } from './senderKey';
