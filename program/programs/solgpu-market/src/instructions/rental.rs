use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::MarketError,
    state::{Listing, Rental, RentalStatus},
};

// ---------------------------------------------------------------- rent
#[derive(Accounts)]
#[instruction(nonce: u64)]
pub struct RentGpu<'info> {
    #[account(mut)]
    pub renter: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(
        init,
        payer = renter,
        space = 8 + Rental::INIT_SPACE,
        seeds = [RENTAL_SEED, listing.key().as_ref(), renter.key().as_ref(), &nonce.to_le_bytes()],
        bump
    )]
    pub rental: Account<'info, Rental>,
    pub system_program: Program<'info, System>,
}

pub fn handle_rent_gpu(
    ctx: Context<RentGpu>,
    nonce: u64,
    minutes: u32,
    expected_lamports_per_minute: u64,
    secret_hash: [u8; 32],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let listing = &mut ctx.accounts.listing;

    require!(listing.active, MarketError::ListingInactive);
    require!(now >= listing.busy_until, MarketError::ListingBusy);
    require!((1..=MAX_MINUTES).contains(&minutes), MarketError::InvalidMinutes);
    // 借り手が画面で見た価格から変わっていたら中止（価格のすり替え防止）
    require!(
        listing.lamports_per_minute == expected_lamports_per_minute,
        MarketError::PriceChanged
    );
    let amount = listing
        .lamports_per_minute
        .checked_mul(minutes as u64)
        .ok_or(MarketError::Overflow)?;

    // 代金をエスクロー（Rental アカウント）に預ける
    let cpi = CpiContext::new(
        anchor_lang::system_program::ID,
        anchor_lang::system_program::Transfer {
            from: ctx.accounts.renter.to_account_info(),
            to: ctx.accounts.rental.to_account_info(),
        },
    );
    anchor_lang::system_program::transfer(cpi, amount)?;

    let accept_deadline = now.checked_add(ACCEPT_TIMEOUT_SECS).ok_or(MarketError::Overflow)?;
    let r = &mut ctx.accounts.rental;
    r.listing = listing.key();
    r.renter = ctx.accounts.renter.key();
    r.owner = listing.owner;
    r.nonce = nonce;
    r.minutes = minutes;
    r.amount = amount;
    r.secret_hash = secret_hash;
    r.status = RentalStatus::Pending;
    r.created_at = now;
    r.accept_deadline = accept_deadline;
    r.started_at = 0;
    r.ends_at = 0;
    r.bump = ctx.bumps.rental;

    // 開始待ちの間は他の人が借りられないようにする
    listing.busy_until = accept_deadline;
    listing.current_rental = r.key();
    listing.open_rentals = listing.open_rentals.checked_add(1).ok_or(MarketError::Overflow)?;
    listing.total_rentals = listing.total_rentals.checked_add(1).ok_or(MarketError::Overflow)?;
    Ok(())
}

// ---------------------------------------------------------------- accept
#[derive(Accounts)]
pub struct Accept<'info> {
    #[account(mut)]
    pub operator: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, has_one = listing)]
    pub rental: Account<'info, Rental>,
}

pub fn handle_accept(ctx: Context<Accept>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let listing = &mut ctx.accounts.listing;
    let r = &mut ctx.accounts.rental;

    require_keys_eq!(ctx.accounts.operator.key(), listing.operator, MarketError::NotOperator);
    require!(r.status == RentalStatus::Pending, MarketError::NotPending);
    require!(now <= r.accept_deadline, MarketError::AcceptDeadlinePassed);

    // 利用時間は「GPU 環境が使えるようになった今」から数える
    r.status = RentalStatus::Active;
    r.started_at = now;
    r.ends_at = now
        .checked_add((r.minutes as i64).checked_mul(60).ok_or(MarketError::Overflow)?)
        .ok_or(MarketError::Overflow)?;
    listing.busy_until = r.ends_at;
    Ok(())
}

// ---------------------------------------------------------------- settle
#[derive(Accounts)]
pub struct Settle<'info> {
    /// 誰が呼んでもよい（手数料を払う人）
    pub caller: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, has_one = listing, has_one = owner, has_one = renter, close = renter)]
    pub rental: Account<'info, Rental>,
    /// CHECK: rental.owner と一致することを has_one で確認済み。代金の受取先
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: rental.renter と一致することを has_one で確認済み。口座の保証金の返却先
    #[account(mut)]
    pub renter: UncheckedAccount<'info>,
}

pub fn handle_settle(ctx: Context<Settle>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let r = &ctx.accounts.rental;
    require!(r.status == RentalStatus::Active, MarketError::NotActive);
    require!(now >= r.ends_at, MarketError::NotEnded);

    // 預かっていた代金を貸し手へ（データを持つ口座なので、lamports を直接動かす）
    let amount = r.amount;
    let rental_info = ctx.accounts.rental.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();
    **rental_info.try_borrow_mut_lamports()? = rental_info
        .lamports()
        .checked_sub(amount)
        .ok_or(MarketError::Overflow)?;
    **owner_info.try_borrow_mut_lamports()? = owner_info
        .lamports()
        .checked_add(amount)
        .ok_or(MarketError::Overflow)?;

    let listing = &mut ctx.accounts.listing;
    listing.open_rentals = listing.open_rentals.saturating_sub(1);
    // 残り（口座の保証金）は close = renter で借り手に戻る
    Ok(())
}

// ---------------------------------------------------------------- refund
#[derive(Accounts)]
pub struct Refund<'info> {
    /// 借り手本人ならいつでも、それ以外の人は accept 期限後のみ
    pub caller: Signer<'info>,
    #[account(mut)]
    pub listing: Account<'info, Listing>,
    #[account(mut, has_one = listing, has_one = renter, close = renter)]
    pub rental: Account<'info, Rental>,
    /// CHECK: rental.renter と一致することを has_one で確認済み。代金と保証金の返却先
    #[account(mut)]
    pub renter: UncheckedAccount<'info>,
}

pub fn handle_refund(ctx: Context<Refund>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let r = &ctx.accounts.rental;
    require!(r.status == RentalStatus::Pending, MarketError::NotPending);
    let is_renter = ctx.accounts.caller.key() == r.renter;
    require!(is_renter || now > r.accept_deadline, MarketError::RefundNotAllowed);

    let rental_key = r.key();
    let listing = &mut ctx.accounts.listing;
    listing.open_rentals = listing.open_rentals.saturating_sub(1);
    // 開始されないまま取り消されたので、すぐ他の人が借りられるようにする
    if listing.current_rental == rental_key {
        listing.busy_until = now;
    }
    // 代金と保証金はすべて close = renter で借り手に戻る
    Ok(())
}
