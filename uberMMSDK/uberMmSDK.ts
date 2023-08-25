import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { UberMm, UberMmIDL } from "./uberMmIDL";
import {
  PublicKey,
  Connection,
  Keypair,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
  LAMPORTS_PER_SOL,
  SYSVAR_CLOCK_PUBKEY,
} from "@solana/web3.js";
import { PHOENIX_PROGRAM_ID, UBER_MM_PROGRAM_ID } from "./consts";
import {
  createPhoenixClient,
  getPhoenixStrategyAddress,
  getTokenBalance,
  sumAsciiChars,
} from "./helpers";
import * as Phoenix from "@ellipsis-labs/phoenix-sdk";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { BN } from "bn.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { rebalanceJupOk } from "./jupiter";
import { simulateTransaction } from "@coral-xyz/anchor/dist/cjs/utils/rpc";
import { parsePriceData } from "@pythnetwork/client";
import { marketsToPyth } from "./marketsToPyth";

const CLIENT_ORDER_ID = 69420;

export class UberMmSDK {
  private wallet: Keypair;
  private program: Program<UberMm>;
  private connection: Connection;
  private currentSide: Phoenix.Side;
  private marketMetadata: {
    market: string;
    baseMint: string;
    quoteMint: string;
  };
  public balanceCheck: boolean;
  public baseMarketMakingAmount: number; // base amount expected to be in wallet ata i.e. 1 SOL
  public quoteMarketMakingAmount: number; // quote amount expected to be in wallet ata i.e. 20 USDC
  public phoenixMarket: Phoenix.MarketState;
  public phoenixClient: Phoenix.Client;

  constructor(
    wallet: Keypair,
    program: Program<UberMm>,
    connection: Connection,
    marketMetadata: {
      market: string;
      baseMint: string;
      quoteMint: string;
    },
    phoenixClient: Phoenix.Client,
    phoenixMarket: Phoenix.MarketState
  ) {
    this.wallet = wallet;
    this.program = program;
    this.connection = connection;
    this.marketMetadata = marketMetadata;
    this.phoenixClient = phoenixClient;
    this.phoenixMarket = phoenixMarket;
  }

  static async init(
    wallet: Keypair,
    connection: Connection,
    marketMetadata: {
      market: string;
      baseMint: string;
      quoteMint: string;
    }
  ): Promise<UberMmSDK> {
    const provider = new AnchorProvider(
      connection,
      new NodeWallet(
        new Keypair({
          publicKey: wallet.publicKey.toBuffer(),
          secretKey: wallet.secretKey,
        })
      ),
      { commitment: "confirmed", preflightCommitment: "confirmed" }
    );
    let program = new Program(UberMmIDL, UBER_MM_PROGRAM_ID, provider);

    const phoenixClient = await createPhoenixClient(
      connection,
      new PublicKey(marketMetadata.market)
    );

    const phoenixMarket = phoenixClient.marketStates.get(marketMetadata.market);
    return new UberMmSDK(
      wallet,
      program,
      connection,
      marketMetadata,
      phoenixClient,
      phoenixMarket
    );
  }

  public async getPhoenixMarketAddresses(): Promise<PublicKey[]> {
    let programKeypairs = await this.connection.getProgramAccounts(
      new PublicKey(PHOENIX_PROGRAM_ID),
      {
        commitment: this.connection.commitment,
        filters: [{ dataSize: 1723488 }],
        encoding: "base64",
      }
    );
    return programKeypairs.map((Keypair: any) => {
      return Keypair.pubkey;
    });
  }

  public async initializeStrategyState(params: MMParams): Promise<string> {
    let [phoenixStrategy] = getPhoenixStrategyAddress(
      this.marketMetadata.market,
      this.wallet.publicKey
    );
    try {
      const tx = await this.program.methods
        .initialize(
          new BN(params.quoteEdgeInBps),
          new BN(params.quoteSizeInQuoteAtoms),
          0,
          false
        )
        .accounts({
          phoenixStrategy: phoenixStrategy,
          user: this.wallet.publicKey,
          market: new PublicKey(this.marketMetadata.market),
          systemProgram: SystemProgram.programId,
        })
        .signers([this.wallet])
        .rpc();
      console.log(`strategy created for market: https://solscan.io/tx/${tx}`);
    } catch (e) {
      console.log(e);
    }
    try {
      let seatTx = this.phoenixMarket.createRequestSeatInstruction(
        this.wallet.publicKey,
        this.wallet.publicKey
      );
      let res = await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(seatTx),
        [this.wallet]
      );
      console.log(`seat created: https://solscan.io/tx/${res}`);
    } catch (e) {
      console.log(e);
    }
    try {
      let claimSeatTx = Phoenix.getClaimSeatIx(
        new PublicKey(this.marketMetadata.market),
        this.wallet.publicKey
      );
      let res = await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(claimSeatTx),
        [this.wallet]
      );
      console.log(`seat claimed: https://solscan.io/tx/${res}`);
    } catch (e) {
      console.log(e);
    }
    return;
  }

  async rebalancePhoenix(
    baseSize: number,
    quoteSize: number,
    simulate: boolean = false
  ) {
    // Calc max float price to where the price_in_ticks is still < Number.MAX_SAFE_INTEGER
    const maxFloatPrice =
      (Number.MAX_SAFE_INTEGER /
        2 /
        (10 ** this.phoenixMarket.data.header.quoteParams.decimals *
          this.phoenixMarket.data.header.rawBaseUnitsPerBaseUnit)) *
      (this.phoenixMarket.data.quoteLotsPerBaseUnitPerTick *
        new BN(this.phoenixMarket.data.header.quoteLotSize).toNumber());

    // Sum the ascii values of the signing wallet and add to our client order ID to ensure it's unique
    const clientOrderId = sumAsciiChars(
      this.wallet.publicKey.toString(),
      CLIENT_ORDER_ID
    );
    // Determine order parameters based on current side
    const side = this.currentSide;
    const isBid = side === Phoenix.Side.Bid;
    const isAsk = side === Phoenix.Side.Ask;

    // Calculate adjusted sizes for bid and ask orders
    const adjustedBaseSize = isBid ? Number(baseSize) : 0;
    const adjustedQuoteSize = isAsk ? Number(quoteSize) : 0;

    // Calculate min sizes to fill based on self-trade behavior
    const minBaseUnitsToFill = isAsk
      ? adjustedBaseSize - adjustedBaseSize * 0.001
      : 0;
    const minQuoteUnitsToFill = isBid
      ? adjustedQuoteSize - adjustedQuoteSize * 0.001
      : 0;

    // Construct order instruction template
    const iocIx =
      this.phoenixMarket.getImmediateOrCancelOrderInstructionfromTemplate(
        this.wallet.publicKey,
        {
          side,
          priceAsFloat: isBid ? maxFloatPrice : 0,
          sizeInBaseUnits: adjustedBaseSize,
          sizeInQuoteUnits: adjustedQuoteSize,
          minBaseUnitsToFill,
          minQuoteUnitsToFill,
          selfTradeBehavior: Phoenix.SelfTradeBehavior.CancelProvide,
          clientOrderId,
          useOnlyDepositedFunds: false,
          matchLimit: undefined,
        }
      );

    if (simulate) {
      let recentBlockhash = await this.connection.getLatestBlockhash();
      console.log(
        "simulate tx: ",
        await simulateTransaction(
          this.connection,
          new Transaction({ recentBlockhash: recentBlockhash.blockhash }).add(
            iocIx
          ),
          [this.wallet]
        )
      );
      return;
    }

    console.log(
      `run phoenix swap: https://solscan.io/tx/${await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(iocIx),
        [this.wallet]
        // { skipPreflight: true }
      )}`
    );
  }

  async getBalance(
    makerQuoteTokenAccount: PublicKey,
    makerBaseTokenAccount: PublicKey
  ) {
    let baseDecimals = 10 ** this.phoenixMarket.data.header.baseParams.decimals;
    let quoteDecimals =
      10 ** this.phoenixMarket.data.header.quoteParams.decimals;

    let quoteBalance =
      (await getTokenBalance(this.connection, makerQuoteTokenAccount)) /
      quoteDecimals;
    let baseBalance =
      (await getTokenBalance(this.connection, makerBaseTokenAccount)) /
      baseDecimals;
    console.log("BaseBalance:", baseBalance, "QuoteBalance: ", quoteBalance);

    return [baseBalance, quoteBalance];
  }

  async getPhoenixOutAmountInAtoms(amount: number) {
    const clockInfo = await this.connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
    this.phoenixClient.reloadClockFromBuffer(clockInfo.data);
    let phoenixOutAmount = this.phoenixMarket.getExpectedOutAmount({
      side: this.currentSide,
      inAmount: amount,
      slot: this.phoenixClient.clock.slot,
      unixTimestamp: this.phoenixClient.clock.unixTimestamp,
    });
    let baseDecimals = 10 ** this.phoenixMarket.data.header.baseParams.decimals;
    let quoteDecimals =
      10 ** this.phoenixMarket.data.header.quoteParams.decimals;
    let expectedOutAmount =
      this.currentSide === Phoenix.Side.Bid
        ? phoenixOutAmount * baseDecimals
        : phoenixOutAmount * quoteDecimals;
    return expectedOutAmount;
  }

  async isRebalanceRequired(
    makerQuoteTokenAccount: PublicKey,
    makerBaseTokenAccount: PublicKey
  ) {
    const quoteMintKey = new PublicKey(this.marketMetadata.quoteMint);
    const baseMintKey = new PublicKey(this.marketMetadata.baseMint);
    let [baseStartBalance, quoteStartBalance] = await this.getBalance(
      makerQuoteTokenAccount,
      makerBaseTokenAccount
    );
    let baseDecimals = 10 ** this.phoenixMarket.data.header.baseParams.decimals;
    let quoteDecimals =
      10 ** this.phoenixMarket.data.header.quoteParams.decimals;
    if (baseStartBalance < this.baseMarketMakingAmount - 0.1) {
      console.log(
        "rebalancing: basebalance is lower than ",
        this.baseMarketMakingAmount - 0.1
      );
      this.currentSide = Phoenix.Side.Bid;
      let inAmount = quoteStartBalance - this.quoteMarketMakingAmount;

      let phoenixOutAmount = await this.getPhoenixOutAmountInAtoms(inAmount);
      console.log("phoenixInAmount", phoenixOutAmount);

      let didRun = await rebalanceJupOk({
        connection: this.connection,
        user: this.wallet,
        inputMint: quoteMintKey,
        outputMint: baseMintKey,
        amount: inAmount,
        expectedHigherThan: phoenixOutAmount,
        uberMM: this,
      });

      if (!didRun) {
        this.rebalancePhoenix(
          phoenixOutAmount / baseDecimals,
          0,
          this.balanceCheck
        );
      }
    } else if (quoteStartBalance < this.quoteMarketMakingAmount - 1) {
      console.log(
        "rebalancing: quotebalance is lower than ",
        this.quoteMarketMakingAmount - 1
      );
      this.currentSide = Phoenix.Side.Ask;
      let inAmount = baseStartBalance - this.baseMarketMakingAmount;
      let phoenixOutAmount = await this.getPhoenixOutAmountInAtoms(inAmount);
      console.log("phoenixOutAmount", phoenixOutAmount);

      let didRun = await rebalanceJupOk({
        connection: this.connection,
        user: this.wallet,
        inputMint: baseMintKey,
        outputMint: quoteMintKey,
        amount: inAmount,
        expectedHigherThan: phoenixOutAmount,
        uberMM: this,
      });

      if (!didRun) {
        this.rebalancePhoenix(
          0,
          phoenixOutAmount / quoteDecimals,
          this.balanceCheck
        );
      }
    } else {
      console.log("rebalance not required");
    }
    if (!this.balanceCheck) {
      await new Promise((r) => setTimeout(r, 5000));
      [baseStartBalance, quoteStartBalance] = await this.getBalance(
        makerQuoteTokenAccount,
        makerBaseTokenAccount
      );
      return [baseStartBalance, quoteStartBalance];
    }
    return [0, 0];
  }

  async cancelAndWithdraw() {
    let cancelOrdersIx = this.phoenixMarket.createCancelAllOrdersInstruction(
      this.wallet.publicKey
    );
    console.log(
      `canceling all orders tx: https://solscan.io/tx/${await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(cancelOrdersIx),
        [this.wallet]
      )}`
    );

    let withdrawFundsIx = this.phoenixMarket.createWithdrawFundsInstruction(
      {
        withdrawFundsParams: {
          quoteLotsToWithdraw: null,
          baseLotsToWithdraw: null,
        },
      },
      this.wallet.publicKey
    );
    console.log(
      `withdrawing funds tx: https://solscan.io/tx/${await sendAndConfirmTransaction(
        this.connection,
        new Transaction().add(withdrawFundsIx),
        [this.wallet]
      )}`
    );

    await new Promise((r) => setTimeout(r, 5000));
  }

  async updateQuotes(
    params: MMParams,
    phoenixStrategy: PublicKey,
    makerQuoteTokenAccount: PublicKey,
    makerBaseTokenAccount: PublicKey
  ) {
    return await this.program.methods
      .updateQuotes(
        new BN(0),
        new BN(params.quoteEdgeInBps),
        new BN(params.quoteSizeInQuoteAtoms),
        params.priceImprovementBehavior,
        false,
        true,
        new BN(params.margin)
      )
      .accounts({
        user: this.wallet.publicKey,
        market: new PublicKey(this.marketMetadata.market),
        phoenixProgram: Phoenix.PROGRAM_ID,
        phoenixStrategy: phoenixStrategy,
        logAuthority: Phoenix.getLogAuthority(),
        seat: this.phoenixMarket.getSeatAddress(this.wallet.publicKey),
        quoteAccount: makerQuoteTokenAccount,
        baseAccount: makerBaseTokenAccount,
        quoteVault: this.phoenixMarket.data.header.quoteParams.vaultKey,
        baseVault: this.phoenixMarket.data.header.baseParams.vaultKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        {
          pubkey: new PublicKey(marketsToPyth[this.marketMetadata.market][0]),
          isWritable: false,
          isSigner: false,
        },
        {
          pubkey: new PublicKey(marketsToPyth[this.marketMetadata.market][1]),
          isWritable: false,
          isSigner: false,
        },
      ])
      .signers([this.wallet])
      .rpc();
  }
  public async runUberMM(
    params: MMParams,
    makerQuoteTokenAccount: PublicKey,
    makerBaseTokenAccount: PublicKey,
    txNumber: number, // how many txs do you want to make
    txInterval: number, // how many seconds between each tx
    initialCancelAndWithdraw: boolean = true
  ) {
    if (initialCancelAndWithdraw) await this.cancelAndWithdraw();

    let [phoenixStrategy] = getPhoenixStrategyAddress(
      this.marketMetadata.market,
      this.wallet.publicKey
    );

    let baseStartBalance: number;
    let quoteStartBalance: number;
    if (txNumber > 0) {
      [baseStartBalance, quoteStartBalance] = await this.isRebalanceRequired(
        makerQuoteTokenAccount,
        makerBaseTokenAccount
      );
      if (this.balanceCheck) return;
    }

    for (let i = 0; i < txNumber; i++) {
      let timeStart = Date.now();
      try {
        const tx = await this.updateQuotes(
          params,
          phoenixStrategy,
          makerQuoteTokenAccount,
          makerBaseTokenAccount
        );
        console.log(i, `https://solscan.io/tx/${tx}`);
        if (i % 10 == 9) {
          await this.getBalance(makerQuoteTokenAccount, makerBaseTokenAccount);
        }
      } catch (e) {
        console.log(e);
        await this.cancelAndWithdraw();
        await this.isRebalanceRequired(
          makerQuoteTokenAccount,
          makerBaseTokenAccount
        );
      }
      let timeSpent = Date.now() - timeStart;
      let waitTime = Math.max(0, txInterval - timeSpent);
      await new Promise((r) => setTimeout(r, waitTime));
    }
    await this.cancelAndWithdraw();

    console.log("Balances After MM: ");
    let [baseBalance, quoteBalance] = await this.getBalance(
      makerQuoteTokenAccount,
      makerBaseTokenAccount
    );

    let accInfo = await this.connection.getAccountInfo(
      new PublicKey(marketsToPyth[this.marketMetadata.market][0])
    );
    let priceBase = parsePriceData(accInfo.data).aggregate.price;
    accInfo = await this.connection.getAccountInfo(
      new PublicKey(marketsToPyth[this.marketMetadata.market][1])
    );
    let priceQuote = parsePriceData(accInfo.data).aggregate.price;
    console.log(
      "Profit Made: ",
      baseBalance * priceBase -
        baseStartBalance * priceBase +
        quoteBalance * priceQuote -
        quoteStartBalance * priceQuote,
      "USD"
    );
  }
}

interface MMParams {
  quoteEdgeInBps: number; // edge from fair price in which we put orders
  quoteSizeInQuoteAtoms: number; // size of orders in quote atoms
  postOnly: boolean;
  priceImprovementBehavior: number; // 0 = ubermensch, 1 = join, 2 = dime, 3 = ignore
  margin: number; // minimum quote edge accepted(only used in ubermensch mode)
}
