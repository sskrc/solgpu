use anchor_lang::prelude::*;

#[constant]
pub const LISTING_SEED: &[u8] = b"listing";

#[constant]
pub const RENTAL_SEED: &[u8] = b"rental";

/// エージェントが利用開始 (accept) するまでの猶予。過ぎたら返金できる
#[constant]
pub const ACCEPT_TIMEOUT_SECS: i64 = 5 * 60;

/// 1 回のレンタルの最大時間（分）
#[constant]
pub const MAX_MINUTES: u32 = 240;

/// 価格の下限・上限（lamports / 分）
#[constant]
pub const MIN_LAMPORTS_PER_MINUTE: u64 = 10_000;

#[constant]
pub const MAX_LAMPORTS_PER_MINUTE: u64 = 1_000_000_000;

pub const MAX_URL_LEN: usize = 120;
pub const MAX_GPU_LEN: usize = 64;
