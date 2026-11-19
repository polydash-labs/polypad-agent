/**
 * polypad-agent — thin typed client for the Polypad agent API (v2.0.0).
 *
 * Non-custodial: the API only reads or prepares unsigned transactions.
 * You sign in your own wallet (or your agent's wallet). Polypad never
 * holds keys, and this SDK never asks for one.
 */
export { PolypadClient, PolypadError, MCP_URL, SITE_ORIGIN, CHAIN_ID, DEFAULT_RPC_URL } from './client.js';
export type { PreparedAction, PreparedTransaction, TxStatus, PolypadClientOptions, UnsignedStep, ToolName } from './client.js';
export { connectUrl, decodeWalletToken } from './binding.js';
export type { WalletTokenInfo } from './binding.js';
export { robinhoodChain } from './chain.js';
export {
  ACTION_LIMITS,
  CHAIN_NAME,
  ERROR_MEANINGS,
  EXPLORER,
  MCP_ENDPOINT,
  MCP_PROTOCOL_VERSION,
  RATE_LIMITS,
  SERVER_VERSION,
  SPEND_VAULT_ADDRESS,
  VAULT_TOKENS,
  X402,
  X402_PRODUCTS,
  x402Product,
  type X402ProductId,
} from './constants.js';
export {
  PolypadConfirmTimeoutError,
  PolypadTxFailedError,
  type ApiErrorBody,
} from './errors.js';
export {
  confirm,
  signAndSend,
  signSendAndConfirm,
  type ConfirmOptions,
  type SentStep,
  type SignAndSendOptions,
} from './prepare.js';
export {
  buildCreateKeyTx,
  buildDepositTx,
  buildRevokeKeyTx,
  buildWithdrawTx,
  getKeyStatus,
  getVaultBalance,
  spendVaultKeyFlow,
  SPEND_VAULT_ABI,
  type CreateKeyParams,
  type SpendingKeyStatus,
  type UnsignedCall,
} from './spend-vault.js';
export {
  isPrepareTool,
  PREPARE_TOOLS,
  TOOL_NAMES,
  type Address,
  type PreparedSummary,
  type PrepareArgs,
  type ReadArgs,
  type ToolArgs,
} from './tools.js';
export {
  encodePaymentHeader,
  fetchWithX402,
  nextPermit2Nonce,
  payForReport,
  productUrl,
  signX402Payment,
  type FetchWithPaymentOptions,
  type PaidFetchResult,
  type PaymentRequirement,
  type SignPaymentOptions,
  type TypedDataSigner,
  type X402Payment,
  type X402PaymentPayload,
} from './x402.js';
