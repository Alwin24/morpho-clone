import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  DEFAULT_RECENT_SLOT_DURATION_MS,
  getAssociatedTokenAddress,
  KaminoAction,
  KaminoMarket,
  PROGRAM_ID,
  VanillaObligation,
} from "@kamino-finance/klend-sdk";
import {
  AddressLookupTableProgram,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { config } from "dotenv";
import { MorphoClone } from "../target/types/morpho_clone";
config({ path: "./target/.env" });

const devKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.DEV_KEYPAIR!))
);

describe("morpho-clone", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.MorphoClone as Program<MorphoClone>;

  const LENDING_MARKET = new PublicKey(
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
  );

  it("Initialize!", async () => {
    const tx = await program.methods
      .initialize()
      .accounts({
        authority: devKeypair.publicKey,
      })
      .rpc();

    console.log("Transaction signature:", tx);
  });

  it.skip("Deposit!", async () => {
    const kaminoMarket = await KaminoMarket.load(
      program.provider.connection,
      LENDING_MARKET,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      PROGRAM_ID
    );

    const depositAmount = "1000";

    const tokenMint = new PublicKey(
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
    );
    const userTokenAccount = getAssociatedTokenAddress(
      tokenMint,
      devKeypair.publicKey
    );

    const [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from("escrow")],
      program.programId
    );

    const [escrowTokenAccount, createAtaIx] =
      createAssociatedTokenAccountIdempotentInstruction(
        escrow,
        tokenMint,
        devKeypair.publicKey
      );

    const kaminoAction = await KaminoAction.buildDepositTxns(
      kaminoMarket,
      depositAmount,
      tokenMint,
      escrowTokenAccount,
      new VanillaObligation(PROGRAM_ID),
      1_000_000,
      true,
      true
    );

    let blockhashWithContext =
      await program.provider.connection.getLatestBlockhash("processed");

    if (kaminoAction.preTxnIxs.length > 0) {
      const preTxn = new Transaction().add(...kaminoAction.preTxnIxs);
      preTxn.feePayer = program.provider.publicKey;
      preTxn.recentBlockhash = blockhashWithContext.blockhash;
      preTxn.partialSign(devKeypair);
      const sign = await program.provider.connection.sendRawTransaction(
        preTxn.serialize()
      );
      console.log("Pre-transaction signature:", sign);
    }

    const kaminoIxs = [
      // ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      // ...kaminoAction.cleanupIxs,
    ];

    const allAccountMetas = kaminoIxs.flatMap((ix) => ix.keys);

    const ixDatas = kaminoIxs.map((ix) => ix.data);
    const ixAccountsCount = Buffer.alloc(kaminoIxs.length);

    kaminoIxs.forEach((ix, i) => {
      ixAccountsCount.writeUInt8(ix.keys.length, i);
    });

    const amount = new anchor.BN(depositAmount);

    const ix = await program.methods
      .deposit(ixDatas, ixAccountsCount, amount)
      .accounts({
        user: devKeypair.publicKey,
        tokenMint,
      })
      .remainingAccounts(allAccountMetas)
      .instruction();

    let ixs = [
      ...kaminoAction.setupIxs,
      ix,
      // ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ];

    const txn = new Transaction().add(...ixs);

    txn.feePayer = devKeypair.publicKey;
    txn.recentBlockhash = blockhashWithContext.blockhash;
    txn.partialSign(devKeypair);

    // const sign = await program.provider.connection.sendRawTransaction(
    //   txn.serialize()
    // );
    const simulation = await program.provider.connection.simulateTransaction(
      txn
    );

    console.log("Transaction signature:", simulation.value);
  });
});
