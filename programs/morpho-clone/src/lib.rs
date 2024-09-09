use anchor_lang::prelude::*;
use anchor_lang::{
    pubkey,
    solana_program::{instruction::Instruction, program::invoke_signed},
};
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

pub const KAMINO_PROGRAM_ID: Pubkey = pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");
pub const ESCROW_SEED: &[u8] = b"escrow";

declare_id!("AVS1hieS2uEKeCCmoJgCG7DS28dpiz7F71qovBwBNV9j");

#[program]
pub mod morpho_clone {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let amount = 1000000;

        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.authority.to_account_info(),
                    to: ctx.accounts.escrow.to_account_info(),
                },
            ),
            amount,
        )?;

        Ok(())
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        ix_datas: Vec<Vec<u8>>,
        ix_accounts_counts: Vec<u8>,
        amount: u64,
    ) -> Result<()> {
        anchor_spl::token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Transfer {
                    from: ctx.accounts.user_token_account.to_account_info(),
                    to: ctx.accounts.escrow_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let remaining_accounts = &ctx.remaining_accounts;

        let accounts: Vec<AccountMeta> = remaining_accounts
            .iter()
            .map(|acc| AccountMeta {
                pubkey: *acc.key,
                is_signer: acc.is_signer,
                is_writable: acc.is_writable,
            })
            .collect();

        let signer_seeds = &[ESCROW_SEED, &[ctx.bumps.escrow]];

        for i in 0..ix_accounts_counts.len() {
            let mut start = 0;
            let mut end = 0;
            for j in 0..i {
                start += ix_accounts_counts[j] as usize;
            }
            for j in 0..=i {
                end += ix_accounts_counts[j] as usize;
            }

            invoke_signed(
                &Instruction {
                    program_id: ctx.accounts.kamino_program.key(),
                    accounts: accounts[start..end].to_vec(),
                    data: ix_datas[i].clone(),
                },
                &remaining_accounts[start..end].to_vec(),
                &[signer_seeds],
            )?;
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [ESCROW_SEED],
        bump,
    )]
    pub escrow: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        constraint = user_token_account.owner == user.key() &&
        user_token_account.mint == token_mint.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [ESCROW_SEED],
        bump,
    )]
    pub escrow: SystemAccount<'info>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = escrow,
        constraint = escrow_token_account.owner == escrow.key() &&
        escrow_token_account.mint == token_mint.key()
    )]
    pub escrow_token_account: Box<Account<'info, TokenAccount>>,
    pub token_mint: Box<Account<'info, Mint>>,

    ///CHECK: The account that will be used to call the kamino program
    #[account(address = KAMINO_PROGRAM_ID)]
    pub kamino_program: UncheckedAccount<'info>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
