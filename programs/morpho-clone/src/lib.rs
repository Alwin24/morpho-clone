use anchor_lang::prelude::*;
use anchor_lang::{
    pubkey,
    solana_program::{instruction::Instruction, program::invoke},
};

pub const KAMINO_PROGRAM_ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

declare_id!("AVS1hieS2uEKeCCmoJgCG7DS28dpiz7F71qovBwBNV9j");

#[program]
pub mod morpho_clone {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        ix_datas: Vec<Vec<u8>>,
        ix_accounts_counts: Vec<u8>,
    ) -> Result<()> {
        let remaining_accounts = &ctx.remaining_accounts;

        let accounts: Vec<AccountMeta> = remaining_accounts
            .iter()
            .map(|acc| AccountMeta {
                pubkey: *acc.key,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            })
            .collect();

        for i in 0..ix_accounts_counts.len() {
            let mut start = 0;
            let mut end = 0;
            for j in 0..i {
                start += ix_accounts_counts[j] as usize;
            }
            for j in 0..=i {
                end += ix_accounts_counts[j] as usize;
            }

            invoke(
                &Instruction {
                    program_id: ctx.accounts.kamino_program.key(),
                    accounts: accounts[start..end].to_vec(),
                    data: ix_datas[i].clone(),
                },
                &remaining_accounts[start..end].to_vec(),
            )?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    ///CHECK: The account that will be used to call the kamino program
    #[account(address = KAMINO_PROGRAM_ID)]
    pub kamino_program: UncheckedAccount<'info>,
}
