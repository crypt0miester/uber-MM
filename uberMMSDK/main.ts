import {
  PublicKey,
  Connection,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import { UberMmSDK } from "./uberMmSDK";
import { Keypair } from "@solana/web3.js";
import marketMetadataJson from "./phoenixMasterConfig.json";
import {
  getAtaForMint,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
} from "./helpers";
import { bs58 } from "@project-serum/anchor/dist/cjs/utils/bytes";
import * as dotenv from "dotenv";
dotenv.config();

const KEYPAIR = process.env.KEYPAIR;
const account = Keypair.fromSecretKey(bs58.decode(KEYPAIR));
console.log(account.publicKey.toBase58());

export async function main() {
  let marketAddress = new PublicKey(
    "4DoNfFBfF7UokCC2FQzriy7yHK6DY6NVdYpuekQ5pRgg"
  );
  // values are optimized for the amounts below.
  // base amount is always assumed to be already in the ata account ready.
  // uncomment the helpers below to use them
  let baseMarketMakingAmount = 1; // 1 sol
  let quoteMarketMakingAmount = 20; // 20 usdc
  let connection = new Connection(process.env.RPC_URL || "");
  const marketMetadata = marketMetadataJson["mainnet-beta"].markets.filter(
    (marketData) => marketData.market === marketAddress.toString()
  )[0];
  let uberMmSDK = await UberMmSDK.init(account, connection, marketMetadata);

  const quoteMintKey = new PublicKey(marketMetadata.quoteMint);
  const baseMintKey = new PublicKey(marketMetadata.baseMint);
  let baseDecimals =
    10 ** uberMmSDK.phoenixMarket.data.header.baseParams.decimals;
  let quoteDecimals =
    10 ** uberMmSDK.phoenixMarket.data.header.quoteParams.decimals;

  let [baseTokenAccount] = getAtaForMint(baseMintKey, account.publicKey);
  let [quoteTokenAccount] = getAtaForMint(quoteMintKey, account.publicKey);

  // helpers to iniiate new markets
  // let instructions = [];
  // creates ata for wrapped sol or base mint
  // instructions.push(
  //   createAssociatedTokenAccountIdempotentInstruction(
  //     account.publicKey,
  //     baseTokenAccount,
  //     account.publicKey,
  //     baseMintKey
  //   )
  // );
  // // send sol to wrapped sol ata
  // instructions.push(
  //   SystemProgram.transfer({
  //     fromPubkey: account.publicKey,
  //     toPubkey: baseTokenAccount,
  //     lamports: 2 * baseDecimals,
  //   })
  // );
  // instructions.push(createSyncNativeInstruction(baseTokenAccount));

  // let res = await sendAndConfirmTransaction(connection, new Transaction().add(...instructions), [account]);
  // console.log(`https://solscan.io/tx/${res}`);

  let params = {
    postOnly: false,
    priceImprovementBehavior: 0, // 0 = ubermensch, 1 = join, 2 = dime, 3 = ignore
    // play with the values below to get better mm-ing (currently it is set at around 10 USDC)
    quoteSizeInQuoteAtoms: (quoteMarketMakingAmount * quoteDecimals) / 2, // size of orders in quote atoms
    quoteEdgeInBps: 5, // edge from fair price in which we put orders
    margin: 2, // minimum quote edge accepted (only used in ubermensch mode)
  };

  // if you have not MMed on this market (or on uberMM) before, you need to initialize the strategy state
  // this function will also handle the creation of market seat account and approving it

  // await uberMmSDK.initializeStrategyState(
  //   params,
  //   marketAddress,
  // );
  // base amount expected to be in wallet i.e. 1 SOL
  uberMmSDK.baseMarketMakingAmount = baseMarketMakingAmount;
  // quote amount expected to be in ata (can be rebalanced if you baseAmount is higher than baseMarketMakingAmount) i.e. 20 USDC
  uberMmSDK.quoteMarketMakingAmount = quoteMarketMakingAmount;
  // balance check (dry running no execution.) (simulate transactions)
  uberMmSDK.balanceCheck = true;
  // if run correctly runUberMM will run until all number of txs are sent, unless:
  // * blockhash not found
  // * setup was not correct
  await uberMmSDK.runUberMM(
    params,
    quoteTokenAccount,
    baseTokenAccount,
    1, // number of txs sent
    20 * 1000, // time interval between txs (20 seconds)
    false // initially cancel andd withdraw (helpful if something is wrong)
  );
}

main();
