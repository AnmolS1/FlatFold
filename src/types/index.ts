// Re-exports shared/types.ts so existing relative imports within src/
// (e.g. `import type { Message } from '../types'`) keep working. The
// canonical definitions live in shared/types.ts since the Worker imports
// them too.
export type {
	User,
	AuthContextType,
	FormErrors,
	DisplayMessage,
	MediaRef,
	ReplyRef,
	RatchetHeaderWire,
	X3dhHandshakeWire,
	WsSendFrame,
	WsAckFrame,
	WsGroupSendFrame,
	WsMessageFrame,
	WsDeliveredFrame,
	WsGroupMessageFrame,
	WsEnvelope,
	WsClientToServerFrame,
	WsServerToClientFrame,
	IdentityPubkeyWire,
	SignedPrekeyWire,
	PublishKeysRequest,
	PreKeyBundleResponse,
} from '../../shared/types';
