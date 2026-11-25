//! SolGPU GPU マーケット（エスクロー付き）
//!
//! - 貸し手は GPU を「出品 (Listing)」する。受取ウォレット (owner) と、
//!   GPU の PC で動くエージェントの鍵 (operator) を登録する
//! - 借り手が「レンタル (Rental)」すると、代金はこのプログラムの口座（Rental アカウント）に預けられる
//! - エージェントが GPU 環境を用意できたら `accept` → 利用開始（ここから時間を数える）
//! - 終了時刻を過ぎたら誰でも `settle` を呼べ、代金は必ず owner へ、口座の保証金は借り手へ戻る
//! - 期限内に `accept` されなければ、誰でも `refund` を呼べ、代金は必ず借り手へ戻る
//!   （accept 前なら借り手自身はいつでもキャンセル可能）
//!
//! お金の行き先はプログラムで固定されているため、エージェントの鍵 (operator) が漏れても
//! 代金を盗むことはできない。

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("Gk1366at4C4ovkCMauacmRckfo9nbi1nyZo4rRB5Ltdt");

#[program]
pub mod solgpu_market {
    use super::*;

    /// GPU を出品する（貸し手のウォレットが署名）
    pub fn create_listing(
        ctx: Context<CreateListing>,
        listing_id: u64,
        operator: Pubkey,
        agent_url: String,
        gpu: String,
        tflops_x100: u32,
        lamports_per_minute: u64,
    ) -> Result<()> {
        instructions::listing::handle_create_listing(
            ctx,
            listing_id,
            operator,
            agent_url,
            gpu,
            tflops_x100,
            lamports_per_minute,
        )
    }

    /// エージェントの URL と受付状態を更新（貸し手 または エージェント）
    pub fn update_agent(ctx: Context<UpdateAgent>, agent_url: String, active: bool) -> Result<()> {
        instructions::listing::handle_update_agent(ctx, agent_url, active)
    }

    /// 価格・性能値・エージェントの鍵を更新（貸し手のみ。レンタル中は不可）
    pub fn update_listing(
        ctx: Context<UpdateListing>,
        operator: Pubkey,
        gpu: String,
        tflops_x100: u32,
        lamports_per_minute: u64,
    ) -> Result<()> {
        instructions::listing::handle_update_listing(ctx, operator, gpu, tflops_x100, lamports_per_minute)
    }

    /// 出品を取り下げ、保証金を返してもらう（貸し手のみ。未精算のレンタルが無いこと）
    pub fn close_listing(ctx: Context<CloseListing>) -> Result<()> {
        instructions::listing::handle_close_listing(ctx)
    }

    /// GPU を借りる。代金はエスクロー（Rental アカウント）に預けられる
    pub fn rent_gpu(
        ctx: Context<RentGpu>,
        nonce: u64,
        minutes: u32,
        expected_lamports_per_minute: u64,
        secret_hash: [u8; 32],
    ) -> Result<()> {
        instructions::rental::handle_rent_gpu(ctx, nonce, minutes, expected_lamports_per_minute, secret_hash)
    }

    /// エージェントが GPU 環境を用意できたことを記録し、利用時間のカウントを始める
    pub fn accept(ctx: Context<Accept>) -> Result<()> {
        instructions::rental::handle_accept(ctx)
    }

    /// 終了時刻を過ぎたレンタルを精算（誰でも呼べる。代金は貸し手へ）
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        instructions::rental::handle_settle(ctx)
    }

    /// 開始されなかったレンタルを返金（借り手はいつでも / 他の人は期限後。代金は借り手へ）
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        instructions::rental::handle_refund(ctx)
    }
}
