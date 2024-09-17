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
    // "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
    "SLendK7ySfcEzyaFqy93gDnD3RtrpXJcnRwb6zFHJSh"
  );

  const LENDING_MARKET = new PublicKey(
    // "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
    "N5rxNZrDorPdcLSGF7tam7SfnPYFB3kF6TpZiNMSeCG"
  );

  it.skip("Initialize Escrow!", async () => {
    const amount = new anchor.BN(10 ** 7);

    const tx = await program.methods
      .initializeEscrow(amount)
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
      PROGRAM_ID,
      true,
      true
    );

    const depositAmount = (10 ** 6 * 0.0001).toString();

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

    const ixs = [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ].map((ix) => {
      ix.keys.forEach((key) => {
        if (key.isSigner && key.isWritable) {
          key.pubkey = devKeypair.publicKey;
        }
        if (key.pubkey.equals(escrow)) {
          key.isSigner = false;
          key.isWritable = true;
        }
      });

      return ix;
    });

    const cpiIxs = ixs.filter((ix) => ix.programId.equals(PROGRAM_ID));
    cpiIxs[cpiIxs.length - 1].keys[0] = {
      pubkey: escrow,
      isSigner: false,
      isWritable: true,
    };

    const cpiIxs1 = cpiIxs.slice(0, 2);
    const cpiIxs2 = cpiIxs.slice(-1);

    const otherIxs = ixs.filter((ix) => !ix.programId.equals(PROGRAM_ID));
    otherIxs[1].keys[1] = {
      pubkey: escrow,
      isSigner: false,
      isWritable: false,
    };

    writeFileSync(
      "kaminoAction/cpiIxs1.json",
      JSON.stringify(cpiIxs1, null, 2)
    );
    writeFileSync(
      "kaminoAction/cpiIxs.json",
      JSON.stringify(cpiIxs.slice(2, 4), null, 2)
    );
    writeFileSync(
      "kaminoAction/cpiIxs2.json",
      JSON.stringify(cpiIxs2, null, 2)
    );
    writeFileSync(
      "kaminoAction/otherIxs.json",
      JSON.stringify(otherIxs, null, 2)
    );

    const allAccountMetas1 = cpiIxs1.flatMap((ix) => ix.keys);

    const ixDatas1 = cpiIxs1.map((ix) => ix.data);
    const ixAccountsCount1 = Buffer.alloc(cpiIxs1.length);

    cpiIxs1.forEach((ix, i) => {
      ixAccountsCount1.writeUInt8(ix.keys.length, i);
    });

    const ix1 = await program.methods
      .initialize(ixDatas1, ixAccountsCount1)
      .accounts({
        user: devKeypair.publicKey,
      })
      .remainingAccounts(allAccountMetas1)
      .instruction();

    const allAccountMetas2 = cpiIxs2.flatMap((ix) => ix.keys);

    const ixDatas2 = cpiIxs2.map((ix) => ix.data);
    const ixAccountsCount2 = Buffer.alloc(cpiIxs2.length);

    cpiIxs2.forEach((ix, i) => {
      ixAccountsCount2.writeUInt8(ix.keys.length, i);
    });

    const amount = new anchor.BN(depositAmount);

    const ix2 = await program.methods
      .deposit(ixDatas2, ixAccountsCount2, amount)
      .accounts({
        user: devKeypair.publicKey,
        userTokenAccount,
        tokenMint,
        escrowTokenAccount,
      })
      .remainingAccounts(allAccountMetas2)
      .instruction();

    otherIxs.splice(2, 0, ...[ix1, ...cpiIxs.slice(2, 4), ix2]);

    const txn = new Transaction().add(...otherIxs);

    txn.feePayer = devKeypair.publicKey;
    txn.recentBlockhash = blockhashWithContext.blockhash;
    txn.partialSign(devKeypair);

    const sign = await program.provider.connection.sendRawTransaction(
      txn.serialize()
    );
    // const simulation = await program.provider.connection.simulateTransaction(
    //   txn
    // );

    console.log(
      "Transaction signature:",
      // simulation.value
      sign
    );
  });
});
