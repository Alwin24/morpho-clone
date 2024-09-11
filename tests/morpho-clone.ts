import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  DEFAULT_RECENT_SLOT_DURATION_MS,
  getAssociatedTokenAddress,
  KaminoAction,
  KaminoMarket,
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
import { writeFileSync } from "fs";
config({ path: "./target/.env" });

const devKeypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.DEV_KEYPAIR!))
);

describe("morpho-clone", () => {
  // Configure the client to use the local cluster.
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.MorphoClone as Program<MorphoClone>;

  const PROGRAM_ID = new PublicKey(
    "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
    // "SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh"
  );

  const LENDING_MARKET = new PublicKey(
    "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
    // "N5rxNZrDorPdcLSGF7tam7SfnPYFB3kF6TpZiNMSeCG"
  );

  it.skip("Initialize!", async () => {
    const amount = new anchor.BN(10 ** 7);

    const tx = await program.methods
      .initialize(amount)
      .accounts({
        authority: devKeypair.publicKey,
      })
      .rpc();

    console.log("Transaction signature:", tx);
  });

  it("Deposit!", async () => {
    const kaminoMarket = await KaminoMarket.load(
      program.provider.connection,
      LENDING_MARKET,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      PROGRAM_ID
    );

    const depositAmount = (10 ** 6 * 0.001).toString();

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

    const escrowTokenAccount = getAssociatedTokenAddress(
      tokenMint,
      escrow,
      true
    );

    console.log("Escrow:", escrow.toBase58());
    console.log("Escrow Token Account:", escrowTokenAccount.toBase58());

    const kaminoAction = await KaminoAction.buildDepositTxns(
      kaminoMarket,
      depositAmount,
      tokenMint,
      escrow,
      new VanillaObligation(PROGRAM_ID),
      1_000_000
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
        userTokenAccount,
        tokenMint,
      })
      .remainingAccounts(allAccountMetas)
      .instruction();

    let ixs = [
      ...kaminoAction.setupIxs,
      // ix,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ].filter((ix) => !ix.programId.equals(AddressLookupTableProgram.programId));

    const targetBytes1 = Buffer.from([117, 169, 176, 69, 197, 23, 15, 162]);
    const targetBytes2 = Buffer.from([251, 10, 231, 76, 27, 11, 159, 96]);
    const targetBytes3 = Buffer.from([136, 63, 15, 186, 211, 152, 168, 164]);

    ixs.forEach((ix) => {
      if (
        Buffer.compare(ix.data.slice(0, 8), targetBytes1) === 0 ||
        Buffer.compare(ix.data.slice(0, 8), targetBytes2) === 0
      ) {
        ix.keys.at(0).isSigner = false;
        ix.keys.at(0).isWritable = true;
        ix.keys.at(1).pubkey = devKeypair.publicKey;
      }

      if (Buffer.compare(ix.data.slice(0, 8), targetBytes3) === 0) {
        ix.keys.at(0).pubkey = devKeypair.publicKey;
        ix.keys.at(1).isSigner = false;
        ix.keys.at(1).isWritable = true;
      }
    });

    // ixs.forEach((ix) => {
    //   ix.keys.forEach((key) => {
    //     if (key.pubkey.equals(escrow)) {
    //       key.isWritable = true;
    //       key.isSigner = false;
    //     }
    //   });
    // });

    // writeFileSync("kaminoAction/setupIxs.json", JSON.stringify(ixs, null, 2));

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

    console.log(
      "Transaction signature:",
      simulation.value
      // sign
    );
  });
});
