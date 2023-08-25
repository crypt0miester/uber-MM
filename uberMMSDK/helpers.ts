import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  AccountInfo,
} from "@solana/web3.js";

import * as anchor from "@coral-xyz/anchor";
import * as Phoenix from "@ellipsis-labs/phoenix-sdk";
import { UBER_MM_PROGRAM_ID, tokenConfig } from "./consts";

import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { struct, u32, u8 } from "@solana/buffer-layout";
import { publicKey, u64 } from "@solana/buffer-layout-utils";

export const createPhoenixClient = async (
  connection: Connection,
  marketAddress: PublicKey
): Promise<Phoenix.Client> => {
  const client = await Phoenix.Client.createWithoutConfig(connection, []);
  client.tokenConfigs = tokenConfig;
  await client.addMarket(marketAddress.toBase58());
  return client;
};

export async function getTokenBalance(
  connection: Connection,
  accountAddress: PublicKey
) {
  try {
    // Fetch the account data
    // const accountInfo: AccountInfo<Buffer> | null = await connection.getAccountInfo(accountAddress);
    const accountInfo = await getAccount(connection, accountAddress);

    if (accountInfo) {
      // console.log(accountInfo)
      return Number(accountInfo.amount);
    } else {
      console.log("Account not found on Solana.");
    }
  } catch (error) {
    console.error("Error:", error);
  }
}
export const getPhoenixStrategyAddress = (
  market: string | PublicKey,
  wallet: PublicKey
) => {
  if (typeof market == "string") {
    market = new PublicKey(market);
  }

  return PublicKey.findProgramAddressSync(
    [
      anchor.utils.bytes.utf8.encode("phoenix"),
      wallet.toBuffer(),
      market.toBuffer(),
    ],
    UBER_MM_PROGRAM_ID
  );
};

export const getAtaForMint = (
  mint: PublicKey,
  account: PublicKey
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [account.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
};
// Sum the ascii values of the signing wallet and add to our client order ID to ensure it's unique
export function sumAsciiChars(pubkey: string, clientOrderId: number) {
  return (
    pubkey.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) +
    clientOrderId
  );
}

export function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID
): TransactionInstruction {
  return buildAssociatedTokenAccountInstruction(
    payer,
    associatedToken,
    owner,
    mint,
    Buffer.from([1]),
    programId,
    associatedTokenProgramId
  );
}

function buildAssociatedTokenAccountInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  instructionData: Buffer,
  programId = TOKEN_PROGRAM_ID,
  associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID
): TransactionInstruction {
  const keys = [
    { pubkey: payer, isSigner: true, isWritable: true },
    { pubkey: associatedToken, isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: programId, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    keys,
    programId: associatedTokenProgramId,
    data: instructionData,
  });
}
/** Instructions defined by the program */
export enum TokenInstruction {
  InitializeMint = 0,
  InitializeAccount = 1,
  InitializeMultisig = 2,
  Transfer = 3,
  Approve = 4,
  Revoke = 5,
  SetAuthority = 6,
  MintTo = 7,
  Burn = 8,
  CloseAccount = 9,
  FreezeAccount = 10,
  ThawAccount = 11,
  TransferChecked = 12,
  ApproveChecked = 13,
  MintToChecked = 14,
  BurnChecked = 15,
  InitializeAccount2 = 16,
  SyncNative = 17,
  InitializeAccount3 = 18,
  InitializeMultisig2 = 19,
  InitializeMint2 = 20,
  GetAccountDataSize = 21,
  InitializeImmutableOwner = 22,
  AmountToUiAmount = 23,
  UiAmountToAmount = 24,
  InitializeMintCloseAuthority = 25,
  TransferFeeExtension = 26,
  ConfidentialTransferExtension = 27,
  DefaultAccountStateExtension = 28,
  Reallocate = 29,
  MemoTransferExtension = 30,
  CreateNativeMint = 31,
  InitializeNonTransferableMint = 32,
  InterestBearingMintExtension = 33,
  CpiGuardExtension = 34,
  InitializePermanentDelegate = 35,
}

/** TODO: docs */
export interface SyncNativeInstructionData {
  instruction: TokenInstruction.SyncNative;
}

/** TODO: docs */
export const syncNativeInstructionData = struct<SyncNativeInstructionData>([
  u8("instruction"),
]);

export function createSyncNativeInstruction(
  account: PublicKey,
  programId = TOKEN_PROGRAM_ID
): TransactionInstruction {
  const keys = [{ pubkey: account, isSigner: false, isWritable: true }];

  const data = Buffer.alloc(syncNativeInstructionData.span);
  syncNativeInstructionData.encode(
    { instruction: TokenInstruction.SyncNative },
    data
  );

  return new TransactionInstruction({ keys, programId, data });
}

export async function getAccount(
  connection: Connection,
  address: PublicKey,
  programId = TOKEN_PROGRAM_ID
): Promise<Account> {
  const info = await connection.getAccountInfo(address, "confirmed");
  return unpackAccount(address, info, programId);
}
/** Base class for errors */
export abstract class TokenError extends Error {
  constructor(message?: string) {
    super(message);
  }
}

/** Thrown if an account is not found at the expected address */
export class TokenAccountNotFoundError extends TokenError {
  name = "TokenAccountNotFoundError";
}

/** Thrown if a program state account is not owned by the expected token program */
export class TokenInvalidAccountOwnerError extends TokenError {
  name = "TokenInvalidAccountOwnerError";
}

/** Thrown if the byte length of an program state account doesn't match the expected size */
export class TokenInvalidAccountSizeError extends TokenError {
  name = "TokenInvalidAccountSizeError";
}
/** Token account state as stored by the program */
export enum AccountState {
  Uninitialized = 0,
  Initialized = 1,
  Frozen = 2,
}

/** Token account as stored by the program */
export interface RawAccount {
  mint: PublicKey;
  owner: PublicKey;
  amount: bigint;
  delegateOption: 1 | 0;
  delegate: PublicKey;
  state: AccountState;
  isNativeOption: 1 | 0;
  isNative: bigint;
  delegatedAmount: bigint;
  closeAuthorityOption: 1 | 0;
  closeAuthority: PublicKey;
}

/** Buffer layout for de/serializing a token account */
export const AccountLayout = struct<RawAccount>([
  publicKey("mint"),
  publicKey("owner"),
  u64("amount"),
  u32("delegateOption"),
  publicKey("delegate"),
  u8("state"),
  u32("isNativeOption"),
  u64("isNative"),
  u64("delegatedAmount"),
  u32("closeAuthorityOption"),
  publicKey("closeAuthority"),
]);

/** Byte length of a token account */
export const ACCOUNT_SIZE = AccountLayout.span;

/** Information about a token account */
export interface Account {
  /** Address of the account */
  address: PublicKey;
  /** Mint associated with the account */
  mint: PublicKey;
  /** Owner of the account */
  owner: PublicKey;
  /** Number of tokens the account holds */
  amount: bigint;
  /** Authority that can transfer tokens from the account */
  delegate: PublicKey | null;
  /** Number of tokens the delegate is authorized to transfer */
  delegatedAmount: bigint;
  /** True if the account is initialized */
  isInitialized: boolean;
  /** True if the account is frozen */
  isFrozen: boolean;
  /** True if the account is a native token account */
  isNative: boolean;
  /**
   * If the account is a native token account, it must be rent-exempt. The rent-exempt reserve is the amount that must
   * remain in the balance until the account is closed.
   */
  rentExemptReserve: bigint | null;
  /** Optional authority to close the account */
  closeAuthority: PublicKey | null;
  tlvData: Buffer;
}

export function unpackAccount(
  address: PublicKey,
  info: AccountInfo<Buffer> | null,
  programId = TOKEN_PROGRAM_ID
): Account {
  if (!info) throw new TokenAccountNotFoundError();
  if (!info.owner.equals(programId)) throw new TokenInvalidAccountOwnerError();
  if (info.data.length < ACCOUNT_SIZE) throw new TokenInvalidAccountSizeError();

  const rawAccount = AccountLayout.decode(info.data.slice(0, ACCOUNT_SIZE));
  let tlvData = Buffer.alloc(0);
  if (info.data.length > ACCOUNT_SIZE) {
    if (info.data[ACCOUNT_SIZE] != 2) throw new TokenInvalidAccountSizeError();
    tlvData = info.data.slice(ACCOUNT_SIZE + 1);
  }

  return {
    address,
    mint: rawAccount.mint,
    owner: rawAccount.owner,
    amount: rawAccount.amount,
    delegate: rawAccount.delegateOption ? rawAccount.delegate : null,
    delegatedAmount: rawAccount.delegatedAmount,
    isInitialized: rawAccount.state !== AccountState.Uninitialized,
    isFrozen: rawAccount.state === AccountState.Frozen,
    isNative: !!rawAccount.isNativeOption,
    rentExemptReserve: rawAccount.isNativeOption ? rawAccount.isNative : null,
    closeAuthority: rawAccount.closeAuthorityOption
      ? rawAccount.closeAuthority
      : null,
    tlvData,
  };
}
