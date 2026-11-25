use anchor_lang::prelude::*;

use crate::{constants::*, error::MarketError, state::Listing};

fn validate_url(url: &str) -> Result<()> {
    require!(
        url.len() <= MAX_URL_LEN && (url.starts_with("https://") || url.starts_with("http://")),
        MarketError::InvalidUrl
    );
    Ok(())
}

fn validate_gpu(gpu: &str) -> Result<()> {
    require!(!gpu.is_empty() && gpu.len() <= MAX_GPU_LEN, MarketError::InvalidGpuName);
    Ok(())
}

fn validate_price(p: u64) -> Result<()> {
    require!(
        (MIN_LAMPORTS_PER_MINUTE..=MAX_LAMPORTS_PER_MINUTE).contains(&p),
        MarketError::InvalidPrice
    );
    Ok(())
}

// ---------------------------------------------------------------- create_listing
#[derive(Accounts)]
#[instruction(listing_id: u64)]
pub struct CreateListing<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, owner.key().as_ref(), &listing_id.to_le_bytes()],
        bump
    )]
    pub listing: Account<'info, Listing>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_listing(
    ctx: Context<CreateListing>,
    listing_id: u64,
    operator: Pubkey,
    agent_url: String,
    gpu: String,
    tflops_x100: u32,
    lamports_per_minute: u64,
) -> Result<()> {
    validate_url(&agent_url)?;
    validate_gpu(&gpu)?;
    validate_price(lamports_per_minute)?;

    let l = &mut ctx.accounts.listing;
    l.owner = ctx.accounts.owner.key();
    l.operator = operator;
    l.listing_id = listing_id;
    l.agent_url = agent_url;
    l.gpu = gpu;
    l.tflops_x100 = tflops_x100;
    l.lamports_per_minute = lamports_per_minute;
    l.active = true;
    l.busy_until = 0;
    l.current_rental = Pubkey::default();
    l.open_rentals = 0;
    l.total_rentals = 0;
    l.bump = ctx.bumps.listing;
    Ok(())
}

// ---------------------------------------------------------------- update_agent
#[derive(Accounts)]
pub struct UpdateAgent<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
}

pub fn handle_update_agent(ctx: Context<UpdateAgent>, agent_url: String, active: bool) -> Result<()> {
    let l = &mut ctx.accounts.listing;
    let who = ctx.accounts.authority.key();
    require!(who == l.owner || who == l.operator, MarketError::NotOwnerOrOperator);
    validate_url(&agent_url)?;
    l.agent_url = agent_url;
    l.active = active;
    Ok(())
}

// ---------------------------------------------------------------- update_listing
#[derive(Accounts)]
pub struct UpdateListing<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ MarketError::NotOwner)]
    pub listing: Account<'info, Listing>,
}

pub fn handle_update_listing(
    ctx: Context<UpdateListing>,
    operator: Pubkey,
    gpu: String,
    tflops_x100: u32,
    lamports_per_minute: u64,
) -> Result<()> {
    let l = &mut ctx.accounts.listing;
    // 進行中のレンタルがあるとエージェントの鍵が変わって開始できなくなるので禁止
    require!(l.open_rentals == 0, MarketError::HasOpenRentals);
    validate_gpu(&gpu)?;
    validate_price(lamports_per_minute)?;
    l.operator = operator;
    l.gpu = gpu;
    l.tflops_x100 = tflops_x100;
    l.lamports_per_minute = lamports_per_minute;
    Ok(())
}

// ---------------------------------------------------------------- close_listing
#[derive(Accounts)]
pub struct CloseListing<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner @ MarketError::NotOwner, close = owner)]
    pub listing: Account<'info, Listing>,
}

pub fn handle_close_listing(ctx: Context<CloseListing>) -> Result<()> {
    // 未精算のレンタルがあると settle / refund ができなくなるので禁止
    require!(ctx.accounts.listing.open_rentals == 0, MarketError::HasOpenRentals);
    Ok(())
}
