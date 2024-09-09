import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MorphoClone } from "../target/types/morpho_clone";
import {
  DEFAULT_RECENT_SLOT_DURATION_MS,
  KaminoAction,
  KaminoMarket,
  PROGRAM_ID,
  VanillaObligation,
} from "@kamino-finance/klend-sdk";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { writeFileSync } from "fs";
import { config } from "dotenv";
config({ path: "./target/.env" });

const devKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.DEV_KEYPAIR!))
);
const mainnetConnection = new Connection(process.env.BACKEND_RPC!, "confirmed");

describe("morpho-clone", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.MorphoClone as Program<MorphoClone>;

  const LENDING_MARKET = new PublicKey(
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
  );

  it("Is initialized!", async () => {
    // await new Promise((resolve) => setTimeout(resolve, 100000));

    const kaminoMarket = await KaminoMarket.load(
      mainnetConnection,
      LENDING_MARKET,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      PROGRAM_ID
    );

    const depositAmount = "1000000";

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
      await program.provider.connection.getLatestBlockhash("finalized");

    if (kaminoAction.preTxnIxs.length > 0) {
      const preTxn = new Transaction().add(...kaminoAction.preTxnIxs);
      preTxn.feePayer = program.provider.publicKey;
      preTxn.recentBlockhash = blockhashWithContext.blockhash;
      preTxn.partialSign(devKeypair);
      const sign = await program.provider.connection.sendRawTransaction(
        preTxn.serialize()
      );
      console.log(sign);
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

    let skip = false;
    let ixs = [
      ...kaminoAction.setupIxs.filter(
        (ix) =>
          ix.programId.toBase58() !==
          "AddressLookupTab1e1111111111111111111111111"
      ),
      // ix,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ];
    // ].filter((ix) => {
    //   if (skip) return true;

    //   if (
    //     ix.data.toString() !==
    //     Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]).toString()
    //   ) {
    //     return true;
    //   } else skip = true;
    // });

    const txn = new Transaction().add(...ixs);

    // writeFileSync(
    //   "kaminoAction/deposit-kamino.json",
    //   JSON.stringify(kaminoAction.lendingIxs, null, 2)
    // );

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
