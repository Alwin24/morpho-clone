import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  DEFAULT_RECENT_SLOT_DURATION_MS,
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

  it("Is initialized!", async () => {
    const kaminoMarket = await KaminoMarket.load(
      program.provider.connection,
      LENDING_MARKET,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      PROGRAM_ID
    );

    const depositAmount = "1000";

    const kaminoAction = await KaminoAction.buildDepositTxns(
      kaminoMarket,
      depositAmount,
      new PublicKey("So11111111111111111111111111111111111111112"),
      program.provider.publicKey,
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

    const ix = await program.methods
      .initialize(ixDatas, ixAccountsCount)
      .accounts({
        kaminoProgram: PROGRAM_ID,
      })
      .remainingAccounts(allAccountMetas)
      .instruction();

    let ixs = [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ].filter((ix) => !ix.programId.equals(AddressLookupTableProgram.programId));

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
