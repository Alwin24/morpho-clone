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
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { config } from "dotenv";
import { MorphoClone } from "../target/types/morpho_clone";
import { writeFileSync } from "fs";
import { IDL } from "../idls/kamino_lending";
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
    "6WVSwDQXrBZeQVnu6hpnsRZhodaJTZBUaC334SiiBKdb"
    // "N5rxNZrDorPdcLSGF7tam7SfnPYFB3kF6TpZiNMSeCG" // deposit & withdraw works
  );

  const tokenMint = new PublicKey(
    // "So11111111111111111111111111111111111111112"
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

  const escrowTokenAccount = getAssociatedTokenAddress(tokenMint, escrow, true);

  console.log("Escrow:", escrow.toBase58());
  console.log("Escrow Token Account:", escrowTokenAccount.toBase58());

  const processIxs = async (ixs: TransactionInstruction[]) => {
    const kaminoIxs = ixs.filter((ix) => ix.programId.equals(PROGRAM_ID));
    const otherIxs = ixs.filter((ix) => !ix.programId.equals(PROGRAM_ID));

    const cpiOrNot = kaminoIxs.map((ix) => {
      const ixDiscriminator = ix.data.slice(0, 8);

      const ixName = Object.values(IDL.instructions).find(
        (ix) =>
          Buffer.compare(Buffer.from(ix.discriminator), ixDiscriminator) === 0
      ).name;

      if (ixName.startsWith("refresh")) {
        return "notCpi";
      } else {
        return "cpi";
      }
    });

    // Group kaminoIxs by cpi or not
    const groupedIxs = cpiOrNot.reduce((acc, type, index) => {
      if (index === 0 || type !== acc[acc.length - 1].type) {
        acc.push({ type: type, ixs: [kaminoIxs[index]] });
      } else {
        acc[acc.length - 1].ixs.push(kaminoIxs[index]);
      }
      return acc;
    }, [] as { type: "cpi" | "notCpi"; ixs: TransactionInstruction[] }[]);

    const processedIxs = [];
    processedIxs.push(...otherIxs);

    for (const group of groupedIxs) {
      group.ixs.forEach((ix) => {
        ix.keys.forEach((key) => {
          if (key.isSigner && key.isWritable) {
            key.pubkey = devKeypair.publicKey;
          }
          if (key.pubkey.equals(escrow)) {
            key.isSigner = false;
            key.isWritable = true;
          }
        });
      });

      if (group.type === "cpi") {
        const cpiIxs = group.ixs;

        const cpiIxDatas = cpiIxs.map((ix) => ix.data);
        const cpiIxAccountsCounts = Buffer.alloc(group.ixs.length);

        group.ixs.forEach((ix, i) => {
          cpiIxAccountsCounts.writeUInt8(ix.keys.length, i);
        });

        const cpiIxAccountMetas = group.ixs.flatMap((ix) => ix.keys);

        const cpiIxInstruction = await program.methods
          .initialize(cpiIxDatas, cpiIxAccountsCounts)
          .accounts({
            user: devKeypair.publicKey,
          })
          .remainingAccounts(cpiIxAccountMetas)
          .instruction();

        processedIxs.push(cpiIxInstruction);
      } else {
        processedIxs.push(...group.ixs);
      }
    }

    return processedIxs;
  };

  const createTxn = async (ixs: TransactionInstruction[]) => {
    const processedIxs = await processIxs(ixs);

    const txn = new Transaction().add(...processedIxs);

    let blockhashWithContext =
      await program.provider.connection.getLatestBlockhash("processed");

    txn.feePayer = devKeypair.publicKey;
    txn.recentBlockhash = blockhashWithContext.blockhash;
    txn.partialSign(devKeypair);

    return { txn, blockhashWithContext };
  };

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

  it.skip("Deposit!", async () => {
    const kaminoMarket = await KaminoMarket.load(
      program.provider.connection,
      LENDING_MARKET,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      PROGRAM_ID,
      true,
      true
    );

    const depositAmount = (10 ** 6 * 0.0001).toString();

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

    // writeFileSync("kaminoAction/ixs.json", JSON.stringify(ixs, null, 2));

    const cpiIxs = ixs.filter((ix) => ix.programId.equals(PROGRAM_ID));
    cpiIxs[cpiIxs.length - 1].keys[0] = {
      pubkey: escrow,
      isSigner: false,
      isWritable: true,
    };

    const cpiIxs1 = cpiIxs.slice(0, 1);
    const cpiIxs2 = cpiIxs.slice(-1);

    const otherIxs = ixs.filter((ix) => !ix.programId.equals(PROGRAM_ID));

    // writeFileSync(
    //   "kaminoAction/cpiIxs1.json",
    //   JSON.stringify(cpiIxs1, null, 2)
    // );
    // writeFileSync(
    //   "kaminoAction/cpiIxs.json",
    //   JSON.stringify(cpiIxs.slice(2, 4), null, 2)
    // );
    // writeFileSync(
    //   "kaminoAction/cpiIxs2.json",
    //   JSON.stringify(cpiIxs2, null, 2)
    // );
    // writeFileSync(
    //   "kaminoAction/otherIxs.json",
    //   JSON.stringify(otherIxs, null, 2)
    // );

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

    otherIxs.splice(1, 0, ...[ix1, ...cpiIxs.slice(1, 3), ix2]);

    const txn = new Transaction().add(...otherIxs);

    txn.feePayer = devKeypair.publicKey;
    txn.recentBlockhash = blockhashWithContext.blockhash;
    txn.partialSign(devKeypair);

    const signature = await program.provider.connection.sendRawTransaction(
      txn.serialize()
    );
    // const simulation = await program.provider.connection.simulateTransaction(
    //   txn
    // );

    console.log(
      "Transaction signature:",
      // simulation.value
      signature
    );
  });

  it.skip("Withdraw!", async () => {
    const kaminoMarket = await KaminoMarket.load(
      program.provider.connection,
      LENDING_MARKET,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      PROGRAM_ID,
      true,
      true
    );

    const withdrawAmount = (10 ** 6 * 0.0001).toString();

    const kaminoAction = await KaminoAction.buildWithdrawTxns(
      kaminoMarket,
      withdrawAmount,
      tokenMint,
      escrow,
      new VanillaObligation(PROGRAM_ID),
      1_000_000
    );

    const ixs = [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ].map((ix) => {
      ix.keys.forEach((key) => {
        if (key.pubkey.equals(escrow)) {
          key.isSigner = false;
          key.isWritable = true;
        }
      });

      return ix;
    });

    writeFileSync("kaminoAction/ixs.json", JSON.stringify(ixs, null, 2));

    const cpiIxs = ixs.filter((ix) => ix.programId.equals(PROGRAM_ID));

    const cpiIxs1 = cpiIxs.slice(-1);

    const otherIxs = ixs.filter((ix) => !ix.programId.equals(PROGRAM_ID));

    const allAccountMetas1 = cpiIxs1.flatMap((ix) => ix.keys);

    const ixDatas1 = cpiIxs1.map((ix) => ix.data);
    const ixAccountsCount1 = Buffer.alloc(cpiIxs1.length);

    cpiIxs1.forEach((ix, i) => {
      ixAccountsCount1.writeUInt8(ix.keys.length, i);
    });

    const amount = new anchor.BN(withdrawAmount);

    const ix1 = await program.methods
      .deposit(ixDatas1, ixAccountsCount1, amount)
      .accounts({
        user: devKeypair.publicKey,
        userTokenAccount,
        tokenMint,
        escrowTokenAccount,
      })
      .remainingAccounts(allAccountMetas1)
      .instruction();

    otherIxs.splice(1, 0, ...[...cpiIxs.slice(0, 2), ix1]);

    const txn = new Transaction().add(...otherIxs);

    let blockhashWithContext =
      await program.provider.connection.getLatestBlockhash("processed");

    txn.feePayer = devKeypair.publicKey;
    txn.recentBlockhash = blockhashWithContext.blockhash;
    txn.partialSign(devKeypair);

    const signature = await program.provider.connection.sendRawTransaction(
      txn.serialize()
    );
    // const simulation = await program.provider.connection.simulateTransaction(
    //   txn
    // );

    console.log(
      "Transaction signature:",
      // simulation.value,
      signature
    );
  });

  it.skip("Borrow!", async () => {
    const kaminoMarket = await KaminoMarket.load(
      program.provider.connection,
      LENDING_MARKET,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      PROGRAM_ID,
      true,
      true
    );

    const borrowAmount = (10 ** 6 * 0.00001).toString();

    const kaminoAction = await KaminoAction.buildBorrowTxns(
      kaminoMarket,
      borrowAmount,
      tokenMint,
      escrow,
      new VanillaObligation(PROGRAM_ID),
      1_000_000
    );

    const ixs = [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ];

    writeFileSync("kaminoAction/ixs.json", JSON.stringify(ixs, null, 2));

    const { txn, blockhashWithContext } = await createTxn(ixs);

    // const signature = await program.provider.connection.sendRawTransaction(
    txn.serialize();
    // );
    const simulation = await program.provider.connection.simulateTransaction(
      txn
    );

    console.log(
      "Transaction signature:",
      simulation.value
      // signature
    );
  });

  it.skip("Repay!", async () => {
    const kaminoMarket = await KaminoMarket.load(
      program.provider.connection,
      LENDING_MARKET,
      DEFAULT_RECENT_SLOT_DURATION_MS,
      PROGRAM_ID,
      true,
      true
    );

    const borrowAmount = (10 ** 6 * 0.00005).toString();

    const kaminoAction = await KaminoAction.buildRepayTxns(
      kaminoMarket,
      borrowAmount,
      tokenMint,
      escrow,
      new VanillaObligation(PROGRAM_ID),
      1_000_000
    );

    const ixs = [
      ...kaminoAction.setupIxs,
      ...kaminoAction.lendingIxs,
      ...kaminoAction.cleanupIxs,
    ].map((ix) => {
      ix.keys.forEach((key) => {
        if (key.pubkey.equals(escrow)) {
          key.isSigner = false;
          key.isWritable = true;
        }
      });

      return ix;
    });

    writeFileSync("kaminoAction/ixs.json", JSON.stringify(ixs, null, 2));

    const cpiIxs = ixs.filter((ix) => ix.programId.equals(PROGRAM_ID));

    const cpiIxs1 = cpiIxs.slice(-1);

    const otherIxs = ixs.filter((ix) => !ix.programId.equals(PROGRAM_ID));

    const allAccountMetas1 = cpiIxs1.flatMap((ix) => ix.keys);

    const ixDatas1 = cpiIxs1.map((ix) => ix.data);
    const ixAccountsCount1 = Buffer.alloc(cpiIxs1.length);

    cpiIxs1.forEach((ix, i) => {
      ixAccountsCount1.writeUInt8(ix.keys.length, i);
    });

    const amount = new anchor.BN(borrowAmount);

    const ix1 = await program.methods
      .deposit(ixDatas1, ixAccountsCount1, amount)
      .accounts({
        user: devKeypair.publicKey,
        userTokenAccount,
        tokenMint,
        escrowTokenAccount,
      })
      .remainingAccounts(allAccountMetas1)
      .instruction();

    otherIxs.splice(1, 0, ...[...cpiIxs.slice(0, 2), ix1]);

    const txn = new Transaction().add(...otherIxs);

    let blockhashWithContext =
      await program.provider.connection.getLatestBlockhash("processed");

    txn.feePayer = devKeypair.publicKey;
    txn.recentBlockhash = blockhashWithContext.blockhash;
    txn.partialSign(devKeypair);

    // const signature = await program.provider.connection.sendRawTransaction(
    txn.serialize();
    // );
    const simulation = await program.provider.connection.simulateTransaction(
      txn
    );

    console.log(
      "Transaction signature:",
      simulation.value
      // signature
    );
  });
});
