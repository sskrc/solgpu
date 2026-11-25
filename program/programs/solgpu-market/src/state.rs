use anchor_lang::prelude::*;

/// 出品（GPU 1 台につき 1 つ）
/// PDA: ["listing", owner, listing_id]
#[account]
#[derive(InitSpace)]
pub struct Listing {
    /// 代金の受取先（貸し手のウォレット）
    pub owner: Pubkey,
    /// GPU の PC で動くエージェントの鍵。accept と URL 更新だけができる
    pub operator: Pubkey,
    pub listing_id: u64,
    #[max_len(120)]
    pub agent_url: String,
    #[max_len(64)]
    pub gpu: String,
    /// ベンチマーク結果 (TFLOPS × 100)
    pub tflops_x100: u32,
    pub lamports_per_minute: u64,
    /// エージェントが起動中で受付中か
    pub active: bool,
    /// この時刻 (unix 秒) まで使用中・予約中
    pub busy_until: i64,
    /// 直近のレンタル
    pub current_rental: Pubkey,
    /// 未精算のレンタル数（0 でないと出品を取り下げられない）
    pub open_rentals: u32,
    pub total_rentals: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum RentalStatus {
    /// 支払い済み・エージェントの利用開始待ち
    Pending,
    /// 利用中
    Active,
}

/// レンタル（エスクロー口座を兼ねる）
/// PDA: ["rental", listing, renter, nonce]
#[account]
#[derive(InitSpace)]
pub struct Rental {
    pub listing: Pubkey,
    pub renter: Pubkey,
    /// 代金の受取先（出品時点の owner を固定）
    pub owner: Pubkey,
    pub nonce: u64,
    pub minutes: u32,
    /// 預かっている代金 (lamports)。口座の保証金とは別
    pub amount: u64,
    /// 借り手だけが知る秘密の値の SHA-256。エージェントが本人確認に使う
    pub secret_hash: [u8; 32],
    pub status: RentalStatus,
    pub created_at: i64,
    pub accept_deadline: i64,
    pub started_at: i64,
    pub ends_at: i64,
    pub bump: u8,
}
